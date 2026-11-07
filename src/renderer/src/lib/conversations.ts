import type { ChatEntry } from './chat'

// 索引键只存元数据，每篇对话单独一个键：发送路径只写一篇，不再整个 JSON 来回搬。
const INDEX_KEY = 'mms.chatConversations.index.v2'
const LEGACY_KEY = 'mms.chatConversations.v1'
const MAX_CONVERSATIONS = 60
const MAX_ENTRIES = 300
const MAX_TITLE = 30
// 只有最近几条保留附件全文与思维过程；更早的只留界面文本，避免单条键值撑爆。
const FULL_CONTEXT_ENTRIES = 8

const convKey = (id: string): string => `mms.chatConv.${id}`

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

interface IndexRow {
  id: string
  title: string
  updatedAt: number
}

interface StoredConversation {
  title: string
  updatedAt: number
  entries: ChatEntry[]
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
  const kept = entries.slice(-MAX_ENTRIES)
  return kept.map((entry, index) => {
    const cleaned = cleanEntry(entry)
    if (kept.length - index > FULL_CONTEXT_ENTRIES) {
      return { ...cleaned, reasoning: '', context: undefined }
    }
    return cleaned
  })
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

function readIndex(): IndexRow[] {
  try {
    const raw = window.localStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const rows: IndexRow[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const row = item as Partial<IndexRow>
      if (typeof row.id !== 'string' || !row.id) continue
      rows.push({
        id: row.id,
        title: typeof row.title === 'string' && row.title ? row.title : '新对话',
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0
      })
    }
    return rows
  } catch {
    return []
  }
}

function readRowContent(id: string): StoredConversation | null {
  try {
    const raw = window.localStorage.getItem(convKey(id))
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { entries?: unknown }).entries)) {
      return null
    }
    const row = parsed as Partial<StoredConversation>
    return {
      title: typeof row.title === 'string' && row.title ? row.title : '新对话',
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
      entries: cleanEntries(row.entries ?? [])
    }
  } catch {
    return null
  }
}

function writeRowContent(row: { id: string; title: string; updatedAt: number; entries: ChatEntry[] }): boolean {
  try {
    window.localStorage.setItem(
      convKey(row.id),
      JSON.stringify({ title: row.title, updatedAt: row.updatedAt, entries: row.entries })
    )
    return true
  } catch {
    return false
  }
}

function writeIndex(rows: IndexRow[]): boolean {
  try {
    window.localStorage.setItem(INDEX_KEY, JSON.stringify(rows))
    return true
  } catch {
    return false
  }
}

function dropOldest(index: IndexRow[]): IndexRow[] {
  const sorted = [...index].sort((a, b) => b.updatedAt - a.updatedAt)
  const dropped = sorted[sorted.length - 1]
  if (!dropped) return sorted
  try {
    window.localStorage.removeItem(convKey(dropped.id))
  } catch {
    /* 配额清理失败不影响下一轮重试 */
  }
  return sorted.filter((row) => row.id !== dropped.id)
}

/**
 * 旧版单键迁移：拆成分片逐篇写，已经分过片的不再重写；
 * 全部写成功且索引落盘才删旧键；配额写不进去的篇目留在旧键里，
 * 由调用方直接当作 fallback 数据展示，下次打开窗口再迁移。
 */
function migrateLegacy(): { index: IndexRow[]; fallback: ChatConversation[] } {
  const index = readIndex()
  const fallback: ChatConversation[] = []
  let legacy: ChatConversation[]
  try {
    const raw = window.localStorage.getItem(LEGACY_KEY)
    if (!raw) return { index, fallback }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return { index, fallback }
    legacy = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || !Array.isArray((item as { entries?: unknown }).entries)) {
        continue
      }
      const row = item as Partial<ChatConversation>
      if (typeof row.id !== 'string' || !row.id) continue
      legacy.push({
        id: row.id,
        title: typeof row.title === 'string' && row.title ? row.title : '新对话',
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        entries: cleanEntries(row.entries ?? [])
      })
    }
  } catch {
    return { index, fallback }
  }
  for (const row of legacy) {
    const existing = index.find((r) => r.id === row.id)
    if (existing && readRowContent(row.id)) continue
    if (!writeRowContent(row)) {
      fallback.push(row)
      continue
    }
    if (existing) {
      existing.title = row.title
      existing.updatedAt = row.updatedAt
    } else {
      index.push({ id: row.id, title: row.title, updatedAt: row.updatedAt })
    }
  }
  index.sort((a, b) => b.updatedAt - a.updatedAt)
  if (!writeIndex(index)) return { index: readIndex(), fallback }
  if (fallback.length === 0) {
    try {
      window.localStorage.removeItem(LEGACY_KEY)
    } catch {
      /* 删不掉只影响下次少做一次迁移 */
    }
  }
  return { index, fallback }
}

function readAll(): ChatConversation[] {
  const { index, fallback } = migrateLegacy()
  const out: ChatConversation[] = []
  for (const row of index) {
    const content = readRowContent(row.id)
    if (content) {
      out.push({
        id: row.id,
        title: content.title || row.title,
        updatedAt: content.updatedAt || row.updatedAt,
        entries: content.entries
      })
    }
  }
  for (const row of fallback) out.push(row)
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function loadChatConversations(): ChatConversation[] {
  return readAll()
}

/**
 * 保存一篇并更新索引。current 传调用方内存里的完整列表，省掉逐篇分片读回；
 * 内存里被裁剪过正文的篇目落盘前从磁盘补回。配额不足时丢一篇重试一次；
 * 连当前一篇都写不进去就整体放弃，并恢复落盘前的索引与分片，
 * 返回的内存列表照常更新界面。
 */
export function saveChatConversation(
  conversation: Omit<ChatConversation, 'title'> & { title?: string },
  current: ChatConversation[]
): ChatConversation[] {
  const next: ChatConversation = {
    id: conversation.id,
    title: conversation.title || titleOf(conversation.entries),
    updatedAt: conversation.updatedAt || Date.now(),
    entries: cleanEntries(conversation.entries)
  }
  // 较旧的写入直接拒绝：迟到的那次保存不能盖掉最新状态。
  const existing = current.find((row) => row.id === next.id)
  let list: ChatConversation[]
  if (existing && existing.updatedAt >= next.updatedAt) {
    list = current.map((row) => (row.id === next.id ? { ...row, entries: next.entries } : row))
    return list.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  list = [...current.filter((row) => row.id !== next.id), next]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS)
  for (const row of list) {
    if (row.entries.length > 0) continue
    const content = readRowContent(row.id)
    if (content) {
      list = list.map((item) =>
        item.id === row.id
          ? { id: row.id, title: content.title || row.title, updatedAt: content.updatedAt || row.updatedAt, entries: content.entries }
          : item
      )
    }
  }
  const initial = list
  const droppedRows: ChatConversation[] = []
  for (;;) {
    if (writeRowContent(next) && writeIndex(toIndex(list))) break
    const oldest = [...list.filter((row) => row.id !== next.id)].sort(
      (a, b) => a.updatedAt - b.updatedAt
    )[0]
    if (!oldest) {
      // 放弃：恢复落盘前的索引与分片，别把索引挂在只有元数据没有正文的篇目上。
      writeIndex(toIndex(initial.filter((row) => row.id !== next.id)))
      for (const row of droppedRows) writeRowContent(row)
      return list
    }
    droppedRows.push(oldest)
    list = list.filter((row) => row.id !== oldest.id)
  }
  for (const row of droppedRows) {
    try {
      window.localStorage.removeItem(convKey(row.id))
    } catch {
      /* 删除失败留下孤儿分片，无害 */
    }
  }
  return list
}

const toIndex = (rows: ChatConversation[]): IndexRow[] =>
  rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updatedAt }))

export function removeChatConversation(id: string): ChatConversation[] {
  const kept = readIndex().filter((row) => row.id !== id)
  try {
    window.localStorage.removeItem(convKey(id))
  } catch {
    /* 无妨 */
  }
  if (!writeIndex(kept)) writeIndex(dropOldest(kept))
  return readAll()
}

export function clearChatConversations(): void {
  try {
    for (const row of readIndex()) window.localStorage.removeItem(convKey(row.id))
    window.localStorage.removeItem(INDEX_KEY)
    window.localStorage.removeItem(LEGACY_KEY)
  } catch {
    /* 本地存储不可用时无事可做 */
  }
}
