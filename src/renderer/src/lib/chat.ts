import type { ChatEvent, InterruptCard } from '../../../shared/api'
import type { AttachmentRef } from './attachments'

// 一条助手回复由若干段组成：文字与工具卡按发生顺序排列，
// 这样「先说一句 → 调工具 → 再总结」在界面上不会被打乱成两段。
export type ChatPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: ToolCard }

export interface ToolCard {
  id: string
  name: string
  status: 'running' | 'ok' | 'error'
  args: unknown
  result?: unknown
  error?: string
  durationMs?: number
}

export interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  reasoning: string
  parts: ChatPart[]
  streaming: boolean
  error?: string
  doneReason?: string
  interrupt?: InterruptCard
  /** 上下文压缩分隔线：只用于显示，不参与模型输入。 */
  notice?: string
  /** 随这条消息发送的附件；只用于显示与恢复，不参与渲染正文。 */
  attachments?: AttachmentRef[]
  /** 送给模型的全文（含附件正文）；历史重放用它，不用界面上显示的那段。 */
  context?: string
}

/** 送给模型的助手文本：只保留文字段，工具卡本身由 runtime 的历史负责。 */
export function assistantText(entry: ChatEntry): string {
  return entry.parts
    .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toolFromEvent(data: Record<string, unknown>): ToolCard {
  const status = data.status === 'ok' || data.status === 'error' ? data.status : 'running'
  return {
    id: typeof data.id === 'string' && data.id ? data.id : `tool_${Math.random().toString(36).slice(2)}`,
    name: typeof data.name === 'string' ? data.name : 'tool',
    status,
    args: data.args ?? {},
    result: data.result,
    error: typeof data.error === 'string' ? data.error : undefined,
    durationMs: typeof data.duration_ms === 'number' ? data.duration_ms : undefined
  }
}

/** 把一条 SSE 事件折进当前助手消息。纯函数，渲染层只在收到事件时调用。 */
export function applyChatEvent(entry: ChatEntry, event: ChatEvent): ChatEntry {
  const data = event.data
  switch (event.event) {
    case 'token': {
      const text = typeof data.text === 'string' ? data.text : ''
      if (!text) return entry
      const parts = entry.parts.slice()
      const last = parts[parts.length - 1]
      if (last && last.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + text }
      else parts.push({ kind: 'text', text })
      return { ...entry, parts }
    }
    case 'reasoning': {
      const text = typeof data.text === 'string' ? data.text : ''
      return text ? { ...entry, reasoning: entry.reasoning + text } : entry
    }
    case 'tool_call': {
      const tool = toolFromEvent(data)
      const parts = entry.parts.slice()
      const index = parts.findIndex((p) => p.kind === 'tool' && p.tool.id === tool.id)
      if (index >= 0) {
        const prev = parts[index]
        if (prev.kind === 'tool') parts[index] = { kind: 'tool', tool: { ...prev.tool, ...tool } }
      } else {
        parts.push({ kind: 'tool', tool })
      }
      return { ...entry, parts }
    }
    case 'error': {
      const message = typeof data.message === 'string' ? data.message : '运行时返回了一个错误'
      return { ...entry, error: message, streaming: false }
    }
    case 'interrupt': {
      const card = typeof data.card === 'string' ? data.card : ''
      const payload = isRecord(data.payload) ? data.payload : {}
      return card ? { ...entry, interrupt: { card, payload } } : entry
    }
    case 'done': {
      return {
        ...entry,
        streaming: false,
        doneReason: typeof data.reason === 'string' ? data.reason : 'stop'
      }
    }
    default:
      // gate / artifact 留给后面的里程碑；未知事件不能打断当前流。
      return entry
  }
}

export function isRecordData(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
}
