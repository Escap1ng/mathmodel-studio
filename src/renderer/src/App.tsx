import { useEffect, useRef, useState } from 'react'
import type {
  ChatEvent,
  ChatMessageInput,
  ChatStartInput,
  ProviderList,
  RuntimeStatus
} from '../../shared/api'
import ChatPane from './components/ChatPane'
import PhaseRail from './components/PhaseRail'
import SettingsDialog from './components/SettingsDialog'
import WorkspacePane from './components/WorkspacePane'
import { applyChatEvent, assistantText, type ChatEntry } from './lib/chat'

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

export default function App() {
  const [meta, setMeta] = useState<StudioMeta | null>(null)
  const [accent, setAccent] = useState<Accent>(initialAccent)
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: 'starting' })
  const [providers, setProviders] = useState<ProviderList | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [streaming, setStreaming] = useState(false)

  // 事件可能比 chat.start 的返回值先到，先按 chatId 暂存，拿到 id 后再按序补放。
  const activeChat = useRef<string | null>(null)
  const activeAssistant = useRef<string | null>(null)
  const buffered = useRef(new Map<string, ChatEvent[]>())

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

  const consume = (event: ChatEvent): boolean => {
    if (event.chatId !== activeChat.current) return false
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

    const history: ChatMessageInput[] = []
    for (const entry of entries) {
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

    setEntries((prev) => [...prev, user, assistant])
    setNotice(null)
    setStreaming(true)
    activeChat.current = null
    activeAssistant.current = assistantId

    const input: ChatStartInput = {
      providerId: provider.id,
      model: provider.model,
      messages: [...history, { role: 'user', content: text }]
    }

    try {
      const result = await window.studio.chat.start(input)
      activeChat.current = result.chatId
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

  return (
    <div className="shell">
      <PhaseRail states={{}} />
      <ChatPane
        runtime={runtime}
        provider={provider}
        entries={entries}
        streaming={streaming}
        canSend={canSend}
        notice={notice}
        onSend={(text) => void send(text)}
        onStop={stop}
        onOpenSettings={() => setSettingsOpen(true)}
        onRestart={() => void restart()}
      />
      <WorkspacePane />
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
