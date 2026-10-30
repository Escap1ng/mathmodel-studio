import { useRef, useState } from 'react'
import type { DragEvent } from 'react'
import type { StagedFile, StageResult } from '../../../shared/api'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function kindLabel(file: StagedFile): string {
  return (file.ext || 'file').toUpperCase().slice(0, 4)
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function DropZone() {
  const [files, setFiles] = useState<StagedFile[]>([])
  const [rejected, setRejected] = useState<string[]>([])
  const [failure, setFailure] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const merge = (result: StageResult): void => {
    setFiles((prev) => {
      const seen = new Set(prev.map((file) => file.path))
      return [...prev, ...result.files.filter((file) => !seen.has(file.path))]
    })
    setRejected(result.rejected.map((item) => `${item.name}：${item.reason}`))
    setFailure(null)
    if (result.files.length > 0) window.dispatchEvent(new Event('mms:workspace-changed'))
  }

  const addPaths = async (paths: string[]): Promise<void> => {
    if (paths.length === 0 || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      merge(await window.studio.files.stage(paths))
    } catch (err) {
      setFailure(errorText(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const pick = async (): Promise<void> => {
    if (busyRef.current) return
    try {
      const result = await window.studio.files.pick()
      if (result) merge(result)
    } catch (err) {
      setFailure(errorText(err))
    }
  }

  const onDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDragging(true)
  }

  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return
    const next = event.relatedTarget as Node | null
    if (next && event.currentTarget.contains(next)) return
    setDragging(false)
  }

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    if (!hasFiles(event)) return
    event.preventDefault()
    setDragging(false)
    const dropped = Array.from(event.dataTransfer.files)
    const paths: string[] = []
    const names: string[] = []
    for (const file of dropped) {
      let path = ''
      try {
        path = window.studio.files.pathFor(file)
      } catch {
        path = ''
      }
      if (path) paths.push(path)
      else names.push(`${file.name}：读不到本地路径`)
    }
    if (names.length > 0) {
      setRejected(names)
      setFailure(null)
    }
    void addPaths(paths)
  }

  const remove = (file: StagedFile): void => {
    setFiles((prev) => prev.filter((item) => item.id !== file.id))
    void window.studio.files.discard(file.path).then(
      () => window.dispatchEvent(new Event('mms:workspace-changed')),
      () => undefined
    )
  }

  const reveal = (): void => {
    void window.studio.files.reveal().catch((err: unknown) => setFailure(errorText(err)))
  }

  const title = busy ? '正在加入…' : dragging ? '松手即添加' : '把赛题与附件拖到这里'

  return (
    <div
      className="chat__empty dropzone-area"
      data-drag={dragging ? 'true' : undefined}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="dropzone" data-drag={dragging ? 'true' : undefined} data-busy={busy ? 'true' : undefined}>
        <button
          type="button"
          className="dropzone__hit"
          aria-label="选择赛题或数据文件"
          onClick={() => void pick()}
        />
        <span className="dropzone__plus" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26">
            <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </span>
        <p className="dropzone__title">{title}</p>
        <p className="dropzone__hint">PDF · Word · Excel · CSV · 图片 · 文本，可一次多个</p>
        <p className="dropzone__sub">点击选择文件，也可以直接拖到这一列任意位置</p>
        {files.length > 0 ? (
          <ul className="dropzone__files" aria-label="已暂存的文件">
            {files.map((file) => (
              <li className="file-chip" key={file.id}>
                <span className="file-chip__kind">{kindLabel(file)}</span>
                <span className="file-chip__name" title={file.name}>
                  {file.name}
                </span>
                <span className="file-chip__size">{formatSize(file.size)}</span>
                <button
                  type="button"
                  className="file-chip__remove"
                  aria-label={`移除 ${file.name}`}
                  onClick={() => remove(file)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {rejected.length > 0 ? (
          <p className="dropzone__reject" role="alert">
            {rejected.length === 1 ? rejected[0] : `${rejected.length} 个文件没加进来：${rejected.join('；')}`}
          </p>
        ) : null}
        {failure ? (
          <p className="dropzone__reject" role="alert">
            {failure}
          </p>
        ) : null}
        <div className="dropzone__foot">
          <span aria-live="polite">
            {files.length > 0
              ? `已暂存 ${files.length} 个文件，暂不参与对话`
              : '文件暂存在本机工作区，暂不参与对话'}
          </span>
          <button type="button" className="dropzone__link" onClick={reveal}>
            打开文件夹
          </button>
        </div>
      </div>
      <p className="chat__empty-note">
        对话流、选模卡、门禁结果与评分明细都会出现在这一列；右侧工作台放图、论文、代码与日志。
      </p>
    </div>
  )
}
