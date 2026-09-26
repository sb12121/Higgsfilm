import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMFY_UI_SETTINGS, defaultLlmStepSettings } from '../../shared/types'
import { AppSettingsStore } from './appSettingsStore'
import { buildQwenWorkflow, QwenTtsClient } from './qwenTtsClient'
import { ProjectStore } from './projectStore'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  )
})

describe('QwenTtsClient', () => {
  it('stores a project-local reference and exact transcript', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-qwen-reference-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
    await settings.load()
    const source = path.join(directory, 'voice-reference.wav')
    await fs.writeFile(source, Buffer.alloc(128, 1))

    const client = new QwenTtsClient(projectStore, settings)
    await client.saveReferenceFile(source)
    const status = await client.saveReferenceText('Exact words from the reference.')

    expect(status).toMatchObject({
      configured: true,
      referenceName: 'voice-reference.wav',
      referenceMime: 'audio/wav',
      referenceText: 'Exact words from the reference.',
    })
    expect(await fs.stat(path.join(directory, '.higgsfilm-qwen-tts', 'reference.wav'))).toBeTruthy()
  })

  it('builds the DeepVids-compatible paragraph workflow', () => {
    const workflow = buildQwenWorkflow('reference.wav', 'Reference words.', 'A full paragraph.')

    expect(workflow['1']).toMatchObject({
      class_type: 'Qwen3Loader',
      inputs: { repo_id: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base' },
    })
    expect(workflow['2']).toMatchObject({
      class_type: 'LoadAudio',
      inputs: { audio: 'reference.wav' },
    })
    expect(workflow['10']).toMatchObject({
      class_type: 'Qwen3VoiceClone',
      inputs: {
        text: 'A full paragraph.',
        ref_text: 'Reference words.',
        ref_audio: ['2', 0],
      },
    })
    expect(workflow['11']).toMatchObject({
      class_type: 'PreviewAudio',
      inputs: { audio: ['10', 0] },
    })
  })

  it('keeps still-cast clone text as the spoken line only', () => {
    const workflow = buildQwenWorkflow('reference.wav', 'Reference words.', 'Genius.', {
      maxNewTokens: 512,
    })

    expect(workflow['10']).toMatchObject({
      class_type: 'Qwen3VoiceClone',
      inputs: {
        text: 'Genius.',
        max_new_tokens: 512,
        ref_text: 'Reference words.',
      },
    })
  })

  it('keeps the existing ComfyUI voice settings when checking status', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-qwen-status-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
    await settings.load()
    await settings.save({
      imageGenerator: 'comfyui',
      voiceMode: 'qwen',
      llmReasoningEffort: 'low',
      llmServiceTier: 'standard',
      llmSteps: defaultLlmStepSettings(),
      comfy: { ...DEFAULT_COMFY_UI_SETTINGS, baseUrl: 'http://localhost:8188/' },
      customImageGuidePath: '',
      customImageCharacterSheetPath: '',
      customImageReferencePaths: [],
      expressionGuidePath: '',
      expressionBackgroundPath: '',
    })

    const status = await new QwenTtsClient(projectStore, settings).getStatus()

    expect(status.comfyUrl).toBe('http://localhost:8188')
    expect(status.model).toBe('Qwen/Qwen3-TTS-12Hz-1.7B-Base')
    expect(status.configured).toBe(false)
  })

  it('persists an aligned paragraph master and exact cue metadata', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-qwen-master-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A verified line.')
    const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
    await settings.load()
    const reference = path.join(directory, 'reference.wav')
    await fs.writeFile(reference, Buffer.alloc(128, 1))

    const referenceStatusClient = new QwenTtsClient(projectStore, settings)
    await referenceStatusClient.saveReferenceFile(reference)
    await referenceStatusClient.saveReferenceText('Reference words.')

    const flac = oneSecondFlac()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/upload/image')) {
          return new Response(JSON.stringify({ name: 'reference.wav' }), { status: 200 })
        }
        if (url.endsWith('/prompt')) {
          return new Response(JSON.stringify({ prompt_id: 'prompt-1' }), { status: 200 })
        }
        if (url.includes('/history/prompt-1')) {
          return new Response(
            JSON.stringify({
              'prompt-1': {
                status: { status_str: 'success', completed: true },
                outputs: { '11': { audio: [{ filename: 'generated.flac', type: 'temp' }] } },
              },
            }),
            { status: 200 },
          )
        }
        if (url.includes('/view?')) {
          return new Response(new Uint8Array(flac), {
            status: 200,
            headers: { 'content-type': 'audio/flac' },
          })
        }
        throw new Error(`Unexpected test fetch: ${url}`)
      }),
    )

    const client = new QwenTtsClient(projectStore, settings, {
      getStatus: async () => ({
        configured: true,
        runtime: 'test-python',
        model: 'small.en',
        message: 'ready',
      }),
      align: async (audioPath) => {
        expect(path.isAbsolute(audioPath)).toBe(true)
        return {
          transcript: 'A verified line.',
          words: [
            { text: 'A', start: 0.05, end: 0.2, confidence: 0.99 },
            { text: 'verified', start: 0.25, end: 0.65, confidence: 0.99 },
            { text: 'line.', start: 0.7, end: 0.95, confidence: 0.99 },
          ],
        }
      },
    })

    const state = await client.generate({ mode: 'all', sequence: 'main' })
    const line = state.manifest.lines[0]!
    expect(line).toMatchObject({
      voiceAlignmentSource: 'paragraph-aligned',
      voiceCueStartMs: 0,
      voiceCueEndMs: 1000,
      voiceAlignmentConfidence: expect.any(Number),
      voiceTranscript: 'A verified line.',
    })
    expect(state.manifest.qwenParagraphMasters).toMatchObject([
      {
        paragraphIndex: 0,
        alignmentStatus: 'aligned',
        masterPath: expect.stringContaining('.higgsfilm-qwen-tts/paragraphs/'),
      },
    ])
    const reportPath = path.join(directory, line.voiceAlignmentReportPath!)
    await expect(fs.readFile(reportPath, 'utf8')).resolves.toContain('"transcript": "A verified line."')
    await expect(fs.stat(path.join(directory, line.voiceSourcePath!))).resolves.toBeTruthy()
    expect(imported.manifest.lines[0]!.id).toBe(line.id)

    const realigned = await client.realign({ sequence: 'main' })
    expect(realigned.manifest.lines[0]!.voiceAlignmentSource).toBe('paragraph-aligned')
    expect(realigned.manifest.qwenParagraphMasters?.[0]?.alignmentStatus).toBe('aligned')
  })

  it('generates one cloned take per still-cast line using that line’s expression tone', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-qwen-still-cast-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    await projectStore.importScriptText(
      'Laughing: Genius.\nCustom: Bux look at wallet.',
      'main',
      'stanzas',
    )
    const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
    await settings.load()
    const reference = path.join(directory, 'reference.wav')
    await fs.writeFile(reference, Buffer.alloc(128, 1))
    const setup = new QwenTtsClient(projectStore, settings)
    await setup.saveReferenceFile(reference)
    await setup.saveReferenceText('Reference words.')

    const flac = oneSecondFlac()
    const promptTexts: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith('/upload/image')) {
          return new Response(JSON.stringify({ name: 'reference.wav' }), { status: 200 })
        }
        if (url.endsWith('/prompt')) {
          const body = JSON.parse(String(init?.body || '{}')) as {
            prompt?: { '10'?: { inputs?: { text?: string; max_new_tokens?: number } } }
          }
          promptTexts.push(body.prompt?.['10']?.inputs?.text || '')
          expect(body.prompt?.['10']?.inputs?.max_new_tokens).toBe(512)
          return new Response(JSON.stringify({ prompt_id: `prompt-${promptTexts.length}` }), {
            status: 200,
          })
        }
        if (url.includes('/history/')) {
          const promptId = url.split('/history/')[1] || 'prompt-1'
          return new Response(
            JSON.stringify({
              [promptId]: {
                status: { status_str: 'success', completed: true },
                outputs: { '11': { audio: [{ filename: `${promptId}.flac`, type: 'temp' }] } },
              },
            }),
            { status: 200 },
          )
        }
        if (url.includes('/view?')) {
          return new Response(new Uint8Array(flac), {
            status: 200,
            headers: { 'content-type': 'audio/flac' },
          })
        }
        throw new Error(`Unexpected test fetch: ${url}`)
      }),
    )

    const client = new QwenTtsClient(projectStore, settings, {
      getStatus: async () => ({
        configured: true,
        runtime: 'test-python',
        model: 'small.en',
        message: 'ready',
      }),
      align: async (_audioPath, text) => {
        const words = text
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((word, index) => ({
            text: word,
            start: index * 0.2,
            end: index * 0.2 + 0.18,
            confidence: 0.99,
          }))
        return { transcript: text.trim(), words }
      },
    })

    const state = await client.generate({ mode: 'all', sequence: 'main' })
    expect(state.manifest.lines.map((entry) => entry.stillBeats?.[0]?.expression)).toEqual([
      'laughing',
      'custom',
    ])
    expect(promptTexts).toHaveLength(2)
    expect(promptTexts[0]).toBe('Genius.')
    expect(promptTexts[1]).toBe('Bux look at wallet.')
    expect(state.manifest.qwenParagraphMasters?.map((master) => master.paragraphIndex)).toEqual([
      0, 1,
    ])
  })
})

function oneSecondFlac(): Buffer {
  const streamInfo = new Uint8Array(18)
  streamInfo[10] = 0x0b
  streamInfo[11] = 0xb8
  streamInfo[16] = 0xbb
  streamInfo[17] = 0x80
  return Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0x80, 0, 0, 18]),
    Buffer.from(streamInfo),
    Buffer.alloc(16),
  ])
}
