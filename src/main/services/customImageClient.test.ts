import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppSettingsStore } from './appSettingsStore'
import { CustomImageClient, resolveCustomImageGuide } from './customImageClient'
import { ProjectStore } from './projectStore'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  )
})

describe('resolveCustomImageGuide', () => {
  it.each(['Visual Direction - Custom Images 16x9.txt', 'Bux_Custom_Image_Generation_Prompt.txt'])('finds %s by walking up from the episode folder', async (fileName) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-guide-'))
    temporaryDirectories.push(root)
    const episode = path.join(root, 'Buxfinance', 'Why Does Money Lose Value')
    await fs.mkdir(episode, { recursive: true })
    const guide = path.join(root, fileName)
    await fs.writeFile(guide, 'guide', 'utf8')

    await expect(resolveCustomImageGuide(episode)).resolves.toBe(guide)
  })
})

describe('CustomImageClient', () => {
  it('writes one 16:9 custom still into the project Custom folder and assigns it', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-custom-gen-'))
    temporaryDirectories.push(directory)
    await fs.mkdir(path.join(directory, 'Expressions', 'Neutral'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Expressions', 'Neutral', '01.png'), pngWithSize(64, 64))
    const guide = path.join(directory, 'Bux_Custom_Image_Generation_Prompt.txt')
    await fs.writeFile(guide, 'Spoken line:\n[SPOKEN LINE]\n', 'utf8')
    const reference = path.join(directory, 'bux-reference.png')
    const characterSheet = path.join(directory, 'character sheet.png')
    await fs.writeFile(reference, pngWithSize(64, 64))
    await fs.writeFile(characterSheet, pngWithSize(64, 64))

    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const imported = await projectStore.importScriptText('Custom: Bux looks at wallet.', 'main', 'stanzas')
    const line = imported.manifest.lines[0]!
    const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
    await settings.load()
    await settings.save({
      ...settings.get(),
      customImageGuidePath: guide,
      customImageCharacterSheetPath: characterSheet,
      customImageReferencePaths: [reference],
    })
    const generated = pngWithSize(3840, 2160)
    const codex = {
      generateImage: vi.fn(async () => ({ data: generated, extension: 'png' })),
      cancelImageGeneration: vi.fn(async () => undefined),
    }
    const client = new CustomImageClient(projectStore, settings, codex)

    const { state, stopped } = await client.generate({ lineIds: [line.id] })
    expect(stopped).toBe(false)

    expect(codex.generateImage).toHaveBeenCalledWith({
      prompt: expect.stringContaining('Bux looks at wallet.'),
      aspectRatio: '16:9',
      referenceImagePaths: [reference],
      characterSheetPath: characterSheet,
    })
    const saved = await fs.readFile(path.join(directory, 'Custom', 'Bux looks at wallet.png'))
    expect(saved.equals(generated)).toBe(true)
    expect(state.manifest.lines[0]?.imagePath).toMatch(/^stills\/001\//)
    expect(state.manifest.lines[0]?.stillBeats?.[0]?.expression).toBe('custom')
  })

  it('skips current images and regenerates an image after its shot note changes', async () => {
    const fixture = await createFixture('Custom: Bux opens a letter.')
    const { client, projectStore, codex, line } = fixture
    await client.generate({ lineIds: [line.id] })
    await expect(client.generate({ lineIds: [line.id], onlyMissing: true })).rejects.toThrow('Every Custom line')
    expect(codex.generateImage).toHaveBeenCalledTimes(1)

    const state = projectStore.get()!
    await projectStore.save({
      ...state.manifest,
      lines: state.manifest.lines.map((candidate) => candidate.id === line.id
        ? { ...candidate, shotNote: 'A close view of the open envelope.' }
        : candidate),
    })
    expect((await client.getSetup()).stills).toEqual([{ lineId: line.id, status: 'stale' }])
    await client.generate({ lineIds: [line.id], onlyMissing: true })
    expect(codex.generateImage).toHaveBeenCalledTimes(2)
  })

  it('assigns the newly generated PNG when an older matching JPG exists', async () => {
    const { client, projectStore, directory, line } = await createFixture('Custom: Bux opens a letter.')
    const customFolder = path.join(directory, 'Custom')
    await fs.mkdir(customFolder, { recursive: true })
    const oldImage = pngWithSize(64, 64)
    const oldPath = path.join(customFolder, 'Bux opens a letter.jpg')
    await fs.writeFile(oldPath, oldImage)

    await client.generate({ lineIds: [line.id] })

    const assignedPath = projectStore.get()!.manifest.lines[0]!.imagePath!
    expect(await fs.readFile(path.join(directory, assignedPath))).toEqual(pngWithSize(3840, 2160))
    expect(await fs.readFile(oldPath)).toEqual(oldImage)
    expect((await client.getSetup()).stills).toEqual([{ lineId: line.id, status: 'current' }])
  })

  it('leaves imported images with no valid ledger usable as unknown', async () => {
    const fixture = await createFixture('Custom: Bux waits at the door.')
    const { client, directory, line, codex } = fixture
    const customFolder = path.join(directory, 'Custom')
    await fs.mkdir(customFolder, { recursive: true })
    await fs.writeFile(path.join(customFolder, 'Bux waits at the door.png'), pngWithSize(64, 64))
    expect((await client.getSetup()).stills).toEqual([{ lineId: line.id, status: 'unknown' }])
    await expect(client.generate({ lineIds: [line.id], onlyMissing: true })).rejects.toThrow('Every Custom line')
    expect(codex.generateImage).not.toHaveBeenCalled()
  })

  it('does not save or assign a deferred result after the project changes, and blocks overlap', async () => {
    const fixture = await createFixture('Custom: Bux checks the clock.')
    const { client, projectStore, directory, codex, line } = fixture
    let finish!: (value: { data: Buffer; extension: string }) => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    codex.generateImage.mockImplementation(() => new Promise((resolve) => {
      finish = resolve
      started()
    }))
    const generation = client.generate({ lineIds: [line.id] })
    await startedPromise
    await expect(client.generate({ lineIds: [line.id] })).rejects.toThrow('already running')

    const secondDirectory = path.join(directory, 'other-project')
    await fs.mkdir(secondDirectory, { recursive: true })
    await projectStore.close()
    await projectStore.open(secondDirectory)
    finish({ data: pngWithSize(3840, 2160), extension: 'png' })
    await expect(generation).rejects.toThrow('changed during generation')
    await expect(fs.access(path.join(directory, 'Custom', 'Bux checks the clock.png'))).rejects.toThrow()
    expect(projectStore.get()?.rootPath).toBe(secondDirectory)
  })

  it('discards a deferred result when its shot note changes', async () => {
    const fixture = await createFixture('Custom: Bux watches the rain.')
    const { client, projectStore, directory, codex, line } = fixture
    await client.generate({ lineIds: [line.id] })
    const outputPath = path.join(directory, 'Custom', 'Bux watches the rain.png')
    const originalOutput = await fs.readFile(outputPath)
    const originalImagePath = projectStore.get()?.manifest.lines[0]?.imagePath
    let finish!: (value: { data: Buffer; extension: string }) => void
    let started!: () => void
    const startedPromise = new Promise<void>((resolve) => { started = resolve })
    codex.generateImage.mockImplementation(() => new Promise((resolve) => {
      finish = resolve
      started()
    }))
    const generation = client.generate({ lineIds: [line.id] })
    await startedPromise
    const state = projectStore.get()!
    await projectStore.save({
      ...state.manifest,
      lines: state.manifest.lines.map((candidate) => candidate.id === line.id
        ? { ...candidate, shotNote: 'Rain streaks on the window.' }
        : candidate),
    })
    finish({ data: pngWithSize(3840, 2160), extension: 'png' })
    await expect(generation).rejects.toThrow('changed during generation')
    expect((await fs.readFile(outputPath)).equals(originalOutput)).toBe(true)
    expect(projectStore.get()?.manifest.lines[0]?.imagePath).toBe(originalImagePath)
  })

  it('does not assign into a project opened while its guarded copy is pending', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-custom-assign-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    await fs.mkdir(path.join(directory, 'Expressions', 'Neutral'), { recursive: true })
    await fs.writeFile(path.join(directory, 'Expressions', 'Neutral', '01.png'), pngWithSize(64, 64))
    const imported = await projectStore.importScriptText('Custom: Bux finds a key.', 'main', 'stanzas')
    const line = imported.manifest.lines[0]!
    const customFolder = path.join(directory, 'Custom')
    await fs.mkdir(customFolder, { recursive: true })
    await fs.writeFile(path.join(customFolder, 'Bux finds a key.png'), pngWithSize(64, 64))

    let copied!: () => void
    let release!: () => void
    const copiedPromise = new Promise<void>((resolve) => { copied = resolve })
    const copyGate = new Promise<void>((resolve) => { release = resolve })
    const copyFile = fs.copyFile.bind(fs)
    const copySpy = vi.spyOn(fs, 'copyFile').mockImplementation(async (source, destination, mode) => {
      await copyFile(source, destination, mode)
      if (String(destination).includes(`${path.sep}stills${path.sep}`)) {
        copied()
        await copyGate
      }
    })
    try {
      const assigning = projectStore.assignCustomImageIfCurrent({
        expectedRootPath: directory,
        expectedProjectId: imported.manifest.id,
        lineId: line.id,
        expectedLineText: line.text,
        validateSource: async () => true,
        validateContext: () => true,
      })
      await copiedPromise
      const otherDirectory = path.join(directory, 'other-project')
      await fs.mkdir(otherDirectory, { recursive: true })
      await projectStore.close()
      await projectStore.open(otherDirectory)
      release()
      await expect(assigning).rejects.toThrow('changed before assignment')
      expect(projectStore.get()?.rootPath).toBe(otherDirectory)
      expect(projectStore.get()?.manifest.lines).toHaveLength(0)
      await expect(fs.readdir(path.join(directory, 'stills', '001'))).resolves.toEqual([])
    } finally {
      release()
      copySpy.mockRestore()
    }
  })
})

async function createFixture(script: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-custom-test-'))
  temporaryDirectories.push(directory)
  await fs.mkdir(path.join(directory, 'Expressions', 'Neutral'), { recursive: true })
  await fs.writeFile(path.join(directory, 'Expressions', 'Neutral', '01.png'), pngWithSize(64, 64))
  const guide = path.join(directory, 'guide.txt')
  const reference = path.join(directory, 'reference.png')
  const characterSheet = path.join(directory, 'character.png')
  await fs.writeFile(guide, 'Spoken line: [SPOKEN LINE]', 'utf8')
  await fs.writeFile(reference, pngWithSize(64, 64))
  await fs.writeFile(characterSheet, pngWithSize(64, 64))
  const projectStore = new ProjectStore()
  await projectStore.open(directory)
  const imported = await projectStore.importScriptText(script, 'main', 'stanzas')
  const line = imported.manifest.lines[0]!
  const settings = new AppSettingsStore(path.join(directory, 'settings.json'))
  await settings.load()
  await settings.save({ ...settings.get(), customImageGuidePath: guide, customImageCharacterSheetPath: characterSheet, customImageReferencePaths: [reference] })
  const codex = {
    generateImage: vi.fn(async () => ({ data: pngWithSize(3840, 2160), extension: 'png' })),
    cancelImageGeneration: vi.fn(async () => undefined),
  }
  return { client: new CustomImageClient(projectStore, settings, codex), projectStore, directory, line, codex }
}

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
