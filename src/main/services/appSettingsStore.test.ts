import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_COMFY_UI_SETTINGS,
  DEFAULT_LLM_REASONING_EFFORT,
  DEFAULT_LLM_SERVICE_TIER,
  defaultLlmStepSettings,
} from '../../shared/types'
import { AppSettingsStore } from './appSettingsStore'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('AppSettingsStore', () => {
  it('defaults to Higgsfield and persists a selected provider', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-settings-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'settings.json')

    const store = new AppSettingsStore(filePath)
    expect(await store.load()).toEqual({
      imageGenerator: 'higgsfield',
      voiceMode: 'microphone',
      llmReasoningEffort: DEFAULT_LLM_REASONING_EFFORT,
      llmServiceTier: DEFAULT_LLM_SERVICE_TIER,
      llmSteps: defaultLlmStepSettings(),
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      customImageGuidePath: '',
      customImageCharacterSheetPath: '',
      customImageReferencePaths: [],
      expressionGuidePath: '',
      expressionBackgroundPath: '',
    })

    await store.save({
      imageGenerator: 'chatgpt',
      voiceMode: 'qwen',
      llmReasoningEffort: 'max',
      llmServiceTier: 'fast',
      llmSteps: defaultLlmStepSettings(),
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      customImageGuidePath: '',
      customImageCharacterSheetPath: '',
      customImageReferencePaths: [],
      expressionGuidePath: '',
      expressionBackgroundPath: '',
    })
    const reloaded = new AppSettingsStore(filePath)
    expect(await reloaded.load()).toEqual({
      imageGenerator: 'chatgpt',
      voiceMode: 'qwen',
      llmReasoningEffort: 'max',
      llmServiceTier: 'fast',
      llmSteps: defaultLlmStepSettings(),
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      customImageGuidePath: '',
      customImageCharacterSheetPath: '',
      customImageReferencePaths: [],
      expressionGuidePath: '',
      expressionBackgroundPath: '',
    })
  })

  it('migrates unknown provider values back to the safe default', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-settings-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'settings.json')
    await fs.writeFile(filePath, JSON.stringify({ imageGenerator: 'unknown-provider' }), 'utf8')

    const store = new AppSettingsStore(filePath)
    expect(await store.load()).toEqual({
      imageGenerator: 'higgsfield',
      voiceMode: 'microphone',
      llmReasoningEffort: DEFAULT_LLM_REASONING_EFFORT,
      llmServiceTier: DEFAULT_LLM_SERVICE_TIER,
      llmSteps: defaultLlmStepSettings(),
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      customImageGuidePath: '',
      customImageCharacterSheetPath: '',
      customImageReferencePaths: [],
      expressionGuidePath: '',
      expressionBackgroundPath: '',
    })
  })

  it('keeps a custom step and fills any missing steps from the defaults', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-settings-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'settings.json')
    await fs.writeFile(
      filePath,
      JSON.stringify({
        llmSteps: {
          'script-draft': { model: 'gpt-5.6-luna', reasoningEffort: 'medium', serviceTier: 'standard' },
        },
      }),
      'utf8',
    )

    const loaded = await new AppSettingsStore(filePath).load()

    expect(loaded.llmSteps['script-draft']).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'medium',
      serviceTier: 'standard',
    })
    expect(loaded.llmSteps['video-idea'].model).toBe('gpt-6-astra')
    expect(loaded.llmSteps.image.reasoningEffort).toBe('low')
  })

  it('moves a character sheet out of the reference list', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-settings-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'settings.json')
    const sheet = path.join(directory, 'character sheet.png')
    const face = path.join(directory, 'face.jpg')
    await fs.writeFile(
      filePath,
      JSON.stringify({
        customImageReferencePaths: [face, sheet],
      }),
      'utf8',
    )

    const store = new AppSettingsStore(filePath)
    const loaded = await store.load()

    expect(loaded.customImageCharacterSheetPath).toBe(sheet)
    expect(loaded.customImageReferencePaths).toEqual([face])
  })

  it('persists named production bible presets across settings store reloads', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-production-bibles-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'settings.json')
    const bible = {
      name: 'Clean cartoon',
      style: 'Clean 2D cartoon illustration.',
      characters: 'Rounded complete bodies.',
      mainCharacter: 'Golden retriever with warm golden fur.',
      supportingCharacter: '',
      setting: 'Bright uncluttered rooms.',
      palette: 'Warm flat colors.',
      camera: 'Readable medium shots.',
      negativePrompt: 'Photorealism, extra limbs.',
    }

    const store = new AppSettingsStore(filePath)
    await store.load()
    await store.saveProductionBible('Dogs', bible)

    const reloaded = new AppSettingsStore(filePath)
    await reloaded.load()
    expect(reloaded.loadProductionBible('dogs')).toEqual({
      name: 'Dogs',
      bible: {
        ...bible,
        name: 'Dogs',
      },
    })
  })

  it('migrates the legacy GPU text encoder default to CPU', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-settings-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'settings.json')
    await fs.writeFile(
      filePath,
      JSON.stringify({
        imageGenerator: 'comfyui',
        comfy: {
          ...DEFAULT_COMFY_UI_SETTINGS,
          clipDevice: 'default',
        },
      }),
      'utf8',
    )

    const store = new AppSettingsStore(filePath)
    expect((await store.load()).comfy.clipDevice).toBe('cpu')
  })

  it('persists YouTube channel image profiles and restores the active selection', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-channel-profiles-'))
    temporaryDirectories.push(directory)
    const filePath = path.join(directory, 'settings.json')
    const bible = {
      name: 'Doggo',
      style: 'Clean 2D cartoon illustration.',
      characters: 'Rounded complete bodies.',
      mainCharacter: 'Golden retriever with warm golden fur.',
      supportingCharacter: '',
      setting: 'Bright uncluttered rooms.',
      palette: 'Warm flat colors.',
      camera: 'Readable medium shots.',
      negativePrompt: 'Photorealism, extra limbs.',
    }

    const store = new AppSettingsStore(filePath)
    await store.load()
    const saved = await store.saveChannelProfile({
      name: 'Doggo',
      visualBible: bible,
      imageGenerator: 'comfyui',
      comfy: {
        ...DEFAULT_COMFY_UI_SETTINGS,
        diffusionModel: 'z_image_turbo_bf16.safetensors',
        guidance: 1,
      },
    })

    expect(saved.profiles).toHaveLength(1)
    expect(saved.activeProfileId).toBe(saved.profiles[0]?.id)
    expect(saved.profiles[0]?.imageGenerator).toBe('comfyui')
    expect(saved.profiles[0]?.comfy.diffusionModel).toBe('z_image_turbo_bf16.safetensors')

    const reloaded = new AppSettingsStore(filePath)
    await reloaded.load()
    const listed = reloaded.getChannelProfiles()
    expect(listed.activeProfileId).toBe(saved.profiles[0]?.id)
    expect(listed.profiles[0]?.visualBible.mainCharacter).toContain('Golden retriever')
    expect(reloaded.getActiveChannelProfile()?.name).toBe('Doggo')

    const remaining = await reloaded.removeChannelProfile(listed.activeProfileId)
    expect(remaining.profiles).toEqual([])
    expect(remaining.activeProfileId).toBe('')
  })
})
