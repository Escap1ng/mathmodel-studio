import type { WorkbenchState } from '../../../../shared/api'
import { findVersion } from './helpers'
import type { TabId } from './tabs'

export default function LogPanel({ state, onGoto }: { state: WorkbenchState; onGoto: (tab: TabId) => void }) {
  const active = findVersion(state, state.figure.active)
  return (
    <div className="panel" data-panel="log">
      {active ? (
        <>
          <pre className="code-block code-block--log">{active.stdout || '（无标准输出）'}</pre>
          {active.stderr ? <pre className="code-block code-block--error">{active.stderr}</pre> : null}
        </>
      ) : (
        <div className="panel__empty">
          <p>还没有渲染记录。</p>
          <button type="button" className="btn btn--primary btn--sm" data-action="goto-figure" onClick={() => onGoto('figure')}>
            去图表页渲染
          </button>
        </div>
      )}
    </div>
  )
}
