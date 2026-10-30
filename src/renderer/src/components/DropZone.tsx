import type { StagedFile } from '../../../shared/api'
import FileChips from './FileChips'

interface Props {
  files: StagedFile[]
  rejected: string[]
  failure: string | null
  dragging: boolean
  busy: boolean
  onPick: () => void
  onRemove: (file: StagedFile) => void
  onReveal: () => void
}

export default function DropZone({
  files,
  rejected,
  failure,
  dragging,
  busy,
  onPick,
  onRemove,
  onReveal
}: Props) {
  const title = busy ? '正在加入…' : dragging ? '松手即添加' : '把赛题与附件拖到这里'

  return (
    <div className="chat__empty dropzone-area" data-drag={dragging ? 'true' : undefined}>
      <div className="dropzone" data-drag={dragging ? 'true' : undefined} data-busy={busy ? 'true' : undefined}>
        <button
          type="button"
          className="dropzone__hit"
          aria-label="选择赛题或数据文件"
          onClick={onPick}
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
          <div className="dropzone__files">
            <FileChips items={files} onRemove={(index) => onRemove(files[index])} />
          </div>
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
              ? `已暂存 ${files.length} 个文件，发消息时一并交给模型`
              : '文件暂存在本机工作区，发消息时一并交给模型'}
          </span>
          <button type="button" className="dropzone__link" onClick={onReveal}>
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
