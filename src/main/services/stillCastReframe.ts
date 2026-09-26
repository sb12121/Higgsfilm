import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface PixelCrop {
  width: number
  height: number
  x: number
  y: number
}

const CONTENT_PAD_RATIO = 0.08
const FRAME_MARGIN = 0.08
const ASPECT_MATCH_TOLERANCE = 0.08

export function parseCropdetect(stderr: string): PixelCrop | null {
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)]
  const last = matches.at(-1)
  if (!last) return null
  const width = Number(last[1])
  const height = Number(last[2])
  const x = Number(last[3])
  const y = Number(last[4])
  if (![width, height, x, y].every((value) => Number.isFinite(value) && value >= 0)) return null
  if (width < 2 || height < 2) return null
  return { width, height, x, y }
}

export function parseVideoSize(stderr: string): { width: number; height: number } | null {
  const match = stderr.match(/Stream #0:\d[^,]*Video:[^\n]*?(\d{2,5})x(\d{2,5})/)
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) return null
  return { width, height }
}

export function evenDimension(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2)
}

export function expandCrop(crop: PixelCrop, sourceWidth: number, sourceHeight: number): PixelCrop {
  const pad = Math.max(crop.width, crop.height) * CONTENT_PAD_RATIO
  const x = evenDimension(Math.max(0, crop.x - pad))
  const y = evenDimension(Math.max(0, crop.y - pad))
  const width = evenDimension(Math.min(sourceWidth - x, crop.width + pad * 2))
  const height = evenDimension(Math.min(sourceHeight - y, crop.height + pad * 2))
  return { width, height, x, y }
}

export function aspectRatio(width: number, height: number): number {
  return width / Math.max(height, 1)
}

export function containPadFilter(width: number, height: number): string {
  return [
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:white`,
    'setsar=1',
  ].join(',')
}

export function reframeStillFilter(
  crop: PixelCrop | null,
  targetWidth: number,
  targetHeight: number,
): string {
  const innerWidth = evenDimension(targetWidth * (1 - FRAME_MARGIN * 2))
  const innerHeight = evenDimension(targetHeight * (1 - FRAME_MARGIN * 2))
  const parts = [
    crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}` : null,
    `scale=${innerWidth}:${innerHeight}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:white`,
    'setsar=1',
  ]
  return parts.filter(Boolean).join(',')
}

export async function reframeStillToCanvas(
  sourcePath: string,
  destinationPath: string,
  width: number,
  height: number,
): Promise<void> {
  const probe = await runFfmpeg([
    '-i',
    sourcePath,
    '-vf',
    'format=rgb24,negate,cropdetect=limit=32:round=2:reset=0',
    '-frames:v',
    '1',
    '-f',
    'null',
    '-',
  ])
  const sourceSize = parseVideoSize(probe.stderr)
  const detected = parseCropdetect(probe.stderr)
  const sourceAspect = sourceSize ? aspectRatio(sourceSize.width, sourceSize.height) : null
  const targetAspect = aspectRatio(width, height)
  const aspectAlreadyMatches =
    sourceAspect !== null && Math.abs(sourceAspect - targetAspect) / targetAspect <= ASPECT_MATCH_TOLERANCE
  const crop =
    !aspectAlreadyMatches && detected && sourceSize
      ? expandCrop(detected, sourceSize.width, sourceSize.height)
      : null
  const filter = reframeStillFilter(crop, width, height)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-reframe-'))
  const suffix = path.extname(destinationPath).replace(/^\./, '') || 'png'
  const outputPath = path.join(directory, `output-${randomUUID()}.${suffix}`)
  try {
    await runFfmpeg(['-y', '-i', sourcePath, '-vf', filter, outputPath])
    await fs.mkdir(path.dirname(destinationPath), { recursive: true })
    await fs.copyFile(outputPath, destinationPath)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

function runFfmpeg(args: string[]): Promise<{ stderr: string }> {
  const executable = process.env.FFMPEG_PATH || 'ffmpeg'
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      reject(
        new Error(`Could not start FFmpeg. Install FFmpeg or set FFMPEG_PATH. ${error.message}`),
      )
    })
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stderr })
        return
      }
      const lastLines = stderr.trim().split(/\r?\n/).slice(-8).join('\n')
      reject(new Error(`FFmpeg still reframe failed.\n${lastLines}`))
    })
  })
}
