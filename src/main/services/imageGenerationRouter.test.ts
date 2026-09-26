import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMFY_UI_SETTINGS, defaultLlmStepSettings, type GenerateSceneInput, type ProjectState } from '../../shared/types'
import { ImageGenerationRouter } from './imageGenerationRouter'

const input: GenerateSceneInput = {
  lineId: 'line-1',
  prompt: 'A friendly golden retriever in a white room.',
  modelEndpoint: 'chatgpt-image-generation',
  aspectRatio: '16:9',
  resolution: '1k',
}

function fakeProvider() {
  return {
    onUpdate: vi.fn(() => () => undefined),
    generateScene: vi.fn(async () => ({} as ProjectState)),
    queueScene: vi.fn(async () => ({} as ProjectState)),
    resumeQueuedScenes: vi.fn(async () => undefined),
    pauseQueuedScenes: vi.fn(async () => undefined),
    cancelQueuedScenes: vi.fn(async () => undefined),
    resumeGenerationQueue: vi.fn(() => undefined),
  }
}

describe('ImageGenerationRouter', () => {
  it('routes new work to the explicitly selected provider', async () => {
    const higgsfield = fakeProvider()
    const chatgpt = fakeProvider()
    const comfyui = fakeProvider()
    const settings = {
      get: () => ({ imageGenerator: 'chatgpt' as const, comfy: DEFAULT_COMFY_UI_SETTINGS }),
    }
    const router = new ImageGenerationRouter(
      settings as never,
      higgsfield as never,
      chatgpt as never,
      comfyui as never,
    )

    await router.queueScene(input)

    expect(chatgpt.queueScene).toHaveBeenCalledWith(input)
    expect(higgsfield.queueScene).not.toHaveBeenCalled()
  })

  it('does not silently fall back when the selected provider fails', async () => {
    const higgsfield = fakeProvider()
    const chatgpt = fakeProvider()
    const comfyui = fakeProvider()
    chatgpt.queueScene.mockRejectedValueOnce(new Error('ChatGPT image generation unavailable.'))
    const settings = {
      get: () => ({ imageGenerator: 'chatgpt' as const, comfy: DEFAULT_COMFY_UI_SETTINGS }),
    }
    const router = new ImageGenerationRouter(
      settings as never,
      higgsfield as never,
      chatgpt as never,
      comfyui as never,
    )

    await expect(router.queueScene(input)).rejects.toThrow('ChatGPT image generation unavailable.')
    expect(higgsfield.queueScene).not.toHaveBeenCalled()
  })

  it('does not resume Higgsfield work while ChatGPT is selected', async () => {
    const higgsfield = fakeProvider()
    const chatgpt = fakeProvider()
    const comfyui = fakeProvider()
    const settings = {
      get: () => ({ imageGenerator: 'chatgpt' as const, comfy: DEFAULT_COMFY_UI_SETTINGS }),
    }
    const router = new ImageGenerationRouter(
      settings as never,
      higgsfield as never,
      chatgpt as never,
      comfyui as never,
    )

    await router.resumeQueuedScenes()

    expect(higgsfield.pauseQueuedScenes).toHaveBeenCalledOnce()
    expect(higgsfield.resumeQueuedScenes).not.toHaveBeenCalled()
    expect(chatgpt.resumeQueuedScenes).toHaveBeenCalledOnce()
  })

  it('routes new work to ComfyUI when selected', async () => {
    const higgsfield = fakeProvider()
    const chatgpt = fakeProvider()
    const comfyui = fakeProvider()
    const settings = {
      get: () => ({ imageGenerator: 'comfyui' as const, comfy: DEFAULT_COMFY_UI_SETTINGS }),
    }
    const router = new ImageGenerationRouter(
      settings as never,
      higgsfield as never,
      chatgpt as never,
      comfyui as never,
    )

    await router.queueScene(input)

    expect(comfyui.queueScene).toHaveBeenCalledWith(input)
    expect(higgsfield.queueScene).not.toHaveBeenCalled()
    expect(chatgpt.queueScene).not.toHaveBeenCalled()
  })

  it('pauses the previous provider when the global setting changes', async () => {
    const higgsfield = fakeProvider()
    const chatgpt = fakeProvider()
    const comfyui = fakeProvider()
    let selectedProvider: 'higgsfield' | 'chatgpt' | 'comfyui' = 'higgsfield'
    const settings = {
      get: () => ({ imageGenerator: selectedProvider, comfy: DEFAULT_COMFY_UI_SETTINGS }),
      save: vi.fn(async (next: {
        imageGenerator: 'higgsfield' | 'chatgpt' | 'comfyui'
        voiceMode: 'microphone' | 'qwen'
        llmReasoningEffort: 'low' | 'medium' | 'high' | 'max'
        llmServiceTier: 'standard' | 'fast'
        comfy: typeof DEFAULT_COMFY_UI_SETTINGS
      }) => {
        selectedProvider = next.imageGenerator
        return next
      }),
    }
    const router = new ImageGenerationRouter(
      settings as never,
      higgsfield as never,
      chatgpt as never,
      comfyui as never,
    )

    await router.saveSettings({
      imageGenerator: 'chatgpt',
      voiceMode: 'microphone',
      llmReasoningEffort: 'low',
      llmServiceTier: 'standard',
      llmSteps: defaultLlmStepSettings(),
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      customImageGuidePath: '',
      customImageCharacterSheetPath: '',
      customImageReferencePaths: [],
      expressionGuidePath: '',
      expressionBackgroundPath: '',
    })

    expect(settings.save).toHaveBeenCalledWith({
      imageGenerator: 'chatgpt',
      voiceMode: 'microphone',
      llmReasoningEffort: 'low',
      llmServiceTier: 'standard',
      llmSteps: defaultLlmStepSettings(),
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      customImageGuidePath: '',
      customImageCharacterSheetPath: '',
      customImageReferencePaths: [],
      expressionGuidePath: '',
      expressionBackgroundPath: '',
    })
    expect(higgsfield.pauseQueuedScenes).toHaveBeenCalledOnce()
    expect(comfyui.pauseQueuedScenes).toHaveBeenCalledOnce()
    expect(chatgpt.resumeQueuedScenes).toHaveBeenCalledOnce()
  })
})
