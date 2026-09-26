import { describe, expect, it } from 'vitest'
import {
  applyChannelProfileToSettings,
  channelProfileFromInput,
  channelProfileMatchesCurrent,
  normalizeChannelProfileState,
  normalizeYoutubeChannelHandle,
} from './channelProfiles'
import { DEFAULT_COMFY_UI_SETTINGS, defaultLlmStepSettings, type StudioSettings, type VisualBible } from './types'

const bible: VisualBible = {
  name: 'Doggo',
  style: 'Clean 2D cartoon.',
  characters: 'Golden retriever.',
  mainCharacter: 'Male golden retriever.',
  supportingCharacter: '',
  setting: 'Bright rooms.',
  palette: 'Warm flat colors.',
  camera: 'Readable medium shots.',
  negativePrompt: 'Photorealism.',
}

const settings: StudioSettings = {
  imageGenerator: 'higgsfield',
  voiceMode: 'microphone',
  llmReasoningEffort: 'low',
  llmServiceTier: 'standard',
  llmSteps: defaultLlmStepSettings(),
  comfy: {
    ...DEFAULT_COMFY_UI_SETTINGS,
    baseUrl: 'http://127.0.0.1:8188',
    diffusionModel: 'flux-2-klein-9b-fp8.safetensors',
  },
  customImageGuidePath: '',
  customImageCharacterSheetPath: '',
  customImageReferencePaths: [],
  expressionGuidePath: '',
  expressionBackgroundPath: '',
}

describe('channelProfiles', () => {
  it('applies generator and Comfy knobs while keeping the local server URL', () => {
    const profile = channelProfileFromInput({
      id: 'doggo',
      name: 'Doggo',
      visualBible: bible,
      imageGenerator: 'comfyui',
      comfy: {
        ...DEFAULT_COMFY_UI_SETTINGS,
        baseUrl: 'http://192.168.1.20:8188',
        diffusionModel: 'z_image_turbo_bf16.safetensors',
        steps: 8,
        guidance: 1,
      },
    })

    expect(profile.productionMode).toBe('generate')
    expect(profile.channelFolderPath).toBe('')
    expect(profile.stillLibraryPath).toBe('')
    expect(profile.scriptBiblePath).toBe('')
    expect(profile.ideaGuidePath).toBe('')
    expect(profile.niche).toBe('')
    expect(profile.youtubeHandle).toBe('')
    expect(profile.channelBrief).toBe('')
    expect(profile.channelBriefUpdatedAt).toBe('')

    const next = applyChannelProfileToSettings(settings, profile)
    expect(next.imageGenerator).toBe('comfyui')
    expect(next.comfy.baseUrl).toBe('http://127.0.0.1:8188')
    expect(next.comfy.diffusionModel).toBe('z_image_turbo_bf16.safetensors')
    expect(next.comfy.guidance).toBe(1)
    expect(next.voiceMode).toBe('microphone')
  })

  it('drops invalid stored profiles and unknown active ids', () => {
    const state = normalizeChannelProfileState(
      [
        { name: 'Missing id', visualBible: bible, imageGenerator: 'comfyui' },
        {
          id: 'doggo',
          name: 'Doggo',
          visualBible: bible,
          imageGenerator: 'comfyui',
          comfy: DEFAULT_COMFY_UI_SETTINGS,
        },
        {
          id: 'doggo',
          name: 'Duplicate id',
          visualBible: bible,
          imageGenerator: 'chatgpt',
          comfy: DEFAULT_COMFY_UI_SETTINGS,
        },
      ],
      'missing',
    )

    expect(state.profiles.map((profile) => profile.id)).toEqual(['doggo'])
    expect(state.activeProfileId).toBe('')
  })

  it('detects when the live studio setup still matches the profile', () => {
    const profile = channelProfileFromInput({
      id: 'doggo',
      name: 'Doggo',
      visualBible: bible,
      imageGenerator: 'comfyui',
      comfy: {
        ...DEFAULT_COMFY_UI_SETTINGS,
        diffusionModel: 'z_image_turbo_bf16.safetensors',
      },
    })
    const current: StudioSettings = {
      ...settings,
      imageGenerator: 'comfyui',
      comfy: {
        ...DEFAULT_COMFY_UI_SETTINGS,
        baseUrl: 'http://10.0.0.4:8188',
        diffusionModel: 'z_image_turbo_bf16.safetensors',
      },
    }

    expect(channelProfileMatchesCurrent(profile, current, bible)).toBe(true)
    expect(
      channelProfileMatchesCurrent(profile, { ...current, imageGenerator: 'chatgpt' }, bible),
    ).toBe(false)
  })

  it('stores expression-still production mode on the channel profile', () => {
    const profile = channelProfileFromInput({
      id: 'doggo-still',
      name: 'Doggo stills',
      visualBible: bible,
      imageGenerator: 'comfyui',
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      productionMode: 'still-cast',
      channelFolderPath: 'C:\\channels\\doggo',
      stillLibraryPath: 'C:\\channels\\doggo\\Expressions',
    })
    expect(profile.productionMode).toBe('still-cast')
    expect(profile.channelFolderPath).toBe('C:\\channels\\doggo')
    expect(profile.stillLibraryPath).toBe('C:\\channels\\doggo\\Expressions')
    expect(profile.scriptBiblePath).toBe('')
  })

  it('keeps a script bible path on the channel profile', () => {
    const profile = channelProfileFromInput({
      id: 'doggo-script',
      name: 'Doggo script',
      visualBible: bible,
      imageGenerator: 'comfyui',
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      scriptBiblePath: 'C:\\bibles\\doggo-script.txt',
    })
    expect(profile.scriptBiblePath).toBe('C:\\bibles\\doggo-script.txt')
  })

  it('keeps an idea guide path on the channel profile', () => {
    const profile = channelProfileFromInput({
      id: 'fit-guide',
      name: 'BuxFit',
      visualBible: bible,
      imageGenerator: 'comfyui',
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      ideaGuidePath: 'C:\\guides\\video-idea.md',
    })
    expect(profile.ideaGuidePath).toBe('C:\\guides\\video-idea.md')
  })

  it('stores niche, YouTube handle, and channel brief on the profile', () => {
    const profile = channelProfileFromInput({
      id: 'fit',
      name: 'BuxFit',
      visualBible: bible,
      imageGenerator: 'comfyui',
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      niche: 'Personal Fitness',
      youtubeHandle: 'https://www.youtube.com/@nischa/videos',
      channelBrief: 'Recent uploads…',
      channelBriefUpdatedAt: '2026-09-16T12:00:00.000Z',
    })
    expect(profile.niche).toBe('Personal Fitness')
    expect(profile.youtubeHandle).toBe('@nischa')
    expect(profile.channelBrief).toBe('Recent uploads…')
    expect(profile.channelBriefUpdatedAt).toBe('2026-09-16T12:00:00.000Z')
  })

  it('normalizes YouTube handles from names and URLs', () => {
    expect(normalizeYoutubeChannelHandle('Graham Stephan')).toBe('@GrahamStephan')
    expect(normalizeYoutubeChannelHandle('@nischa')).toBe('@nischa')
    expect(normalizeYoutubeChannelHandle('https://www.youtube.com/@nischa/videos')).toBe('@nischa')
    expect(normalizeYoutubeChannelHandle('')).toBe('')
  })
})
