import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { CodexClient } from './services/codexClient'
import { registerIpc } from './ipc'
import { FfmpegExporter } from './services/ffmpegExporter'
import { HiggsfieldClient } from './services/higgsfieldClient'
import { ProjectStore } from './services/projectStore'
import { TeleprompterWindow } from './services/teleprompterWindow'

let mainWindow: BrowserWindow | null = null

async function createWindow(): Promise<void> {
  const projectStore = new ProjectStore()
  const higgsfield = new HiggsfieldClient(projectStore)
  const codex = new CodexClient()
  const exporter = new FfmpegExporter(projectStore)

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0b0d12',
    title: 'Higgsfilm Studio',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The ESM preload bundle needs the unsandboxed preload runtime.
      // Context isolation and disabled node integration still keep page code isolated.
      sandbox: false,
    },
  })

  const teleprompter = new TeleprompterWindow(mainWindow)
  mainWindow.on('closed', () => teleprompter.destroy())
  registerIpc(mainWindow, projectStore, higgsfield, codex, teleprompter, exporter)

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  await createWindow()
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
