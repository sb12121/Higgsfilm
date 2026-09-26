import type { GenerateSceneInput, ProjectState, ScriptLine, SequenceId } from '../../shared/types'
import { composeGenerationPrompt, scriptSummaryForSequence } from '../../shared/promptComposer'
import { sceneContextFingerprint, scenePromptFingerprint } from '../../shared/sceneContext'
import { CodexClient } from './codexClient'
import { logGeneration, logGenerationError } from './generationLogger'
import { ProjectStore } from './projectStore'

interface QueueTask {
  input: GenerateSceneInput
  projectId: string
}

type UpdateListener = (state: ProjectState) => void

export class CodexImageClient {
  private readonly queue: QueueTask[] = []
  private readonly queuedLineIds = new Set<string>()
  private readonly listeners = new Set<UpdateListener>()
  private activeQueueTasks = 0
  private providerPaused = false
  private cancellationVersion = 0

  constructor(
    private readonly projectStore: ProjectStore,
    private readonly codex: CodexClient,
  ) {}

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async generateScene(input: GenerateSceneInput): Promise<ProjectState> {
    if (this.providerPaused) {
      logGeneration('ChatGPT', 'direct generation rejected because queue is paused', { lineId: input.lineId })
      throw new Error('ChatGPT image generation is paused. Resume image generation first.')
    }
    logGeneration('ChatGPT', 'direct generation started', { lineId: input.lineId })
    const projectId = this.projectStore.getManifest().id
    await this.markSceneQueued(input)
    try {
      await this.processScene({ input, projectId })
      return this.projectStore.get()!
    } catch (error) {
      logGenerationError('ChatGPT', 'direct generation failed', error, { lineId: input.lineId })
      await this.markSceneFailed(input, projectId, error)
      throw error
    }
  }

  async queueScene(input: GenerateSceneInput): Promise<ProjectState> {
    if (this.providerPaused) {
      logGeneration('ChatGPT', 'queue request rejected because queue is paused', { lineId: input.lineId })
      throw new Error('ChatGPT image generation is paused. Resume image generation first.')
    }
    const manifest = this.projectStore.getManifest()
    const sequence = input.sequence || 'main'
    logGeneration('ChatGPT', 'queue request accepted', {
      lineId: input.lineId,
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
    if (!this.projectStore.findLine(input.lineId, sequence)) {
      throw new Error('The selected scene no longer exists.')
    }
    if (this.queuedLineIds.has(input.lineId)) return this.projectStore.get()!

    const queuedInput = { ...input, sequence }
    const state = await this.markSceneQueued(queuedInput)
    this.queuedLineIds.add(input.lineId)
    this.queue.push({ input: queuedInput, projectId: manifest.id })
    logGeneration('ChatGPT', 'scene added to queue', {
      lineId: input.lineId,
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
    void this.processQueue()
    return this.projectStore.get() || state
  }

  async resumeQueuedScenes(): Promise<void> {
    this.providerPaused = false
    const state = this.projectStore.get()
    if (!state) {
      logGeneration('ChatGPT', 'resume found no open project')
      return
    }

    for (const sequence of ['main', 'trailer'] as SequenceId[]) {
      for (const line of this.projectStore.getSequenceManifest(sequence).lines) {
        if (line.imageGenerator !== 'chatgpt') continue
        if (line.sceneStatus !== 'queued' && line.sceneStatus !== 'generating') continue
        if (this.queuedLineIds.has(line.id)) continue
        this.queuedLineIds.add(line.id)
        this.queue.push({
          input: inputForLine(line, sequence),
          projectId: state.manifest.id,
        })
      }
    }
    logGeneration('ChatGPT', 'resume scan complete', {
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
    void this.processQueue()
  }

  async cancelQueuedScenes(): Promise<void> {
    this.cancellationVersion += 1
    this.providerPaused = true
    const pendingTasks = this.queue.splice(0)
    logGeneration('ChatGPT', 'cancel started', {
      pending: pendingTasks.length,
      active: this.activeQueueTasks,
    })
    pendingTasks.forEach((task) => this.queuedLineIds.delete(task.input.lineId))
    await this.codex.cancelImageGeneration()
    await Promise.all(
      pendingTasks.map((task) =>
        this.markSceneFailed(
          task.input,
          task.projectId,
          new Error('ChatGPT image generation was cancelled.'),
        ),
      ),
    )

    if (!this.projectStore.get()) {
      logGeneration('ChatGPT', 'cancel complete with no open project')
      return
    }
    const activeLines = allSequenceLines(this.projectStore).filter(
      ({ line }) =>
        line.imageGenerator === 'chatgpt' &&
        (line.sceneStatus === 'queued' || line.sceneStatus === 'generating'),
    )
    if (activeLines.length === 0) {
      logGeneration('ChatGPT', 'cancel complete with no queued scenes')
      return
    }
    for (const { line } of activeLines) {
      line.sceneStatus = 'failed'
      line.error = 'ChatGPT image generation was cancelled.'
    }
    await this.saveAndNotify()
    logGeneration('ChatGPT', 'cancel marked scenes', { count: activeLines.length })
  }

  resumeGenerationQueue(): void {
    this.providerPaused = false
    logGeneration('ChatGPT', 'queue unpaused', {
      queued: this.queue.length,
      active: this.activeQueueTasks,
    })
  }

  async pauseQueuedScenes(): Promise<void> {
    this.providerPaused = true
    const pendingTasks = this.queue.splice(0)
    logGeneration('ChatGPT', 'queue paused', { pending: pendingTasks.length })
    pendingTasks.forEach((task) => this.queuedLineIds.delete(task.input.lineId))
    await Promise.all(
      pendingTasks.map((task) =>
        this.markSceneFailed(
          task.input,
          task.projectId,
          new Error('ChatGPT image generation was paused because another image provider is selected.'),
        ),
      ),
    )
  }

  private processQueue(): void {
    if (this.providerPaused) {
      logGeneration('ChatGPT', 'dispatcher blocked because queue is paused', {
        queued: this.queue.length,
        active: this.activeQueueTasks,
      })
      return
    }
    while (this.activeQueueTasks < 1 && this.queue.length > 0) {
      const task = this.queue.shift()!
      this.activeQueueTasks += 1
      logGeneration('ChatGPT', 'worker started', {
        lineId: task.input.lineId,
        queued: this.queue.length,
        active: this.activeQueueTasks,
      })
      void this.processQueuedTask(task).finally(() => {
        this.activeQueueTasks -= 1
        logGeneration('ChatGPT', 'worker released', {
          lineId: task.input.lineId,
          queued: this.queue.length,
          active: this.activeQueueTasks,
        })
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
      logGeneration('ChatGPT', 'scene completed', { lineId: task.input.lineId })
    } catch (error) {
      logGenerationError('ChatGPT', 'scene worker failed', error, { lineId: task.input.lineId })
      await this.markSceneFailed(task.input, task.projectId, error)
    } finally {
      this.queuedLineIds.delete(task.input.lineId)
    }
  }

  private async processScene(task: QueueTask, cancellationVersion = this.cancellationVersion): Promise<void> {
    const state = this.projectStore.get()
    if (!state || state.manifest.id !== task.projectId) {
      throw new Error('The queued scene belongs to a different project.')
    }

    const line = this.projectStore.findLine(task.input.lineId, task.input.sequence)
    if (!line) throw new Error('The selected scene no longer exists.')
    const sequence = task.input.sequence || 'main'
    const canonicalRecord =
      line.sceneRecord?.sourceFingerprint === sceneContextFingerprint(state.manifest, sequence)
        ? line.sceneRecord
        : undefined

    line.sceneStatus = 'generating'
    line.error = undefined
    await this.saveAndNotify()
    logGeneration('ChatGPT', 'scene marked generating', { lineId: task.input.lineId })

    if (cancellationVersion !== this.cancellationVersion) {
      throw new Error('ChatGPT image generation was cancelled.')
    }
    logGeneration('ChatGPT', 'calling Codex image generation', {
      lineId: task.input.lineId,
      aspectRatio: task.input.aspectRatio,
    })
    const generationPrompt = composeGenerationPrompt(
      task.input.prompt,
      state.manifest.visualBible,
      task.input.aspectRatio,
      scriptSummaryForSequence(state.manifest, sequence),
      canonicalRecord,
    )
    const image = await this.codex.generateImage({
      prompt: generationPrompt,
      aspectRatio: task.input.aspectRatio,
    })
    if (cancellationVersion !== this.cancellationVersion) {
      throw new Error('ChatGPT image generation was cancelled.')
    }
    const currentLine = this.projectStore.findLine(line.id, task.input.sequence)
    if (
      !currentLine ||
      (task.input.promptFingerprint &&
        scenePromptFingerprint(currentLine.scenePrompt) !== task.input.promptFingerprint)
    ) {
      logGeneration('ChatGPT', 'discarded stale image result', { lineId: task.input.lineId })
      return
    }
    const savedState = await this.projectStore.saveImage(
      line.id,
      image.data,
      image.extension,
      task.input.sequence,
    )
    logGeneration('ChatGPT', 'image saved locally', {
      lineId: task.input.lineId,
      bytes: image.data.byteLength,
      extension: image.extension,
    })
    this.notify(savedState)
  }

  private async markSceneQueued(input: GenerateSceneInput): Promise<ProjectState> {
    const line = this.projectStore.findLine(input.lineId, input.sequence)
    if (!line) throw new Error('The selected scene no longer exists.')

    line.scenePrompt = input.prompt
    line.sceneStatus = 'queued'
    line.imageGenerator = 'chatgpt'
    line.higgsStatus = undefined
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
    line.error = error instanceof Error ? error.message : 'ChatGPT image generation failed.'
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
}

function inputForLine(line: ScriptLine, sequence: SequenceId = 'main'): GenerateSceneInput {
  return {
    lineId: line.id,
    sequence,
    prompt: line.scenePrompt,
    modelEndpoint: 'chatgpt-image-generation',
    aspectRatio: sequence === 'trailer' ? '9:16' : '16:9',
    resolution: '1k',
  }
}

function allSequenceLines(projectStore: ProjectStore): Array<{ line: ScriptLine; sequence: SequenceId }> {
  return (['main', 'trailer'] as SequenceId[]).flatMap((sequence) =>
    projectStore.getSequenceManifest(sequence).lines.map((line) => ({ line, sequence })),
  )
}
