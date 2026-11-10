import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ClipboardEvent as ReactClipboardEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import type { DecisionAction, ProviderView, RuntimeStatus, StagedFile } from '../../../../shared/api'
import { buildContextText, WORKSPACE_DRAG, type SendExtras } from '../../lib/attachments'
import { isRecord, type ChatEntry, type ToolCard } from '../../lib/chat'
import { formatTokens } from '../../lib/context'
import { errorText } from '../../lib/format'
import { PHASES, STATE_TEXT, type PhaseState } from '../../lib/phases'
import DecisionCard, { type ModelCandidate } from './DecisionCard'
import MessageActions from './MessageActions'
import WelcomeScreen from './WelcomeScreen'
import FileChips from '../common/FileChips'
import MarkdownView from './MarkdownView'

const COMPOSER_MIN = 132
const COMPOSER_STORAGE_KEY = 'mms.composerHeight'

function clampComposerHeight(height: number, chat: HTMLElement | null): number {
  const max = Math.max(
    COMPOSER_MIN + 40,
    Math.round((chat?.getBoundingClientRect().height ?? 640) * 0.72)
  )
  return Math.round(Math.min(max, Math.max(COMPOSER_MIN, height)))
}

function readComposerHeight(): number | null {
  try {
    const raw = window.localStorage.getItem(COMPOSER_STORAGE_KEY)
    const value = raw ? Number(raw) : Number.NaN
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

function hasWorkspaceDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(WORKSPACE_DRAG)
}

function acceptsDrop(event: DragEvent<HTMLElement>): boolean {
  return hasFiles(event) || hasWorkspaceDrag(event)
}

interface Props {
  runtime: RuntimeStatus
  provider?: ProviderView
  entries: ChatEntry[]
  streaming: boolean
  canSend: boolean
  notice: string | null
  phases: Record<number, PhaseState>
  currentPhase?: number
  mode: 'workflow' | 'chat'
  pending: boolean
  conversationTitle: string
  contextLabel: string
  depthLabel: string
  usedTokens: number
  trimNote: string | null
  resolving: boolean
  onModeChange: (mode: 'workflow' | 'chat') => void
  onSend: (text: string, extras?: SendExtras) => void
  onRetry: () => void
  onRegenerate: (entryId: string) => void
  onStop: () => void
  onDecision: (action: DecisionAction, choice?: string) => void
  onExplain: (candidate: ModelCandidate) => void
  onOpenSettings: () => void
  onRestart: () => void
  onClearCurrent: () => void
}

const TOOL_LABELS: Record<string, string> = {
  list_templates: '模板清单'
}

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '{}'
  if (typeof args === 'string') return args
  try {
    return JSON.stringify(args)
  } catch {
    return String(args)
  }
}

function describeTool(tool: ToolCard): string | null {
  if (tool.status === 'running' || tool.status === 'error') return null
  const result = tool.result
  if (isRecord(result)) {
    if (result.ok === false && typeof result.error === 'string') return result.error
    if (typeof result.total === 'number' && isRecord(result.by_skill)) {
      return `载入 ${result.total} 个模板，覆盖 ${Object.keys(result.by_skill).length} 个技能`
    }
  }
  return '完成'
}

function ToolCardView({ tool }: { tool: ToolCard }) {
  const summary = describeTool(tool)
  const state = tool.status === 'running' ? '调用中' : tool.status === 'ok' ? '完成' : '失败'
  return (
    <div className="tool-card" data-status={tool.status} data-tool={tool.name}>
      <div className="tool-card__head">
        <span className="tool-card__dot" aria-hidden="true" />
        <span className="tool-card__name">{TOOL_LABELS[tool.name] ?? tool.name}</span>
        <code className="tool-card__id">{tool.name}</code>
        <span className="tool-card__meta">
          {state}
          {typeof tool.durationMs === 'number' ? ` · ${tool.durationMs}ms` : ''}
        </span>
      </div>
      <div className="tool-card__body">
        <div className="tool-card__line">
          <span className="tool-card__key">参数</span>
          <code>{formatArgs(tool.args)}</code>
        </div>
        {summary ? (
          <div className="tool-card__line">
            <span className="tool-card__key">结果</span>
            <span>{summary}</span>
          </div>
        ) : null}
        {tool.status === 'error' && tool.error ? (
          <div className="tool-card__line tool-card__line--error">{tool.error}</div>
        ) : null}
      </div>
    </div>
  )
}

function EntryViewBase({
  entry,
  onDecision,
  onExplain,
  onRetry,
  onRegenerate,
  resolving
}: {
  entry: ChatEntry
  onDecision: (action: DecisionAction, choice?: string) => void
  onExplain: (candidate: ModelCandidate) => void
  onRetry?: () => void
  onRegenerate?: (entryId: string) => void
  resolving?: boolean
}) {
  if (entry.role === 'user') {
    const text = entry.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    return (
      <article className="msg msg--user">
        {text ? <div className="msg__text">{text}</div> : null}
        {entry.attachments?.length ? (
          <div className="msg__files">
            <FileChips items={entry.attachments} label="随消息发送的附件" />
          </div>
        ) : null}
      </article>
    )
  }

  const hasBody = entry.parts.length > 0 || entry.reasoning.length > 0
  const last = entry.parts[entry.parts.length - 1]

  return (
    <article className="msg msg--assistant">
      <div className="msg__role">助手</div>
      {entry.reasoning ? (
        <details className="think">
          <summary>思考过程</summary>
          <div className="think__text">{entry.reasoning}</div>
        </details>
      ) : null}
      {!hasBody && entry.streaming ? <div className="msg__pending">正在生成…</div> : null}
      {entry.parts.map((part, index) =>
        part.kind === 'text' ? (
          <MarkdownView
            key={`t-${index}`}
            text={part.text}
            streaming={entry.streaming && index === entry.parts.length - 1}
          />
        ) : (
          <ToolCardView key={`k-${part.tool.id}-${index}`} tool={part.tool} />
        )
      )}
      {entry.streaming && entry.parts.length > 0 && last?.kind === 'tool' ? (
        <span className="cursor cursor--block" aria-hidden="true" />
      ) : null}
      {entry.interrupt ? (
        <DecisionCard
          card={entry.interrupt}
          busy={entry.streaming}
          resolving={resolving}
          onDecision={onDecision}
          onExplain={onExplain}
        />
      ) : null}
      {entry.error ? (
        <div className="msg__error">
          <span>{entry.error}</span>
          {onRetry ? (
            <button type="button" className="linkbtn msg__retry" onClick={onRetry}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {entry.doneReason === 'cancelled' ? <div className="msg__note">已停止</div> : null}
      {entry.doneReason === 'waiting' && !entry.interrupt?.resolved ? (
        <div className="msg__note">已暂停，等你做出选择。</div>
      ) : null}
      {entry.doneReason === 'max_tool_rounds' ? (
        <div className="msg__note">工具调用轮数已用尽，这一轮先停在这里。</div>
      ) : null}
      {!entry.streaming ? (
        <MessageActions entry={entry} onRegenerate={onRegenerate} />
      ) : null}
    </article>
  )
}

// 条目不可变且回调引用稳定（见下），memo 让流式期间只有活跃条目重渲。
const EntryView = memo(EntryViewBase)

export default function ChatPane({
  runtime,
  provider,
  entries,
  streaming,
  canSend,
  notice,
  phases,
  currentPhase,
  mode,
  pending,
  conversationTitle,
  contextLabel,
  depthLabel,
  usedTokens,
  trimNote,
  resolving,
  onModeChange,
  onSend,
  onRetry,
  onRegenerate,
  onStop,
  onDecision,
  onExplain,
  onOpenSettings,
  onRestart,
  onClearCurrent
}: Props) {
  const [draft, setDraft] = useState('')
  const streamRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const [composerHeight, setComposerHeight] = useState<number | null>(readComposerHeight)
  const [resizingComposer, setResizingComposer] = useState(false)
  const [files, setFiles] = useState<StagedFile[]>([])
  const [rejected, setRejected] = useState<string[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [staging, setStaging] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const stageLock = useRef(false)
  // 决策/解释/重试/重新生成经 latest ref 转发，别名引用不随渲染变化，EntryView 的 memo 才能命中。
  const handlers = useRef({ onDecision, onExplain, onRetry, onRegenerate })
  handlers.current = { onDecision, onExplain, onRetry, onRegenerate }
  const handleDecision = useCallback((action: DecisionAction, choice?: string): void => {
    handlers.current.onDecision(action, choice)
  }, [])
  const handleExplain = useCallback((candidate: ModelCandidate): void => {
    handlers.current.onExplain(candidate)
  }, [])
  const handleRetry = useCallback((): void => {
    handlers.current.onRetry()
  }, [])
  const handleRegenerate = useCallback((entryId: string): void => {
    handlers.current.onRegenerate(entryId)
  }, [])
  const rounds = useMemo(
    () => entries.reduce((count, entry) => (entry.role === 'user' ? count + 1 : count), 0),
    [entries]
  )
  // 距底 80px 内算「停在底部」；流式推进时只有停在底部才跟随，否则挂起浮钮提示。
  const [atBottom, setAtBottom] = useState(true)
  const atBottomRef = useRef(true)
  const [hasNew, setHasNew] = useState(false)
  const firstIdRef = useRef<string | null>(null)
  // 输入框高度由 ResizeObserver 写 ref，渲染期不再发 getBoundingClientRect。
  const composerHeightRef = useRef(140)

  const onStreamScroll = (): void => {
    const el = streamRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (near !== atBottomRef.current) {
      atBottomRef.current = near
      setAtBottom(near)
      if (near) setHasNew(false)
    }
  }

  const jumpToBottom = (): void => {
    const el = streamRef.current
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
    atBottomRef.current = true
    setAtBottom(true)
    setHasNew(false)
  }

  const scrollFrameRef = useRef(0)

  useEffect(() => {
    const el = streamRef.current
    if (!el) return
    const firstId = entries[0]?.id ?? null
    const switched = firstId !== firstIdRef.current
    firstIdRef.current = firstId
    const lastRole = entries[entries.length - 1]?.role
    // 同一帧只量一次、写一次；流式 token 连来时不会被每块重排卡住。
    cancelAnimationFrame(scrollFrameRef.current)
    scrollFrameRef.current = requestAnimationFrame(() => {
      // 刚切会话，或最后一条是自己发出的：总是到底。流式推进只跟随本来就停在底部的人。
      if (switched || lastRole === 'user') {
        atBottomRef.current = true
        setAtBottom(true)
        setHasNew(false)
        el.scrollTop = el.scrollHeight
        return
      }
      if (atBottomRef.current) el.scrollTop = el.scrollHeight
      else setHasNew(true)
    })
    return () => cancelAnimationFrame(scrollFrameRef.current)
  }, [entries])

  const ready = runtime.state === 'ready'
  const phaseDef = PHASES.find((p) => p.num === currentPhase)
  const phaseText = phaseDef
    ? `阶段${phaseDef.label} · ${STATE_TEXT[phases[phaseDef.num] ?? 'idle']}`
    : '阶段零 · 待开始'
  const blocked = mode === 'workflow' && pending
  const sendDisabled = !canSend || blocked || attaching

  useEffect(() => {
    try {
      if (composerHeight == null) window.localStorage.removeItem(COMPOSER_STORAGE_KEY)
      else window.localStorage.setItem(COMPOSER_STORAGE_KEY, String(composerHeight))
    } catch {
      /* 本地存储不可用时只保留本次会话 */
    }
  }, [composerHeight])

  useEffect(() => {
    const el = composerRef.current
    if (!el) return
    const observer = new ResizeObserver((records) => {
      const height = records[0]?.contentRect.height
      if (height) composerHeightRef.current = Math.round(height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (composerHeight == null) return
    setComposerHeight((value) =>
      value == null ? value : clampComposerHeight(value, chatRef.current)
    )
    const onResize = (): void =>
      setComposerHeight((value) =>
        value == null ? value : clampComposerHeight(value, chatRef.current)
      )
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [composerHeight == null])

  const startComposerResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = composerRef.current?.getBoundingClientRect().height ?? 140
    let last = startHeight
    setResizingComposer(true)
    document.body.style.userSelect = 'none'
    const move = (moveEvent: PointerEvent): void => {
      // 拖动期间只写 DOM 高度：流式重渲不会回写这个值，拖动不被每帧 setEntries 卡住。
      last = clampComposerHeight(startHeight - (moveEvent.clientY - startY), chatRef.current)
      if (composerRef.current) composerRef.current.style.height = `${last}px`
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.style.userSelect = ''
      setComposerHeight(last)
      setResizingComposer(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  const nudgeComposer = (delta: number): void => {
    const height = composerRef.current?.getBoundingClientRect().height ?? 140
    setComposerHeight(clampComposerHeight(height + delta, chatRef.current))
  }

  const onComposerKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      nudgeComposer(16)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      nudgeComposer(-16)
    }
  }

  const merge = (result: {
    files: StagedFile[]
    rejected: { name: string; reason: string }[]
  }): void => {
    if (result.files.length > 0) {
      setFiles((prev) => {
        const seen = new Set(prev.map((file) => file.path))
        return [...prev, ...result.files.filter((file) => !seen.has(file.path))]
      })
      window.dispatchEvent(new Event('mms:workspace-changed'))
    }
    setRejected(result.rejected.map((item) => `${item.name}：${item.reason}`))
    setAttachError(null)
  }

  const addPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0 || stageLock.current) return
    stageLock.current = true
    setStaging(true)
    try {
      merge(await window.studio.files.stage(paths))
    } catch (err) {
      setAttachError(errorText(err))
    } finally {
      stageLock.current = false
      setStaging(false)
    }
  }

  // 文件页拖过来或右键「添加到对话」：工作区里的原文件直接当附件，不复制副本。
  const attachRels = async (rels: string[]): Promise<void> => {
    if (rels.length === 0 || stageLock.current) return
    stageLock.current = true
    setStaging(true)
    try {
      merge(await window.studio.files.attach(rels))
    } catch (err) {
      setAttachError(errorText(err))
    } finally {
      stageLock.current = false
      setStaging(false)
    }
  }

  useEffect(() => {
    const onAttach = (event: Event): void => {
      const detail = (event as CustomEvent<{ rels?: unknown }>).detail
      const rels = detail?.rels
      if (Array.isArray(rels)) {
        void attachRels(rels.filter((rel): rel is string => typeof rel === 'string'))
      }
    }
    window.addEventListener('mms:attach-workspace', onAttach)
    return () => window.removeEventListener('mms:attach-workspace', onAttach)
    // attachRels 只用到 setState 与稳定的 ref，不需要随渲染重订阅
  }, [])

  const stampName = (base: string, ext: string): string => {
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `${base}-${stamp}.${ext}`
  }

  const extOf = (file: File): string => {
    const dot = file.name.lastIndexOf('.')
    const fromName = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : ''
    if (fromName) return fromName
    const fromType = file.type.split('/')[1] ?? ''
    return (fromType === 'jpeg' ? 'jpg' : fromType) || 'png'
  }

  // 剪贴板里的截图没有本地路径，字节直接写进暂存区；带路径的仍走 stage。
  const pastedFiles = async (list: File[]): Promise<void> => {
    if (list.length === 0 || stageLock.current) return
    stageLock.current = true
    setStaging(true)
    try {
      const staged: StagedFile[] = []
      const rejectedList: { name: string; reason: string }[] = []
      const paths: string[] = []
      for (const file of list) {
        let path = ''
        try {
          path = window.studio.files.pathFor(file)
        } catch {
          path = ''
        }
        if (path) {
          paths.push(path)
          continue
        }
        try {
          const data = await file.arrayBuffer()
          const base = file.type.startsWith('image/') ? '截图' : '剪贴板'
          staged.push(
            await window.studio.files.stageBlob({ name: stampName(base, extOf(file)), data })
          )
        } catch (err) {
          rejectedList.push({ name: file.name || '剪贴板文件', reason: errorText(err) })
        }
      }
      if (paths.length > 0) {
        const result = await window.studio.files.stage(paths)
        staged.push(...result.files)
        rejectedList.push(...result.rejected)
      }
      merge({ files: staged, rejected: rejectedList })
    } catch (err) {
      setAttachError(errorText(err))
    } finally {
      stageLock.current = false
      setStaging(false)
    }
  }

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const data = event.clipboardData
    if (!data) return
    const list: File[] = []
    for (let index = 0; index < data.items.length; index++) {
      const item = data.items[index]
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (file) list.push(file)
    }
    if (list.length === 0) return
    event.preventDefault()
    void pastedFiles(list)
  }

  const pick = async (): Promise<void> => {
    if (stageLock.current) return
    try {
      const result = await window.studio.files.pick()
      if (result) merge(result)
    } catch (err) {
      setAttachError(errorText(err))
    }
  }

  const remove = (file: StagedFile): void => {
    setFiles((prev) => prev.filter((item) => item.id !== file.id))
    if (file.origin === 'workspace') return
    void window.studio.files.discard(file.path).then(
      () => window.dispatchEvent(new Event('mms:workspace-changed')),
      () => undefined
    )
  }

  const reveal = (): void => {
    void window.studio.files.reveal().catch((err: unknown) => setAttachError(errorText(err)))
  }

  const onDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!acceptsDrop(event)) return
    event.preventDefault()
    setDragging(true)
  }

  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!acceptsDrop(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!acceptsDrop(event)) return
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setDragging(false)
  }

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    if (!acceptsDrop(event)) return
    event.preventDefault()
    setDragging(false)
    if (hasWorkspaceDrag(event)) {
      try {
        const raw: unknown = JSON.parse(event.dataTransfer.getData(WORKSPACE_DRAG))
        if (Array.isArray(raw)) {
          void attachRels(raw.filter((rel): rel is string => typeof rel === 'string'))
        }
      } catch {
        setAttachError('拖进来的内容读不出来')
      }
      return
    }
    const dropped = Array.from(event.dataTransfer.files)
    const paths: string[] = []
    const names: string[] = []
    for (const file of dropped) {
      let path = ''
      try {
        path = window.studio.files.pathFor(file)
      } catch {
        path = ''
      }
      if (path) paths.push(path)
      else names.push(`${file.name}：读不到本地路径`)
    }
    if (names.length > 0) {
      setRejected(names)
      setAttachError(null)
    }
    void addPaths(paths)
  }

  const submit = async (): Promise<void> => {
    const text = draft.trim()
    if (!canSend || streaming || blocked || attaching) return
    if (!text && files.length === 0) return

    let extras: SendExtras | undefined
    if (files.length > 0) {
      setAttaching(true)
      setAttachError(null)
      try {
        const result = await window.studio.files.context(files.map((file) => file.path))
        extras = {
          context: buildContextText(text, result.blocks, files),
          attachments: files.map((file) => ({ name: file.name, kind: file.kind, size: file.size })),
          attachmentPaths: files.map((file) => file.path)
        }
      } catch (err) {
        setAttachError(`附件读取失败：${errorText(err)}`)
        setAttaching(false)
        return
      }
      setAttaching(false)
    }

    setDraft('')
    setFiles([])
    setRejected([])
    onSend(text, extras)
  }

  const placeholder = !ready
    ? runtime.state === 'starting'
      ? '正在启动本地运行时…'
      : '运行时未连接'
    : !provider
      ? '先在模型设置里选择一个服务商'
      : !canSend
        ? '这个服务商还没有保存 API Key'
        : blocked
          ? '上面的决策卡还在等你的选择'
          : files.length > 0
            ? '可以只发附件，也可以补充说明'
            : mode === 'workflow'
              ? '粘贴赛题正文，也可以粘贴截图或拖入文件'
              : '想聊点什么？也可以直接拖入文件'

  const attachNotice = attachError ?? (rejected.length > 0 ? rejected.join('；') : null)

  return (
    <section
      className="chat"
      aria-label="对话"
      ref={chatRef}
      data-drag={dragging ? 'true' : undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className="chat__head">
        <div className="chat__head-main">
          <span className="chat__head-kind">{mode === 'workflow' ? '建模会话' : '自由问答'}</span>
          <h1 className="chat__head-title" title={conversationTitle}>
            {conversationTitle}
          </h1>
        </div>
        <div className="chat__head-side">
          <span
            className="chat__head-meter"
            title="按估算 token 显示；历史回放按这个预算截断，不是模型硬上限"
          >
            上下文约 {formatTokens(usedTokens)} / {contextLabel}
            {rounds > 0 ? ` · ${rounds} 轮` : ''}
          </span>
          {entries.length > 0 ? (
            <button type="button" className="linkbtn" data-action="clear-current" onClick={onClearCurrent}>
              新对话
            </button>
          ) : null}
        </div>
      </header>

      <div className="chat__streamwrap">
        <div className="chat__stream" ref={streamRef} onScroll={onStreamScroll}>
          <div className="chat__column">
            {entries.length === 0 ? (
              <WelcomeScreen
                mode={mode}
                files={files}
                rejected={rejected}
                failure={attachError}
                dragging={dragging}
                busy={staging}
                onPick={() => void pick()}
                onRemove={remove}
                onReveal={reveal}
                onSend={(text) => onSend(text)}
                onEnterWorkflow={() => onModeChange('workflow')}
              />
            ) : (
              <div className="messages" aria-live="polite">
                {entries.map((entry) =>
                  entry.notice ? (
                    <div className="msg-divider" key={entry.id} role="note">
                      <span>{entry.notice}</span>
                    </div>
                  ) : (
                    <EntryView
                      key={entry.id}
                      entry={entry}
                      onDecision={handleDecision}
                      onExplain={handleExplain}
                      onRetry={entry.error ? handleRetry : undefined}
                      onRegenerate={mode === 'chat' ? handleRegenerate : undefined}
                      resolving={resolving}
                    />
                  )
                )}
              </div>
            )}
          </div>
        </div>
        {!atBottom ? (
          <button
            type="button"
            className="chat__jump"
            data-action="jump-bottom"
            data-new={hasNew ? 'true' : undefined}
            onClick={jumpToBottom}
          >
            {hasNew ? '有新内容 · 回到底部' : '回到底部'}
          </button>
        ) : null}
      </div>

      {dragging && entries.length > 0 ? (
        <div className="chat__droplayer" aria-hidden="true">
          <span>松手添加附件</span>
        </div>
      ) : null}

      {runtime.state === 'error' ? (
        <div className="chat__banner" role="alert">
          <span>{runtime.message ?? '本地运行时启动失败'}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onRestart}>
            重试
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="chat__banner" role="alert">
          <span>{notice}</span>
        </div>
      ) : null}
      {entries.length > 0 && attachNotice ? (
        <div className="chat__banner" role="alert">
          <span>{attachNotice}</span>
        </div>
      ) : null}
      {trimNote ? (
        <div className="chat__banner chat__banner--soft" data-role="trim-note">
          <span>{trimNote}</span>
        </div>
      ) : null}

      <div className="chat__composer">
        <div
          className="splitter splitter--row"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整输入框高度"
          aria-valuenow={Math.round(composerHeight ?? composerHeightRef.current)}
          tabIndex={0}
          data-splitter="composer"
          data-dragging={resizingComposer ? 'true' : undefined}
          onPointerDown={startComposerResize}
          onDoubleClick={() => setComposerHeight(null)}
          onKeyDown={onComposerKey}
        />
        <div
          className="composer"
          ref={composerRef}
          data-resized={composerHeight != null ? 'true' : 'false'}
          style={
            composerHeight != null
              ? ({ height: `${composerHeight}px` } as CSSProperties)
              : undefined
          }
        >
          {files.length > 0 ? (
            <div className="composer__attach">
              <FileChips
                items={files}
                onRemove={(index) => remove(files[index])}
                label="待发送的附件"
              />
            </div>
          ) : null}
          <textarea
            className="composer__input"
            placeholder={placeholder}
            value={draft}
            disabled={!ready}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
        </div>
        <div className="composer__bar">
          <div className="mode-switch" role="group" aria-label="对话模式" data-active={mode}>
            <span className="mode-switch__thumb" aria-hidden="true" />
            <button
              type="button"
              className="mode-switch__btn"
              data-mode="chat"
              aria-pressed={mode === 'chat'}
              title="自由对话：问答、分析、写作，不按七阶段推进"
              onClick={() => onModeChange('chat')}
            >
              通用
            </button>
            <button
              type="button"
              className="mode-switch__btn"
              data-mode="workflow"
              aria-pressed={mode === 'workflow'}
              title="固定流程：题面确认 → 选模 → 基线 → 论文"
              onClick={() => onModeChange('workflow')}
            >
              数模
            </button>
          </div>
          <button
            type="button"
            className="pill pill--button pill--model"
            onClick={onOpenSettings}
            disabled={!provider}
            title="模型与 API Key 设置"
          >
            {provider
              ? `${provider.display} · ${provider.model}`
              : '未选择模型'}
          </button>
          <button
            type="button"
            className="pill pill--button pill--params"
            onClick={onOpenSettings}
            disabled={!provider}
            title={`上下文预算 ${contextLabel}，已用约 ${formatTokens(usedTokens)}；思维深度 ${depthLabel}。点击修改。`}
          >
            {contextLabel} · {depthLabel}
          </button>
          {mode === 'workflow' ? (
            <span className="pill" data-role="phase-pill">
              {phaseText}
            </span>
          ) : null}
          {streaming ? (
            <button type="button" className="pill pill--send pill--stop" onClick={onStop}>
              停止
            </button>
          ) : (
            <button
              type="button"
              className="pill pill--send"
              data-mode={mode}
              disabled={sendDisabled}
              onClick={() => void submit()}
            >
              {attaching ? '读取附件…' : mode === 'workflow' ? '开始建模' : '发送'}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
