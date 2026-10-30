import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ChatEvent,
  ChatStartInput,
  ChatStartResult,
  ProviderList,
  ResumeInput,
  RuntimeStatus,
  SaveProviderPayload,
  SessionLatest,
  StudioMeta,
  WorkbenchResult,
  WorkbenchState
} from '../shared/api'

// 渲染层只能看到这几条窄接口：主进程的 runtime 端口、token 与 API Key 都不经过这里。
// 所有返回值都是可结构化克隆的纯数据，订阅函数返回一个取消订阅的闭包。
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
    save: (payload: SaveProviderPayload): Promise<ProviderList> =>
      ipcRenderer.invoke('providers:save', payload),
    clear: (id: string): Promise<ProviderList> => ipcRenderer.invoke('providers:clear', id)
  },

  chat: {
    start: (input: ChatStartInput): Promise<ChatStartResult> => ipcRenderer.invoke('chat:start', input),
    resume: (input: ResumeInput): Promise<ChatStartResult> => ipcRenderer.invoke('chat:resume', input),
    cancel: (chatId: string): Promise<{ ok: true }> => ipcRenderer.invoke('chat:cancel', chatId),
    onEvent: (cb: (event: ChatEvent) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, payload: ChatEvent): void => cb(payload)
      ipcRenderer.on('chat:event', handler)
      return () => ipcRenderer.removeListener('chat:event', handler)
    }
  },

  session: {
    latest: (): Promise<SessionLatest> => ipcRenderer.invoke('session:latest')
  },

  workbench: {
    state: (): Promise<WorkbenchState> => ipcRenderer.invoke('workbench:state'),
    render: (template: string, theme: string): Promise<WorkbenchResult> =>
      ipcRenderer.invoke('workbench:render', { template, theme }),
    rollback: (version: string): Promise<WorkbenchResult> =>
      ipcRenderer.invoke('workbench:rollback', { version })
  },

  paper: {
    build: (): Promise<WorkbenchResult> => ipcRenderer.invoke('paper:build')
  }
}

contextBridge.exposeInMainWorld('studio', studioApi)

export type StudioApi = typeof studioApi
