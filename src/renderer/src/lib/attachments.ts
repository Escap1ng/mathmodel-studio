import type { AttachmentBlock, StagedFile } from '../../../shared/api'
import { formatBytes } from './format'

export interface AttachmentRef {
  name: string
  kind: StagedFile['kind']
  size?: number
}

/** 发送时附带的上下文：context 给模型，attachments 只给界面显示与恢复。 */
export interface SendExtras {
  context?: string
  attachments?: AttachmentRef[]
}

// 送进模型的消息里，附件正文用一对固定标记包起来：
// 界面显示只用标记前的手打文字，重启恢复时再按标记剥掉正文、还原胶囊。
export const ATTACH_START = '--- 附件（本机文件）---'
export const ATTACH_END = '--- 附件结束 ---'

/** 文件页把工作区条目拖到中栏时用的私有类型，避免和系统文件拖拽混在一起。 */
export const WORKSPACE_DRAG = 'application/x-mms-workspace-files'

const KIND_BY_EXT: Record<string, StagedFile['kind']> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  pages: 'doc',
  rtf: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  txt: 'text',
  md: 'text',
  json: 'text',
  log: 'text',
  tex: 'text',
  py: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  bmp: 'image',
  svg: 'image'
}

export function kindOfName(name: string): StagedFile['kind'] {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  return KIND_BY_EXT[ext] ?? 'other'
}

export function buildContextText(text: string, blocks: AttachmentBlock[], files: StagedFile[]): string {
  const parts: string[] = []
  if (text.trim()) parts.push(text.trim())
  const body = blocks
    .map((block, index) => {
      const file = files[index]
      const size = file ? ` · ${formatBytes(file.size)}` : ''
      const note = block.note ? `（${block.note}）` : ''
      return `### ${block.name}${size}${note}\n${block.text || '（无正文）'}`
    })
    .join('\n\n')
  return [...parts, ATTACH_START, body, ATTACH_END].join('\n\n')
}

// 只认我们自己写出的块标题（带体积），避免把附件正文里的 Markdown 标题误判成新附件。
const HEADER = /^### (.+?) · [\d.]+ (?:B|KB|MB)(?:（.*）)?$/

export function splitContextContent(content: string): {
  display: string
  attachments: AttachmentRef[]
} {
  const start = content.indexOf(ATTACH_START)
  if (start < 0) return { display: content.trim(), attachments: [] }
  const display = content.slice(0, start).trim()
  const end = content.indexOf(ATTACH_END, start + ATTACH_START.length)
  const body = content.slice(start + ATTACH_START.length, end < 0 ? content.length : end)
  const attachments: AttachmentRef[] = []
  for (const line of body.split('\n')) {
    const match = HEADER.exec(line.trim())
    if (match) attachments.push({ name: match[1], kind: kindOfName(match[1]) })
  }
  return { display, attachments }
}
