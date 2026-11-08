import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type {
  ChatEvent,
  ChatMessageInput,
  ChatStartInput,
  DecisionAction,
  ProviderList,
  RuntimeStatus,
  SessionSnapshot,
  SessionSummary
} from '../../shared/api'
import ChatPane from './components/chat/ChatPane'
import { candidatesOf, type ModelCandidate } from './components/chat/DecisionCard'
import ExplainDrawer from './components/chat/ExplainDrawer'
import PhaseRail from './components/rail/PhaseRail'
import SettingsDialog from './components/settings/SettingsDialog'
import WorkspacePane from './components/workspace/WorkspacePane'
import { splitContextContent, type SendExtras } from './lib/attachments'
import { applyChatEvent, assistantText, type ChatEntry } from './lib/chat'
import { contextLabel, conversationTokens, depthLabel, fitHistory } from './lib/context'
import {
  clearChatConversations,
  loadChatConversations,
  removeChatConversation,
  saveChatConversation,
  titleOf,
  type ChatConversation,
  type ConversationItem,
  type ConversationKind
} from './lib/conversations'
import { PHASES, type PhaseState } from './lib/phases'

// 类型由 src/preload/index.d.ts 声明的全局 window.studio 反推，
// 避免把依赖 electron 的 preload 源文件拉进渲染层类型图。
type StudioMeta = Awaited<ReturnType<typeof window.studio.meta>>

type Accent = 'a' | 'b' | 'c'
const ACCENTS: Record<Accent, string> = { a: '松绿', b: '靛蓝', c: '朱砂' }

const RAIL_WIDTH = 240
const PANE_MIN = 380
const PANE_MAX = 1100
const CHAT_MIN = 480
const PANE_STORAGE_KEY = 'mms.paneWidth'
// 收合偏好按模式分开记；旧单键启动时迁移，迁移完即删。
const LEGACY_COLLAPSE_KEY = 'mms.workspaceCollapsed'
const COLLAPSE_KEYS: Record<'workflow' | 'chat', string> = {
  workflow: 'mms.workspaceCollapsed.workflow',
  chat: 'mms.workspaceCollapsed.chat'
}

type CollapseByMode = Record<'workflow' | 'chat', boolean>

function readWorkspaceCollapse(): CollapseByMode {
  const defaults: CollapseByMode = { workflow: false, chat: true }
  try {
    const legacy = window.localStorage.getItem(LEGACY_COLLAPSE_KEY)
    if (legacy != null) {
      // 旧键不分模式，两模式先各承接一份；用户手动 toggle 后自然会走各自的键。
      const value = legacy === '1'
      const next: CollapseByMode = { workflow: value, chat: value }
      window.localStorage.removeItem(LEGACY_COLLAPSE_KEY)
      for (const mode of ['workflow', 'chat'] as const) {
        window.localStorage.setItem(COLLAPSE_KEYS[mode], next[mode] ? '1' : '0')
      }
      return next
    }
    const read = (mode: 'workflow' | 'chat'): boolean => {
      const raw = window.localStorage.getItem(COLLAPSE_KEYS[mode])
      return raw == null ? defaults[mode] : raw === '1'
    }
    return { workflow: read('workflow'), chat: read('chat') }
  } catch {
    return { workflow: false, chat: true }
  }
}

function clampPaneWidth(width: number, rail = RAIL_WIDTH): number {
  const max = Math.min(PANE_MAX, Math.max(PANE_MIN, window.innerWidth - rail - CHAT_MIN))
  return Math.round(Math.min(max, Math.max(PANE_MIN, width)))
}

function readPaneWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(PANE_STORAGE_KEY)
    const value = raw ? Number(raw) : Number.NaN
    return Number.isFinite(value) && value > 0 ? clampPaneWidth(value) : null
  } catch {
    return null
  }
}

function positionGrip(element: HTMLElement, clientY: number): void {
  const rect = element.getBoundingClientRect()
  const y = Math.min(Math.max(24, clientY - rect.top), Math.max(24, rect.height - 24))
  element.style.setProperty('--grip-y', `${Math.round(y)}px`)
}

function titleFromProblem(problem: string): string {
  const { display } = splitContextContent(problem || '')
  const text = (display || problem || '').replace(/\s+/g, ' ').trim()
  if (!text) return '建模会话'
  return text.length > 30 ? `${text.slice(0, 30)}…` : text
}

let sequence = 0
function nextId(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now().toString(36)}-${sequence}`
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function initialAccent(): Accent {
  const fromUrl = new URLSearchParams(window.location.search).get('accent')
  if (fromUrl === 'a' || fromUrl === 'b' || fromUrl === 'c') return fromUrl
  const saved = localStorage.getItem('studio.accent')
  return saved === 'b' || saved === 'c' ? saved : 'a'
}

function userText(entry: ChatEntry): string {
  return entry.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('').trim()
}

function phaseMap(snapshot: SessionSnapshot): Record<number, PhaseState> {
  const out: Record<number, PhaseState> = {}
  for (const row of snapshot.phases) out[row.phase] = row.status
  return out
}

function entriesFromSnapshot(snapshot: SessionSnapshot): ChatEntry[] {
  return snapshot.messages.map((message, index) => {
    // 用户消息里存的是「手打文字 + 附件正文」；显示时只取文字，并还原附件胶囊。
    const parsed =
      message.role === 'user'
        ? splitContextContent(message.content)
        : { display: message.content, attachments: [] }
    return {
      id: `restored-${snapshot.id}-${index}`,
      role: message.role,
      reasoning: '',
      parts: parsed.display ? [{ kind: 'text' as const, text: parsed.display }] : [],
      streaming: false,
      interrupt: message.interrupt,
      attachments: parsed.attachments.length > 0 ? parsed.attachments : undefined,
      context: parsed.attachments.length > 0 ? message.content : undefined,
      doneReason:
        message.role === 'assistant' && message.interrupt && !message.interrupt.resolved
          ? 'waiting'
          : undefined
    }
  })
}

function currentPhaseOf(phases: Record<number, PhaseState>): number | undefined {
  for (const phase of PHASES) if (phases[phase.num] === 'waiting') return phase.num
  for (const phase of PHASES) if (phases[phase.num] === 'running') return phase.num
  let last: number | undefined
  for (const phase of PHASES) if (phases[phase.num] === 'passed') last = phase.num
  return last
}

export default function App() {
  const [meta, setMeta] = useState<StudioMeta | null>(null)
  const [accent, setAccent] = useState<Accent>(initialAccent)
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: 'starting' })
  const [providers, setProviders] = useState<ProviderList | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [streaming, setStreaming] = useState(false)
  // 卡片点击后的等待反馈；下一轮流结束或出错时清除
  const [resolving, setResolving] = useState(false)
  const [phases, setPhases] = useState<Record<number, PhaseState>>({})
  const [mode, setMode] = useState<'workflow' | 'chat'>('chat')
  const [explain, setExplain] = useState<ModelCandidate | null>(null)
  // 抽屉常挂载做滑入滑出过渡；关闭瞬间还要有内容可画，留最近一次候选
  const lastExplainRef = useRef<ModelCandidate | null>(null)
  if (explain) lastExplainRef.current = explain
  const [paneWidth, setPaneWidth] = useState<number | null>(readPaneWidth)
  const [resizingPane, setResizingPane] = useState(false)
  const [collapseByMode, setCollapseByMode] = useState<CollapseByMode>(readWorkspaceCollapse)
  const workspaceCollapsed = collapseByMode[mode]
  const [localChats, setLocalChats] = useState<ChatConversation[]>(loadChatConversations)
  // 本地会话列表的镜像：落盘需要最新列表但不适合进 effect 依赖。
  const localChatsRef = useRef<ChatConversation[]>([])
  localChatsRef.current = localChats
  const [remoteSessions, setRemoteSessions] = useState<SessionSummary[]>([])
  const [activeKind, setActiveKind] = useState<ConversationKind | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [trimNote, setTrimNote] = useState<string | null>(null)
  const shellRef = useRef<HTMLDivElement | null>(null)

  // 事件可能比 chat.start 的返回值先到，先按 chatId 暂存，拿到 id 后再按序补放。
  const activeChat = useRef<string | null>(null)
  const activeAssistant = useRef<string | null>(null)
  const buffered = useRef(new Map<string, ChatEvent[]>())
  const sessionId = useRef<string | null>(null)
  const entriesRef = useRef<ChatEntry[]>([])
  // 数模卡片的最近一次决策操作：错误重试时重放同一次 resume
  const lastResume = useRef<{ action: DecisionAction; choice?: string } | null>(null)

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  useEffect(() => {
    try {
      if (paneWidth == null) window.localStorage.removeItem(PANE_STORAGE_KEY)
      else window.localStorage.setItem(PANE_STORAGE_KEY, String(paneWidth))
    } catch {
      /* 本地存储不可用时只保留本次会话内的宽度 */
    }
  }, [paneWidth])

  useEffect(() => {
    try {
      // 只写当前模式的键；另一模式的偏好原样保留。
      window.localStorage.setItem(COLLAPSE_KEYS[mode], collapseByMode[mode] ? '1' : '0')
    } catch {
      /* 本地存储不可用时只保留本次会话内的状态 */
    }
  }, [collapseByMode, mode])

  const refreshSessions = async (): Promise<void> => {
    if (runtime.state !== 'ready') return
    try {
      const list = await window.studio.session.list()
      setRemoteSessions(list.sessions)
    } catch {
      // 列表刷新失败不打断正在进行的对话；下次结束时还会再试。
    }
  }

  useEffect(() => {
    if (runtime.state !== 'ready') return
    let alive = true
    window.studio.session
      .list()
      .then((list) => {
        if (alive) setRemoteSessions(list.sessions)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [runtime.state])

  // 问答会话存在渲染层的本地存储里；流结束后才落盘，避免每来一个 token 写一次。
  useEffect(() => {
    if (mode !== 'chat' || streaming || activeKind !== 'chat' || !activeId || entries.length === 0) {
      return
    }
    setLocalChats(
      saveChatConversation({ id: activeId, updatedAt: Date.now(), entries }, localChatsRef.current)
    )
  }, [entries, streaming, mode, activeKind, activeId])

  useEffect(() => {
    if (streaming || runtime.state !== 'ready' || mode !== 'workflow') return
    void refreshSessions()
    // 每次一轮结束刷新一次标题与待决策标记；refreshSessions 只读 runtime 状态。
  }, [streaming, runtime.state, mode])

  useEffect(() => {
    if (paneWidth == null) return
    let timer = 0
    const apply = (): void => {
      const rail =
        shellRef.current?.querySelector<HTMLElement>('.rail')?.getBoundingClientRect().width ??
        RAIL_WIDTH
      setPaneWidth((value) => (value == null ? value : clampPaneWidth(value, rail)))
    }
    // 窗口从 1440 拉到 2400 的过程中可能触发多次中间尺寸的 resize；
    // 立刻夹取会把用户宽度永久压到中间尺寸对应的最小值，所以等尺寸稳定再夹。
    const onResize = (): void => {
      window.clearTimeout(timer)
      timer = window.setTimeout(apply, 180)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('resize', onResize)
    }
  }, [paneWidth == null])

  useEffect(() => {
    document.documentElement.dataset.accent = accent
    localStorage.setItem('studio.accent', accent)
  }, [accent])

  useEffect(() => {
    window.studio
      .meta()
      .then(setMeta)
      .catch(() => setMeta(null))
  }, [])

  useEffect(() => {
    let alive = true
    window.studio.runtime
      .status()
      .then((status) => {
        if (alive) setRuntime(status)
      })
      .catch(() => undefined)
    const off = window.studio.runtime.onStatus((status) => setRuntime(status))
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => {
    if (runtime.state !== 'ready') return
    let alive = true
    window.studio.providers
      .list()
      .then((list) => {
        if (alive) setProviders(list)
      })
      .catch((err: unknown) => {
        if (alive) setNotice(errorText(err))
      })
    return () => {
      alive = false
    }
    // 只在 runtime 从别的状态切到 ready 时拉一次；保存设置后由返回值直接刷新。
  }, [runtime.state])

  // 关窗/重启 runtime 后，会话表里如果还有待决卡，就把它原样摆回来。
  useEffect(() => {
    if (runtime.state !== 'ready') return
    let alive = true
    window.studio.session
      .latest()
      .then(({ session }) => {
        if (!alive || activeChat.current) return
        if (!session) {
          const latestChat = localChats[0]
          if (latestChat && entriesRef.current.length === 0) {
            setEntries(latestChat.entries)
            changeMode('chat')
            setActiveKind('chat')
            setActiveId(latestChat.id)
          }
          return
        }
        const hasPending = Boolean(session.pending)
        if (!hasPending && entriesRef.current.length > 0) return
        sessionId.current = session.id
        setEntries(entriesFromSnapshot(session))
        setPhases(phaseMap(session))
        changeMode('workflow')
        setActiveKind('workflow')
        setActiveId(session.id)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [runtime.state])

  // 真实模型的 token 一帧可能来几十个；攒到同一帧只重渲一次，避免每个 token 都全树重排。
  const tokQueue = useRef<ChatEvent[]>([])
  const tokFrame = useRef(0)

  const drainTokens = (): void => {
    tokFrame.current = 0
    const queue = tokQueue.current
    if (queue.length === 0) return
    tokQueue.current = []
    const assistantId = activeAssistant.current
    if (!assistantId) return
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.id !== assistantId) return entry
        let next = entry
        for (const event of queue) next = applyChatEvent(next, event)
        return next
      })
    )
  }

  const flushTokens = (): void => {
    if (tokFrame.current) {
      cancelAnimationFrame(tokFrame.current)
      tokFrame.current = 0
    }
    drainTokens()
  }

  const dropTokens = (): void => {
    if (tokFrame.current) {
      cancelAnimationFrame(tokFrame.current)
      tokFrame.current = 0
    }
    tokQueue.current = []
  }

  const consume = (event: ChatEvent): boolean => {
    if (event.chatId !== activeChat.current) return false
    if (event.event === 'token' || event.event === 'reasoning') {
      if (!activeAssistant.current) return false
      tokQueue.current.push(event)
      if (!tokFrame.current) tokFrame.current = requestAnimationFrame(drainTokens)
      return true
    }
    // 非增量事件（阶段、卡片、结束、错误）必须先落地已收到的文字，界面顺序才不会倒置。
    flushTokens()
    if (event.event === 'phase') {
      const phase = event.data.phase
      const status = event.data.status
      if (typeof phase === 'number' && typeof status === 'string') {
        setPhases((prev) => ({ ...prev, [phase]: status as PhaseState }))
      }
      return true
    }
    if (event.event === 'compaction') {
      const data = event.data
      const before = typeof data.before === 'number' ? data.before : 0
      const after = typeof data.after === 'number' ? data.after : 0
      const summarized = typeof data.summarized === 'number' ? data.summarized : 0
      const pruned = typeof data.pruned === 'number' ? data.pruned : 0
      const dropped = typeof data.dropped === 'number' ? data.dropped : 0
      const reason = typeof data.reason === 'string' ? data.reason : ''
      const head =
        reason === 'overflow' ? '上下文超出模型窗口，已压缩后重试' : '上下文接近预算，已压缩较早对话'
      const parts = [
        summarized > 0 ? `合并 ${summarized} 条消息` : '',
        pruned > 0 ? `裁剪 ${pruned} 处工具结果` : '',
        dropped > 0 ? `丢弃 ${dropped} 条最早消息` : ''
      ].filter(Boolean)
      const detail = parts.length > 0 ? `：${parts.join('、')}` : ''
      const divider: ChatEntry = {
        id: nextId('n'),
        role: 'assistant',
        reasoning: '',
        parts: [],
        streaming: false,
        notice: `${head}${detail}（约 ${before} → ${after} tokens）`
      }
      setEntries((prev) => {
        const next = prev.slice()
        const index = next.findIndex((entry) => entry.id === activeAssistant.current)
        next.splice(index < 0 ? next.length : index, 0, divider)
        return next
      })
      return true
    }
    if (event.event === 'artifact') {
      // 阶段四把图登记进图表版本后，右侧工作台要重新拉一次状态。
      window.dispatchEvent(new Event('mms:workbench-changed'))
      return true
    }
    const assistantId = activeAssistant.current
    if (!assistantId) return false
    setEntries((prev) =>
      prev.map((entry) => (entry.id === assistantId ? applyChatEvent(entry, event) : entry))
    )
    if (event.event === 'done') {
      activeChat.current = null
      activeAssistant.current = null
      setStreaming(false)
      setResolving(false)
    }
    if (event.event === 'error') setResolving(false)
    return true
  }

  useEffect(() => {
    const off = window.studio.chat.onEvent((event) => {
      if (!activeChat.current) {
        const queue = buffered.current.get(event.chatId) ?? []
        if (queue.length < 500) queue.push(event)
        buffered.current.set(event.chatId, queue)
        return
      }
      consume(event)
    })
    return () => {
      off()
      dropTokens()
    }
    // consume 只读 refs 与 setState，行为稳定；此处只订阅一次。
    // eslint 在本仓库未启用，避免把 refs 写进依赖导致反复退订。
  }, [])

  const provider =
    providers?.providers.find((p) => p.id === providers.activeProvider) ?? undefined
  const canSend =
    runtime.state === 'ready' &&
    Boolean(provider) &&
    (!provider?.requiresKey || Boolean(provider?.configured))

  const conversations = useMemo<ConversationItem[]>(() => {
    const rows: ConversationItem[] = [
      ...remoteSessions.map((session) => ({
        id: session.id,
        kind: 'workflow' as const,
        title: titleFromProblem(session.problem),
        updatedAt: session.updatedAt * 1000,
        pending: session.pending
      })),
      ...localChats.map((chat) => ({
        id: chat.id,
        kind: 'chat' as const,
        title: chat.title,
        updatedAt: chat.updatedAt
      }))
    ]
    return rows.sort((a, b) => b.updatedAt - a.updatedAt)
  }, [remoteSessions, localChats])

  const activeConversation = conversations.find(
    (item) => item.id === activeId && item.kind === activeKind
  )
  const activeTitle = activeConversation?.title ?? (entries.length > 0 ? titleOf(entries) : '新对话')
  const usedTokens = conversationTokens(entries)
  const selectedContextLabel = contextLabel(provider?.contextLimit ?? 200_000)
  const selectedDepthLabel = depthLabel(provider?.thinkingDepth ?? 'high')

  // 切模式恢复各自已记住的右栏形态（collapseByMode 初始默认即问答收起、建模展开）；
  // 模式内手动 toggle 只写当前模式的键。
  const changeMode = (next: 'workflow' | 'chat'): void => {
    setMode(next)
  }

  // 列宽过渡只在模式切换的瞬间存在：手动收合（toggleWorkspace）与拖拽都不设它，保持即时。
  const [modeAnimating, setModeAnimating] = useState(false)
  const firstModeRun = useRef(true)
  useEffect(() => {
    if (firstModeRun.current) {
      firstModeRun.current = false
      return
    }
    setModeAnimating(true)
    let settled = false
    let timer = 0
    const finish = (): void => {
      if (settled) return
      settled = true
      setModeAnimating(false)
      window.clearTimeout(timer)
    }
    const el = shellRef.current
    // transitionend 可能被中断丢失，480ms 兜底与 --t-layout:400ms 对齐。
    timer = window.setTimeout(finish, 480)
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === el && event.propertyName === 'grid-template-columns') finish()
    }
    el?.addEventListener('transitionend', onEnd)
    return () => {
      window.clearTimeout(timer)
      el?.removeEventListener('transitionend', onEnd)
    }
  }, [mode])

  const newConversation = (): void => {
    if (streaming) {
      setNotice('正在生成，先停止再新建会话')
      return
    }
    sessionId.current = null
    activeChat.current = null
    activeAssistant.current = null
    dropTokens()
    setEntries([])
    setPhases({})
    changeMode('chat')
    setActiveKind(null)
    setActiveId(null)
    setTrimNote(null)
    setNotice(null)
  }

  const selectConversation = async (item: ConversationItem): Promise<void> => {
    if (streaming) {
      setNotice('正在生成，先停止再切换会话')
      return
    }
    setNotice(null)
    setTrimNote(null)
    dropTokens()
    if (item.kind === 'workflow') {
      try {
        const { session } = await window.studio.session.get(item.id)
        if (!session) {
          setNotice('这个建模会话已经不存在')
          void refreshSessions()
          return
        }
        sessionId.current = session.id
        activeChat.current = null
        activeAssistant.current = null
        setEntries(entriesFromSnapshot(session))
        setPhases(phaseMap(session))
        changeMode('workflow')
        setActiveKind('workflow')
        setActiveId(session.id)
      } catch (err) {
        setNotice(errorText(err))
      }
      return
    }
    const chat = localChats.find((row) => row.id === item.id)
    if (!chat) {
      setNotice('这个问答会话已经不存在')
      setLocalChats(loadChatConversations())
      return
    }
    sessionId.current = null
    activeChat.current = null
    activeAssistant.current = null
    setEntries(chat.entries)
    setPhases({})
    changeMode('chat')
    setActiveKind('chat')
    setActiveId(chat.id)
  }

  const deleteConversation = async (item: ConversationItem): Promise<void> => {
    if (streaming) return
    try {
      if (item.kind === 'workflow') {
        await window.studio.session.remove(item.id)
        await refreshSessions()
      } else {
        setLocalChats(removeChatConversation(item.id))
      }
      if (activeKind === item.kind && activeId === item.id) newConversation()
    } catch (err) {
      setNotice(errorText(err))
    }
  }

  const clearHistory = async (): Promise<void> => {
    if (streaming) {
      setNotice('正在生成，先停止再清空历史')
      return
    }
    try {
      await window.studio.session.clear()
      clearChatConversations()
      setLocalChats([])
      setRemoteSessions([])
      newConversation()
    } catch (err) {
      setNotice(errorText(err))
    }
  }

  const send = async (text: string, extras?: SendExtras, replaceFrom?: number): Promise<void> => {
    if (!provider || !canSend || streaming) return
    const content = extras?.context ?? text
    if (!content.trim()) return

    const baseEntries = mode === 'workflow' ? [] : entries.slice(0, replaceFrom ?? entries.length)
    const allHistory: ChatMessageInput[] = []
    for (const entry of baseEntries) {
      if (entry.role === 'user') {
        // 附件正文不进界面，但重放历史时要留给模型，所以优先进模型的全文。
        const value = entry.context ?? userText(entry)
        if (value) allHistory.push({ role: 'user', content: value })
      } else {
        const value = assistantText(entry)
        if (value) allHistory.push({ role: 'assistant', content: value })
      }
    }
    const fitted = fitHistory(allHistory, content, provider.contextLimit)
    const history = fitted.messages
    setTrimNote(
      fitted.dropped > 0
        ? `已按 ${contextLabel(provider.contextLimit)} 上下文省略最早 ${fitted.dropped} 条消息（本地估算）。`
        : null
    )

    const assistantId = nextId('a')
    const user: ChatEntry = {
      id: nextId('u'),
      role: 'user',
      reasoning: '',
      parts: text ? [{ kind: 'text', text }] : [],
      streaming: false,
      attachments: extras?.attachments,
      context: extras?.context
    }
    const assistant: ChatEntry = {
      id: assistantId,
      role: 'assistant',
      reasoning: '',
      parts: [],
      streaming: true
    }
    const nextEntries = [...baseEntries, user, assistant]
    const chatConvId =
      mode === 'chat' ? (activeKind === 'chat' && activeId ? activeId : nextId('c')) : null

    setEntries(nextEntries)
    setNotice(null)
    setStreaming(true)
    activeChat.current = null
    activeAssistant.current = assistantId
    if (mode === 'workflow') {
      setPhases({})
      sessionId.current = null
      setActiveKind(null)
      setActiveId(null)
    } else if (chatConvId) {
      setActiveKind('chat')
      setActiveId(chatConvId)
      // 先把用户问题落盘：流到一半关窗时，至少还能在列表里找回这一问。
      // 写盘挪到下一拍，先让内存里的列表用这一问渲染出来，避免发送瞬间卡在同步 IO。
      window.setTimeout(() => {
        setLocalChats(
          saveChatConversation(
            { id: chatConvId, updatedAt: Date.now(), entries: nextEntries },
            localChatsRef.current
          )
        )
      }, 0)
    }

    const input: ChatStartInput = {
      providerId: provider.id,
      model: provider.model,
      mode,
      messages: [...history, { role: 'user', content }],
      thinking: provider.thinkingDepth,
      contextTokens: provider.contextLimit,
      sendThinking: provider.sendThinking,
      attachmentPaths: extras?.attachmentPaths
    }

    try {
      const result = await window.studio.chat.start(input)
      activeChat.current = result.chatId
      if (mode === 'workflow') {
        sessionId.current = result.chatId
        setActiveKind('workflow')
        setActiveId(result.chatId)
        void refreshSessions()
      }
      const queued = buffered.current.get(result.chatId) ?? []
      buffered.current.clear()
      for (const event of queued) {
        if (!consume(event)) break
      }
    } catch (err) {
      buffered.current.clear()
      dropTokens()
      activeAssistant.current = null
      setStreaming(false)
      setEntries((prev) =>
        prev.map((entry) =>
          entry.id === assistantId ? { ...entry, streaming: false, error: errorText(err) } : entry
        )
      )
    }
  }

  // 自由对话里的卡片不重开 orchestrator：选一张卡就等于发一条消息，由模型接着聊。
  const decideInChat = async (action: DecisionAction, choice?: string): Promise<void> => {
    if (streaming) return
    const pendingEntry = [...entries]
      .reverse()
      .find((entry) => entry.interrupt && !entry.interrupt.resolved)
    const picked = choice
      ? candidatesOf(pendingEntry?.interrupt?.payload ?? {}).find((c) => c.id === choice)
      : undefined
    const label =
      action === 'choose'
        ? `已选：${picked?.name ?? choice ?? ''}`
        : action === 'reroll'
          ? '已换一批'
          : '已确认'
    setEntries((prev) =>
      prev.map((entry) =>
        entry.interrupt && !entry.interrupt.resolved
          ? { ...entry, interrupt: { ...entry.interrupt, resolved: label } }
          : entry
      )
    )
    const text =
      action === 'choose'
        ? `我选「${picked?.name ?? choice ?? ''}」。请按这个模型继续。`
        : action === 'reroll'
          ? '换一批候选模型（batch 加 1）。'
          : '确认。'
    setResolving(true)
    await send(text)
  }

  const resume = async (action: DecisionAction, choice?: string): Promise<void> => {
    const sid = sessionId.current
    if (!sid || streaming) return
    // 数模错误重试要重放的卡操作；retry 失败回滚时不动它。
    lastResume.current = { action, choice }
    const pendingEntry = [...entries]
      .reverse()
      .find((entry) => entry.interrupt && !entry.interrupt.resolved)
    const pendingId = pendingEntry?.id
    const picked = choice
      ? candidatesOf(pendingEntry?.interrupt?.payload ?? {}).find((c) => c.id === choice)
      : undefined
    const label =
      action === 'confirm'
        ? '已确认'
        : action === 'reroll'
          ? '已换一批'
          : `已选：${picked?.name ?? choice ?? ''}`
    setEntries((prev) =>
      prev.map((entry) =>
        entry.interrupt && !entry.interrupt.resolved
          ? { ...entry, interrupt: { ...entry.interrupt, resolved: label } }
          : entry
      )
    )
    const assistantId = nextId('a')
    setEntries((prev) => [
      ...prev,
      { id: assistantId, role: 'assistant', reasoning: '', parts: [], streaming: true }
    ])
    setStreaming(true)
    setResolving(true)
    setNotice(null)
    setTrimNote(null)
    setActiveKind('workflow')
    setActiveId(sid)
    activeChat.current = sid
    activeAssistant.current = assistantId
    try {
      const result = await window.studio.chat.resume({ sessionId: sid, action, choice })
      activeChat.current = result.chatId
      const queued = buffered.current.get(result.chatId) ?? []
      buffered.current.clear()
      for (const event of queued) {
        if (!consume(event)) break
      }
    } catch (err) {
      buffered.current.clear()
      dropTokens()
      activeChat.current = null
      activeAssistant.current = null
      setStreaming(false)
      setResolving(false)
      setEntries((prev) =>
        prev.map((entry) => {
          if (entry.id === assistantId) {
            return { ...entry, streaming: false, error: errorText(err) }
          }
          if (entry.id === pendingId && entry.interrupt) {
            const copy = { ...entry.interrupt }
            delete copy.resolved
            return { ...entry, interrupt: copy }
          }
          return entry
        })
      )
    }
  }

  // 从某一条 assistant 消息重发：定位它前面最近的 user，把该问之后的内容截断重发。
  // 仅正常模式；数模的错误走 retry 的 resume 重放。
  const retryFromEntry = (entryId: string): void => {
    if (streaming) return
    const index = entries.findIndex((entry) => entry.id === entryId)
    if (index < 0) return
    let userIdx = -1
    for (let scan = index - 1; scan >= 0; scan--) {
      if (entries[scan].role === 'user') {
        userIdx = scan
        break
      }
    }
    if (userIdx < 0) return
    const user = entries[userIdx]
    void send(userText(user), { attachments: user.attachments, context: user.context }, userIdx)
  }

  // 消息里的「重试」按钮：数模在会话里时重放最近一次卡决策；正常模式重发最后一问。
  const retry = (): void => {
    if (streaming) return
    if (mode === 'workflow') {
      if (sessionId.current && lastResume.current) {
        void resume(lastResume.current.action, lastResume.current.choice)
      }
      return
    }
    const lastUser = [...entries].reverse().find((entry) => entry.role === 'user')
    if (!lastUser) return
    const index = entries.findIndex((entry) => entry.id === lastUser.id)
    void send(
      userText(lastUser),
      { attachments: lastUser.attachments, context: lastUser.context },
      index
    )
  }

  const stop = (): void => {
    const chatId = activeChat.current
    if (!chatId) return
    const assistantId = activeAssistant.current
    void window.studio.chat
      .cancel(chatId)
      .catch((err: unknown) => setNotice(errorText(err)))
    // 主进程会在 2 秒后断掉本地流；这里再兜一层，避免界面永远停在「生成中」。
    window.setTimeout(() => {
      if (activeChat.current !== chatId || !assistantId) return
      dropTokens()
      activeChat.current = null
      activeAssistant.current = null
      setStreaming(false)
      setResolving(false)
      setEntries((prev) =>
        prev.map((entry) =>
          entry.id === assistantId && entry.streaming
            ? { ...entry, streaming: false, doneReason: 'cancelled' }
            : entry
        )
      )
    }, 2500)
  }

  const restart = async (): Promise<void> => {
    setNotice(null)
    try {
      setProviders(await window.studio.runtime.restart())
    } catch (err) {
      setNotice(errorText(err))
    }
  }

  const statusText =
    runtime.state === 'ready'
      ? `运行时已连接${runtime.fake ? ' · 离线演示' : ''}`
      : runtime.state === 'starting'
        ? '运行时启动中'
        : '运行时未连接'

  const pendingCard = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if (entry.interrupt && !entry.interrupt.resolved) return entry.interrupt
    }
    return null
  }, [entries])
  const pending = Boolean(pendingCard)
  const currentPhase = currentPhaseOf(phases)
  const measuredPane = (): number =>
    shellRef.current?.querySelector<HTMLElement>('.workspace')?.getBoundingClientRect().width ??
    paneWidth ??
    520
  const measuredRail = (): number =>
    shellRef.current?.querySelector<HTMLElement>('.rail')?.getBoundingClientRect().width ?? RAIL_WIDTH

  const startPaneResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX
    const startWidth = measuredPane()
    const rail = measuredRail()
    let last = startWidth
    setResizingPane(true)
    document.body.style.userSelect = 'none'
    const move = (moveEvent: PointerEvent): void => {
      positionGrip(handle, moveEvent.clientY)
      // 拖动期间只写 DOM 变量：流式重渲不会回写这个值，拖动不被每帧 setEntries 卡住。
      last = clampPaneWidth(startWidth - (moveEvent.clientX - startX), rail)
      shellRef.current?.style.setProperty('--pane-w', `${last}px`)
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.style.userSelect = ''
      setPaneWidth(last)
      setResizingPane(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const nudgePane = (delta: number): void =>
    setPaneWidth(clampPaneWidth(measuredPane() + delta, measuredRail()))

  const onPaneKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      nudgePane(16)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      nudgePane(-16)
    }
  }

  // 离开时不清 --grip-y：指针常在分隔条外松手，清掉会让高亮在淡出过程中闪回中间。
  const onGripMove = (event: ReactPointerEvent<HTMLDivElement>): void =>
    positionGrip(event.currentTarget, event.clientY)

  const toggleWorkspace = (): void =>
    setCollapseByMode((prev) => ({ ...prev, [mode]: !prev[mode] }))

  return (
    <div
      className="shell"
      ref={shellRef}
      data-resizing={resizingPane ? 'col' : undefined}
      data-pane={workspaceCollapsed ? 'collapsed' : 'expanded'}
      data-mode={mode}
      data-mode-animating={modeAnimating ? 'true' : undefined}
      style={paneWidth == null ? undefined : ({ '--pane-w': `${paneWidth}px` } as CSSProperties)}
    >
      <PhaseRail
        mode={mode}
        states={phases}
        current={currentPhase}
        conversations={conversations}
        activeId={activeId}
        busy={streaming}
        onNew={newConversation}
        onSelect={(item) => void selectConversation(item)}
        onDelete={(item) => void deleteConversation(item)}
        onClearAll={() => void clearHistory()}
      />
      <ChatPane
        runtime={runtime}
        provider={provider}
        entries={entries}
        streaming={streaming}
        canSend={canSend}
        notice={notice}
        phases={phases}
        currentPhase={currentPhase}
        mode={mode}
        pending={pending}
        conversationTitle={activeTitle}
        contextLabel={selectedContextLabel}
        depthLabel={selectedDepthLabel}
        usedTokens={usedTokens}
        trimNote={trimNote}
        resolving={resolving}
        onModeChange={changeMode}
        onSend={(text, extras) => void send(text, extras)}
        onRetry={retry}
        onRegenerate={retryFromEntry}
        onStop={stop}
        onDecision={(action, choice) =>
          mode === 'workflow' ? void resume(action, choice) : void decideInChat(action, choice)
        }
        onExplain={setExplain}
        onOpenSettings={() => setSettingsOpen(true)}
        onRestart={() => void restart()}
        onClearCurrent={newConversation}
      />
      <WorkspacePane
        runtimeReady={runtime.state === 'ready'}
        collapsed={workspaceCollapsed}
        onToggle={toggleWorkspace}
        projectId={activeKind === 'workflow' ? activeId : null}
        sessionId={activeKind === 'workflow' ? activeId : null}
      />
      <div
        className="splitter splitter--col"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整工作台宽度"
        aria-valuenow={Math.round(measuredPane())}
        tabIndex={0}
        data-splitter="pane"
        data-dragging={resizingPane ? 'true' : undefined}
        onPointerDown={startPaneResize}
        onPointerMove={onGripMove}
        onPointerEnter={onGripMove}
        onDoubleClick={() => setPaneWidth(null)}
        onKeyDown={onPaneKey}
      />
      {lastExplainRef.current ? (
        <ExplainDrawer
          candidate={lastExplainRef.current}
          open={explain != null}
          onClose={() => setExplain(null)}
        />
      ) : null}
      <footer className="statusbar">
        <span>{meta ? `v${meta.version}` : '主进程未响应'}</span>
        <span className={`status-dot status-dot--${runtime.state}`} aria-hidden="true" />
        <span>{statusText}</span>
        {runtime.state === 'error' ? (
          <button type="button" className="statusbar__action" onClick={() => void restart()}>
            重试
          </button>
        ) : null}
        {provider ? <span>{provider.display}</span> : null}
        <span className="statusbar__spacer">强调色</span>
        <span className="swatches">
          {(Object.keys(ACCENTS) as Accent[]).map((key) => (
            <button
              key={key}
              className={`swatch swatch--${key}`}
              aria-pressed={accent === key}
              aria-label={ACCENTS[key]}
              title={ACCENTS[key]}
              onClick={() => setAccent(key)}
            />
          ))}
        </span>
        <span>{ACCENTS[accent]}</span>
        <span>{meta?.Electron ? `Electron ${meta.Electron}` : ''}</span>
      </footer>

      {settingsOpen && providers ? (
        <SettingsDialog
          list={providers}
          onClose={() => setSettingsOpen(false)}
          onChanged={setProviders}
        />
      ) : null}
    </div>
  )
}
