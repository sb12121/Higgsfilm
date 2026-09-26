import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_TRAILER_EXPORT_SETTINGS,
  type ExportResult,
  type ExportSettings,
  type ProjectState,
  type ScriptLine,
  type SequenceId,
  type SequenceManifest,
} from '../../shared/types'
import {
  expressionPlaybackBeats,
  lineHasStillCastBeats,
  lineStillCastImagesReady,
  stillBeatDurations,
} from '../../shared/stillCast'
import { logGeneration, logGenerationError } from './generationLogger'
import { ProjectStore } from './projectStore'
import { containPadFilter } from './stillCastReframe'
import {
  SCENE_END_PADDING_SECONDS,
  SCENE_START_PADDING_SECONDS,
  SPEECH_DETECT_MIN_SECONDS,
  SPEECH_DETECT_NOISE,
  SPEECH_LEAD_SECONDS,
  SPEECH_TRAIL_SECONDS,
  VOICE_CLEANUP_VERSION,
  parseMediaDurationSeconds,
  parseSilencePeriods,
  probeMediaDurationSeconds,
  speechWindowFromSilence,
  type SpeechWindow,
} from './voiceTakeCleanup'

interface FfmpegResult {
  stdout: string
  stderr: string
}

// Mid-line pauses stay intact because we only cut once at each edge.
// New takes are cleaned on save (see voiceTakeCleanup). Export still
// supports legacy uncleaned voice files with the same speech window.
const FIRST_SCENE_START_PADDING_SECONDS = SCENE_START_PADDING_SECONDS
const RENDER_CACHE_DIRECTORY = '.higgsfilm-render-cache'
const RENDER_PIPELINE_VERSION = 'scene-segment-v28-concat-pcm'
const DIALOGUE_NORMALIZE_MEAN_DB = -16
const DIALOGUE_NORMALIZE_PEAK_DB = -1.5
const DIALOGUE_NORMALIZE_MAX_BOOST_DB = 16
const DIALOGUE_NORMALIZE_MAX_CUT_DB = 12
const ASSET_SAMPLE_BYTES = 64 * 1024
const MOTION_EFFECT_THRESHOLD_SECONDS = 5
const MOTION_ZOOM_MAX = 1.12
const MOTION_PAN_ZOOM = 1.06
const MOTION_WORK_SCALE = 2
const MOTION_MAX_WORK_EDGE = 3840
const PRE_RENDER_CONCURRENCY = 2
const SEGMENT_X264_PRESET = 'veryfast'
const PROGRAM_AAC_BITRATE = '384k'
const LOUDNORM_LRA = 11

interface LoudnormMeasurement {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

interface SceneCacheRequest {
  state: ProjectState
  line: ScriptLine
  position: number
  sequence: SequenceId
}

export class FfmpegExporter {
  private readonly renderJobs = new Map<string, Promise<string>>()
  private readonly pendingPreRenders = new Map<string, SceneCacheRequest>()
  private preRenderWorkerRunning = false
  private preRenderPaused = false
  private programPreRenderTimer: ReturnType<typeof setTimeout> | null = null
  private activeProjectId: string | null = null
  private encodeActive = 0
  private readonly encodeWaiters: Array<() => void> = []

  constructor(private readonly projectStore: ProjectStore) {
    projectStore.onChange((state) => {
      if (!state) {
        this.pendingPreRenders.clear()
        this.activeProjectId = null
        this.clearProgramPreRenderTimer()
        return
      }
      this.schedulePreRenders(state)
    })
  }

  setPreRenderPaused(paused: boolean): void {
    this.preRenderPaused = paused
    if (paused) {
      this.clearProgramPreRenderTimer()
      return
    }
    void this.drainPreRenderQueue()
  }

  async exportLongform(outputPath: string, sequence: SequenceId = 'main'): Promise<ExportResult> {
    const state = this.projectStore.get()
    if (!state) throw new Error('Open a project folder before exporting.')
    const sequenceManifest = sequenceManifestFromState(state, sequence)
    if (sequenceManifest.lines.length === 0) {
      throw new Error(`Create a ${sequence === 'trailer' ? '9:16 condensed' : 'longform'} script before exporting.`)
    }

    const unavailableLine = sequenceManifest.lines.find((line) => !lineStillCastImagesReady(line))
    if (unavailableLine) {
      throw new Error(
        `Finish generating ${sequence === 'trailer' ? '9:16 ' : ''}scene ${unavailableLine.index + 1} before exporting.`,
      )
    }

    const totalDuration = sequenceManifest.lines.reduce(
      (sum, line) => sum + Math.max(0.1, line.duration),
      0,
    )
    const cachedProgram = await this.ensureCachedProgram(state, sequence)
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.copyFile(cachedProgram, outputPath)
    return { outputPath, duration: Number(totalDuration.toFixed(2)) }
  }

  private schedulePreRenders(state: ProjectState): void {
    if (this.activeProjectId !== state.manifest.id) {
      this.pendingPreRenders.clear()
      this.activeProjectId = state.manifest.id
    }

    const eligibleKeys = new Set<string>()
    for (const sequence of ['main', 'trailer'] as SequenceId[]) {
      const sequenceManifest = sequenceManifestFromState(state, sequence)
      sequenceManifest.lines.forEach((line, position) => {
        if (!lineStillCastImagesReady(line) || !line.voicePath) return
        const key = `${state.manifest.id}:${sequence}:${line.id}`
        eligibleKeys.add(key)
        this.pendingPreRenders.set(key, {
          state,
          line,
          position,
          sequence,
        })
      })
    }
    for (const key of this.pendingPreRenders.keys()) {
      if (key.startsWith(`${state.manifest.id}:`) && !eligibleKeys.has(key)) {
        this.pendingPreRenders.delete(key)
      }
    }
    void this.drainPreRenderQueue()
  }

  private async drainPreRenderQueue(): Promise<void> {
    if (this.preRenderPaused || this.preRenderWorkerRunning) return
    this.preRenderWorkerRunning = true

    try {
      while (!this.preRenderPaused && this.pendingPreRenders.size > 0) {
        const batch = [...this.pendingPreRenders.entries()]
        this.pendingPreRenders.clear()
        await Promise.all(
          batch.map(async ([, request]) => {
            try {
              const cachePath = await this.ensureCachedSegment(
                request.state,
                sequenceManifestFromState(request.state, request.sequence),
                request.line,
                request.position,
                request.sequence,
              )
              logGeneration('Export', 'scene pre-render checked', {
                sequence: request.sequence,
                lineId: request.line.id,
                cachePath,
              })
            } catch (error) {
              logGenerationError('Export', 'scene pre-render failed', error, {
                sequence: request.sequence,
                lineId: request.line.id,
              })
            }
          }),
        )
      }
      if (!this.preRenderPaused) this.queueProgramPreRender()
    } finally {
      this.preRenderWorkerRunning = false
      if (!this.preRenderPaused && this.pendingPreRenders.size > 0) void this.drainPreRenderQueue()
    }
  }

  private clearProgramPreRenderTimer(): void {
    if (!this.programPreRenderTimer) return
    clearTimeout(this.programPreRenderTimer)
    this.programPreRenderTimer = null
  }

  private queueProgramPreRender(): void {
    this.clearProgramPreRenderTimer()
    this.programPreRenderTimer = setTimeout(() => {
      this.programPreRenderTimer = null
      if (this.preRenderPaused) return
      void this.preRenderReadyPrograms()
    }, 10_000)
    this.programPreRenderTimer.unref?.()
  }

  private async preRenderReadyPrograms(): Promise<void> {
    const state = this.projectStore.get()
    if (!state || state.manifest.id !== this.activeProjectId) return

    for (const sequence of ['main', 'trailer'] as SequenceId[]) {
      const sequenceManifest = sequenceManifestFromState(state, sequence)
      if (
        sequenceManifest.lines.length === 0 ||
        sequenceManifest.lines.some((line) => !lineStillCastImagesReady(line) || !line.voicePath)
      ) {
        continue
      }
      try {
        const cachePath = await this.ensureCachedProgram(state, sequence)
        logGeneration('Export', 'program pre-render ready', { sequence, cachePath })
      } catch (error) {
        logGenerationError('Export', 'program pre-render failed', error, { sequence })
      }
    }
  }

  private async ensureCachedProgram(state: ProjectState, sequence: SequenceId): Promise<string> {
    const sequenceManifest = sequenceManifestFromState(state, sequence)
    const fingerprints = await Promise.all(
      sequenceManifest.lines.map((line, position) =>
        this.segmentFingerprint(state, sequenceManifest, line, position, sequence),
      ),
    )
    const segmentPaths = await Promise.all(
      sequenceManifest.lines.map((line, position) =>
        this.ensureCachedSegment(state, sequenceManifest, line, position, sequence),
      ),
    )
    const descriptor = JSON.stringify({
      pipeline: RENDER_PIPELINE_VERSION,
      sequence,
      segmentKeys: fingerprints.map((fingerprint) => fingerprint.key),
      exportSettings: exportSettingsFingerprint(sequenceManifest.exportSettings),
    })
    const key = createHash('sha256').update(descriptor).digest('hex')
    const cachePath = path.join(
      state.rootPath,
      RENDER_CACHE_DIRECTORY,
      `${sequence}-program-${key}.mp4`,
    )
    const cached = await this.existingCachePath(cachePath)
    if (cached) return cached

    const jobKey = `program:${key}`
    const currentJob = this.renderJobs.get(jobKey)
    if (currentJob) return currentJob

    const job = this.renderCachedProgram(sequenceManifest, segmentPaths, cachePath)
    this.renderJobs.set(jobKey, job)
    void job
      .finally(() => {
        if (this.renderJobs.get(jobKey) === job) {
          this.renderJobs.delete(jobKey)
        }
      })
      .catch(() => undefined)
    return job
  }

  private async renderCachedProgram(
    sequenceManifest: SequenceManifest,
    segmentPaths: string[],
    cachePath: string,
  ): Promise<string> {
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    const temporaryPath = `${cachePath}.${randomUUID()}.tmp.mp4`
    const concatList = `${temporaryPath}.concat.txt`
    const normalizedPaths: string[] = []
    try {
      // Re-encode each scene's audio to PCM in MOV before concat. FFmpeg 9's concat
      // demuxer drops mid-timeline audio when decoding FLAC-in-MKV segments (only the
      // first ~2 scenes survive). PCM-in-MOV keeps a continuous decode timeline so
      // loudnorm/AAC mastering hears every line. Video is copied so pictures stay locked.
      for (const [index, segmentPath] of segmentPaths.entries()) {
        const normalizedPath = `${temporaryPath}.norm-${index}-${path.basename(segmentPath, path.extname(segmentPath))}.mov`
        await this.runFfmpeg([
          '-y',
          '-i',
          segmentPath,
          '-c:v',
          'copy',
          '-c:a',
          'pcm_s16le',
          '-ar',
          '48000',
          '-ac',
          '2',
          '-avoid_negative_ts',
          'make_zero',
          normalizedPath,
        ])
        normalizedPaths.push(normalizedPath)
      }
      const normalizedList = normalizedPaths
        .map((segmentPath) => `file '${segmentPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n')
      await fs.writeFile(concatList, normalizedList, 'utf8')
      const polish = buildDialogueMasterFilter(sequenceManifest.exportSettings.truePeak)
      const measured = await this.measureLoudnorm(
        concatList,
        polish,
        sequenceManifest.exportSettings.audioLufs,
        sequenceManifest.exportSettings.truePeak,
      )
      const loudnorm = loudnormMeasurementUsable(measured)
        ? buildLoudnormApplyFilter(
            sequenceManifest.exportSettings.audioLufs,
            sequenceManifest.exportSettings.truePeak,
            measured,
          )
        : buildLoudnormSinglePassFilter(
            sequenceManifest.exportSettings.audioLufs,
            sequenceManifest.exportSettings.truePeak,
          )
      const masterFilter = `${polish},${loudnorm}`
      await this.runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatList,
        '-af',
        masterFilter,
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-b:a',
        PROGRAM_AAC_BITRATE,
        '-movflags',
        '+faststart',
        temporaryPath,
      ])
      try {
        await fs.rename(temporaryPath, cachePath)
        return cachePath
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const existing = await this.existingCachePath(cachePath)
        if (!existing) throw error
        return existing
      }
    } finally {
      await fs.rm(temporaryPath, { force: true })
      await fs.rm(concatList, { force: true })
      await Promise.all(normalizedPaths.map((normalizedPath) => fs.rm(normalizedPath, { force: true })))
    }
  }

  private async measureLoudnorm(
    audioPath: string,
    polishFilter: string,
    audioLufs: number,
    truePeak: number,
  ): Promise<LoudnormMeasurement> {
    const nullSink = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const result = await this.runFfmpeg([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      audioPath,
      '-vn',
      '-af',
      `${polishFilter},${buildLoudnormMeasureFilter(audioLufs, truePeak)}`,
      '-f',
      'null',
      nullSink,
    ])
    return parseLoudnormMeasurement(result.stderr)
  }

  private async ensureCachedSegment(
    state: ProjectState,
    sequenceManifest: SequenceManifest,
    line: ScriptLine,
    position: number,
    sequence: SequenceId,
  ): Promise<string> {
    if (stillImagePathsForLine(line).length === 0) {
      throw new Error(`Scene ${line.index + 1} has no generated image.`)
    }

    const fingerprint = await this.segmentFingerprint(
      state,
      sequenceManifest,
      line,
      position,
      sequence,
    )
    const cached = await this.existingCachePath(fingerprint.cachePath)
    if (cached) {
      logGeneration('Export', 'scene cache hit', {
        sequence,
        lineId: line.id,
        cachePath: cached,
      })
      return cached
    }

    const currentJob = this.renderJobs.get(fingerprint.key)
    if (currentJob) return currentJob

    logGeneration('Export', 'scene encode start', {
      sequence,
      lineId: line.id,
      cachePath: fingerprint.cachePath,
    })
    const job = this.renderCachedSegment(
      state.rootPath,
      sequenceManifest,
      line,
      position,
      fingerprint.cachePath,
    )
    this.renderJobs.set(fingerprint.key, job)
    void job
      .finally(() => {
        if (this.renderJobs.get(fingerprint.key) === job) {
          this.renderJobs.delete(fingerprint.key)
        }
      })
      .catch(() => undefined)
    return job
  }

  private async segmentFingerprint(
    state: ProjectState,
    sequenceManifest: SequenceManifest,
    line: ScriptLine,
    position: number,
    sequence: SequenceId,
  ): Promise<{
    key: string
    cachePath: string
  }> {
    const stillPaths = stillImagePathsForLine(line)
    if (stillPaths.length === 0) {
      throw new Error(`Scene ${line.index + 1} is missing still images.`)
    }
    const imageHash = (
      await Promise.all(
        stillPaths.map((relativePath) => assetIdentity(resolveProjectAsset(state.rootPath, relativePath))),
      )
    ).join(',')
    const audioPath = line.voicePath ? resolveProjectAsset(state.rootPath, line.voicePath) : null
    const audioHash = audioPath ? await assetIdentity(audioPath) : 'no-audio'
    const duration = Math.max(0.1, line.duration)
    const motionEffect = motionEffectForLine(line, duration)
    const startPadding =
      position === 0 ? FIRST_SCENE_START_PADDING_SECONDS : SCENE_START_PADDING_SECONDS
    const previousStill =
      position > 0 ? stillImagePathsForLine(sequenceManifest.lines[position - 1]!)[0] : undefined
    const previousStillHash = previousStill
      ? await assetIdentity(resolveProjectAsset(state.rootPath, previousStill))
      : ''
    const descriptor = JSON.stringify({
      pipeline: RENDER_PIPELINE_VERSION,
      sequence,
      lineId: line.id,
      lineIndex: line.index,
      position,
      duration,
      stillPaths,
      imageHash,
      audioHash,
      motionEffect,
      startPadding,
      cueLead: position > 0 && (line.voiceCleanupVersion || 0) < VOICE_CLEANUP_VERSION
        ? SCENE_START_PADDING_SECONDS : 0,
      previousStill: previousStill || '',
      previousStillHash,
      endPadding: SCENE_END_PADDING_SECONDS,
      speechDetectNoise: SPEECH_DETECT_NOISE,
      speechDetectMin: SPEECH_DETECT_MIN_SECONDS,
      speechLead: SPEECH_LEAD_SECONDS,
      speechTrail: SPEECH_TRAIL_SECONDS,
      silenceMode:
        (line.voiceCleanupVersion || 0) >= 1
          ? 'pre-cleaned-voice'
          : 'speech-window-atrim',
      voiceCleanupVersion: line.voiceCleanupVersion || 0,
      dialogueNormalize: {
        meanDb: DIALOGUE_NORMALIZE_MEAN_DB,
        peakDb: DIALOGUE_NORMALIZE_PEAK_DB,
      },
      firstScenePadding: FIRST_SCENE_START_PADDING_SECONDS,
      scenePadding: SCENE_START_PADDING_SECONDS,
      exportSettings: exportSettingsFingerprint(sequenceManifest.exportSettings),
    })
    const key = createHash('sha256').update(descriptor).digest('hex')
    const cachePath = path.join(
      state.rootPath,
      RENDER_CACHE_DIRECTORY,
      `${sequence}-${line.id}-${key}.mkv`,
    )
    return { key, cachePath }
  }

  private async existingCachePath(cachePath: string): Promise<string | null> {
    try {
      const stats = await fs.stat(cachePath)
      return stats.isFile() && stats.size > 0 ? cachePath : null
    } catch {
      return null
    }
  }

  private async renderCachedSegment(
    rootPath: string,
    sequenceManifest: SequenceManifest,
    line: ScriptLine,
    position: number,
    cachePath: string,
  ): Promise<string> {
    await this.acquireEncodeSlot()
    try {
      await fs.mkdir(path.dirname(cachePath), { recursive: true })
      const temporaryPath = `${cachePath}.${randomUUID()}.tmp.mkv`
      try {
        await this.renderSegment(
          sequenceManifest,
          line,
          rootPath,
          temporaryPath,
          position === 0,
        )
        try {
          await fs.rename(temporaryPath, cachePath)
          return cachePath
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          const existing = await this.existingCachePath(cachePath)
          if (!existing) throw error
          return existing
        }
      } finally {
        await fs.rm(temporaryPath, { force: true })
      }
    } finally {
      this.releaseEncodeSlot()
    }
  }

  private async acquireEncodeSlot(): Promise<void> {
    while (this.encodeActive >= PRE_RENDER_CONCURRENCY) {
      await new Promise<void>((resolve) => {
        this.encodeWaiters.push(resolve)
      })
    }
    this.encodeActive += 1
  }

  private releaseEncodeSlot(): void {
    this.encodeActive = Math.max(0, this.encodeActive - 1)
    const next = this.encodeWaiters.shift()
    next?.()
  }

  private async renderSegment(
    manifest: SequenceManifest,
    line: SequenceManifest['lines'][number],
    rootPath: string,
    outputPath: string,
    isFirstScene: boolean,
  ): Promise<void> {
    const stillPaths = stillImagePathsForLine(line).map((relativePath) =>
      resolveProjectAsset(rootPath, relativePath),
    )
    if (stillPaths.length === 0) {
      throw new Error(`Scene ${line.index + 1} is missing still images.`)
    }
    const audioPath = line.voicePath ? resolveProjectAsset(rootPath, line.voicePath) : null
    const voiceAlreadyCleaned = (line.voiceCleanupVersion || 0) >= 1
    const probedDuration =
      voiceAlreadyCleaned && audioPath ? await probeMediaDurationSeconds(audioPath) : null
    const duration = probedDuration || Math.max(0.1, line.duration)
    const sceneStartPadding = voiceAlreadyCleaned
      ? 0
      : isFirstScene
        ? FIRST_SCENE_START_PADDING_SECONDS
        : SCENE_START_PADDING_SECONDS
    const sceneEndPadding = voiceAlreadyCleaned ? 0 : SCENE_END_PADDING_SECONDS
    const speechWindow =
      audioPath && !voiceAlreadyCleaned ? await this.measureSpeechWindow(audioPath, duration) : null
    const spokenDuration = speechWindow
      ? Math.max(0.1, speechWindow.trimEnd - speechWindow.trimStart)
      : duration
    const audioInput = audioPath
      ? ['-i', audioPath]
      : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']
    const normalizeGainDb = audioPath
      ? voiceAlreadyCleaned
        ? await this.measureDialogueNormalizeGain(audioPath, {
            trimStart: 0,
            trimEnd: duration,
            sourceDuration: duration,
          })
        : speechWindow
          ? await this.measureDialogueNormalizeGain(audioPath, speechWindow)
          : 0
      : 0
    const audioFilter = audioPath
      ? voiceAlreadyCleaned
        ? `volume=${Number(normalizeGainDb.toFixed(2))}dB`
        : speechWindow
          ? buildSpeechWindowAudioFilter(
              speechWindow,
              sceneStartPadding,
              sceneEndPadding,
              normalizeGainDb,
            )
          : null
      : null
    const width = manifest.exportSettings.width
    const height = manifest.exportSettings.height
    const fps = manifest.exportSettings.fps
    const baseVideoFilter = lineHasStillCastBeats(line)
      ? containPadFilter(width, height)
      : coverScaleCropFilter(width, height)
    const totalDuration = voiceAlreadyCleaned
      ? spokenDuration
      : spokenDuration + sceneStartPadding + sceneEndPadding
    const linePosition = manifest.lines.findIndex((entry) => entry.id === line.id)
    const previousStill = linePosition > 0 ? stillImagePathsForLine(manifest.lines[linePosition - 1]!)[0] : undefined
    const previousStillPath = previousStill ? resolveProjectAsset(rootPath, previousStill) : undefined
    const cueLead =
      previousStillPath && linePosition > 0 && (line.voiceCleanupVersion || 0) < VOICE_CLEANUP_VERSION
        ? Math.min(SCENE_START_PADDING_SECONDS, Math.max(0, totalDuration - 0.15))
        : 0

    if (stillPaths.length === 1 && previousStillPath && cueLead >= 0.04) {
      const rest = Number((totalDuration - cueLead).toFixed(3))
      const held = `${baseVideoFilter},fps=${fps},setsar=1`
      const current = `${videoFilterForLine(line, spokenDuration, width, height, rest)},fps=${fps},setsar=1`
      await this.runFfmpeg([
        '-y',
        '-loop',
        '1',
        '-framerate',
        String(fps),
        '-t',
        String(cueLead),
        '-i',
        previousStillPath,
        '-loop',
        '1',
        '-framerate',
        String(fps),
        '-t',
        String(rest),
        '-i',
        stillPaths[0]!,
        ...audioInput,
        '-filter_complex',
        `[0:v]${held}[v0];[1:v]${current}[v1];[v0][v1]concat=n=2:v=1:a=0[v]`,
        '-map',
        '[v]',
        '-map',
        '2:a',
        '-t',
        String(totalDuration),
        '-r',
        String(fps),
        ...(audioFilter ? ['-af', audioFilter, '-shortest'] : ['-shortest']),
        '-c:v',
        'libx264',
        '-preset',
        SEGMENT_X264_PRESET,
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'flac',
        '-sample_fmt',
        's16',
        '-ar',
        '48000',
        '-ac',
        '2',
        outputPath,
      ])
      return
    }

    if (stillPaths.length === 1) {
      await this.runFfmpeg([
        '-y',
        '-loop',
        '1',
        '-framerate',
        String(fps),
        '-i',
        stillPaths[0]!,
        ...audioInput,
        '-t',
        String(totalDuration),
        '-vf',
        videoFilterForLine(line, spokenDuration, width, height, totalDuration),
        '-r',
        String(fps),
        ...(audioFilter ? ['-af', audioFilter, '-shortest'] : []),
        '-c:v',
        'libx264',
        '-preset',
        SEGMENT_X264_PRESET,
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'flac',
        '-sample_fmt',
        's16',
        '-ar',
        '48000',
        '-ac',
        '2',
        outputPath,
      ])
      return
    }

    const beats = (line.stillBeats || []).filter((beat) => beat.imagePath)
    const durations = stillBeatDurations(beats, spokenDuration)
    if (durations.length > 0) {
      durations[0] = (durations[0] || 0) + sceneStartPadding
      durations[durations.length - 1] =
        (durations[durations.length - 1] || 0) + sceneEndPadding
    }
    const inputArgs: string[] = []
    stillPaths.forEach((imagePath, index) => {
      inputArgs.push('-loop', '1', '-t', String(durations[index] || 0.2), '-i', imagePath)
    })
    const videoLabels = stillPaths.map((_, index) => {
      return `[${index}:v]${baseVideoFilter},setsar=1,fps=${fps}[v${index}]`
    })
    const concatInputs = stillPaths.map((_, index) => `[v${index}]`).join('')
    const audioInputIndex = stillPaths.length
    const filterComplex = [
      ...videoLabels,
      `${concatInputs}concat=n=${stillPaths.length}:v=1:a=0[v]`,
      audioFilter ? `[${audioInputIndex}:a]${audioFilter}[a]` : null,
    ].filter(Boolean).join(';')

    await this.runFfmpeg([
      '-y',
      ...inputArgs,
      ...audioInput,
      '-filter_complex',
      filterComplex,
      '-map',
      '[v]',
      '-map',
      audioFilter ? '[a]' : `${audioInputIndex}:a`,
      '-t',
      String(totalDuration),
      '-r',
      String(fps),
      ...(audioFilter ? ['-shortest'] : []),
      '-c:v',
      'libx264',
      '-preset',
      SEGMENT_X264_PRESET,
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'flac',
      '-sample_fmt',
      's16',
      '-ar',
      '48000',
      '-ac',
      '2',
      outputPath,
    ])
  }

  private async measureDialogueNormalizeGain(
    audioPath: string,
    window: SpeechWindow,
  ): Promise<number> {
    try {
      const start = Number(window.trimStart.toFixed(3))
      const end = Number(Math.max(window.trimStart + 0.05, window.trimEnd).toFixed(3))
      const result = await this.runFfmpeg([
        '-i',
        audioPath,
        '-af',
        `atrim=start=${start}:end=${end},volumedetect`,
        '-f',
        'null',
        '-',
      ])
      const levels = parseVolumeDetect(result.stderr)
      return levels ? dialogueNormalizeGainDb(levels.meanVolumeDb, levels.maxVolumeDb) : 0
    } catch {
      return 0
    }
  }

  private async measureSpeechWindow(
    audioPath: string,
    fallbackDuration: number,
  ): Promise<SpeechWindow> {
    try {
      const result = await this.runFfmpeg([
        '-i',
        audioPath,
        '-af',
        `silencedetect=noise=${SPEECH_DETECT_NOISE}:d=${SPEECH_DETECT_MIN_SECONDS}`,
        '-f',
        'null',
        '-',
      ])
      const sourceDuration = parseMediaDurationSeconds(result.stderr) ?? fallbackDuration
      return speechWindowFromSilence(
        parseSilencePeriods(result.stderr),
        sourceDuration,
        SPEECH_LEAD_SECONDS,
        SPEECH_TRAIL_SECONDS,
      )
    } catch {
      // Prefer intact speech over a failed trim when detection cannot run.
      return {
        trimStart: 0,
        trimEnd: fallbackDuration,
        sourceDuration: fallbackDuration,
      }
    }
  }

  private runFfmpeg(args: string[]): Promise<FfmpegResult> {
    const executable = process.env.FFMPEG_PATH || 'ffmpeg'
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', (error) => {
        reject(
          new Error(
            `Could not start FFmpeg. Install FFmpeg or set FFMPEG_PATH. ${error.message}`,
          ),
        )
      })
      child.once('close', (code) => {
        if (code === 0) {
          resolve({ stdout, stderr })
        } else {
          const lastLines = stderr.trim().split(/\r?\n/).slice(-8).join('\n')
          reject(new Error(`FFmpeg export failed.\n${lastLines}`))
        }
      })
    })
  }
}

type MotionEffect = 'none' | 'zoom-in' | 'zoom-out' | 'pan-left' | 'pan-right'

function buildSpeechWindowAudioFilter(
  window: SpeechWindow,
  sceneStartPadding: number,
  sceneEndPadding: number,
  normalizeGainDb = 0,
): string {
  const start = Number(window.trimStart.toFixed(3))
  const end = Number(window.trimEnd.toFixed(3))
  const gain = Number(normalizeGainDb.toFixed(2))
  return [
    `atrim=start=${start}:end=${end}`,
    'asetpts=PTS-STARTPTS',
    `volume=${gain}dB`,
    `adelay=${Math.round(sceneStartPadding * 1000)}:all=1`,
    `apad=pad_dur=${sceneEndPadding}`,
  ].join(',')
}

export function dialogueNormalizeGainDb(meanVolumeDb: number, maxVolumeDb: number): number {
  if (!Number.isFinite(meanVolumeDb) || !Number.isFinite(maxVolumeDb)) return 0
  const meanGain = DIALOGUE_NORMALIZE_MEAN_DB - meanVolumeDb
  const peakHeadroom = DIALOGUE_NORMALIZE_PEAK_DB - maxVolumeDb
  const gain = Math.min(meanGain, peakHeadroom, DIALOGUE_NORMALIZE_MAX_BOOST_DB)
  return Number(Math.max(-DIALOGUE_NORMALIZE_MAX_CUT_DB, gain).toFixed(2))
}

export function parseVolumeDetect(stderr: string): { meanVolumeDb: number; maxVolumeDb: number } | null {
  const mean = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i)
  const peak = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i)
  if (!mean || !peak) return null
  const meanVolumeDb = Number(mean[1])
  const maxVolumeDb = Number(peak[1])
  if (!Number.isFinite(meanVolumeDb) || !Number.isFinite(maxVolumeDb)) return null
  return { meanVolumeDb, maxVolumeDb }
}

export { speechWindowFromSilence } from './voiceTakeCleanup'

function buildDialogueMasterFilter(truePeak: number): string {
  const limiterDb = Number.isFinite(truePeak) ? truePeak : -1.5
  return [
    'highpass=f=80',
    'afftdn=nr=12:nf=-50',
    'treble=g=-2:f=6000',
    'equalizer=f=3000:t=q:w=1:g=2',
    'acompressor=threshold=-18dB:ratio=3:attack=5:release=50:makeup=2',
    `alimiter=limit=${limiterDb}dB:level=false`,
  ].join(',')
}

function buildLoudnormMeasureFilter(audioLufs: number, truePeak: number): string {
  return `loudnorm=I=${audioLufs}:TP=${truePeak}:LRA=${LOUDNORM_LRA}:print_format=json`
}

function buildLoudnormSinglePassFilter(audioLufs: number, truePeak: number): string {
  return `loudnorm=I=${audioLufs}:TP=${truePeak}:LRA=${LOUDNORM_LRA}`
}

function loudnormMeasurementUsable(measured: LoudnormMeasurement): boolean {
  return [
    measured.input_i,
    measured.input_tp,
    measured.input_lra,
    measured.input_thresh,
    measured.target_offset,
  ].every((value) => /^-?\d+(?:\.\d+)?$/.test(value))
}

function buildLoudnormApplyFilter(
  audioLufs: number,
  truePeak: number,
  measured: LoudnormMeasurement,
): string {
  return [
    `loudnorm=I=${audioLufs}`,
    `TP=${truePeak}`,
    `LRA=${LOUDNORM_LRA}`,
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'linear=true',
    'print_format=summary',
  ].join(':')
}

function parseLoudnormMeasurement(stderr: string): LoudnormMeasurement {
  const match = stderr.match(/\{\s*"input_i"\s*:\s*"([^"]+)"[\s\S]*?\}/)
  if (!match) {
    throw new Error('FFmpeg loudnorm measure pass did not return calibration data.')
  }
  try {
    const parsed = JSON.parse(match[0]!) as Partial<LoudnormMeasurement>
    if (
      typeof parsed.input_i !== 'string' ||
      typeof parsed.input_tp !== 'string' ||
      typeof parsed.input_lra !== 'string' ||
      typeof parsed.input_thresh !== 'string' ||
      typeof parsed.target_offset !== 'string'
    ) {
      throw new Error('incomplete')
    }
    return {
      input_i: parsed.input_i,
      input_tp: parsed.input_tp,
      input_lra: parsed.input_lra,
      input_thresh: parsed.input_thresh,
      target_offset: parsed.target_offset,
    }
  } catch {
    throw new Error('FFmpeg loudnorm measure pass returned unreadable calibration data.')
  }
}

function motionEffectForLine(line: ScriptLine, duration: number): MotionEffect {
  if (lineHasStillCastBeats(line)) return 'none'
  if (duration <= MOTION_EFFECT_THRESHOLD_SECONDS) return 'none'
  const effects: MotionEffect[] = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right']
  return effects[Math.abs(line.index) % effects.length]
}

function videoFilterForLine(
  line: ScriptLine,
  duration: number,
  width: number,
  height: number,
  animationDuration = duration,
): string {
  const effect = motionEffectForLine(line, duration)
  if (effect === 'none') {
    return lineHasStillCastBeats(line) ? containPadFilter(width, height) : coverScaleCropFilter(width, height)
  }
  return kenBurnsFilter(effect, width, height, animationDuration)
}

function coverScaleCropFilter(width: number, height: number): string {
  return `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`
}

function evenDimension(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

function motionWorkingSize(width: number, height: number): { workW: number; workH: number } {
  const scale = Math.min(MOTION_WORK_SCALE, MOTION_MAX_WORK_EDGE / Math.max(width, height, 1))
  return { workW: evenDimension(width * scale), workH: evenDimension(height * scale) }
}

function easeExpression(duration: number): string {
  return `(0.5-0.5*cos(PI*min(max(t/${duration},0),1)))`
}

function kenBurnsFilter(
  effect: Exclude<MotionEffect, 'none'>,
  width: number,
  height: number,
  animationDuration: number,
): string {
  const { workW, workH } = motionWorkingSize(width, height)
  const ease = easeExpression(animationDuration)
  const zoom =
    effect === 'zoom-in'
      ? `1+(${MOTION_ZOOM_MAX}-1)*${ease}`
      : effect === 'zoom-out'
        ? `${MOTION_ZOOM_MAX}-(${MOTION_ZOOM_MAX}-1)*${ease}`
        : String(MOTION_PAN_ZOOM)
  const panProgress = effect === 'pan-left' ? `(1-${ease})` : ease
  const isPan = effect === 'pan-left' || effect === 'pan-right'
  const zoomScale = isPan
    ? `scale=w='max(${workW},trunc(iw*${MOTION_PAN_ZOOM}/2)*2)':h='max(${workH},trunc(ih*${MOTION_PAN_ZOOM}/2)*2)':flags=bilinear`
    : `scale=w='max(${workW},trunc(iw*(${zoom})/2)*2)':h='max(${workH},trunc(ih*(${zoom})/2)*2)':eval=frame:flags=bilinear`
  const cropX = isPan
    ? `trunc((iw-${workW})*${panProgress}/2)*2`
    : `trunc((iw-${workW})/4)*2`

  return [
    `scale=${workW}:${workH}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${workW}:${workH}`,
    'setsar=1',
    zoomScale,
    `crop=${workW}:${workH}:x='${cropX}':y='trunc((ih-${workH})/4)*2'`,
    `scale=${width}:${height}:flags=lanczos`,
    'setsar=1',
  ].join(',')
}

function stillImagePathsForLine(line: ScriptLine): string[] {
  const beats = expressionPlaybackBeats(line.stillBeats || [], line.id)
    .map((beat) => beat.imagePath)
    .filter((value): value is string => Boolean(value))
  if (beats.length > 0) return beats
  return line.imagePath ? [line.imagePath] : []
}

function sequenceManifestFromState(state: ProjectState, sequence: SequenceId): SequenceManifest {
  if (sequence === 'main') {
    return {
      lines: state.manifest.lines,
      scriptFile: state.manifest.scriptFile,
      exportSettings: state.manifest.exportSettings,
    }
  }
  return (
    state.manifest.trailer || {
      lines: [],
      scriptFile: 'trailer/script.txt',
      exportSettings: structuredClone(DEFAULT_TRAILER_EXPORT_SETTINGS),
    }
  )
}

async function assetIdentity(filePath: string): Promise<string> {
  const stats = await fs.stat(filePath)
  // Ignore mtime — cloud sync / openers under Documents often touch timestamps
  // without changing bytes, which used to bust the whole render cache on reopen.
  const digest = await sampleFileDigest(filePath, stats.size)
  return `${stats.size}:${digest}`
}

async function sampleFileDigest(filePath: string, size: number): Promise<string> {
  const hash = createHash('sha1')
  hash.update(`size:${size}`)
  if (size <= 0) return hash.digest('hex')

  const handle = await fs.open(filePath, 'r')
  try {
    const chunkSize = Math.min(ASSET_SAMPLE_BYTES, size)
    const head = Buffer.alloc(chunkSize)
    await handle.read(head, 0, chunkSize, 0)
    hash.update(head)
    if (size > chunkSize * 2) {
      const tail = Buffer.alloc(chunkSize)
      await handle.read(tail, 0, chunkSize, size - chunkSize)
      hash.update(tail)
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

function exportSettingsFingerprint(settings: ExportSettings): Record<string, string | number> {
  return {
    width: settings.width,
    height: settings.height,
    fps: settings.fps,
    audioLufs: settings.audioLufs,
    truePeak: settings.truePeak,
    masterPreset: settings.masterPreset || 'dialogue-youtube',
  }
}

function resolveProjectAsset(rootPath: string, relativePath: string): string {
  const root = path.resolve(rootPath)
  const absolutePath = path.resolve(rootPath, relativePath)
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${path.sep}`)) {
    throw new Error('Export asset is outside the active project.')
  }
  return absolutePath
}
