// 主进程与渲染层共享的 IPC 形状。这里只放纯类型，不 import electron。

export interface StudioMeta {
  version: string
  platform: string
  electron: string
  chrome: string
}

export type RuntimeState = 'starting' | 'ready' | 'error'

export interface RuntimeStatus {
  state: RuntimeState
  message?: string
  version?: string
}

export interface ProviderView {
  id: string
  display: string
  models: string[]
  model: string
  baseUrl: string
  requiresKey: boolean
  custom: boolean
  configured: boolean
  note?: string
}

export interface ProviderList {
  ok: true
  providers: ProviderView[]
  activeProvider: string
}

export interface SaveProviderInput {
  id: string
  model: string
  apiKey?: string
  baseUrl?: string
}

export interface ProblemFile {
  path: string
  text: string
}

export interface RunInput {
  problem: string
  dataPaths: string[]
  providerId: string
  model: string
}

export interface RunStartResult {
  ok: true
  runId: string
}

export type PhaseStatus = 'running' | 'ok' | 'error'

export interface PhaseData {
  id: number
  label: string
  status: PhaseStatus
  detail?: string
}

export interface LogData {
  level: 'info' | 'warn' | 'error'
  text: string
}

export interface RunOutputs {
  dir?: string
  code?: string
  resultJson?: string
  png?: string
  pdf?: string
  svg?: string
  paperPdf?: string
  paperDocx?: string
  paperTex?: string
  paperError?: string
}

export interface DoneData {
  ok: boolean
  cancelled?: boolean
  error?: string
  outputs: RunOutputs
  picked?: string
  sources?: Record<string, string>
  seconds?: number
}

export interface RunEvent {
  runId: string
  id: string
  event: string
  data: Record<string, unknown>
}

export interface RunSummary {
  ok: boolean
  error: string
  problem: string
  picked?: { name?: string }
  sources?: Record<string, string>
  outputs: RunOutputs
  seconds?: number
}
