import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectState, StudioApi } from '../shared/types'

const studioApi: StudioApi = {
  project: {
    choose: () => ipcRenderer.invoke('project:choose'),
    importScript: (sequence, lineMode, stillLibraryPath) =>
      ipcRenderer.invoke('project:import-script', sequence, lineMode, stillLibraryPath),
    importScriptText: (script, sequence, lineMode, stillLibraryPath) =>
      ipcRenderer.invoke('project:import-script-text', script, sequence, lineMode, stillLibraryPath),
    get: () => ipcRenderer.invoke('project:get'),
    close: () => ipcRenderer.invoke('project:close'),
    save: (manifest) => ipcRenderer.invoke('project:save', manifest),
    resetSceneGenerationCache: (sequence) =>
      ipcRenderer.invoke('project:reset-scene-generation-cache', sequence),
    saveRecording: (payload) => ipcRenderer.invoke('project:save-recording', payload),
    saveStanzaRecording: (payload) => ipcRenderer.invoke('project:save-stanza-recording', payload),
    trimVoiceTake: (payload) => ipcRenderer.invoke('project:trim-voice-take', payload),
    resetVoiceTakeCleanup: (payload) => ipcRenderer.invoke('project:reset-voice-cleanup', payload),
    assetDataUrl: (relativePath) => ipcRenderer.invoke('project:asset-data', relativePath),
    audioPeaks: (relativePath, bucketCount) =>
      ipcRenderer.invoke('project:audio-peaks', relativePath, bucketCount),
    assetThumbDataUrl: (relativePath, maxEdge) =>
      ipcRenderer.invoke('project:asset-thumb', relativePath, maxEdge),
    copyImageToClipboard: (relativePath) => ipcRenderer.invoke('project:copy-image', relativePath),
    saveScriptCreator: (draft) => ipcRenderer.invoke('project:save-script-creator', draft),
  },
  productionBibles: {
    list: () => ipcRenderer.invoke('production-bibles:list'),
    save: (name, bible) => ipcRenderer.invoke('production-bibles:save', name, bible),
    load: (name) => ipcRenderer.invoke('production-bibles:load', name),
  },
  channelProfiles: {
    list: () => ipcRenderer.invoke('channel-profiles:list'),
    save: (input) => ipcRenderer.invoke('channel-profiles:save', input),
    remove: (id) => ipcRenderer.invoke('channel-profiles:remove', id),
    apply: (id) => ipcRenderer.invoke('channel-profiles:apply', id),
    chooseFolder: () => ipcRenderer.invoke('channel-profiles:choose-folder'),
  },
  stillCast: {
    chooseLibrary: () => ipcRenderer.invoke('still-cast:choose-library'),
    scanLibrary: (libraryPath) => ipcRenderer.invoke('still-cast:scan-library', libraryPath),
    scanCatalog: (libraryPath) => ipcRenderer.invoke('still-cast:scan-catalog', libraryPath),
    prepareLibrary: (libraryPath) => ipcRenderer.invoke('still-cast:prepare-library', libraryPath),
    assignImages: (input) => ipcRenderer.invoke('still-cast:assign-images', input),
    setExpression: (input) => ipcRenderer.invoke('still-cast:set-expression', input),
  },
  customImages: {
    getSetup: () => ipcRenderer.invoke('custom-image:get-setup'),
    chooseGuide: () => ipcRenderer.invoke('custom-image:choose-guide'),
    chooseCharacterSheet: () => ipcRenderer.invoke('custom-image:choose-character-sheet'),
    chooseReferences: () => ipcRenderer.invoke('custom-image:choose-references'),
    generate: (input) => ipcRenderer.invoke('custom-image:generate', input),
    missingBrief: () => ipcRenderer.invoke('custom-image:missing-brief'),
    scriptCreatorBrief: (input) => ipcRenderer.invoke('custom-image:script-creator-brief', input),
    cancel: () => ipcRenderer.invoke('custom-image:cancel'),
    onProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]) =>
        callback(progress)
      ipcRenderer.on('custom-image:progress', listener)
      return () => ipcRenderer.removeListener('custom-image:progress', listener)
    },
  },
  expressionImages: {
    getSetup: () => ipcRenderer.invoke('expression-image:get-setup'),
    chooseGuide: () => ipcRenderer.invoke('expression-image:choose-guide'),
    chooseBackground: () => ipcRenderer.invoke('expression-image:choose-background'),
    generate: (input) => ipcRenderer.invoke('expression-image:generate', input),
    cancel: () => ipcRenderer.invoke('expression-image:cancel'),
    onProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]) =>
        callback(progress)
      ipcRenderer.on('expression-image:progress', listener)
      return () => ipcRenderer.removeListener('expression-image:progress', listener)
    },
  },
  scriptBible: {
    choose: () => ipcRenderer.invoke('script-bible:choose'),
    read: (filePath) => ipcRenderer.invoke('script-bible:read', filePath),
  },
  ideaGuide: {
    choose: () => ipcRenderer.invoke('idea-guide:choose'),
    read: (filePath) => ipcRenderer.invoke('idea-guide:read', filePath),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    getHiggs: () => ipcRenderer.invoke('settings:get-higgs'),
    loginHiggs: () => ipcRenderer.invoke('settings:login-higgs'),
    getComfyStatus: () => ipcRenderer.invoke('settings:get-comfy-status'),
  },
  higgs: {
    generateScene: (input) => ipcRenderer.invoke('higgs:generate-scene', input),
    queueScene: (input) => ipcRenderer.invoke('higgs:queue-scene', input),
    cancel: () => ipcRenderer.invoke('higgs:cancel'),
    resume: () => ipcRenderer.invoke('higgs:resume'),
    onUpdate: (callback: (state: ProjectState) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, state: ProjectState) => callback(state)
      ipcRenderer.on('higgs:scene-update', listener)
      return () => ipcRenderer.removeListener('higgs:scene-update', listener)
    },
  },
  llm: {
    getStatus: () => ipcRenderer.invoke('llm:get-status'),
    login: () => ipcRenderer.invoke('llm:login'),
    generate: (input) => ipcRenderer.invoke('llm:generate', input),
    cancel: (requestId) => ipcRenderer.invoke('llm:cancel', requestId),
  },
  youtube: {
    research: (input) => ipcRenderer.invoke('youtube:research', input),
  },
  teleprompter: {
    show: (payload) => ipcRenderer.invoke('teleprompter:show', payload),
    update: (payload) => ipcRenderer.invoke('teleprompter:update', payload),
    hide: () => ipcRenderer.invoke('teleprompter:hide'),
  },
  imageInspector: {
    show: (payload) => ipcRenderer.invoke('image-inspector:show', payload),
    update: (payload) => ipcRenderer.invoke('image-inspector:update', payload),
    hide: () => ipcRenderer.invoke('image-inspector:hide'),
    onNavigate: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, delta: number) => callback(delta)
      ipcRenderer.on('image-inspector:navigate', listener)
      return () => ipcRenderer.removeListener('image-inspector:navigate', listener)
    },
    onClosed: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('image-inspector:closed', listener)
      return () => ipcRenderer.removeListener('image-inspector:closed', listener)
    },
  },
  voiceInspector: {
    show: (payload) => ipcRenderer.invoke('voice-inspector:show', payload),
    update: (payload) => ipcRenderer.invoke('voice-inspector:update', payload),
    hide: () => ipcRenderer.invoke('voice-inspector:hide'),
    onNavigate: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, delta: number) => callback(delta)
      ipcRenderer.on('voice-inspector:navigate', listener)
      return () => ipcRenderer.removeListener('voice-inspector:navigate', listener)
    },
    onClosed: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('voice-inspector:closed', listener)
      return () => ipcRenderer.removeListener('voice-inspector:closed', listener)
    },
    onProjectUpdated: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) =>
        callback(state)
      ipcRenderer.on('voice-inspector:project-updated', listener)
      return () => ipcRenderer.removeListener('voice-inspector:project-updated', listener)
    },
  },
  export: {
    longform: (sequence) => ipcRenderer.invoke('export:longform', sequence),
    setPreRenderPaused: (paused) => ipcRenderer.invoke('export:set-pre-render-paused', paused),
  },
  qwen: {
    getStatus: () => ipcRenderer.invoke('qwen:get-status'),
    chooseReference: () => ipcRenderer.invoke('qwen:choose-reference'),
    saveReferenceText: (text) => ipcRenderer.invoke('qwen:save-reference-text', text),
    generate: (input) => ipcRenderer.invoke('qwen:generate', input),
    realign: (input) => ipcRenderer.invoke('qwen:realign', input),
    cancel: () => ipcRenderer.invoke('qwen:cancel'),
    onProgress: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]) =>
        callback(progress)
      ipcRenderer.on('qwen:progress', listener)
      return () => ipcRenderer.removeListener('qwen:progress', listener)
    },
  },
}

contextBridge.exposeInMainWorld('studio', studioApi)
