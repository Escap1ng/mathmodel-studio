import { useEffect, useState } from 'react'
import type {
  FigureVersion,
  GateRow,
  ScoreDeduction,
  ScoreRound,
  WorkbenchState
} from '../../../shared/api'

const TABS = [
  { id: 'figure', label: '图表' },
  { id: 'paper', label: '论文' },
  { id: 'code', label: '代码' },
  { id: 'score', label: '评分' },
  { id: 'gate', label: '门禁' },
  { id: 'log', label: '日志' }
] as const
type TabId = (typeof TABS)[number]['id']

interface Props {
  runtimeReady: boolean
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function findVersion(state: WorkbenchState | null, id: string | null): FigureVersion | undefined {
  return state?.figure.versions.find((version) => version.id === id)
}

function verdictText(round: ScoreRound): string {
  if (round.veto) return '一票否决'
  return round.pass ? '达标' : '需优化'
}

const DIM_SHORT: Record<string, string> = {
  abstract: '摘要',
  model: '模型',
  innovation: '创新',
  writing: '写作',
  layout: '排版'
}

function GateBar({ rows, onPick }: { rows: GateRow[]; onPick: (id: string) => void }) {
  return (
    <div className="gatebar" aria-label="门禁摘要">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          className="gatebar__chip"
          data-gate={row.id}
          data-ok={row.ok ? 'true' : 'false'}
          title={row.detail}
          onClick={() => onPick(row.id)}
        >
          <span className="gatebar__dot" aria-hidden="true" />
          {row.label}
        </button>
      ))}
    </div>
  )
}

function FigurePanel({
  state,
  template,
  theme,
  rendering,
  error,
  onTemplate,
  onTheme,
  onRender,
  onRollback
}: {
  state: WorkbenchState
  template: string
  theme: string
  rendering: boolean
  error: string | null
  onTemplate: (value: string) => void
  onTheme: (value: string) => void
  onRender: () => void
  onRollback: (value: string) => void
}) {
  const figure = state.figure
  const active = findVersion(state, figure.active)
  const previous = findVersion(state, figure.previous)
  return (
    <div className="panel" data-panel="figure">
      <div className="panel__head">
        <div>
          <div className="panel__kicker">工作台 · 图表</div>
          <h2 className="panel__title">样例图与主题</h2>
        </div>
        <span className="panel__meta">{active ? `${active.label} · ${active.theme_title}` : '尚未渲染'}</span>
      </div>

      <div className="figure-controls">
        <label className="control">
          <span>模板</span>
          <select data-role="figure-template" value={template} onChange={(e) => onTemplate(e.target.value)}>
            {figure.templates.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </select>
        </label>
        <label className="control">
          <span>主题</span>
          <select data-role="figure-theme" value={theme} onChange={(e) => onTheme(e.target.value)}>
            {figure.themes.map((row) => (
              <option key={row.id} value={row.id}>
                {row.title}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          data-action="render-figure"
          disabled={rendering}
          onClick={onRender}
        >
          {rendering ? '渲染中…' : '重渲'}
        </button>
      </div>

      {error ? <div className="panel__error" role="alert">{error}</div> : null}

      {active ? (
        previous && previous.id !== active.id ? (
          <div className="figure-diff" data-role="figure-diff">
            <figure className="figure-shot figure-shot--previous">
              <img src={figure.previousImage ?? undefined} alt={`上一版 ${previous.label}`} />
              <figcaption>
                上一版 {previous.label} · {previous.theme_title}
                <button type="button" className="linkbtn" data-action="rollback" data-version={previous.id} onClick={() => onRollback(previous.id)}>
                  回滚
                </button>
              </figcaption>
            </figure>
            <figure className="figure-shot">
              <img src={figure.activeImage ?? undefined} alt={`当前 ${active.label}`} data-role="figure-image" />
              <figcaption>当前 {active.label} · {active.theme_title}</figcaption>
            </figure>
          </div>
        ) : (
          <figure className="figure-shot figure-shot--single">
            <img src={figure.activeImage ?? undefined} alt={`当前 ${active.label}`} data-role="figure-image" />
            <figcaption>
              {active.template_title} · {active.label} · {active.theme_title}
            </figcaption>
          </figure>
        )
      ) : (
        <div className="panel__empty">
          <p>还没有图表产物。先渲染一张样例图，之后可以换主题重渲并回滚。</p>
          <button type="button" className="btn btn--primary btn--sm" data-action="render-first" disabled={rendering} onClick={onRender}>
            渲染样例图
          </button>
        </div>
      )}

      {figure.versions.length ? (
        <div className="version-strip" aria-label="版本历史">
          <span className="version-strip__label">版本</span>
          {figure.versions.map((version) => (
            <button
              key={version.id}
              type="button"
              className="version-chip"
              data-version={version.id}
              data-active={version.id === figure.active ? 'true' : 'false'}
              disabled={version.id === figure.active || rendering}
              onClick={() => onRollback(version.id)}
            >
              {version.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ScorePanel({
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
      <div className="panel__head">
        <div>
          <div className="panel__kicker">决策点 K6 · 评分</div>
          <h2 className="panel__title">五维评分与扣分定位</h2>
        </div>
        <span className={`score-badge score-badge--${round.veto ? 'veto' : round.pass ? 'pass' : 'fix'}`} data-role="score-verdict">
          {badge}
        </span>
      </div>

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
  )
}

function GatePanel({ state }: { state: WorkbenchState }) {
  return (
    <div className="panel" data-panel="gate">
      <div className="panel__head">
        <div>
          <div className="panel__kicker">工作台 · 门禁</div>
          <h2 className="panel__title">当前交付检查</h2>
        </div>
      </div>
      <div className="gate-list">
        {state.gate.map((row) => (
          <div className={`gate-row${row.ok ? ' gate-row--ok' : ' gate-row--bad'}`} key={row.id} data-gate-row={row.id}>
            <span className="gate-row__dot" aria-hidden="true" />
            <span className="gate-row__label">{row.label}</span>
            <span className="gate-row__detail">{row.detail}</span>
          </div>
        ))}
      </div>
      <p className="panel__hint">
        章节结构来自 mathmodel-score 的样例 `chapter-sample.tex`；图表门禁检查 PNG/PDF/SVG 三件产物是否齐全。
      </p>
    </div>
  )
}

function CodePanel({ state }: { state: WorkbenchState }) {
  const active = findVersion(state, state.figure.active)
  return (
    <div className="panel" data-panel="code">
      <div className="panel__head">
        <div>
          <div className="panel__kicker">工作台 · 代码</div>
          <h2 className="panel__title">可复现的渲染命令</h2>
        </div>
      </div>
      {active ? (
        <>
          <pre className="code-block" data-role="figure-command">{active.command}</pre>
          <div className="path-list">
            {Object.entries(active.outputs).map(([kind, path]) => (
              <div key={kind} className="path-row">
                <span>{kind.toUpperCase()}</span>
                <code>{path}</code>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="panel__hint">先在图表页渲染一张图，这里会显示它实际执行的命令与产物路径。</p>
      )}
    </div>
  )
}

function LogPanel({ state }: { state: WorkbenchState }) {
  const active = findVersion(state, state.figure.active)
  return (
    <div className="panel" data-panel="log">
      <div className="panel__head">
        <div>
          <div className="panel__kicker">工作台 · 日志</div>
          <h2 className="panel__title">最近一次渲染</h2>
        </div>
      </div>
      {active ? (
        <>
          <pre className="code-block code-block--log">{active.stdout || '（无标准输出）'}</pre>
          {active.stderr ? <pre className="code-block code-block--error">{active.stderr}</pre> : null}
        </>
      ) : (
        <p className="panel__hint">还没有渲染记录。</p>
      )}
    </div>
  )
}

export default function WorkspacePane({ runtimeReady }: Props) {
  const [active, setActive] = useState<TabId>('figure')
  const [state, setState] = useState<WorkbenchState | null>(null)
  const [loading, setLoading] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [template, setTemplate] = useState('line-compare')
  const [theme, setTheme] = useState('nature')
  const [roundNo, setRoundNo] = useState(2)
  const [vetoMode, setVetoMode] = useState(false)
  const [deduction, setDeduction] = useState<ScoreDeduction | null>(null)

  const renderFigure = async (nextTemplate: string, nextTheme: string): Promise<void> => {
    setRendering(true)
    setError(null)
    try {
      const result = await window.studio.workbench.render(nextTemplate, nextTheme)
      setState(result.state)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRendering(false)
    }
  }

  useEffect(() => {
    if (!runtimeReady) return
    let alive = true
    setLoading(true)
    window.studio.workbench
      .state()
      .then((next) => {
        if (!alive) return
        setState(next)
        setRoundNo(next.score.defaultRound || next.score.rounds[0]?.round || 1)
        const activeVersion = next.figure.versions.find((v) => v.id === next.figure.active)
        if (activeVersion) {
          setTemplate(activeVersion.template)
          setTheme(activeVersion.theme)
        }
      })
      .catch((err: unknown) => {
        if (alive) setError(errorText(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // 只在 runtime 就绪时载入一次；渲染结果由 renderFigure 直接回填。
    // eslint 未启用，避免把 renderFigure 写进依赖导致反复载入。
  }, [runtimeReady])

  const pickGate = (id: string): void => {
    if (id === 'figure') setActive('figure')
    else if (id === 'score') setActive('score')
    else if (id === 'chapter') setActive('gate')
  }

  return (
    <aside className="workspace" aria-label="工作台" data-loading={loading ? 'true' : 'false'}>
      <div className="tabs" role="tablist">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            className="tab"
            data-tab={tab.id}
            aria-selected={tab.id === active}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {state ? <GateBar rows={state.gate} onPick={pickGate} /> : null}

      <div className="workspace__body" role="tabpanel">
        {!state && !error ? <div className="card">运行时准备好后载入工作台…</div> : null}
        {error && active !== 'figure' ? <div className="panel__error" role="alert">{error}</div> : null}
        {state && active === 'figure' ? (
          <FigurePanel
            state={state}
            template={template}
            theme={theme}
            rendering={rendering}
            error={error}
            onTemplate={(value) => {
              setTemplate(value)
            }}
            onTheme={(value) => {
              setTheme(value)
            }}
            onRender={() => void renderFigure(template, theme)}
            onRollback={(version) => {
              void window.studio.workbench
                .rollback(version)
                .then((result) => {
                  setState(result.state)
                  const picked = result.state.figure.versions.find((v) => v.id === result.state.figure.active)
                  if (picked) {
                    setTemplate(picked.template)
                    setTheme(picked.theme)
                  }
                })
                .catch((err: unknown) => setError(errorText(err)))
            }}
          />
        ) : null}
        {state && active === 'score' ? (
          <ScorePanel
            state={state}
            roundNo={roundNo}
            vetoMode={vetoMode}
            deduction={deduction}
            onRound={(round) => {
              setVetoMode(false)
              setRoundNo(round)
              setDeduction(null)
            }}
            onVeto={(value) => {
              setVetoMode(value)
              setDeduction(null)
            }}
            onDeduction={setDeduction}
          />
        ) : null}
        {state && active === 'gate' ? <GatePanel state={state} /> : null}
        {state && active === 'code' ? <CodePanel state={state} /> : null}
        {state && active === 'log' ? <LogPanel state={state} /> : null}
        {state && active === 'paper' ? (
          <div className="panel" data-panel="paper">
            <div className="panel__head">
              <div>
                <div className="panel__kicker">工作台 · 论文</div>
                <h2 className="panel__title">论文预览</h2>
              </div>
            </div>
            <div className="panel__empty">
              <p>论文 PDF / Word 的页级预览要在 M5 接上 xelatex 与 pandoc 之后才有产物。</p>
              <p>现在能先看图表、评分与扣分定位；评分样例来自 mathmodel-score 技能。</p>
            </div>
          </div>
        ) : null}
      </div>
    </aside>
  )
}
