import { contextBridge, ipcRenderer } from 'electron'
import type { ProjectState, StudioApi } from '../shared/types'

const studioApi: StudioApi = {
  project: {
    choose: () => ipcRenderer.invoke('project:choose'),
    importScript: () => ipcRenderer.invoke('project:import-script'),
    importScriptText: (script) => ipcRenderer.invoke('project:import-script-text', script),
    get: () => ipcRenderer.invoke('project:get'),
    save: (manifest) => ipcRenderer.invoke('project:save', manifest),
    saveRecording: (payload) => ipcRenderer.invoke('project:save-recording', payload),
    assetDataUrl: (relativePath) => ipcRenderer.invoke('project:asset-data', relativePath),
  },
  settings: {
    getHiggs: () => ipcRenderer.invoke('settings:get-higgs'),
    loginHiggs: () => ipcRenderer.invoke('settings:login-higgs'),
  },
  higgs: {
    generateScene: (input) => ipcRenderer.invoke('higgs:generate-scene', input),
    queueScene: (input) => ipcRenderer.invoke('higgs:queue-scene', input),
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
    cancel: () => ipcRenderer.invoke('llm:cancel'),
  },
  teleprompter: {
    show: (payload) => ipcRenderer.invoke('teleprompter:show', payload),
    update: (payload) => ipcRenderer.invoke('teleprompter:update', payload),
    hide: () => ipcRenderer.invoke('teleprompter:hide'),
  },
  export: {
    longform: () => ipcRenderer.invoke('export:longform'),
  },
}

contextBridge.exposeInMainWorld('studio', studioApi)
