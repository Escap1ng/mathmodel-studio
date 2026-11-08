import type { WorkbenchState } from '../../../../shared/api'
import { findVersion } from './helpers'
import type { TabId } from './tabs'

export default function CodePanel({ state, onGoto }: { state: WorkbenchState; onGoto: (tab: TabId) => void }) {
  const active = findVersion(state, state.figure.active)
  return (
    <div className="panel" data-panel="code">
      {active ? (
        <div className="code-layout">
          <pre className="code-block" data-role="figure-command">{active.command}</pre>
          <div className="path-list">
            {Object.entries(active.outputs).map(([kind, path]) => (
              <div key={kind} className="path-row">
                <span>{kind.toUpperCase()}</span>
                <code>{path}</code>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="panel__empty">
          <p>还没有可复现的命令。渲染过图表后，这里会显示实际执行的命令与产物路径。</p>
          <button type="button" className="btn btn--primary btn--sm" data-action="goto-figure" onClick={() => onGoto('figure')}>
            去图表页渲染
          </button>
        </div>
      )}
    </div>
  )
}
