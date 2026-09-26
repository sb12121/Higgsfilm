import type {
  GenerateSceneInput,
  ImageGenerator,
  ProjectState,
  StudioSettings,
} from '../../shared/types'
import { AppSettingsStore } from './appSettingsStore'
import { CodexImageClient } from './codexImageClient'
import { ComfyUiClient } from './comfyUiClient'
import { logGeneration } from './generationLogger'
import { HiggsfieldClient } from './higgsfieldClient'

type UpdateListener = (state: ProjectState) => void
type ImageGenerationProvider = Pick<
  HiggsfieldClient,
  | 'generateScene'
  | 'queueScene'
  | 'resumeQueuedScenes'
  | 'pauseQueuedScenes'
  | 'cancelQueuedScenes'
  | 'resumeGenerationQueue'
> & {
  onUpdate: (listener: UpdateListener) => () => void
}

export class ImageGenerationRouter {
  private readonly listeners = new Set<UpdateListener>()

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly higgsfield: HiggsfieldClient,
    private readonly chatgpt: CodexImageClient,
    private readonly comfyui: ComfyUiClient,
  ) {
    this.higgsfield.onUpdate((state) => this.notify(state))
    this.chatgpt.onUpdate((state) => this.notify(state))
    this.comfyui.onUpdate((state) => this.notify(state))
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async generateScene(input: GenerateSceneInput): Promise<ProjectState> {
    const provider = this.settings.get().imageGenerator
    logGeneration(provider, 'generate request routed', { lineId: input.lineId })
    return this.provider().generateScene(input)
  }

  async queueScene(input: GenerateSceneInput): Promise<ProjectState> {
    const provider = this.settings.get().imageGenerator
    logGeneration(provider, 'queue request routed', { lineId: input.lineId })
    return this.provider().queueScene(input)
  }

  async cancelGenerations(): Promise<void> {
    logGeneration(this.settings.get().imageGenerator, 'cancel requested')
    await Promise.all([
      this.higgsfield.cancelQueuedScenes(),
      this.chatgpt.cancelQueuedScenes(),
      this.comfyui.cancelQueuedScenes(),
    ])
    logGeneration(this.settings.get().imageGenerator, 'cancel complete')
  }

  async resumeGenerations(): Promise<void> {
    const provider = this.settings.get().imageGenerator
    logGeneration(provider, 'resume requested')
    this.provider().resumeGenerationQueue()
    logGeneration(provider, 'resume complete')
  }

  async saveSettings(nextSettings: StudioSettings): Promise<StudioSettings> {
    const previousProvider = this.settings.get().imageGenerator
    const savedSettings = await this.settings.save(nextSettings)
    logGeneration(savedSettings.imageGenerator, 'settings saved', { previousProvider })
    if (previousProvider === savedSettings.imageGenerator) return savedSettings

    const providers: Record<ImageGenerator, ImageGenerationProvider> = {
      higgsfield: this.higgsfield,
      chatgpt: this.chatgpt,
      comfyui: this.comfyui,
    }
    await Promise.all(
      (Object.entries(providers) as [ImageGenerator, ImageGenerationProvider][])
        .filter(([provider]) => provider !== savedSettings.imageGenerator)
        .map(([, provider]) => provider.pauseQueuedScenes()),
    )
    await providers[savedSettings.imageGenerator].resumeQueuedScenes()
    return savedSettings
  }

  async resumeQueuedScenes(): Promise<void> {
    const selectedProvider = this.settings.get().imageGenerator
    const providers: Record<ImageGenerator, ImageGenerationProvider> = {
      higgsfield: this.higgsfield,
      chatgpt: this.chatgpt,
      comfyui: this.comfyui,
    }
    await Promise.all(
      (Object.entries(providers) as [ImageGenerator, ImageGenerationProvider][])
        .filter(([provider]) => provider !== selectedProvider)
        .map(([, provider]) => provider.pauseQueuedScenes()),
    )
    await providers[selectedProvider].resumeQueuedScenes()
  }

  private provider(): ImageGenerationProvider {
    const selectedProvider: ImageGenerator = this.settings.get().imageGenerator
    if (selectedProvider === 'chatgpt') return this.chatgpt
    if (selectedProvider === 'comfyui') return this.comfyui
    return this.higgsfield
  }

  private notify(state: ProjectState): void {
    for (const listener of this.listeners) listener(state)
  }
}
