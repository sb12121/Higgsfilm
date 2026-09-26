import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { nativeImage } from 'electron'
import type { AssetData } from '../../shared/types'

export const THUMB_CACHE_DIRECTORY = '.higgsfilm-thumbs'
export const DEFAULT_THUMB_MAX_EDGE = 512

export async function imageThumbDataUrl(
  rootPath: string,
  absolutePath: string,
  maxEdge = DEFAULT_THUMB_MAX_EDGE,
): Promise<AssetData | null> {
  try {
    const stats = await fs.stat(absolutePath)
    if (!stats.isFile() || stats.size === 0) return null

    const cacheKey = createHash('sha1')
      .update(`${absolutePath}:${stats.size}:${Math.round(stats.mtimeMs)}:${maxEdge}`)
      .digest('hex')
    const cachePath = path.join(rootPath, THUMB_CACHE_DIRECTORY, `${cacheKey}.jpg`)

    try {
      const cached = await fs.readFile(cachePath)
      if (cached.length > 0) {
        return { dataUrl: `data:image/jpeg;base64,${cached.toString('base64')}`, mimeType: 'image/jpeg' }
      }
    } catch {
      // Cache miss — build a fresh thumb below.
    }

    const image = nativeImage.createFromPath(absolutePath)
    if (image.isEmpty()) return null

    const { width, height } = image.getSize()
    const longest = Math.max(width, height, 1)
    const resized =
      longest <= maxEdge
        ? image
        : image.resize(
            width >= height
              ? { width: maxEdge, quality: 'better' }
              : { height: maxEdge, quality: 'better' },
          )

    const jpeg = resized.toJPEG(78)
    await fs.mkdir(path.dirname(cachePath), { recursive: true })
    await fs.writeFile(cachePath, jpeg)
    return { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`, mimeType: 'image/jpeg' }
  } catch {
    return null
  }
}
