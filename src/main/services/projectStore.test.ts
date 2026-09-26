import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VISUAL_BIBLE, ProjectStore } from './projectStore'
import { emptyVideoIdeaSession } from '../../shared/videoIdea'
import * as voiceCleanup from './voiceTakeCleanup'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('ProjectStore', () => {
  it('preserves an invalid manifest and the previously open project', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-invalid-manifest-'))
    temporaryDirectories.push(parent)
    const store = new ProjectStore()
    const previous = await store.open(path.join(parent, 'previous'))
    const broken = path.join(parent, 'broken')
    await fs.mkdir(broken)
    const manifestPath = path.join(broken, 'higgsfilm.json')
    const original = '{"lines": [incomplete project data'
    await fs.writeFile(manifestPath, original)

    await expect(store.open(broken)).rejects.toThrow()
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(original)
    expect(store.get()?.manifest.id).toBe(previous.manifest.id)
  })

  it('does not overwrite a manifest when reading it fails', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-unreadable-manifest-'))
    temporaryDirectories.push(directory)
    const store = new ProjectStore()
    await store.open(directory)
    const manifestPath = path.join(directory, 'higgsfilm.json')
    const original = await fs.readFile(manifestPath, 'utf8')
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('Access denied'), { code: 'EACCES' }))

    await expect(store.open(directory)).rejects.toThrow('Access denied')
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(original)
  })

  it.each(['line', 'stanza'] as const)(
    'commits %s recording cleanup to the current manifest after a concurrent save',
    async (mode) => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-recording-race-'))
      temporaryDirectories.push(directory)
      const store = new ProjectStore()
      await store.open(directory)
      const imported = await store.importScriptText('First scene.')
      const lineId = imported.manifest.lines[0].id
      let release!: () => void
      let started!: () => void
      const pending = new Promise<void>((resolve) => { release = resolve })
      const entered = new Promise<void>((resolve) => { started = resolve })
      vi.spyOn(voiceCleanup, 'cleanupRecordedVoiceTake').mockImplementationOnce(async (source) => {
        started()
        await pending
        const rawAbsolutePath = path.join(path.dirname(source), 'voice-raw.webm')
        const cleanedAbsolutePath = path.join(path.dirname(source), 'voice.flac')
        await fs.rename(source, rawAbsolutePath)
        await fs.writeFile(cleanedAbsolutePath, 'cleaned audio')
        return { rawAbsolutePath, cleanedAbsolutePath, trimStart: 1, trimEnd: 3, durationSeconds: 2.2, version: 2, endPaddingSeconds: 0.15, confident: true }
      })
      const payload = { lineId, data: new Uint8Array([1]).buffer, duration: 10, mimeType: 'audio/webm' }
      const recording = mode === 'line' ? store.saveRecording(payload) : store.saveStanzaRecording(payload)
      await entered
      try {
        const concurrent = store.get()!.manifest
        concurrent.lines[0].shotNote = 'Keep this concurrent edit'
        await store.save(concurrent)
      } finally {
        release()
      }
      await recording
      const reopened = await store.open(directory)
      expect(reopened.manifest.lines[0]).toMatchObject({
        voicePath: 'scenes/001/voice.flac',
        voiceRawPath: 'scenes/001/voice-raw.webm',
        duration: 2.2,
        endTime: 2.2,
        voiceTrimStart: 1,
        voiceTrimEnd: 3,
        status: 'recorded',
        shotNote: 'Keep this concurrent edit',
      })
      expect(await fs.readFile(path.join(directory, reopened.manifest.lines[0].voicePath!), 'utf8')).toBe('cleaned audio')
    },
  )

  it.each(['reroll', 'collapse', 'custom', 'trailer'] as const)(
    'rejects outside-project still deletion during %s',
    async (mode) => {
      const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-still-containment-'))
      temporaryDirectories.push(parent)
      const directory = path.join(parent, 'project')
      const outside = path.join(parent, 'outside.png')
      await fs.writeFile(outside, 'must survive')
      const store = new ProjectStore()
      await store.open(directory)
      const sequence = mode === 'trailer' ? 'trailer' : 'main'
      await fs.mkdir(path.join(directory, 'Expressions', 'Happy'), { recursive: true })
      await fs.writeFile(path.join(directory, 'Expressions', 'Happy', 'happy.png'), 'replacement')
      await store.importScriptText('First scene.', sequence)
      const line = store.getSequenceManifest(sequence).lines[0]
      line.stillBeats = [{ id: 'beat1', text: line.text, expression: mode === 'custom' ? 'custom' : 'happy', imagePath: '../outside.png' }]
      if (mode === 'collapse') {
        line.stillBeats.push({ id: 'beat2', text: line.text, expression: 'happy' })
      }
      if (mode === 'custom') {
        await fs.mkdir(path.join(directory, 'Custom'))
        await fs.writeFile(path.join(directory, 'Custom', 'First scene.png'), 'replacement')
      }
      await store.save()
      await store.open(directory)

      await expect(store.assignStillCastImages({ sequence, lineIds: [line.id], reroll: true }))
        .rejects.toThrow('Still image path is outside the active project.')
      expect(await fs.readFile(outside, 'utf8')).toBe('must survive')
    },
  )

  it('notifies listeners after opening and saving a project', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-project-events-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    const revisions: number[] = []
    const unsubscribe = projectStore.onChange((state) => {
      if (state) revisions.push(state.revision)
    })

    await projectStore.open(directory)
    await projectStore.importScriptText('A narrated scene.')
    unsubscribe()
    await projectStore.save(projectStore.getManifest())

    expect(revisions).toHaveLength(2)
    expect(revisions[1]).toBeGreaterThan(revisions[0])
  })

  it('unloads the open project and notifies listeners', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-project-close-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    const events: Array<number | null> = []
    const unsubscribe = projectStore.onChange((state) => events.push(state ? state.revision : null))

    await projectStore.open(directory)
    expect(projectStore.get()?.rootPath).toBe(path.resolve(directory))
    await projectStore.close()
    unsubscribe()

    expect(projectStore.get()).toBeNull()
    expect(events.at(-1)).toBeNull()
  })

  it('keeps overlapping image saves for every completed scene', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-project-store-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    const state = await projectStore.open(directory)
    const imported = await projectStore.importScriptText('First scene. Second scene.')
    const [firstLine, secondLine] = imported.manifest.lines

    await Promise.all([
      projectStore.saveImage(firstLine.id, Buffer.from('first-image'), 'png'),
      projectStore.saveImage(secondLine.id, Buffer.from('second-image'), 'png'),
    ])

    const current = projectStore.get()!
    expect(current.manifest.lines[0].sceneStatus).toBe('complete')
    expect(current.manifest.lines[0].imagePath).toBe('scenes/001/image-01.png')
    expect(current.manifest.lines[1].sceneStatus).toBe('complete')
    expect(current.manifest.lines[1].imagePath).toBe('scenes/002/image-01.png')
    expect(current.revision).toBeGreaterThan(state.revision)

    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, 'higgsfilm.json'), 'utf8'),
    ) as { lines: Array<{ sceneStatus: string; imagePath?: string }> }
    expect(persisted.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sceneStatus: 'complete',
          imagePath: 'scenes/001/image-01.png',
        }),
        expect.objectContaining({
          sceneStatus: 'complete',
          imagePath: 'scenes/002/image-01.png',
        }),
      ]),
    )
  })

  it('preserves generated voice assets when a stale direction save finishes later', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-project-voice-race-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A narrated scene.')
    const staleManifest = structuredClone(imported.manifest)
    const line = imported.manifest.lines[0]!

    await projectStore.saveRecording({
      lineId: line.id,
      data: new Uint8Array(Buffer.from('qwen-voice')).buffer,
      duration: 2.4,
      mimeType: 'audio/flac',
    })
    staleManifest.lines[0]!.sceneDescription = 'A clear visual direction.'
    staleManifest.lines[0]!.directionStatus = 'complete'
    await projectStore.save(staleManifest)

    const savedLine = projectStore.get()!.manifest.lines[0]!
    expect(savedLine.voicePath).toBe('scenes/001/voice.flac')
    expect(savedLine.duration).toBe(2.4)
    expect(savedLine.directionStatus).toBe('complete')
  })

  it('clears a regenerated image tag when the renderer saves an empty tag list', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-image-tags-clear-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A narrated scene.')
    const line = imported.manifest.lines[0]!
    await projectStore.saveImage(line.id, Buffer.from('scene-image'), 'png')

    const tagged = structuredClone(projectStore.getManifest())
    tagged.lines[0]!.imageTags = ['regenerated']
    await projectStore.save(tagged)
    expect(projectStore.getManifest().lines[0]!.imageTags).toEqual(['regenerated'])

    const accepted = structuredClone(projectStore.getManifest())
    accepted.lines[0]!.imageTags = []
    await projectStore.save(accepted)
    expect(projectStore.getManifest().lines[0]!.imageTags).toBeUndefined()
  })

  it('keeps a regenerated image tag when a stale save omits it', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-image-tags-preserve-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A narrated scene.')
    const staleManifest = structuredClone(imported.manifest)
    const line = imported.manifest.lines[0]!
    await projectStore.saveImage(line.id, Buffer.from('scene-image'), 'png')

    const tagged = structuredClone(projectStore.getManifest())
    tagged.lines[0]!.imageTags = ['regenerated']
    await projectStore.save(tagged)

    staleManifest.lines[0]!.sceneDescription = 'A later direction edit.'
    staleManifest.lines[0]!.directionStatus = 'complete'
    delete staleManifest.lines[0]!.imageTags
    await projectStore.save(staleManifest)

    const savedLine = projectStore.getManifest().lines[0]!
    expect(savedLine.imageTags).toEqual(['regenerated'])
    expect(savedLine.directionStatus).toBe('complete')
  })

  it('replaces a voice clip and advances its asset version', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-project-voice-replace-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A narrated scene.')
    const line = imported.manifest.lines[0]!

    await projectStore.saveRecording({
      lineId: line.id,
      data: new Uint8Array(Buffer.from('old-voice')).buffer,
      duration: 2,
      mimeType: 'audio/flac',
    })
    const firstVersion = projectStore.getManifest().lines[0]!.voiceAssetVersion

    await projectStore.saveRecording({
      lineId: line.id,
      data: new Uint8Array(Buffer.from('new-voice')).buffer,
      duration: 2,
      mimeType: 'audio/flac',
    })
    const savedLine = projectStore.getManifest().lines[0]!

    expect(savedLine.voicePath).toBe('scenes/001/voice.flac')
    expect(savedLine.voiceAssetVersion).toBeTruthy()
    expect(savedLine.voiceAssetVersion).not.toBe(firstVersion)
    await expect(fs.readFile(path.join(directory, 'scenes', '001', 'voice.flac'))).resolves.toEqual(
      Buffer.from('new-voice'),
    )
  })

  it('persists QWEN cue metadata and invalidates it when the script text changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-qwen-cues-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A carefully aligned voice line.')
    const line = imported.manifest.lines[0]!

    await projectStore.saveRecording({
      lineId: line.id,
      data: new Uint8Array(Buffer.from('qwen-voice')).buffer,
      duration: 1.234,
      mimeType: 'audio/flac',
      sourcePath: '.higgsfilm-qwen-tts/paragraphs/master-main-0001.wav',
      cueStartMs: 0,
      cueEndMs: 1234,
      alignmentSource: 'paragraph-aligned',
      alignmentConfidence: 0.97,
      transcript: 'A carefully aligned voice line.',
      alignmentReportPath: '.higgsfilm-qwen-tts/alignments/main-0001.json',
    })
    await projectStore.saveQwenParagraphMaster('main', {
      version: 1,
      paragraphIndex: 0,
      lineIds: [line.id],
      masterPath: '.higgsfilm-qwen-tts/paragraphs/master-main-0001.wav',
      durationMs: 1234,
      createdAt: new Date().toISOString(),
      alignmentStatus: 'aligned',
      alignmentReportPath: '.higgsfilm-qwen-tts/alignments/main-0001.json',
    })

    expect(projectStore.getManifest().lines[0]).toMatchObject({
      voiceAssetVersion: expect.any(String),
      voiceSourcePath: '.higgsfilm-qwen-tts/paragraphs/master-main-0001.wav',
      voiceCueStartMs: 0,
      voiceCueEndMs: 1234,
      voiceAlignmentSource: 'paragraph-aligned',
      voiceAlignmentConfidence: 0.97,
      voiceTranscript: 'A carefully aligned voice line.',
      voiceAlignmentReportPath: '.higgsfilm-qwen-tts/alignments/main-0001.json',
      duration: 1.23,
    })
    expect(projectStore.getManifest().qwenParagraphMasters).toHaveLength(1)

    const staleManifest = structuredClone(projectStore.getManifest())
    staleManifest.lines[0]!.text = 'A changed voice line.'
    await projectStore.save(staleManifest)

    expect(projectStore.getManifest().lines[0]).toMatchObject({
      status: 'draft',
      voiceAlignmentError: expect.stringContaining('script text changed'),
    })
    expect(projectStore.getManifest().lines[0]!.voicePath).toBeUndefined()
    expect(projectStore.getManifest().lines[0]!.voiceAssetVersion).toBeUndefined()
    expect(projectStore.getManifest().lines[0]!.voiceSourcePath).toBeUndefined()
    expect(projectStore.getManifest().lines[0]!.voiceAlignmentReportPath).toBeUndefined()
    expect(projectStore.getManifest().qwenParagraphMasters).toEqual([])
  })

  it('does not restore an old image as complete after a scene direction changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-project-image-race-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A narrated scene.')
    const line = imported.manifest.lines[0]!
    await projectStore.saveImage(line.id, Buffer.from('old-image'), 'png')

    const staleManifest = structuredClone(projectStore.get()!.manifest)
    const staleLine = staleManifest.lines[0]!
    staleLine.sceneDescription = 'A completely different visual moment in a garden.'
    staleLine.scenePrompt = 'A completely different visual moment in a garden.'
    staleLine.directionStatus = 'complete'
    staleLine.sceneStatus = 'draft'
    staleLine.imagePath = undefined
    await projectStore.save(staleManifest)

    const savedLine = projectStore.get()!.manifest.lines[0]!
    expect(savedLine.sceneStatus).toBe('draft')
    expect(savedLine.imagePath).toBeUndefined()
    await expect(fs.readFile(path.join(directory, 'scenes', '001', 'image-01.png'))).resolves.toEqual(
      Buffer.from('old-image'),
    )
  })

  it('clears scene-generation state and removes generated images before a full prompt reset', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-project-generation-reset-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A narrated scene.')
    const line = imported.manifest.lines[0]!
    await projectStore.saveImage(line.id, Buffer.from('old-image'), 'png')

    const manifest = structuredClone(projectStore.get()!.manifest)
    const savedLine = manifest.lines[0]!
    savedLine.scenePrompt = 'Old generated scene direction.'
    savedLine.sceneDescription = 'Old generated scene direction.'
    savedLine.directionStatus = 'complete'
    await projectStore.save(manifest)

    const reset = await projectStore.resetSceneGenerationCache()
    const resetLine = reset.manifest.lines[0]!

    expect(resetLine.scenePrompt).toContain('A narrated scene.')
    expect(resetLine.sceneDescription).toBeUndefined()
    expect(resetLine.sceneRecord).toBeUndefined()
    expect(resetLine.directionStatus).toBe('draft')
    expect(resetLine.sceneStatus).toBe('draft')
    expect(resetLine.imagePath).toBeUndefined()
    await expect(
      fs.access(path.join(directory, 'scenes', '001', 'image-01.png')),
    ).rejects.toThrow()
  })

  it('persists and normalizes a structured scene record', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-scene-record-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A narrated scene.')
    const line = imported.manifest.lines[0]!
    line.sceneRecord = {
      version: 1,
      lineId: line.id,
      sourceFingerprint: 'fingerprint-1',
      focalSubject: 'environment',
      visualAction: 'sunlight falls across the entryway',
      shotType: 'wide establishing shot',
      setting: 'bright entryway',
      visibleCharacters: [],
      visibleProps: ['red door'],
      propState: 'red door closed',
      variationReason: 'environmental beat',
      direction: 'A bright entryway shows a closed red door in a wide establishing shot.',
    }
    line.sceneDescription = line.sceneRecord.direction
    line.scenePrompt = `${line.scenePrompt}\nScene direction: ${line.sceneRecord.direction}`
    line.directionStatus = 'complete'
    await projectStore.save(imported.manifest)

    const reopened = new ProjectStore()
    const state = await reopened.open(directory)
    expect(state.manifest.lines[0]!.sceneRecord).toMatchObject({
      version: 1,
      lineId: line.id,
      focalSubject: 'environment',
      visibleProps: ['red door'],
    })
  })

  it('persists a direction-only scene record', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-plain-scene-record-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A narrated scene.')
    const line = imported.manifest.lines[0]!
    line.sceneRecord = {
      version: 1,
      lineId: line.id,
      sourceFingerprint: 'fingerprint-plain',
      direction:
        'A golden retriever watches the morning light cross a quiet apartment entryway in a medium environmental shot.',
    }
    line.sceneDescription = line.sceneRecord.direction
    line.scenePrompt = `${line.scenePrompt}\nScene direction: ${line.sceneRecord.direction}`
    line.directionStatus = 'complete'
    await projectStore.save(imported.manifest)

    const reopened = new ProjectStore()
    const state = await reopened.open(directory)
    expect(state.manifest.lines[0]!.sceneRecord).toEqual({
      version: 1,
      lineId: line.id,
      sourceFingerprint: 'fingerprint-plain',
      direction: line.sceneRecord.direction,
    })
  })

  it('preserves generating and failed direction states when an older direction exists', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-direction-status-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A narrated scene.')
    const line = imported.manifest.lines[0]!
    line.sceneRecord = {
      version: 1,
      lineId: line.id,
      sourceFingerprint: 'fingerprint-status',
      direction: 'An earlier visual direction remains available while a replacement is generated.',
    }
    line.sceneDescription = line.sceneRecord.direction
    line.directionStatus = 'generating'
    await projectStore.save(imported.manifest)
    expect(projectStore.getManifest().lines[0]!.directionStatus).toBe('generating')

    const failedManifest = structuredClone(projectStore.getManifest())
    failedManifest.lines[0]!.directionStatus = 'failed'
    failedManifest.lines[0]!.directionError = 'The replacement request timed out.'
    await projectStore.save(failedManifest)

    expect(projectStore.getManifest().lines[0]).toMatchObject({
      directionStatus: 'failed',
      directionError: 'The replacement request timed out.',
    })
  })

  it('persists paragraph membership on imported script lines', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-paragraph-store-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const state = await projectStore.importScriptText(
      'The hook begins. The setup follows.\n\nThe reveal lands.',
    )

    expect(state.manifest.lines.map((line) => line.paragraphIndex)).toEqual([0, 0, 1])
  })

  it('clears a stale script summary when a sequence is replaced', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-script-summary-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A cat crosses the room.')
    imported.manifest.scriptSummary = 'The recurring subject is a cat.'
    await projectStore.save(imported.manifest)

    await projectStore.importScriptText('A dog waits by the door.')

    expect(projectStore.get()!.manifest.scriptSummary).toBeUndefined()
  })

  it('restores paragraph membership for older saved projects', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-paragraph-migration-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    await projectStore.importScriptText('The hook begins. The setup follows.\n\nThe reveal lands.')

    const manifestPath = path.join(directory, 'higgsfilm.json')
    const legacyManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      lines: Array<{ paragraphIndex?: number }>
    }
    legacyManifest.lines.forEach((line) => delete line.paragraphIndex)
    await fs.writeFile(manifestPath, JSON.stringify(legacyManifest), 'utf8')

    const reopened = new ProjectStore()
    const state = await reopened.open(directory)
    expect(state.manifest.lines.map((line) => line.paragraphIndex)).toEqual([0, 0, 1])
  })

  it('migrates projects using the old stickman visual bible', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-style-migration-'))
    temporaryDirectories.push(directory)
    await fs.writeFile(
      path.join(directory, 'higgsfilm.json'),
      JSON.stringify({
        name: 'Legacy project',
        visualBible: {
          name: 'Stickman MS Paint Explainer',
          style: 'legacy stickman style',
        },
      }),
      'utf8',
    )

    const projectStore = new ProjectStore()
    const state = await projectStore.open(directory)
    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, 'higgsfilm.json'), 'utf8'),
    ) as { visualBible: { name: string } }

    expect(state.manifest.visualBible.name).toBe(DEFAULT_VISUAL_BIBLE.name)
    expect(persisted.visualBible.name).toBe(DEFAULT_VISUAL_BIBLE.name)
  })

  it('upgrades legacy 1080p export settings to 4K on open', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-export-4k-migration-'))
    temporaryDirectories.push(directory)
    await fs.writeFile(
      path.join(directory, 'higgsfilm.json'),
      JSON.stringify({
        name: 'HD project',
        exportSettings: {
          width: 1920,
          height: 1080,
          fps: 30,
          audioLufs: -16,
          truePeak: -1.5,
        },
        trailer: {
          lines: [],
          scriptFile: 'trailer/script.txt',
          exportSettings: {
            width: 1080,
            height: 1920,
            fps: 30,
            audioLufs: -16,
            truePeak: -1.5,
          },
        },
      }),
      'utf8',
    )

    const projectStore = new ProjectStore()
    const state = await projectStore.open(directory)
    const persisted = JSON.parse(
      await fs.readFile(path.join(directory, 'higgsfilm.json'), 'utf8'),
    ) as {
      exportSettings: { width: number; height: number }
      trailer: { exportSettings: { width: number; height: number } }
    }

    expect(state.manifest.exportSettings).toMatchObject({ width: 3840, height: 2160 })
    expect(state.manifest.trailer?.exportSettings).toMatchObject({ width: 2160, height: 3840 })
    expect(persisted.exportSettings).toMatchObject({ width: 3840, height: 2160 })
    expect(persisted.trailer.exportSettings).toMatchObject({ width: 2160, height: 3840 })
  })

  it('keeps custom export resolutions that are not legacy 1080p', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-export-custom-res-'))
    temporaryDirectories.push(directory)
    await fs.writeFile(
      path.join(directory, 'higgsfilm.json'),
      JSON.stringify({
        name: '1440p project',
        exportSettings: {
          width: 2560,
          height: 1440,
          fps: 30,
          audioLufs: -16,
          truePeak: -1.5,
        },
      }),
      'utf8',
    )

    const projectStore = new ProjectStore()
    const state = await projectStore.open(directory)
    expect(state.manifest.exportSettings).toMatchObject({ width: 2560, height: 1440 })
  })

  it('creates an independent vertical trailer sequence and stores its assets separately', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-trailer-store-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    const opened = await projectStore.open(directory)
    expect(opened.manifest.trailer?.lines).toEqual([])
    expect(opened.manifest.exportSettings).toMatchObject({
      width: 3840,
      height: 2160,
      fps: 30,
    })
    expect(opened.manifest.trailer?.exportSettings).toMatchObject({
      width: 2160,
      height: 3840,
      fps: 30,
    })

    const state = await projectStore.importScriptText(
      'A fast trailer hook. The full story has more to reveal.',
      'trailer',
    )
    const trailerLines = state.manifest.trailer!.lines
    expect(state.manifest.lines).toEqual([])
    expect(trailerLines).toHaveLength(2)
    expect(trailerLines.at(-1)?.role).toBe('cta')

    const trailerLine = trailerLines[0]
    await projectStore.saveRecording({
      lineId: trailerLine.id,
      sequence: 'trailer',
      data: new Uint8Array(Buffer.from('trailer-voice')).buffer,
      duration: 1.2,
      mimeType: 'audio/wav',
    })
    await projectStore.saveImage(
      trailerLine.id,
      Buffer.from('trailer-image'),
      'png',
      'trailer',
    )

    const saved = projectStore.get()!
    const savedTrailerLine = saved.manifest.trailer!.lines[0]
    expect(savedTrailerLine.voicePath).toBe('trailer/scenes/001/voice.wav')
    expect(savedTrailerLine.imagePath).toBe('trailer/scenes/001/image-01.png')
    expect(saved.manifest.lines).toEqual([])
    await expect(fs.stat(path.join(directory, 'trailer', 'script.txt'))).resolves.toBeTruthy()
  })

  it('applies a channel visual bible only when creating a new project folder', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-channel-bible-'))
    temporaryDirectories.push(directory)
    const channelBible = {
      ...DEFAULT_VISUAL_BIBLE,
      name: 'Doggo channel',
      mainCharacter: 'Male golden retriever with a blue collar.',
    }

    const created = new ProjectStore()
    const opened = await created.open(directory, { defaultVisualBible: channelBible })
    expect(opened.manifest.visualBible.name).toBe('Doggo channel')
    expect(opened.manifest.visualBible.mainCharacter).toContain('blue collar')

    const existing = new ProjectStore()
    const reopened = await existing.open(directory, {
      defaultVisualBible: {
        ...DEFAULT_VISUAL_BIBLE,
        name: 'Should not replace',
      },
    })
    expect(reopened.manifest.visualBible.name).toBe('Doggo channel')
  })

  it('imports stanza lines without sentence splitting', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-stanza-import-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const state = await projectStore.importScriptText(
      'Custom: Bux look at wallet,\nWarm Smile: Beautiful.\nConfident: Bux feel rich.',
      'main',
      'stanzas',
    )

    expect(state.manifest.lines.map((line) => line.text)).toEqual([
      'Bux look at wallet,',
      'Beautiful.',
      'Bux feel rich.',
    ])
    expect(state.manifest.lines.map((line) => line.paragraphIndex)).toEqual([0, 1, 2])
  })

  it('saves one stanza take onto a single-line stanza', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-stanza-record-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('Beautiful.', 'main', 'stanzas')
    const line = imported.manifest.lines[0]!

    const saved = await projectStore.saveStanzaRecording({
      lineId: line.id,
      data: new Uint8Array(Buffer.from('stanza-voice')).buffer,
      duration: 1.4,
      mimeType: 'audio/wav',
    })

    expect(saved.manifest.lines[0]?.voicePath).toBe('scenes/001/voice.wav')
    expect(saved.manifest.lines[0]?.voiceSourcePath).toBe('stanzas/001-master.wav')
    expect(saved.manifest.lines[0]?.status).toBe('recorded')
    expect(saved.manifest.lines[0]?.duration).toBe(1.4)
    await expect(fs.stat(path.join(directory, 'stanzas', '001-master.wav'))).resolves.toBeTruthy()
  })

  it('assigns a Custom image whose filename matches a script line', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-custom-still-'))
    temporaryDirectories.push(directory)
    const library = path.join(directory, 'Expressions')
    await fs.mkdir(path.join(library, 'Neutral Talking'), { recursive: true })
    await fs.writeFile(path.join(library, 'Neutral Talking', 'talk.png'), Buffer.from('talk-still'))
    await fs.mkdir(path.join(directory, 'Custom'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Custom', 'One hundred dollars.png'), Buffer.from('custom-still'))

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText(
      'DB look at wallet.\nOne hundred dollars.\nBeautiful.',
      'main',
      'stanzas',
    )
    const dollarLine = imported.manifest.lines[1]!

    const assigned = await projectStore.assignStillCastImages({
      libraryPath: library,
      lineIds: [dollarLine.id],
    })
    const saved = assigned.manifest.lines[1]!
    expect(saved.stillBeats?.[0]?.expression).toBe('custom')
    expect(saved.stillBeats?.[0]?.imagePath).toMatch(/^stills\/002\//)
    expect(saved.sceneStatus).toBe('complete')
    expect(saved.imagePath).toBe(saved.stillBeats?.[0]?.imagePath)
  })

  it('assigns Custom-9x16 stills on the condensed trailer and ignores Expressions', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-trailer-custom-'))
    temporaryDirectories.push(directory)
    const library = path.join(directory, 'Expressions')
    await fs.mkdir(path.join(library, 'Neutral Talking'), { recursive: true })
    await fs.writeFile(path.join(library, 'Neutral Talking', 'talk.png'), Buffer.from('talk-still'))
    await fs.mkdir(path.join(directory, 'Custom'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Custom', 'One hundred dollars.png'), Buffer.from('landscape-custom'))
    await fs.mkdir(path.join(directory, 'Custom-9x16'), { recursive: true })
    await fs.writeFile(
      path.join(directory, 'Custom-9x16', 'One hundred dollars.png'),
      Buffer.from('vertical-custom'),
    )

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText(
      'Custom: One hundred dollars.\nPoint at camera: See the full video to learn more.',
      'trailer',
      'stanzas',
      library,
    )

    const dollarLine = imported.manifest.trailer!.lines[0]!
    expect(dollarLine.text).toBe('One hundred dollars.')
    expect(dollarLine.stillBeats?.[0]?.expression).toBe('custom')
    expect(dollarLine.stillBeats?.[0]?.imagePath).toMatch(/^trailer\/stills\/001\//)
    expect(dollarLine.sceneStatus).toBe('complete')
    const copied = await fs.readFile(path.join(directory, dollarLine.stillBeats![0]!.imagePath!))
    expect(copied.toString()).toBe('vertical-custom')

    const ctaLine = imported.manifest.trailer!.lines[1]!
    expect(ctaLine.stillBeats?.[0]?.expression).toBe('custom')
    expect(ctaLine.sceneStatus).toBe('draft')
    expect(ctaLine.error).toMatch(/Custom-9x16/)
  })

  it('assigns stills from the channel Expressions folder without a configured library path', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-channel-assign-'))
    temporaryDirectories.push(root)
    const channel = path.join(root, 'BuxFit')
    const project = path.join(channel, 'How to Get Stronger at Home Without Weights')
    await fs.mkdir(path.join(channel, 'Expressions', 'Warm Smile'), { recursive: true })
    await fs.writeFile(path.join(channel, 'Expressions', 'Warm Smile', 'smile.png'), Buffer.from('smile-still'))
    await fs.mkdir(path.join(project, 'Custom'), { recursive: true })
    await fs.writeFile(path.join(project, 'Custom', 'Bux lift tiny soup can.png'), Buffer.from('custom-still'))

    const projectStore = new ProjectStore()
    await projectStore.open(project)
    const imported = await projectStore.importScriptText(
      'Warm Smile: Bux will get stronger at home without weights.\nCustom: Bux lift tiny soup can.',
      'main',
      'stanzas',
    )
    const assigned = await projectStore.assignStillCastImages({ lineIds: imported.manifest.lines.map((line) => line.id) })
    expect(assigned.manifest.lines[0]?.stillBeats?.[0]?.imagePath).toMatch(/^stills\/001\//)
    expect(assigned.manifest.lines[1]?.stillBeats?.[0]?.expression).toBe('custom')
    expect(assigned.manifest.lines[1]?.stillBeats?.[0]?.imagePath).toMatch(/^stills\/002\//)
  })

  it('lets a line switch from a Custom still to an expression folder', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-set-expression-'))
    temporaryDirectories.push(directory)
    const library = path.join(directory, 'Expressions')
    await fs.mkdir(path.join(library, 'Warm Smile'), { recursive: true })
    await fs.writeFile(path.join(library, 'Warm Smile', 'smile.png'), Buffer.from('smile-still'))
    await fs.mkdir(path.join(directory, 'Custom'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Custom', 'One hundred dollars.png'), Buffer.from('custom-still'))

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('One hundred dollars.', 'main', 'stanzas')
    const line = imported.manifest.lines[0]!
    await projectStore.assignStillCastImages({ libraryPath: library, lineIds: [line.id] })

    const changed = await projectStore.setStillCastExpression({
      libraryPath: library,
      lineId: line.id,
      expression: 'Warm Smile',
    })
    const saved = changed.manifest.lines[0]!
    expect(saved.stillBeats?.[0]?.expression).toBe('warm-smile')
    expect(saved.stillBeats?.[0]?.imagePath).toMatch(/^stills\/001\//)
    const copied = await fs.readFile(path.join(directory, saved.stillBeats![0]!.imagePath!))
    expect(copied.toString()).toBe('smile-still')
  })

  it('assigns prefixed expression stills on import and leaves Custom lines waiting', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-prefix-import-'))
    temporaryDirectories.push(directory)
    const library = path.join(directory, 'Expressions')
    await fs.mkdir(path.join(library, 'Warm Smile'), { recursive: true })
    await fs.writeFile(path.join(library, 'Warm Smile', 'smile.png'), Buffer.from('smile-still'))
    await fs.mkdir(path.join(library, 'Confident'), { recursive: true })
    await fs.writeFile(path.join(library, 'Confident', 'confident.png'), Buffer.from('confident-still'))
    await fs.mkdir(path.join(library, 'Excited'), { recursive: true })
    await fs.writeFile(path.join(library, 'Excited', 'excited.png'), Buffer.from('excited-still'))
    await fs.mkdir(path.join(library, 'Neutral Talking'), { recursive: true })
    await fs.writeFile(path.join(library, 'Neutral Talking', 'talk.png'), Buffer.from('talk-still'))

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText(
      [
        'Custom: Bux look at wallet.',
        'Custom: One hundred dollars.',
        'Warm Smile: Beautiful.',
        '',
        'Confident: Powerful.',
        'Excited: Crisp.',
      ].join('\n'),
      'main',
      'stanzas',
      library,
    )

    expect(imported.manifest.lines.map((line) => line.text)).toEqual([
      'Bux look at wallet.',
      'One hundred dollars.',
      'Beautiful.',
      'Powerful.',
      'Crisp.',
    ])
    expect(imported.manifest.lines.map((line) => line.stillBeats?.[0]?.expression)).toEqual([
      'custom',
      'custom',
      'warm-smile',
      'confident',
      'excited',
    ])
    expect(imported.manifest.lines[0]?.imagePath).toBeUndefined()
    expect(imported.manifest.lines[1]?.imagePath).toBeUndefined()
    expect(imported.manifest.lines[2]?.imagePath).toMatch(/^stills\/003\//)
    expect(imported.manifest.lines[3]?.imagePath).toMatch(/^stills\/004\//)
    expect(imported.manifest.lines[4]?.imagePath).toMatch(/^stills\/005\//)
    await expect(fs.readFile(path.join(directory, 'script.txt'), 'utf8')).resolves.toContain(
      'Custom: Bux look at wallet.',
    )
  })

  it('assigns a Custom prefix once a matching Custom image exists', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-custom-prefix-'))
    temporaryDirectories.push(directory)
    const library = path.join(directory, 'Expressions')
    await fs.mkdir(path.join(library, 'Neutral Talking'), { recursive: true })
    await fs.writeFile(path.join(library, 'Neutral Talking', 'talk.png'), Buffer.from('talk-still'))
    await fs.mkdir(path.join(directory, 'Custom'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Custom', 'Bux look at wallet.png'), Buffer.from('wallet-still'))

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText(
      'Custom: Bux look at wallet.',
      'main',
      'stanzas',
      library,
    )

    expect(imported.manifest.lines[0]?.text).toBe('Bux look at wallet.')
    expect(imported.manifest.lines[0]?.stillBeats?.[0]?.expression).toBe('custom')
    expect(imported.manifest.lines[0]?.imagePath).toMatch(/^stills\/001\//)
    const copied = await fs.readFile(path.join(directory, imported.manifest.lines[0]!.imagePath!))
    expect(copied.toString()).toBe('wallet-still')
  })

  it('keeps a newer video idea when a stale project save finishes later', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-video-idea-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    const opened = await projectStore.open(directory)
    const stale = structuredClone(opened.manifest)
    const idea = emptyVideoIdeaSession('inflation')
    idea.updatedAt = '2026-09-12T12:00:00.000Z'
    idea.phase = 'demand'
    idea.idea.subject = 'Inflation'
    const withIdea = structuredClone(opened.manifest)
    withIdea.videoIdea = idea
    await projectStore.save(withIdea)

    stale.lines = opened.manifest.lines
    await projectStore.save(stale)

    expect(projectStore.get()!.manifest.videoIdea?.idea.subject).toBe('Inflation')
    expect(projectStore.get()!.manifest.videoIdea?.seed).toBe('inflation')
  })

  it('persists the script creator draft across reopen', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-script-draft-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    await projectStore.saveScriptCreator({
      topic: 'Why money loses value',
      draft: 'Custom: Bux look at wallet.\n\nConfident: Bux feel rich.',
    })
    await projectStore.close()

    const reopened = await projectStore.open(directory)
    expect(reopened.scriptCreator).toEqual({
      topic: 'Why money loses value',
      draft: 'Custom: Bux look at wallet.\n\nConfident: Bux feel rich.',
    })
    await expect(fs.readFile(path.join(directory, 'draft-script.txt'), 'utf8')).resolves.toContain(
      'Bux look at wallet.',
    )
  })

  it('persists a known script source, preserves it on partial saves, and ignores malformed metadata', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-script-source-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    const opened = await projectStore.open(directory)
    const source = { topic: 'How budgets work', bible: 'Narrate simply.\nUse short scenes.' }
    await projectStore.saveScriptCreator({
      topic: source.topic,
      draft: 'A generated narration draft.',
      source,
      expectedProjectId: opened.manifest.id,
      expectedRootPath: opened.rootPath,
    })
    await projectStore.saveScriptCreator({ draft: 'A manually edited narration draft.' })

    await projectStore.close()
    const reopened = await projectStore.open(directory)
    expect(reopened.scriptCreator).toEqual({
      topic: source.topic,
      draft: 'A manually edited narration draft.',
      source,
    })

    await fs.writeFile(path.join(directory, 'draft-source.json'), '{broken', 'utf8')
    await projectStore.close()
    const legacy = await projectStore.open(directory)
    expect(legacy.scriptCreator).toEqual({
      topic: source.topic,
      draft: 'A manually edited narration draft.',
    })
  })

  it('rejects a script draft save targeted at a different project', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-script-source-guard-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    const opened = await projectStore.open(directory)
    await expect(
      projectStore.saveScriptCreator({
        topic: 'wrong project',
        expectedProjectId: 'another-project',
        expectedRootPath: opened.rootPath,
      }),
    ).rejects.toThrow('The project changed before the script draft could be saved.')
    expect(projectStore.get()?.scriptCreator).toEqual({ topic: '', draft: '' })
  })

  it('updates the project name when the folder was renamed on disk', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-rename-parent-'))
    temporaryDirectories.push(parent)
    const original = path.join(parent, 'New folder')
    await fs.mkdir(original)

    const projectStore = new ProjectStore()
    await projectStore.open(original)
    expect(projectStore.get()?.manifest.name).toBe('New folder')
    await projectStore.close()

    const renamed = path.join(parent, 'How to Get Stronger at Home Without Weights')
    await fs.rename(original, renamed)
    const reopened = await projectStore.open(renamed)
    expect(reopened.manifest.name).toBe('How to Get Stronger at Home Without Weights')
    const persisted = JSON.parse(await fs.readFile(path.join(renamed, 'higgsfilm.json'), 'utf8')) as {
      name: string
    }
    expect(persisted.name).toBe('How to Get Stronger at Home Without Weights')
  })

  it('asks you to choose the folder again if it was moved while open', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-moved-project-'))
    temporaryDirectories.push(directory)

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    await fs.rm(directory, { recursive: true, force: true })

    await expect(
      projectStore.saveScriptCreator({
        topic: 'Why money loses value',
        draft: 'Custom: Bux look at wallet.',
      }),
    ).rejects.toThrow('The project folder is missing. It may have been moved or renamed. Choose the folder again.')
  })
})
