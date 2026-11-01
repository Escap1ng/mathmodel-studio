import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AttachmentBlock, AttachmentContext, StagedFile } from '../shared/api'
import { workspacePath } from './workspace'
import { extractXlsx } from './xlsx'

// 附件正文抽取：发送前把用户选中的文件读成文本，连同消息交给模型。
// 只读工作区里的文件（含 附件/ 下的暂存副本）；读不了的文件不报错，而是带一条说明，让模型知道有这个文件、为什么没正文。
const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_FILE_CHARS = 20_000
const MAX_TOTAL_CHARS = 60_000
const MAX_PDF_PAGES = 30

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'tex', 'py', 'm', 'r', 'jl',
  'ipynb', 'yaml', 'yml', 'xml', 'html', 'sql'
])
const UNSUPPORTED: Record<string, string> = {
  doc: 'Word 文档暂不解析，可另存为 PDF 或直接粘贴正文',
  docx: 'Word 文档暂不解析，可另存为 PDF 或直接粘贴正文',
  xls: '旧版 .xls 暂不解析，可另存为 .xlsx 或 CSV',
  pages: 'Pages 文档暂不解析，可另存为 PDF',
  zip: '压缩包不解析，请解压后拖入具体文件'
}

const require = createRequire(__filename)
let pdfjsPromise: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null

function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjsPromise
}

function standardFonts(): string | undefined {
  try {
    const dir = join(dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')
    // pdfjs 要求这个前缀以斜杠结尾；Windows 路径要换成正斜杠。
    return `${dir.replace(/\\/g, '/')}/`
  } catch {
    return undefined
  }
}

function decodeText(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8')
  }
  const utf8 = bytes.toString('utf8')
  // 中文数据表常是 GBK；UTF-8 解出大量替换符时再按 GBK 试一次。
  const bad = (utf8.match(/\uFFFD/g) ?? []).length
  if (bad > Math.max(8, utf8.length * 0.02)) {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      return utf8
    }
  }
  return utf8
}

function clip(text: string, limit: number): { text: string; clipped: boolean } {
  if (text.length <= limit) return { text, clipped: false }
  return { text: text.slice(0, limit), clipped: true }
}

function tableShape(text: string, delimiter: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) return '空表'
  const cols = lines[0].split(delimiter).length
  return `${Math.max(0, lines.length - 1)} 行 × ${cols} 列`
}

async function extractPdf(bytes: Buffer): Promise<{ text: string; note: string }> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    standardFontDataUrl: standardFonts(),
    useSystemFonts: true
  }).promise
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES)
    const chunks: string[] = []
    for (let index = 1; index <= pages; index++) {
      const page = await doc.getPage(index)
      const content = await page.getTextContent()
      const line = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
      if (line) chunks.push(line)
    }
    const more = doc.numPages > pages ? `，只取前 ${pages} 页` : ''
    return { text: chunks.join('\n\n'), note: `${doc.numPages} 页${more}` }
  } finally {
    await Promise.resolve((doc as unknown as { destroy?: () => Promise<void> }).destroy?.()).catch(
      () => undefined
    )
  }
}

async function extractOne(path: string): Promise<AttachmentBlock> {
  const name = basename(path)
  const ext = extname(name).slice(1).toLowerCase()
  const kind: StagedFile['kind'] =
    ext === 'pdf' ? 'pdf'
      : ['doc', 'docx', 'pages', 'rtf'].includes(ext) ? 'doc'
        : ['xls', 'xlsx', 'csv', 'tsv'].includes(ext) ? 'sheet'
          : TEXT_EXT.has(ext) ? 'text'
            : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext) ? 'image'
              : 'other'

  const info = await stat(path).catch(() => null)
  if (!info || !info.isFile()) return { name, kind, text: '', note: '文件不在了' }
  if (info.size > MAX_FILE_BYTES) {
    return { name, kind, text: '', note: `超过 ${MAX_FILE_BYTES / 1024 / 1024} MB，未解析` }
  }

  if (ext === 'pdf') {
    try {
      const bytes = await readFile(path)
      const { text, note } = await extractPdf(bytes)
      const clipped = clip(text, MAX_FILE_CHARS)
      return { name, kind, text: clipped.text, note: clipped.clipped ? `${note}，正文已截断` : note }
    } catch (err) {
      return {
        name,
        kind,
        text: '',
        note: `PDF 解析失败：${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  if (ext === 'xlsx') {
    try {
      const bytes = await readFile(path)
      const { text, note } = extractXlsx(bytes)
      const clipped = clip(text, MAX_FILE_CHARS)
      return { name, kind, text: clipped.text, note: clipped.clipped ? `${note}，正文已截断` : note }
    } catch (err) {
      return {
        name,
        kind,
        text: '',
        note: `Excel 解析失败：${err instanceof Error ? err.message : String(err)}`
      }
    }
  }

  if (UNSUPPORTED[ext]) return { name, kind, text: '', note: UNSUPPORTED[ext] }
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif') {
    return { name, kind, text: '', note: '图片未解析' }
  }
  if (!TEXT_EXT.has(ext)) return { name, kind, text: '', note: '这类文件暂不解析，只登记文件名' }

  try {
    const bytes = await readFile(path)
    const raw = decodeText(bytes)
    const shape = ext === 'csv' || ext === 'tsv' ? tableShape(raw, ext === 'csv' ? ',' : '\t') : ''
    const clipped = clip(raw, MAX_FILE_CHARS)
    const note = [shape, clipped.clipped ? '正文已截断' : ''].filter(Boolean).join('，')
    return { name, kind, text: clipped.text, note: note || undefined }
  } catch (err) {
    return { name, kind, text: '', note: `读取失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

export async function attachmentContext(paths: unknown): Promise<AttachmentContext> {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('没有附件')
  if (paths.length > 20) throw new Error('一次最多 20 个附件')
  const root = resolve(workspacePath())
  const blocks: AttachmentBlock[] = []
  let total = 0
  let truncated = false
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw) continue
    const target = resolve(raw)
    const inside = relative(root, target)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
      throw new Error('只能读取工作区里的文件')
    }
    const block = await extractOne(target)
    const room = Math.max(0, MAX_TOTAL_CHARS - total)
    if (block.text.length > room) {
      block.text = block.text.slice(0, room)
      truncated = true
    }
    total += block.text.length
    blocks.push(block)
  }
  if (blocks.length === 0) throw new Error('没有可读取的附件')
  return { ok: true, blocks, truncated }
}
