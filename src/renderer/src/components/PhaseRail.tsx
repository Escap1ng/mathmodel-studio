import { PHASES, STATE_TEXT, type PhaseState } from '../lib/phases'

interface Props {
  states: Record<number, PhaseState>
  current?: number
}

export default function PhaseRail({ states, current }: Props) {
  return (
    <nav className="rail" aria-label="建模阶段">
      <div className="rail__head">
        <div className="rail__title">赛题会话</div>
        <p className="rail__empty">还没有会话。上传赛题 PDF 或粘贴题目即从阶段零开始。</p>
      </div>
      <div className="phases">
        {PHASES.map((p) => {
          const state = states[p.num] ?? 'idle'
          return (
            <div key={p.num} className={`phase${current === p.num ? ' phase--active' : ''}`}>
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
