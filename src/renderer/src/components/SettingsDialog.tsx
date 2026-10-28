import { useEffect, useMemo, useState } from 'react'
import type { ProviderList } from '../../../shared/api'

interface Props {
  list: ProviderList
  onClose: () => void
  onChanged: (list: ProviderList) => void
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function SettingsDialog({ list, onClose, onChanged }: Props) {
  const [selected, setSelected] = useState(list.activeProvider || list.providers[0]?.id || '')
  const view = useMemo(
    () => list.providers.find((p) => p.id === selected) ?? list.providers[0],
    [list.providers, selected]
  )

  const [model, setModel] = useState(view?.model ?? '')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(view?.baseUrl ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  if (!view) return null

  const select = (id: string): void => {
    const next = list.providers.find((p) => p.id === id)
    setSelected(id)
    setModel(next?.model ?? '')
    setBaseUrl(next?.baseUrl ?? '')
    setApiKey('')
    setError(null)
  }

  const save = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await window.studio.providers.save({
        id: view.id,
        model: model.trim(),
        apiKey: apiKey.trim() || undefined,
        baseUrl: view.custom ? baseUrl.trim() : undefined
      })
      setApiKey('')
      onChanged(next)
      onClose()
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await window.studio.providers.clear(view.id)
      setApiKey('')
      onChanged(next)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const canSave = model.trim().length > 0 && (!view.custom || baseUrl.trim().length > 0)

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings__head">
          <h2 className="settings__title" id="settings-title">
            模型与服务商
          </h2>
          <p className="settings__sub">
            Key 只交给主进程，用系统安全存储加密后落盘；渲染层、事件流与日志里都不会出现明文。
          </p>
        </div>

        <div className="settings__providers" role="group" aria-label="选择服务商">
          {list.providers.map((p) => (
            <button
              key={p.id}
              type="button"
              className="provider-chip"
              aria-pressed={p.id === view.id}
              onClick={() => select(p.id)}
            >
              <span className={`provider-chip__dot${p.configured ? ' is-on' : ''}`} aria-hidden="true" />
              {p.display}
            </button>
          ))}
        </div>

        <div className="settings__body">
          <label className="field">
            <span className="field__label">模型</span>
            <input
              value={model}
              list={`models-${view.id}`}
              spellCheck={false}
              autoComplete="off"
              placeholder={view.models[0] ?? '模型 ID'}
              onChange={(event) => setModel(event.target.value)}
            />
            <datalist id={`models-${view.id}`}>
              {view.models.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            {view.models.length > 0 ? (
              <span className="field__hint">可选：{view.models.join(' · ')}</span>
            ) : null}
          </label>

          {view.custom ? (
            <label className="field">
              <span className="field__label">Base URL</span>
              <input
                value={baseUrl}
                spellCheck={false}
                autoComplete="off"
                placeholder="https://example.com/v1"
                onChange={(event) => setBaseUrl(event.target.value)}
              />
              <span className="field__hint">只接受 https；本机 http 端点仅限 127.0.0.1 或 localhost。</span>
            </label>
          ) : null}

          {view.requiresKey ? (
            <label className="field">
              <span className="field__label">
                API Key
                {view.configured ? <span className="field__badge">已保存</span> : null}
              </span>
              <input
                type="password"
                value={apiKey}
                spellCheck={false}
                autoComplete="off"
                placeholder={view.configured ? '留空则不修改已保存的 Key' : '粘贴 Key，保存后不再回显'}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <span className="field__hint">
                {view.configured
                  ? '已保存的 Key 不会回到界面，也无法查看；只能覆盖或清除。'
                  : '系统安全存储不可用时会拒绝保存，而不是退回明文。'}
              </span>
            </label>
          ) : null}

          {view.note ? <p className="settings__note">{view.note}</p> : null}
        </div>

        <div className="settings__foot">
          {error ? <span className="settings__error">{error}</span> : null}
          {!error && view.requiresKey && view.configured ? (
            <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void clearKey()}>
              清除 Key
            </button>
          ) : null}
          <span className="settings__spacer" />
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={busy || !canSave}
            onClick={() => void save()}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
