import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { RecordingFocusPayload } from '../../shared/types'

export class TeleprompterWindow {
  private window: BrowserWindow | null = null
  private loadPromise: Promise<void> | null = null

  constructor(private readonly mainWindow: BrowserWindow) {}

  async show(payload: RecordingFocusPayload): Promise<void> {
    const window = await this.ensure()
    this.present(window, payload)
  }

  async update(payload: RecordingFocusPayload): Promise<void> {
    const window = await this.ensure()
    this.present(window, payload)
  }

  private present(window: BrowserWindow, payload: RecordingFocusPayload): void {
    this.positionOnMainMonitor(window, this.heightForPayload(payload))
    window.webContents.send('teleprompter:update', payload)
    if (!window.isVisible()) window.showInactive()
  }

  private heightForPayload(payload: RecordingFocusPayload): number {
    const lineCount = payload.lines && payload.lines.length > 1 ? payload.lines.length : 1
    const expressions = (payload.expressions || []).filter((value) => value.trim())
    const mixed = new Set(expressions.map((value) => value.trim().toLowerCase())).size > 1
    const tone = Boolean(payload.expression || expressions.length)
    const speakers = (payload.speakers || []).filter((value) => value.trim())
    const mixedSpeakers = new Set(speakers.map((value) => value.trim().toLowerCase())).size > 1
    const speaker = Boolean(payload.speaker || speakers.length)
    return Math.min(
      640,
      236 + (tone ? 28 : 0) + (speaker ? 48 : 0) + lineCount * (mixed || mixedSpeakers ? 58 : 36),
    )
  }

  async hide(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) this.window.hide()
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close()
    this.window = null
    this.loadPromise = null
  }

  private async ensure(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      if (this.loadPromise) await this.loadPromise
      return this.window
    }

    const window = new BrowserWindow({
      width: 960,
      height: 280,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/overlay.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    window.setAlwaysOnTop(true, 'floating')
    window.setIgnoreMouseEvents(true, { forward: true })
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.loadPromise = null
      }
    })

    this.window = window
    this.loadPromise = process.env.ELECTRON_RENDERER_URL
      ? window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay.html`)
      : window.loadFile(join(__dirname, '../renderer/overlay.html'))
    await this.loadPromise
    return window
  }

  private positionOnMainMonitor(window: BrowserWindow, requestedHeight = 280): void {
    const mainBounds = this.mainWindow.isDestroyed()
      ? screen.getPrimaryDisplay().workArea
      : this.mainWindow.getBounds()
    const display = screen.getDisplayMatching(mainBounds)
    const workArea = display.workArea
    const [windowWidth] = window.getSize()
    const width = Math.min(windowWidth, Math.max(520, workArea.width - 48))
    const height = Math.min(Math.max(requestedHeight, 240), Math.max(240, workArea.height - 48))
    const x = workArea.x + Math.round((workArea.width - width) / 2)
    const topQuarterCenter = workArea.y + Math.round(workArea.height * 0.25)
    const y = Math.max(workArea.y + 24, topQuarterCenter - Math.round(height / 2))
    window.setBounds({ x, y, width, height }, false)
  }
}
