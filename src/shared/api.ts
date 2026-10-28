// 主进程与渲染层共享的 IPC 形状。这里只放纯类型，不 import electron。

export interface StudioMeta {
  version: string
  platform: string
  Electron: string
  chrome: string
}

export type RuntimeState = 'starting' | 'ready' | 'error'

export interface RuntimeStatus {
  state: RuntimeState
  message?: string
  version?: string
  fake?: boolean
}

export interface ProviderView {
  id: string
  display: string
  models: string[]
  model: string
  baseUrl: string
  requiresKey: boolean
  toolCalling: boolean
  custom: boolean
  configured: boolean
  note?: string
}

export interface ProviderList {
  ok: true
  providers: ProviderView[]
  activeProvider: string
  fake: boolean
}

export interface SaveProviderPayload {
  id: string
  model: string
  apiKey?: string
  baseUrl?: string
}

export interface ChatMessageInput {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatStartInput {
  providerId: string
  model: string
  messages: ChatMessageInput[]
}

export interface ChatStartResult {
  ok: true
  chatId: string
}

export interface ChatEvent {
  chatId: string
  id: string
  event: string
  data: Record<string, unknown>
}
