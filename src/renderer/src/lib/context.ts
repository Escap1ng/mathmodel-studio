import type { ChatMessageInput, ThinkingDepth } from '../../../shared/api'
import { assistantText, type ChatEntry } from './chat'

export interface ContextOption {
  tokens: number
  label: string
}

export const CONTEXT_OPTIONS: ContextOption[] = [
  { tokens: 200_000, label: '200k' },
  { tokens: 400_000, label: '400k' },
  { tokens: 1_000_000, label: '1m' }
]

export const DEPTH_OPTIONS: { value: ThinkingDepth; label: string }[] = [
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'max', label: '最大' }
]

export function contextLabel(tokens: number): string {
  return CONTEXT_OPTIONS.find((option) => option.tokens === tokens)?.label ?? formatTokens(tokens)
}

export function depthLabel(depth: ThinkingDepth): string {
  return DEPTH_OPTIONS.find((option) => option.value === depth)?.label ?? '高'
}

/** 与 runtime 的估算保持一致：CJK 1 字 1 token，其余 3.5 字符 1 token，宁可高估。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x2e80 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk + other / 3.5)
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}m`
  }
  if (tokens >= 1_000) {
    const value = tokens / 1_000
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}k`
  }
  return String(Math.max(0, Math.round(tokens)))
}

/**
 * 会话用量只做显示，按字符数直读，避免流式时每个 token 都把整段历史重扫一遍。
 * 条目不可变，单条结果按引用缓存在 WeakMap：流式期间只有活跃条目重算，
 * 历史条目不再重复 JSON.stringify 工具参数。
 * 回放预算（fitHistory）仍用 estimateTokens，与原文字节分类一致。
 */
const entryCharCache = new WeakMap<ChatEntry, number>()

function entryCharCount(entry: ChatEntry): number {
  const cached = entryCharCache.get(entry)
  if (cached !== undefined) return cached
  let count = 0
  if (entry.role === 'user') {
    const text = entry.context ?? entry.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    count = text.length
  } else {
    count = assistantText(entry).length + entry.reasoning.length
    for (const part of entry.parts) {
      if (part.kind === 'tool') {
        try {
          count += JSON.stringify(part.tool.args ?? {}).length
          if (part.tool.result !== undefined) {
            count += JSON.stringify(part.tool.result).length
          }
        } catch {
          /* 序列化不了的参数不计入，估算只用于显示 */
        }
      }
    }
  }
  entryCharCache.set(entry, count)
  return count
}

export function conversationTokens(entries: ChatEntry[]): number {
  let total = 0
  for (const entry of entries) total += entryCharCount(entry)
  return total
}

/**
 * 只回放放得进预算的历史。最新的附件正文也算在预算内；
 * 一旦当前消息自己就超过上限，宁可不带旧历史，也不要发一个必被截断的请求。
 */
export function fitHistory(
  history: ChatMessageInput[],
  current: string,
  budget: number
): { messages: ChatMessageInput[]; dropped: number } {
  const limit = Math.floor(Math.max(0, budget) * 0.85)
  let used = estimateTokens(current)
  if (used >= limit || history.length === 0) {
    return { messages: [], dropped: history.length }
  }
  const picked: ChatMessageInput[] = []
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    const cost = estimateTokens(message.content)
    if (picked.length > 0 && used + cost > limit) break
    picked.unshift(message)
    used += cost
  }
  while (picked.length > 0 && picked[0].role !== 'user') picked.shift()
  return { messages: picked, dropped: history.length - picked.length }
}
