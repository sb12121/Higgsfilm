import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { ImageInspectorPayload } from '../../shared/types'

export class ImageInspectorWindow {
  private window: BrowserWindow | null = null
  private loadPromise: Promise<void> | null = null
  private latestPayload: ImageInspectorPayload | null = null

  constructor(private readonly mainWindow: BrowserWindow) {}

  async show(payload: ImageInspectorPayload): Promise<void> {
    this.latestPayload = payload
    const window = await this.ensure()
    this.positionOnMainMonitor(window)
    window.webContents.send('image-inspector:update', payload)
    if (!window.isVisible()) {
      window.show()
    }
    window.focus()
  }

  async update(payload: ImageInspectorPayload): Promise<void> {
    this.latestPayload = payload
    if (!this.window || this.window.isDestroyed()) return
    if (this.loadPromise) await this.loadPromise
    this.window.webContents.send('image-inspector:update', payload)
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
      width: 960,
      height: 640,
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
      title: 'Higgsfilm Image Inspector',
      webPreferences: {
        preload: join(__dirname, '../preload/inspector.mjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
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
        this.mainWindow.webContents.send('image-inspector:closed')
      }
    })

    this.window = window
    this.loadPromise = process.env.ELECTRON_RENDERER_URL
      ? window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/inspector.html`)
      : window.loadFile(join(__dirname, '../renderer/inspector.html'))
    await this.loadPromise
    if (this.latestPayload) {
      window.webContents.send('image-inspector:update', this.latestPayload)
    }
    return window
  }

  private positionOnMainMonitor(window: BrowserWindow): void {
    const mainBounds = this.mainWindow.isDestroyed()
      ? screen.getPrimaryDisplay().workArea
      : this.mainWindow.getBounds()
    const display = screen.getDisplayMatching(mainBounds)
    const workArea = display.workArea
    const width = Math.min(1120, Math.max(720, Math.round(workArea.width * 0.62)))
    const height = Math.min(720, Math.max(480, Math.round(workArea.height * 0.68)))
    const x = workArea.x + Math.round((workArea.width - width) / 2)
    const y = workArea.y + Math.round((workArea.height - height) / 2)
    window.setBounds({ x, y, width, height }, false)
  }
}
