import { PHASES, STATE_TEXT, type PhaseState } from '../lib/phases'

interface Props {
  states: Record<number, PhaseState>
  current?: number
}

export default function PhaseRail({ states, current }: Props) {
  const hasSession = Object.keys(states).length > 0
  const currentDef = PHASES.find((p) => p.num === current)
  const summary =
    hasSession && currentDef
      ? `当前停在阶段${currentDef.label} · ${STATE_TEXT[states[currentDef.num] ?? 'idle']}`
      : '还没有会话。上传赛题 PDF 或粘贴题目即从阶段零开始。'
  return (
    <nav className="rail" aria-label="建模阶段">
      <div className="rail__head">
        <div className="rail__title">赛题会话</div>
        <p className="rail__empty" data-role="rail-summary">
          {summary}
        </p>
      </div>
      <div className="phases">
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
    </nav>
  )
}
