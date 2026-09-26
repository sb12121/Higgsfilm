import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_COMFY_UI_SETTINGS } from '../../shared/types'
import { AppSettingsStore } from './appSettingsStore'
import { ExpressionImageClient, resolveExpressionImageGuide } from './expressionImageClient'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('resolveExpressionImageGuide', () => {
  it.each([
    ['BuxFit', 'Tools - Regenerate Expressions.txt'],
    ['PaperCollage', 'Bux_PaperCollage_Image_Generation_Master_Prompt.txt'],
  ])('finds the expression guide in %s/%s above the library', async (folder, fileName) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-expression-guide-'))
    temporaryDirectories.push(root)
    const library = path.join(root, 'BuxFit', 'Expressions')
    const guide = path.join(root, folder, fileName)
    await fs.mkdir(path.dirname(guide), { recursive: true })
    await fs.mkdir(library, { recursive: true })
    await fs.writeFile(guide, 'guide', 'utf8')

    await expect(resolveExpressionImageGuide(library)).resolves.toBe(guide)
  })
})

describe('ExpressionImageClient', () => {
  it('writes three 4K frames and one shared plate for the chosen expression', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-expression-gen-'))
    temporaryDirectories.push(directory)
    const library = path.join(directory, 'Expressions')
    await fs.mkdir(path.join(library, 'Concerned'), { recursive: true })
    const guide = path.join(directory, 'Bux_PaperCollage_Image_Generation_Master_Prompt.txt')
    await fs.writeFile(guide, 'Pose: [EXPRESSION / POSE]\n', 'utf8')
    const sheet = path.join(directory, 'character sheet.png')
    const face = path.join(directory, 'face.jpg')
    const background = path.join(directory, 'plate.png')
    const png = pngWithSize(3840, 2160)
    await fs.writeFile(sheet, png)
    await fs.writeFile(face, png)
    await fs.writeFile(background, png)

    const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
    await settings.load()
    await settings.save({
      ...settings.get(),
      customImageCharacterSheetPath: sheet,
      customImageReferencePaths: [face],
      expressionGuidePath: guide,
      expressionBackgroundPath: background,
    })
    await settings.saveChannelProfile({
      name: 'BuxFit',
      visualBible: {
        name: 'BuxFit',
        style: 'Paper collage.',
        characters: 'Bux.',
        mainCharacter: 'Athletic Bux.',
        supportingCharacter: '',
        setting: 'Craft paper.',
        palette: 'Gold and black.',
        camera: 'Full body.',
        negativePrompt: 'Photorealism.',
      },
      imageGenerator: 'higgsfield',
      comfy: DEFAULT_COMFY_UI_SETTINGS,
      productionMode: 'still-cast',
      channelFolderPath: directory,
      stillLibraryPath: library,
    })
    const codex = {
      generateImage: vi.fn(async () => ({ data: png, extension: 'png' })),
      cancelImageGeneration: vi.fn(async () => undefined),
    }
    const client = new ExpressionImageClient(settings, codex)

    const result = await client.generate({ expressions: ['Concerned'] })

    expect(result.stopped).toBe(false)
    expect(result.written).toHaveLength(3)
    expect(codex.generateImage).toHaveBeenCalledTimes(3)
    expect(codex.generateImage).toHaveBeenNthCalledWith(1, {
      prompt: expect.stringContaining('Concerned. Alternative 01 of 3.'),
      aspectRatio: '16:9',
      referenceImagePaths: [face],
      characterSheetPath: sheet,
      backgroundImagePath: background,
    })
    const frame = await fs.readFile(path.join(library, 'Concerned', '01.png'))
    const plate = await fs.readFile(path.join(library, 'Concerned', '_bg_plate.png'))
    expect(frame.equals(png)).toBe(true)
    expect(plate.equals(png)).toBe(true)
  })
})

function pngWithSize(width: number, height: number): Buffer {
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
  return Buffer.concat([signature, ihdr, Buffer.from('pixel')])
}
