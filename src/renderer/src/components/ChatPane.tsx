import { useEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import type { DecisionAction, ProviderView, RuntimeStatus, StagedFile } from '../../../shared/api'
import { buildContextText, type SendExtras } from '../lib/attachments'
import { isRecordData, type ChatEntry, type ToolCard } from '../lib/chat'
import { PHASES, STATE_TEXT, type PhaseState } from '../lib/phases'
import DecisionCard, { type ModelCandidate } from './DecisionCard'
import DropZone from './DropZone'
import FileChips from './FileChips'

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

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
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
  onModeChange: (mode: 'workflow' | 'chat') => void
  onSend: (text: string, extras?: SendExtras) => void
  onStop: () => void
  onDecision: (action: DecisionAction, choice?: string) => void
  onExplain: (candidate: ModelCandidate) => void
  onOpenSettings: () => void
  onRestart: () => void
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
  if (isRecordData(result)) {
    if (result.ok === false && typeof result.error === 'string') return result.error
    if (typeof result.total === 'number' && isRecordData(result.by_skill)) {
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

function EntryView({
  entry,
  onDecision,
  onExplain
}: {
  entry: ChatEntry
  onDecision: (action: DecisionAction, choice?: string) => void
  onExplain: (candidate: ModelCandidate) => void
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
          <div className="msg__text" key={`t-${index}`}>
            {part.text}
            {entry.streaming && index === entry.parts.length - 1 ? (
              <span className="cursor" aria-hidden="true" />
            ) : null}
          </div>
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
          onDecision={onDecision}
          onExplain={onExplain}
        />
      ) : null}
      {entry.error ? <div className="msg__error">{entry.error}</div> : null}
      {entry.doneReason === 'cancelled' ? <div className="msg__note">已停止</div> : null}
      {entry.doneReason === 'waiting' && !entry.interrupt?.resolved ? (
        <div className="msg__note">已暂停，等你做出选择。</div>
      ) : null}
      {entry.doneReason === 'max_tool_rounds' ? (
        <div className="msg__note">工具调用轮数已用尽，这一轮先停在这里。</div>
      ) : null}
    </article>
  )
}

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
  onModeChange,
  onSend,
  onStop,
  onDecision,
  onExplain,
  onOpenSettings,
  onRestart
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
  const ready = runtime.state === 'ready'
  const phaseDef = PHASES.find((p) => p.num === currentPhase)
  const phaseText = phaseDef
    ? `阶段${phaseDef.label} · ${STATE_TEXT[phases[phaseDef.num] ?? 'idle']}`
    : '阶段零 · 待开始'
  const blocked = mode === 'workflow' && pending
  const sendDisabled = !canSend || blocked || attaching

  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries])

  useEffect(() => {
    try {
      if (composerHeight == null) window.localStorage.removeItem(COMPOSER_STORAGE_KEY)
      else window.localStorage.setItem(COMPOSER_STORAGE_KEY, String(composerHeight))
    } catch {
      /* 本地存储不可用时只保留本次会话 */
    }
  }, [composerHeight])

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
    setResizingComposer(true)
    document.body.style.userSelect = 'none'
    const move = (moveEvent: PointerEvent): void => {
      setComposerHeight(
        clampComposerHeight(startHeight - (moveEvent.clientY - startY), chatRef.current)
      )
    }
    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.style.userSelect = ''
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
    void window.studio.files.discard(file.path).then(
      () => window.dispatchEvent(new Event('mms:workspace-changed')),
      () => undefined
    )
  }

  const reveal = (): void => {
    void window.studio.files.reveal().catch((err: unknown) => setAttachError(errorText(err)))
  }

  const onDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDragging(true)
  }

  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setDragging(false)
  }

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDragging(false)
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
          attachments: files.map((file) => ({ name: file.name, kind: file.kind, size: file.size }))
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
              ? '粘贴赛题正文，先确认题面与附件'
              : '描述这道题，或粘贴题目正文'

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
      <div className="chat__stream" ref={streamRef}>
        <div className="chat__column">
          {entries.length === 0 ? (
            <DropZone
              files={files}
              rejected={rejected}
              failure={attachError}
              dragging={dragging}
              busy={staging}
              onPick={() => void pick()}
              onRemove={remove}
              onReveal={reveal}
            />
          ) : (
            <div className="messages" aria-live="polite">
              {entries.map((entry) => (
                <EntryView
                  key={entry.id}
                  entry={entry}
                  onDecision={onDecision}
                  onExplain={onExplain}
                />
              ))}
            </div>
          )}
        </div>
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

      <div
        className="chat__composer"
        ref={composerRef}
        data-resized={composerHeight != null ? 'true' : 'false'}
        style={
          composerHeight != null
            ? ({ height: `${composerHeight}px` } as CSSProperties)
            : undefined
        }
      >
        <div
          className="splitter splitter--row"
          role="separator"
          aria-orientation="horizontal"
          aria-label="调整输入框高度"
          aria-valuenow={Math.round(composerHeight ?? composerRef.current?.getBoundingClientRect().height ?? 140)}
          tabIndex={0}
          data-splitter="composer"
          data-dragging={resizingComposer ? 'true' : undefined}
          onPointerDown={startComposerResize}
          onDoubleClick={() => setComposerHeight(null)}
          onKeyDown={onComposerKey}
        />
        <div className="composer">
          {entries.length > 0 ? (
            <div className="composer__attach">
              <FileChips
                items={files}
                onRemove={(index) => remove(files[index])}
                label="待发送的附件"
              />
              <button
                type="button"
                className="composer__add"
                onClick={() => void pick()}
                disabled={!ready}
                title="添加附件"
              >
                ＋ 附件
              </button>
            </div>
          ) : null}
          <textarea
            className="composer__input"
            placeholder={placeholder}
            value={draft}
            disabled={!ready}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer__bar">
            <div className="mode-switch" role="group" aria-label="输入模式">
              <button
                type="button"
                className="mode-switch__btn"
                data-mode="workflow"
                aria-pressed={mode === 'workflow'}
                onClick={() => onModeChange('workflow')}
              >
                建模
              </button>
              <button
                type="button"
                className="mode-switch__btn"
                data-mode="chat"
                aria-pressed={mode === 'chat'}
                onClick={() => onModeChange('chat')}
              >
                问答
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
            <span className="pill" data-role="phase-pill">
              {phaseText}
            </span>
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
      </div>
    </section>
  )
}
