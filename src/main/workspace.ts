import { app, dialog, shell, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { WorkspaceEntry, WorkspaceInfo, WorkspaceListing } from '../shared/api'
import { saveWorkspace, savedWorkspace } from './settings'

// 工作区是用户看得见、放得进自己文件的地方：默认在桌面建「赛题」，可在文件页改到别处。
// 附件副本统一落在 <工作区>/附件/日期/，不再藏进 userData。
const MAX_ENTRIES = 400
const MAX_DEPTH = 3
const KIND_BY_EXT: Record<string, Exclude<WorkspaceEntry['kind'], 'dir'>> = {
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

export function defaultWorkspace(): string {
  return join(app.getPath('desktop'), '赛题')
}

export function workspacePath(): string {
  // MMS_WORKSPACE 只给自动化测试用，避免冒烟在真实桌面上建目录。
  const override = process.env['MMS_WORKSPACE']
  if (override) return resolve(override)
  return savedWorkspace() || defaultWorkspace()
}

export function workspaceInfo(): WorkspaceInfo {
  const path = workspacePath()
  const base = defaultWorkspace()
  return { path, defaultPath: base, isDefault: resolve(path) === resolve(base) }
}

export async function ensureWorkspace(): Promise<string> {
  const path = workspacePath()
  await mkdir(path, { recursive: true })
  return path
}

export function attachmentsRoot(): string {
  return join(workspacePath(), '附件')
}

async function walk(dir: string, root: string, depth: number, out: WorkspaceEntry[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_ENTRIES) return
  const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const dirs = items.filter((item) => item.isDirectory() && !item.name.startsWith('.'))
  const files = items.filter((item) => !item.isDirectory() && !item.name.startsWith('.'))
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  const fileRows: { entry: WorkspaceEntry; mtime: number }[] = []
  for (const file of files) {
    const full = join(dir, file.name)
    const info = await stat(full).catch(() => null)
    if (!info || !info.isFile()) continue
    const ext = extname(file.name).slice(1).toLowerCase()
    fileRows.push({
      mtime: info.mtimeMs,
      entry: {
        name: file.name,
        rel: relative(root, full),
        dir: relative(root, dir),
        size: info.size,
        mtime: info.mtimeMs,
        ext,
        kind: KIND_BY_EXT[ext] ?? 'other'
      }
    })
  }
  fileRows.sort((a, b) => b.mtime - a.mtime)

  for (const dirItem of dirs) {
    if (out.length >= MAX_ENTRIES) return
    out.push({
      name: dirItem.name,
      rel: relative(root, join(dir, dirItem.name)),
      dir: relative(root, dir),
      size: 0,
      mtime: 0,
      ext: '',
      kind: 'dir'
    })
  }
  for (const row of fileRows) {
    if (out.length >= MAX_ENTRIES) return
    out.push(row.entry)
  }
  for (const dirItem of dirs) {
    if (out.length >= MAX_ENTRIES) return
    await walk(join(dir, dirItem.name), root, depth + 1, out)
  }
}

export async function listWorkspace(): Promise<WorkspaceListing> {
  const root = await ensureWorkspace()
  const entries: WorkspaceEntry[] = []
  await walk(root, root, 1, entries)
  const totalSize = entries.reduce((sum, entry) => (entry.kind === 'dir' ? sum : sum + entry.size), 0)
  return { ok: true, info: workspaceInfo(), entries, totalSize, truncated: entries.length >= MAX_ENTRIES }
}

export async function chooseWorkspace(win: BrowserWindow | null): Promise<WorkspaceListing | null> {
  const options: OpenDialogOptions = {
    title: '选择工作区文件夹',
    buttonLabel: '用这个文件夹',
    defaultPath: await ensureWorkspace(),
    properties: ['openDirectory', 'createDirectory']
  }
  const result = win
    ? await dialog.showOpenDialog(win, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const picked = resolve(result.filePaths[0])
  await mkdir(picked, { recursive: true })
  saveWorkspace(picked)
  return listWorkspace()
}

export async function resetWorkspace(): Promise<WorkspaceListing> {
  saveWorkspace(undefined)
  return listWorkspace()
}

export async function revealWorkspace(): Promise<void> {
  const root = await ensureWorkspace()
  const error = await shell.openPath(root)
  if (error) throw new Error(error)
}

export async function openWorkspaceEntry(rel: unknown): Promise<void> {
  if (typeof rel !== 'string' || !rel) throw new Error('缺少文件路径')
  const root = await ensureWorkspace()
  const target = resolve(root, rel)
  const inside = relative(root, target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('路径不在工作区内')
  const error = await shell.openPath(target)
  if (error) throw new Error(error)
}
