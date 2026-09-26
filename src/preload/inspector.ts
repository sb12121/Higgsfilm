import { contextBridge, ipcRenderer } from 'electron'
import type { AssetData, ImageInspectorPayload } from '../shared/types'

contextBridge.exposeInMainWorld('imageInspector', {
  onUpdate: (callback: (payload: ImageInspectorPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ImageInspectorPayload) => {
      callback(payload)
    }
    ipcRenderer.on('image-inspector:update', listener)
    return () => ipcRenderer.removeListener('image-inspector:update', listener)
  },
  navigate: (delta: number) => ipcRenderer.invoke('image-inspector:navigate', delta),
  close: () => ipcRenderer.invoke('image-inspector:hide'),
  loadImage: (relativePath: string): Promise<AssetData | null> =>
    ipcRenderer.invoke('project:asset-data', relativePath),
})
