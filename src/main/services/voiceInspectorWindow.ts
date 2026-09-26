import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { VoiceInspectorPayload } from '../../shared/types'

export class VoiceInspectorWindow {
  private window: BrowserWindow | null = null
  private loadPromise: Promise<void> | null = null
  private latestPayload: VoiceInspectorPayload | null = null

  constructor(private readonly mainWindow: BrowserWindow) {}

  async show(payload: VoiceInspectorPayload): Promise<void> {
    this.latestPayload = payload
    const window = await this.ensure()
    this.positionOnMainMonitor(window)
    window.webContents.send('voice-inspector:update', payload)
    if (!window.isVisible()) {
      window.show()
    }
    window.focus()
  }

  async update(payload: VoiceInspectorPayload): Promise<void> {
    this.latestPayload = payload
    if (!this.window || this.window.isDestroyed()) return
    if (this.loadPromise) await this.loadPromise
    this.window.webContents.send('voice-inspector:update', payload)
  }

  async hide(): Promise<void> {
    this.latestPayload = null
    if (this.window && !this.window.isDestroyed()) this.window.hide()
  }

  isOpen(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible())
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close()
    this.window = null
    this.loadPromise = null
    this.latestPayload = null
  }

  private async ensure(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed()) {
      if (this.loadPromise) await this.loadPromise
      return this.window
    }

    const window = new BrowserWindow({
      width: 1040,
      height: 700,
      show: false,
      frame: false,
      transparent: false,
      resizable: true,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: false,
      focusable: true,
      autoHideMenuBar: true,
      backgroundColor: '#0b0d12',
      title: 'Higgsfilm Voice Inspector',
      webPreferences: {
        preload: join(__dirname, '../preload/voiceInspector.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    })

    window.setAlwaysOnTop(true, 'floating')
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.loadPromise = null
        this.latestPayload = null
      }
      if (!this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('voice-inspector:closed')
      }
    })

    this.window = window
    this.loadPromise = process.env.ELECTRON_RENDERER_URL
      ? window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/voice-inspector.html`)
      : window.loadFile(join(__dirname, '../renderer/voice-inspector.html'))
    await this.loadPromise
    if (this.latestPayload) {
      window.webContents.send('voice-inspector:update', this.latestPayload)
    }
    return window
  }

  private positionOnMainMonitor(window: BrowserWindow): void {
    const mainBounds = this.mainWindow.isDestroyed()
      ? screen.getPrimaryDisplay().workArea
      : this.mainWindow.getBounds()
    const display = screen.getDisplayMatching(mainBounds)
    const workArea = display.workArea
    const width = Math.min(1180, Math.max(840, Math.round(workArea.width * 0.64)))
    const height = Math.min(780, Math.max(560, Math.round(workArea.height * 0.72)))
    const x = workArea.x + Math.round((workArea.width - width) / 2)
    const y = workArea.y + Math.round((workArea.height - height) / 2)
    window.setBounds({ x, y, width, height }, false)
  }
}
