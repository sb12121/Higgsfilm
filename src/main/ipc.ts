import { ipcMain, dialog, type BrowserWindow } from 'electron'
import type { GenerateSceneInput, ProjectManifest, RecordingPayload } from '../shared/types'
import { CodexClient } from './services/codexClient'
import { FfmpegExporter } from './services/ffmpegExporter'
import { HiggsfieldClient } from './services/higgsfieldClient'
import { ProjectStore } from './services/projectStore'
import { TeleprompterWindow } from './services/teleprompterWindow'

export function registerIpc(
  window: BrowserWindow,
  projectStore: ProjectStore,
  higgsfield: HiggsfieldClient,
  codex: CodexClient,
  teleprompter: TeleprompterWindow,
  exporter: FfmpegExporter,
): void {
  const unsubscribeHiggsUpdates = higgsfield.onUpdate((state) => {
    if (!window.isDestroyed()) window.webContents.send('higgs:scene-update', state)
  })
  window.once('closed', unsubscribeHiggsUpdates)

  ipcMain.handle('project:choose', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a Higgsfilm project folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const state = await projectStore.open(result.filePaths[0])
    void higgsfield.resumeQueuedScenes()
    return state
  })

  ipcMain.handle('project:import-script', async () => {
    if (!projectStore.get()) throw new Error('Choose a project folder before importing a script.')
    const result = await dialog.showOpenDialog(window, {
      title: 'Import a narration script',
      properties: ['openFile'],
      filters: [
        { name: 'Scripts', extensions: ['txt', 'md', 'text'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return projectStore.importScript(result.filePaths[0])
  })

  ipcMain.handle('project:import-script-text', (_event, script: string) => {
    if (!projectStore.get()) throw new Error('Choose a project folder before pasting a script.')
    if (!script.trim()) throw new Error('Paste some script text before creating narration lines.')
    return projectStore.importScriptText(script)
  })

  ipcMain.handle('project:get', () => {
    const state = projectStore.get()
    if (state) void higgsfield.resumeQueuedScenes()
    return state
  })

  ipcMain.handle('project:save', (_event, manifest: ProjectManifest) => projectStore.save(manifest))

  ipcMain.handle('project:save-recording', (_event, payload: RecordingPayload) =>
    projectStore.saveRecording(payload),
  )

  ipcMain.handle('project:asset-data', (_event, relativePath: string) =>
    projectStore.assetDataUrl(relativePath),
  )

  ipcMain.handle('settings:get-higgs', () => higgsfield.getStatus())

  ipcMain.handle('settings:login-higgs', () => higgsfield.login())

  ipcMain.handle('higgs:generate-scene', (_event, input: GenerateSceneInput) =>
    higgsfield.generateScene(input),
  )

  ipcMain.handle('higgs:queue-scene', (_event, input: GenerateSceneInput) =>
    higgsfield.queueScene(input),
  )

  ipcMain.handle('llm:get-status', () => codex.getStatus())

  ipcMain.handle('llm:login', () => codex.startLogin())

  ipcMain.handle('llm:generate', (_event, input) => codex.generate(input))

  ipcMain.handle('llm:cancel', () => codex.cancelActive())

  ipcMain.handle('teleprompter:show', (_event, payload) => teleprompter.show(payload))

  ipcMain.handle('teleprompter:update', (_event, payload) => teleprompter.update(payload))

  ipcMain.handle('teleprompter:hide', () => teleprompter.hide())

  ipcMain.handle('export:longform', async () => {
    const state = projectStore.get()
    if (!state) throw new Error('Choose a project folder before exporting.')

    const suggestedName = `${state.manifest.name.replace(/[^\w\- ]/g, '').trim() || 'higgsfilm-project'}.mp4`
    const result = await dialog.showSaveDialog(window, {
      title: 'Export longform video',
      defaultPath: `${state.rootPath}\\exports\\${suggestedName}`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    })
    if (result.canceled || !result.filePath) return null
    return exporter.exportLongform(result.filePath)
  })
}
