import { useEffect, useState } from 'react'
import type { GateRow, ScoreDeduction, WorkbenchState } from '../../../../shared/api'
import type { PhaseState } from '../../lib/phases'
import FilesPanel from './FilesPanel'
import FigurePanel from './FigurePanel'
import PaperPanel from './PaperPanel'
import ScorePanel from './ScorePanel'
import GatePanel from './GatePanel'
import CodePanel from './CodePanel'
import LogPanel from './LogPanel'
import ProcessPanel from './ProcessPanel'
import { errorText } from '../../lib/format'
import { TABS, TAB_GROUPS, tabsForMode, type TabId } from './tabs'

interface Props {
  runtimeReady: boolean
  collapsed: boolean
  onToggle: () => void
  /** 通用模式只留文件页，数模模式恢复全量标签 */
  mode: 'workflow' | 'chat'
  /** 当前建模会话 id：文件页据此显示赛题项目文件夹 */
  projectId: string | null
  /** 工作台产物的会话作用域；空值让 runtime 回落到最近会话 */
  sessionId: string | null
  /** 过程总览：七阶段状态、当前阶段、已选模型与待决卡 */
  phases: Record<number, PhaseState>
  currentPhase?: number
  resolvedModel: string | null
  pendingKind: string | null
}

function GateSummary({ rows, onOpen }: { rows: GateRow[]; onOpen: () => void }) {
  const passed = rows.filter((row) => row.ok).length
  return (
    <button
      type="button"
      className="gate-summary"
      onClick={onOpen}
      title={rows.map((row) => `${row.label}：${row.detail}`).join('\n')}
    >
      <span className="gate-summary__dots" aria-hidden="true">
        {rows.map((row) => (
          <i key={row.id} className="gate-summary__dot" data-ok={row.ok ? 'true' : 'false'} data-gate={row.id} />
        ))}
      </span>
      <span className="gate-summary__text">门禁 {passed}/{rows.length}</span>
    </button>
  )
}

export default function WorkspacePane({
  runtimeReady,
  collapsed,
  onToggle,
  mode,
  projectId,
  sessionId,
  phases,
  currentPhase,
  resolvedModel,
  pendingKind
}: Props) {
  const scope = sessionId ?? undefined
  const [active, setActive] = useState<TabId>('process')
  const [state, setState] = useState<WorkbenchState | null>(null)
  const [loading, setLoading] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [building, setBuilding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [template, setTemplate] = useState('line-compare')
  const [theme, setTheme] = useState('nature')
  const [roundNo, setRoundNo] = useState(2)
  const [vetoMode, setVetoMode] = useState(false)
  const [deduction, setDeduction] = useState<ScoreDeduction | null>(null)
  // 论文预览页码按产物路径记：切去图表再回来、重开论文页都能停在原页。
  const [pdfPages, setPdfPages] = useState<Record<string, number>>({})
  const pdfPath = state?.paper.artifacts.pdf?.path ?? 'paper'
  const paperPage = pdfPages[pdfPath] ?? 1
  const setPaperPage = (page: number): void => {
    setPdfPages((prev) => ({ ...prev, [pdfPath]: page }))
  }

  const renderFigure = async (nextTemplate: string, nextTheme: string): Promise<void> => {
    setRendering(true)
    setError(null)
    try {
      const result = await window.studio.workbench.render(nextTemplate, nextTheme, scope)
      setState(result.state)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRendering(false)
    }
  }

  const buildPaper = async (): Promise<void> => {
    setBuilding(true)
    setError(null)
    try {
      const result = await window.studio.paper.build(scope)
      setState(result.state)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBuilding(false)
    }
  }

  useEffect(() => {
    if (!runtimeReady) return
    let alive = true
    setLoading(true)
    setState(null)
    window.studio.workbench
      .state(scope)
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
    // runtime 就绪或当前会话变化时重拉；渲染结果由 renderFigure 直接回填。
    // eslint 未启用，避免把 renderFigure 写进依赖导致反复载入。
  }, [runtimeReady, scope])

  // 进入数模就落在过程总览：模式切换本身是一次上下文重置。
  useEffect(() => {
    if (mode === 'workflow') setActive('process')
  }, [mode])

  // 阶段四把图登记成新版本后，主进程之外的改动不会走 renderFigure，靠事件回拉一次状态。
  useEffect(() => {
    const reload = (): void => {
      window.studio.workbench
        .state(scope)
        .then((next) => setState(next))
        .catch(() => undefined)
    }
    window.addEventListener('mms:workbench-changed', reload)
    return () => window.removeEventListener('mms:workbench-changed', reload)
  }, [scope])

  return (
    <aside
      className={`workspace${collapsed ? ' workspace--collapsed' : ''}`}
      aria-label="工作台"
      data-loading={loading ? 'true' : 'false'}
    >
      <div className="workspace__head">
        {collapsed ? (
          <button
            type="button"
            className="workspace__toggle"
            aria-label="展开工作台"
            title="展开工作台"
            onClick={onToggle}
          >
            ‹
          </button>
        ) : (
          <>
            <span className="workspace__name">{mode === 'chat' ? '文件' : '工作台'}</span>
            {mode === 'workflow' ? (
              state ? (
                <GateSummary rows={state.gate} onOpen={() => setActive('gate')} />
              ) : (
                <span className="workspace__hint">载入中…</span>
              )
            ) : null}
            <button
              type="button"
              className="workspace__toggle"
              aria-label="收起工作台"
              title="收起工作台，专注对话"
              onClick={onToggle}
            >
              ›
            </button>
          </>
        )}
      </div>

      {collapsed ? (
        <div className="workspace__icons">
          {state && mode === 'workflow' ? (
            <div
              className="workspace__gate-dots"
              title={state.gate.map((row) => `${row.label}：${row.detail}`).join('\n')}
            >
              {state.gate.map((row) => (
                <i key={row.id} data-ok={row.ok ? 'true' : 'false'} />
              ))}
            </div>
          ) : null}
          {tabsForMode(mode).map((tab) => (
            <button
              key={tab.id}
              type="button"
              className="workspace-icon"
              data-tab={tab.id}
              title={tab.label}
              aria-label={tab.label}
              onClick={() => {
                setActive(tab.id)
                onToggle()
              }}
            >
              {tab.icon}
            </button>
          ))}
        </div>
      ) : (
        <>
          {mode === 'workflow' ? (
            <div className="tabs" role="tablist">
              {TAB_GROUPS.map((group) => (
                <div className="tabs__group" key={group.label}>
                  <span className="tabs__label">{group.label}</span>
                  <div className="tabs__set">
                    {group.ids.map((id) => {
                      const tab = TABS.find((item) => item.id === id)
                      if (!tab) return null
                      return (
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
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <div className="workspace__body" role="tabpanel">
            {mode === 'chat' ? (
              <FilesPanel projectId={projectId} />
            ) : (
              <>
                {!state && !error && active !== 'files' && active !== 'process' ? (
                  <div className="card">运行时准备好后载入工作台…</div>
                ) : null}
                {error && active !== 'figure' && active !== 'files' ? (
                  <div className="panel__error" role="alert">{error}</div>
                ) : null}
                {active === 'process' ? (
                  <ProcessPanel
                    state={state}
                    phases={phases}
                    currentPhase={currentPhase}
                    resolvedModel={resolvedModel}
                    pendingKind={pendingKind}
                    onGoto={setActive}
                  />
                ) : null}
                {active === 'files' ? <FilesPanel projectId={projectId} /> : null}
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
                        .rollback(version, scope)
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
                {state && active === 'code' ? <CodePanel state={state} onGoto={setActive} /> : null}
                {state && active === 'log' ? <LogPanel state={state} onGoto={setActive} /> : null}
                {state && active === 'paper' ? (
                  <PaperPanel
                    state={state}
                    building={building}
                    error={error}
                    page={paperPage}
                    onPage={setPaperPage}
                    onBuild={() => void buildPaper()}
                  />
                ) : null}
              </>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
