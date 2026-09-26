import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  containPadFilter,
  expandCrop,
  parseCropdetect,
  parseVideoSize,
  reframeStillFilter,
  reframeStillToCanvas,
} from './stillCastReframe'

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

const spawnMock = vi.mocked(spawn)
const temporaryDirectories: string[] = []

afterEach(async () => {
  spawnMock.mockReset()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('stillCastReframe', () => {
  it('parses the last cropdetect window and expands it inside the source', () => {
    const stderr = [
      'Stream #0:0: Video: png, rgb24, 3840x2160',
      '[Parsed_cropdetect_1 @ 0x] crop=1200:1600:1300:280',
      '[Parsed_cropdetect_1 @ 0x] crop=1280:1680:1260:240',
    ].join('\n')
    expect(parseVideoSize(stderr)).toEqual({ width: 3840, height: 2160 })
    expect(parseCropdetect(stderr)).toEqual({ width: 1280, height: 1680, x: 1260, y: 240 })
    expect(expandCrop({ width: 1280, height: 1680, x: 1260, y: 240 }, 3840, 2160)).toEqual({
      width: 1548,
      height: 1948,
      x: 1126,
      y: 106,
    })
  })

  it('fits the detected character into a 9:16 canvas and pads the rest with white', () => {
    expect(
      reframeStillFilter({ width: 1400, height: 1800, x: 1200, y: 180 }, 2160, 3840),
    ).toBe(
      'crop=1400:1800:1200:180,scale=1814:3226:force_original_aspect_ratio=decrease:flags=lanczos,pad=2160:3840:(ow-iw)/2:(oh-ih)/2:white,setsar=1',
    )
    expect(containPadFilter(2160, 3840)).toBe(
      'scale=2160:3840:force_original_aspect_ratio=decrease:flags=lanczos,pad=2160:3840:(ow-iw)/2:(oh-ih)/2:white,setsar=1',
    )
  })

  it('crops a 16:9 expression to the character, then pads to 9:16', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'higgsfilm-reframe-'))
    temporaryDirectories.push(directory)
    const sourcePath = path.join(directory, 'smile.png')
    const destinationPath = path.join(directory, 'vertical.png')
    await writeFile(sourcePath, Buffer.from('source-still'))
    spawnMock.mockImplementation((_executable, args) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
      })
      const vf = String(args[args.indexOf('-vf') + 1] || '')
      queueMicrotask(() => {
        if (vf.includes('cropdetect')) {
          child.stderr.emit(
            'data',
            Buffer.from(
              'Stream #0:0: Video: png, rgb24, 3840x2160\ncrop=1280:1680:1260:240\n',
            ),
          )
        } else {
          writeFileSync(String(args[args.length - 1]), Buffer.from('vertical-still'))
        }
        child.emit('close', 0)
      })
      return child as unknown as ReturnType<typeof spawn>
    })

    await reframeStillToCanvas(sourcePath, destinationPath, 2160, 3840)
    const filter = spawnMock.mock.calls[1]?.[1]
    expect(filter).toEqual(
      expect.arrayContaining([
        '-vf',
        'crop=1548:1948:1126:106,scale=1814:3226:force_original_aspect_ratio=decrease:flags=lanczos,pad=2160:3840:(ow-iw)/2:(oh-ih)/2:white,setsar=1',
      ]),
    )
  })
})
