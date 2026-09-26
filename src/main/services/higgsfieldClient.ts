import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  GenerateSceneInput,
  HiggsConnectionStatus,
  HiggsRequestStatus,
  ProjectState,
  ScriptLine,
  SequenceId,
} from '../../shared/types'
import { composeGenerationPrompt, scriptSummaryForSequence } from '../../shared/promptComposer'
import { sceneContextFingerprint, scenePromptFingerprint } from '../../shared/sceneContext'
import { logGeneration, logGenerationError } from './generationLogger'
import { ProjectStore } from './projectStore'

const executable =
  process.env.HIGGSFIELD_PATH ||
  (process.platform === 'win32' && process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'higgsfield.cmd')
    : 'higgsfield')
const DEFAULT_MODEL_ENDPOINT = 'nano_banana_2_lite'
const maxConcurrentGenerations = boundedConcurrency(process.env.HIGGSFIELD_CONCURRENCY || '1')

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

interface CliInvocation {
  command: string
  prefixArgs: string[]
  shell: boolean
}

interface AccountStatus {
  email?: string
  credits?: number | string
  subscription_plan_type?: string
  plan_type?: string
}

type CliJobResult = Record<string, unknown>
type UpdateListener = (state: ProjectState) => void

interface QueueTask {
  input: GenerateSceneInput
  projectId: string
  requestId?: string
}

export class HiggsfieldClient {
  private readonly queue: QueueTask[] = []
  private readonly queuedLineIds = new Set<string>()
  private readonly listeners = new Set<UpdateListener>()
  private activeQueueTasks = 0
  private availableGenerationSlots = maxConcurrentGenerations
  private readonly generationWaiters: Array<{
    resolve: (release: () => void) => void
  }> = []
  private queuePausedUntil = 0
  private queueResumeTimer: ReturnType<typeof setTimeout> | null = null
  private rateLimitRetryDelayMs = 30_000
  private providerPaused = false
  private readonly activeGenerationProcesses = new Set<ChildProcess>()
  private cancellationVersion = 0

  constructor(private readonly projectStore: ProjectStore) {}

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async getStatus(resolveWorkspace = true): Promise<HiggsConnectionStatus> {
    let versionResult: CommandResult
    try {
      versionResult = await this.run(['--version'])
    } catch {
      return {
        configured: false,
        installed: false,
        authenticated: false,
        modelEndpoint: DEFAULT_MODEL_ENDPOINT,
        message: 'Install the Higgsfield CLI to connect your account.',
      }
    }

    if (versionResult.code !== 0) {
      return {
        configured: false,
        installed: false,
        authenticated: false,
        modelEndpoint: DEFAULT_MODEL_ENDPOINT,
        message: 'The Higgsfield CLI could not be started.',
      }
    }

    const authResult = await this.run(['auth', 'token', '--no-color'], true, false)
    if (authResult.code !== 0) {
      return {
        configured: false,
        installed: true,
        authenticated: false,
        modelEndpoint: DEFAULT_MODEL_ENDPOINT,
        message: 'Sign in with your Higgsfield account to use its subscription credits.',
      }
    }

    const accountResult = await this.run(['account', 'status', '--json', '--no-color'])
    if (accountResult.code !== 0) {
      const detail = `${accountResult.stdout}\n${accountResult.stderr}`.toLowerCase()
      let workspaceResult: CommandResult | null = null
      if (resolveWorkspace && detail.includes('no workspace selected')) {
        workspaceResult = await this.run(['workspace', 'list', '--json', '--no-color'])
        const workspaces =
          workspaceResult.code === 0 ? extractWorkspaceIds(parseJson<unknown>(workspaceResult.stdout)) : []
        if (workspaces.length === 1) {
          const selected = await this.run(['workspace', 'set', workspaces[0], '--no-color'])
          if (selected.code === 0) return this.getStatus(false)
        }
      }
      const workspaceDetail = workspaceResult
        ? `${workspaceResult.stdout}\n${workspaceResult.stderr}`.toLowerCase()
        : ''
      return {
        configured: true,
        installed: true,
        authenticated: true,
        modelEndpoint: DEFAULT_MODEL_ENDPOINT,
        message: detail.includes('no workspace selected')
          ? workspaceDetail.includes('auth login')
            ? 'Connected through Higgsfield CLI OAuth. Generation can use your private account context.'
            : 'Connected, but no billing workspace is selected. Run `higgsfield workspace list`, then `higgsfield workspace set <workspace_id>` to view workspace credits.'
          : 'Connected through Higgsfield CLI OAuth, but account credits could not be read.',
      }
    }

    const account = parseJson<AccountStatus>(accountResult.stdout) || {}
    const credits = typeof account.credits === 'string' ? Number(account.credits) : account.credits
    return {
      configured: true,
      installed: true,
      authenticated: true,
      email: account.email,
      plan: account.subscription_plan_type || account.plan_type,
      credits: Number.isFinite(credits) ? credits : undefined,
      modelEndpoint: DEFAULT_MODEL_ENDPOINT,
      message:
        credits === 0
          ? 'Signed in, but this Higgsfield account has no available credits.'
          : 'Connected through Higgsfield CLI OAuth.',
    }
  }

  async login(): Promise<HiggsConnectionStatus> {
    const beforeLogin = await this.getStatus()
    if (!beforeLogin.installed) {
      throw new Error('Install the Higgsfield CLI before signing in.')
    }

    const result = await this.run(['auth', 'login', '--no-color'], false)
    if (result.code !== 0) {
      throw new Error(commandError(result, 'Higgsfield login failed.'))
    }
    return this.getStatus()
  }

  async generateScene(input: GenerateSceneInput): Promise<ProjectState> {
    if (this.providerPaused) {
      logGeneration('Higgsfield', 'direct generation rejected because queue is paused', { lineId: input.lineId })
      throw new Error('Higgsfield image generation is paused. Resume image generation first.')
    }
    logGeneration('Higgsfield', 'direct generation started', { lineId: input.lineId })
    const status = await this.getStatus()
    if (!status.authenticated) {
      throw new Error('Sign in with your Higgsfield account before generating a scene.')
    }

    const projectId = this.projectStore.getManifest().id
    await this.markSceneQueued(input)
    try {
      await this.processScene({ input, projectId })
      return this.projectStore.get()!
    } catch (error) {
      await this.markSceneFailed(input, projectId, error)
      throw error
    }
  }

  async queueScene(input: GenerateSceneInput): Promise<ProjectState> {
    if (this.providerPaused) {
      logGeneration('Higgsfield', 'queue request rejected because queue is paused', { lineId: input.lineId })
      throw new Error('Higgsfield image generation is paused. Resume image generation first.')
    }
    const manifest = this.projectStore.getManifest()
    const sequence = input.sequence || 'main'
    logGeneration('Higgsfield', 'queue request accepted', {
      lineId: input.lineId,
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
    if (!this.projectStore.findLine(input.lineId, sequence)) {
      throw new Error('The selected scene no longer exists.')
    }
    const queuedTask = this.queue.find((task) => task.input.lineId === input.lineId)
    if (queuedTask) {
      const state = await this.markSceneQueued(input)
      queuedTask.input = input
      queuedTask.requestId = undefined
      this.processQueue()
      return state
    }
    if (this.queuedLineIds.has(input.lineId)) {
      this.processQueue()
      return this.projectStore.get()!
    }

    const queuedInput = { ...input, sequence }
    const state = await this.markSceneQueued(queuedInput)
    this.queuedLineIds.add(input.lineId)
    this.queue.push({ input: queuedInput, projectId: manifest.id })
    logGeneration('Higgsfield', 'scene added to queue', {
      lineId: input.lineId,
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
    void this.processQueue()
    return state
  }

  async resumeQueuedScenes(): Promise<void> {
    this.providerPaused = false
    const state = this.projectStore.get()
    if (!state) return

    for (const sequence of ['main', 'trailer'] as SequenceId[]) {
      for (const line of this.projectStore.getSequenceManifest(sequence).lines) {
        if (line.imageGenerator && line.imageGenerator !== 'higgsfield') continue
        if (line.sceneStatus !== 'queued' && line.sceneStatus !== 'generating') continue
        if (this.queuedLineIds.has(line.id)) continue
        this.queuedLineIds.add(line.id)
        this.queue.push({
          input: inputForLine(line, sequence),
          projectId: state.manifest.id,
          requestId: line.higgsRequestId,
        })
      }
    }
    void this.processQueue()
  }

  async pauseQueuedScenes(): Promise<void> {
    this.providerPaused = true
    const queuedTasks = this.queue.splice(0)
    const pendingTasks = queuedTasks.filter((task) => !task.requestId)
    this.queue.push(...queuedTasks.filter((task) => Boolean(task.requestId)))
    pendingTasks.forEach((task) => this.queuedLineIds.delete(task.input.lineId))
    await Promise.all(
      pendingTasks.map((task) =>
        this.markSceneFailed(
          task.input,
          task.projectId,
          new Error('Higgsfield generation was paused because another image provider is selected.'),
        ),
      ),
    )

    if (!this.projectStore.get()) return
    const legacyQueuedLines = allSequenceLines(this.projectStore).filter(
      ({ line }) =>
        !line.imageGenerator &&
        (line.sceneStatus === 'queued' || line.sceneStatus === 'generating'),
    )
    if (legacyQueuedLines.length === 0) return

    for (const { line } of legacyQueuedLines) {
      line.sceneStatus = 'failed'
      line.higgsStatus = 'failed'
      line.error = 'This legacy Higgsfield job was paused because another image provider is selected.'
    }
    await this.saveAndNotify()
  }

  resumeGenerationQueue(): void {
    this.providerPaused = false
    logGeneration('Higgsfield', 'queue unpaused', {
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
  }

  async cancelQueuedScenes(): Promise<void> {
    this.cancellationVersion += 1
    this.providerPaused = true
    const pendingTasks = this.queue.splice(0)
    logGeneration('Higgsfield', 'cancel started', {
      pending: pendingTasks.length,
      active: this.activeQueueTasks,
    })
    pendingTasks.forEach((task) => this.queuedLineIds.delete(task.input.lineId))
    if (this.queueResumeTimer) {
      clearTimeout(this.queueResumeTimer)
      this.queueResumeTimer = null
    }
    this.queuePausedUntil = 0
    this.rateLimitRetryDelayMs = 30_000
    for (const child of this.activeGenerationProcesses) this.terminateProcess(child)

    await Promise.all(
      pendingTasks.map((task) =>
        this.markSceneFailed(
          task.input,
          task.projectId,
          new Error('Higgsfield image generation was cancelled.'),
        ),
      ),
    )

    if (!this.projectStore.get()) return
    const activeLines = allSequenceLines(this.projectStore).filter(
      ({ line }) =>
        (!line.imageGenerator || line.imageGenerator === 'higgsfield') &&
        (line.sceneStatus === 'queued' || line.sceneStatus === 'generating'),
    )
    if (activeLines.length === 0) return
    for (const { line } of activeLines) {
      line.sceneStatus = 'failed'
      line.higgsStatus = 'failed'
      line.error = 'Higgsfield image generation was cancelled.'
    }
    await this.saveAndNotify()
    logGeneration('Higgsfield', 'cancel marked scenes', { count: activeLines.length })
  }

  private processQueue(): void {
    if (this.queuePausedUntil > Date.now()) {
      logGeneration('Higgsfield', 'dispatcher waiting for rate-limit backoff', {
        queued: this.queue.length,
        active: this.activeQueueTasks,
      })
      return
    }

    while (this.activeQueueTasks < maxConcurrentGenerations && this.queue.length > 0) {
      if (this.providerPaused && !this.queue[0].requestId) {
        logGeneration('Higgsfield', 'dispatcher blocked because queue is paused', {
          queued: this.queue.length,
          active: this.activeQueueTasks,
        })
        return
      }
      const task = this.queue.shift()!
      this.activeQueueTasks += 1
      logGeneration('Higgsfield', 'worker started', {
        lineId: task.input.lineId,
        queued: this.queue.length,
        active: this.activeQueueTasks,
      })
      void this.processQueuedTask(task).finally(() => {
        this.activeQueueTasks -= 1
        logGeneration('Higgsfield', 'worker released', {
          lineId: task.input.lineId,
          queued: this.queue.length,
          active: this.activeQueueTasks,
        })
        this.processQueue()
      })
    }
  }

  private async processQueuedTask(task: QueueTask): Promise<void> {
    let requeued = false
    try {
      const state = this.projectStore.get()
      if (!state || state.manifest.id !== task.projectId) {
        throw new Error('The queued scene belongs to a different project.')
      }
      await this.processScene(task, this.cancellationVersion)
      logGeneration('Higgsfield', 'scene completed', { lineId: task.input.lineId })
      this.rateLimitRetryDelayMs = 30_000
    } catch (error) {
      if (isRateLimitError(error)) {
        logGenerationError('Higgsfield', 'scene hit rate limit', error, { lineId: task.input.lineId })
        this.queue.unshift(task)
        requeued = true
        this.pauseQueueForRateLimit()
        return
      }
      logGenerationError('Higgsfield', 'scene worker failed', error, { lineId: task.input.lineId })
      console.error(`[Higgsfield] scene ${task.input.lineId} failed`, error)
      await this.markSceneFailed(task.input, task.projectId, error)
    } finally {
      if (!requeued) this.queuedLineIds.delete(task.input.lineId)
    }
  }

  private async processScene(task: QueueTask, cancellationVersion = this.cancellationVersion): Promise<void> {
    const releaseSlot = await this.acquireGenerationSlot()
    try {
      const state = this.projectStore.get()
      if (!state || state.manifest.id !== task.projectId) {
        throw new Error('The queued scene belongs to a different project.')
      }

      const status = await this.getStatus()
      if (!status.authenticated) {
        throw new Error('Sign in with your Higgsfield account before generating a scene.')
      }
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('Higgsfield image generation was cancelled.')
      }
      if (this.providerPaused && !task.requestId) {
        throw new Error('Higgsfield generation was paused because another image provider is selected.')
      }

      const line = this.projectStore.findLine(task.input.lineId, task.input.sequence)
      if (!line) throw new Error('The selected scene no longer exists.')
      const sequence = task.input.sequence || 'main'
      const canonicalRecord =
        line.sceneRecord?.sourceFingerprint === sceneContextFingerprint(state.manifest, sequence)
          ? line.sceneRecord
          : undefined

      let requestId = task.requestId
      let job: CliJobResult = {}
      if (!requestId) {
        if (cancellationVersion !== this.cancellationVersion) {
          throw new Error('Higgsfield image generation was cancelled.')
        }
        if (this.providerPaused) {
          throw new Error('Higgsfield generation was paused because another image provider is selected.')
        }
        const generationPrompt = composeGenerationPrompt(
          task.input.prompt,
          state.manifest.visualBible,
          task.input.aspectRatio,
          scriptSummaryForSequence(state.manifest, sequence),
          canonicalRecord,
        )
        const result = await this.run([
          'generate',
          'create',
          DEFAULT_MODEL_ENDPOINT,
          '--prompt',
          generationPrompt,
          '--aspect_ratio',
          task.input.aspectRatio,
          '--resolution',
          '1k',
          '--json',
          '--no-color',
        ], true, true, 'generation')
        logGeneration('Higgsfield', 'create CLI process returned', {
          lineId: task.input.lineId,
          code: result.code,
          stdoutBytes: result.stdout.length,
          stderrBytes: result.stderr.length,
        })
        if (result.code !== 0) {
          throw new Error(commandError(result, 'Higgsfield could not queue the scene.'))
        }

        job = parseJson<CliJobResult>(result.stdout) || {}
        requestId = firstString(job, ['id', 'job_id', 'request_id']) || extractJobId(result.stdout)
        if (!requestId) {
          const output = `${result.stdout}\n${result.stderr}`.trim()
          throw new Error(
            `Higgsfield did not return a scene job ID.${output ? ` CLI output: ${output.slice(-500)}` : ''}`,
          )
        }
        line.higgsRequestId = requestId
      }
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('Higgsfield image generation was cancelled.')
      }

      line.sceneStatus = 'generating'
      line.higgsStatus = toRequestStatus(firstString(job, ['status'])) || 'in_progress'
      line.error = undefined
      await this.saveAndNotify()
      logGeneration('Higgsfield', 'scene marked generating', { lineId: task.input.lineId })

      const waitResult = await this.run([
        'generate',
        'wait',
        requestId,
        '--json',
        '--no-color',
      ], true, true, 'generation')
      logGeneration('Higgsfield', 'wait CLI process returned', {
        lineId: task.input.lineId,
        code: waitResult.code,
        stdoutBytes: waitResult.stdout.length,
        stderrBytes: waitResult.stderr.length,
      })
      if (waitResult.code !== 0) {
        throw new Error(commandError(waitResult, 'Higgsfield could not finish the scene.'))
      }
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('Higgsfield image generation was cancelled.')
      }

      job = parseJson<CliJobResult>(waitResult.stdout) || {}
      const imageUrl = findImageUrl(job) || findUrl(waitResult.stdout)
      if (!imageUrl) throw new Error('Higgsfield completed without returning an image URL.')

      line.higgsStatus = toRequestStatus(firstString(job, ['status'])) || 'completed'
      const imageResponse = await fetch(imageUrl)
      if (!imageResponse.ok) throw new Error('The generated image could not be downloaded.')
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer())
      const imageFileExtension = imageExtension(imageResponse.headers.get('content-type'))
      const currentLine = this.projectStore.findLine(line.id, task.input.sequence)
      if (
        !currentLine ||
        (task.input.promptFingerprint &&
          scenePromptFingerprint(currentLine.scenePrompt) !== task.input.promptFingerprint)
      ) {
        logGeneration('Higgsfield', 'discarded stale image result', {
          lineId: task.input.lineId,
        })
        return
      }
      const savedState = await this.projectStore.saveImage(
        line.id,
        imageBuffer,
        imageFileExtension,
        task.input.sequence,
      )
      logGeneration('Higgsfield', 'image saved locally', {
        lineId: task.input.lineId,
        imagePath: findLineInState(savedState, task.input.lineId)?.imagePath,
      })
      this.notify(savedState)
    } finally {
      releaseSlot()
    }
  }

  private async markSceneQueued(input: GenerateSceneInput): Promise<ProjectState> {
    const line = this.projectStore.findLine(input.lineId, input.sequence)
    if (!line) throw new Error('The selected scene no longer exists.')

    line.scenePrompt = input.prompt
    line.sceneStatus = 'queued'
    line.imageGenerator = 'higgsfield'
    line.higgsStatus = 'queued'
    line.higgsRequestId = undefined
    line.error = undefined
    return this.saveAndNotify()
  }

  private async markSceneFailed(
    input: GenerateSceneInput,
    projectId: string,
    error: unknown,
  ): Promise<void> {
    const state = this.projectStore.get()
    if (!state || state.manifest.id !== projectId) return
    const line = this.projectStore.findLine(input.lineId, input.sequence)
    if (!line) return

    line.sceneStatus = 'failed'
    line.higgsStatus = 'failed'
    line.error = error instanceof Error ? error.message : 'Scene generation failed.'
    await this.saveAndNotify()
  }

  private async saveAndNotify(): Promise<ProjectState> {
    const state = await this.projectStore.save()
    this.notify(state)
    return state
  }

  private notify(state: ProjectState): void {
    for (const listener of this.listeners) listener(state)
  }

  private acquireGenerationSlot(): Promise<() => void> {
    if (this.availableGenerationSlots > 0) {
      this.availableGenerationSlots -= 1
      return Promise.resolve(() => this.releaseGenerationSlot())
    }
    return new Promise((resolve) => {
      this.generationWaiters.push({ resolve })
    })
  }

  private releaseGenerationSlot(): void {
    const waiter = this.generationWaiters.shift()
    if (waiter) {
      waiter.resolve(() => this.releaseGenerationSlot())
      return
    }
    this.availableGenerationSlots += 1
  }

  private pauseQueueForRateLimit(): void {
    if (this.queueResumeTimer) return

    const delay = this.rateLimitRetryDelayMs
    this.queuePausedUntil = Date.now() + delay
    this.rateLimitRetryDelayMs = Math.min(delay * 2, 5 * 60_000)
    console.warn(`[Higgsfield] rate limit reached; retrying queued scenes in ${Math.round(delay / 1000)}s`)
    this.queueResumeTimer = setTimeout(() => {
      this.queueResumeTimer = null
      this.queuePausedUntil = 0
      this.processQueue()
    }, delay)
  }

  private run(
    args: string[],
    windowsHide = true,
    captureOutput = true,
    kind: 'general' | 'generation' = 'general',
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const invocation = resolveCliInvocation()
      const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
        windowsHide,
        shell: invocation.shell,
      })
      if (kind === 'generation') this.activeGenerationProcesses.add(child)
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        if (captureOutput) stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', (error) => {
        this.activeGenerationProcesses.delete(child)
        reject(error)
      })
      child.once('close', (code) => {
        this.activeGenerationProcesses.delete(child)
        resolve({ code: code ?? 1, stdout, stderr })
      })
    })
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

function inputForLine(line: ScriptLine, sequence: SequenceId = 'main'): GenerateSceneInput {
  return {
    lineId: line.id,
    sequence,
    prompt: line.scenePrompt,
    modelEndpoint: DEFAULT_MODEL_ENDPOINT,
    aspectRatio: sequence === 'trailer' ? '9:16' : '16:9',
    resolution: '1k',
  }
}

function allSequenceLines(projectStore: ProjectStore): Array<{ line: ScriptLine; sequence: SequenceId }> {
  return (['main', 'trailer'] as SequenceId[]).flatMap((sequence) =>
    projectStore.getSequenceManifest(sequence).lines.map((line) => ({ line, sequence })),
  )
}

function findLineInState(state: ProjectState, lineId: string): ScriptLine | undefined {
  return (
    state.manifest.lines.find((line) => line.id === lineId) ||
    state.manifest.trailer?.lines.find((line) => line.id === lineId)
  )
}

function resolveCliInvocation(): CliInvocation {
  if (process.platform === 'win32' && executable.toLowerCase().endsWith('.cmd')) {
    const cliEntry = join(dirname(executable), 'node_modules', '@higgsfield', 'cli', 'bin', 'higgsfield.js')
    const nodeCandidates = [
      process.env.NODE_EXECUTABLE,
      process.env.ProgramFiles ? join(process.env.ProgramFiles, 'nodejs', 'node.exe') : undefined,
      process.env.LOCALAPPDATA
        ? join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe')
        : undefined,
    ].filter((candidate): candidate is string => Boolean(candidate))
    const nodeExecutable = nodeCandidates.find((candidate) => existsSync(candidate)) || 'node'

    if (existsSync(cliEntry)) {
      return {
        command: nodeExecutable,
        prefixArgs: [cliEntry],
        shell: false,
      }
    }
  }

  return {
    command: executable,
    prefixArgs: [],
    shell: process.platform === 'win32',
  }
}

function parseJson<T>(value: string): T | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    const lines = trimmed.split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]) as T
      } catch {
        // Keep looking for the JSON payload after CLI progress output.
      }
    }
    return null
  }
}

function firstString(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, keys)
      if (found) return found
    }
    return undefined
  }
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  for (const key of keys) {
    if (typeof record[key] === 'string' && record[key]) return record[key] as string
  }
  for (const nestedValue of Object.values(record)) {
    const found = firstString(nestedValue, keys)
    if (found) return found
  }
  return undefined
}

function extractJobId(value: string): string | undefined {
  return value.match(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  )?.[0]
}

function extractWorkspaceIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractWorkspaceIds(item))
  }
  if (!value || typeof value !== 'object') return []

  const record = value as Record<string, unknown>
  const directId = firstString(record, ['id', 'workspace_id'])
  if (directId) return [directId]
  for (const key of ['workspaces', 'data', 'items', 'results']) {
    const ids = extractWorkspaceIds(record[key])
    if (ids.length) return ids
  }
  return []
}

function findImageUrl(value: unknown): string | null {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) return value
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageUrl(item)
      if (found) return found
    }
    return null
  }

  const record = value as Record<string, unknown>
  for (const key of ['result_url', 'image_url', 'output_url', 'url']) {
    if (typeof record[key] === 'string' && /^https?:\/\//.test(record[key])) {
      return record[key] as string
    }
  }
  for (const key of ['images', 'outputs', 'result', 'output', 'result_urls', 'urls']) {
    const found = findImageUrl(record[key])
    if (found) return found
  }
  return null
}

function findUrl(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s"'\\]+/)
  return match?.[0] || null
}

function toRequestStatus(value?: string): HiggsRequestStatus | undefined {
  if (
    value === 'queued' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'nsfw' ||
    value === 'canceled'
  ) {
    return value
  }
  return undefined
}

function commandError(result: CommandResult, fallback: string): string {
  const detail = `${result.stderr}\n${result.stdout}`.trim()
  return detail || fallback
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /rate_limit_reached|concurrent_jobs_limit|rate limit/i.test(message)
}

function imageExtension(contentType: string | null): string {
  if (contentType?.includes('png')) return 'png'
  if (contentType?.includes('webp')) return 'webp'
  return 'jpg'
}

function boundedConcurrency(value: string | undefined): number {
  const parsed = Number(value || 5)
  if (!Number.isFinite(parsed)) return 5
  return Math.min(5, Math.max(1, Math.floor(parsed)))
}
