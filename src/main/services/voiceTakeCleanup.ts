import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { detectVoiceBoundary } from '../../shared/voiceBoundary'
import {
  SCENE_END_PADDING_SECONDS,
  SCENE_START_PADDING_SECONDS,
  cleanedDurationFromWindow as sharedCleanedDurationFromWindow,
} from '../../shared/voiceCleanupMath'

export const VOICE_CLEANUP_VERSION = 2
export const VOICE_CLEANUP_END_GAP_SECONDS = 0.25
export const VOICE_BOUNDARY_SAMPLE_RATE = 24000

export const SPEECH_DETECT_NOISE = '-40dB'
export const SPEECH_DETECT_MIN_SECONDS = 0.15
export const SPEECH_LEAD_SECONDS = 0.2
export const SPEECH_TRAIL_SECONDS = 0.25
export {
  SCENE_START_PADDING_SECONDS,
  SCENE_END_PADDING_SECONDS,
  clampVoiceTrimEnd,
  clampVoiceTrimStart,
  rawTrimEndFromCleanedEnd,
  rawTrimStartFromCleanedStart,
} from '../../shared/voiceCleanupMath'
export { MIN_SPEECH_WINDOW_SECONDS } from '../../shared/voiceCleanupMath'

export interface SpeechWindow {
  trimStart: number
  trimEnd: number
  sourceDuration: number
  endPaddingSeconds?: number
  confident?: boolean
}

export interface VoiceTakeCleanupResult {
  durationSeconds: number
  rawAbsolutePath: string
  cleanedAbsolutePath: string
  trimStart: number
  trimEnd: number
  version: number
  endPaddingSeconds: number
  confident: boolean
}

interface FfmpegResult {
  stdout: string
  stderr: string
}

export function speechWindowFromSilence(
  periods: Array<{ start: number; end: number | null }>,
  duration: number,
  leadSeconds: number,
  trailSeconds: number,
): SpeechWindow {
  const safeDuration = Math.max(0.1, duration)
  let speechStart = 0
  let speechEnd = safeDuration

  const leading = periods.find((period) => period.start <= 0.05 && period.end !== null)
  if (leading?.end != null && Number.isFinite(leading.end)) {
    speechStart = Math.max(0, leading.end)
  }

  const trailing = [...periods]
    .reverse()
    .find((period) => period.end === null || (period.end ?? 0) >= safeDuration - 0.08)
  if (trailing && Number.isFinite(trailing.start)) {
    speechEnd = Math.max(speechStart, trailing.start)
  }

  if (speechEnd <= speechStart + 0.05) {
    return { trimStart: 0, trimEnd: safeDuration, sourceDuration: safeDuration }
  }

  return {
    trimStart: Math.max(0, speechStart - leadSeconds),
    trimEnd: Math.min(safeDuration, speechEnd + trailSeconds),
    sourceDuration: safeDuration,
  }
}

export function parseSilencePeriods(stderr: string): Array<{ start: number; end: number | null }> {
  const events: Array<{ type: 'start' | 'end'; time: number }> = []
  for (const line of stderr.split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([-\d.]+)/)
    const end = line.match(/silence_end:\s*([-\d.]+)/)
    if (start) events.push({ type: 'start', time: Number(start[1]) })
    if (end) events.push({ type: 'end', time: Number(end[1]) })
  }

  const periods: Array<{ start: number; end: number | null }> = []
  let open: number | null = null
  for (const event of events) {
    if (event.type === 'start') {
      open = event.time
      continue
    }
    if (open === null) {
      periods.push({ start: 0, end: event.time })
      continue
    }
    periods.push({ start: open, end: event.time })
    open = null
  }
  if (open !== null) periods.push({ start: open, end: null })
  return periods
}

export function probeMediaDurationSeconds(filePath: string): Promise<number | null> {
  const executable = process.env.FFPROBE_PATH || 'ffprobe'
  return new Promise((resolve) => {
    const child = spawn(executable, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      filePath,
    ], { windowsHide: true })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.once('error', () => resolve(null))
    child.once('close', (code) => {
      if (code !== 0) {
        resolve(null)
        return
      }
      const value = Number(stdout.trim())
      resolve(Number.isFinite(value) && value > 0 ? Number(value.toFixed(3)) : null)
    })
  })
}

export function parseMediaDurationSeconds(stderr: string): number | null {
  const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  if (![hours, minutes, seconds].every((value) => Number.isFinite(value))) return null
  return hours * 3600 + minutes * 60 + seconds
}

export function cleanedDurationFromWindow(
  window: Pick<SpeechWindow, 'trimStart' | 'trimEnd'>,
  sceneStartPadding = 0,
  sceneEndPadding = VOICE_CLEANUP_END_GAP_SECONDS,
): number {
  return sharedCleanedDurationFromWindow(
    window.trimStart,
    window.trimEnd,
    sceneStartPadding,
    sceneEndPadding,
  )
}

export function buildVoiceCleanupAudioFilter(
  window: SpeechWindow,
  sceneStartPadding = 0,
  sceneEndPadding = window.endPaddingSeconds ?? VOICE_CLEANUP_END_GAP_SECONDS,
): string {
  const start = Number(window.trimStart.toFixed(3))
  const end = Number(window.trimEnd.toFixed(3))
  return [
    `atrim=start=${start}:end=${end}`,
    'asetpts=PTS-STARTPTS',
    ...(sceneStartPadding > 0 ? [`adelay=${Math.round(sceneStartPadding * 1000)}:all=1`] : []),
    `apad=pad_dur=${sceneEndPadding}`,
  ].join(',')
}

export async function detectSpeechWindowFromRaw(
  rawAbsolutePath: string,
  fallbackDurationSeconds: number,
): Promise<SpeechWindow> {
  const sampleRate = VOICE_BOUNDARY_SAMPLE_RATE
  const pcm = await decodeVoicePcm(rawAbsolutePath, sampleRate)
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
  const sourceDuration = samples.length > 0 ? samples.length / sampleRate : Math.max(0.1, fallbackDurationSeconds)
  const boundary = detectVoiceBoundary(samples, sampleRate)
  if (!boundary.confident) {
    return { trimStart: 0, trimEnd: sourceDuration, sourceDuration, endPaddingSeconds: 0, confident: false }
  }
  const trimStart = Math.max(0, boundary.speechStart)
  // Keep up to 100 ms of the original tail to protect fading final sounds.
  const trimEnd = Math.min(sourceDuration, boundary.speechEnd + 0.1)
  const retainedQuiet = trimEnd - boundary.speechEnd
  return {
    trimStart,
    trimEnd,
    sourceDuration,
    endPaddingSeconds: Math.max(0, VOICE_CLEANUP_END_GAP_SECONDS - retainedQuiet),
    confident: true,
  }
}

export async function rewriteCleanedVoiceTakeFromRaw(
  rawAbsolutePath: string,
  cleanedAbsolutePath: string,
  window: SpeechWindow,
): Promise<{ durationSeconds: number; trimStart: number; trimEnd: number; endPaddingSeconds: number }> {
  const directory = path.dirname(cleanedAbsolutePath)
  const temporaryPath = path.join(directory, `voice-clean-${randomUUID()}.flac`)
  try {
    const audioFilter = buildVoiceCleanupAudioFilter(window)
    await runFfmpeg([
      '-y',
      '-i',
      rawAbsolutePath,
      '-af',
      audioFilter,
      '-c:a',
      'flac',
      temporaryPath,
    ])
    await fs.rm(cleanedAbsolutePath, { force: true }).catch(() => undefined)
    await fs.rename(temporaryPath, cleanedAbsolutePath)
    const probed = await probeMediaDurationSeconds(cleanedAbsolutePath)
    return {
      durationSeconds: probed ?? cleanedDurationFromWindow(window, 0, window.endPaddingSeconds),
      trimStart: window.trimStart,
      trimEnd: window.trimEnd,
      endPaddingSeconds: window.endPaddingSeconds ?? VOICE_CLEANUP_END_GAP_SECONDS,
    }
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * After a take is written to disk, strip edge dead air, keep a short speech
 * safety window, then bake scene padding into the cleaned voice file.
 * The original take is preserved beside it as voice-raw.* for later editing.
 */
export async function cleanupRecordedVoiceTake(
  absoluteVoicePath: string,
  fallbackDurationSeconds: number,
): Promise<VoiceTakeCleanupResult> {
  const extension = path.extname(absoluteVoicePath) || '.wav'
  const directory = path.dirname(absoluteVoicePath)
  const rawAbsolutePath = path.join(directory, `voice-raw${extension}`)
  const cleanedAbsolutePath = path.join(directory, 'voice.flac')

  await fs.rm(rawAbsolutePath, { force: true }).catch(() => undefined)
  await fs.rename(absoluteVoicePath, rawAbsolutePath)

  try {
    const window = await detectSpeechWindowFromRaw(rawAbsolutePath, fallbackDurationSeconds)
    const rewritten = await rewriteCleanedVoiceTakeFromRaw(
      rawAbsolutePath,
      cleanedAbsolutePath,
      window,
    )
    if (path.resolve(absoluteVoicePath) !== path.resolve(cleanedAbsolutePath)) {
      await fs.rm(absoluteVoicePath, { force: true }).catch(() => undefined)
    }
    return {
      durationSeconds: rewritten.durationSeconds,
      rawAbsolutePath,
      cleanedAbsolutePath,
      trimStart: rewritten.trimStart,
      trimEnd: rewritten.trimEnd,
      version: VOICE_CLEANUP_VERSION,
      endPaddingSeconds: rewritten.endPaddingSeconds,
      confident: window.confident ?? true,
    }
  } catch (error) {
    // If cleanup fails, restore the raw take as the playable voice file.
    try {
      await fs.rename(rawAbsolutePath, absoluteVoicePath)
    } catch {
      // Ignore restore failures; the caller still has the original buffer path issue.
    }
    throw error
  }
}

function decodeVoicePcm(filePath: string, sampleRate: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-v', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', String(sampleRate),
      '-f', 's16le', '-acodec', 'pcm_s16le', '-',
    ], { windowsHide: true })
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code) => code === 0
      ? resolve(Buffer.concat(chunks))
      : reject(new Error(`FFmpeg PCM decode failed: ${stderr.slice(-500)}`)))
  })
}

function runFfmpeg(args: string[]): Promise<FfmpegResult> {
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
        reject(new Error(`FFmpeg voice cleanup failed.\n${lastLines}`))
      }
    })
  })
}
