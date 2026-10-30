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
  mode?: 'chat' | 'workflow'
  messages: ChatMessageInput[]
}

export interface ChatStartResult {
  ok: true
  chatId: string
}

export type DecisionAction = 'confirm' | 'reroll' | 'choose'

export interface ResumeInput {
  sessionId: string
  action: DecisionAction
  choice?: string
}

export interface InterruptCard {
  card: string
  payload: Record<string, unknown>
  resolved?: string
}

export interface SessionMessage {
  role: 'user' | 'assistant'
  content: string
  interrupt?: InterruptCard
}

export type PhaseStatus = 'idle' | 'running' | 'waiting' | 'passed' | 'failed'

export interface SessionPhase {
  phase: number
  status: PhaseStatus
  name: string
}

export interface SessionSnapshot {
  id: string
  provider: string
  model: string
  problem: string
  updatedAt: number
  phases: SessionPhase[]
  pending: InterruptCard | null
  messages: SessionMessage[]
  batch: number
}

export interface SessionLatest {
  ok: true
  session: SessionSnapshot | null
}

export interface ChatEvent {
  chatId: string
  id: string
  event: string
  data: Record<string, unknown>
}
