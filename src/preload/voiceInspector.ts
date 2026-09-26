import { contextBridge, ipcRenderer } from 'electron'
import type {
  AssetData,
  ProjectState,
  ResetVoiceTakeCleanupPayload,
  TrimVoiceTakePayload,
  VoiceInspectorPayload,
} from '../shared/types'

contextBridge.exposeInMainWorld('voiceInspector', {
  onUpdate: (callback: (payload: VoiceInspectorPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: VoiceInspectorPayload) => {
      callback(payload)
    }
    ipcRenderer.on('voice-inspector:update', listener)
    return () => ipcRenderer.removeListener('voice-inspector:update', listener)
  },
  navigate: (delta: number) => ipcRenderer.invoke('voice-inspector:navigate', delta),
  close: () => ipcRenderer.invoke('voice-inspector:hide'),
  loadAudio: (relativePath: string): Promise<AssetData | null> =>
    ipcRenderer.invoke('project:asset-data', relativePath),
  audioPeaks: (relativePath: string, bucketCount?: number): Promise<number[] | null> =>
    ipcRenderer.invoke('project:audio-peaks', relativePath, bucketCount),
  trimVoiceTake: (payload: TrimVoiceTakePayload): Promise<ProjectState> =>
    ipcRenderer.invoke('voice-inspector:trim', payload),
  resetVoiceTakeCleanup: (payload: ResetVoiceTakeCleanupPayload): Promise<ProjectState> =>
    ipcRenderer.invoke('voice-inspector:reset-cleanup', payload),
})
