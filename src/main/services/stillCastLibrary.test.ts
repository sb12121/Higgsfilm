import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveExpressionLibraryPath,
  scanProjectCustomStills,
  scanStillCastCatalog,
} from './stillCastLibrary'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('stillCastLibrary', () => {
  it('scans Custom images named after script lines without treating them as expression folders', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-custom-scan-'))
    temporaryDirectories.push(directory)
    const library = path.join(directory, 'Expressions')
    await fs.mkdir(path.join(library, 'Warm Smile'), { recursive: true })
    await fs.writeFile(path.join(library, 'Warm Smile', 'a.png'), Buffer.from('smile'))
    await fs.mkdir(path.join(directory, 'Custom'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Custom', 'One hundred dollars.png'), Buffer.from('chart'))
    await fs.mkdir(path.join(directory, 'Custom', 'ignored-subfolder'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Custom', 'ignored-subfolder', 'nope.png'), Buffer.from('nope'))

    const customs = await scanProjectCustomStills(directory)
    expect(customs.folderPath).toBe(path.join(directory, 'Custom'))
    expect(customs.stills.map((still) => still.fileName)).toEqual(['One hundred dollars.png'])
    expect(customs.stills[0]?.matchKey).toBe('one hundred dollars')

    const catalog = await scanStillCastCatalog(library, directory)
    expect(catalog.folders.map((folder) => folder.folderName)).toEqual(['Warm Smile'])
    expect(catalog.customStills?.map((still) => still.fileName)).toEqual(['One hundred dollars.png'])
    expect(catalog.trailerCustomStills).toEqual([])
  })

  it('scans Custom-9x16 stills separately from landscape Custom', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-custom-9x16-scan-'))
    temporaryDirectories.push(directory)
    const library = path.join(directory, 'Expressions')
    await fs.mkdir(path.join(library, 'Warm Smile'), { recursive: true })
    await fs.writeFile(path.join(library, 'Warm Smile', 'a.png'), Buffer.from('smile'))
    await fs.mkdir(path.join(directory, 'Custom'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Custom', 'One hundred dollars.png'), Buffer.from('wide'))
    await fs.mkdir(path.join(directory, 'Custom-9x16'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Custom-9x16', 'One hundred dollars.png'), Buffer.from('tall'))

    const trailerCustoms = await scanProjectCustomStills(directory, 'custom-9x16')
    expect(trailerCustoms.folderPath).toBe(path.join(directory, 'Custom-9x16'))
    expect(trailerCustoms.stills.map((still) => still.fileName)).toEqual(['One hundred dollars.png'])

    const catalog = await scanStillCastCatalog(library, directory)
    expect(catalog.customStills?.map((still) => still.fileName)).toEqual(['One hundred dollars.png'])
    expect(catalog.trailerCustomStills?.map((still) => still.fileName)).toEqual(['One hundred dollars.png'])
    expect(catalog.trailerCustomFolderPath).toBe(path.join(directory, 'Custom-9x16'))
  })

  it('reads Expressions from the channel folder and Custom from the project folder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-channel-stills-'))
    temporaryDirectories.push(root)
    const channel = path.join(root, 'BuxFit')
    const project = path.join(channel, 'How to Get Stronger at Home Without Weights')
    const expressions = path.join(channel, 'Expressions')
    await fs.mkdir(path.join(expressions, 'Warm Smile'), { recursive: true })
    await fs.writeFile(path.join(expressions, 'Warm Smile', 'smile.png'), Buffer.from('smile'))
    await fs.mkdir(path.join(project, 'Custom'), { recursive: true })
    await fs.writeFile(path.join(project, 'Custom', 'Bux lift tiny soup can.png'), Buffer.from('custom'))

    const resolved = await resolveExpressionLibraryPath(project, path.join(root, 'missing-library'))
    expect(resolved).toBe(expressions)

    const catalog = await scanStillCastCatalog(path.join(root, 'missing-library'), project)
    expect(catalog.libraryPath).toBe(expressions)
    expect(catalog.folders.map((folder) => folder.folderName)).toEqual(['Warm Smile'])
    expect(catalog.customFolderPath).toBe(path.join(project, 'Custom'))
    expect(catalog.customStills?.map((still) => still.fileName)).toEqual(['Bux lift tiny soup can.png'])
  })
})
