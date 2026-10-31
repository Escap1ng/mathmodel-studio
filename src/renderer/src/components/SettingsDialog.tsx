import { useEffect, useMemo, useState } from 'react'
import type { ProviderList, ThinkingDepth } from '../../../shared/api'
import {
  CONTEXT_OPTIONS,
  DEPTH_OPTIONS,
  contextLabel,
  depthLabel,
  formatTokens
} from '../lib/context'

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
  const [contextTokens, setContextTokens] = useState(view?.contextLimit ?? 200_000)
  const [depth, setDepth] = useState<ThinkingDepth>(view?.thinkingDepth ?? 'high')
  const [sendThinking, setSendThinking] = useState(view?.sendThinking ?? true)
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

  const fake = view.id === 'fake'
  const reasoning = view.reasoning
  const mapping = reasoning
    ? DEPTH_OPTIONS.map((option) => `${option.label}→${reasoning.map[option.value] ?? '不发送'}`).join(' · ')
    : ''
  const selectedPreset = contextLabel(contextTokens)
  const selectedModelMax = view.modelContexts?.[model.trim()] ?? view.contextMax
  const contextHint =
    selectedModelMax < 1_000_000
      ? `该模型上限约 ${formatTokens(selectedModelMax)}，更大的档位不可选。`
      : '按这个上限截断回放历史；模型本身的上限更高，超出部分是本地估算。'

  const pickModel = (name: string): void => {
    setModel(name)
    const max = view.modelContexts?.[name.trim()] ?? view.contextMax
    if (contextTokens > max) setContextTokens(max)
  }

  const select = (id: string): void => {
    const next = list.providers.find((p) => p.id === id)
    setSelected(id)
    setModel(next?.model ?? '')
    setBaseUrl(next?.baseUrl ?? '')
    setContextTokens(next?.contextLimit ?? 200_000)
    setDepth(next?.thinkingDepth ?? 'high')
    setSendThinking(next?.sendThinking ?? true)
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
        baseUrl: view.custom ? baseUrl.trim() : undefined,
        contextTokens: fake ? undefined : Math.min(contextTokens, selectedModelMax),
        thinkingDepth: fake ? undefined : depth,
        sendThinking: fake ? undefined : sendThinking
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
        <div className="settings__shell">
          <aside className="settings__nav" aria-label="选择服务商">
            <div className="settings__nav-title">服务商</div>
            {list.providers.map((p) => (
              <button
                key={p.id}
                type="button"
                className="provider-chip provider-chip--row"
                aria-pressed={p.id === view.id}
                onClick={() => select(p.id)}
              >
                <span className={`provider-chip__dot${p.configured ? ' is-on' : ''}`} aria-hidden="true" />
                <span className="provider-chip__name">{p.display}</span>
                {p.configured ? <span className="provider-chip__state">已保存</span> : null}
              </button>
            ))}
            <p className="settings__nav-note">
              预设模型名按官方文档核对于 2026-10；改名后可直接手填模型 ID。
            </p>
          </aside>

          <section className="settings__main">
            <header className="settings__head">
              <h2 className="settings__title" id="settings-title">
                {view.display}
              </h2>
              <p className="settings__sub">
                API Key 只交给主进程，用系统安全存储加密后落盘；渲染层、事件流与日志里都不会出现明文。
              </p>
            </header>

            <div className="settings__body">
              <div className="field">
                <span className="field__label">模型</span>
                <input
                  value={model}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={view.models[0] ?? '模型 ID'}
                  onChange={(event) => pickModel(event.target.value)}
                />
                {view.models.length > 0 ? (
                  <div className="model-presets" role="group" aria-label="预设模型">
                    {view.models.map((name) => (
                      <button
                        key={name}
                        type="button"
                        className="model-chip"
                        aria-pressed={model === name}
                        onClick={() => pickModel(name)}
                      >
                        {name}
                      </button>
                    ))}
                  </div>
                ) : null}
                <span className="field__hint">
                  {view.models.length > 0
                    ? '点一个预设，或直接输入新的模型 ID。'
                    : '这个端点没有预设模型，按服务商文档填写。'}
                </span>
              </div>

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

              {!fake ? (
                <>
                  <div className="field">
                    <span className="field__label">
                      上下文预算
                      <span className="field__badge">{selectedPreset}</span>
                    </span>
                    <div className="seg" role="group" aria-label="上下文预算">
                      {CONTEXT_OPTIONS.map((option) => (
                        <button
                          key={option.label}
                          type="button"
                          className="seg__btn"
                          data-value={option.tokens}
                          aria-pressed={contextTokens === option.tokens}
                          disabled={option.tokens > selectedModelMax}
                          onClick={() => setContextTokens(option.tokens)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <span className="field__hint">{contextHint}</span>
                  </div>

                  <div className="field">
                    <span className="field__label">
                      思维深度
                      <span className="field__badge">{depthLabel(depth)}</span>
                    </span>
                    <div className="seg" role="group" aria-label="思维深度">
                      {DEPTH_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className="seg__btn"
                          data-value={option.value}
                          aria-pressed={depth === option.value}
                          onClick={() => setDepth(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <span className="field__hint">
                      {reasoning?.note ?? '该服务商没有声明思考参数，深度只用于显示。'}
                      {mapping ? ` 映射：${mapping}。` : ''}
                    </span>
                  </div>

                  {view.custom ? (
                    <label className="field field--check">
                      <input
                        type="checkbox"
                        checked={sendThinking}
                        onChange={(event) => setSendThinking(event.target.checked)}
                      />
                      <span>
                        <span className="field__label">发送思考深度参数</span>
                        <span className="field__hint">
                          只在端点支持 OpenAI 的 reasoning_effort 时打开；本地推理服务不认这个字段时请关闭。
                        </span>
                      </span>
                    </label>
                  ) : null}
                </>
              ) : null}

              {view.note ? <p className="settings__note">{view.note}</p> : null}
            </div>

            <div className="settings__foot">
              {error ? <span className="settings__error">{error}</span> : null}
              {!error && view.requiresKey && view.configured ? (
                <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void clearKey()}>
                  清除密钥
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
          </section>
        </div>
      </div>
    </div>
  )
}
