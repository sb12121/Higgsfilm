import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ExportResult, ProjectManifest } from '../../shared/types'
import { ProjectStore } from './projectStore'

interface FfmpegResult {
  stdout: string
  stderr: string
}

export class FfmpegExporter {
  constructor(private readonly projectStore: ProjectStore) {}

  async exportLongform(outputPath: string): Promise<ExportResult> {
    const rootPath = this.projectStore.getRootPath()
    const manifest = this.projectStore.getManifest()
    if (manifest.lines.length === 0) throw new Error('Import a script before exporting.')

    const missingImage = manifest.lines.find((line) => !line.imagePath)
    if (missingImage) {
      throw new Error(`Generate a visual for scene ${missingImage.index + 1} before exporting.`)
    }

    const tempDirectory = path.join(rootPath, `.higgsfilm-render-${Date.now()}`)
    await fs.mkdir(tempDirectory, { recursive: true })
    const segmentPaths: string[] = []
    const totalDuration = manifest.lines.reduce((sum, line) => sum + Math.max(0.1, line.duration), 0)

    try {
      for (const line of manifest.lines) {
        const segmentPath = path.join(tempDirectory, `segment-${String(line.index).padStart(4, '0')}.mp4`)
        await this.renderSegment(manifest, line, rootPath, segmentPath)
        segmentPaths.push(segmentPath)
      }

      const concatList = path.join(tempDirectory, 'concat.txt')
      const concatContents = segmentPaths
        .map((segmentPath) => `file '${segmentPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
        .join('\n')
      await fs.writeFile(concatList, concatContents, 'utf8')
      await fs.mkdir(path.dirname(outputPath), { recursive: true })

      await this.runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatList,
        '-vf',
        'format=yuv420p',
        '-af',
        `loudnorm=I=${manifest.exportSettings.audioLufs}:TP=${manifest.exportSettings.truePeak}:LRA=11`,
        '-r',
        String(manifest.exportSettings.fps),
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '18',
        '-c:a',
        'aac',
        '-ar',
        '48000',
        '-b:a',
        '192k',
        '-movflags',
        '+faststart',
        outputPath,
      ])

      return { outputPath, duration: Number(totalDuration.toFixed(2)) }
    } finally {
      await fs.rm(tempDirectory, { recursive: true, force: true })
    }
  }

  private async renderSegment(
    manifest: ProjectManifest,
    line: ProjectManifest['lines'][number],
    rootPath: string,
    outputPath: string,
  ): Promise<void> {
    const imagePath = path.resolve(rootPath, line.imagePath!)
    const duration = Math.max(0.1, line.duration)
    const audioPath = line.voicePath ? path.resolve(rootPath, line.voicePath) : null
    const audioInput = audioPath
      ? ['-i', audioPath]
      : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000']

    await this.runFfmpeg([
      '-y',
      '-loop',
      '1',
      '-i',
      imagePath,
      ...audioInput,
      '-t',
      String(duration),
      '-vf',
      `scale=${manifest.exportSettings.width}:${manifest.exportSettings.height}:force_original_aspect_ratio=increase,crop=${manifest.exportSettings.width}:${manifest.exportSettings.height}`,
      '-r',
      String(manifest.exportSettings.fps),
      '-c:v',
      'libx264',
      '-preset',
      'fast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-b:a',
      '192k',
      outputPath,
    ])
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
