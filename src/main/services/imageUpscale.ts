import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AspectRatio } from '../../shared/types'
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_TRAILER_EXPORT_SETTINGS } from '../../shared/types'

export function exportCanvasForAspect(aspect: AspectRatio): { width: number; height: number } {
  return aspect === '9:16'
    ? {
        width: DEFAULT_TRAILER_EXPORT_SETTINGS.width,
        height: DEFAULT_TRAILER_EXPORT_SETTINGS.height,
      }
    : {
        width: DEFAULT_EXPORT_SETTINGS.width,
        height: DEFAULT_EXPORT_SETTINGS.height,
      }
}

export function readPngSize(data: Buffer): { width: number; height: number } | null {
  if (data.length < 24) return null
  if (data[0] !== 0x89 || data.toString('ascii', 1, 4) !== 'PNG') return null
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  }
}

export async function ensureImageExportResolution(
  data: Buffer,
  aspect: AspectRatio,
  extension = 'png',
): Promise<{ data: Buffer; upscaled: boolean }> {
  const { width, height } = exportCanvasForAspect(aspect)
  const size = readPngSize(data)
  if (!size) return { data, upscaled: false }
  if (size.width === width && size.height === height) return { data, upscaled: false }

  const scaled = await scaleImageWithFfmpeg(data, extension, width, height)
  return { data: scaled, upscaled: true }
}

export async function ensurePngExportCanvas(
  data: Buffer,
  sourceExtension: string,
  aspect: AspectRatio,
): Promise<Buffer> {
  const { width, height } = exportCanvasForAspect(aspect)
  const normalized = sourceExtension.replace(/^\./, '').toLowerCase() || 'png'
  const size = normalized === 'png' ? readPngSize(data) : null
  if (size?.width === width && size.height === height) return data
  return scaleImageWithFfmpeg(data, normalized, width, height, 'png')
}

async function scaleImageWithFfmpeg(
  data: Buffer,
  extension: string,
  width: number,
  height: number,
  outputExtension = extension,
): Promise<Buffer> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-upscale-'))
  const suffix = extension.replace(/^\./, '') || 'png'
  const outputSuffix = outputExtension.replace(/^\./, '') || suffix
  const inputPath = path.join(directory, `input.${suffix}`)
  const outputPath = path.join(directory, `output-${randomUUID()}.${outputSuffix}`)
  try {
    await fs.writeFile(inputPath, data)
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-vf',
      `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`,
      outputPath,
    ])
    return await fs.readFile(outputPath)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const REFERENCE_MAX_EDGE = 1536

export async function normalizeReferenceImage(sourcePath: string, destinationPath: string): Promise<void> {
  await runFfmpeg([
    '-y',
    '-i',
    sourcePath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${REFERENCE_MAX_EDGE}:${REFERENCE_MAX_EDGE}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-pix_fmt',
    'yuv420p',
    '-q:v',
    '2',
    '-update',
    '1',
    destinationPath,
  ])
  const data = await fs.readFile(destinationPath)
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) {
    throw new Error(`Reference image could not be prepared for Codex: ${sourcePath}`)
  }
}

function runFfmpeg(args: string[]): Promise<void> {
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
        resolve()
        return
      }
      const lastLines = stderr.trim().split(/\r?\n/).slice(-8).join('\n')
      reject(new Error(`FFmpeg image upscale failed.\n${lastLines}`))
    })
  })
}
