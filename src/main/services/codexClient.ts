import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  LlmConnectionStatus,
  LlmGenerationInput,
  LlmGenerationResult,
} from '../../shared/types'

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

const executable = process.env.CODEX_PATH || 'codex'
const model = process.env.CODEX_MODEL || 'gpt-5.6-luna'
const reasoningEffort = process.env.CODEX_REASONING_EFFORT || 'max'
const maxConcurrentGenerations = boundedConcurrency(process.env.CODEX_CONCURRENCY)

interface SlotWaiter {
  resolve: (release: () => void) => void
  reject: (error: Error) => void
}

export class CodexClient {
  private readonly activeProcesses = new Set<ChildProcess>()
  private readonly cancelledProcesses = new Set<ChildProcess>()
  private availableSlots = maxConcurrentGenerations
  private readonly slotWaiters: SlotWaiter[] = []

  async getStatus(): Promise<LlmConnectionStatus> {
    const versionResult = await this.run(['--version'])
    if (versionResult.code !== 0) {
      return {
        installed: false,
        authenticated: false,
        message: 'Codex CLI is not available on PATH.',
      }
    }

    const loginResult = await this.run(['login', 'status'])
    const output = `${loginResult.stdout}\n${loginResult.stderr}`.toLowerCase()
    const authenticated = loginResult.code === 0
    const authMethod = output.includes('chatgpt')
      ? 'chatgpt'
      : output.includes('api key')
        ? 'api-key'
        : authenticated
          ? 'unknown'
          : undefined

    return {
      installed: true,
      authenticated,
      authMethod,
      version: versionResult.stdout.trim(),
      message: authenticated
        ? authMethod === 'chatgpt'
          ? 'Connected through your ChatGPT account.'
          : 'Codex is authenticated.'
        : 'Sign in to Codex with ChatGPT to enable the creative copilot.',
    }
  }

  async startLogin(): Promise<{ started: boolean }> {
    const status = await this.getStatus()
    if (!status.installed) throw new Error('Install the official Codex CLI before signing in.')

    if (process.platform === 'win32') {
      const commandShell = process.env.ComSpec || 'cmd.exe'
      const child = spawn(
        commandShell,
        ['/c', 'start', '"Higgsfilm ChatGPT login"', commandShell, '/k', 'codex login'],
        { detached: true, stdio: 'ignore', windowsHide: false },
      )
      child.unref()
    } else {
      const child = spawn(executable, ['login'], { detached: true, stdio: 'ignore' })
      child.unref()
    }

    return { started: true }
  }

  async generate(input: LlmGenerationInput): Promise<LlmGenerationResult> {
    const releaseSlot = await this.acquireSlot()
    try {
      const status = await this.getStatus()
      if (!status.installed) throw new Error('Install Codex CLI to use ChatGPT generations.')
      if (!status.authenticated) throw new Error('Sign in to Codex with ChatGPT before generating.')

      const outputPath = path.join(os.tmpdir(), `higgsfilm-codex-${randomUUID()}.txt`)
      const prompt = [
        'You are the Higgsfilm Creative Copilot.',
        'Create useful production artifacts for an AI video project.',
        'Do not modify files, run commands, spend generation credits, or call external tools.',
        'Return only the requested creative answer, with clear headings when helpful.',
        '',
        input.prompt.trim(),
      ].join('\n')

      try {
        const result = await this.run(
          [
            'exec',
            '--ephemeral',
            '--skip-git-repo-check',
            '--sandbox',
            'read-only',
            '--model',
            model,
            '--config',
            `model_reasoning_effort="${reasoningEffort}"`,
            '--color',
            'never',
            '--output-last-message',
            outputPath,
            '-',
          ],
          prompt,
        )
        if (result.code !== 0) {
          const detail = result.stderr.trim().split(/\r?\n/).slice(-4).join('\n')
          throw new Error(detail || 'Codex could not complete the generation.')
        }

        const text = await fs.readFile(outputPath, 'utf8').catch(() => result.stdout.trim())
        if (!text.trim()) throw new Error('Codex returned an empty generation.')
        return { text: text.trim() }
      } finally {
        await fs.rm(outputPath, { force: true }).catch(() => undefined)
      }
    } finally {
      releaseSlot()
    }
  }

  cancelActive(): void {
    while (this.slotWaiters.length > 0) {
      this.slotWaiters.shift()!.reject(new Error('Codex generation cancelled.'))
    }
    for (const child of this.activeProcesses) {
      this.cancelledProcesses.add(child)
      if (process.platform === 'win32' && child.pid) {
        const commandShell = process.env.ComSpec || 'cmd.exe'
        const killer = spawn(
          commandShell,
          ['/d', '/c', 'taskkill', '/pid', String(child.pid), '/t', '/f'],
          { detached: true, stdio: 'ignore', windowsHide: true },
        )
        killer.unref()
      } else {
        child.kill('SIGTERM')
      }
    }
  }

  private acquireSlot(): Promise<() => void> {
    if (this.availableSlots > 0) {
      this.availableSlots -= 1
      return Promise.resolve(() => this.releaseSlot())
    }
    return new Promise((resolve, reject) => {
      this.slotWaiters.push({ resolve, reject })
    })
  }

  private releaseSlot(): void {
    const waiter = this.slotWaiters.shift()
    if (waiter) {
      waiter.resolve(() => this.releaseSlot())
      return
    }
    this.availableSlots += 1
  }

  private run(args: string[], input?: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        windowsHide: true,
        shell: process.platform === 'win32',
      })
      this.activeProcesses.add(child)
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.once('error', (error) => {
        this.activeProcesses.delete(child)
        const cancelled = this.cancelledProcesses.delete(child)
        reject(cancelled ? new Error('Codex generation cancelled.') : error)
      })
      child.once('close', (code) => {
        this.activeProcesses.delete(child)
        const cancelled = this.cancelledProcesses.delete(child)
        if (cancelled) {
          reject(new Error('Codex generation cancelled.'))
          return
        }
        resolve({ code: code ?? 1, stdout, stderr })
      })
      if (input !== undefined) {
        child.stdin?.write(input)
      }
      child.stdin?.end()
    })
  }
}

function boundedConcurrency(value: string | undefined): number {
  const parsed = Number(value || 5)
  if (!Number.isFinite(parsed)) return 5
  return Math.min(5, Math.max(1, Math.floor(parsed)))
}
