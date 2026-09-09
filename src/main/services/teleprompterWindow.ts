import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { RecordingFocusPayload } from '../../shared/types'

export class TeleprompterWindow {
  private window: BrowserWindow | null = null
  private loadPromise: Promise<void> | null = null

  constructor(private readonly mainWindow: BrowserWindow) {}

  async show(payload: RecordingFocusPayload): Promise<void> {
    const window = await this.ensure()
    this.positionOnMainMonitor(window)
    window.webContents.send('teleprompter:update', payload)
    if (!window.isVisible()) window.showInactive()
  }

  async update(payload: RecordingFocusPayload): Promise<void> {
    const window = await this.ensure()
    this.positionOnMainMonitor(window)
    window.webContents.send('teleprompter:update', payload)
    if (!window.isVisible()) window.showInactive()
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

  private positionOnMainMonitor(window: BrowserWindow): void {
    const mainBounds = this.mainWindow.isDestroyed()
      ? screen.getPrimaryDisplay().workArea
      : this.mainWindow.getBounds()
    const display = screen.getDisplayMatching(mainBounds)
    const workArea = display.workArea
    const [windowWidth, windowHeight] = window.getSize()
    const width = Math.min(windowWidth, Math.max(520, workArea.width - 48))
    const height = Math.min(windowHeight, Math.max(210, workArea.height - 48))
    const x = workArea.x + Math.round((workArea.width - width) / 2)
    const topQuarterCenter = workArea.y + Math.round(workArea.height * 0.25)
    const y = Math.max(workArea.y + 24, topQuarterCenter - Math.round(height / 2))
    window.setBounds({ x, y, width, height }, false)
  }
}
