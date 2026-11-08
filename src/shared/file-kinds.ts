import type { FileKind } from './api'

/** 扩展名 → 文件类别；主进程暂存/工作区列表与渲染层拖拽共用同一张表。 */
export const KIND_BY_EXT: Record<string, Exclude<FileKind, 'dir'>> = {
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
