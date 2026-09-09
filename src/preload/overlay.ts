import { contextBridge, ipcRenderer } from 'electron'
import type { RecordingFocusPayload } from '../shared/types'

contextBridge.exposeInMainWorld('teleprompterOverlay', {
  onUpdate: (callback: (payload: RecordingFocusPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RecordingFocusPayload) => {
      callback(payload)
    }
    ipcRenderer.on('teleprompter:update', listener)
    return () => ipcRenderer.removeListener('teleprompter:update', listener)
  },
})
