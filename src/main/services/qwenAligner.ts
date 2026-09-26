import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { QwenAlignmentStatus } from '../../shared/types'
import type { WhisperWord } from './qwenAlignment'

export const DEFAULT_QWEN_ALIGNMENT_MODEL = 'small.en'

export interface AlignmentResponse {
  ok?: boolean
  error?: string
  transcript?: string
  words?: WhisperWord[]
  model?: string
  message?: string
}

export class QwenAlignerError extends Error {
  override readonly name = 'QwenAlignerError'

  constructor(message: string) {
    super(message)
  }
}

export class QwenAligner {
  constructor(
    private readonly pythonCommand = process.env.QWEN_ALIGNMENT_PYTHON ||
      process.env.PYTHON_PATH ||
      'python',
    private readonly model = process.env.QWEN_ALIGNMENT_MODEL || DEFAULT_QWEN_ALIGNMENT_MODEL,
  ) {}

  async getStatus(): Promise<QwenAlignmentStatus> {
    return this.detectStatus()
  }

  async align(
    audioPath: string,
    text: string,
    signal?: AbortSignal,
    language = 'en',
  ): Promise<{ transcript: string; words: WhisperWord[] }> {
    const scriptPath = await this.scriptPath()
    const response = await this.run(
      scriptPath,
      {
        mode: 'align',
        audioPath,
        text,
        model: this.model,
        language,
      },
      signal,
    )
    if (!response.ok) {
      throw new QwenAlignerError(
        response.error ||
          'Whisper could not align the generated QWEN paragraph. Check the local alignment setup.',
      )
    }
    if (!Array.isArray(response.words)) {
      throw new QwenAlignerError('Whisper returned no word timestamps for the generated QWEN paragraph.')
    }
    const words = response.words.map((word) => ({
      text: typeof word.text === 'string' ? word.text.trim() : '',
      start: Number(word.start),
      end: Number(word.end),
      confidence:
        word.confidence === undefined ? undefined : Math.min(1, Math.max(0, Number(word.confidence))),
    }))
    if (
      words.some(
        (word) =>
          !word.text ||
          !Number.isFinite(word.start) ||
          !Number.isFinite(word.end) ||
          word.start < 0 ||
          word.end <= word.start ||
          (word.confidence !== undefined && !Number.isFinite(word.confidence)),
      )
    ) {
      throw new QwenAlignerError('Whisper returned an invalid word timestamp.')
    }
    for (let index = 1; index < words.length; index += 1) {
      if (words[index]!.start < words[index - 1]!.start) {
        throw new QwenAlignerError('Whisper returned non-monotonic word timestamps.')
      }
    }
    return {
      transcript: response.transcript || words.map((word) => word.text).join(' '),
      words,
    }
  }

  private async detectStatus(): Promise<QwenAlignmentStatus> {
    const scriptPath = await this.findScriptPath()
    if (!scriptPath) {
      return {
        configured: false,
        runtime: this.pythonCommand,
        model: this.model,
        message: 'The QWEN alignment helper script is missing from the installation.',
      }
    }
    try {
      const response = await this.run(scriptPath, { mode: 'status', model: this.model })
      const message =
        response.message ||
        response.error ||
        'Install faster-whisper in the configured Python runtime.'
      return {
        configured: Boolean(response.ok),
        runtime: this.pythonCommand,
        model: this.model,
        message: response.ok
          ? message
          : `${message} Run "${this.pythonCommand} -m pip install faster-whisper", then refresh this status.`,
      }
    } catch (error) {
      return {
        configured: false,
        runtime: this.pythonCommand,
        model: this.model,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private async scriptPath(): Promise<string> {
    const scriptPath = await this.findScriptPath()
    if (!scriptPath) {
      throw new QwenAlignerError(
        'The QWEN alignment helper is unavailable. Reinstall Higgsfilm or set QWEN_ALIGNMENT_SCRIPT.',
      )
    }
    return scriptPath
  }

  private async findScriptPath(): Promise<string | undefined> {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      process.env.QWEN_ALIGNMENT_SCRIPT,
      path.resolve(process.cwd(), 'scripts', 'qwen-align.py'),
      path.resolve(moduleDirectory, '..', 'scripts', 'qwen-align.py'),
      path.resolve(moduleDirectory, '..', '..', 'scripts', 'qwen-align.py'),
      process.resourcesPath
        ? path.join(process.resourcesPath, 'scripts', 'qwen-align.py')
        : undefined,
    ].filter((candidate): candidate is string => Boolean(candidate))
    for (const candidate of candidates) {
      if (await fs.stat(candidate).then((info) => info.isFile()).catch(() => false)) {
        return candidate
      }
    }
    return undefined
  }

  private run(
    scriptPath: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AlignmentResponse> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('QWEN audio alignment was cancelled.', 'AbortError'))
        return
      }
      const child = spawn(this.pythonCommand, [scriptPath], {
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort)
      }
      const settleError = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = (): void => {
        child.kill()
        settleError(new DOMException('QWEN audio alignment was cancelled.', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', (error) => {
        settleError(
          new QwenAlignerError(
            `Could not start the QWEN alignment runtime "${this.pythonCommand}". ${error.message}`,
          ),
        )
      })
      child.once('close', (code) => {
        if (settled) return
        settled = true
        cleanup()
        const response = parseQwenAlignmentResponse(stdout)
        if (response) {
          resolve(response)
          return
        }
        reject(
          new QwenAlignerError(
            `The QWEN alignment runtime returned invalid output (exit ${code ?? 1}). ${
              stderr.trim().slice(-500) || 'No diagnostic was returned.'
            }`,
          ),
        )
      })
      child.stdin.write(JSON.stringify(request))
      child.stdin.end()
    })
  }
}

export function parseQwenAlignmentResponse(output: string): AlignmentResponse | undefined {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  try {
    const value = JSON.parse(trimmed) as AlignmentResponse
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}
