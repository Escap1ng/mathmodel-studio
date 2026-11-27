import { dialog, type BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import type { ProblemFile } from '../shared/api'

const MAX_PROBLEM_CHARS = 200_000

export async function pickProblemFile(win: BrowserWindow | null): Promise<ProblemFile | null> {
  const options = {
    title: '选择题面文件',
    properties: ['openFile' as const],
    filters: [{ name: '题面文本', extensions: ['txt', 'md', 'tex'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) return null
  const path = result.filePaths[0]
  const text = readFileSync(path, 'utf8')
  if (text.length > MAX_PROBLEM_CHARS) throw new Error('题面文件过大（超过 20 万字符）')
  return { path, text }
}

export async function pickDataFiles(win: BrowserWindow | null): Promise<string[]> {
  const options = {
    title: '选择数据与附件',
    properties: ['openFile' as const, 'multiSelections' as const],
    filters: [{ name: '数据与附件', extensions: ['csv', 'tsv', 'xlsx', 'docx', 'pdf', 'zip'] }]
  }
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (result.canceled) return []
  return result.filePaths.slice(0, 10)
}
