import type { WorkbenchState } from '../../../../shared/api'
import SelectMenu from '../common/SelectMenu'
import { findVersion } from './helpers'

export default function FigurePanel({
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
  return (
    <div className="panel" data-panel="figure">
      <div className="panel__bar">
        <span className="panel__meta">
          {active ? `${active.label} · ${active.theme_title}` : '尚未渲染'}
        </span>
      </div>

      <div className="figure-controls">
        <SelectMenu
          label="模板"
          value={template}
          options={figure.templates}
          dataRole="figure-template"
          onChange={onTemplate}
        />
        <SelectMenu
          label="主题"
          value={theme}
          options={figure.themes}
          dataRole="figure-theme"
          onChange={onTheme}
        />
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
        <figure className="figure-shot figure-shot--single">
          <img src={figure.activeImage ?? undefined} alt={`当前 ${active.label}`} data-role="figure-image" />
          <figcaption>
            {active.template_title} · {active.label} · {active.theme_title}
          </figcaption>
        </figure>
      ) : (
        <div className="panel__empty">
          <p>还没有图表产物。</p>
          <ol className="empty-steps">
            <li>选模板与主题</li>
            <li>渲染出首版 PNG/PDF/SVG</li>
            <li>换主题重渲，旧版留在下方历史里</li>
          </ol>
          <button type="button" className="btn btn--primary btn--sm" data-action="render-first" disabled={rendering} onClick={onRender}>
            渲染样例图
          </button>
        </div>
      )}

      {figure.versions.length ? (
        <div className="version-strip" aria-label="历史版本">
          <span className="version-strip__label">历史</span>
          {figure.versions.map((version) => (
            <button
              key={version.id}
              type="button"
              className="version-chip"
              data-version={version.id}
              data-active={version.id === figure.active ? 'true' : 'false'}
              title={`${version.template_title} · ${version.theme_title}`}
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
