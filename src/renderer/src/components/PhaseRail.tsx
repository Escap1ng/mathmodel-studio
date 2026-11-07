import { useEffect, useRef, useState } from 'react'
import type { ConversationItem } from '../lib/conversations'
import { formatAgo } from '../lib/format'
import { PHASES, STATE_TEXT, type PhaseState } from '../lib/phases'

interface Props {
  mode: 'workflow' | 'chat'
  states: Record<number, PhaseState>
  current?: number
  conversations: ConversationItem[]
  activeId: string | null
  busy: boolean
  onNew: () => void
  onSelect: (item: ConversationItem) => void
  onDelete: (item: ConversationItem) => void
  onClearAll: () => void
}

export default function PhaseRail({
  mode,
  states,
  current,
  conversations,
  activeId,
  busy,
  onNew,
  onSelect,
  onDelete,
  onClearAll
}: Props) {
  const hasSession = Object.keys(states).length > 0
  const currentDef = PHASES.find((p) => p.num === current)
  const summary =
    hasSession && currentDef
      ? `当前停在阶段${currentDef.label} · ${STATE_TEXT[states[currentDef.num] ?? 'idle']}`
      : '还没有建模会话。上传赛题或粘贴题目即从阶段零开始。'
  // 两种内容（会话列表、阶段轨道）始终挂载：chat 下阶段区 0fr 折叠，workflow 下
  // 会话列表折叠成窄条（头部的「会话列表」按钮展开，占满左栏）。
  const [convsOpen, setConvsOpen] = useState(false)
  const [asking, setAsking] = useState<string | null>(null)
  const [askClear, setAskClear] = useState(false)
  const timer = useRef(0)
  // 进入数模瞬间给一次圆点逐个点亮：只播一遍，播完回到实时状态色。
  const [phasesEntering, setPhasesEntering] = useState(false)
  const prevMode = useRef(mode)

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
    },
    []
  )

  useEffect(() => {
    const was = prevMode.current
    prevMode.current = mode
    if (was === 'workflow' || mode !== 'workflow') return
    setPhasesEntering(true)
    const stagger = window.setTimeout(() => setPhasesEntering(false), 700)
    return () => window.clearTimeout(stagger)
  }, [mode])

  const arm = (key: string): void => {
    setAsking(key)
    setAskClear(false)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAsking(null), 2600)
  }

  const askDelete = (item: ConversationItem): void => {
    const key = `${item.kind}:${item.id}`
    if (asking === key) {
      setAsking(null)
      window.clearTimeout(timer.current)
      onDelete(item)
      return
    }
    arm(key)
  }

  const askClearAll = (): void => {
    if (askClear) {
      setAskClear(false)
      window.clearTimeout(timer.current)
      onClearAll()
      return
    }
    setAsking(null)
    setAskClear(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setAskClear(false), 3200)
  }

  return (
    <nav
      className="rail"
      data-mode={mode}
      data-convs-open={mode === 'workflow' && convsOpen ? 'true' : 'false'}
      aria-label="会话与建模阶段"
    >
      <div className="rail__head">
        <div className="rail__title">会话</div>
        {mode === 'workflow' ? (
          <button
            type="button"
            className="rail__convs-toggle linkbtn"
            data-action="convs-toggle"
            disabled={busy}
            aria-expanded={convsOpen}
            onClick={() => setConvsOpen((value) => !value)}
          >
            {convsOpen ? '收起会话' : '会话列表'}
          </button>
        ) : null}
        <button
          type="button"
          className="rail__new"
          data-action="new-chat"
          disabled={busy}
          onClick={onNew}
        >
          <span aria-hidden="true">＋</span> 新对话
        </button>
      </div>

      <div className="rail__convs" data-role="conversation-list">
        <div className="rail__convs-inner">
          {conversations.length === 0 ? (
            <p className="rail__empty">
              还没有历史。发一条消息，或在建模中途停下，会话会留在这里。
            </p>
          ) : (
            conversations.map((item) => {
              const key = `${item.kind}:${item.id}`
              const active = item.id === activeId
              const confirming = asking === key
              return (
                <div
                  key={key}
                  className={`conv${active ? ' conv--active' : ''}`}
                  data-kind={item.kind}
                  data-active={active ? 'true' : 'false'}
                >
                  <button
                    type="button"
                    className="conv__main"
                    disabled={busy && !active}
                    title={item.title}
                    onClick={() => onSelect(item)}
                  >
                    <span className="conv__title">{item.title}</span>
                    <span className="conv__meta">
                      <span className="conv__tag">{item.kind === 'workflow' ? '建模' : '问答'}</span>
                      {formatAgo(item.updatedAt)}
                      {item.pending ? <span className="conv__pending">待决策</span> : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="conv__del"
                    data-confirm={confirming ? 'true' : 'false'}
                    disabled={busy}
                    aria-label={confirming ? '再点一次删除会话' : `删除会话 ${item.title}`}
                    title={confirming ? '再点一次删除' : '删除会话'}
                    onClick={() => askDelete(item)}
                  >
                    {confirming ? '确认' : '×'}
                  </button>
                </div>
              )
            })
          )}
          {conversations.length > 0 ? (
            <div className="rail__convs-foot">
              <button
                type="button"
                className="rail__clear"
                data-confirm={askClear ? 'true' : 'false'}
                disabled={busy}
                onClick={askClearAll}
              >
                {askClear ? '再点一次清空全部' : '清空历史'}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="rail__divider" />

      <div className="rail__phases" data-role="phase-track">
        <div className="rail__phases-inner">
          <div className="rail__head rail__head--phases">
            <div className="rail__title">建模阶段</div>
            <p className="rail__empty" data-role="rail-summary">
              {summary}
            </p>
          </div>
          <div className="phases" data-entering={phasesEntering ? 'true' : undefined}>
            {PHASES.map((p) => {
              const state = states[p.num] ?? 'idle'
              return (
                <div
                  key={p.num}
                  className={`phase phase--${state}${current === p.num ? ' phase--active' : ''}`}
                  data-phase={p.num}
                  data-state={state}
                >
                  <span className="phase__dot" aria-hidden="true" />
                  <span className="phase__name">
                    <span className="phase__num">{p.label}</span>
                    {p.name}
                  </span>
                  <span className="phase__state">{STATE_TEXT[state]}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </nav>
  )
}
