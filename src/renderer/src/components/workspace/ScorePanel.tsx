import type { ScoreDeduction, WorkbenchState } from '../../../../shared/api'
import { DIM_SHORT, verdictText } from './helpers'

export default function ScorePanel({
  state,
  roundNo,
  vetoMode,
  deduction,
  onRound,
  onVeto,
  onDeduction
}: {
  state: WorkbenchState
  roundNo: number
  vetoMode: boolean
  deduction: ScoreDeduction | null
  onRound: (round: number) => void
  onVeto: (value: boolean) => void
  onDeduction: (value: ScoreDeduction | null) => void
}) {
  const rounds = state.score.rounds
  const round = vetoMode ? state.score.veto : rounds.find((r) => r.round === roundNo) ?? rounds[0]
  if (!round) return <div className="panel__error">评分数据为空</div>
  const badge = verdictText(round)
  const changes = round.changes ?? []
  return (
    <div className={`panel score-panel${round.veto ? ' score-panel--veto' : ''}`} data-panel="score" data-round={round.round}>
      <div className="panel__bar">
        <div className="score-toolbar">
          {rounds.map((r) => (
            <button
              key={r.round}
              type="button"
              className="score-round"
              data-round={r.round}
              aria-pressed={!vetoMode && r.round === round.round}
              onClick={() => onRound(r.round)}
            >
              第 {r.round} 轮
            </button>
          ))}
          <button
            type="button"
            className="score-round score-round--veto"
            data-action="veto"
            aria-pressed={vetoMode}
            onClick={() => onVeto(!vetoMode)}
          >
            红线示例
          </button>
        </div>
        <span className={`score-badge score-badge--${round.veto ? 'veto' : round.pass ? 'pass' : 'fix'}`} data-role="score-verdict">
          {badge}
        </span>
      </div>

      {round.veto ? (
        <div className="veto-bar" role="alert">
          触发一票否决（身份信息/页眉等红线），直接淘汰、不计分，不进入优化循环。
        </div>
      ) : null}
      {round.breaker ? (
        <div className="breaker-bar" role="alert">
          未达 85 分标准，需人工复核（第 {round.round} 轮，熔断上限 3 轮）。
        </div>
      ) : null}

      <div className="score-layout">
        <div className="score-layout__main">
          <div className="score-total" data-role="score-total">
            <strong>{round.total}</strong>
            <span>/ 100</span>
            <small>{round.pass ? `≥ ${round.pass_score} 达标` : `低于 ${round.pass_score}`}</small>
          </div>

          <div className="score-bars">
            {round.dimensions.map((dim) => (
              <div className="score-row" key={dim.id} data-dim={dim.id}>
                <span className="score-row__label">{dim.label}</span>
                <span className="score-row__bar">
                  <i style={{ width: `${Math.max(0, Math.min(100, (dim.score / dim.max) * 100))}%` }} />
                </span>
                <span className="score-row__num">
                  {dim.score}/{dim.max}
                </span>
              </div>
            ))}
          </div>

          {changes.length ? (
            <div className="score-changes">
              <span>较上一轮：</span>
              {changes.map((change) => (
                <span key={change.dim} className={change.delta > 0 ? 'is-up' : 'is-down'}>
                  {change.dim} {change.from}→{change.to}（{change.delta > 0 ? '+' : ''}
                  {change.delta}）
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="score-layout__side">
          <div className="deductions">
            <div className="deductions__head">
              <span>扣分明细</span>
              <small>{round.deductions.length} 项</small>
            </div>
            {round.deductions.map((item, index) => (
              <button
                key={`${item.dim_id}-${index}`}
                type="button"
                className="deduction"
                data-deduction={index}
                data-picked={deduction === item ? 'true' : 'false'}
                onClick={() => onDeduction(deduction === item ? null : item)}
              >
                <span className="deduction__dim">{DIM_SHORT[item.dim_id] ?? item.dim}</span>
                <span className="deduction__item">{item.item}</span>
                <span className="deduction__penalty">-{item.penalty}</span>
              </button>
            ))}
          </div>

          {deduction ? (
            <div className="deduction-detail" data-role="deduction-detail">
              <div className="deduction-detail__target">定位：{deduction.target}</div>
              <p>{deduction.suggestion}</p>
              {deduction.note ? <small>{deduction.note}</small> : null}
            </div>
          ) : (
            <p className="panel__hint">点一条扣分项，看它落在正文哪一处、该怎么改。</p>
          )}
        </div>
      </div>
    </div>
  )
}
