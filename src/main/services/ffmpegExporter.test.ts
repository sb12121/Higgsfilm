import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import {
  FfmpegExporter,
  dialogueNormalizeGainDb,
  parseVolumeDetect,
  speechWindowFromSilence,
} from './ffmpegExporter'
import { ProjectStore } from './projectStore'
import { VOICE_BOUNDARY_SAMPLE_RATE } from './voiceTakeCleanup'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

const temporaryDirectories: string[] = []
const finalConcatOrders: string[][] = []
const spawnMock = vi.mocked(spawn)
let segmentGate: Promise<void> | null = null
let releaseSegment: (() => void) | null = null
let segmentStartedResolve: (() => void) | null = null

function installFfmpegMock(): void {
  spawnMock.mockImplementation((_executable, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    })
    const argumentList = (args as string[]).map(String)
    const outputPath = argumentList[argumentList.length - 1] || ''
    const isMeasurePass =
      argumentList.includes('-vn') &&
      argumentList.includes('null') &&
      argumentList.some((argument) => argument.includes('print_format=json'))
    const isSilenceDetectPass = argumentList.some((argument) =>
      argument.includes('silencedetect='),
    )
    const isVolumeDetectPass = argumentList.some((argument) =>
      argument.includes('volumedetect'),
    )
    const isPcmDecode = argumentList.includes('s16le')

    void (async () => {
      try {
        if (isPcmDecode) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          const input = argumentList[argumentList.indexOf('-i') + 1] || ''
          const source = await fs.readFile(input).catch(() => Buffer.alloc(0))
          const duration = source.includes(Buffer.from('long-voice')) || input.includes('scenes\\003\\') ? 6 : 2
          const pcm = Buffer.alloc(duration * VOICE_BOUNDARY_SAMPLE_RATE * 2)
          for (let i = 0; i < duration * VOICE_BOUNDARY_SAMPLE_RATE; i++) {
            const time = i / VOICE_BOUNDARY_SAMPLE_RATE
            const amplitude = time >= 0.16 && time < (duration === 6 ? 5.89 : 0.89) ? 0.035 : 0.0015
            pcm.writeInt16LE(Math.round(32767 * amplitude * Math.sin(i * 0.37)), i * 2)
          }
          child.stdout.emit('data', pcm)
          child.emit('close', 0)
          return
        }
        if (argumentList.includes('format=duration')) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          child.emit('close', 1)
          return
        }

        if (isSilenceDetectPass) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          // Omit Duration so cleanup falls back to the recorded line duration.
          // Only leading silence is reported so soft onsets get a fixed lead-in.
          child.stderr.emit(
            'data',
            Buffer.from(
              [
                '[silencedetect @ 0] silence_start: 0',
                '[silencedetect @ 0] silence_end: 0.35 | silence_duration: 0.35',
              ].join('\n'),
            ),
          )
          child.emit('close', 0)
          return
        }

        if (isVolumeDetectPass) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          child.stderr.emit(
            'data',
            Buffer.from(
              [
                '[Parsed_volumedetect_0 @ 0] n_samples: 48000',
                '[Parsed_volumedetect_0 @ 0] mean_volume: -22.00 dB',
                '[Parsed_volumedetect_0 @ 0] max_volume: -6.00 dB',
              ].join('\n'),
            ),
          )
          child.emit('close', 0)
          return
        }

        if (isMeasurePass) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          child.stderr.emit(
            'data',
            Buffer.from(
              [
                'Ignored loudnorm preface',
                JSON.stringify({
                  input_i: '-18.50',
                  input_tp: '-3.20',
                  input_lra: '7.10',
                  input_thresh: '-28.40',
                  target_offset: '2.50',
                }),
                'Ignored loudnorm epilogue',
              ].join('\n'),
            ),
          )
          child.emit('close', 0)
          return
        }

        const isNullProbe =
          argumentList.includes('-f') &&
          argumentList.includes('null') &&
          !isSilenceDetectPass &&
          !isVolumeDetectPass &&
          !isMeasurePass
        if (isNullProbe) {
          await new Promise<void>((resolve) => setImmediate(resolve))
          child.stderr.emit(
            'data',
            Buffer.from('Duration: 00:00:00.80, start: 0.000000, bitrate: 128 kb/s'),
          )
          child.emit('close', 0)
          return
        }

        if (argumentList.includes('copy')) {
          const inputIndex = argumentList.indexOf('-i')
          const concatPath = argumentList[inputIndex + 1] || ''
          if (concatPath.endsWith('.concat.txt')) {
            const concatContents = await fs.readFile(concatPath, 'utf8')
            finalConcatOrders.push(concatContents.split(/\r?\n/).filter(Boolean))
          }
        } else if (segmentGate && argumentList.includes('libx264')) {
          segmentStartedResolve?.()
          await segmentGate
          segmentGate = null
        }

        await fs.mkdir(path.dirname(outputPath), { recursive: true })
        await fs.writeFile(outputPath, Buffer.from(`rendered:${path.basename(outputPath)}`))
        child.emit('close', 0)
      } catch (error: unknown) {
        child.stderr.emit('data', Buffer.from(String(error)))
        child.emit('close', 1)
      }
    })()

    return child as unknown as ReturnType<typeof spawn>
  })
}

async function createReadyProject(sceneCount = 1): Promise<{
  directory: string
  projectStore: ProjectStore
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-exporter-'))
  temporaryDirectories.push(directory)

  const projectStore = new ProjectStore()
  await projectStore.open(directory)
  const script = Array.from({ length: sceneCount }, (_, index) => `Scene ${index + 1} happens here.`).join(' ')
  const imported = await projectStore.importScriptText(script)

  for (const line of imported.manifest.lines) {
    await projectStore.saveImage(line.id, Buffer.from(`image-${line.id}`), 'png')
    const voice = new Uint8Array(Buffer.from(`voice-${line.id}`))
    await projectStore.saveRecording({
      lineId: line.id,
      data: voice.buffer,
      duration: 1,
      mimeType: 'audio/wav',
    })
  }

  return { directory, projectStore }
}

afterEach(async () => {
  spawnMock.mockReset()
  finalConcatOrders.length = 0
  segmentGate = null
  releaseSegment?.()
  releaseSegment = null
  segmentStartedResolve = null
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

function spawnArgsList(): string[][] {
  return spawnMock.mock.calls.map((call) => (call[1] as string[]).map(String))
}

function isSilenceDetectArgs(args: string[]): boolean {
  return args.includes('s16le')
}

function isVolumeDetectArgs(args: string[]): boolean {
  return args.some((argument) => argument.includes('volumedetect'))
}

function isSegmentEncodeArgs(args: string[]): boolean {
  return args.includes('libx264')
}

function isProgramMeasureArgs(args: string[]): boolean {
  return (
    args.includes('-vn') &&
    args.includes('null') &&
    args.some((argument) => argument.includes('print_format=json'))
  )
}

function isProgramEncodeArgs(args: string[]): boolean {
  return args.includes('copy') && args.includes('aac')
}

function isProgramNormalizeArgs(args: string[]): boolean {
  return (
    args.includes('copy') &&
    args.includes('pcm_s16le') &&
    args.includes('-avoid_negative_ts') &&
    args.some((argument) => argument.endsWith('.mov'))
  )
}

describe('FfmpegExporter', () => {
  it('reuses a cached segment and invalidates it when an asset changes', async () => {
    installFfmpegMock()
    const { directory, projectStore } = await createReadyProject()
    const exporter = new FfmpegExporter(projectStore)

    await exporter.exportLongform(path.join(directory, 'exports', 'first.mp4'))
    const firstPass = spawnArgsList()
    expect(firstPass.filter(isSilenceDetectArgs)).toHaveLength(1)
    expect(firstPass.filter(isVolumeDetectArgs)).toHaveLength(1)
    expect(firstPass.filter(isSegmentEncodeArgs)).toHaveLength(1)
    expect(firstPass.filter(isProgramNormalizeArgs)).toHaveLength(1)
    expect(firstPass.filter(isProgramMeasureArgs)).toHaveLength(1)
    expect(firstPass.filter(isProgramEncodeArgs)).toHaveLength(1)

    const segmentArgs = firstPass.find(isSegmentEncodeArgs)!
    expect(segmentArgs).toEqual(
      expect.arrayContaining(['-c:a', 'flac', '-vf', expect.stringContaining('scale=3840:2160')]),
    )
    expect(segmentArgs).toEqual(
      expect.arrayContaining(['-vf', expect.stringContaining('flags=lanczos')]),
    )
    expect(segmentArgs).not.toEqual(
      expect.arrayContaining(['-vf', expect.stringContaining('eval=frame')]),
    )
    const normalizeArgs = firstPass.find(isProgramNormalizeArgs)!
    expect(normalizeArgs).toEqual(
      expect.arrayContaining(['-c:a', 'pcm_s16le', '-avoid_negative_ts', 'make_zero']),
    )
    expect(normalizeArgs.at(-1)).toMatch(/\.mov$/)
    const measureArgs = firstPass.find(isProgramMeasureArgs)!
    expect(measureArgs).toEqual(expect.arrayContaining(['-vn', '-f', 'null']))
    expect(measureArgs).toEqual(
      expect.arrayContaining([
        '-af',
        expect.stringContaining('highpass=f=80'),
      ]),
    )
    expect(measureArgs).toEqual(
      expect.arrayContaining([
        '-af',
        expect.stringContaining('print_format=json'),
      ]),
    )
    const programArgs = firstPass.find(isProgramEncodeArgs)!
    expect(programArgs).toEqual(
      expect.arrayContaining(['-c:v', 'copy', '-c:a', 'aac', '-b:a', '384k']),
    )
    expect(programArgs).toEqual(
      expect.arrayContaining([
        '-af',
        expect.stringContaining('measured_I=-18.50'),
      ]),
    )

    await exporter.exportLongform(path.join(directory, 'exports', 'second.mp4'))
    expect(spawnArgsList().filter(isSegmentEncodeArgs)).toHaveLength(1)

    const line = projectStore.getManifest().lines[0]
    await projectStore.saveImage(line.id, Buffer.from('replacement-image'), 'png')
    await exporter.exportLongform(path.join(directory, 'exports', 'third.mp4'))

    expect(spawnArgsList().filter(isSegmentEncodeArgs)).toHaveLength(2)

    const replacementVoice = new Uint8Array(Buffer.from('replacement-voice'))
    await projectStore.saveRecording({
      lineId: line.id,
      data: replacementVoice.buffer,
      duration: 1,
      mimeType: 'audio/wav',
    })
    await exporter.exportLongform(path.join(directory, 'exports', 'fourth.mp4'))

    expect(spawnArgsList().filter(isSegmentEncodeArgs)).toHaveLength(3)
    const cacheFiles = await fs.readdir(path.join(directory, '.higgsfilm-render-cache'))
    expect(cacheFiles.filter((file) => file.endsWith('.mkv'))).toHaveLength(3)
    expect(cacheFiles.some((file) => file.startsWith('main-program-') && file.endsWith('.mp4'))).toBe(true)
  })

  it('pauses background encodes while a microphone session is active', async () => {
    installFfmpegMock()
    const { directory, projectStore } = await createReadyProject()
    const exporter = new FfmpegExporter(projectStore)
    exporter.setPreRenderPaused(true)

    const line = projectStore.getManifest().lines[0]
    await projectStore.saveRecording({
      lineId: line.id,
      data: new Uint8Array(Buffer.from('rerecord-voice')).buffer,
      duration: 1,
      mimeType: 'audio/wav',
    })
    spawnMock.mockClear()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(spawnMock).not.toHaveBeenCalled()

    exporter.setPreRenderPaused(false)
    await exporter.exportLongform(path.join(directory, 'exports', 'after-pause.mp4'))
    expect(spawnMock.mock.calls.length).toBeGreaterThan(0)
  })

  it('deduplicates concurrent renders and preserves manifest ordering', async () => {
    installFfmpegMock()
    const { directory, projectStore } = await createReadyProject(2)
    const exporter = new FfmpegExporter(projectStore)

    const firstLine = projectStore.getManifest().lines[0]
    const secondLine = projectStore.getManifest().lines[1]
    const firstExport = exporter.exportLongform(path.join(directory, 'exports', 'first.mp4'))
    const secondExport = exporter.exportLongform(path.join(directory, 'exports', 'second.mp4'))
    await Promise.all([firstExport, secondExport])

    expect(spawnArgsList().filter(isSilenceDetectArgs)).toHaveLength(2)
    expect(spawnArgsList().filter(isSegmentEncodeArgs)).toHaveLength(2)
    expect(finalConcatOrders).toHaveLength(1)
    for (const order of finalConcatOrders) {
      expect(order[0]).toContain(firstLine.id)
      expect(order[1]).toContain(secondLine.id)
    }
  })

  it('waits for an in-progress background pre-render during export', async () => {
    installFfmpegMock()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-export-wait-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A scene is recorded.')
    const line = imported.manifest.lines[0]
    const exporter = new FfmpegExporter(projectStore)

    await projectStore.saveImage(line.id, Buffer.from('image'), 'png')
    const started = new Promise<void>((resolve) => {
      segmentStartedResolve = resolve
    })
    segmentGate = new Promise<void>((resolve) => {
      releaseSegment = resolve
    })
    const voice = new Uint8Array(Buffer.from('voice'))
    await projectStore.saveRecording({
      lineId: line.id,
      data: voice.buffer,
      duration: 1,
      mimeType: 'audio/wav',
    })
    await started

    let exportFinished = false
    const exportPromise = exporter
      .exportLongform(path.join(directory, 'exports', 'waited.mp4'))
      .then((result) => {
        exportFinished = true
        return result
      })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(exportFinished).toBe(false)

    releaseSegment?.()
    await exportPromise
    expect(spawnArgsList().filter(isSegmentEncodeArgs)).toHaveLength(1)
    expect(spawnArgsList().filter(isProgramEncodeArgs)).toHaveLength(1)
  })

  it('renders and exports trailer scenes with independent vertical settings', async () => {
    installFfmpegMock()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-trailer-export-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText(
      'A vertical hook grabs attention. See the full video to learn more.',
      'trailer',
    )
    for (const trailerLine of imported.manifest.trailer!.lines) {
      await projectStore.saveImage(trailerLine.id, Buffer.from('trailer-image'), 'png', 'trailer')
      const saved = projectStore
        .getManifest()
        .trailer!.lines.find((line) => line.id === trailerLine.id)
      if (saved?.stillBeats?.[0] && saved.imagePath) {
        saved.stillBeats[0].imagePath = saved.imagePath
      }
      await projectStore.saveRecording({
        lineId: trailerLine.id,
        sequence: 'trailer',
        data: new Uint8Array(Buffer.from('trailer-voice')).buffer,
        duration: 1,
        mimeType: 'audio/wav',
      })
    }

    const exporter = new FfmpegExporter(projectStore)
    await exporter.exportLongform(path.join(directory, 'exports', 'trailer.mp4'), 'trailer')

    expect(spawnArgsList().filter(isSilenceDetectArgs)).toHaveLength(2)
    expect(spawnArgsList().filter(isSegmentEncodeArgs)).toHaveLength(2)
    expect(spawnArgsList().find(isSegmentEncodeArgs)).toEqual(
      expect.arrayContaining(['-c:a', 'flac', '-vf', expect.stringContaining('scale=2160:3840')]),
    )
    const cacheFiles = await fs.readdir(path.join(directory, '.higgsfilm-render-cache'))
    expect(cacheFiles.some((file) => file.startsWith('trailer-') && file.endsWith('.mkv'))).toBe(true)
  })

  it('adds motion effects only to scenes longer than five seconds', async () => {
    installFfmpegMock()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-motion-export-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A long visual moment unfolds.')
    const line = imported.manifest.lines[0]
    await projectStore.saveImage(line.id, Buffer.from('long-image'), 'png')
    await projectStore.saveRecording({
      lineId: line.id,
      data: new Uint8Array(Buffer.from('long-voice')).buffer,
      duration: 6,
      mimeType: 'audio/wav',
    })

    const exporter = new FfmpegExporter(projectStore)
    await exporter.exportLongform(path.join(directory, 'exports', 'motion.mp4'))

    const ffmpegArgs = spawnArgsList().find(isSegmentEncodeArgs)!
    expect(ffmpegArgs).toEqual(expect.arrayContaining(['-framerate', '30']))
    expect(ffmpegArgs).toEqual(expect.arrayContaining(['-vf', expect.stringContaining('eval=frame')]))
    expect(ffmpegArgs).not.toEqual(expect.arrayContaining(['-vf', expect.stringContaining('zoompan')]))
    const motionFilter = ffmpegArgs.find((argument) => argument.includes('eval=frame'))
    expect(motionFilter).toMatch(/t\/6/)
    expect(motionFilter).toContain('1+(1.12-1)*')
    expect(motionFilter).toContain('0.5-0.5*cos(PI*')
    expect(motionFilter).toContain('3840:2160')
    expect(motionFilter).toContain('flags=lanczos')
    expect(motionFilter).toContain('scale=w=')
    expect(motionFilter).not.toMatch(/crop=w=/)
  })

  it('pans long scenes on a high-resolution canvas instead of pixel-stepping zoompan', async () => {
    installFfmpegMock()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-pan-export-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('First beat. Second beat. A long panning visual unfolds.')
    for (const line of imported.manifest.lines) {
      await projectStore.saveImage(line.id, Buffer.from(`image-${line.id}`), 'png')
      await projectStore.saveRecording({
        lineId: line.id,
        data: new Uint8Array(Buffer.from(`voice-${line.id}`)).buffer,
        duration: line.index === 2 ? 6 : 1,
        mimeType: 'audio/wav',
      })
    }

    const exporter = new FfmpegExporter(projectStore)
    await exporter.exportLongform(path.join(directory, 'exports', 'pan.mp4'))

    const panCall = spawnMock.mock.calls.find((call) =>
      (call[1] as string[]).some(
        (argument) =>
          argument.includes('1.06') &&
          argument.includes('trunc((iw-3840)*') &&
          !argument.includes('silencedetect'),
      ),
    )
    expect(panCall).toBeTruthy()
    const panFilter = (panCall?.[1] as string[]).find((argument) => argument.includes('trunc((iw-3840)*'))
    expect(panFilter).toContain('1.06')
    expect(panFilter).not.toContain('zoompan')
    expect(panFilter).not.toContain('crop=w=')
  })

  it('keeps expression stills static even on long recorded lines', async () => {
    installFfmpegMock()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-still-cast-static-'))
    temporaryDirectories.push(directory)
    const library = path.join(directory, 'Expressions')
    await fs.mkdir(path.join(library, 'Warm Smile'), { recursive: true })
    await fs.writeFile(path.join(library, 'Warm Smile', 'smile.png'), Buffer.from('smile-still'))

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText(
      'Warm Smile: A long talking-head beat stays locked on the face.',
      'main',
      'stanzas',
      library,
    )
    const line = imported.manifest.lines[0]!
    expect(line.stillBeats?.[0]?.imagePath).toBeTruthy()
    await projectStore.saveRecording({
      lineId: line.id,
      data: new Uint8Array(Buffer.from('long-voice')).buffer,
      duration: 6,
      mimeType: 'audio/wav',
    })

    const exporter = new FfmpegExporter(projectStore)
    await exporter.exportLongform(path.join(directory, 'exports', 'still-cast.mp4'))

    const ffmpegArgs = spawnArgsList().find(isSegmentEncodeArgs)!
    expect(ffmpegArgs).toEqual(
      expect.arrayContaining([
        '-vf',
        'scale=3840:2160:force_original_aspect_ratio=decrease:flags=lanczos,pad=3840:2160:(ow-iw)/2:(oh-ih)/2:white,setsar=1',
      ]),
    )
    expect(ffmpegArgs.join(' ')).not.toContain('eval=frame')
    expect(ffmpegArgs.join(' ')).not.toContain('1.12')
    expect(ffmpegArgs.join(' ')).not.toContain('1.06')
  })

  it('cleans dead air on save and uses the cleaned take at export', async () => {
    installFfmpegMock()
    const { directory, projectStore } = await createReadyProject(2)
    const lines = projectStore.getManifest().lines
    expect(lines[0]?.voiceCleanupVersion).toBe(2)
    expect(lines[0]?.voiceRawPath).toMatch(/^scenes\/001\/voice-raw\.wav$/)
    expect(lines[0]?.voicePath).toMatch(/^scenes\/001\/voice\.flac$/)
    expect(lines[0]?.voiceTrimStart).toBeCloseTo(0.14, 3)
    expect(lines[0]?.voiceTrimEnd).toBeCloseTo(1.01, 3)

    const exporter = new FfmpegExporter(projectStore)
    await exporter.exportLongform(path.join(directory, 'exports', 'snappy.mp4'))

    const cleanupCalls = spawnMock.mock.calls.filter((call) => {
      const args = (call[1] as string[]).map(String)
      return args.some((arg) => arg.startsWith('atrim=start=0.14:end=1.01,asetpts=PTS-STARTPTS,apad=pad_dur=0.15'))
    })
    expect(cleanupCalls).toHaveLength(2)

    const segmentCalls = spawnMock.mock.calls.filter((call) =>
      (call[1] as string[]).includes('libx264'),
    )
    expect(segmentCalls).toHaveLength(2)

    const firstArgs = segmentCalls[0]?.[1] as string[]
    const secondArgs = segmentCalls[1]?.[1] as string[]
    const firstAudio = firstArgs.find((argument) => argument.includes('volume='))
    const secondAudio = secondArgs.find((argument) => argument.includes('volume='))

    expect(firstAudio).toBe('volume=4.5dB')
    expect(firstAudio).not.toContain('atrim=')
    expect(firstAudio).not.toContain('adelay=')
    expect(secondAudio).toBe('volume=4.5dB')
    expect(secondArgs.filter((arg) => arg === '-i')).toHaveLength(2)
    expect(firstArgs).toEqual(expect.arrayContaining(['-shortest']))
    expect(secondArgs).toEqual(expect.arrayContaining(['-shortest']))
  })

  it('keeps version 1 cleaned audio and its previous-still cue timing', async () => {
    installFfmpegMock()
    const { directory, projectStore } = await createReadyProject(2)
    const manifest = projectStore.getManifest()
    manifest.lines[1]!.voiceCleanupVersion = 1
    await projectStore.save(manifest)
    spawnMock.mockClear()

    await new FfmpegExporter(projectStore).exportLongform(path.join(directory, 'exports', 'legacy.mp4'))
    const segments = spawnArgsList().filter(isSegmentEncodeArgs)
    const legacy = segments.find((args) => args.filter((arg) => arg === '-i').length === 3)
    expect(legacy).toBeTruthy()
    expect(legacy?.join(' ')).not.toContain('silencedetect')
    expect(legacy?.join(' ')).not.toContain('atrim=')
    expect(legacy).toEqual(expect.arrayContaining(['-t', '0.1']))
  })

  it('re-trims a cleaned take from raw without re-atrimming at export', async () => {
    installFfmpegMock()
    const { directory, projectStore } = await createReadyProject()
    const line = projectStore.getManifest().lines[0]!
    const previousVersion = line.voiceAssetVersion

    spawnMock.mockClear()
    await projectStore.trimVoiceTake({
      lineId: line.id,
      trimEndSeconds: 0.8,
    })

    const trimmed = projectStore.getManifest().lines[0]!
    expect(trimmed.voiceTrimStart).toBeCloseTo(0.14, 3)
    expect(trimmed.voiceTrimEnd).toBeCloseTo(0.8, 3)
    expect(trimmed.duration).toBe(0.91)
    expect(trimmed.voiceCleanupVersion).toBe(2)
    expect(trimmed.voiceRawPath).toMatch(/voice-raw\.wav$/)
    expect(trimmed.voiceAssetVersion).toBeTruthy()
    expect(trimmed.voiceAssetVersion).not.toBe(previousVersion)

    const rewriteFilters = spawnMock.mock.calls
      .map((call) => (call[1] as string[]).map(String))
      .filter((args) => args.some((argument) => argument.includes('atrim=start=0.14:end=0.8')))
    expect(rewriteFilters.length).toBeGreaterThan(0)

    spawnMock.mockClear()
    await projectStore.trimVoiceTake({
      lineId: line.id,
      trimStartSeconds: 0.3,
      trimEndSeconds: 0.8,
    })
    expect(projectStore.getManifest().lines[0]?.voiceTrimStart).toBeCloseTo(0.3, 3)
    expect(projectStore.getManifest().lines[0]?.voiceTrimEnd).toBeCloseTo(0.8, 3)

    spawnMock.mockClear()
    const exporter = new FfmpegExporter(projectStore)
    await exporter.exportLongform(path.join(directory, 'exports', 'trimmed.mp4'))

    const segmentCalls = spawnMock.mock.calls.filter((call) =>
      (call[1] as string[]).includes('libx264'),
    )
    expect(segmentCalls).toHaveLength(1)
    const audioFilter = (segmentCalls[0]?.[1] as string[]).find((argument) =>
      argument.includes('volume='),
    )
    expect(audioFilter).toBe('volume=4.5dB')
    expect(audioFilter).not.toContain('atrim=')
  })

  it('matches quiet and loud takes to the same dialogue level without clipping', () => {
    expect(dialogueNormalizeGainDb(-22, -6)).toBe(4.5)
    expect(dialogueNormalizeGainDb(-10, -0.2)).toBe(-6)
    expect(dialogueNormalizeGainDb(-40, -20)).toBe(16)
    expect(dialogueNormalizeGainDb(-8, 0)).toBe(-8)
    expect(dialogueNormalizeGainDb(-15, 3)).toBe(-4.5)
    expect(
      parseVolumeDetect(
        '[Parsed_volumedetect_0 @ 0] mean_volume: -22.00 dB\n[Parsed_volumedetect_0 @ 0] max_volume: -6.00 dB',
      ),
    ).toEqual({ meanVolumeDb: -22, maxVolumeDb: -6 })
  })

  it('backs up from detected speech onset so soft consonants stay intact', () => {
    const window = speechWindowFromSilence(
      [
        { start: 0, end: 0.4 },
        { start: 2.5, end: null },
      ],
      3,
      0.2,
      0.1,
    )
    expect(window.trimStart).toBeCloseTo(0.2, 3)
    expect(window.trimEnd).toBeCloseTo(2.6, 3)
  })

  it('keeps cache keys stable when only file mtime changes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-cache-stable-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('A stable cache scene.')
    const line = imported.manifest.lines[0]!
    await projectStore.saveImage(line.id, Buffer.from('stable-image-bytes'), 'png')
    await projectStore.saveRecording({
      lineId: line.id,
      data: new Uint8Array(Buffer.from('stable-voice-bytes')).buffer,
      duration: 1,
      mimeType: 'audio/wav',
    })

    installFfmpegMock()
    const exporter = new FfmpegExporter(projectStore)
    await exporter.exportLongform(path.join(directory, 'exports', 'first.mp4'))
    const encodeCalls = spawnMock.mock.calls.filter((call) => (call[1] as string[]).includes('libx264'))
    expect(encodeCalls).toHaveLength(1)

    const imagePath = path.join(directory, projectStore.getManifest().lines[0]!.imagePath!)
    const voicePath = path.join(directory, projectStore.getManifest().lines[0]!.voicePath!)
    const future = new Date(Date.now() + 60_000)
    await fs.utimes(imagePath, future, future)
    await fs.utimes(voicePath, future, future)

    spawnMock.mockClear()
    installFfmpegMock()
    await exporter.exportLongform(path.join(directory, 'exports', 'second.mp4'))
    const reencodeCalls = spawnMock.mock.calls.filter((call) => (call[1] as string[]).includes('libx264'))
    expect(reencodeCalls).toHaveLength(0)
  })
})
