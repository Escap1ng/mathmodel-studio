import type { WorkbenchState } from '../../../../shared/api'

export default function GatePanel({ state }: { state: WorkbenchState }) {
  const passed = state.gate.filter((row) => row.ok).length
  return (
    <div className="panel" data-panel="gate">
      <div className="panel__bar">
        <span className="panel__meta" data-role="gate-summary">
          {passed}/{state.gate.length} 通过
        </span>
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
        章节结构来自 mathmodel-score 的 chapter-sample.tex；图表门禁检查 PNG/PDF/SVG 三件产物是否齐全。
      </p>
    </div>
  )
}
