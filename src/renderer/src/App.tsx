import { useEffect, useRef, useState } from 'react'
import type {
  ChatEvent,
  ChatMessageInput,
  ChatStartInput,
  DecisionAction,
  ProviderList,
  RuntimeStatus,
  SessionSnapshot
} from '../../shared/api'
import ChatPane from './components/ChatPane'
import { candidatesOf, type ModelCandidate } from './components/DecisionCard'
import ExplainDrawer from './components/ExplainDrawer'
import PhaseRail from './components/PhaseRail'
import SettingsDialog from './components/SettingsDialog'
import WorkspacePane from './components/WorkspacePane'
import { applyChatEvent, assistantText, type ChatEntry } from './lib/chat'
import { PHASES, type PhaseState } from './lib/phases'

// 类型由 src/preload/index.d.ts 声明的全局 window.studio 反推，
// 避免把依赖 electron 的 preload 源文件拉进渲染层类型图。
type StudioMeta = Awaited<ReturnType<typeof window.studio.meta>>

type Accent = 'a' | 'b' | 'c'
const ACCENTS: Record<Accent, string> = { a: '墨青', b: '靛蓝', c: '朱砂' }

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
  return snapshot.messages.map((message, index) => ({
    id: `restored-${snapshot.id}-${index}`,
    role: message.role,
    reasoning: '',
    parts: message.content ? [{ kind: 'text', text: message.content }] : [],
    streaming: false,
    interrupt: message.interrupt,
    doneReason:
      message.role === 'assistant' && message.interrupt && !message.interrupt.resolved
        ? 'waiting'
        : undefined
  }))
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
  const [phases, setPhases] = useState<Record<number, PhaseState>>({})
  const [mode, setMode] = useState<'workflow' | 'chat'>('workflow')
  const [explain, setExplain] = useState<ModelCandidate | null>(null)

  // 事件可能比 chat.start 的返回值先到，先按 chatId 暂存，拿到 id 后再按序补放。
  const activeChat = useRef<string | null>(null)
  const activeAssistant = useRef<string | null>(null)
  const buffered = useRef(new Map<string, ChatEvent[]>())
  const sessionId = useRef<string | null>(null)
  const entriesRef = useRef<ChatEntry[]>([])

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

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
        if (!alive || !session || activeChat.current) return
        const hasPending = Boolean(session.pending)
        if (!hasPending && entriesRef.current.length > 0) return
        sessionId.current = session.id
        setEntries(entriesFromSnapshot(session))
        setPhases(phaseMap(session))
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [runtime.state])

  const consume = (event: ChatEvent): boolean => {
    if (event.chatId !== activeChat.current) return false
    if (event.event === 'phase') {
      const phase = event.data.phase
      const status = event.data.status
      if (typeof phase === 'number' && typeof status === 'string') {
        setPhases((prev) => ({ ...prev, [phase]: status as PhaseState }))
      }
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
    }
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
    return off
    // consume 只读 refs 与 setState，行为稳定；此处只订阅一次。
    // eslint 在本仓库未启用，避免把 refs 写进依赖导致反复退订。
  }, [])

  const provider =
    providers?.providers.find((p) => p.id === providers.activeProvider) ?? undefined
  const canSend =
    runtime.state === 'ready' &&
    Boolean(provider) &&
    (!provider?.requiresKey || Boolean(provider?.configured))

  const send = async (text: string): Promise<void> => {
    if (!provider || !canSend || streaming) return

    const baseEntries = mode === 'workflow' ? [] : entries
    const history: ChatMessageInput[] = []
    for (const entry of baseEntries) {
      if (entry.role === 'user') {
        const content = userText(entry)
        if (content) history.push({ role: 'user', content })
      } else {
        const content = assistantText(entry)
        if (content) history.push({ role: 'assistant', content })
      }
    }

    const assistantId = nextId('a')
    const user: ChatEntry = {
      id: nextId('u'),
      role: 'user',
      reasoning: '',
      parts: [{ kind: 'text', text }],
      streaming: false
    }
    const assistant: ChatEntry = {
      id: assistantId,
      role: 'assistant',
      reasoning: '',
      parts: [],
      streaming: true
    }

    setEntries([...baseEntries, user, assistant])
    setNotice(null)
    setStreaming(true)
    activeChat.current = null
    activeAssistant.current = assistantId
    if (mode === 'workflow') {
      setPhases({})
      sessionId.current = null
    }

    const input: ChatStartInput = {
      providerId: provider.id,
      model: provider.model,
      mode,
      messages: [...history, { role: 'user', content: text }]
    }

    try {
      const result = await window.studio.chat.start(input)
      activeChat.current = result.chatId
      if (mode === 'workflow') sessionId.current = result.chatId
      const queued = buffered.current.get(result.chatId) ?? []
      buffered.current.clear()
      for (const event of queued) {
        if (!consume(event)) break
      }
    } catch (err) {
      buffered.current.clear()
      activeAssistant.current = null
      setStreaming(false)
      setEntries((prev) =>
        prev.map((entry) =>
          entry.id === assistantId ? { ...entry, streaming: false, error: errorText(err) } : entry
        )
      )
    }
  }

  const resume = async (action: DecisionAction, choice?: string): Promise<void> => {
    const sid = sessionId.current
    if (!sid || streaming) return
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
    setNotice(null)
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
      activeChat.current = null
      activeAssistant.current = null
      setStreaming(false)
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
      activeChat.current = null
      activeAssistant.current = null
      setStreaming(false)
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
      ? `runtime 已连接${runtime.fake ? ' · 离线演示' : ''}`
      : runtime.state === 'starting'
        ? 'runtime 启动中'
        : 'runtime 未连接'

  const pendingCard = [...entries]
    .reverse()
    .find((entry) => entry.interrupt && !entry.interrupt.resolved)?.interrupt
  const pending = Boolean(pendingCard)
  const currentPhase = currentPhaseOf(phases)

  return (
    <div className="shell">
      <PhaseRail states={phases} current={currentPhase} />
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
        onModeChange={setMode}
        onSend={(text) => void send(text)}
        onStop={stop}
        onDecision={(action, choice) => void resume(action, choice)}
        onExplain={setExplain}
        onOpenSettings={() => setSettingsOpen(true)}
        onRestart={() => void restart()}
      />
      <WorkspacePane />
      {explain ? <ExplainDrawer candidate={explain} onClose={() => setExplain(null)} /> : null}
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
