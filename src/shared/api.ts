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

export interface FigureTemplate {
  id: string
  title: string
  group: string
}

export interface FigureTheme {
  id: string
  title: string
  builtin: boolean
}

export interface FigureVersion {
  id: string
  label: string
  template: string
  template_title: string
  theme: string
  theme_title: string
  created: number
  outputs: Record<string, string>
  command: string
  stdout: string
  stderr: string
}

export interface FigureState {
  ok: boolean
  templates: FigureTemplate[]
  themes: FigureTheme[]
  versions: FigureVersion[]
  active: string | null
  active_png: string | null
  previous: string | null
  previous_png: string | null
  activeImage?: string | null
  previousImage?: string | null
  error?: string
}

export interface ScoreDimension {
  id: string
  label: string
  score: number
  max: number
}

export interface ScoreDeduction {
  dim: string
  dim_id: string
  item: string
  penalty: number
  note: string
  target: string
  suggestion: string
}

export interface ScoreChange {
  dim: string
  from: number
  to: number
  delta: number
}

export interface ScoreRound {
  paper: string
  round: number
  veto: boolean
  total: number
  max: number
  pass_score: number
  pass: boolean
  verdict: 'pass' | 'fix' | 'veto'
  dimensions: ScoreDimension[]
  deductions: ScoreDeduction[]
  changes: ScoreChange[]
  breaker: boolean
}

export interface ChapterState {
  ok: boolean
  pass?: boolean
  hard_failed?: number
  soft_failed?: number
  manual?: number
  pass_count?: number
  error?: string
}

export interface ScoreState {
  ok: boolean
  rounds: ScoreRound[]
  veto: ScoreRound | null
  defaultRound: number
  chapter?: ChapterState
  error?: string
}

export interface GateRow {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface PaperTool {
  found: boolean
  path: string
  version: string
}

export interface PaperEnv {
  ok: boolean
  missing: string[]
  xelatex: PaperTool
  pandoc: PaperTool
  python_docx: boolean
}

export interface PaperStep {
  id: string
  label: string
  ok: boolean
  detail: string
  ms?: number
}

export interface PaperGate {
  id: string
  label: string
  ok: boolean
  detail: string
}

export interface PaperArtifact {
  path: string
  size: number
}

export interface PaperState {
  ok: boolean
  env: PaperEnv
  artifacts: Record<string, PaperArtifact>
  builtAt: string | null
  steps: PaperStep[]
  gates: PaperGate[]
  error: string | null
  logTail: string
  workspace: string
  pdfData?: string | null
}

export interface WorkbenchState {
  ok: boolean
  figure: FigureState
  score: ScoreState
  chapter: ChapterState
  paper: PaperState
  gate: GateRow[]
}

export interface WorkbenchResult {
  ok: boolean
  state: WorkbenchState
}

export interface StagedFile {
  id: string
  name: string
  size: number
  ext: string
  kind: 'pdf' | 'doc' | 'sheet' | 'image' | 'text' | 'other'
  path: string
}

export interface StageRejection {
  name: string
  reason: string
}

// 截图 / 剪贴板文件没有本地路径，字节直接交给主进程写进暂存区。
export interface StagedBlob {
  name: string
  data: ArrayBuffer
}

export interface StageResult {
  ok: true
  files: StagedFile[]
  rejected: StageRejection[]
  folder: string
}

export type FileKind = 'dir' | StagedFile['kind']

export interface WorkspaceInfo {
  path: string
  defaultPath: string
  isDefault: boolean
}

export interface WorkspaceEntry {
  name: string
  rel: string
  dir: string
  size: number
  mtime: number
  ext: string
  kind: FileKind
}

export interface WorkspaceListing {
  ok: true
  info: WorkspaceInfo
  entries: WorkspaceEntry[]
  totalSize: number
  truncated: boolean
}

export interface AttachmentBlock {
  name: string
  kind: StagedFile['kind']
  text: string
  note?: string
}

export interface AttachmentContext {
  ok: true
  blocks: AttachmentBlock[]
  truncated: boolean
}

export interface ChatEvent {
  chatId: string
  id: string
  event: string
  data: Record<string, unknown>
}
