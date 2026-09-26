import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureImageExportResolution, readPngSize } from './imageUpscale'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

const spawnMock = vi.mocked(spawn)

function pngWithSize(width: number, height: number, payload = 'pixel'): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(width, 0)
  ihdrData.writeUInt32BE(height, 4)
  ihdrData[8] = 8
  ihdrData[9] = 2
  const ihdr = Buffer.concat([
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR'),
    ihdrData,
    Buffer.alloc(4),
  ])
  return Buffer.concat([signature, ihdr, Buffer.from(payload)])
}

afterEach(() => {
  spawnMock.mockReset()
})

describe('imageUpscale', () => {
  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(readPngSize(pngWithSize(1920, 1080))).toEqual({ width: 1920, height: 1080 })
    expect(readPngSize(Buffer.from([1, 2, 3, 4]))).toBeNull()
  })

  it('leaves 4K PNGs unchanged', async () => {
    const source = pngWithSize(3840, 2160, 'already-4k')
    const result = await ensureImageExportResolution(source, '16:9')
    expect(result.upscaled).toBe(false)
    expect(result.data).toBe(source)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('upscales smaller ComfyUI stills onto the 4K export canvas', async () => {
    spawnMock.mockImplementation((_executable, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      })
      const outputPath = String(args[args.length - 1])
      writeFileSync(outputPath, pngWithSize(3840, 2160, 'scaled'))
      queueMicrotask(() => child.emit('close', 0))
      return child as unknown as ReturnType<typeof spawn>
    })

    const result = await ensureImageExportResolution(pngWithSize(1920, 1080, 'hd'), '16:9')
    expect(result.upscaled).toBe(true)
    expect(readPngSize(result.data)).toEqual({ width: 3840, height: 2160 })
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '-vf',
        'scale=3840:2160:force_original_aspect_ratio=increase:flags=lanczos,crop=3840:2160',
      ]),
    )
  })

  it('uses the vertical 4K canvas for trailer stills', async () => {
    spawnMock.mockImplementation((_executable, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      })
      const outputPath = String(args[args.length - 1])
      writeFileSync(outputPath, pngWithSize(2160, 3840, 'scaled'))
      queueMicrotask(() => child.emit('close', 0))
      return child as unknown as ReturnType<typeof spawn>
    })

    const result = await ensureImageExportResolution(pngWithSize(1080, 1920, 'hd'), '9:16')
    expect(result.upscaled).toBe(true)
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining([
        '-vf',
        'scale=2160:3840:force_original_aspect_ratio=increase:flags=lanczos,crop=2160:3840',
      ]),
    )
  })
})
