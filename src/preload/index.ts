import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type {
  AttachmentContext,
  ChatEvent,
  ChatStartInput,
  ChatStartResult,
  ProviderList,
  ResumeInput,
  RuntimeStatus,
  SaveProviderPayload,
  SessionGet,
  SessionLatest,
  SessionList,
  StageResult,
  StagedFile,
  StagedBlob,
  StudioMeta,
  WorkbenchResult,
  WorkbenchState,
  WorkspaceListing,
  WorkspaceProject
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
    latest: (): Promise<SessionLatest> => ipcRenderer.invoke('session:latest'),
    list: (): Promise<SessionList> => ipcRenderer.invoke('session:list'),
    get: (id: string): Promise<SessionGet> => ipcRenderer.invoke('session:get', id),
    remove: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke('session:delete', id),
    clear: (): Promise<{ ok: true; removed: number }> => ipcRenderer.invoke('session:clear')
  },

  files: {
    pick: (): Promise<StageResult | null> => ipcRenderer.invoke('files:pick'),
    stage: (paths: string[]): Promise<StageResult> => ipcRenderer.invoke('files:stage', paths),
    attach: (rels: string[]): Promise<StageResult> => ipcRenderer.invoke('files:attach', rels),
    stageBlob: (payload: StagedBlob): Promise<StagedFile> => ipcRenderer.invoke('files:stage-blob', payload),
    discard: (path: string): Promise<void> => ipcRenderer.invoke('files:discard', path),
    context: (paths: string[]): Promise<AttachmentContext> => ipcRenderer.invoke('files:context', paths),
    reveal: (): Promise<void> => ipcRenderer.invoke('files:reveal'),
    // 沙箱渲染层拿不到 File.path，路径只能由 preload 里的 webUtils 换出来。
    pathFor: (file: File): string => webUtils.getPathForFile(file)
  },

  workspace: {
    get: (projectId?: string): Promise<WorkspaceListing> =>
      ipcRenderer.invoke('workspace:get', projectId ?? ''),
    choose: (): Promise<WorkspaceListing | null> => ipcRenderer.invoke('workspace:choose'),
    reset: (): Promise<WorkspaceListing> => ipcRenderer.invoke('workspace:reset'),
    reveal: (): Promise<void> => ipcRenderer.invoke('workspace:reveal'),
    open: (rel: string): Promise<void> => ipcRenderer.invoke('workspace:open', rel),
    revealEntry: (rel: string): Promise<void> => ipcRenderer.invoke('workspace:reveal-entry', rel),
    copyPath: (rel: string): Promise<string> => ipcRenderer.invoke('workspace:copy-path', rel),
    trash: (rel: string): Promise<void> => ipcRenderer.invoke('workspace:trash', rel),
    project: (chatId: string): Promise<WorkspaceProject | null> =>
      ipcRenderer.invoke('workspace:project', chatId),
    openProject: (chatId: string): Promise<void> =>
      ipcRenderer.invoke('workspace:open-project', chatId)
  },

  workbench: {
    state: (sessionId?: string): Promise<WorkbenchState> =>
      ipcRenderer.invoke('workbench:state', sessionId ?? ''),
    render: (template: string, theme: string, sessionId?: string): Promise<WorkbenchResult> =>
      ipcRenderer.invoke('workbench:render', { template, theme, sessionId }),
    rollback: (version: string, sessionId?: string): Promise<WorkbenchResult> =>
      ipcRenderer.invoke('workbench:rollback', { version, sessionId })
  },

  paper: {
    build: (sessionId?: string): Promise<WorkbenchResult> =>
      ipcRenderer.invoke('paper:build', sessionId ?? '')
  }
}

contextBridge.exposeInMainWorld('studio', studioApi)

export type StudioApi = typeof studioApi
