import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const createFromPath = vi.fn()
const resize = vi.fn()
const toJPEG = vi.fn()
const getSize = vi.fn()
const isEmpty = vi.fn()

vi.mock('electron', () => ({
  nativeImage: {
    createFromPath: (...args: unknown[]) => createFromPath(...args),
  },
}))

import { DEFAULT_THUMB_MAX_EDGE, imageThumbDataUrl, THUMB_CACHE_DIRECTORY } from './assetThumb'

const temporaryDirectories: string[] = []

afterEach(async () => {
  createFromPath.mockReset()
  resize.mockReset()
  toJPEG.mockReset()
  getSize.mockReset()
  isEmpty.mockReset()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('imageThumbDataUrl', () => {
  it('creates a resized JPEG thumb and reuses the disk cache', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-thumb-'))
    temporaryDirectories.push(root)
    const sourcePath = path.join(root, 'scene.png')
    await fs.writeFile(sourcePath, Buffer.from('fake-png'))

    isEmpty.mockReturnValue(false)
    getSize.mockReturnValue({ width: 3840, height: 2160 })
    toJPEG.mockReturnValue(Buffer.from('thumb-jpeg'))
    resize.mockReturnValue({
      toJPEG,
    })
    createFromPath.mockReturnValue({
      isEmpty,
      getSize,
      resize,
    })

    const first = await imageThumbDataUrl(root, sourcePath, DEFAULT_THUMB_MAX_EDGE)
    expect(first?.mimeType).toBe('image/jpeg')
    expect(first?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(resize).toHaveBeenCalledWith({ width: DEFAULT_THUMB_MAX_EDGE, quality: 'better' })
    expect(createFromPath).toHaveBeenCalledTimes(1)

    const cacheFiles = await fs.readdir(path.join(root, THUMB_CACHE_DIRECTORY))
    expect(cacheFiles).toHaveLength(1)

    const second = await imageThumbDataUrl(root, sourcePath, DEFAULT_THUMB_MAX_EDGE)
    expect(second?.dataUrl).toBe(first?.dataUrl)
    expect(createFromPath).toHaveBeenCalledTimes(1)
  })

  it('skips resize when the source already fits the thumb edge', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-thumb-small-'))
    temporaryDirectories.push(root)
    const sourcePath = path.join(root, 'small.png')
    await fs.writeFile(sourcePath, Buffer.from('small-png'))

    isEmpty.mockReturnValue(false)
    getSize.mockReturnValue({ width: 320, height: 180 })
    toJPEG.mockReturnValue(Buffer.from('small-jpeg'))
    createFromPath.mockReturnValue({
      isEmpty,
      getSize,
      resize,
      toJPEG,
    })

    const result = await imageThumbDataUrl(root, sourcePath, 512)
    expect(result?.mimeType).toBe('image/jpeg')
    expect(resize).not.toHaveBeenCalled()
    expect(toJPEG).toHaveBeenCalledWith(78)
  })
})
