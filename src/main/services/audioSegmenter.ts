import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface AudioSegment {
  data: Buffer
  duration: number
  start: number
  end: number
}

export interface AudioCue {
  start: number
  end: number
  confidence?: number
}

export interface SilenceRange {
  start: number
  end: number
}

interface TextLine {
  text: string
}

const SILENCE_THRESHOLD = '-28dB'
const SILENCE_MINIMUM_SECONDS = 0.05
const SENTENCE_PAUSE_MINIMUM_SECONDS = 0.1
const MIN_SEGMENT_SECONDS = 0.1
const MAX_BOUNDARY_DRIFT_SECONDS = 1.8

export async function splitParagraphAudio(
  audio: Buffer,
  lines: readonly TextLine[],
  duration: number,
  signal?: AbortSignal,
  cues?: readonly AudioCue[],
): Promise<AudioSegment[]> {
  if (lines.length === 0) return []
  const totalDuration = Math.max(0.1, duration)
  const validatedCues = cues
    ? validateAudioCues(cues, lines.length, totalDuration)
    : undefined
  if (lines.length === 1) {
    const measuredDuration = audioDurationSeconds(audio)
    const finalDuration = measuredDuration || totalDuration
    return [{ data: audio, duration: finalDuration, start: 0, end: finalDuration }]
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-qwen-'))
  const inputPath = path.join(temporaryDirectory, 'paragraph.flac')
  await fs.writeFile(inputPath, audio)

  try {
    const ranges = validatedCues || validateAudioCues(
      await safeSilenceRanges(inputPath, lines, totalDuration, signal),
      lines.length,
      totalDuration,
    )
    const segments: AudioSegment[] = []

    for (let index = 0; index < lines.length; index += 1) {
      signal?.throwIfAborted()
      const start = ranges[index]?.start ?? 0
      const end = ranges[index]?.end ?? totalDuration
      const segmentDuration = Math.max(0.05, end - start)
      const outputPath = path.join(temporaryDirectory, `line-${String(index).padStart(4, '0')}.flac`)
      await runFfmpeg(
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          inputPath,
          '-ss',
          String(start),
          '-t',
          String(segmentDuration),
          '-map',
          '0:a:0',
          '-c:a',
          'flac',
          '-ar',
          '48000',
          '-ac',
          '2',
          outputPath,
        ],
        signal,
      )
      const data = await fs.readFile(outputPath)
      if (data.length === 0) throw new Error('FFmpeg returned an empty QWEN voice segment.')
      const measuredDuration = audioDurationSeconds(data)
      if (!measuredDuration || measuredDuration <= 0) {
        throw new Error('Could not measure the encoded QWEN voice segment duration.')
      }
      segments.push({
        data,
        duration: measuredDuration,
        start,
        end,
      })
    }
    return segments
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export function calculateLineBoundaries(
  lines: readonly TextLine[],
  duration: number,
  silences: readonly SilenceRange[],
): number[] {
  const totalDuration = Math.max(0.1, duration)
  if (lines.length <= 1) return [0, totalDuration]

  const weights = lines.map((line) => {
    const words = line.text.trim().split(/\s+/).filter(Boolean).length
    return Math.max(1, words)
  })
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const boundaries = [0]
  let accumulatedWeight = 0

  for (let index = 0; index < lines.length - 1; index += 1) {
    accumulatedWeight += weights[index]!
    const target = totalDuration * accumulatedWeight / totalWeight
    const minimum = boundaries[index]! + MIN_SEGMENT_SECONDS
    const maximum = totalDuration - (lines.length - index - 1) * MIN_SEGMENT_SECONDS
    const sentencePauses = silences
      .filter((range) => range.end - range.start >= SENTENCE_PAUSE_MINIMUM_SECONDS)
      .filter((range) => range.start >= minimum && range.start <= maximum)
    const candidate = sentencePauses
      .filter((range) => Math.abs(range.start - target) <= MAX_BOUNDARY_DRIFT_SECONDS)
      .sort((left, right) => {
        const distance = Math.abs(left.start - target) - Math.abs(right.start - target)
        return distance || right.end - right.start - (left.end - left.start)
      })[0]
    if (!candidate) {
      throw new Error(
        `No safe audio boundary was detected near line ${index + 1}; proportional speech cuts are disabled.`,
      )
    }
    const boundary = candidate.start
    boundaries.push(Math.min(maximum, Math.max(minimum, boundary)))
  }

  boundaries.push(totalDuration)
  return boundaries
}

async function safeSilenceRanges(
  inputPath: string,
  lines: readonly TextLine[],
  duration: number,
  signal?: AbortSignal,
): Promise<AudioCue[]> {
  const stderr = await runFfmpeg(
    [
      '-hide_banner',
      '-i',
      inputPath,
      '-af',
      `silencedetect=noise=${SILENCE_THRESHOLD}:d=${SILENCE_MINIMUM_SECONDS}`,
      '-f',
      'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    ],
    signal,
  )
  const silences = parseSilenceRanges(stderr)
  const boundaries = calculateLineBoundaries(lines, duration, silences)
  return boundaries.slice(0, -1).map((start, index) => ({
    start,
    end: boundaries[index + 1]!,
  }))
}

export function parseSilenceRanges(stderr: string): SilenceRange[] {
  const ranges: SilenceRange[] = []
  let start: number | undefined
  const pattern = /silence_(start|end):\s*([0-9]+(?:\.[0-9]+)?)/g
  for (const match of stderr.matchAll(pattern)) {
    const value = Number(match[2])
    if (!Number.isFinite(value)) continue
    if (match[1] === 'start') {
      start = value
    } else if (start !== undefined && value > start) {
      ranges.push({ start, end: value })
      start = undefined
    }
  }
  return ranges
}

export function validateAudioCues(
  cues: readonly AudioCue[],
  lineCount: number,
  duration: number,
): AudioCue[] {
  const totalDuration = Math.max(0.1, duration)
  if (cues.length !== lineCount) {
    throw new Error(`Expected one safe audio cue per line, received ${cues.length}.`)
  }
  cues.forEach((cue, index) => {
    if (
      !Number.isFinite(cue.start) ||
      !Number.isFinite(cue.end) ||
      (cue.confidence !== undefined && !Number.isFinite(cue.confidence))
    ) {
      throw new Error(`QWEN returned an invalid audio cue at line ${index + 1}.`)
    }
  })
  const normalized = cues.map((cue) => ({
    start: Math.max(0, Math.min(totalDuration, cue.start)),
    end: Math.max(0, Math.min(totalDuration, cue.end)),
    ...(cue.confidence === undefined ? {} : { confidence: cue.confidence }),
  }))
  if (
    normalized[0]?.start > 0.01 ||
    normalized[normalized.length - 1]?.end < totalDuration - 0.01 ||
    normalized.some(
      (cue, index) =>
        !Number.isFinite(cue.start) ||
        !Number.isFinite(cue.end) ||
        cue.end <= cue.start ||
        (index > 0 && cue.start < normalized[index - 1]!.end),
    )
  ) {
    throw new Error('QWEN alignment cues are missing coverage or contain an overlapping boundary.')
  }
  return normalized
}

export function wordCountAudioCues(lines: readonly TextLine[], duration: number): AudioCue[] {
  const totalDuration = Math.max(0.1, duration)
  if (lines.length === 0) return []
  if (lines.length === 1) return [{ start: 0, end: totalDuration }]
  const weights = lines.map((line) => Math.max(1, line.text.trim().split(/\s+/).filter(Boolean).length))
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0)
  const cues: AudioCue[] = []
  let cursor = 0
  for (const [index, weight] of weights.entries()) {
    const start = cursor
    const end = index === weights.length - 1 ? totalDuration : cursor + (weight / weightSum) * totalDuration
    cues.push({ start, end })
    cursor = end
  }
  return cues
}

export async function splitStanzaAudio(
  audio: Buffer,
  mimeType: string,
  lines: readonly TextLine[],
  duration: number,
  signal?: AbortSignal,
): Promise<AudioSegment[]> {
  const extension = mimeType.includes('webm')
    ? '.webm'
    : mimeType.includes('wav')
      ? '.wav'
      : mimeType.includes('mpeg') || mimeType.includes('mp3')
        ? '.mp3'
        : '.webm'
  const totalDuration = Math.max(0.1, duration)
  if (lines.length === 0) return []
  if (lines.length === 1) {
    return [{ data: audio, duration: totalDuration, start: 0, end: totalDuration }]
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-stanza-'))
  const inputPath = path.join(temporaryDirectory, `stanza${extension}`)
  await fs.writeFile(inputPath, audio)
  const cues = wordCountAudioCues(lines, totalDuration)

  try {
    const segments: AudioSegment[] = []
    for (const [index, cue] of cues.entries()) {
      signal?.throwIfAborted()
      const segmentDuration = Math.max(0.05, cue.end - cue.start)
      const outputPath = path.join(temporaryDirectory, `line-${String(index).padStart(4, '0')}.flac`)
      await runFfmpeg(
        [
          '-y',
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          inputPath,
          '-ss',
          String(cue.start),
          '-t',
          String(segmentDuration),
          '-map',
          '0:a:0',
          '-c:a',
          'flac',
          '-ar',
          '48000',
          '-ac',
          '2',
          outputPath,
        ],
        signal,
      )
      const data = await fs.readFile(outputPath)
      if (data.length === 0) throw new Error('FFmpeg returned an empty stanza voice segment.')
      const measuredDuration = audioDurationSeconds(data)
      segments.push({
        data,
        duration: measuredDuration || segmentDuration,
        start: cue.start,
        end: cue.end,
      })
    }
    return segments
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export function audioDurationSeconds(bytes: Uint8Array): number | undefined {
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
    return wavDurationSeconds(bytes)
  }
  if (bytes.length < 8 || ascii(bytes, 0, 4) !== 'fLaC') return undefined
  let offset = 4
  while (offset + 4 <= bytes.length) {
    const header = bytes[offset]!
    const length = (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!
    offset += 4
    if (offset + length > bytes.length) return undefined
    if ((header & 0x7f) === 0 && length >= 18) {
      const sampleRate =
        bytes[offset + 10]! * 4096 +
        bytes[offset + 11]! * 16 +
        (bytes[offset + 12]! >> 4)
      const totalSamples =
        (bytes[offset + 13]! & 0x0f) * 0x1_0000_0000 +
        bytes[offset + 14]! * 0x1_000_000 +
        bytes[offset + 15]! * 0x10_000 +
        bytes[offset + 16]! * 0x100 +
        bytes[offset + 17]!
      return sampleRate > 0 && totalSamples > 0
        ? totalSamples / sampleRate
        : undefined
    }
    offset += length
    if ((header & 0x80) !== 0) break
  }
  return undefined
}

function wavDurationSeconds(bytes: Uint8Array): number | undefined {
  let offset = 12
  let byteRate: number | undefined
  let dataLength: number | undefined
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4)
    const chunkLength = uint32LittleEndian(bytes, offset + 4)
    const dataOffset = offset + 8
    if (dataOffset + chunkLength > bytes.length) return undefined
    if (chunkType === 'fmt ' && chunkLength >= 12) {
      byteRate = uint32LittleEndian(bytes, dataOffset + 8)
    } else if (chunkType === 'data') {
      dataLength = chunkLength
      break
    }
    offset = dataOffset + chunkLength + (chunkLength % 2)
  }
  return byteRate && dataLength ? dataLength / byteRate : undefined
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function uint32LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0
}

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<string> {
  const executable = process.env.FFMPEG_PATH || 'ffmpeg'
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('QWEN audio segmentation was cancelled.', 'AbortError'))
      return
    }
    const child = spawn(executable, args, { windowsHide: true })
    let stderr = ''
    let settled = false
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      child.kill()
      if (!settled) reject(new DOMException('QWEN audio segmentation was cancelled.', 'AbortError'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      settled = true
      cleanup()
      reject(new Error(`Could not start FFmpeg for QWEN audio segmentation. ${error.message}`))
    })
    child.once('close', (code) => {
      settled = true
      cleanup()
      if (code === 0) {
        resolve(stderr)
      } else {
        const message = stderr.trim().split(/\r?\n/).slice(-6).join('\n')
        reject(new Error(`FFmpeg QWEN audio segmentation failed.\n${message}`))
      }
    })
  })
}
