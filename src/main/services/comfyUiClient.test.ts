import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeScenePrompt } from '../../shared/promptComposer'
import { DEFAULT_COMFY_UI_SETTINGS, defaultLlmStepSettings, type GenerateSceneInput } from '../../shared/types'
import { AppSettingsStore } from './appSettingsStore'
import { ComfyUiClient } from './comfyUiClient'
import { ProjectStore } from './projectStore'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('ComfyUiClient', () => {
  it('queues a Flux workflow and saves the generated image locally', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-comfy-image-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const state = await projectStore.importScriptText('A golden retriever waits by the door.')
    const line = state.manifest.lines[0]
    const scenePrompt = composeScenePrompt(
      line.text,
      'A golden retriever waits beside a red door.',
    )
    const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
    await settings.load()

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/object_info/UNETLoader')) {
        return new Response(
          JSON.stringify({
            UNETLoader: {
              input: {
                required: {
                  unet_name: [['flux-2-klein-9b-fp8.safetensors']],
                },
              },
            },
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/prompt')) {
        const body = JSON.parse(String(init?.body)) as {
          prompt: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
          client_id?: string
        }
        expect(body.client_id).toBeTruthy()
        expect(body.prompt['4'].inputs?.text).toContain('Style:')
        expect(body.prompt['4'].inputs?.text).toContain('A golden retriever waits beside a red door.')
        expect(body.prompt['4'].inputs?.text).not.toContain(line.text)
        expect(body.prompt['2'].inputs?.device).toBe('cpu')
        expect(body.prompt['6'].inputs?.width).toBe(1920)
        expect(body.prompt['6'].inputs?.height).toBe(1080)
        expect(body.prompt['14'].class_type).toBe('ImageScale')
        expect(body.prompt['14'].inputs?.width).toBe(3840)
        expect(body.prompt['14'].inputs?.height).toBe(2160)
        expect(body.prompt['14'].inputs?.upscale_method).toBe('lanczos')
        expect(body.prompt['13'].inputs?.images).toEqual(['14', 0])
        return new Response(JSON.stringify({ prompt_id: 'prompt-1' }), { status: 200 })
      }
      if (url.endsWith('/history/prompt-1')) {
        return new Response(
          JSON.stringify({
            'prompt-1': {
              status: { status_str: 'success', completed: true },
              outputs: {
                '13': {
                  images: [{ filename: 'higgsfilm_00001.png', subfolder: '', type: 'output' }],
                },
              },
            },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/view?')) {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      throw new Error(`Unexpected ComfyUI request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', undefined)

    const client = new ComfyUiClient(projectStore, settings)
    const input: GenerateSceneInput = {
      lineId: line.id,
      prompt: scenePrompt,
      modelEndpoint: 'comfyui-local',
      aspectRatio: '16:9',
      resolution: '1k',
    }

    await client.queueScene(input)
    await vi.waitFor(() => {
      expect(projectStore.get()!.manifest.lines[0].sceneStatus).toBe('complete')
    })

    const savedLine = projectStore.get()!.manifest.lines[0]
    expect(savedLine.imageGenerator).toBe('comfyui')
    expect(savedLine.comfyPromptId).toBeUndefined()
    expect(savedLine.imagePath).toBe('scenes/001/image-01.png')
    await expect(fs.readFile(path.join(directory, savedLine.imagePath!))).resolves.toEqual(
      Buffer.from([137, 80, 78, 71]),
    )
  })

  it('queues the native Z-Image Turbo workflow when selected', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-comfy-z-image-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const state = await projectStore.importScriptText('A golden retriever waits by the door.')
    const line = state.manifest.lines[0]
    const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
    await settings.load()
    await settings.save({
      imageGenerator: 'comfyui',
      voiceMode: 'microphone',
      llmReasoningEffort: 'low',
      llmServiceTier: 'standard',
      llmSteps: defaultLlmStepSettings(),
      customImageGuidePath: '',
      customImageCharacterSheetPath: '',
      customImageReferencePaths: [],
      expressionGuidePath: '',
      expressionBackgroundPath: '',
      comfy: {
        ...DEFAULT_COMFY_UI_SETTINGS,
        diffusionModel: 'z_image_turbo_bf16.safetensors',
        steps: 20,
      },
    })

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/object_info/UNETLoader')) {
        return new Response(
          JSON.stringify({
            UNETLoader: {
              input: {
                required: {
                  unet_name: [['z_image_turbo_bf16.safetensors']],
                },
              },
            },
          }),
          { status: 200 },
        )
      }
      if (url.endsWith('/prompt')) {
        const body = JSON.parse(String(init?.body)) as {
          prompt: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
          client_id?: string
        }
        expect(body.client_id).toBeTruthy()
        expect(body.prompt['1'].inputs?.unet_name).toBe('z_image_turbo_bf16.safetensors')
        expect(body.prompt['2'].inputs?.type).toBe('lumina2')
        expect(body.prompt['2'].inputs?.device).toBe('cpu')
        expect(body.prompt['7'].class_type).toBe('ModelSamplingAuraFlow')
        expect(body.prompt['8'].inputs?.steps).toBe(20)
        expect(body.prompt['8'].inputs?.sampler_name).toBe('res_multistep')
        expect(body.prompt['8'].inputs?.cfg).toBe(1)
        expect(body.prompt['4'].inputs?.text).toContain('2D cartoon illustration')
        expect(body.prompt['4'].inputs?.text).toContain('16:9 canvas')
        expect(body.prompt['4'].inputs?.text).toContain('Heads attached to necks')
        expect(body.prompt['4'].inputs?.text).not.toContain('unreadable text')
        expect(body.prompt['4'].inputs?.text).not.toContain('Creative variation requirements')
        expect(body.prompt['4'].inputs?.text).not.toContain('Whole-script continuity canon')
        expect(body.prompt['4'].inputs?.text).not.toContain('question mark')
        expect(body.prompt['6'].inputs?.width).toBe(1152)
        expect(body.prompt['6'].inputs?.height).toBe(648)
        expect(body.prompt['11'].class_type).toBe('ImageScale')
        expect(body.prompt['11'].inputs?.width).toBe(3840)
        expect(body.prompt['11'].inputs?.height).toBe(2160)
        expect(body.prompt['11'].inputs?.upscale_method).toBe('lanczos')
        expect(body.prompt['10'].inputs?.images).toEqual(['11', 0])
        return new Response(JSON.stringify({ prompt_id: 'z-prompt-1' }), { status: 200 })
      }
      if (url.endsWith('/history/z-prompt-1')) {
        return new Response(
          JSON.stringify({
            'z-prompt-1': {
              status: { status_str: 'success', completed: true },
              outputs: {
                '10': {
                  images: [{ filename: 'higgsfilm_z_00001.png', subfolder: '', type: 'output' }],
                },
              },
            },
          }),
          { status: 200 },
        )
      }
      if (url.includes('/view?')) {
        return new Response(Uint8Array.from([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      throw new Error(`Unexpected ComfyUI request: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('WebSocket', undefined)

    const client = new ComfyUiClient(projectStore, settings)
    const input: GenerateSceneInput = {
      lineId: line.id,
      prompt: line.scenePrompt,
      modelEndpoint: 'comfyui-local',
      aspectRatio: '16:9',
      resolution: '1k',
    }

    await client.queueScene(input)
    await vi.waitFor(() => {
      expect(projectStore.get()!.manifest.lines[0].sceneStatus).toBe('complete')
    })
  })

  it('marks persisted queued ComfyUI scenes as cancelled', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-comfy-cancel-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const state = await projectStore.importScriptText('A golden retriever waits by the door.')
    const line = state.manifest.lines[0]
    line.imageGenerator = 'comfyui'
    line.sceneStatus = 'queued'
    await projectStore.save(state.manifest)
    const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
    await settings.load()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const client = new ComfyUiClient(projectStore, settings)
    await client.cancelQueuedScenes()

    const cancelledLine = projectStore.get()!.manifest.lines[0]
    expect(cancelledLine.sceneStatus).toBe('failed')
    expect(cancelledLine.error).toContain('cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
