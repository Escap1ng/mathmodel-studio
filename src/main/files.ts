import { dialog, shell, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { StagedFile, StageRejection, StageResult } from '../shared/api'
import { attachmentsRoot } from './workspace'

// 拖进来的文件只做暂存：复制到 <工作区>/附件/日期/ 下，解析与发送留给下一步。
// 不直接引用原路径——原文件可能被移动或删除，工作区里要留一份自己的副本。
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_BATCH = 20

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

function rootDir(): string {
  return attachmentsRoot()
}

function dayStamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function uniqueTarget(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length) || 'file'
  let target = join(dir, name)
  for (let i = 2; i <= 999; i++) {
    try {
      await stat(target)
    } catch {
      return target
    }
    target = join(dir, `${stem} (${i})${ext}`)
  }
  throw new Error('同名文件太多')
}

async function stageOne(source: string, dir: string): Promise<StagedFile> {
  if (!isAbsolute(source)) throw new Error('不是绝对路径')
  const info = await stat(source).catch(() => null)
  if (!info) throw new Error('文件不存在或读不到')
  if (!info.isFile()) throw new Error('拖进来的是文件夹')
  if (info.size > MAX_FILE_BYTES) throw new Error('超过 100 MB')
  const name = basename(source)
  if (!name) throw new Error('文件名不可用')
  const target = await uniqueTarget(dir, name)
  await copyFile(source, target)
  const ext = extname(name).slice(1).toLowerCase()
  return {
    id: randomUUID(),
    name,
    size: info.size,
    ext,
    kind: KIND_BY_EXT[ext] ?? 'other',
    path: target
  }
}

export async function stageFiles(paths: unknown): Promise<StageResult> {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('没有收到文件')
  if (paths.length > MAX_BATCH) throw new Error(`一次最多 ${MAX_BATCH} 个文件`)
  const folder = join(rootDir(), dayStamp())
  await mkdir(folder, { recursive: true })

  const files: StagedFile[] = []
  const rejected: StageRejection[] = []
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw) continue
    try {
      files.push(await stageOne(raw, folder))
    } catch (err) {
      rejected.push({
        name: basename(raw),
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return { ok: true, files, rejected, folder }
}

function cleanName(raw: string): string {
  const base = basename(raw).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim()
  return (base || '剪贴板文件').slice(0, 120)
}

// 截图与剪贴板里的文件没有本地路径，只能把字节写进暂存区。
export async function stageBlob(payload: unknown): Promise<StagedFile> {
  if (!payload || typeof payload !== 'object') throw new Error('没有收到文件内容')
  const { name, data } = payload as { name?: unknown; data?: unknown }
  if (typeof name !== 'string' || !name.trim()) throw new Error('缺少文件名')
  const bytes =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : null
  if (!bytes) throw new Error('文件内容类型不对')
  if (bytes.byteLength === 0) throw new Error('文件是空的')
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('超过 100 MB')

  const folder = join(rootDir(), dayStamp())
  await mkdir(folder, { recursive: true })
  const finalName = cleanName(name)
  const target = await uniqueTarget(folder, finalName)
  await writeFile(target, bytes)
  const ext = extname(finalName).slice(1).toLowerCase()
  return {
    id: randomUUID(),
    name: finalName,
    size: bytes.byteLength,
    ext,
    kind: KIND_BY_EXT[ext] ?? 'other',
    path: target
  }
}

export async function pickFiles(win: BrowserWindow | null): Promise<StageResult | null> {
  const options: OpenDialogOptions = {
    title: '选择赛题或数据文件',
    buttonLabel: '加入',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '赛题与数据', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'tsv', 'txt', 'md', 'json', 'png', 'jpg', 'jpeg', 'webp'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  return stageFiles(result.filePaths)
}

// 只允许删除暂存目录里的副本；原文件不归应用管，绝不碰。
export async function discardStaged(path: unknown): Promise<void> {
  if (typeof path !== 'string' || !path) throw new Error('缺少文件路径')
  const root = resolve(rootDir())
  const target = resolve(path)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能移除暂存目录里的副本')
  await unlink(target).catch(() => undefined)
}

export async function revealStaged(): Promise<void> {
  const folder = rootDir()
  await mkdir(folder, { recursive: true })
  const error = await shell.openPath(folder)
  if (error) throw new Error(error)
}
