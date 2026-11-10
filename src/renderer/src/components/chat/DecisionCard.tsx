import type { DecisionAction, InterruptCard } from '../../../../shared/api'

export interface ModelCandidate {
  id: string
  name: string
  idea: string
  innovation: string
  interpretability: string
  difficulty: string
  eta: string
  accuracy: string
  recommended: boolean
  reason: string
  explain: {
    math: string
    fit: string
    diff: string
    verify: string
    eta: string
    source: string
  }
}

function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return fallback
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    : []
}

export function candidatesOf(payload: Record<string, unknown>): ModelCandidate[] {
  return records(payload.candidates).map((raw, index) => {
    const explain = raw.explain && typeof raw.explain === 'object' ? (raw.explain as Record<string, unknown>) : {}
    return {
      id: text(raw.id, `c${index + 1}`),
      name: text(raw.name, '未命名候选'),
      idea: text(raw.idea),
      innovation: text(raw.innovation),
      interpretability: text(raw.interpretability),
      difficulty: text(raw.difficulty),
      eta: text(raw.eta),
      accuracy: text(raw.accuracy),
      recommended: raw.recommended === true,
      reason: text(raw.reason),
      explain: {
        math: text(explain.math),
        fit: text(explain.fit),
        diff: text(explain.diff),
        verify: text(explain.verify),
        eta: text(explain.eta, text(raw.eta)),
        source: text(explain.source, 'mathmodel-methods · selection-guide')
      }
    }
  })
}

interface Props {
  card: InterruptCard
  busy: boolean
  resolving?: boolean
  onDecision: (action: DecisionAction, choice?: string) => void
  onExplain: (candidate: ModelCandidate) => void
}

const CANDIDATE_LEVEL: Record<string, number> = { 低: 1, 中: 2, 中高: 2.5, 高: 3 }
const RADAR_AXES = ['创新', '解释', '精度', '速度', '易做']

/** 「N–M 小时」取中点；解析不到就放弃这维，不让雷达瞎画。 */
function etaHours(eta: string): number | null {
  const nums = eta.match(/\d+(?:\.\d+)?/g)
  if (!nums || nums.length === 0) return null
  return nums.map(Number).reduce((sum, value) => sum + value, 0) / nums.length
}

function radarValues(candidate: ModelCandidate, speed: number | null): number[] | null {
  const innovation = CANDIDATE_LEVEL[candidate.innovation.trim()]
  const interpretability = CANDIDATE_LEVEL[candidate.interpretability.trim()]
  const difficulty = CANDIDATE_LEVEL[candidate.difficulty.trim()]
  const accuracy = CANDIDATE_LEVEL[candidate.accuracy.trim()]
  if (
    innovation === undefined ||
    interpretability === undefined ||
    difficulty === undefined ||
    accuracy === undefined ||
    speed === null
  ) {
    return null
  }
  // 难度与耗时都反向：外圈恒代表更优。
  return [innovation / 3, interpretability / 3, accuracy / 3, speed, (4 - difficulty) / 3]
}

function radarPoints(values: number[], radius: number): string {
  return values
    .map((value, index) => {
      const angle = (Math.PI * 2 * index) / values.length - Math.PI / 2
      const x = 60 + Math.cos(angle) * radius * value
      const y = 54 + Math.sin(angle) * radius * value
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function CandidateRadar({
  values,
  recommended,
  name
}: {
  values: number[]
  recommended: boolean
  name: string
}) {
  return (
    <div className="candidate__radar" role="img" aria-label={`${name} 五维对比`}>
      <svg viewBox="0 0 120 108" width="120" height="108" aria-hidden="true">
        <g className="candidate__radar-grid">
          {[0.33, 0.66, 1].map((scale) => (
            <polygon key={scale} points={radarPoints([1, 1, 1, 1, 1], 34 * scale)} />
          ))}
          {RADAR_AXES.map((axis, index) => {
            const angle = (Math.PI * 2 * index) / RADAR_AXES.length - Math.PI / 2
            return (
              <line
                key={axis}
                x1="60"
                y1="54"
                x2={(60 + Math.cos(angle) * 34).toFixed(1)}
                y2={(54 + Math.sin(angle) * 34).toFixed(1)}
              />
            )
          })}
        </g>
        {RADAR_AXES.map((axis, index) => {
          const angle = (Math.PI * 2 * index) / RADAR_AXES.length - Math.PI / 2
          return (
            <text
              key={axis}
              className="candidate__radar-label"
              x={(60 + Math.cos(angle) * 45).toFixed(1)}
              y={(54 + Math.sin(angle) * 45 + 2.5).toFixed(1)}
              textAnchor="middle"
            >
              {axis}
            </text>
          )
        })}
        <polygon
          className={`candidate__radar-fill${recommended ? ' candidate__radar-fill--pick' : ''}`}
          points={radarPoints(values, 34)}
        />
      </svg>
    </div>
  )
}

/** 点击后的等待反馈：resolving 且已 resolved 时给一次呼吸点，已 resolved 仍 disabled */
function ResolvingMark({ show }: { show: boolean }) {
  if (!show) return null
  return <i className="decision__spinner" aria-hidden="true" />
}

function ProblemConfirm({ card, busy, resolving, onDecision }: Props) {
  const payload = card.payload
  const questions = records(payload.questions)
  const attachments = records(payload.attachments)
  const resolved = card.resolved
  return (
    <section className="decision" data-card="problem-confirm">
      <div className="decision__head">
        <span className="decision__kicker">决策点 K2</span>
        <h3 className="decision__title">{text(payload.title, '赛题与附件确认')}</h3>
        <p className="decision__intro">{text(payload.intro)}</p>
      </div>
      <ol className="decision__questions">
        {questions.map((q, index) => (
          <li key={text(q.id, String(index))} data-role="question">
            <span className="decision__q-index">问 {index + 1}</span>
            <span className="decision__q-text">{text(q.text)}</span>
            <span className="decision__q-data">{text(q.data, '未附数据')}</span>
          </li>
        ))}
      </ol>
      <div className="decision__meta">
        <span>附件：{attachments.length ? `${attachments.length} 个` : '暂无'}</span>
        <span>{text(payload.warning)}</span>
      </div>
      <div className="decision__foot">
        {resolved ? <span className="decision__resolved">{resolved}</span> : null}
        <ResolvingMark show={resolving === true} />
        <button
          type="button"
          className="btn btn--primary"
          data-action="confirm"
          disabled={busy || Boolean(resolved)}
          onClick={() => onDecision('confirm')}
        >
          确认，继续
        </button>
      </div>
    </section>
  )
}

function ModelChoice({ card, busy, resolving, onDecision, onExplain }: Props) {
  const payload = card.payload
  const candidates = candidatesOf(payload)
  const resolved = card.resolved
  const hours = candidates.map((candidate) => etaHours(candidate.eta))
  const known = hours.filter((value): value is number => value !== null)
  const minHours = known.length > 0 ? Math.min(...known) : 0
  const maxHours = known.length > 0 ? Math.max(...known) : 0
  const speedOf = (value: number | null): number | null =>
    value === null
      ? null
      : maxHours === minHours
        ? 1
        : 0.35 + 0.65 * (1 - (value - minHours) / (maxHours - minHours))
  const radars = candidates.map((candidate, index) => radarValues(candidate, speedOf(hours[index])))
  const hasRadar = radars.some((values) => values !== null)
  return (
    <section className="decision" data-card="model-choice">
      <div className="decision__head">
        <span className="decision__kicker">决策点 K3 · 选模</span>
        <h3 className="decision__title">{text(payload.title, '算法选择')}</h3>
        <p className="decision__intro">{text(payload.intro)}</p>
        {hasRadar ? (
          <p className="decision__radar-note">越靠外越好；难度与耗时已反向归一。</p>
        ) : null}
      </div>
      <div className="decision__grid" data-count={candidates.length}>
        {candidates.map((candidate, index) => {
          const radar = radars[index]
          return (
            <article
              key={candidate.id}
              className={`candidate${candidate.recommended ? ' candidate--pick' : ''}`}
              data-candidate={candidate.id}
              data-recommended={candidate.recommended ? 'true' : 'false'}
            >
              <header className="candidate__head">
                <span className="candidate__index">{index + 1}</span>
                <h4 className="candidate__name">{candidate.name}</h4>
                {candidate.recommended ? <span className="candidate__badge">推荐</span> : null}
              </header>
              <p className="candidate__idea">{candidate.idea}</p>
              {radar ? (
                <CandidateRadar values={radar} recommended={candidate.recommended} name={candidate.name} />
              ) : null}
              <dl className="candidate__spec">
                <div>
                  <dt>创新度</dt>
                  <dd>{candidate.innovation}</dd>
                </div>
                <div>
                  <dt>可解释性</dt>
                  <dd>{candidate.interpretability}</dd>
                </div>
                <div>
                  <dt>实现难度</dt>
                  <dd>{candidate.difficulty}</dd>
                </div>
                <div>
                  <dt>预计耗时</dt>
                  <dd>{candidate.eta}</dd>
                </div>
                <div>
                  <dt>精度与鲁棒性</dt>
                  <dd>{candidate.accuracy}</dd>
                </div>
              </dl>
              {candidate.recommended ? <p className="candidate__reason">{candidate.reason}</p> : null}
              <div className="candidate__actions">
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  data-action="choose"
                  data-choice={candidate.id}
                  disabled={busy || Boolean(resolved)}
                  onClick={() => onDecision('choose', candidate.id)}
                >
                  选它
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  data-action="explain"
                  data-choice={candidate.id}
                  onClick={() => onExplain(candidate)}
                >
                  解释
                </button>
              </div>
            </article>
          )
        })}
      </div>
      <div className="decision__foot">
        {resolved ? <span className="decision__resolved">{resolved}</span> : null}
        <ResolvingMark show={resolving === true} />
        <span className="decision__batch">第 {text(payload.batch, '1')} 组</span>
        <button
          type="button"
          className="btn btn--ghost"
          data-action="reroll"
          disabled={busy || Boolean(resolved)}
          onClick={() => onDecision('reroll')}
        >
          换一批
        </button>
      </div>
    </section>
  )
}

export default function DecisionCard(props: Props) {
  return props.card.card === 'model-choice' ? <ModelChoice {...props} /> : <ProblemConfirm {...props} />
}
