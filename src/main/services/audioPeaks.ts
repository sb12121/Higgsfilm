import { spawn } from 'node:child_process'

const PEAK_SAMPLE_RATE = 8000

export async function computeAudioPeaks(
  absolutePath: string,
  bucketCount: number,
): Promise<number[]> {
  const samples = await decodeMonoFloat32(absolutePath)
  return bucketPeaks(samples, Math.max(1, Math.floor(bucketCount)))
}

export function bucketPeaks(samples: Float32Array, bucketCount: number): number[] {
  if (samples.length === 0) {
    return Array.from({ length: bucketCount }, () => 0)
  }
  const peaks: number[] = []
  const samplesPerBucket = Math.max(1, Math.floor(samples.length / bucketCount))
  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = bucket * samplesPerBucket
    const end = Math.min(samples.length, start + samplesPerBucket)
    let peak = 0
    for (let index = start; index < end; index += 1) {
      const value = Math.abs(samples[index] || 0)
      if (value > peak) peak = value
    }
    peaks.push(peak)
  }
  const maxPeak = peaks.reduce((highest, value) => Math.max(highest, value), 0.001)
  return peaks.map((value) => value / maxPeak)
}

function decodeMonoFloat32(absolutePath: string): Promise<Float32Array> {
  const executable = process.env.FFMPEG_PATH || 'ffmpeg'
  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-i',
        absolutePath,
        '-ac',
        '1',
        '-ar',
        String(PEAK_SAMPLE_RATE),
        '-f',
        'f32le',
        'pipe:1',
      ],
      { windowsHide: true },
    )
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
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
      if (code !== 0) {
        const lastLines = stderr.trim().split(/\r?\n/).slice(-8).join('\n')
        reject(new Error(`FFmpeg waveform decode failed.\n${lastLines}`))
        return
      }
      const buffer = Buffer.concat(chunks)
      if (buffer.byteLength < 4) {
        resolve(new Float32Array())
        return
      }
      const alignedLength = Math.floor(buffer.byteLength / 4) * 4
      const copy = Buffer.allocUnsafe(alignedLength)
      buffer.copy(copy, 0, 0, alignedLength)
      resolve(
        new Float32Array(
          copy.buffer,
          copy.byteOffset,
          Math.floor(alignedLength / 4),
        ),
      )
    })
  })
}
