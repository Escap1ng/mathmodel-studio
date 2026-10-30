import { useEffect, useState } from 'react'
import type { FileKind, WorkspaceEntry, WorkspaceListing } from '../../../shared/api'

const KIND_LABEL: Record<FileKind, string> = {
  dir: 'DIR',
  pdf: 'PDF',
  doc: 'DOC',
  sheet: 'XLS',
  image: 'IMG',
  text: 'TXT',
  other: 'FILE'
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function FilesPanel() {
  const [listing, setListing] = useState<WorkspaceListing | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setListing(await window.studio.workspace.get())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void load()
    // 中栏拖入/移除文件后自动刷新；面板没打开时组件未挂载，切过来会重新载入。
    const onChanged = (): void => {
      void load()
    }
    window.addEventListener('mms:workspace-changed', onChanged)
    return () => window.removeEventListener('mms:workspace-changed', onChanged)
  }, [])

  const choose = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.studio.workspace.choose()
      if (next) setListing(next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const reset = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setListing(await window.studio.workspace.reset())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const reveal = (): void => {
    void window.studio.workspace.reveal().catch((err: unknown) => setError(errorText(err)))
  }

  const open = (entry: WorkspaceEntry): void => {
    void window.studio.workspace.open(entry.rel).catch((err: unknown) => setError(errorText(err)))
  }

  const files = listing ? listing.entries.filter((entry) => entry.kind !== 'dir').length : 0
  const dirs = listing ? listing.entries.length - files : 0

  return (
    <div className="panel" data-panel="files">
      <div className="panel__head">
        <div>
          <div className="panel__kicker">工作台 · 文件</div>
          <h2 className="panel__title">工作区</h2>
        </div>
        <span className="panel__meta">
          {listing ? `${files} 个文件${dirs > 0 ? ` · ${dirs} 个文件夹` : ''} · ${formatSize(listing.totalSize)}` : ''}
        </span>
      </div>

      <div className="files__path">
        <code title={listing?.info.path ?? ''}>{listing?.info.path ?? '正在读取…'}</code>
        {listing?.info.isDefault ? (
          <span className="files__tag">默认</span>
        ) : (
          <button type="button" className="files__link" onClick={() => void reset()} disabled={busy}>
            恢复默认
          </button>
        )}
      </div>

      <p className="files__hint">
        拖进中栏的文件会复制到 <code>附件/日期/</code> 下；这里也会列出你直接放进工作区的文件。
      </p>

      <div className="files__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void load()} disabled={busy}>
          刷新
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void choose()} disabled={busy}>
          更改工作区…
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={reveal}>
          打开文件夹
        </button>
      </div>

      {error ? (
        <div className="panel__error" role="alert">
          {error}
        </div>
      ) : null}

      {!listing && !error ? <div className="card">正在读取工作区…</div> : null}

      {listing && listing.entries.length === 0 ? (
        <div className="panel__empty">
          <p>
            <strong>工作区还是空的</strong>
          </p>
          <ol className="empty-steps">
            <li>把赛题或数据文件拖进中栏大框</li>
            <li>副本会存到工作区的「附件/日期」文件夹</li>
            <li>也可以直接把自己的文件放进工作区</li>
          </ol>
          <button type="button" className="btn btn--ghost btn--sm" onClick={reveal}>
            打开文件夹
          </button>
        </div>
      ) : null}

      {listing && listing.entries.length > 0 ? (
        <ul className="files__list">
          {listing.entries.map((entry) => (
            <li key={entry.rel}>
              <button type="button" className="file-row" title={entry.rel} onClick={() => open(entry)}>
                <span className="file-row__kind" data-kind={entry.kind}>
                  {KIND_LABEL[entry.kind]}
                </span>
                <span className="file-row__main">
                  <span className="file-row__name">{entry.name}</span>
                  {entry.dir ? <span className="file-row__dir">{entry.dir}</span> : null}
                </span>
                <span className="file-row__size">
                  {entry.kind === 'dir' ? '文件夹' : formatSize(entry.size)}
                </span>
                <span className="file-row__time">
                  {entry.kind === 'dir' ? '' : formatTime(entry.mtime)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {listing?.truncated ? <p className="files__note">只列出前 400 项，其余请在文件夹里查看。</p> : null}
    </div>
  )
}
