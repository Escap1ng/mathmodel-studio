import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ProblemFile,
  ProviderList,
  RunEvent,
  RunInput,
  RunStartResult,
  RuntimeStatus,
  SaveProviderInput,
  StudioMeta
} from '../shared/api'

// 渲染层只能看到这几条窄接口：主进程的 runtime 端口、token 与 API Key 都不经过这里。
const studioApi = {
  meta: (): Promise<StudioMeta> => ipcRenderer.invoke('app:meta'),

  runtime: {
    status: (): Promise<RuntimeStatus> => ipcRenderer.invoke('runtime:status'),
    restart: (): Promise<ProviderList> => ipcRenderer.invoke('runtime:restart'),
    onStatus: (cb: (status: RuntimeStatus) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, status: RuntimeStatus): void => cb(status)
      ipcRenderer.on('runtime:status', handler)
      return () => ipcRenderer.removeListener('runtime:status', handler)
    }
  },

  providers: {
    list: (): Promise<ProviderList> => ipcRenderer.invoke('providers:list'),
    save: (payload: SaveProviderInput): Promise<ProviderList> =>
      ipcRenderer.invoke('providers:save', payload),
    clear: (id: string): Promise<ProviderList> => ipcRenderer.invoke('providers:clear', id)
  },

  files: {
    pickProblem: (): Promise<ProblemFile | null> => ipcRenderer.invoke('files:pick-problem'),
    pickData: (): Promise<string[]> => ipcRenderer.invoke('files:pick-data')
  },

  run: {
    start: (input: RunInput): Promise<RunStartResult> => ipcRenderer.invoke('run:start', input),
    cancel: (runId: string): Promise<{ ok: true }> => ipcRenderer.invoke('run:cancel', runId),
    onEvent: (cb: (event: RunEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: RunEvent): void => cb(payload)
      ipcRenderer.on('run:event', handler)
      return () => ipcRenderer.removeListener('run:event', handler)
    }
  },

  artifacts: {
    open: (path: string): Promise<{ ok: true }> => ipcRenderer.invoke('artifact:open', path),
    reveal: (path: string): Promise<{ ok: true }> => ipcRenderer.invoke('artifact:reveal', path),
    image: (path: string): Promise<string | null> => ipcRenderer.invoke('artifact:image', path)
  }
}

contextBridge.exposeInMainWorld('studio', studioApi)

export type StudioApi = typeof studioApi
