import type { WorkbenchState } from '../../../../shared/api'
import { PHASES, STATE_TEXT, type PhaseState } from '../../lib/phases'
import type { TabId } from './tabs'

interface Props {
  state: WorkbenchState | null
  phases: Record<number, PhaseState>
  currentPhase?: number
  resolvedModel: string | null
  pendingKind: string | null
  onGoto: (tab: TabId) => void
}

interface Chip {
  text: string
  goto?: TabId
}

export default function ProcessPanel({
  state,
  phases,
  currentPhase,
  resolvedModel,
  pendingKind,
  onGoto
}: Props) {
  const passed = state ? state.gate.filter((row) => row.ok).length : 0
  const versions = state?.figure.versions.length ?? 0
  const artifacts = state ? Object.keys(state.paper.artifacts) : []
  const round = state
    ? state.score.rounds.find((item) => item.round === state.score.defaultRound) ?? state.score.rounds[0]
    : undefined

  const chips: Record<number, Chip> = {
    0: state ? { text: `门禁 ${passed}/${state.gate.length}`, goto: 'gate' } : { text: '待预检' },
    1: { text: '题面与附件', goto: 'files' },
    2: { text: '赛题文件夹', goto: 'files' },
    3: resolvedModel
      ? { text: `已选：${resolvedModel}` }
      : pendingKind === 'model-choice'
        ? { text: '等你选模' }
        : { text: '未选模' },
    4: versions > 0
      ? { text: `图表 ${versions} 版`, goto: 'figure' }
      : { text: '未出图', goto: 'code' },
    5: artifacts.length > 0
      ? { text: `论文 ${artifacts.map((key) => key.toUpperCase()).join(' · ')}`, goto: 'paper' }
      : { text: '去构建论文', goto: 'paper' },
    6: round
      ? { text: `第 ${round.round} 轮 · ${round.total} 分`, goto: 'score' }
      : { text: '未评分', goto: 'score' }
  }

  const current = currentPhase == null ? null : PHASES.find((phase) => phase.num === currentPhase)

  return (
    <div className="panel" data-panel="process">
      <div className="panel__bar">
        <span className="panel__meta">{current ? `当前：${current.name}` : '等待开始'}</span>
      </div>
      <ol className="process">
        {PHASES.map((phase) => {
          const status = phases[phase.num] ?? 'idle'
          const chip = chips[phase.num]
          return (
            <li
              key={phase.num}
              className={`process-node process-node--${status}`}
              data-state={status}
              data-current={currentPhase === phase.num ? 'true' : undefined}
            >
              <span className="process-node__dot" aria-hidden="true" />
              <div className="process-node__head">
                <span className="process-node__num">{phase.num}</span>
                <span className="process-node__name">{phase.name}</span>
                <span className="process-node__state">{STATE_TEXT[status]}</span>
              </div>
              {chip ? (
                chip.goto ? (
                  <button type="button" className="process-chip" onClick={() => onGoto(chip.goto as TabId)}>
                    {chip.text}
                  </button>
                ) : (
                  <span className="process-chip process-chip--static">{chip.text}</span>
                )
              ) : null}
            </li>
          )
        })}
      </ol>
      <p className="panel__hint">节点颜色就是阶段状态；点下方芯片跳到对应页。</p>
    </div>
  )
}