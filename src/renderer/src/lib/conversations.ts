import type { ChatEntry } from './chat'

const KEY = 'mms.chatConversations.v1'
const MAX_CONVERSATIONS = 30
const MAX_ENTRIES = 80
const MAX_TITLE = 30

export interface ChatConversation {
  id: string
  title: string
  updatedAt: number
  entries: ChatEntry[]
}

export type ConversationKind = 'workflow' | 'chat'

export interface ConversationItem {
  id: string
  kind: ConversationKind
  title: string
  updatedAt: number
  pending?: boolean
}

function cleanEntry(entry: ChatEntry): ChatEntry {
  return {
    ...entry,
    streaming: false,
    doneReason: entry.streaming ? 'cancelled' : entry.doneReason,
    parts: entry.parts.map((part) =>
      part.kind === 'tool' && part.tool.status === 'running'
        ? { ...part, tool: { ...part.tool, status: 'error' as const, error: '上次生成被中断' } }
        : part
    )
  }
}

function cleanEntries(entries: ChatEntry[]): ChatEntry[] {
  return entries.slice(-MAX_ENTRIES).map(cleanEntry)
}

export function titleOf(entries: ChatEntry[]): string {
  const firstUser = entries.find((entry) => entry.role === 'user')
  if (!firstUser) return '新对话'
  const text = firstUser.parts
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  const fallback = firstUser.attachments?.map((item) => item.name).join('、') ?? ''
  const raw = text || fallback
  if (!raw) return '新对话'
  return raw.length > MAX_TITLE ? `${raw.slice(0, MAX_TITLE)}…` : raw
}

function readAll(): ChatConversation[] {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: ChatConversation[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const row = item as Partial<ChatConversation>
      if (typeof row.id !== 'string' || !Array.isArray(row.entries)) continue
      out.push({
        id: row.id,
        title: typeof row.title === 'string' && row.title ? row.title : titleOf(row.entries),
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        entries: cleanEntries(row.entries)
      })
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS)
  } catch {
    return []
  }
}

function writeAll(list: ChatConversation[]): ChatConversation[] {
  let rows = list.slice(0, MAX_CONVERSATIONS)
  for (;;) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(rows))
      return rows
    } catch {
      // 配额不足时先丢最旧的一篇；只剩当前一篇还写不进去就放弃，
      // 让这次对话留在内存里，而不是把整页卡死。
      if (rows.length <= 1) return list
      rows = rows.slice(0, rows.length - 1)
    }
  }
}

export function loadChatConversations(): ChatConversation[] {
  return readAll()
}

export function saveChatConversation(
  conversation: Omit<ChatConversation, 'title'> & { title?: string }
): ChatConversation[] {
  const list = readAll().filter((item) => item.id !== conversation.id)
  const next: ChatConversation = {
    id: conversation.id,
    title: conversation.title || titleOf(conversation.entries),
    updatedAt: conversation.updatedAt || Date.now(),
    entries: cleanEntries(conversation.entries)
  }
  list.unshift(next)
  return writeAll(list.sort((a, b) => b.updatedAt - a.updatedAt))
}

export function removeChatConversation(id: string): ChatConversation[] {
  return writeAll(readAll().filter((item) => item.id !== id))
}

export function clearChatConversations(): void {
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    /* 本地存储不可用时无事可做 */
  }
}
