import { app, clipboard, dialog, shell, type BrowserWindow, type OpenDialogOptions } from 'electron'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
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

// —— 按赛题分项目文件夹 ——
// 每个 workflow 会话在自己的文件夹下工作：<工作区>/<标题-xxxx>/{附件,图表,论文,代码}。
// 目录注册表放 userData，重启后 resume 还能找回同一个项目目录。
const PROJECT_SUBDIRS = ['附件', '图表', '论文', '代码'] as const
const MAX_PROJECT_STEM = 32

interface ProjectRecord {
  name: string
  path: string
}

interface ProjectFile {
  version: 1
  map: Record<string, ProjectRecord>
}

let projectCache: ProjectFile | null = null

function projectFilePath(): string {
  return join(app.getPath('userData'), 'project-folders.json')
}

function loadProjects(): ProjectFile {
  if (projectCache) return projectCache
  try {
    const raw = JSON.parse(readFileSync(projectFilePath(), 'utf8')) as Partial<ProjectFile>
    const map: Record<string, ProjectRecord> = {}
    if (raw.map && typeof raw.map === 'object') {
      for (const [id, item] of Object.entries(raw.map)) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Partial<ProjectRecord>
        if (typeof rec.name === 'string' && typeof rec.path === 'string' && rec.name && rec.path) {
          map[id] = { name: rec.name, path: rec.path }
        }
      }
    }
    projectCache = { version: 1, map }
  } catch {
    projectCache = { version: 1, map: {} }
  }
  return projectCache
}

function saveProjects(next: ProjectFile): void {
  mkdirSync(dirname(projectFilePath()), { recursive: true })
  writeFileSync(projectFilePath(), JSON.stringify(next, null, 2) + '\n', 'utf8')
  projectCache = next
}

/** 首条用户消息 → 文件夹名：剥掉附件正文，替换非法字符，截到 32 字符再加短码。 */
export function projectNameFrom(firstText: string, token: string): string {
  const marker = '--- 附件（本机文件）---'
  const cut = firstText.indexOf(marker)
  const display = (cut >= 0 ? firstText.slice(0, cut) : firstText)
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .trim()
  const stem = display.slice(0, MAX_PROJECT_STEM).trim() || '建模会话'
  return `${stem}-${token}`
}

export async function createProjectFolder(firstText: string, token: string): Promise<ProjectRecord> {
  const name = projectNameFrom(firstText, token)
  const root = await ensureWorkspace()
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  for (const sub of PROJECT_SUBDIRS) await mkdir(join(path, sub), { recursive: true })
  return { name, path }
}

export function rememberProject(chatId: string, record: ProjectRecord): void {
  const file = loadProjects()
  saveProjects({ ...file, map: { ...file.map, [chatId]: record } })
}

export function projectFolderFor(chatId: string): string | undefined {
  return loadProjects().map[chatId]?.path
}

export function projectInfoFor(chatId: unknown): ProjectRecord | null {
  if (typeof chatId !== 'string' || !chatId) return null
  return loadProjects().map[chatId] ?? null
}

export async function openProjectFolder(chatId: unknown): Promise<void> {
  const record = projectInfoFor(chatId)
  if (!record) throw new Error('这个会话还没有项目文件夹')
  const error = await shell.openPath(record.path)
  if (error) throw new Error(error)
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

async function entryPath(rel: unknown): Promise<string> {
  if (typeof rel !== 'string' || !rel) throw new Error('缺少文件路径')
  const root = await ensureWorkspace()
  const target = resolve(root, rel)
  const inside = relative(root, target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('路径不在工作区内')
  return target
}

export async function openWorkspaceEntry(rel: unknown): Promise<void> {
  const error = await shell.openPath(await entryPath(rel))
  if (error) throw new Error(error)
}

export function revealWorkspaceEntry(rel: unknown): Promise<void> {
  return entryPath(rel).then((target) => {
    shell.showItemInFolder(target)
  })
}

export async function copyWorkspacePath(rel: unknown): Promise<string> {
  const target = await entryPath(rel)
  clipboard.writeText(target)
  return target
}

// 用户主动删除时走系统回收站，不做不可恢复的 unlink。
export async function trashWorkspaceEntry(rel: unknown): Promise<void> {
  await shell.trashItem(await entryPath(rel))
}
