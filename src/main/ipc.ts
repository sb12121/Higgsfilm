import { clipboard, dialog, ipcMain, nativeImage, type BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ChannelImageProfileInput,
  CustomImageGenerateInput,
  ExpressionImageGenerateInput,
  GenerateSceneInput,
  ProjectManifest,
  ProjectState,
  VisualBible,
  QwenTtsGenerateInput,
  QwenTtsRealignInput,
  RecordingPayload,
  ResetVoiceTakeCleanupPayload,
  SequenceId,
  ScriptCreatorDraft,
  StillCastAssignInput,
  StillCastExpressionInput,
  StudioSettings,
  ScriptLineMode,
  TrimVoiceTakePayload,
  VideoIdeaResearchRequest,
} from '../shared/types'
import { applyChannelProfileToSettings, emptyVisualBible } from '../shared/channelProfiles'
import { CodexClient } from './services/codexClient'
import { CustomImageClient } from './services/customImageClient'
import { ExpressionImageClient } from './services/expressionImageClient'
import { AppSettingsStore } from './services/appSettingsStore'
import { ComfyUiClient } from './services/comfyUiClient'
import { FfmpegExporter } from './services/ffmpegExporter'
import { HiggsfieldClient } from './services/higgsfieldClient'
import { ImageGenerationRouter } from './services/imageGenerationRouter'
import { ProjectStore } from './services/projectStore'
import { QwenTtsClient } from './services/qwenTtsClient'
import { TeleprompterWindow } from './services/teleprompterWindow'
import { ImageInspectorWindow } from './services/imageInspectorWindow'
import { VoiceInspectorWindow } from './services/voiceInspectorWindow'
import {
  expressionLibraryPathForChannel,
  prepareStillCastLibrary,
  scanStillCastCatalog,
  scanStillCastLibrary,
} from './services/stillCastLibrary'
import { researchYouTube } from './services/youtubeResearch'

export function registerIpc(
  window: BrowserWindow,
  projectStore: ProjectStore,
  imageGeneration: ImageGenerationRouter,
  higgsfield: HiggsfieldClient,
  codex: CodexClient,
  teleprompter: TeleprompterWindow,
  imageInspector: ImageInspectorWindow,
  voiceInspector: VoiceInspectorWindow,
  exporter: FfmpegExporter,
  appSettings: AppSettingsStore,
  comfyui: ComfyUiClient,
  qwen: QwenTtsClient,
): void {
  let rendererReady = false
  let latestState: ProjectState | null = null
  let stateSendScheduled = false
  let resumedProjectId: string | null = null

  const resumeQueuesForProject = (state: ProjectState | null): void => {
    if (!state || resumedProjectId === state.manifest.id) return
    resumedProjectId = state.manifest.id
    void imageGeneration.resumeQueuedScenes().catch((error) => {
      if (resumedProjectId === state.manifest.id) resumedProjectId = null
      console.error('[Higgsfilm] Could not resume saved image queues:', error)
    })
  }

  const sendLatestState = (): void => {
    if (
      !latestState ||
      !rendererReady ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.isLoadingMainFrame()
    ) {
      return
    }

    if (stateSendScheduled) return
    stateSendScheduled = true
    setImmediate(() => {
      stateSendScheduled = false
      if (
        !latestState ||
        !rendererReady ||
        window.isDestroyed() ||
        window.webContents.isDestroyed() ||
        window.webContents.isLoadingMainFrame()
      ) {
        return
      }

      try {
        window.webContents.send('higgs:scene-update', latestState)
      } catch (error) {
        // The renderer can disappear between the lifecycle checks and send().
        // Keep the state queued so the next renderer load can receive it.
        rendererReady = false
        const message = error instanceof Error ? error.message : String(error)
        if (!message.includes('Render frame was disposed')) {
          console.error('[Higgsfilm] Could not send scene update:', error)
        }
      }
    })
  }

  const handleRendererStart = (): void => {
    rendererReady = false
  }
  const handleRendererReady = (): void => {
    rendererReady = true
    sendLatestState()
  }

  window.webContents.on('did-start-loading', handleRendererStart)
  window.webContents.on('did-finish-load', handleRendererReady)

  const unsubscribeHiggsUpdates = imageGeneration.onUpdate((state) => {
    const current = projectStore.get()
    if (!current || current.manifest.id !== state.manifest.id) return
    latestState = state
    sendLatestState()
  })
  const unsubscribeQwenProgress = qwen.onProgress((progress) => {
    if (
      !rendererReady ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.webContents.isLoadingMainFrame()
    ) {
      return
    }
    try {
      window.webContents.send('qwen:progress', progress)
    } catch {
      rendererReady = false
    }
  })

  window.once('closed', () => {
    unsubscribeHiggsUpdates()
    unsubscribeQwenProgress()
    window.webContents.removeListener('did-start-loading', handleRendererStart)
    window.webContents.removeListener('did-finish-load', handleRendererReady)
  })

  ipcMain.handle('project:choose', async () => {
    const channel = appSettings.getActiveChannelProfile()
    const defaultPath = channel?.channelFolderPath?.trim() || undefined
    const result = await dialog.showOpenDialog(window, {
      title: defaultPath
        ? 'Choose a project folder inside this channel'
        : 'Choose a Higgsfilm project folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const state = await projectStore.open(result.filePaths[0], {
      defaultVisualBible: channel?.visualBible,
    })
    resumedProjectId = null
    resumeQueuesForProject(state)
    return state
  })

  ipcMain.handle(
    'project:import-script',
    async (
      _event,
      sequence: SequenceId = 'main',
      lineMode: ScriptLineMode = 'sentences',
      stillLibraryPath?: string,
    ) => {
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
    return projectStore.importScript(result.filePaths[0], sequence, lineMode, stillLibraryPath)
  })

  ipcMain.handle(
    'project:import-script-text',
    (
      _event,
      script: string,
      sequence: SequenceId = 'main',
      lineMode: ScriptLineMode = 'sentences',
      stillLibraryPath?: string,
    ) => {
    if (!projectStore.get()) throw new Error('Choose a project folder before pasting a script.')
    if (!script.trim()) throw new Error('Paste some script text before creating narration lines.')
    return projectStore.importScriptText(script, sequence, lineMode, stillLibraryPath)
  })

  ipcMain.handle('project:get', () => {
    const state = projectStore.get()
    resumeQueuesForProject(state)
    return state
  })

  ipcMain.handle('project:close', async () => {
    resumedProjectId = null
    latestState = null
    await Promise.all([
      imageGeneration.cancelGenerations().catch(() => undefined),
      qwen.cancel().catch(() => undefined),
      teleprompter.hide().catch(() => undefined),
      imageInspector.hide().catch(() => undefined),
      voiceInspector.hide().catch(() => undefined),
    ])
    await projectStore.close()
  })

  ipcMain.handle('project:save', (_event, manifest: ProjectManifest) => projectStore.save(manifest))

  ipcMain.handle(
    'project:save-script-creator',
    (
      _event,
      draft: Partial<ScriptCreatorDraft> & { expectedProjectId?: string; expectedRootPath?: string },
    ) =>
    projectStore.saveScriptCreator(draft),
  )

  ipcMain.handle('project:reset-scene-generation-cache', (_event, sequence: SequenceId = 'main') =>
    projectStore.resetSceneGenerationCache(sequence),
  )

  ipcMain.handle('project:save-recording', (_event, payload: RecordingPayload) =>
    projectStore.saveRecording(payload),
  )

  ipcMain.handle('project:save-stanza-recording', (_event, payload: RecordingPayload) =>
    projectStore.saveStanzaRecording(payload),
  )

  ipcMain.handle('project:trim-voice-take', (_event, payload: TrimVoiceTakePayload) =>
    projectStore.trimVoiceTake(payload),
  )

  ipcMain.handle('project:reset-voice-cleanup', (_event, payload: ResetVoiceTakeCleanupPayload) =>
    projectStore.resetVoiceTakeCleanup(payload),
  )

  ipcMain.handle('project:asset-data', (_event, relativePath: string) =>
    projectStore.assetDataUrl(relativePath),
  )

  ipcMain.handle('project:audio-peaks', (_event, relativePath: string, bucketCount?: number) =>
    projectStore.audioPeaks(relativePath, bucketCount),
  )

  ipcMain.handle('project:asset-thumb', (_event, relativePath: string, maxEdge?: number) =>
    projectStore.assetThumbDataUrl(relativePath, maxEdge),
  )

  ipcMain.handle('qwen:get-status', () => qwen.getStatus())

  ipcMain.handle('qwen:choose-reference', async () => {
    if (!projectStore.get()) throw new Error('Choose a project folder before selecting a QWEN reference.')
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a QWEN voice reference',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return qwen.getStatus()
    return qwen.saveReferenceFile(result.filePaths[0]!)
  })

  ipcMain.handle('qwen:save-reference-text', (_event, text: string) =>
    qwen.saveReferenceText(text),
  )

  ipcMain.handle('qwen:generate', (_event, input: QwenTtsGenerateInput) =>
    qwen.generate(input),
  )

  ipcMain.handle('qwen:realign', (_event, input: QwenTtsRealignInput) =>
    qwen.realign(input),
  )

  ipcMain.handle('qwen:cancel', () => qwen.cancel())

  ipcMain.handle('project:copy-image', async (_event, relativePath: string) => {
    const asset = await projectStore.assetDataUrl(relativePath)
    if (!asset || !asset.mimeType.startsWith('image/')) {
      throw new Error('The selected scene image is not available to copy.')
    }
    const image = nativeImage.createFromDataURL(asset.dataUrl)
    if (image.isEmpty()) {
      throw new Error('The selected scene image could not be decoded.')
    }
    clipboard.writeImage(image)
  })

  ipcMain.handle('production-bibles:list', () => appSettings.getProductionBibles())

  ipcMain.handle(
    'production-bibles:save',
    (_event, name: string, bible: VisualBible) => appSettings.saveProductionBible(name, bible),
  )

  ipcMain.handle(
    'production-bibles:load',
    (_event, name: string) => appSettings.loadProductionBible(name),
  )

  ipcMain.handle('channel-profiles:list', () => appSettings.getChannelProfiles())

  ipcMain.handle(
    'channel-profiles:save',
    (_event, input: ChannelImageProfileInput) => appSettings.saveChannelProfile(input),
  )

  ipcMain.handle('channel-profiles:choose-folder', async () => {
    const active = appSettings.getActiveChannelProfile()
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a channel folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(active?.channelFolderPath ? { defaultPath: active.channelFolderPath } : {}),
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const channelFolderPath = path.resolve(result.filePaths[0])
    const name = path.basename(channelFolderPath)
    const expressionsPath = expressionLibraryPathForChannel(channelFolderPath)
    await fs.mkdir(expressionsPath, { recursive: true })

    const currentSettings = appSettings.get()
    const existing =
      appSettings.getChannelProfiles().profiles.find(
        (profile) =>
          profile.channelFolderPath &&
          profile.channelFolderPath.toLowerCase() === channelFolderPath.toLowerCase(),
      ) ||
      appSettings.getChannelProfiles().profiles.find(
        (profile) => profile.name.toLowerCase() === name.toLowerCase(),
      ) ||
      active

    return appSettings.saveChannelProfile({
      id: existing?.id,
      name,
      visualBible: existing?.visualBible || emptyVisualBible(name),
      imageGenerator: existing?.imageGenerator || currentSettings.imageGenerator,
      comfy: existing?.comfy || currentSettings.comfy,
      productionMode: existing?.productionMode || 'still-cast',
      channelFolderPath,
      stillLibraryPath: expressionsPath,
      scriptBiblePath: existing?.scriptBiblePath || '',
      ideaGuidePath: existing?.ideaGuidePath || '',
      niche: existing?.niche || '',
      youtubeHandle: existing?.youtubeHandle || '',
      channelBrief: existing?.channelBrief || '',
      channelBriefUpdatedAt: existing?.channelBriefUpdatedAt || '',
    })
  })

  ipcMain.handle('channel-profiles:remove', (_event, id: string) =>
    appSettings.removeChannelProfile(id),
  )

  ipcMain.handle('channel-profiles:apply', async (_event, id: string) => {
    const trimmed = String(id || '').trim()
    resumedProjectId = null
    latestState = null
    await Promise.all([
      imageGeneration.cancelGenerations().catch(() => undefined),
      qwen.cancel().catch(() => undefined),
      teleprompter.hide().catch(() => undefined),
      imageInspector.hide().catch(() => undefined),
      voiceInspector.hide().catch(() => undefined),
    ])
    await projectStore.close()
    if (!trimmed) {
      appSettings.setActiveChannelProfileId('')
      const settings = await imageGeneration.saveSettings(appSettings.get())
      return {
        ...appSettings.getChannelProfiles(),
        settings,
        visualBible: null,
      }
    }
    const profile = appSettings.getChannelProfile(trimmed)
    if (!profile) throw new Error('That YouTube channel profile was not found.')
    appSettings.setActiveChannelProfileId(profile.id)
    const settings = await imageGeneration.saveSettings(
      applyChannelProfileToSettings(appSettings.get(), profile),
    )
    return {
      ...appSettings.getChannelProfiles(),
      settings,
      visualBible: profile.visualBible,
    }
  })

  ipcMain.handle('still-cast:choose-library', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose an expression stills folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('still-cast:scan-library', (_event, libraryPath: string) =>
    scanStillCastLibrary(libraryPath),
  )

  ipcMain.handle('still-cast:scan-catalog', (_event, libraryPath?: string) => {
    const state = projectStore.get()
    const library = libraryPath?.trim()
    if (!state) {
      if (!library) throw new Error('Open a project before scanning the still catalog.')
      return scanStillCastLibrary(library)
    }
    return scanStillCastCatalog(libraryPath, state.rootPath)
  })

  ipcMain.handle('still-cast:prepare-library', (_event, libraryPath: string) =>
    prepareStillCastLibrary(libraryPath),
  )

  ipcMain.handle('still-cast:assign-images', (_event, input: StillCastAssignInput) =>
    projectStore.assignStillCastImages(input),
  )

  ipcMain.handle('still-cast:set-expression', (_event, input: StillCastExpressionInput) =>
    projectStore.setStillCastExpression(input),
  )

  const customImages = new CustomImageClient(projectStore, appSettings, codex)

  ipcMain.handle('custom-image:get-setup', () => customImages.getSetup())

  ipcMain.handle('custom-image:choose-guide', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose the 16:9 custom image guide',
      properties: ['openFile'],
      filters: [
        { name: 'Image guides', extensions: ['txt', 'md', 'text'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('custom-image:choose-character-sheet', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose the character sheet',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('custom-image:choose-references', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose custom image references',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  ipcMain.handle('custom-image:missing-brief', () => customImages.missingCursorBrief())

  ipcMain.handle(
    'custom-image:script-creator-brief',
    (_event, input: { script?: string; topic?: string }) =>
      customImages.scriptCreatorCursorBrief(input?.script || '', input?.topic || ''),
  )

  ipcMain.handle('custom-image:generate', (event, input: CustomImageGenerateInput) =>
    customImages.generate(input, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('custom-image:progress', progress)
    }),
  )

  ipcMain.handle('custom-image:cancel', () => {
    customImages.cancel()
  })

  const expressionImages = new ExpressionImageClient(appSettings, codex)

  ipcMain.handle('expression-image:get-setup', () => expressionImages.getSetup())

  ipcMain.handle('expression-image:choose-guide', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose the expression image guide',
      properties: ['openFile'],
      filters: [
        { name: 'Image guides', extensions: ['txt', 'md', 'text'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('expression-image:choose-background', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose the shared expression background',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('expression-image:generate', (event, input: ExpressionImageGenerateInput) =>
    expressionImages.generate(input, (progress) => {
      if (!event.sender.isDestroyed()) event.sender.send('expression-image:progress', progress)
    }),
  )

  ipcMain.handle('expression-image:cancel', () => {
    expressionImages.cancel()
  })

  ipcMain.handle('script-bible:choose', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a script bible',
      properties: ['openFile'],
      filters: [
        { name: 'Script bibles', extensions: ['txt', 'md', 'text'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('script-bible:read', async (_event, filePath: string) => {
    const resolved = path.resolve(String(filePath || '').trim())
    let text = ''
    try {
      text = await fs.readFile(resolved, 'utf8')
    } catch {
      throw new Error('Could not read that script bible file. Choose it again.')
    }
    if (!text.trim()) throw new Error('That script bible file is empty.')
    return { path: resolved, text }
  })

  ipcMain.handle('idea-guide:choose', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a video idea guide',
      properties: ['openFile'],
      filters: [
        { name: 'Idea guides', extensions: ['md', 'txt', 'text'] },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('idea-guide:read', async (_event, filePath: string) => {
    const resolved = path.resolve(String(filePath || '').trim())
    let text = ''
    try {
      text = await fs.readFile(resolved, 'utf8')
    } catch {
      throw new Error('Could not read that idea guide file. Choose it again.')
    }
    if (!text.trim()) throw new Error('That idea guide file is empty.')
    return { path: resolved, text }
  })

  ipcMain.handle('settings:get', () => appSettings.get())

  ipcMain.handle('settings:save', (_event, settings: StudioSettings) => imageGeneration.saveSettings(settings))

  ipcMain.handle('settings:get-higgs', () => higgsfield.getStatus())

  ipcMain.handle('settings:login-higgs', () => higgsfield.login())

  ipcMain.handle('settings:get-comfy-status', () => comfyui.getStatus())

  ipcMain.handle('higgs:generate-scene', (_event, input: GenerateSceneInput) =>
    imageGeneration.generateScene(input),
  )

  ipcMain.handle('higgs:queue-scene', (_event, input: GenerateSceneInput) =>
    imageGeneration.queueScene(input),
  )

  ipcMain.handle('higgs:cancel', () => imageGeneration.cancelGenerations())

  ipcMain.handle('higgs:resume', () => imageGeneration.resumeGenerations())

  ipcMain.handle('llm:get-status', () => codex.getStatus())

  ipcMain.handle('llm:login', () => codex.startLogin())

  ipcMain.handle('llm:generate', (_event, input) => codex.generate(input))

  ipcMain.handle('llm:cancel', (_event, requestId?: string) => codex.cancelActive(requestId))

  ipcMain.handle('youtube:research', (_event, input: VideoIdeaResearchRequest) =>
    researchYouTube(input),
  )

  ipcMain.handle('teleprompter:show', (_event, payload) => teleprompter.show(payload))

  ipcMain.handle('teleprompter:update', (_event, payload) => teleprompter.update(payload))

  ipcMain.handle('teleprompter:hide', () => teleprompter.hide())

  ipcMain.handle('image-inspector:show', (_event, payload) => imageInspector.show(payload))

  ipcMain.handle('image-inspector:update', (_event, payload) => imageInspector.update(payload))

  ipcMain.handle('image-inspector:hide', async () => {
    await imageInspector.hide()
    if (!window.isDestroyed()) window.webContents.send('image-inspector:closed')
  })

  ipcMain.handle('image-inspector:navigate', (_event, delta: number) => {
    if (!window.isDestroyed()) window.webContents.send('image-inspector:navigate', Number(delta) || 0)
  })

  ipcMain.handle('voice-inspector:show', (_event, payload) => voiceInspector.show(payload))

  ipcMain.handle('voice-inspector:update', (_event, payload) => voiceInspector.update(payload))

  ipcMain.handle('voice-inspector:hide', async () => {
    await voiceInspector.hide()
    if (!window.isDestroyed()) window.webContents.send('voice-inspector:closed')
  })

  ipcMain.handle('voice-inspector:navigate', (_event, delta: number) => {
    if (!window.isDestroyed()) window.webContents.send('voice-inspector:navigate', Number(delta) || 0)
  })

  ipcMain.handle('voice-inspector:trim', async (_event, payload: TrimVoiceTakePayload) => {
    const state = await projectStore.trimVoiceTake(payload)
    if (!window.isDestroyed()) window.webContents.send('voice-inspector:project-updated', state)
    return state
  })

  ipcMain.handle(
    'voice-inspector:reset-cleanup',
    async (_event, payload: ResetVoiceTakeCleanupPayload) => {
      const state = await projectStore.resetVoiceTakeCleanup(payload)
      if (!window.isDestroyed()) window.webContents.send('voice-inspector:project-updated', state)
      return state
    },
  )

  ipcMain.handle('export:set-pre-render-paused', (_event, paused: boolean) => {
    exporter.setPreRenderPaused(Boolean(paused))
  })

  ipcMain.handle('export:longform', async (_event, sequence: SequenceId = 'main') => {
    const state = projectStore.get()
    if (!state) throw new Error('Choose a project folder before exporting.')

    const baseName = state.manifest.name.replace(/[^\w\- ]/g, '').trim() || 'higgsfilm-project'
    const suggestedName = `${baseName}${sequence === 'trailer' ? '-9x16' : ''}.mp4`
    const result = await dialog.showSaveDialog(window, {
      title: sequence === 'trailer' ? 'Export 9:16 condensed video' : 'Export 16:9 longform video',
      defaultPath: `${state.rootPath}\\exports\\${suggestedName}`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    })
    if (result.canceled || !result.filePath) return null
    return exporter.exportLongform(result.filePath, sequence)
  })
}
