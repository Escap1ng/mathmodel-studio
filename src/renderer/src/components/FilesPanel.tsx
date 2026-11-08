import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import type {
  FileKind,
  WorkspaceEntry,
  WorkspaceListing,
  WorkspaceProject
} from '../../../shared/api'
import { WORKSPACE_DRAG } from '../lib/attachments'
import ContextMenu, { type ContextMenuItem } from './ContextMenu'

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

export default function FilesPanel({ projectId }: { projectId: string | null }) {
  const [listing, setListing] = useState<WorkspaceListing | null>(null)
  const [project, setProject] = useState<WorkspaceProject | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: WorkspaceEntry } | null>(null)
  // 删除先点一次变「确认」，再点才真的移到回收站，避免右键一路点到底误删。
  const [armed, setArmed] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const flashTimer = useRef<number | null>(null)
  // 建模会话默认只看当前赛题：项目目录大起来后整棵工作区容易撞 400 项截断。
  const [onlyProject, setOnlyProject] = useState(true)
  const scoped = Boolean(projectId) && onlyProject

  const load = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setListing(await window.studio.workspace.get(scoped ? (projectId ?? undefined) : undefined))
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
  }, [projectId, onlyProject])

  useEffect(
    () => () => {
      if (flashTimer.current != null) window.clearTimeout(flashTimer.current)
    },
    []
  )

  useEffect(() => {
    let alive = true
    if (!projectId) {
      setProject(null)
      return
    }
    window.studio.workspace.project(projectId).then(
      (info) => {
        if (alive) setProject(info)
      },
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [projectId])

  const notify = (text: string): void => {
    setFlash(text)
    if (flashTimer.current != null) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(null), 2200)
  }

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

  const attach = (entry: WorkspaceEntry): void => {
    window.dispatchEvent(new CustomEvent('mms:attach-workspace', { detail: { rels: [entry.rel] } }))
    notify(`已加入对话：${entry.name}`)
  }

  const startDrag = (event: ReactDragEvent<HTMLButtonElement>, entry: WorkspaceEntry): void => {
    if (entry.kind === 'dir') {
      event.preventDefault()
      return
    }
    event.dataTransfer.setData(WORKSPACE_DRAG, JSON.stringify([entry.rel]))
    event.dataTransfer.effectAllowed = 'copy'
  }

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const items: ContextMenuItem[] = []
    if (menu.entry.kind !== 'dir') items.push({ id: 'attach', label: '添加到对话' })
    items.push(
      { id: 'open', label: '打开' },
      { id: 'reveal', label: '在文件夹中显示' },
      { id: 'copy', label: '复制路径' },
      { id: 'trash', label: armed ? '确认移到回收站' : '移到回收站', danger: true }
    )
    return items
  }, [menu, armed])

  const runMenu = (id: string): void => {
    const entry = menu?.entry
    if (!entry) return
    if (id === 'trash' && !armed) {
      setArmed(true)
      return
    }
    setMenu(null)
    if (id === 'attach') {
      attach(entry)
    } else if (id === 'open') {
      open(entry)
    } else if (id === 'reveal') {
      void window.studio.workspace
        .revealEntry(entry.rel)
        .catch((err: unknown) => setError(errorText(err)))
    } else if (id === 'copy') {
      void window.studio.workspace.copyPath(entry.rel).then(
        () => notify('路径已复制'),
        (err: unknown) => setError(errorText(err))
      )
    } else if (id === 'trash') {
      void window.studio.workspace.trash(entry.rel).then(
        () => {
          notify(`已移到回收站：${entry.name}`)
          void load()
        },
        (err: unknown) => setError(errorText(err))
      )
    }
  }

  const files = listing ? listing.entries.filter((entry) => entry.kind !== 'dir').length : 0
  const dirs = listing ? listing.entries.length - files : 0

  return (
    <div className="panel" data-panel="files">
      <div className="panel__bar">
        <span className="panel__meta">
          {listing ? `${files} 个文件${dirs > 0 ? ` · ${dirs} 个文件夹` : ''} · ${formatSize(listing.totalSize)}` : ''}
        </span>
        {project ? (
          <button
            type="button"
            className="files__scope"
            data-action="files-scope"
            data-on={scoped ? 'true' : 'false'}
            aria-pressed={scoped}
            title={scoped ? '切换到整个工作区' : '只看当前赛题文件夹'}
            onClick={() => setOnlyProject((value) => !value)}
          >
            仅看当前赛题
          </button>
        ) : null}
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

      {project ? (
        <div className="files__project" data-role="files-project">
          <span className="files__tag">当前赛题</span>
          <code title={project.path}>{project.name}</code>
          <button
            type="button"
            className="files__link"
            data-action="open-project"
            onClick={() => {
              if (projectId) {
                void window.studio.workspace
                  .openProject(projectId)
                  .catch((err: unknown) => setError(errorText(err)))
              }
            }}
          >
            打开项目文件夹
          </button>
        </div>
      ) : null}

      <p className="files__hint">
        拖进中栏的文件会复制到 <code>附件/日期/</code> 下；这里也会列出你直接放进工作区的文件。拖动条目到中栏可直接发给模型，右键还有更多操作。
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

      {flash ? (
        <p className="files__note" role="status">
          {flash}
        </p>
      ) : null}

      {!listing && !error ? <div className="card">正在读取工作区…</div> : null}

      {listing && listing.entries.length === 0 ? (
        <div className="panel__empty">
          <p>
            <strong>{scoped ? '当前赛题文件夹还是空的' : '工作区还是空的'}</strong>
          </p>
          <ol className="empty-steps">
            <li>把赛题或数据文件拖进中栏大框</li>
            <li>副本会存到工作区的「附件/日期」文件夹</li>
            <li>{scoped ? '建模产物与附件会陆续收进当前赛题文件夹' : '也可以直接把自己的文件放进工作区'}</li>
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
              <button
                type="button"
                className="file-row"
                title={`${entry.rel}${entry.kind === 'dir' ? '' : ' · 拖到中栏可发送'}`}
                draggable={entry.kind !== 'dir'}
                data-kind-row={entry.kind}
                data-menu={menu?.entry.rel === entry.rel ? 'true' : undefined}
                onDragStart={(event) => startDrag(event, entry)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setArmed(false)
                  setMenu({ x: event.clientX, y: event.clientY, entry })
                }}
                onClick={() => open(entry)}
              >
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

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onSelect={runMenu}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
