import { app, BrowserWindow, ipcMain, Menu, shell, type WebContents } from 'electron'
import { readFileSync } from 'node:fs'
import { join, relative, isAbsolute } from 'node:path'
import { APP_ROOT, runtimePython } from './runtime-env'
import { Channel, type RuntimeProvider } from './channel'
import { pickDataFiles, pickProblemFile } from './files'
import {
  activeProviderId,
  apiKeyFor,
  clearProviderKey,
  publicProviders,
  saveProvider
} from './settings'
import type {
  ProviderList,
  ProviderView,
  RunEvent,
  RunInput,
  RuntimeStatus,
  SaveProviderInput
} from '../shared/api'

// 开发时 electron-vite 会注入 ELECTRON_RENDERER_URL；打包后走 out/renderer/index.html。
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL']
const RUNS_ROOT = join(app.getPath('userData'), 'runs')
const channel = new Channel(APP_ROOT, runtimePython(), app.getPath('userData'))
const activeStreams = new Map<string, AbortController>()

channel.onStatus((status: RuntimeStatus) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('runtime:status', status)
  }
})

async function providerViews(): Promise<ProviderList> {
  const { providers } = await channel.providers()
  const saved = publicProviders()
  const views: ProviderView[] = providers.map((row: RuntimeProvider) => {
    const stored = saved[row.id]
    const models = row.models ?? []
    return {
      id: row.id,
      display: row.display,
      models,
      model: stored?.model || row.model || models[0] || '',
      baseUrl: stored?.baseUrl || row.base_url || '',
      requiresKey: Boolean(row.requires_key),
      custom: Boolean(row.custom),
      configured: row.id === 'fake' || Boolean(stored?.configured),
      note: row.note
    }
  })
  const preferred = activeProviderId()
  const active =
    views.find((view) => view.id === preferred) ??
    views.find((view) => view.configured) ??
    views[0]
  return { ok: true, providers: views, activeProvider: active?.id ?? '' }
}

function parseSaveInput(raw: unknown): SaveProviderInput {
  if (!raw || typeof raw !== 'object') throw new Error('设置格式不对')
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  const model = typeof obj.model === 'string' ? obj.model.trim() : ''
  if (!id) throw new Error('缺少服务商')
  if (!model) throw new Error('缺少模型名')
  return {
    id,
    model,
    apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : undefined,
    baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : undefined
  }
}

function parseRunInput(raw: unknown): RunInput {
  if (!raw || typeof raw !== 'object') throw new Error('运行请求格式不对')
  const obj = raw as Record<string, unknown>
  const problem = typeof obj.problem === 'string' ? obj.problem.trim() : ''
  const providerId = typeof obj.providerId === 'string' ? obj.providerId.trim() : ''
  if (problem.length < 10) throw new Error('题面至少写一句完整的题目描述')
  if (problem.length > 200_000) throw new Error('题面过长')
  if (!providerId) throw new Error('没有选择服务商')
  const dataPaths = Array.isArray(obj.dataPaths)
    ? obj.dataPaths.filter((item): item is string => typeof item === 'string' && Boolean(item)).slice(0, 10)
    : []
  return {
    problem,
    dataPaths,
    providerId,
    model: typeof obj.model === 'string' ? obj.model.trim() : ''
  }
}

function insideRuns(path: string): boolean {
  if (!isAbsolute(path)) return false
  const rel = relative(RUNS_ROOT, path)
  return Boolean(rel) && !rel.startsWith('..') && !isAbsolute(rel)
}

function attachStream(runId: string, sender: WebContents): void {
  const controller = new AbortController()
  activeStreams.set(runId, controller)
  void channel
    .stream(
      runId,
      (event: RunEvent) => {
        if (!sender.isDestroyed()) sender.send('run:event', event)
      },
      controller.signal
    )
    .catch((err: unknown) => {
      if (controller.signal.aborted || sender.isDestroyed()) return
      const message = err instanceof Error ? err.message : String(err)
      sender.send('run:event', {
        runId,
        id: '0',
        event: 'done',
        data: { ok: false, error: message, outputs: {} }
      })
    })
    .finally(() => activeStreams.delete(runId))
}

function appVersion(): string {
  try {
    return readFileSync(join(APP_ROOT, 'VERSION'), 'utf8').trim() || app.getVersion()
  } catch {
    return app.getVersion()
  }
}

ipcMain.handle('app:meta', () => ({
  version: appVersion(),
  platform: process.platform,
  electron: process.versions.electron,
  chrome: process.versions.chrome
}))

ipcMain.handle('runtime:status', () => channel.current())

ipcMain.handle('runtime:restart', async () => {
  await channel.restart()
  return providerViews()
})

ipcMain.handle('providers:list', () => providerViews())

ipcMain.handle('providers:save', async (_event, raw: unknown) => {
  saveProvider(parseSaveInput(raw))
  return providerViews()
})

ipcMain.handle('providers:clear', async (_event, raw: unknown) => {
  const id = typeof raw === 'string' ? raw : ''
  if (!id) throw new Error('缺少服务商')
  clearProviderKey(id)
  return providerViews()
})

ipcMain.handle('files:pick-problem', (event) => pickProblemFile(BrowserWindow.fromWebContents(event.sender)))

ipcMain.handle('files:pick-data', (event) => pickDataFiles(BrowserWindow.fromWebContents(event.sender)))

ipcMain.handle('run:start', async (event, raw: unknown) => {
  const input = parseRunInput(raw)
  const list = await providerViews()
  const view = list.providers.find((item) => item.id === input.providerId)
  if (!view) throw new Error('未知服务商')
  if (view.custom && !view.baseUrl) throw new Error('自定义端点还没填 base URL')
  const apiKey = view.id === 'fake' ? '' : apiKeyFor(view.id) ?? ''
  if (view.requiresKey && !apiKey) throw new Error('还没配置 API Key')
  const result = await channel.startRun({
    problem: input.problem,
    dataPaths: input.dataPaths,
    provider: {
      id: view.id,
      model: input.model || view.model,
      baseUrl: view.custom ? view.baseUrl : undefined,
      apiKey
    }
  })
  attachStream(result.runId, event.sender)
  return result
})

ipcMain.handle('run:cancel', async (_event, raw: unknown) => {
  const runId = typeof raw === 'string' ? raw : ''
  if (!runId) throw new Error('缺少运行 id')
  await channel.cancelRun(runId)
  // provider 正在等下一块数据时 cancel 只能等它醒来；2 秒后断开本地流兜底。
  const controller = activeStreams.get(runId)
  if (controller) setTimeout(() => controller.abort(), 2000)
  return { ok: true }
})

ipcMain.handle('artifact:open', async (_event, raw: unknown) => {
  const path = typeof raw === 'string' ? raw : ''
  if (!insideRuns(path)) throw new Error('只能打开本次运行的产物')
  const error = await shell.openPath(path)
  if (error) throw new Error(error)
  return { ok: true }
})

ipcMain.handle('artifact:reveal', (_event, raw: unknown) => {
  const path = typeof raw === 'string' ? raw : ''
  if (!insideRuns(path)) throw new Error('只能定位本次运行的产物')
  shell.showItemInFolder(path)
  return { ok: true }
})

ipcMain.handle('artifact:image', (_event, raw: unknown) => {
  const path = typeof raw === 'string' ? raw : ''
  if (!insideRuns(path)) return null
  try {
    const bytes = readFileSync(path)
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
})

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    useContentSize: true,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#ffffff',
    title: 'MathModel Studio',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  win.once('ready-to-show', () => {
    win.setContentSize(1280, 860)
    win.show()
  })

  if (DEV_SERVER_URL && !app.isPackaged) {
    void win.loadURL(DEV_SERVER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

// 渲染层拿不到 Node 能力，也不该拿到：外部链接一律走 shell.openExternal，且只放 https。
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const allowedOrigin = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : 'file:'
    const origin = url.startsWith('file://') ? 'file:' : new URL(url).origin
    if (origin !== allowedOrigin) event.preventDefault()
  })
})

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  void channel.start().catch((err: unknown) => {
    console.error('[runtime] 启动失败:', err instanceof Error ? err.message : err)
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  for (const controller of activeStreams.values()) controller.abort()
  activeStreams.clear()
  channel.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
