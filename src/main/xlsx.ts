import { inflateRawSync } from 'node:zlib'

// xlsx 是一个装着 XML 的 ZIP。这里不引第三方表格库，只按中央目录解压出需要的几个部件，
// 再把单元格读成「工作表名 + TSV」交给模型；公式只取缓存值，样式只用来判断日期。
const MAX_SHEETS = 10
const MAX_ROWS = 300
const MAX_COLS = 60
const MAX_CELL_CHARS = 1000
const MAX_PART_BYTES = 32 * 1024 * 1024

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

interface ZipEntry {
  method: number
  compressed: number
  size: number
  offset: number
}

interface CellFormat {
  id: number
  code?: string
}

interface Styles {
  formats: Map<number, string>
  xf: number[]
}

interface SheetResult {
  name: string
  rows: string[][]
  truncatedRows: boolean
  truncatedCols: boolean
  truncatedCell: boolean
}

export interface XlsxText {
  text: string
  note: string
}

function listZip(bytes: Buffer): Map<string, ZipEntry> {
  let eocd = -1
  const stop = Math.max(0, bytes.length - 22 - 0xffff)
  for (let at = bytes.length - 22; at >= stop; at--) {
    if (bytes.readUInt32LE(at) === EOCD_SIG) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（缺少压缩目录）')

  const total = bytes.readUInt16LE(eocd + 10)
  const offset = bytes.readUInt32LE(eocd + 16)
  if (total === 0xffff || offset === 0xffffffff) throw new Error('暂不支持 ZIP64 格式的 xlsx')

  const entries = new Map<string, ZipEntry>()
  let at = offset
  for (let index = 0; index < total; index++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_SIG) {
      throw new Error('xlsx 的压缩目录已损坏')
    }
    const nameLength = bytes.readUInt16LE(at + 28)
    const extraLength = bytes.readUInt16LE(at + 30)
    const commentLength = bytes.readUInt16LE(at + 32)
    const name = bytes.toString('utf8', at + 46, at + 46 + nameLength)
    entries.set(name, {
      method: bytes.readUInt16LE(at + 10),
      compressed: bytes.readUInt32LE(at + 20),
      size: bytes.readUInt32LE(at + 24),
      offset: bytes.readUInt32LE(at + 42)
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function readPart(bytes: Buffer, entries: Map<string, ZipEntry>, name: string): string | null {
  const entry = entries.get(name)
  if (!entry) return null
  if (entry.size > MAX_PART_BYTES) throw new Error(`xlsx 内部文件过大：${name}`)
  const header = entry.offset
  if (header + 30 > bytes.length || bytes.readUInt32LE(header) !== LOCAL_SIG) {
    throw new Error('xlsx 条目已损坏')
  }
  const start =
    header + 30 + bytes.readUInt16LE(header + 26) + bytes.readUInt16LE(header + 28)
  const raw = bytes.subarray(start, start + entry.compressed)
  if (entry.method === 0) return raw.toString('utf8')
  if (entry.method === 8) {
    return inflateRawSync(raw, { maxOutputLength: MAX_PART_BYTES }).toString('utf8')
  }
  throw new Error(`不支持的压缩方式 ${entry.method}`)
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    if (body === 'lt') return '<'
    if (body === 'gt') return '>'
    if (body === 'quot') return '"'
    if (body === 'apos') return "'"
    return '&'
  })
}

function attr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  if (!match) return undefined
  return decodeXml(match[1] ?? match[2] ?? '')
}

function readSharedStrings(xml: string | null): string[] {
  if (!xml) return []
  const out: string[] = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    const body = (match[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
    const parts: string[] = []
    for (const text of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) parts.push(decodeXml(text[1]))
    out.push(parts.join(''))
  }
  return out
}

function readStyles(xml: string | null): Styles {
  const formats = new Map<number, string>()
  const xf: number[] = []
  if (!xml) return { formats, xf }
  for (const match of xml.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    const id = Number(attr(match[0], 'numFmtId'))
    const code = attr(match[0], 'formatCode')
    if (Number.isFinite(id) && code) formats.set(id, code)
  }
  const section = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)
  if (section) {
    for (const match of section[1].matchAll(/<xf\b[^>]*\/?>/g)) {
      xf.push(Number(attr(match[0], 'numFmtId') ?? '0'))
    }
  }
  return { formats, xf }
}

function formatAt(styles: Styles, index: number | undefined): CellFormat | undefined {
  if (index == null || !Number.isInteger(index)) return undefined
  const id = styles.xf[index]
  if (id == null) return undefined
  return { id, code: styles.formats.get(id) }
}

const DATE_FORMAT_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47])
const TIME_FORMAT_IDS = new Set([18, 19, 20, 21, 45, 46, 47])

function stripLiterals(code: string): string {
  return code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?![hms])[^\]]*\]/gi, '')
}

function isDateFormat(format: CellFormat | undefined): boolean {
  if (!format) return false
  if (DATE_FORMAT_IDS.has(format.id)) return true
  if (!format.code) return false
  const code = stripLiterals(format.code)
  return /[ymdhs]/i.test(code) || /\[[hms]+\]/i.test(format.code)
}

function isTimeFormat(format: CellFormat | undefined): boolean {
  if (!format) return false
  if (TIME_FORMAT_IDS.has(format.id)) return true
  if (!format.code) return false
  const code = stripLiterals(format.code)
  return /[hs]/i.test(code) && !/[yd]/i.test(code)
}

function hasClock(format: CellFormat | undefined): boolean {
  if (!format) return false
  if (TIME_FORMAT_IDS.has(format.id)) return true
  if (!format.code) return false
  return /[hs]/i.test(stripLiterals(format.code))
}

// Excel 的日期是 1900 或 1904 起算的序列号，小数部分是一天内的时刻。
function serialText(
  serial: number,
  kind: 'date' | 'time' | 'datetime',
  date1904: boolean
): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958466) return null
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const date = new Date(base + Math.round(serial * 86400) * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  if (kind === 'time') return clock
  if (kind === 'datetime') return `${day} ${clock}`
  return day
}

function columnIndex(ref: string | undefined, fallback: number): number {
  const letters = ref ? /^[A-Za-z]+/.exec(ref)?.[0] : undefined
  if (!letters) return fallback
  let index = 0
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64)
  }
  return index - 1
}

function cleanCell(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[\t\r\n]+/g, ' ')
    .trim()
}

function cellText(
  attrs: string,
  body: string,
  type: string | undefined,
  shared: string[],
  styles: Styles,
  date1904: boolean
): { value: string; clipped: boolean } {
  if (type === 'inlineStr') {
    const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? ''
    const parts: string[] = []
    for (const text of inline.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      parts.push(decodeXml(text[1]))
    }
    const value = cleanCell(parts.join(''))
    return { value: value.slice(0, MAX_CELL_CHARS), clipped: value.length > MAX_CELL_CHARS }
  }

  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
  if (raw == null) return { value: '', clipped: false }
  const text = decodeXml(raw)

  if (type === 's') {
    const value = cleanCell(shared[Number(text)] ?? '')
    return { value: value.slice(0, MAX_CELL_CHARS), clipped: value.length > MAX_CELL_CHARS }
  }
  if (type === 'b') return { value: text === '1' ? 'TRUE' : 'FALSE', clipped: false }
  if (type === 'str' || type === 'e') {
    const value = cleanCell(text)
    return { value: value.slice(0, MAX_CELL_CHARS), clipped: value.length > MAX_CELL_CHARS }
  }

  const style = formatAt(styles, Number(attr(attrs, 's')))
  if (isDateFormat(style)) {
    const kind = isTimeFormat(style) ? 'time' : hasClock(style) ? 'datetime' : 'date'
    const date = serialText(Number(text), kind, date1904)
    if (date) return { value: date, clipped: false }
  }
  return { value: cleanCell(text), clipped: false }
}

function readSheet(
  name: string,
  xml: string,
  shared: string[],
  styles: Styles,
  date1904: boolean
): SheetResult {
  const rows: string[][] = []
  let truncatedRows = false
  let truncatedCols = false
  let truncatedCell = false

  for (const rowMatch of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    if (rows.length >= MAX_ROWS) {
      truncatedRows = true
      break
    }
    const body = rowMatch[2] ?? ''
    const cells: string[] = []
    let nextColumn = 0
    for (const cellMatch of body.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1]
      const column = columnIndex(attr(attrs, 'r'), nextColumn)
      if (column > MAX_COLS) {
        truncatedCols = true
        break
      }
      nextColumn = column + 1
      const cell = cellText(
        attrs,
        cellMatch[2] ?? '',
        attr(attrs, 't'),
        shared,
        styles,
        date1904
      )
      if (cell.clipped) truncatedCell = true
      while (cells.length < column) cells.push('')
      cells[column] = cell.value
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
    if (cells.length > 0) rows.push(cells)
  }

  return { name, rows, truncatedRows, truncatedCols, truncatedCell }
}

interface SheetRef {
  name: string
  path: string
}

function resolvePart(target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function sheetRefs(workbookXml: string, relsXml: string | null, entries: Map<string, ZipEntry>): SheetRef[] {
  const rels = new Map<string, { target: string; type?: string }>()
  if (relsXml) {
    for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
      const id = attr(match[0], 'Id')
      const target = attr(match[0], 'Target')
      if (id && target && attr(match[0], 'TargetMode') !== 'External') {
        rels.set(id, { target: resolvePart(target), type: attr(match[0], 'Type') })
      }
    }
  }

  const refs: SheetRef[] = []
  let fallback = 0
  for (const match of workbookXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(match[0], 'name') ?? `工作表 ${refs.length + 1}`
    const rid = attr(match[0], 'r:id')
    const rel = rid ? rels.get(rid) : undefined
    if (rel) {
      // 图表页等非 worksheet 部件没有单元格，跳过而不是记成空表。
      if (rel.type?.endsWith('/worksheet') && entries.has(rel.target)) {
        refs.push({ name, path: rel.target })
      }
      continue
    }
    fallback += 1
    const path = `xl/worksheets/sheet${fallback}.xml`
    if (entries.has(path)) refs.push({ name, path })
  }
  return refs
}

function widthOf(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0)
}

export function extractXlsx(bytes: Buffer): XlsxText {
  const entries = listZip(bytes)
  const workbookXml = readPart(bytes, entries, 'xl/workbook.xml')
  if (!workbookXml) throw new Error('不是有效的 xlsx（缺少工作簿）')

  const shared = readSharedStrings(readPart(bytes, entries, 'xl/sharedStrings.xml'))
  const styles = readStyles(readPart(bytes, entries, 'xl/styles.xml'))
  const relsXml = readPart(bytes, entries, 'xl/_rels/workbook.xml.rels')
  const date1904 = /^(1|true)$/i.test(attr(/<workbookPr\b[^>]*\/?>/.exec(workbookXml)?.[0] ?? '', 'date1904') ?? '')

  const refs = sheetRefs(workbookXml, relsXml, entries)
  if (refs.length === 0) throw new Error('工作簿里没有可读的工作表')

  const picked = refs.slice(0, MAX_SHEETS)
  const results: SheetResult[] = []
  for (const ref of picked) {
    const xml = readPart(bytes, entries, ref.path)
    if (xml == null) continue
    results.push(readSheet(ref.name, xml, shared, styles, date1904))
  }
  if (results.length === 0) throw new Error('工作簿里没有可读的工作表')

  const sections = results.map((sheet) => {
    const rows = sheet.rows.length
    const cols = widthOf(sheet.rows)
    const head = `[工作表 ${sheet.name}] ${rows > 0 ? `${rows} 行 × ${cols} 列` : '空表'}`
    if (rows === 0) return head
    return `${head}\n${sheet.rows.map((row) => row.join('\t')).join('\n')}`
  })

  const summaries = results.map((sheet) => {
    const rows = sheet.rows.length
    return rows > 0 ? `${sheet.name} ${rows} 行 × ${widthOf(sheet.rows)} 列` : `${sheet.name} 空表`
  })
  if (refs.length > picked.length) summaries.push(`其余 ${refs.length - picked.length} 个工作表未读`)

  const limits: string[] = []
  if (results.some((sheet) => sheet.truncatedRows)) limits.push(`每个工作表最多 ${MAX_ROWS} 行`)
  if (results.some((sheet) => sheet.truncatedCols)) limits.push(`最多 ${MAX_COLS} 列`)
  if (results.some((sheet) => sheet.truncatedCell)) limits.push(`单元格超过 ${MAX_CELL_CHARS} 字已截断`)

  const note = [`${refs.length} 个工作表`, summaries.join('、'), ...limits].join('；')
  return { text: sections.join('\n\n'), note }
}
