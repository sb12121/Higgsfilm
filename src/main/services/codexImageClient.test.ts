import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeGenerationPrompt, composeScenePrompt } from '../../shared/promptComposer'
import type { GenerateSceneInput } from '../../shared/types'
import { CodexImageClient } from './codexImageClient'
import { ProjectStore } from './projectStore'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

describe('CodexImageClient', () => {
  it('saves a generated image through the shared project image workflow', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-codex-image-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const withScript = await projectStore.importScriptText('A golden retriever waits by the door.')
    const line = withScript.manifest.lines[0]
    const scenePrompt = composeScenePrompt(
      line.text,
      'A golden retriever waits beside a red door.',
    )
    const input: GenerateSceneInput = {
      lineId: line.id,
      prompt: scenePrompt,
      modelEndpoint: 'chatgpt-image-generation',
      aspectRatio: '16:9',
      resolution: '1k',
    }
    const codex = {
      generateImage: vi.fn(async () => ({
        data: Buffer.from('generated-image'),
        extension: 'png',
      })),
    }
    const client = new CodexImageClient(projectStore, codex as never)

    await client.queueScene(input)
    await vi.waitFor(() => {
      expect(projectStore.get()!.manifest.lines[0].sceneStatus).toBe('complete')
    })

    const savedLine = projectStore.get()!.manifest.lines[0]
    expect(codex.generateImage).toHaveBeenCalledWith({
      prompt: composeGenerationPrompt(scenePrompt, projectStore.get()!.manifest.visualBible),
      aspectRatio: '16:9',
    })
    expect(savedLine.imageGenerator).toBe('chatgpt')
    expect(savedLine.imagePath).toBe('scenes/001/image-01.png')
    await expect(fs.readFile(path.join(directory, savedLine.imagePath!))).resolves.toEqual(Buffer.from('generated-image'))
  })

  it('marks stale queued ChatGPT scenes as cancelled even without an in-memory queue', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-codex-cancel-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const state = await projectStore.importScriptText('A golden retriever waits by the door.')
    const line = state.manifest.lines[0]
    line.imageGenerator = 'chatgpt'
    line.sceneStatus = 'queued'
    await projectStore.save(state.manifest)
    expect(projectStore.get()!.manifest.lines[0].imageGenerator).toBe('chatgpt')
    expect(projectStore.get()!.manifest.lines[0].sceneStatus).toBe('queued')
    const codex = {
      generateImage: vi.fn(),
      cancelImageGeneration: vi.fn(),
    }
    const client = new CodexImageClient(projectStore, codex as never)

    await client.cancelQueuedScenes()

    const cancelledLine = projectStore.get()!.manifest.lines[0]
    expect(codex.cancelImageGeneration).toHaveBeenCalledOnce()
    expect(cancelledLine.sceneStatus).toBe('failed')
    expect(cancelledLine.error).toContain('cancelled')
  })

  it('routes a trailer image to the vertical sequence and aspect ratio', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-codex-trailer-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const state = await projectStore.importScriptText(
      'A vertical hook. See the full video to learn more.',
      'trailer',
    )
    const line = state.manifest.trailer!.lines[0]
    const scenePrompt = composeScenePrompt(line.text, 'A stickman fills a tall vertical frame.')
    const input: GenerateSceneInput = {
      lineId: line.id,
      sequence: 'trailer',
      prompt: scenePrompt,
      modelEndpoint: 'chatgpt-image-generation',
      aspectRatio: '9:16',
      resolution: '1k',
    }
    const codex = {
      generateImage: vi.fn(async () => ({
        data: Buffer.from('trailer-image'),
        extension: 'png',
      })),
    }
    const client = new CodexImageClient(projectStore, codex as never)

    await client.queueScene(input)
    await vi.waitFor(() => {
      expect(projectStore.get()!.manifest.trailer!.lines[0].sceneStatus).toBe('complete')
    })

    expect(codex.generateImage).toHaveBeenCalledWith({
      prompt: composeGenerationPrompt(
        scenePrompt,
        projectStore.get()!.manifest.visualBible,
        '9:16',
      ),
      aspectRatio: '9:16',
    })
    expect(projectStore.get()!.manifest.trailer!.lines[0].imagePath).toBe(
      'trailer/scenes/001/image-01.png',
    )
  })

  it('preserves 9:16 when recovering a persisted trailer queue', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-codex-trailer-resume-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore()
    await projectStore.open(directory)
    const state = await projectStore.importScriptText(
      'A queued vertical hook. See the full video to learn more.',
      'trailer',
    )
    const line = state.manifest.trailer!.lines[0]
    line.imageGenerator = 'chatgpt'
    line.sceneStatus = 'queued'
    await projectStore.save(state.manifest)

    const codex = {
      generateImage: vi.fn(async () => ({
        data: Buffer.from('resumed-trailer-image'),
        extension: 'png',
      })),
    }
    const client = new CodexImageClient(projectStore, codex as never)

    await client.resumeQueuedScenes()
    await vi.waitFor(() => {
      expect(projectStore.get()!.manifest.trailer!.lines[0].sceneStatus).toBe('complete')
    })

    expect(codex.generateImage).toHaveBeenCalledWith(
      expect.objectContaining({ aspectRatio: '9:16' }),
    )
  })
})
