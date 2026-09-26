import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  GenerateSceneInput,
  LlmConnectionStatus,
  LlmGenerationInput,
  LlmGenerationResult,
  LlmReasoningEffort,
  LlmServiceTier,
  LlmStep,
  LlmStepSetting,
  LlmStepSettings,
} from '../../shared/types'
import {
  DEFAULT_LLM_REASONING_EFFORT,
  DEFAULT_LLM_SERVICE_TIER,
  normalizeLlmModel,
  normalizeLlmReasoningEffort,
  normalizeLlmServiceTier,
} from '../../shared/types'
import { logGeneration, logGenerationError } from './generationLogger'
import { normalizeReferenceImage } from './imageUpscale'

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export interface CodexImageResult {
  data: Buffer
  extension: string
}

export interface CodexImageRequest extends Pick<GenerateSceneInput, 'prompt' | 'aspectRatio'> {
  referenceImagePaths?: string[]
  characterSheetPath?: string
  backgroundImagePath?: string
}

const executable = process.env.CODEX_PATH || 'codex'
const model = process.env.CODEX_MODEL || 'gpt-5.6-luna'
const environmentReasoningEffort = process.env.CODEX_REASONING_EFFORT
  ? normalizeLlmReasoningEffort(process.env.CODEX_REASONING_EFFORT)
  : undefined
const { text: maxTextConcurrentGenerations, image: maxImageConcurrentGenerations } =
  codexConcurrencyLimits()
const textTimeoutMs = boundedTimeout(process.env.CODEX_TEXT_TIMEOUT_MS || '600000')
const scriptTimeoutMs = boundedTimeout(
  process.env.CODEX_SCRIPT_TIMEOUT_MS || process.env.CODEX_TEXT_TIMEOUT_MS || '900000',
)
const imageTimeoutMs = boundedTimeout(process.env.CODEX_IMAGE_TIMEOUT_MS || '300000')

type GenerationSlot = 'text' | 'image'

interface SlotWaiter {
  requestId?: string
  resolve: (release: () => void) => void
  reject: (error: Error) => void
}

export class CodexClient {
  private readonly activeProcesses = new Set<ChildProcess>()
  private readonly activeImageProcesses = new Set<ChildProcess>()
  private readonly activeProcessRequests = new Map<ChildProcess, string | undefined>()
  private readonly cancelledProcesses = new Set<ChildProcess>()
  private availableTextSlots = maxTextConcurrentGenerations
  private availableImageSlots = maxImageConcurrentGenerations
  private readonly textSlotWaiters: SlotWaiter[] = []
  private readonly imageSlotWaiters: SlotWaiter[] = []
  private readonly statusInFlight = new Map<'general' | 'image', Promise<LlmConnectionStatus>>()

  constructor(
    private readonly getConfiguredReasoningEffort: () => LlmReasoningEffort = () =>
      DEFAULT_LLM_REASONING_EFFORT,
    private readonly getConfiguredServiceTier: () => LlmServiceTier = () =>
      DEFAULT_LLM_SERVICE_TIER,
    private readonly spawnProcess: typeof spawn = spawn,
    private readonly executablePath: string = executable,
    private readonly getStepSettings?: () => LlmStepSettings,
  ) {}

  async getStatus(kind: 'general' | 'image' = 'general'): Promise<LlmConnectionStatus> {
    const inFlight = this.statusInFlight.get(kind)
    if (inFlight) return inFlight
    const pending = this.readStatus(kind).finally(() => {
      if (this.statusInFlight.get(kind) === pending) this.statusInFlight.delete(kind)
    })
    this.statusInFlight.set(kind, pending)
    return pending
  }

  private async readStatus(kind: 'general' | 'image'): Promise<LlmConnectionStatus> {
    const versionResult = await this.run(['--version'], undefined, kind)
    if (versionResult.code !== 0) {
      return {
        installed: false,
        authenticated: false,
        message: 'Codex CLI is not available on PATH.',
      }
    }

    const loginResult = await this.run(['login', 'status'], undefined, kind)
    const output = `${loginResult.stdout}\n${loginResult.stderr}`.toLowerCase()
    const authenticated = loginResult.code === 0
    const authMethod = output.includes('chatgpt')
      ? 'chatgpt'
      : output.includes('api key')
        ? 'api-key'
        : authenticated
          ? 'unknown'
          : undefined

    return {
      installed: true,
      authenticated,
      authMethod,
      version: versionResult.stdout.trim(),
      message: authenticated
        ? authMethod === 'chatgpt'
          ? 'Connected through your ChatGPT account.'
          : 'Codex is authenticated.'
        : 'Sign in to Codex with ChatGPT to enable the creative copilot.',
    }
  }

  async startLogin(): Promise<{ started: boolean }> {
    const status = await this.getStatus()
    if (!status.installed) throw new Error('Install the official Codex CLI before signing in.')

    if (process.platform === 'win32') {
      const commandShell = process.env.ComSpec || 'cmd.exe'
      const child = spawn(
        commandShell,
        ['/c', 'start', '"Higgsfilm ChatGPT login"', commandShell, '/k', 'codex login'],
        { detached: true, stdio: 'ignore', windowsHide: false },
      )
      child.unref()
    } else {
      const child = spawn(executable, ['login'], { detached: true, stdio: 'ignore' })
      child.unref()
    }

    return { started: true }
  }

  async generate(input: LlmGenerationInput): Promise<LlmGenerationResult> {
    logGeneration('ChatGPT', 'text request queued', {
      purpose: input.purpose,
      promptChars: input.prompt.length,
      requestId: input.requestId,
      availableSlots: this.availableSlotsFor('text'),
    })
    const releaseSlot = await this.acquireSlot('text', input.requestId)
    const step = this.stepSetting(input.purpose || 'creative')
    logGeneration('ChatGPT', 'text request started', {
      purpose: input.purpose,
      promptChars: input.prompt.length,
      model: step.model,
      reasoningEffort: step.reasoningEffort,
      serviceTier: step.serviceTier,
      requestId: input.requestId,
      availableSlots: this.availableSlotsFor('text'),
    })
    try {
      const outputPath = path.join(os.tmpdir(), `higgsfilm-codex-${randomUUID()}.txt`)
      const prompt = [
        'You are the Higgsfilm Creative Copilot.',
        'Create useful production artifacts for an AI video project.',
        'Do not modify files, run commands, spend generation credits, or call external tools.',
        input.purpose === 'still-cast'
          ? 'For still-cast requests, return only the requested JSON object. No markdown fences, headings, labels, or commentary.'
          : input.purpose === 'video-idea'
            ? 'For video-idea requests, return only the requested JSON object. No markdown fences. Coach in the message field. Do not write the narration script. Request YouTube research only when you still need market evidence.'
          : input.purpose === 'script-draft'
            ? 'For script-draft requests, return only the finished narration script. Follow the script bible exactly, including its narrative viewpoint and grammar. Every line is spoken voice. Custom is only a picture label on a spoken line, never a silent shot. No markdown fences, titles, or commentary.'
          : input.purpose === 'trailer-script'
            ? 'For trailer-script requests, return only the condensed 9:16 spoken script. About 30 seconds. Keep the same lesson and narrative viewpoint as the longform. Prefix every line Custom: for vertical Custom-9x16 stills. No markdown fences, titles, or commentary.'
            : input.purpose === 'scene-direction'
            ? 'For scene-direction requests, return only the requested visual direction prose without headings, labels, JSON, or reasoning.'
            : 'Return only the requested creative answer, with clear headings when helpful.',
        '',
        input.prompt.trim(),
      ].join('\n')

      try {
        const result = await this.run(
          [
            'exec',
            '--ephemeral',
            '--skip-git-repo-check',
            '--sandbox',
            'read-only',
            '--model',
            step.model,
            '--config',
            `model_reasoning_effort="${step.reasoningEffort}"`,
            '--color',
            'never',
            '--output-last-message',
            outputPath,
            '-',
            ...codexServiceTierArgs(step.serviceTier),
          ],
          prompt,
          'general',
          input.requestId,
          timeoutForPurpose(input.purpose),
        )
        logGeneration('ChatGPT', 'text CLI process returned', {
          purpose: input.purpose,
          requestId: input.requestId,
          code: result.code,
          stdoutBytes: result.stdout.length,
          stderrBytes: result.stderr.length,
        })
        if (result.code !== 0) {
          const detail = summarizeCliError(result.stderr)
          throw new Error(detail || 'Codex could not complete the generation.')
        }

        const text = await fs.readFile(outputPath, 'utf8').catch(() => result.stdout.trim())
        if (!text.trim()) throw new Error('Codex returned an empty generation.')
        logGeneration('ChatGPT', 'text response delivered', {
          purpose: input.purpose,
          requestId: input.requestId,
          responseChars: text.trim().length,
          responseFormat: responseFormat(text),
        })
        return { text: text.trim() }
      } finally {
        await fs.rm(outputPath, { force: true }).catch(() => undefined)
      }
    } catch (error) {
      logGenerationError('ChatGPT', 'text request failed', error, { purpose: input.purpose })
      throw error
    } finally {
      releaseSlot()
      logGeneration('ChatGPT', 'text request slot released', {
        purpose: input.purpose,
        requestId: input.requestId,
        availableSlots: this.availableSlotsFor('text'),
      })
    }
  }

  async generateImage(input: CodexImageRequest): Promise<CodexImageResult> {
    const releaseSlot = await this.acquireSlot('image')
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-codex-image-'))
    const step = this.stepSetting('image')
    try {
      logGeneration('ChatGPT', 'image request started', {
        aspectRatio: input.aspectRatio,
        references: input.referenceImagePaths?.length || 0,
        model: step.model,
        reasoningEffort: step.reasoningEffort,
        serviceTier: step.serviceTier,
        availableSlots: this.availableSlotsFor('image'),
      })
      const status = await this.getStatus('image')
      logGeneration('ChatGPT', 'image capability status checked', {
        installed: status.installed,
        authenticated: status.authenticated,
        version: status.version,
      })
      if (!status.installed) throw new Error('Install Codex CLI to use ChatGPT image generation.')
      if (!status.authenticated) throw new Error('Sign in to Codex with ChatGPT before generating images.')

      const startedAt = Date.now()
      const characterSheetPath = input.characterSheetPath?.trim() || ''
      const backgroundImagePath = input.backgroundImagePath?.trim() || ''
      const reserved = (characterSheetPath ? 1 : 0) + (backgroundImagePath ? 1 : 0)
      const referenceImagePaths = await stageReferenceImages(
        workdir,
        input.referenceImagePaths,
        Math.max(0, MAX_REFERENCE_IMAGES - reserved),
      )
      const stagedCharacterSheet = characterSheetPath
        ? await stageNamedImage(workdir, characterSheetPath, 'character-sheet.jpg')
        : ''
      const stagedBackground = backgroundImagePath
        ? await stageNamedImage(workdir, backgroundImagePath, 'background.jpg')
        : ''
      const attachedPaths = [referenceImagePaths, stagedCharacterSheet, stagedBackground].flat().filter(Boolean)
      logGeneration('ChatGPT', 'image references staged', {
        count: attachedPaths.length,
        paths: attachedPaths,
      })
      const prompt = codexImageGenerationPrompt(
        input,
        referenceImagePaths,
        stagedCharacterSheet,
        stagedBackground,
      )
      const result = await this.run(
        [
          'exec',
          '--json',
          '--ephemeral',
          '--skip-git-repo-check',
          '--sandbox',
          'workspace-write',
          '--enable',
          'image_generation',
          '--config',
          `model_reasoning_effort="${step.reasoningEffort}"`,
          '-C',
          workdir,
          ...attachedPaths.flatMap((filePath) => ['--image', filePath]),
          '--model',
          step.model,
          '--color',
          'never',
          ...codexServiceTierArgs(step.serviceTier),
          '-',
        ],
        prompt,
        'image',
        undefined,
        undefined,
        workdir,
      )
      logGeneration('ChatGPT', 'image CLI process returned', {
        code: result.code,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
      })
      if (result.code !== 0) {
        const detail = summarizeCliError(result.stderr || result.stdout)
        throw new Error(detail || 'Codex could not generate the image.')
      }

      const output = `${result.stdout}\n${result.stderr}`
      const image =
        (await extractImageArtifact(output)) ||
        (await imageFromDirectory(workdir, { newerThanMs: startedAt })) ||
        (await imageFromDirectory(codexGeneratedImagesDir(), { maxDepth: 4, newerThanMs: startedAt }))
      if (!image) {
        const agentMessage = agentMessageFromCodexOutput(output)
        logGeneration('ChatGPT', 'image artifact missing', {
          ...summarizeCodexOutput(output),
          agentMessage: agentMessage.slice(0, 500),
        })
        throw new Error(
          agentMessage
            ? `Codex completed without returning a usable image artifact. ${agentMessage}`
            : 'Codex completed without returning a usable image artifact.',
        )
      }
      logGeneration('ChatGPT', 'image artifact parsed', {
        bytes: image.data.byteLength,
        extension: image.extension,
      })
      return image
    } catch (error) {
      logGenerationError('ChatGPT', 'image request failed', error)
      throw error
    } finally {
      await fs.rm(workdir, { recursive: true, force: true }).catch(() => undefined)
      releaseSlot()
      logGeneration('ChatGPT', 'image request slot released', {
        availableSlots: this.availableSlotsFor('image'),
      })
    }
  }

  cancelActive(requestId?: string): void {
    this.rejectSlotWaiters(this.textSlotWaiters, requestId)
    this.rejectSlotWaiters(this.imageSlotWaiters, requestId)
    for (const child of this.activeProcesses) {
      if (requestId !== undefined && this.activeProcessRequests.get(child) !== requestId) continue
      this.cancelledProcesses.add(child)
      this.terminateProcess(child)
    }
  }

  async cancelImageGeneration(): Promise<void> {
    this.rejectSlotWaiters(this.imageSlotWaiters)
    for (const child of this.activeImageProcesses) {
      this.cancelledProcesses.add(child)
      this.terminateProcess(child)
    }
    const deadline = Date.now() + 2_000
    while (this.activeImageProcesses.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  dispose(): void {
    this.cancelActive()
  }

  private acquireSlot(
    kind: GenerationSlot,
    requestId?: string,
  ): Promise<() => void> {
    if (this.availableSlotsFor(kind) > 0) {
      this.setAvailableSlots(kind, this.availableSlotsFor(kind) - 1)
      return Promise.resolve(() => this.releaseSlot(kind))
    }
    return new Promise((resolve, reject) => {
      this.waitersFor(kind).push({ requestId, resolve, reject })
    })
  }

  private reasoningEffort(): LlmReasoningEffort {
    return (
      environmentReasoningEffort ||
      normalizeLlmReasoningEffort(this.getConfiguredReasoningEffort())
    )
  }

  private imageReasoningEffort(): LlmReasoningEffort {
    return normalizeLlmReasoningEffort(process.env.CODEX_IMAGE_REASONING_EFFORT || 'low')
  }

  private serviceTier(): LlmServiceTier {
    return normalizeLlmServiceTier(this.getConfiguredServiceTier())
  }

  private stepSetting(step: LlmStep): LlmStepSetting {
    const configured = this.getStepSettings?.()?.[step]
    if (configured) {
      return {
        model: normalizeLlmModel(configured.model),
        reasoningEffort: normalizeLlmReasoningEffort(configured.reasoningEffort),
        serviceTier: normalizeLlmServiceTier(configured.serviceTier),
      }
    }
    return {
      model: normalizeLlmModel(model),
      reasoningEffort: step === 'image' ? this.imageReasoningEffort() : this.reasoningEffort(),
      serviceTier: this.serviceTier(),
    }
  }

  private releaseSlot(kind: GenerationSlot): void {
    const waiters = this.waitersFor(kind)
    const waiter = waiters.shift()
    if (waiter) {
      waiter.resolve(() => this.releaseSlot(kind))
      return
    }
    this.setAvailableSlots(kind, this.availableSlotsFor(kind) + 1)
  }

  private run(
    args: string[],
    input?: string,
    kind: 'general' | 'image' = 'general',
    requestId?: string,
    timeoutOverrideMs?: number,
    cwd?: string,
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.executablePath, args, {
        cwd,
        windowsHide: true,
        shell: process.platform === 'win32',
      })
      const timeoutMs =
        timeoutOverrideMs ?? (kind === 'image' ? imageTimeoutMs : textTimeoutMs)
      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        logGeneration('ChatGPT', 'CLI process timed out', {
          kind,
          pid: child.pid,
          timeoutMs,
          requestId,
        })
        this.terminateProcess(child)
      }, timeoutMs)
      timeout.unref()
      this.activeProcesses.add(child)
      this.activeProcessRequests.set(child, requestId)
      if (kind === 'image') this.activeImageProcesses.add(child)
      logGeneration('ChatGPT', `${kind === 'image' ? 'image' : 'text'} CLI process started`, {
        command: args.join(' '),
        kind,
        pid: child.pid,
        timeoutMs,
        requestId,
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', (error) => {
        clearTimeout(timeout)
        this.activeProcesses.delete(child)
        this.activeProcessRequests.delete(child)
        this.activeImageProcesses.delete(child)
        if (kind === 'image') {
          logGenerationError('ChatGPT', 'image CLI process errored', error, {
            pid: child.pid,
            requestId,
          })
        }
        const cancelled = this.cancelledProcesses.delete(child)
        reject(
          cancelled
            ? new Error('Codex generation cancelled.')
            : timedOut
              ? new Error(`Codex ${kind} generation timed out after ${timeoutMs} ms.`)
              : error,
        )
      })
      child.once('close', (code) => {
        clearTimeout(timeout)
        this.activeProcesses.delete(child)
        this.activeProcessRequests.delete(child)
        this.activeImageProcesses.delete(child)
        if (kind === 'image') {
          logGeneration('ChatGPT', 'image CLI process closed', {
            code: code ?? 1,
            pid: child.pid,
            requestId,
          })
        }
        const cancelled = this.cancelledProcesses.delete(child)
        if (cancelled) {
          reject(new Error('Codex generation cancelled.'))
          return
        }
        if (timedOut) {
          reject(new Error(`Codex ${kind} generation timed out after ${timeoutMs} ms.`))
          return
        }
        resolve({ code: code ?? 1, stdout, stderr })
      })
      if (input !== undefined) {
        child.stdin?.write(input)
      }
      child.stdin?.end()
    })
  }

  private availableSlotsFor(kind: GenerationSlot): number {
    return kind === 'text' ? this.availableTextSlots : this.availableImageSlots
  }

  private setAvailableSlots(kind: GenerationSlot, value: number): void {
    if (kind === 'text') {
      this.availableTextSlots = value
    } else {
      this.availableImageSlots = value
    }
  }

  private waitersFor(kind: GenerationSlot): SlotWaiter[] {
    return kind === 'text' ? this.textSlotWaiters : this.imageSlotWaiters
  }

  private rejectSlotWaiters(waiters: SlotWaiter[], requestId?: string): void {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (requestId !== undefined && waiter.requestId !== requestId) continue
      waiters.splice(index, 1)
      waiter.reject(new Error('Codex generation cancelled.'))
    }
  }

  private terminateProcess(child: ChildProcess): void {
    if (process.platform === 'win32' && child.pid) {
      const commandShell = process.env.ComSpec || 'cmd.exe'
      const killer = spawn(
        commandShell,
        ['/d', '/c', 'taskkill', '/pid', String(child.pid), '/t', '/f'],
        { detached: true, stdio: 'ignore', windowsHide: true },
      )
      killer.unref()
    } else {
      child.kill('SIGTERM')
    }
  }
}

export function codexImageGenerationPrompt(
  input: Pick<CodexImageRequest, 'prompt' | 'aspectRatio'>,
  referenceImagePaths: string[] = [],
  characterSheetPath = '',
  backgroundImagePath = '',
): string {
  const sheet = characterSheetPath.trim()
  const background = backgroundImagePath.trim()
  const attached = referenceImagePaths.length > 0 || Boolean(sheet) || Boolean(background)
  const attachmentLines = [
    'Call image_gen exactly once in edit mode, then stop.',
    'Pass referenced_image_paths set to exactly these files, and no others:',
  ]
  if (referenceImagePaths.length > 0) {
    attachmentLines.push(
      'Face and style references. Use these for facial construction and surface texture only:',
      ...referenceImagePaths.map((filePath) => `- ${filePath}`),
    )
  }
  if (sheet) {
    attachmentLines.push(
      'Character sheet. This file locks body proportions, silhouette, costume, and identity. Do not reproduce its grid, lineup, or turnaround:',
      `- ${sheet}`,
    )
  }
  if (background) {
    attachmentLines.push(
      'Background plate. Use this image as the exact full-frame background for this still and every other still in the batch. Do not redraw, crop, or replace it:',
      `- ${background}`,
    )
  }
  attachmentLines.push(
    'Copy each path character for character, including the drive letter and the .jpg extension.',
    'Do not shorten a path to its file name, and do not rename, convert, or rewrite the reference files.',
    'Do not run a shell command on the reference files.',
    'The text below is the scene request. It does not replace the reference images.',
    'Do not call image_gen without referenced_image_paths.',
  )
  return [
    attached
      ? attachmentLines.join('\n')
      : 'Call the image_gen tool exactly once to generate one new image, then stop.',
    'Do not finish with only a text description.',
    `The finished frame must be ${input.aspectRatio}.`,
    '',
    input.prompt.trim(),
  ].join('\n')
}

function codexGeneratedImagesDir(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'generated_images')
}

const MAX_REFERENCE_IMAGES = 5

async function stageNamedImage(workdir: string, source: string, fileName: string): Promise<string> {
  assertReferenceExtension(source)
  const destination = path.join(workdir, fileName)
  await normalizeReferenceImage(source, destination)
  return destination
}

async function stageReferenceImages(
  workdir: string,
  sources: string[] | undefined,
  limit = MAX_REFERENCE_IMAGES,
): Promise<string[]> {
  const limited = (sources || []).map((source) => source.trim()).filter(Boolean).slice(0, limit)
  const staged: string[] = []
  for (const [index, source] of limited.entries()) {
    assertReferenceExtension(source)
    const destination = path.join(workdir, `reference-${index + 1}.jpg`)
    await normalizeReferenceImage(source, destination)
    staged.push(destination)
  }
  return staged
}

function assertReferenceExtension(source: string): void {
  const extension = path.extname(source).toLowerCase()
  if (!/^\.(?:png|jpe?g|webp|gif)$/.test(extension)) {
    throw new Error(`Reference image must be a png, jpg, webp, or gif: ${source}`)
  }
}

export async function imageFromDirectory(
  directory: string,
  options: { maxDepth?: number; newerThanMs?: number } = {},
): Promise<CodexImageResult | null> {
  const images = await listGeneratedImages(directory, 0, options.maxDepth ?? 2, options.newerThanMs)
  const newest = images.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]
  if (!newest) return null
  const data = await fs.readFile(newest.filePath)
  return {
    data,
    extension: path.extname(newest.filePath).slice(1).toLowerCase() || 'png',
  }
}

async function listGeneratedImages(
  directory: string,
  depth = 0,
  maxDepth = 2,
  newerThanMs?: number,
): Promise<Array<{ filePath: string; mtimeMs: number }>> {
  if (depth > maxDepth) return []
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const images: Array<{ filePath: string; mtimeMs: number }> = []
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      images.push(...(await listGeneratedImages(filePath, depth + 1, maxDepth, newerThanMs)))
      continue
    }
    if (
      !entry.isFile() ||
      /^(?:reference-\d+|character-sheet|background)\./i.test(entry.name) ||
      !isImagePath(filePath)
    ) {
      continue
    }
    const stat = await fs.stat(filePath)
    if (newerThanMs !== undefined && stat.mtimeMs < newerThanMs) continue
    images.push({ filePath, mtimeMs: stat.mtimeMs })
  }
  return images
}

export function agentMessageFromCodexOutput(output: string): string {
  const messages: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed) as {
        item?: { type?: string; text?: string; content?: unknown; message?: unknown }
      }
      if (parsed.item?.type !== 'agent_message') continue
      const text =
        parsed.item.text ||
        (typeof parsed.item.message === 'string' ? parsed.item.message : '') ||
        textFromContent(parsed.item.content)
      if (text.trim()) messages.push(text.trim())
    } catch {
      // Non-JSON lines are not agent messages.
    }
  }
  return messages.join('\n').trim()
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const record = part as { text?: unknown; content?: unknown }
      if (typeof record.text === 'string') return record.text
      if (typeof record.content === 'string') return record.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function codexServiceTierArgs(serviceTier: LlmServiceTier): string[] {
  return serviceTier === 'fast'
    ? ['--enable', 'fast_mode', '--config', 'service_tier="priority"']
    : []
}

export function codexConcurrencyLimits(environment: NodeJS.ProcessEnv = process.env): {
  text: number
  image: number
} {
  return {
    text: boundedConcurrency(
      environment.CODEX_TEXT_CONCURRENCY || environment.CODEX_CONCURRENCY || '5',
    ),
    image: boundedConcurrency(environment.CODEX_IMAGE_CONCURRENCY || '1'),
  }
}

function boundedConcurrency(value: string | undefined): number {
  const parsed = Number(value || 5)
  if (!Number.isFinite(parsed)) return 5
  return Math.min(5, Math.max(1, Math.floor(parsed)))
}

function boundedTimeout(value: string | undefined): number {
  const parsed = Number(value || 600_000)
  if (!Number.isFinite(parsed)) return 600_000
  // Cap at 30 minutes so Luna Max script drafts can finish without hanging forever.
  return Math.min(1_800_000, Math.max(10_000, Math.floor(parsed)))
}

function timeoutForPurpose(purpose: LlmGenerationInput['purpose']): number {
  if (purpose === 'script-draft' || purpose === 'trailer-script' || purpose === 'video-idea') {
    return scriptTimeoutMs
  }
  return textTimeoutMs
}

function responseFormat(value: string): 'json' | 'markdown' | 'plain' {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  if (/^```/u.test(trimmed) || /^#{1,6}\s/u.test(trimmed)) return 'markdown'
  return 'plain'
}

function summarizeCliError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const errorLines = lines.filter((line) =>
    /^(?:error|error occurred|fatal|failed|usage limit|upgrade|unauthorized|forbidden)\b/i.test(
      line,
    ),
  )
  return (errorLines.length > 0 ? errorLines : lines).slice(-4).join('\n')
}

export async function extractImageArtifact(output: string): Promise<CodexImageResult | null> {
  const candidates: unknown[] = [output]
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      candidates.unshift(JSON.parse(trimmed))
    } catch {
      // Keep the raw output as a fallback for markdown, URLs, and data URLs.
    }
  }

  for (const candidate of candidates) {
    const image = await findImageArtifact(candidate)
    if (image) return image
  }
  return null
}

async function findImageArtifact(value: unknown, depth = 0): Promise<CodexImageResult | null> {
  if (depth > 12 || value === null || value === undefined) return null

  if (typeof value === 'string') {
    return imageFromString(value)
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const image = await findImageArtifact(item, depth + 1)
      if (image) return image
    }
    return null
  }
  if (typeof value !== 'object') return null

  const record = value as Record<string, unknown>
  const preferredKeys = [
    'b64_json',
    'base64',
    'base64_data',
    'image_data',
    'data',
    'bytes',
    'image',
    'image_url',
    'output_url',
    'result_url',
    'url',
    'path',
    'saved_path',
    'file_path',
    'filename',
    'result',
    'output',
    'content',
    'artifact',
  ]
  for (const key of preferredKeys) {
    if (!(key in record)) continue
    if (
      ['b64_json', 'base64', 'base64_data', 'image_data', 'data', 'bytes', 'result'].includes(key) &&
      typeof record[key] === 'string'
    ) {
      const encoded = record[key].trim()
      const dataUrl = await imageFromString(encoded)
      if (dataUrl) return dataUrl
      const isExplicitBase64Key = ['b64_json', 'base64', 'base64_data', 'image_data'].includes(key)
      if ((isExplicitBase64Key || encoded.length > 1000) && /^[A-Za-z0-9+/=\s]+$/.test(encoded)) {
        const data = Buffer.from(encoded, 'base64')
        if (data.length > 0) return { data, extension: extensionForData(data) }
      }
    }
    const image = await findImageArtifact(record[key], depth + 1)
    if (image) return image
  }
  for (const [key, nestedValue] of Object.entries(record)) {
    if (preferredKeys.includes(key)) continue
    const image = await findImageArtifact(nestedValue, depth + 1)
    if (image) return image
  }
  return null
}

async function imageFromString(value: string): Promise<CodexImageResult | null> {
  const trimmed = value.trim()
  const markdownMatch = trimmed.match(/!\[[^\]]*\]\(([^)\s]+)\)/i)
  if (markdownMatch) return imageFromString(markdownMatch[1])

  const dataUrlMatch = trimmed.match(/data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/i)
  if (dataUrlMatch) {
    return {
      data: Buffer.from(dataUrlMatch[2], 'base64'),
      extension: extensionForMime(dataUrlMatch[1]),
    }
  }

  const embeddedUrl = trimmed.match(/(?:https?|file):\/\/[^)\s"'<>]+/i)?.[0]
  if (embeddedUrl) {
    if (embeddedUrl.toLowerCase().startsWith('file://')) return imageFromString(embeddedUrl)
    const response = await fetch(embeddedUrl)
    if (!response.ok) return null
    const mimeType = response.headers.get('content-type') || 'image/png'
    if (!mimeType.startsWith('image/')) return null
    return {
      data: Buffer.from(await response.arrayBuffer()),
      extension: extensionForMime(mimeType),
    }
  }

  const filePath = trimmed.startsWith('file://') ? fileURLToPath(trimmed) : trimmed
  if (isImagePath(filePath)) {
    const data = await fs.readFile(filePath).catch(() => null)
    if (data) return { data, extension: path.extname(filePath).slice(1).toLowerCase() || 'png' }
  }

  if (trimmed.length > 10_000 && /^[A-Za-z0-9+/=\s]+$/.test(trimmed)) {
    return {
      data: Buffer.from(trimmed, 'base64'),
      extension: 'png',
    }
  }
  return null
}

function isImagePath(filePath: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(filePath)
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('jpeg')) return 'jpg'
  if (mimeType.includes('webp')) return 'webp'
  if (mimeType.includes('gif')) return 'gif'
  return 'png'
}

function extensionForData(data: Buffer): string {
  if (data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png'
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg'
  if (data.subarray(0, 4).toString() === 'GIF8') return 'gif'
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP') return 'webp'
  return 'png'
}

function summarizeCodexOutput(output: string): Record<string, unknown> {
  const eventTypes = new Set<string>()
  const itemTypes = new Set<string>()
  const topLevelKeys = new Set<string>()
  let jsonLines = 0

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      jsonLines += 1
      Object.keys(parsed).forEach((key) => topLevelKeys.add(key))
      if (typeof parsed.type === 'string') eventTypes.add(parsed.type)
      if (parsed.item && typeof parsed.item === 'object' && !Array.isArray(parsed.item)) {
        const itemType = (parsed.item as Record<string, unknown>).type
        if (typeof itemType === 'string') itemTypes.add(itemType)
      }
    } catch {
      // The parser already handles non-JSON output as a fallback artifact source.
    }
  }

  return {
    bytes: output.length,
    jsonLines,
    eventTypes: [...eventTypes],
    itemTypes: [...itemTypes],
    topLevelKeys: [...topLevelKeys],
  }
}
