import { useEffect, useState, type JSX } from 'react'
import type { ProviderList, ProviderView } from '../../../shared/api'

interface Props {
  open: boolean
  providers: ProviderList | null
  onClose: () => void
  onChanged: (list: ProviderList) => void
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function SettingsDialog({ open, providers, onClose, onChanged }: Props): JSX.Element | null {
  const [selected, setSelected] = useState('')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open || !providers) return
    const view = providers.providers.find((item) => item.id === providers.activeProvider) ?? providers.providers[0]
    if (view) {
      setSelected(view.id)
      setModel(view.model)
      setBaseUrl(view.baseUrl)
    }
    setApiKey('')
    setError('')
    setNote('')
  }, [open, providers])

  if (!open) return null

  const view: ProviderView | undefined = providers?.providers.find((item) => item.id === selected)
  const isFake = view?.id === 'fake'

  function selectProvider(id: string): void {
    const next = providers?.providers.find((item) => item.id === id)
    setSelected(id)
    if (next) {
      setModel(next.model)
      setBaseUrl(next.baseUrl)
    }
    setApiKey('')
    setError('')
    setNote('')
  }

  async function save(): Promise<void> {
    if (!view) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      const list = await window.studio.providers.save({
        id: view.id,
        model: model.trim(),
        baseUrl: view.custom ? baseUrl.trim() : undefined,
        apiKey: apiKey.trim() || undefined
      })
      onChanged(list)
      setNote('已保存')
      setApiKey('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function clearKey(): Promise<void> {
    if (!view) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      const list = await window.studio.providers.clear(view.id)
      onChanged(list)
      setNote('已清除 Key')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="设置">
        <header className="modal-head">
          <h2>设置</h2>
          <button className="icon" onClick={onClose} aria-label="关闭">×</button>
        </header>

        <label className="field">
          <span>服务商</span>
          <select value={selected} onChange={(event) => selectProvider(event.target.value)}>
            {providers?.providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.display}
                {item.configured && item.id !== 'fake' ? '（已配置）' : ''}
              </option>
            ))}
          </select>
        </label>

        {isFake ? (
          <p className="hint">离线模式不联网：用内置基线脚本与样例论文跑通链路，适合先看界面。</p>
        ) : (
          <>
            <label className="field">
              <span>模型</span>
              <input
                value={model}
                onChange={(event) => setModel(event.target.value)}
                list={`models-${view?.id ?? 'none'}`}
                placeholder={view?.models[0] || '模型名'}
              />
              <datalist id={`models-${view?.id ?? 'none'}`}>
                {view?.models.map((item) => <option key={item} value={item} />)}
              </datalist>
            </label>
            {view?.custom && (
              <label className="field">
                <span>Base URL</span>
                <input
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://…/v1"
                />
              </label>
            )}
            <label className="field">
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={view?.configured ? '已保存（留空则不变）' : '粘贴 Key'}
                autoComplete="off"
              />
            </label>
            <p className="hint">Key 用系统安全存储加密后保存，运行时按次传给本机进程，不写日志、不进事件。</p>
          </>
        )}

        {view?.note && <p className="hint">{view.note}</p>}
        {error && <p className="banner error">{error}</p>}
        {note && <p className="banner ok">{note}</p>}

        <footer className="modal-foot">
          {!isFake && (
            <button className="ghost" onClick={clearKey} disabled={busy}>
              清除 Key
            </button>
          )}
          <button className="primary" onClick={save} disabled={busy || !view}>
            {busy ? '保存中…' : '保存'}
          </button>
        </footer>
      </div>
    </div>
  )
}
