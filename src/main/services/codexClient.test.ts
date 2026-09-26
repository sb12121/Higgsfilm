import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { defaultLlmStepSettings } from '../../shared/types'
import {
  CodexClient,
  codexConcurrencyLimits,
  codexImageGenerationPrompt,
  codexServiceTierArgs,
  extractImageArtifact,
  imageFromDirectory,
} from './codexClient'

const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('extractImageArtifact', () => {
  it('reads base64 image artifacts nested in Codex JSON events', async () => {
    const output = JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'image_generation_call',
        result: { b64_json: onePixelPng },
      },
    })

    const image = await extractImageArtifact(output)

    expect(image?.extension).toBe('png')
    expect(image?.data.equals(Buffer.from(onePixelPng, 'base64'))).toBe(true)
  })

  it('reads data URLs and rejects text-only responses', async () => {
    const image = await extractImageArtifact(`data:image/jpeg;base64,${onePixelPng}`)
    const noImage = await extractImageArtifact('The image was generated successfully.')

    expect(image?.extension).toBe('jpg')
    expect(image?.data.equals(Buffer.from(onePixelPng, 'base64'))).toBe(true)
    expect(noImage).toBeNull()
  })
})

describe('codexImageGenerationPrompt', () => {
  it('tells Codex to call image_gen once and names reference files for edits', () => {
    expect(codexImageGenerationPrompt({ prompt: 'Bux squats.', aspectRatio: '16:9' })).toContain(
      'Call the image_gen tool exactly once',
    )
    expect(
      codexImageGenerationPrompt({ prompt: 'Bux squats.', aspectRatio: '9:16' }, [
        'C:\\refs\\reference-1.jpg',
      ]),
    ).toContain('referenced_image_paths set to exactly these files')
    expect(
      codexImageGenerationPrompt({ prompt: 'Bux squats.', aspectRatio: '9:16' }, [
        'C:\\refs\\reference-1.jpg',
      ]),
    ).toContain('C:\\refs\\reference-1.jpg')
    expect(
      codexImageGenerationPrompt({ prompt: 'Bux squats.', aspectRatio: '9:16' }, [
        'C:\\refs\\reference-1.jpg',
      ]),
    ).toContain('Do not shorten a path to its file name')
    expect(
      codexImageGenerationPrompt({ prompt: 'Bux squats.', aspectRatio: '16:9' }, [
        'C:\\refs\\reference-1.jpg',
      ], 'C:\\refs\\character-sheet.jpg'),
    ).toContain('Character sheet. This file locks body proportions')
  })
})

describe('imageFromDirectory', () => {
  it('reads a generated image and ignores staged references', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'higgsfilm-image-dir-'))
    const generated = Buffer.from(onePixelPng, 'base64')
    await fs.writeFile(path.join(directory, 'reference-1.png'), Buffer.from('reference'))
    await fs.writeFile(path.join(directory, 'bux.png'), generated)

    const image = await imageFromDirectory(directory)

    expect(image?.extension).toBe('png')
    expect(image?.data.equals(generated)).toBe(true)
    await fs.rm(directory, { recursive: true, force: true })
  })
})

describe('codexServiceTierArgs', () => {
  it('maps Fast mode to the Codex priority service tier', () => {
    expect(codexServiceTierArgs('fast')).toEqual([
      '--enable',
      'fast_mode',
      '--config',
      'service_tier="priority"',
    ])
    expect(codexServiceTierArgs('standard')).toEqual([])
  })
})

describe('CodexClient image generation', () => {
  it('calls image_gen in a writable workspace and returns the artifact', async () => {
    const commands: string[][] = []
    let prompt = ''
    const spawnProcess = fakeCodexSpawn((args, child) => {
      commands.push([...args])
      const stdin = child.stdin as unknown as { write: (chunk: string) => boolean }
      const originalWrite = stdin.write
      stdin.write = (chunk: string) => {
        prompt += chunk
        return originalWrite(chunk)
      }
      queueMicrotask(() => {
        const stdout = child.stdout as unknown as EventEmitter
        if (args[0] === '--version') {
          stdout.emit('data', Buffer.from('codex 1.0.0\n'))
        } else if (args[0] === 'login') {
          stdout.emit('data', Buffer.from('Logged in using ChatGPT\n'))
        } else {
          stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                type: 'item.completed',
                item: { type: 'image_generation', result: { b64_json: onePixelPng } },
              })}\n`,
            ),
          )
        }
        child.emit('close', 0)
      })
    })
    const reference = path.join(os.tmpdir(), `higgsfilm-ref-${Date.now()}.png`)
    await fs.writeFile(reference, Buffer.from(onePixelPng, 'base64'))
    const client = new CodexClient(undefined, undefined, spawnProcess, 'fake-codex')

    const image = await client.generateImage({
      prompt: 'Bux squats on crumpled paper.',
      aspectRatio: '16:9',
      referenceImagePaths: [reference],
    })

    const exec = commands.find((args) => args[0] === 'exec')
    expect(exec).toEqual(expect.arrayContaining([
      '--sandbox',
      'workspace-write',
      '--enable',
      'image_generation',
      '--image',
    ]))
    expect(exec).toEqual(expect.arrayContaining(['--config', 'model_reasoning_effort="low"']))
    expect(exec?.some((arg) => arg.endsWith('reference-1.jpg'))).toBe(true)
    expect(prompt).toContain('image_gen exactly once')
    expect(prompt).toContain('referenced_image_paths')
    expect(image.data.equals(Buffer.from(onePixelPng, 'base64'))).toBe(true)
    await fs.rm(reference, { force: true })
  })

  it('keeps image generation on low reasoning when script writing is set to max', async () => {
    const commands: string[][] = []
    const spawnProcess = fakeCodexSpawn((args, child) => {
      commands.push([...args])
      queueMicrotask(() => {
        const stdout = child.stdout as unknown as EventEmitter
        if (args[0] === '--version') stdout.emit('data', Buffer.from('codex 1.0.0\n'))
        else if (args[0] === 'login') stdout.emit('data', Buffer.from('Logged in using ChatGPT\n'))
        else {
          stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                type: 'item.completed',
                item: { type: 'image_generation', result: { b64_json: onePixelPng } },
              })}\n`,
            ),
          )
        }
        child.emit('close', 0)
      })
    })
    const client = new CodexClient(() => 'max', undefined, spawnProcess, 'fake-codex')

    await client.generateImage({ prompt: 'Bux squats.', aspectRatio: '16:9' })

    const exec = commands.find((args) => args[0] === 'exec')
    expect(exec).toEqual(expect.arrayContaining(['--config', 'model_reasoning_effort="low"']))
    expect(exec?.join(' ')).not.toContain('model_reasoning_effort="max"')
  })

  it('uses the image step model, reasoning, and priority', async () => {
    const commands: string[][] = []
    const spawnProcess = fakeCodexSpawn((args, child) => {
      commands.push([...args])
      queueMicrotask(() => {
        const stdout = child.stdout as unknown as EventEmitter
        if (args[0] === '--version') stdout.emit('data', Buffer.from('codex 1.0.0\n'))
        else if (args[0] === 'login') stdout.emit('data', Buffer.from('Logged in using ChatGPT\n'))
        else {
          stdout.emit(
            'data',
            Buffer.from(
              `${JSON.stringify({
                type: 'item.completed',
                item: { type: 'image_generation', result: { b64_json: onePixelPng } },
              })}\n`,
            ),
          )
        }
        child.emit('close', 0)
      })
    })
    const steps = defaultLlmStepSettings()
    steps.image = { model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'standard' }
    const client = new CodexClient(() => 'max', () => 'fast', spawnProcess, 'fake-codex', () => steps)

    await client.generateImage({ prompt: 'Bux squats.', aspectRatio: '16:9' })

    const exec = commands.find((args) => args[0] === 'exec')
    expect(exec).toEqual(expect.arrayContaining([
      '--model',
      'gpt-5.6-sol',
      '--config',
      'model_reasoning_effort="high"',
    ]))
    expect(exec?.join(' ')).not.toContain('fast_mode')
    expect(exec?.join(' ')).not.toContain('gpt-5.6-luna')
  })
})

describe('CodexClient step settings', () => {
  it('uses the script step model, reasoning, and priority', async () => {
    const commands: string[][] = []
    const spawnProcess = fakeCodexSpawn((args, child) => {
      commands.push([...args])
      queueMicrotask(() => {
        const stdout = child.stdout as unknown as EventEmitter
        stdout.emit('data', Buffer.from('A finished narration.\n'))
        child.emit('close', 0)
      })
    })
    const steps = defaultLlmStepSettings()
    steps['script-draft'] = { model: 'gpt-5.6-sol', reasoningEffort: 'max', serviceTier: 'fast' }
    const client = new CodexClient(() => 'low', () => 'standard', spawnProcess, 'fake-codex', () => steps)

    const result = await client.generate({ purpose: 'script-draft', prompt: 'Write the script.' })

    expect(result.text).toContain('finished narration')
    const exec = commands.find((args) => args[0] === 'exec')
    expect(exec).toEqual(expect.arrayContaining([
      '--model',
      'gpt-5.6-sol',
      '--config',
      'model_reasoning_effort="max"',
      '--enable',
      'fast_mode',
      '--config',
      'service_tier="priority"',
    ]))
  })
})

function fakeCodexSpawn(
  onSpawn: (args: readonly string[], child: ChildProcess) => void,
): typeof import('node:child_process').spawn {
  return ((
    _command: string,
    args: readonly string[],
    _options: SpawnOptions,
  ) => {
    const child = new EventEmitter() as unknown as ChildProcess
    ;(child as unknown as { stdin: unknown }).stdin = {
      write: () => true,
      end: () => undefined,
    }
    ;(child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter()
    ;(child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter()
    onSpawn(args, child)
    return child
  }) as typeof import('node:child_process').spawn
}

describe('CodexClient concurrency', () => {
  it('keeps text capacity at five and image capacity separate', () => {
    expect(codexConcurrencyLimits({})).toEqual({ text: 5, image: 1 })
    expect(
      codexConcurrencyLimits({
        CODEX_CONCURRENCY: '2',
        CODEX_TEXT_CONCURRENCY: '4',
        CODEX_IMAGE_CONCURRENCY: '3',
      }),
    ).toEqual({ text: 4, image: 3 })
  })

  it('cancels only the matching queued scene run', async () => {
    const children: ChildProcess[] = []
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      _options: SpawnOptions,
    ) => {
      const child = new EventEmitter() as unknown as ChildProcess
      ;(child as unknown as { stdin: unknown }).stdin = {
        write: () => true,
        end: () => undefined,
      }
      ;(child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter()
      ;(child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter()
      children.push(child)
      return child
    }) as typeof import('node:child_process').spawn
    const client = new CodexClient(undefined, undefined, spawnProcess, 'fake-codex')
    const requests = Array.from({ length: 6 }, (_, index) =>
      client.generate({
        requestId: index === 5 ? 'cancel-me' : 'keep-me',
        prompt: `request ${index}`,
      }),
    )

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(children).toHaveLength(5)
    client.cancelActive('cancel-me')
    await expect(requests[5]).rejects.toThrow(/cancelled/i)

    for (const child of children) {
      ;(child.stdout as unknown as EventEmitter).emit('data', Buffer.from('ok'))
      child.emit('close', 0)
    }
    await expect(Promise.all(requests.slice(0, 5))).resolves.toHaveLength(5)
  })

  it('coalesces overlapping status checks into one CLI round-trip', async () => {
    const commands: string[][] = []
    const spawnProcess = ((
      _command: string,
      args: readonly string[],
      _options: SpawnOptions,
    ) => {
      commands.push([...args])
      const child = new EventEmitter() as unknown as ChildProcess
      ;(child as unknown as { stdin: unknown }).stdin = {
        write: () => true,
        end: () => undefined,
      }
      ;(child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter()
      ;(child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter()
      queueMicrotask(() => {
        const stdout = child.stdout as unknown as EventEmitter
        stdout.emit(
          'data',
          Buffer.from(args[0] === '--version' ? 'codex 1.0.0\n' : 'Logged in using ChatGPT\n'),
        )
        child.emit('close', 0)
      })
      return child
    }) as typeof import('node:child_process').spawn

    const client = new CodexClient(undefined, undefined, spawnProcess, 'fake-codex')
    const [first, second] = await Promise.all([client.getStatus(), client.getStatus()])

    expect(first).toEqual(second)
    expect(first.authenticated).toBe(true)
    expect(commands).toEqual([['--version'], ['login', 'status']])
  })
})
