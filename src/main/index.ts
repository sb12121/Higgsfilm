import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { CodexClient } from './services/codexClient'
import { AppSettingsStore } from './services/appSettingsStore'
import { CodexImageClient } from './services/codexImageClient'
import { ComfyUiClient } from './services/comfyUiClient'
import { registerIpc } from './ipc'
import { FfmpegExporter } from './services/ffmpegExporter'
import { HiggsfieldClient } from './services/higgsfieldClient'
import { ImageGenerationRouter } from './services/imageGenerationRouter'
import { ProjectStore } from './services/projectStore'
import { QwenTtsClient } from './services/qwenTtsClient'
import { TeleprompterWindow } from './services/teleprompterWindow'
import { ImageInspectorWindow } from './services/imageInspectorWindow'
import { VoiceInspectorWindow } from './services/voiceInspectorWindow'

let mainWindow: BrowserWindow | null = null

async function createWindow(): Promise<void> {
  const projectStore = new ProjectStore()
  const appSettings = new AppSettingsStore(join(app.getPath('userData'), 'higgsfilm-settings.json'))
  await appSettings.load()
  const higgsfield = new HiggsfieldClient(projectStore)
  const codex = new CodexClient(
    () => appSettings.get().llmReasoningEffort,
    () => appSettings.get().llmServiceTier,
    undefined,
    undefined,
    () => appSettings.get().llmSteps,
  )
  const chatgptImages = new CodexImageClient(projectStore, codex)
  const comfyui = new ComfyUiClient(projectStore, appSettings)
  const qwen = new QwenTtsClient(projectStore, appSettings)
  const imageGeneration = new ImageGenerationRouter(appSettings, higgsfield, chatgptImages, comfyui)
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
      // Keep mic silence timers/audio callbacks alive when the always-on-top
      // teleprompter overlay takes Windows foreground status.
      backgroundThrottling: false,
    },
  })

  const teleprompter = new TeleprompterWindow(mainWindow)
  const imageInspector = new ImageInspectorWindow(mainWindow)
  const voiceInspector = new VoiceInspectorWindow(mainWindow)
  mainWindow.on('closed', () => {
    teleprompter.destroy()
    imageInspector.destroy()
    voiceInspector.destroy()
    codex.dispose()
  })
  registerIpc(
    mainWindow,
    projectStore,
    imageGeneration,
    higgsfield,
    codex,
    teleprompter,
    imageInspector,
    voiceInspector,
    exporter,
    appSettings,
    comfyui,
    qwen,
  )

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(
      `[Higgsfilm][Renderer] process gone reason="${details.reason}" exitCode=${details.exitCode}`,
    )
  })
  mainWindow.webContents.on('unresponsive', () => {
    console.error('[Higgsfilm][Renderer] became unresponsive')
  })
  mainWindow.webContents.on('responsive', () => {
    console.info('[Higgsfilm][Renderer] became responsive')
  })
  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    if (message.includes('[Higgsfilm][SceneGeneration]')) {
      console.info(`[Higgsfilm][Renderer] ${message}`)
    }
  })
  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame) {
        console.error(
          `[Higgsfilm][Renderer] main frame failed to load code=${errorCode} description="${errorDescription}" url="${validatedURL}"`,
        )
      }
    },
  )

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
