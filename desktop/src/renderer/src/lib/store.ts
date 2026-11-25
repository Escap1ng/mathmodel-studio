import type { RunOutputs } from '../../../shared/api'

export interface Conversation {
  id: string
  title: string
  problem: string
  dataPaths: string[]
  runId?: string
  status: 'idle' | 'running' | 'done' | 'error'
  outputs?: RunOutputs
  picked?: string
  sources?: Record<string, string>
  seconds?: number
  error?: string
  createdAt: number
}

export interface Workspace {
  id: string
  name: string
  conversations: Conversation[]
}

export interface UiState {
  workspaces: Workspace[]
  activeWorkspaceId: string
  activeConversationId: string | null
}

const KEY = 'mms.ui.v1'

export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function defaultUi(): UiState {
  const workspace: Workspace = { id: uid('w'), name: '默认工作区', conversations: [] }
  return { workspaces: [workspace], activeWorkspaceId: workspace.id, activeConversationId: null }
}

export function loadUi(): UiState {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return defaultUi()
    const parsed = JSON.parse(raw) as Partial<UiState>
    if (!Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) return defaultUi()
    const workspaces = parsed.workspaces.filter(
      (item): item is Workspace => Boolean(item && typeof item.id === 'string' && Array.isArray(item.conversations))
    )
    if (workspaces.length === 0) return defaultUi()
    const activeWorkspaceId =
      typeof parsed.activeWorkspaceId === 'string' && workspaces.some((w) => w.id === parsed.activeWorkspaceId)
        ? parsed.activeWorkspaceId
        : workspaces[0].id
    const active = workspaces.find((w) => w.id === activeWorkspaceId)
    const activeConversationId =
      typeof parsed.activeConversationId === 'string' &&
      active?.conversations.some((c) => c.id === parsed.activeConversationId)
        ? parsed.activeConversationId
        : null
    return { workspaces, activeWorkspaceId, activeConversationId }
  } catch {
    return defaultUi()
  }
}

export function saveUi(state: UiState): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // 存储不可用时只影响会话列表持久化，不影响运行
  }
}

export function conversationTitle(problem: string): string {
  const first = problem.trim().split(/\r?\n/)[0] ?? ''
  return first.slice(0, 24) || '新对话'
}
