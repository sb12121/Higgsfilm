import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  GenerateSceneInput,
  HiggsConnectionStatus,
  HiggsRequestStatus,
  ProjectState,
  ScriptLine,
} from '../../shared/types'
import { composeGenerationPrompt } from '../../shared/promptComposer'
import { ProjectStore } from './projectStore'

const executable =
  process.env.HIGGSFIELD_PATH ||
  (process.platform === 'win32' && process.env.APPDATA
    ? join(process.env.APPDATA, 'npm', 'higgsfield.cmd')
    : 'higgsfield')
const DEFAULT_MODEL_ENDPOINT = 'nano_banana_2_lite'
const maxConcurrentGenerations = boundedConcurrency(process.env.HIGGSFIELD_CONCURRENCY)

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
    const manifest = this.projectStore.getManifest()
    if (!manifest.lines.some((line) => line.id === input.lineId)) {
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

    const state = await this.markSceneQueued(input)
    this.queuedLineIds.add(input.lineId)
    this.queue.push({ input, projectId: manifest.id })
    void this.processQueue()
    return state
  }

  async resumeQueuedScenes(): Promise<void> {
    const state = this.projectStore.get()
    if (!state) return

    for (const line of state.manifest.lines) {
      if (line.sceneStatus !== 'queued' && line.sceneStatus !== 'generating') continue
      if (this.queuedLineIds.has(line.id)) continue
      this.queuedLineIds.add(line.id)
      this.queue.push({
        input: inputForLine(line),
        projectId: state.manifest.id,
        requestId: line.higgsRequestId,
      })
    }
    void this.processQueue()
  }

  private processQueue(): void {
    while (this.activeQueueTasks < maxConcurrentGenerations && this.queue.length > 0) {
      const task = this.queue.shift()!
      this.activeQueueTasks += 1
      void this.processQueuedTask(task).finally(() => {
        this.activeQueueTasks -= 1
        this.processQueue()
      })
    }
  }

  private async processQueuedTask(task: QueueTask): Promise<void> {
    try {
      const state = this.projectStore.get()
      if (!state || state.manifest.id !== task.projectId) {
        throw new Error('The queued scene belongs to a different project.')
      }
      await this.processScene(task)
    } catch (error) {
      console.error(`[Higgsfield] scene ${task.input.lineId} failed`, error)
      await this.markSceneFailed(task.input, task.projectId, error)
    } finally {
      this.queuedLineIds.delete(task.input.lineId)
    }
  }

  private async processScene(task: QueueTask): Promise<void> {
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

      const line = state.manifest.lines.find((candidate) => candidate.id === task.input.lineId)
      if (!line) throw new Error('The selected scene no longer exists.')

      let requestId = task.requestId
      let job: CliJobResult = {}
      if (!requestId) {
        const generationPrompt = composeGenerationPrompt(task.input.prompt, state.manifest.visualBible)
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
        ])
        if (result.code !== 0) {
          throw new Error(commandError(result, 'Higgsfield could not queue the scene.'))
        }

        job = parseJson<CliJobResult>(result.stdout) || {}
        requestId = firstString(job, ['id', 'job_id', 'request_id'])
        if (!requestId) throw new Error('Higgsfield did not return a scene job ID.')
        line.higgsRequestId = requestId
      }

      line.sceneStatus = 'generating'
      line.higgsStatus = toRequestStatus(firstString(job, ['status'])) || 'in_progress'
      line.error = undefined
      await this.saveAndNotify()

      const waitResult = await this.run([
        'generate',
        'wait',
        requestId,
        '--json',
        '--no-color',
      ])
      if (waitResult.code !== 0) {
        throw new Error(commandError(waitResult, 'Higgsfield could not finish the scene.'))
      }

      job = parseJson<CliJobResult>(waitResult.stdout) || {}
      const imageUrl = findImageUrl(job) || findUrl(waitResult.stdout)
      if (!imageUrl) throw new Error('Higgsfield completed without returning an image URL.')

      line.higgsStatus = toRequestStatus(firstString(job, ['status'])) || 'completed'
      const imageResponse = await fetch(imageUrl)
      if (!imageResponse.ok) throw new Error('The generated image could not be downloaded.')
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer())
      const savedState = await this.projectStore.saveImage(
        line.id,
        imageBuffer,
        imageExtension(imageResponse.headers.get('content-type')),
      )
      this.notify(savedState)
    } finally {
      releaseSlot()
    }
  }

  private async markSceneQueued(input: GenerateSceneInput): Promise<ProjectState> {
    const line = this.projectStore
      .getManifest()
      .lines.find((candidate) => candidate.id === input.lineId)
    if (!line) throw new Error('The selected scene no longer exists.')

    line.scenePrompt = input.prompt
    line.sceneStatus = 'queued'
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
    const line = state.manifest.lines.find((candidate) => candidate.id === input.lineId)
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

  private run(args: string[], windowsHide = true, captureOutput = true): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const invocation = resolveCliInvocation()
      const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
        windowsHide,
        shell: invocation.shell,
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        if (captureOutput) stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    })
  }
}

function inputForLine(line: ScriptLine): GenerateSceneInput {
  return {
    lineId: line.id,
    prompt: line.scenePrompt,
    modelEndpoint: DEFAULT_MODEL_ENDPOINT,
    aspectRatio: '16:9',
    resolution: '1k',
  }
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
  return undefined
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
