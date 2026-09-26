import { randomUUID } from 'node:crypto'
import type {
  AspectRatio,
  ComfyConnectionStatus,
  ComfyUiSettings,
  GenerateSceneInput,
  ProjectState,
  ScriptLine,
  SequenceId,
} from '../../shared/types'
import {
  DEFAULT_COMFY_UI_SETTINGS,
  normalizeComfyUiSettings,
} from '../../shared/types'
import { isZImageModel } from '../../shared/imageModels'
import {
  composeGenerationPrompt,
  composeZImagePrompt,
  scriptSummaryForSequence,
} from '../../shared/promptComposer'
import { sceneContextFingerprint, scenePromptFingerprint } from '../../shared/sceneContext'
import styleWorkflowTemplate from '../workflows/comfyui-flux-style-api.json'
import previousReferenceWorkflowTemplate from '../workflows/comfyui-flux-prevref-api.json'
import zImageWorkflowTemplate from '../workflows/comfyui-z-image-turbo-api.json'
import { logGeneration, logGenerationError } from './generationLogger'
import { ensureImageExportResolution, exportCanvasForAspect } from './imageUpscale'
import { ProjectStore } from './projectStore'
import { AppSettingsStore } from './appSettingsStore'

type WorkflowNode = {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

type Workflow = Record<string, WorkflowNode>

type HistoryImage = {
  filename: string
  subfolder?: string
  type?: string
}

type HistoryEntry = {
  outputs?: Record<string, { images?: HistoryImage[] }>
  status?: {
    status_str?: string
    completed?: boolean
    messages?: unknown[]
  }
}

type QueueTask = {
  input: GenerateSceneInput
  projectId: string
}

type UpdateListener = (state: ProjectState) => void

class ComfyUiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ComfyUiError'
  }
}

const POLL_MS = 1500
const TIMEOUT_MS = 560_000
const LOADING_STALL_MS = 4 * 60_000
const SAMPLING_STALL_MS = 2 * 60_000
const REFERENCE_STRENGTH_ON = 0.05
const STYLE_SAVE_NODE = '13'
const STYLE_UPSCALE_NODE = '14'
const PREVIOUS_REFERENCE_SAVE_NODE = '19'
const PREVIOUS_REFERENCE_UPSCALE_NODE = '20'
const Z_IMAGE_SAVE_NODE = '10'
const Z_IMAGE_UPSCALE_NODE = '11'

const UNET_NODE = '1'
const CLIP_NODE = '2'
const VAE_NODE = '3'
const PROMPT_NODE = '4'
const GUIDANCE_NODE = '5'

const STYLE_EMPTY_LATENT = '6'
const STYLE_SCHEDULER = '7'
const STYLE_NOISE = '8'
const STYLE_SAMPLER = '9'

const REFERENCE_LOAD = '6'
const REFERENCE_SCALE = '7'
const REFERENCE_BLEND = '10'
const REFERENCE_EMPTY_LATENT = '9'
const REFERENCE_SCHEDULER = '13'
const REFERENCE_NOISE = '14'
const REFERENCE_SAMPLER = '15'

interface ModelCache {
  baseUrl: string
  models: string[]
  loadedAt: number
}

type ComfyProgressState = {
  lastActivityAt: number
  samplingStarted: boolean
  executionStarted: boolean
}

export class ComfyUiClient {
  private readonly queue: QueueTask[] = []
  private readonly queuedLineIds = new Set<string>()
  private readonly listeners = new Set<UpdateListener>()
  private readonly activeControllers = new Map<string, AbortController>()
  private readonly slotWaiters: Array<(release: () => void) => void> = []
  private activeQueueTasks = 0
  private availableGenerationSlots = 1
  private providerPaused = false
  private cancellationVersion = 0
  private modelCache: ModelCache | null = null

  constructor(
    private readonly projectStore: ProjectStore,
    private readonly settings: AppSettingsStore,
  ) {}

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async getStatus(): Promise<ComfyConnectionStatus> {
    const settings = normalizeComfyUiSettings(this.settings.get().comfy)
    const baseUrl = normalizeComfyUrl(settings.baseUrl)
    try {
      const response = await comfyFetch(`${baseUrl}/system_stats`, {
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) {
        return {
          configured: true,
          reachable: false,
          baseUrl,
          models: [],
          selectedModel: settings.diffusionModel,
          message: `ComfyUI responded with HTTP ${response.status}.`,
        }
      }

      let models: string[] = []
      try {
        models = await this.listDiffusionModels(baseUrl)
      } catch (error) {
        logGenerationError('ComfyUI', 'model discovery failed', error)
      }
      const selectedModel = resolveAvailableModel(settings.diffusionModel, models) || settings.diffusionModel
      return {
        configured: true,
        reachable: true,
        baseUrl,
        models,
        selectedModel,
        message:
          models.length > 0
            ? `Connected to ComfyUI. ${models.length} diffusion model(s) available.`
            : 'Connected to ComfyUI, but no diffusion models were reported.',
      }
    } catch (error) {
      return {
        configured: true,
        reachable: false,
        baseUrl,
        models: [],
        selectedModel: settings.diffusionModel,
        message: error instanceof Error ? error.message : 'Could not reach ComfyUI.',
      }
    }
  }

  async generateScene(input: GenerateSceneInput): Promise<ProjectState> {
    if (this.providerPaused) {
      throw new Error('ComfyUI image generation is paused. Resume image generation first.')
    }
    const projectId = this.projectStore.getManifest().id
    await this.markSceneQueued(input)
    try {
      await this.processScene({ input, projectId }, this.cancellationVersion)
      return this.projectStore.get()!
    } catch (error) {
      logGenerationError('ComfyUI', 'direct generation failed', error, { lineId: input.lineId })
      await this.markSceneFailed(input, projectId, error)
      throw error
    }
  }

  async queueScene(input: GenerateSceneInput): Promise<ProjectState> {
    if (this.providerPaused) {
      throw new Error('ComfyUI image generation is paused. Resume image generation first.')
    }
    const manifest = this.projectStore.getManifest()
    const sequence = input.sequence || 'main'
    if (!this.projectStore.findLine(input.lineId, sequence)) {
      throw new Error('The selected scene no longer exists.')
    }
    if (this.queuedLineIds.has(input.lineId)) {
      return this.projectStore.get()!
    }

    const queuedInput = { ...input, sequence }
    const state = await this.markSceneQueued(queuedInput)
    this.queuedLineIds.add(input.lineId)
    this.queue.push({ input: queuedInput, projectId: manifest.id })
    logGeneration('ComfyUI', 'scene added to queue', {
      lineId: input.lineId,
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
    this.processQueue()
    return state
  }

  async resumeQueuedScenes(): Promise<void> {
    this.providerPaused = false
    const state = this.projectStore.get()
    if (!state) return

    for (const sequence of ['main', 'trailer'] as SequenceId[]) {
      for (const line of this.projectStore.getSequenceManifest(sequence).lines) {
        if (line.imageGenerator !== 'comfyui') continue
        if (line.sceneStatus !== 'queued' && line.sceneStatus !== 'generating') continue
        if (this.queuedLineIds.has(line.id)) continue
        this.queuedLineIds.add(line.id)
        this.queue.push({
          input: inputForLine(line, sequence),
          projectId: state.manifest.id,
        })
      }
    }
    logGeneration('ComfyUI', 'resume scan complete', {
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
    this.processQueue()
  }

  async pauseQueuedScenes(): Promise<void> {
    this.providerPaused = true
    const pendingTasks = this.queue.splice(0)
    pendingTasks.forEach((task) => this.queuedLineIds.delete(task.input.lineId))
    await Promise.all(
      pendingTasks.map((task) =>
        this.markSceneFailed(
          task.input,
          task.projectId,
          new Error('ComfyUI generation was paused because another image provider is selected.'),
        ),
      ),
    )

    const notSubmittedLines = allSequenceLines(this.projectStore).filter(
      ({ line }) =>
        line.imageGenerator === 'comfyui' &&
        line.sceneStatus === 'queued' &&
        !line.comfyPromptId,
    )
    if (notSubmittedLines.length === 0) return
    for (const { line } of notSubmittedLines) {
      line.sceneStatus = 'failed'
      line.error = 'This ComfyUI job was paused because another image provider is selected.'
    }
    await this.saveAndNotify()
  }

  resumeGenerationQueue(): void {
    this.providerPaused = false
    logGeneration('ComfyUI', 'queue unpaused', {
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
    this.processQueue()
  }

  async cancelQueuedScenes(): Promise<void> {
    this.cancellationVersion += 1
    this.providerPaused = true
    const pendingTasks = this.queue.splice(0)
    pendingTasks.forEach((task) => this.queuedLineIds.delete(task.input.lineId))
    const activeLineIds = [...this.activeControllers.keys()]
    const remotePromptIds = allSequenceLines(this.projectStore)
      .map(({ line }) => line)
      .filter(
        (line) =>
          line.imageGenerator === 'comfyui' &&
          (line.sceneStatus === 'queued' || line.sceneStatus === 'generating') &&
          line.comfyPromptId,
      )
      .map((line) => line.comfyPromptId!)
      .filter((id, index, all) => all.indexOf(id) === index) ?? []

    for (const controller of this.activeControllers.values()) controller.abort()
    await this.cancelRemoteJobs(remotePromptIds, activeLineIds.length > 0)

    await Promise.all(
      pendingTasks.map((task) =>
        this.markSceneFailed(
          task.input,
          task.projectId,
          new Error('ComfyUI image generation was cancelled.'),
        ),
      ),
    )

    const manifest = this.projectStore.getManifest()
    const activeLines = allSequenceLines(this.projectStore).filter(
      ({ line }) =>
        line.imageGenerator === 'comfyui' &&
        (line.sceneStatus === 'queued' || line.sceneStatus === 'generating'),
    )
    for (const { line } of activeLines) {
      line.sceneStatus = 'failed'
      line.comfyPromptId = undefined
      line.error = 'ComfyUI image generation was cancelled.'
    }
    if (activeLines.length > 0) await this.saveAndNotify()
    logGeneration('ComfyUI', 'cancel complete', {
      pending: pendingTasks.length,
      active: activeLines.length,
    })
  }

  private processQueue(): void {
    if (this.providerPaused) return
    while (this.activeQueueTasks < 1 && this.queue.length > 0) {
      const task = this.queue.shift()!
      this.activeQueueTasks += 1
      logGeneration('ComfyUI', 'worker started', {
        lineId: task.input.lineId,
        queued: this.queue.length,
        active: this.activeQueueTasks,
      })
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
      await this.processScene(task, this.cancellationVersion)
      logGeneration('ComfyUI', 'scene completed', { lineId: task.input.lineId })
    } catch (error) {
      logGenerationError('ComfyUI', 'scene worker failed', error, { lineId: task.input.lineId })
      await this.markSceneFailed(task.input, task.projectId, error)
    } finally {
      this.queuedLineIds.delete(task.input.lineId)
    }
  }

  private async processScene(task: QueueTask, cancellationVersion: number): Promise<void> {
    const releaseSlot = await this.acquireGenerationSlot()
    const controller = new AbortController()
    this.activeControllers.set(task.input.lineId, controller)
    const promptIdRef = { current: null as string | null }
    const progressState: ComfyProgressState = {
      lastActivityAt: Date.now(),
      samplingStarted: false,
      executionStarted: false,
    }
    let progressSubscription: { ready: Promise<void>; close: () => void } | undefined

    try {
      const state = this.projectStore.get()
      if (!state || state.manifest.id !== task.projectId) {
        throw new Error('The queued scene belongs to a different project.')
      }
      const manifest = this.projectStore.getManifest()
      const sequence = task.input.sequence || 'main'
      const sequenceManifest = this.projectStore.getSequenceManifest(sequence)
      const line = this.projectStore.findLine(task.input.lineId, sequence)
      if (!line) throw new Error('The selected scene no longer exists.')
      const canonicalRecord =
        line.sceneRecord?.sourceFingerprint === sceneContextFingerprint(manifest, sequence)
          ? line.sceneRecord
          : undefined
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('ComfyUI image generation was cancelled.')
      }
      if (this.providerPaused && !line.comfyPromptId) {
        throw new Error('ComfyUI generation was paused because another image provider is selected.')
      }

      const comfySettings = normalizeComfyUiSettings(this.settings.get().comfy)
      const baseUrl = normalizeComfyUrl(comfySettings.baseUrl)
      let promptId = line.comfyPromptId
      let saveNode = isZImageModel(comfySettings.diffusionModel)
        ? Z_IMAGE_SAVE_NODE
        : STYLE_SAVE_NODE

      if (!promptId) {
        const modelName = await this.resolveDiffusionModel(baseUrl, comfySettings.diffusionModel)
        const generationPrompt = isZImageModel(modelName)
          ? composeZImagePrompt(
              task.input.prompt,
              manifest.visualBible,
              task.input.aspectRatio,
              canonicalRecord,
            )
          : composeGenerationPrompt(
              task.input.prompt,
              manifest.visualBible,
              task.input.aspectRatio,
              scriptSummaryForSequence(manifest, sequence),
              canonicalRecord,
            )
        let workflow: Workflow
        if (isZImageModel(modelName)) {
          workflow = buildZImageWorkflow(
            generationPrompt,
            task.input.aspectRatio,
            comfySettings,
            modelName,
          )
          saveNode = Z_IMAGE_SAVE_NODE
        } else {
          let previousSceneImage: string | undefined
          if (shouldUsePreviousReference(comfySettings) && line.index > 0) {
            const previousLine = sequenceManifest.lines[line.index - 1]
            if (previousLine?.imagePath && previousLine.sceneStatus === 'complete') {
              previousSceneImage = (
                await this.projectStore.assetDataUrl(previousLine.imagePath)
              )?.dataUrl
            }
          }
          if (previousSceneImage?.startsWith('data:')) {
            const uploadedName = await uploadImage(baseUrl, previousSceneImage)
            workflow = buildPreviousReferenceWorkflow(
              generationPrompt,
              task.input.aspectRatio,
              comfySettings,
              modelName,
              uploadedName,
            )
            saveNode = PREVIOUS_REFERENCE_SAVE_NODE
          } else {
            workflow = buildStyleWorkflow(
              generationPrompt,
              task.input.aspectRatio,
              comfySettings,
              modelName,
            )
          }
        }

        const clientId = randomUUID()
        progressState.lastActivityAt = Date.now()
        progressSubscription = subscribeComfyProgress(
          baseUrl,
          clientId,
          promptIdRef,
          task.input.lineId,
          progressState,
        )
        await progressSubscription.ready
        promptId = await queuePrompt(baseUrl, workflow, clientId)
        promptIdRef.current = promptId
        line.comfyPromptId = promptId
        line.sceneStatus = 'generating'
        line.error = undefined
        await this.saveAndNotify()
        logGeneration('ComfyUI', 'workflow queued', {
          lineId: task.input.lineId,
          promptId,
          model: modelName,
          aspectRatio: task.input.aspectRatio,
        })
      } else {
        const clientId = randomUUID()
        progressState.lastActivityAt = Date.now()
        promptIdRef.current = promptId
        progressSubscription = subscribeComfyProgress(
          baseUrl,
          clientId,
          promptIdRef,
          task.input.lineId,
          progressState,
        )
        await progressSubscription.ready
        promptIdRef.current = promptId
        line.sceneStatus = 'generating'
        line.error = undefined
        await this.saveAndNotify()
        logGeneration('ComfyUI', 'resuming workflow', {
          lineId: task.input.lineId,
          promptId,
        })
      }

      if (!promptId) throw new ComfyUiError('ComfyUI did not return a prompt ID.')
      const output = await waitForOutput(
        baseUrl,
        promptId,
        saveNode,
        controller.signal,
        progressState,
      )
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('ComfyUI image generation was cancelled.')
      }
      const image = await downloadView(baseUrl, output)
      if (cancellationVersion !== this.cancellationVersion) {
        throw new Error('ComfyUI image generation was cancelled.')
      }
      const imageFileExtension = imageExtension(image.mime)
      const currentLine = this.projectStore.findLine(line.id, sequence)
      if (
        !currentLine ||
        (task.input.promptFingerprint &&
          scenePromptFingerprint(currentLine.scenePrompt) !== task.input.promptFingerprint)
      ) {
        logGeneration('ComfyUI', 'discarded stale image result', {
          lineId: task.input.lineId,
          promptId,
        })
        return
      }
      if (currentLine) currentLine.comfyPromptId = undefined
      const prepared = await ensureImageExportResolution(
        image.data,
        task.input.aspectRatio,
        imageFileExtension,
      )
      const savedState = await this.projectStore.saveImage(
        line.id,
        prepared.data,
        imageFileExtension,
        sequence,
      )
      logGeneration('ComfyUI', 'image saved locally', {
        lineId: task.input.lineId,
        promptId,
        bytes: prepared.data.byteLength,
        upscaled: prepared.upscaled,
        imagePath: this.projectStore.findLine(line.id, sequence)?.imagePath,
      })
      this.notify(savedState)
    } finally {
      progressSubscription?.close()
      this.activeControllers.delete(task.input.lineId)
      releaseSlot()
    }
  }

  private async resolveDiffusionModel(baseUrl: string, requested: string): Promise<string> {
    const models = await this.listDiffusionModels(baseUrl)
    if (models.length === 0) return requested || DEFAULT_COMFY_UI_SETTINGS.diffusionModel
    const resolved = resolveAvailableModel(requested, models)
    if (resolved) return resolved
    throw new ComfyUiError(
      `Diffusion model "${requested}" was not found in ComfyUI. Available: ${models
        .slice(0, 12)
        .join(', ')}${models.length > 12 ? '…' : ''}`,
      400,
    )
  }

  private async listDiffusionModels(baseUrl: string): Promise<string[]> {
    const cached = this.modelCache
    if (cached && cached.baseUrl === baseUrl && Date.now() - cached.loadedAt < 30_000) {
      return cached.models
    }
    const response = await comfyFetch(`${baseUrl}/object_info/UNETLoader`, {
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) {
      throw new ComfyUiError(`Could not list ComfyUI diffusion models (HTTP ${response.status}).`)
    }
    const data = (await response.json()) as {
      UNETLoader?: { input?: { required?: { unet_name?: unknown } } }
    }
    const names = (data.UNETLoader?.input?.required?.unet_name as unknown[])?.[0]
    const models = Array.isArray(names)
      ? names
          .filter((name): name is string => typeof name === 'string' && name.length > 0)
          .filter((name) => !/^put_/i.test(name))
          .filter((name) => !/melband|roformer/i.test(name))
      : []
    this.modelCache = { baseUrl, models, loadedAt: Date.now() }
    return models
  }

  private async markSceneQueued(input: GenerateSceneInput): Promise<ProjectState> {
    const line = this.projectStore.findLine(input.lineId, input.sequence)
    if (!line) throw new Error('The selected scene no longer exists.')
    line.scenePrompt = input.prompt
    line.sceneStatus = 'queued'
    line.imageGenerator = 'comfyui'
    line.comfyPromptId = undefined
    line.higgsRequestId = undefined
    line.higgsStatus = undefined
    line.error = undefined
    return this.saveAndNotify()
  }

  private async markSceneFailed(
    input: GenerateSceneInput,
    projectId: string,
    error: unknown,
  ): Promise<void> {
    const current = this.projectStore.get()
    if (!current || current.manifest.id !== projectId) return
    const line = this.projectStore.findLine(input.lineId, input.sequence)
    if (!line) return
    line.sceneStatus = 'failed'
    line.comfyPromptId = undefined
    line.error = error instanceof Error ? error.message : 'ComfyUI image generation failed.'
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
    return new Promise((resolve) => this.slotWaiters.push(resolve))
  }

  private releaseGenerationSlot(): void {
    const waiter = this.slotWaiters.shift()
    if (waiter) {
      waiter(() => this.releaseGenerationSlot())
      return
    }
    this.availableGenerationSlots += 1
  }

  private async cancelRemoteJobs(promptIds: string[], interruptActive: boolean): Promise<void> {
    const baseUrl = normalizeComfyUrl(normalizeComfyUiSettings(this.settings.get().comfy).baseUrl)
    const requests: Promise<unknown>[] = promptIds.map((promptId) =>
      comfyFetch(`${baseUrl}/queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [promptId] }),
      }).catch((error) => logGenerationError('ComfyUI', 'remote queue delete failed', error)),
    )
    if (interruptActive) {
      requests.push(
        comfyFetch(`${baseUrl}/interrupt`, { method: 'POST' }).catch((error) =>
          logGenerationError('ComfyUI', 'remote interrupt failed', error),
        ),
      )
    }
    await Promise.all(requests)
  }
}

function normalizeComfyUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    throw new ComfyUiError('ComfyUI URL is invalid. Example: http://127.0.0.1:8188', 400)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ComfyUiError('ComfyUI URL must use http:// or https://', 400)
  }
  return `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '')}`
}

async function comfyFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    if (error instanceof Error) {
      throw new ComfyUiError(
        `Could not reach ComfyUI at ${new URL(url).origin}. Start ComfyUI and check its URL.`,
        502,
      )
    }
    throw error
  }
}

async function interruptComfy(baseUrl: string): Promise<void> {
  const response = await comfyFetch(`${baseUrl}/interrupt`, { method: 'POST' })
  if (!response.ok) {
    throw new ComfyUiError(`ComfyUI interrupt failed (HTTP ${response.status}).`, 502)
  }
}

function resolutionForAspect(aspect: AspectRatio): { width: number; height: number } {
  return aspect === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
}

function applyOutputUpscale(
  workflow: Workflow,
  nodeId: string,
  sourceNodeId: string,
  saveNodeId: string,
  aspect: AspectRatio,
): void {
  const { width, height } = exportCanvasForAspect(aspect)
  workflow[nodeId] = {
    class_type: 'ImageScale',
    inputs: {
      image: [sourceNodeId, 0],
      upscale_method: 'lanczos',
      width,
      height,
      crop: 'center',
    },
    _meta: { title: 'Higgsfilm 4K output' },
  }
  workflow[saveNodeId].inputs.images = [nodeId, 0]
}

function companionsForDiffusion(unetName: string): {
  clipName: string
  clipType: string
  vaeName: string
} {
  const lower = unetName.toLowerCase()
  if (lower.includes('qwen_image') || lower.includes('qwen-image')) {
    return {
      clipName: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
      clipType: 'qwen_image',
      vaeName: 'qwen_image_vae.safetensors',
    }
  }
  if (lower.includes('klein')) {
    return {
      clipName: 'qwen_3_8b_fp8mixed_abliterated.safetensors',
      clipType: 'flux2',
      vaeName: 'flux2-vae.safetensors',
    }
  }
  return {
    clipName: 'mistral_3_small_flux2_fp8.safetensors',
    clipType: 'flux2',
    vaeName: 'flux2-vae.safetensors',
  }
}

function applySharedModelInputs(
  workflow: Workflow,
  prompt: string,
  settings: ComfyUiSettings,
  diffusionModel: string,
): void {
  const companions = companionsForDiffusion(diffusionModel)
  workflow[UNET_NODE].inputs.unet_name = diffusionModel
  workflow[UNET_NODE].inputs.weight_dtype = settings.weightDtype
  workflow[CLIP_NODE].inputs.clip_name = companions.clipName
  workflow[CLIP_NODE].inputs.type = companions.clipType
  workflow[CLIP_NODE].inputs.device = settings.clipDevice === 'gpu' ? 'default' : 'cpu'
  workflow[VAE_NODE].inputs.vae_name = companions.vaeName
  workflow[PROMPT_NODE].inputs.text = prompt
  workflow[GUIDANCE_NODE].inputs.guidance = settings.guidance
}

function buildZImageWorkflow(
  prompt: string,
  aspect: AspectRatio,
  settings: ComfyUiSettings,
  diffusionModel: string,
): Workflow {
  const workflow = structuredClone(zImageWorkflowTemplate) as Workflow
  const { width, height } = zImageResolutionForAspect(aspect)
  workflow['1'].inputs.unet_name = diffusionModel
  workflow['1'].inputs.weight_dtype = settings.weightDtype
  workflow['2'].inputs.device = settings.clipDevice === 'gpu' ? 'default' : 'cpu'
  workflow['4'].inputs.text = prompt
  workflow['6'].inputs.width = width
  workflow['6'].inputs.height = height
  workflow['8'].inputs.seed =
    settings.seedMode === 'fixed' ? settings.seed : Math.floor(Math.random() * 2 ** 32)
  workflow['8'].inputs.steps = settings.steps
  workflow['8'].inputs.cfg = 1
  workflow['8'].inputs.sampler_name = 'res_multistep'
  workflow['8'].inputs.scheduler = 'simple'
  applyOutputUpscale(workflow, Z_IMAGE_UPSCALE_NODE, '9', Z_IMAGE_SAVE_NODE, aspect)
  return workflow
}

function zImageResolutionForAspect(aspect: AspectRatio): { width: number; height: number } {
  return aspect === '9:16' ? { width: 648, height: 1152 } : { width: 1152, height: 648 }
}

function buildStyleWorkflow(
  prompt: string,
  aspect: AspectRatio,
  settings: ComfyUiSettings,
  diffusionModel: string,
): Workflow {
  const workflow = structuredClone(styleWorkflowTemplate) as Workflow
  const { width, height } = resolutionForAspect(aspect)
  applySharedModelInputs(workflow, prompt, settings, diffusionModel)
  workflow[STYLE_EMPTY_LATENT].inputs.width = width
  workflow[STYLE_EMPTY_LATENT].inputs.height = height
  workflow[STYLE_EMPTY_LATENT].inputs.batch_size = 1
  workflow[STYLE_SCHEDULER].inputs.steps = settings.steps
  workflow[STYLE_SCHEDULER].inputs.width = width
  workflow[STYLE_SCHEDULER].inputs.height = height
  workflow[STYLE_NOISE].inputs.noise_seed =
    settings.seedMode === 'fixed' ? settings.seed : Math.floor(Math.random() * 2 ** 32)
  workflow[STYLE_SAMPLER].inputs.sampler_name = settings.sampler
  applyOutputUpscale(workflow, STYLE_UPSCALE_NODE, '12', STYLE_SAVE_NODE, aspect)
  return workflow
}

function buildPreviousReferenceWorkflow(
  prompt: string,
  aspect: AspectRatio,
  settings: ComfyUiSettings,
  diffusionModel: string,
  uploadedName: string,
): Workflow {
  const workflow = structuredClone(previousReferenceWorkflowTemplate) as Workflow
  const { width, height } = resolutionForAspect(aspect)
  applySharedModelInputs(workflow, prompt, settings, diffusionModel)
  workflow[REFERENCE_LOAD].inputs.image = uploadedName
  workflow[REFERENCE_SCALE].inputs.width = width
  workflow[REFERENCE_SCALE].inputs.height = height
  workflow[REFERENCE_BLEND].inputs.blend_factor = Math.min(
    1,
    Math.max(REFERENCE_STRENGTH_ON, settings.referenceStrength),
  )
  workflow[REFERENCE_EMPTY_LATENT].inputs.width = width
  workflow[REFERENCE_EMPTY_LATENT].inputs.height = height
  workflow[REFERENCE_EMPTY_LATENT].inputs.batch_size = 1
  workflow[REFERENCE_SCHEDULER].inputs.steps = settings.steps
  workflow[REFERENCE_SCHEDULER].inputs.width = width
  workflow[REFERENCE_SCHEDULER].inputs.height = height
  workflow[REFERENCE_NOISE].inputs.noise_seed =
    settings.seedMode === 'fixed' ? settings.seed : Math.floor(Math.random() * 2 ** 32)
  workflow[REFERENCE_SAMPLER].inputs.sampler_name = settings.sampler
  applyOutputUpscale(workflow, PREVIOUS_REFERENCE_UPSCALE_NODE, '18', PREVIOUS_REFERENCE_SAVE_NODE, aspect)
  return workflow
}

function shouldUsePreviousReference(settings: ComfyUiSettings): boolean {
  return settings.referenceMode === 'previous' && settings.referenceStrength >= REFERENCE_STRENGTH_ON
}

function resolveAvailableModel(requested: string, models: string[]): string | null {
  if (models.length === 0) return requested
  if (models.includes(requested)) return requested
  const requestedStem = requested.replace(/\.safetensors$/i, '').toLowerCase()
  const requestedWithoutFp8 = requestedStem.replace(/-fp8(?:mixed)?$/i, '')
  const normalized = models.map((model) => ({
    raw: model,
    key: model.replace(/\.safetensors$/i, '').toLowerCase(),
  }))
  return (
    normalized.find((model) => model.key === requestedStem)?.raw ||
    normalized.find(
      (model) =>
        model.key === `${requestedWithoutFp8}-fp8` ||
        model.key === `${requestedWithoutFp8}-fp8mixed`,
    )?.raw ||
    normalized.find(
      (model) => model.key.replace(/-fp8(?:mixed)?$/i, '') === requestedWithoutFp8,
    )?.raw ||
    (requestedWithoutFp8.includes('klein')
      ? normalized.find((model) => model.key.includes('klein'))?.raw
      : null)
  ) ?? null
}

async function uploadImage(baseUrl: string, dataUrl: string): Promise<string> {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl.trim())
  if (!match) throw new ComfyUiError('Previous scene image must be a data URL.', 400)
  const mime = match[1] || 'image/png'
  const extension = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png'
  const fileName = `higgsfilm_prev_${randomUUID().slice(0, 8)}.${extension}`
  const form = new FormData()
  form.append(
    'image',
    new Blob([new Uint8Array(Buffer.from(match[2], 'base64'))], { type: mime }),
    fileName,
  )
  form.append('overwrite', 'true')
  const response = await comfyFetch(`${baseUrl}/upload/image`, {
    method: 'POST',
    body: form,
  })
  const text = await response.text()
  if (!response.ok) {
    throw new ComfyUiError(
      `ComfyUI image upload failed (HTTP ${response.status}): ${text.slice(0, 300)}`,
      response.status,
    )
  }
  try {
    const data = JSON.parse(text) as { name?: string }
    return data.name || fileName
  } catch {
    return fileName
  }
}

async function queuePrompt(baseUrl: string, workflow: Workflow, clientId: string): Promise<string> {
  const response = await comfyFetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId }),
  })
  const text = await response.text()
  let data: { prompt_id?: string; error?: unknown; node_errors?: unknown } = {}
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    // The response is reported below with its raw text.
  }
  if (!response.ok || (data.node_errors && Object.keys(data.node_errors).length > 0)) {
    throw new ComfyUiError(
      `ComfyUI workflow rejected: ${formatComfyError(data.error, data.node_errors, text)}`,
      response.status >= 400 ? response.status : 400,
    )
  }
  if (!data.prompt_id) throw new ComfyUiError('ComfyUI did not return a prompt ID.', 502)
  return data.prompt_id
}

async function waitForOutput(
  baseUrl: string,
  promptId: string,
  preferredSaveNode: string,
  signal: AbortSignal,
  progressState: ComfyProgressState,
): Promise<HistoryImage> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (signal.aborted) throw new ComfyUiError('ComfyUI image generation was cancelled.', 499)
    const response = await comfyFetch(`${baseUrl}/history/${promptId}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    })
    if (!response.ok) {
      throw new ComfyUiError(`ComfyUI history failed (HTTP ${response.status}).`, 502)
    }
    const history = (await response.json()) as Record<string, HistoryEntry>
    const entry = history[promptId]
    if (entry) {
      progressState.lastActivityAt = Date.now()
      const status = entry.status?.status_str?.toLowerCase()
      if (status === 'error' || hasInterruptedMessage(entry.status?.messages)) {
        throw new ComfyUiError('ComfyUI reported an execution error.', 502)
      }
      const images =
        entry.outputs?.[preferredSaveNode]?.images ??
        Object.values(entry.outputs ?? {}).flatMap((output) => output.images ?? [])
      if (images.length > 0) return images[0]
      if (entry.status?.completed && status === 'success') {
        throw new ComfyUiError('ComfyUI finished but returned no image.', 502)
      }
    }
    const inQueue = await isPromptInQueue(baseUrl, promptId)
    if (inQueue === true && !progressState.executionStarted) {
      progressState.lastActivityAt = Date.now()
    }
    if (Date.now() - startedAt > 5000 && inQueue === false && !entry) {
      throw new ComfyUiError(
        'ComfyUI job left the queue without an image. Check the ComfyUI console for details.',
        502,
      )
    }
    const stallLimit = progressState.samplingStarted ? SAMPLING_STALL_MS : LOADING_STALL_MS
    if (Date.now() - progressState.lastActivityAt > stallLimit) {
      await interruptComfy(baseUrl).catch(() => undefined)
      throw new ComfyUiError(
        progressState.samplingStarted
          ? `ComfyUI stalled during sampling for over ${Math.round(SAMPLING_STALL_MS / 60_000)} minutes.`
          : `ComfyUI stalled while loading the model for over ${Math.round(LOADING_STALL_MS / 60_000)} minutes.`,
        504,
      )
    }
    await delay(POLL_MS, signal)
  }
  throw new ComfyUiError(
    'ComfyUI timed out waiting for the image after nine minutes. Check the ComfyUI console.',
    504,
  )
}

async function isPromptInQueue(baseUrl: string, promptId: string): Promise<boolean | null> {
  try {
    const response = await comfyFetch(`${baseUrl}/queue`, {
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) return null
    const data = (await response.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] }
    return [...(data.queue_running ?? []), ...(data.queue_pending ?? [])].some(
      (row) => Array.isArray(row) && row[1] === promptId,
    )
  } catch {
    return null
  }
}

async function downloadView(
  baseUrl: string,
  image: HistoryImage,
): Promise<{ data: Buffer; mime: string }> {
  const query = new URLSearchParams({
    filename: image.filename,
    subfolder: image.subfolder ?? '',
    type: image.type ?? 'output',
  })
  const response = await comfyFetch(`${baseUrl}/view?${query.toString()}`)
  if (!response.ok) throw new ComfyUiError(`ComfyUI image download failed (HTTP ${response.status}).`, 502)
  return {
    data: Buffer.from(await response.arrayBuffer()),
    mime: response.headers.get('content-type') || 'image/png',
  }
}

function imageExtension(mime: string): string {
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  return 'png'
}

function inputForLine(line: ScriptLine, sequence: SequenceId = 'main'): GenerateSceneInput {
  return {
    lineId: line.id,
    sequence,
    prompt: line.scenePrompt,
    modelEndpoint: 'comfyui-local',
    aspectRatio: sequence === 'trailer' ? '9:16' : '16:9',
    resolution: '1k',
  }
}

function allSequenceLines(projectStore: ProjectStore): Array<{ line: ScriptLine; sequence: SequenceId }> {
  return (['main', 'trailer'] as SequenceId[]).flatMap((sequence) =>
    projectStore.getSequenceManifest(sequence).lines.map((line) => ({ line, sequence })),
  )
}

function hasInterruptedMessage(messages: unknown[] | undefined): boolean {
  return (messages ?? []).some((message) => {
    if (Array.isArray(message)) return message[0] === 'execution_interrupted'
    if (!message || typeof message !== 'object') return false
    return (
      'type' in message &&
      (message as { type?: unknown }).type === 'execution_interrupted'
    )
  })
}

function formatComfyError(error: unknown, nodeErrors: unknown, rawText: string): string {
  const parts: string[] = []
  if (typeof error === 'string' && error.trim()) parts.push(error.trim())
  else if (error && typeof error === 'object') parts.push(JSON.stringify(error).slice(0, 400))
  if (nodeErrors && typeof nodeErrors === 'object') {
    parts.push(JSON.stringify(nodeErrors).slice(0, 500))
  }
  return parts.join(' — ') || rawText.slice(0, 500) || 'Unknown ComfyUI error'
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ComfyUiError('ComfyUI image generation was cancelled.', 499))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function subscribeComfyProgress(
  baseUrl: string,
  clientId: string,
  promptIdRef: { current: string | null },
  lineId: string,
  progressState: ComfyProgressState,
): { ready: Promise<void>; close: () => void } {
  const WebSocketConstructor = (globalThis as typeof globalThis & {
    WebSocket?: typeof WebSocket
  }).WebSocket
  if (!WebSocketConstructor) return { ready: Promise.resolve(), close: () => undefined }

  const url = new URL(baseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocketConstructor(
    `${url.origin}${url.pathname === '/' ? '' : url.pathname}/ws?clientId=${encodeURIComponent(clientId)}`,
  )
  const ready = new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    socket.addEventListener('open', finish)
    socket.addEventListener('error', finish)
    setTimeout(finish, 2500)
  })
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    let message: { type?: string; data?: Record<string, unknown> }
    try {
      message = JSON.parse(event.data) as typeof message
    } catch {
      return
    }
    const data = message.data
    if (!data) return
    const promptId = promptIdRef.current
    if (promptId && typeof data.prompt_id === 'string' && data.prompt_id !== promptId) return
    if (message.type === 'progress') {
      const value = Number(data.value)
      const max = Number(data.max)
      progressState.lastActivityAt = Date.now()
      if (Number.isFinite(max) && max > 1 && Number.isFinite(value) && value > 0) {
        progressState.samplingStarted = true
      }
      logGeneration('ComfyUI', 'sampling progress', {
        lineId,
        step: data.value,
        max: data.max,
        node: data.node,
      })
    } else if (message.type === 'execution_start') {
      progressState.executionStarted = true
      progressState.lastActivityAt = Date.now()
      logGeneration('ComfyUI', 'execution started', { lineId })
    } else if (message.type === 'executing') {
      progressState.executionStarted = true
      progressState.lastActivityAt = Date.now()
      if (data.node == null) {
        logGeneration('ComfyUI', 'execution finishing', { lineId })
      }
    }
  })
  return {
    ready,
    close: () => {
      try {
        socket.close()
      } catch {
        // The socket may already be closed during cancellation.
      }
    },
  }
}
