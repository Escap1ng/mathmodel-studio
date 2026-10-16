import { contextBridge, ipcRenderer } from 'electron'

export interface StudioMeta {
  version: string
  platform: string
  Electron: string
  chrome: string
}

const studioApi = {
  meta: (): Promise<StudioMeta> => ipcRenderer.invoke('app:meta')
}

contextBridge.exposeInMainWorld('studio', studioApi)

export type StudioApi = typeof studioApi
