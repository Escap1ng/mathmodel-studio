import { app, BrowserWindow, ipcMain, Menu, shell, type WebContents } from 'electron'
import { APP_ROOT, runtimePython } from './runtime-env'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Channel, type ChatEventPayload, type ProviderRow, type RuntimeStatus } from './channel'
import { attachmentContext } from './extract'
import {
  adoptAttachments,
  attachWorkspace,
  discardStaged,
  pickFiles,
  revealStaged,
  stageBlob,
  stageFiles
} from './files'
import {
  chooseWorkspace,
  copyWorkspacePath,
  createProjectFolder,
  ensureWorkspace,
  listWorkspace,
  openProjectFolder,
  openWorkspaceEntry,
  projectFolderFor,
  projectInfoFor,
  rememberProject,
  resetWorkspace,
  revealWorkspace,
  revealWorkspaceEntry,
  trashWorkspaceEntry,
  workspacePath
} from './workspace'
import type {
  ChatStartInput,
  ProviderList,
  ProviderView,
  ResumeInput,
  SessionGet,
  SessionLatest,
  SessionList,
  ThinkingDepth,
  WorkbenchResult,
  WorkbenchState
} from '../shared/api'
import {
  activeProviderId,
  apiKeyFor,
  clearProviderKey,
  projectFoldersEnabled,
  publicProviders,
  saveProvider,
  type SaveProviderInput
} from './settings'

// 开发时 electron-vite 会注入 ELECTRON_RENDERER_URL；打包后走 out/renderer/index.html。
const DEV_SERVER_URL = process.env['ELECTRON_RENDERER_URL']
const channel = new Channel(APP_ROOT, runtimePython(), app.getPath('userData'))
const activeStreams = new Map<string, AbortController>()

type ChatInput = ChatStartInput

function broadcastStatus(status: RuntimeStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('runtime:status', status)
  }
}

channel.onStatus(broadcastStatus)

async function providerViews(): Promise<ProviderList> {
  const { providers, fake } = await channel.providers()
  const saved = publicProviders()
  const views: ProviderView[] = providers.map((row: ProviderRow) => {
    const isFake = row.id === 'fake'
    const stored = saved[row.id]
    const models = row.models ?? []
    return {
      id: row.id,
      display: row.display,
      models,
      model: stored?.model || models[0] || '',
      baseUrl: stored?.baseUrl || row.base_url || '',
      requiresKey: !isFake && row.requires_key !== false,
      toolCalling: Boolean(row.tool_calling),
      custom: Boolean(row.custom),
      configured: isFake || Boolean(stored?.configured),
      contextLimit: stored?.context ?? 200_000,
      contextMax: row.context_len ?? 1_000_000,
      modelContexts: row.model_context,
      thinkingDepth: stored?.depth ?? 'high',
      sendThinking: stored?.sendThinking ?? !row.custom,
      reasoning: row.reasoning,
      note: row.note
    }
  })
  const preferred = activeProviderId()
  const active =
    views.find((v) => v.id === preferred) ??
    views.find((v) => v.configured) ??
    views.find((v) => v.id === 'fake') ??
    views[0]
  return { ok: true, providers: views, activeProvider: active?.id ?? '', fake }
}

function parseSaveInput(raw: unknown): SaveProviderInput {
  if (!raw || typeof raw !== 'object') throw new Error('设置格式不对')
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  const model = typeof obj.model === 'string' ? obj.model.trim() : ''
  if (!id) throw new Error('缺少服务商')
  if (!model) throw new Error('缺少模型名')
  const contextTokens =
    typeof obj.contextTokens === 'number' && Number.isFinite(obj.contextTokens)
      ? obj.contextTokens
      : undefined
  const thinkingDepth =
    obj.thinkingDepth === 'medium' || obj.thinkingDepth === 'high' || obj.thinkingDepth === 'max'
      ? (obj.thinkingDepth as ThinkingDepth)
      : undefined
  return {
    id,
    model,
    apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : undefined,
    baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : undefined,
    contextTokens,
    thinkingDepth,
    sendThinking: typeof obj.sendThinking === 'boolean' ? obj.sendThinking : undefined
  }
}

function parseChatInput(raw: unknown): ChatInput {
  if (!raw || typeof raw !== 'object') throw new Error('对话请求格式不对')
  const obj = raw as Record<string, unknown>
  const providerId = typeof obj.providerId === 'string' ? obj.providerId : ''
  const model = typeof obj.model === 'string' ? obj.model.trim() : ''
  const list = obj.messages
  if (!providerId) throw new Error('没有选择服务商')
  if (!Array.isArray(list) || list.length === 0) throw new Error('消息为空')
  if (list.length > 200) throw new Error('消息过多')
  const messages: ChatInput['messages'] = []
  let total = 0
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new Error('消息格式不对')
    const m = item as Record<string, unknown>
    if (m.role !== 'user' && m.role !== 'assistant') throw new Error('消息角色不合法')
    if (typeof m.content !== 'string') throw new Error('消息内容必须是文本')
    total += m.content.length
    if (total > 1_600_000) throw new Error('消息总长度超过上限')
    messages.push({ role: m.role, content: m.content })
  }
  const thinking =
    obj.thinking === 'medium' || obj.thinking === 'high' || obj.thinking === 'max'
      ? (obj.thinking as ThinkingDepth)
      : undefined
  const contextTokens =
    typeof obj.contextTokens === 'number' && Number.isFinite(obj.contextTokens)
      ? obj.contextTokens
      : undefined
  const attachmentPaths = Array.isArray(obj.attachmentPaths)
    ? obj.attachmentPaths.filter((item): item is string => typeof item === 'string' && Boolean(item)).slice(0, 20)
    : undefined
  return {
    providerId,
    model,
    mode: obj.mode === 'workflow' ? 'workflow' : 'chat',
    messages,
    thinking,
    contextTokens,
    sendThinking: typeof obj.sendThinking === 'boolean' ? obj.sendThinking : undefined,
    attachmentPaths
  }
}

function parseResumeInput(raw: unknown): ResumeInput {
  if (!raw || typeof raw !== 'object') throw new Error('恢复请求格式不对')
  const obj = raw as Record<string, unknown>
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId.trim() : ''
  const action = obj.action
  if (!sessionId) throw new Error('缺少会话 id')
  if (action !== 'confirm' && action !== 'reroll' && action !== 'choose') throw new Error('未知决策动作')
  const choice = typeof obj.choice === 'string' ? obj.choice : undefined
  if (action === 'choose' && !choice) throw new Error('缺少候选 id')
  return { sessionId, action, choice }
}

function attachStream(chatId: string, sender: WebContents): void {
  const controller = new AbortController()
  activeStreams.set(chatId, controller)
  void channel
    .stream(
      chatId,
      (ev: ChatEventPayload) => {
        if (!sender.isDestroyed()) sender.send('chat:event', { chatId, ...ev })
      },
      controller.signal
    )
    .catch((err: unknown) => {
      if (controller.signal.aborted || sender.isDestroyed()) return
      const message = err instanceof Error ? err.message : String(err)
      sender.send('chat:event', { chatId, id: '0', event: 'error', data: { message } })
      sender.send('chat:event', { chatId, id: '0', event: 'done', data: { reason: 'error' } })
    })
    .finally(() => activeStreams.delete(chatId))
}

ipcMain.handle('app:meta', () => ({
  version: app.getVersion(),
  platform: process.platform,
  Electron: process.versions.electron,
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

ipcMain.handle('chat:start', async (event, raw: unknown) => {
  const input = parseChatInput(raw)
  const list = await providerViews()
  const view = list.providers.find((p) => p.id === input.providerId)
  if (!view) throw new Error('未知服务商')
  if (view.custom && !view.baseUrl) throw new Error('自定义端点还没填 base URL')
  const apiKey = view.id === 'fake' ? '' : apiKeyFor(view.id)
  if (view.requiresKey && !apiKey) throw new Error('还没配置 API Key')

  // 建模会话按赛题分文件夹；建目录失败就退回旧行为，发送不能被目录问题卡住。
  let workspace = workspacePath()
  let project: { name: string; path: string } | null = null
  if (input.mode === 'workflow' && projectFoldersEnabled()) {
    const firstText = input.messages.find((message) => message.role === 'user')?.content ?? ''
    try {
      project = await createProjectFolder(firstText, randomBytes(2).toString('hex'))
      await adoptAttachments(input.attachmentPaths, project.path)
      workspace = project.path
    } catch {
      project = null
    }
  }

  const chatId = await channel.startChat({
    providerId: view.id,
    model: input.model || view.model,
    mode: input.mode,
    apiKey,
    baseUrl: view.custom ? view.baseUrl : undefined,
    messages: input.messages,
    thinking: view.sendThinking ? input.thinking ?? view.thinkingDepth : '',
    contextTokens: input.contextTokens ?? view.contextLimit,
    sendThinking: view.sendThinking,
    // 阶段四要在工作区里找数据文件；路径由主进程给，渲染层不碰文件系统。
    workspace
  })
  if (project) rememberProject(chatId, project)
  attachStream(chatId, event.sender)
  return { ok: true, chatId }
})

ipcMain.handle('chat:resume', async (event, raw: unknown) => {
  const input = parseResumeInput(raw)
  // 续聊沿用会话自己的项目目录；老会话没登记过时退回全局工作区。
  const workspace = projectFolderFor(input.sessionId) ?? workspacePath()
  await channel.resumeSession(input.sessionId, input.action, input.choice ?? '', workspace)
  attachStream(input.sessionId, event.sender)
  return { ok: true, chatId: input.sessionId }
})

ipcMain.handle('session:latest', async (): Promise<SessionLatest> => ({
  ok: true,
  session: (await channel.latestSession()) as SessionLatest['session']
}))

ipcMain.handle('session:list', async (): Promise<SessionList> => ({
  ok: true,
  sessions: (await channel.listSessions()) as unknown as SessionList['sessions']
}))

ipcMain.handle('session:get', async (_event, raw: unknown): Promise<SessionGet> => {
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) throw new Error('缺少会话 id')
  return { ok: true, session: (await channel.getSession(id)) as SessionGet['session'] }
})

ipcMain.handle('session:delete', async (_event, raw: unknown) => {
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) throw new Error('缺少会话 id')
  await channel.deleteSession(id)
  return { ok: true }
})

ipcMain.handle('session:clear', async () => ({
  ok: true,
  removed: await channel.clearSessions()
}))

ipcMain.handle('files:pick', (event) => pickFiles(BrowserWindow.fromWebContents(event.sender)))

ipcMain.handle('files:stage', (_event, raw: unknown) => stageFiles(raw))

ipcMain.handle('files:attach', (_event, raw: unknown) => attachWorkspace(raw))

ipcMain.handle('files:stage-blob', (_event, raw: unknown) => stageBlob(raw))

ipcMain.handle('files:discard', (_event, raw: unknown) => discardStaged(raw))

ipcMain.handle('files:context', (_event, raw: unknown) => attachmentContext(raw))

ipcMain.handle('files:reveal', () => revealStaged())

ipcMain.handle('workspace:get', () => listWorkspace())

ipcMain.handle('workspace:choose', (event) =>
  chooseWorkspace(BrowserWindow.fromWebContents(event.sender))
)

ipcMain.handle('workspace:reset', () => resetWorkspace())

ipcMain.handle('workspace:reveal', () => revealWorkspace())

ipcMain.handle('workspace:open', (_event, raw: unknown) => openWorkspaceEntry(raw))

ipcMain.handle('workspace:reveal-entry', (_event, raw: unknown) => revealWorkspaceEntry(raw))

ipcMain.handle('workspace:copy-path', (_event, raw: unknown) => copyWorkspacePath(raw))

ipcMain.handle('workspace:trash', (_event, raw: unknown) => trashWorkspaceEntry(raw))
ipcMain.handle('workspace:project', (_event, raw: unknown) => projectInfoFor(raw))
ipcMain.handle('workspace:open-project', (_event, raw: unknown) => openProjectFolder(raw))

function imageDataUrl(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null
  try {
    const bytes = readFileSync(path)
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

function pdfDataUrl(path: unknown): string | null {
  if (typeof path !== 'string' || !path) return null
  try {
    const bytes = readFileSync(path)
    if (!bytes.length || bytes.length > 12 * 1024 * 1024) return null
    return `data:application/pdf;base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

function withImages(raw: Record<string, unknown>): WorkbenchState {
  const figure = (raw['figure'] ?? {}) as Record<string, unknown>
  const paper = (raw['paper'] ?? {}) as Record<string, unknown>
  const artifacts = (paper['artifacts'] ?? {}) as Record<string, { path?: string }>
  return {
    ...(raw as unknown as WorkbenchState),
    figure: {
      ...(figure as unknown as WorkbenchState['figure']),
      activeImage: imageDataUrl(figure['active_png']),
      previousImage: imageDataUrl(figure['previous_png'])
    },
    paper: {
      ...(paper as unknown as WorkbenchState['paper']),
      pdfData: pdfDataUrl(artifacts.pdf?.path)
    }
  }
}

ipcMain.handle('workbench:state', async () => withImages(await channel.workbenchState()))

ipcMain.handle('workbench:render', async (_event, raw: unknown): Promise<WorkbenchResult> => {
  if (!raw || typeof raw !== 'object') throw new Error('渲染请求格式不对')
  const obj = raw as Record<string, unknown>
  const template = typeof obj.template === 'string' ? obj.template : ''
  const theme = typeof obj.theme === 'string' ? obj.theme : ''
  if (!template || !theme) throw new Error('缺少模板或主题')
  const data = await channel.renderFigure(template, theme)
  return { ok: true, state: withImages((data['state'] ?? {}) as Record<string, unknown>) }
})

ipcMain.handle('workbench:rollback', async (_event, raw: unknown): Promise<WorkbenchResult> => {
  if (!raw || typeof raw !== 'object') throw new Error('回滚请求格式不对')
  const version = (raw as Record<string, unknown>).version
  if (typeof version !== 'string' || !version) throw new Error('缺少版本 id')
  const data = await channel.rollbackFigure(version)
  return { ok: true, state: withImages((data['state'] ?? {}) as Record<string, unknown>) }
})

ipcMain.handle('paper:build', async (): Promise<WorkbenchResult> => {
  const data = await channel.buildPaper()
  return { ok: true, state: withImages((data['state'] ?? {}) as Record<string, unknown>) }
})

ipcMain.handle('chat:cancel', async (_event, raw: unknown) => {
  const chatId = typeof raw === 'string' ? raw : ''
  if (!chatId) throw new Error('缺少会话 id')
  await channel.cancel(chatId)
  // provider 正在等下一块数据时，cancel 只能等它醒来；2 秒后断开本地流兜底。
  const controller = activeStreams.get(chatId)
  if (controller) setTimeout(() => controller.abort(), 2000)
  return { ok: true }
})

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    // 1440×900 是布局的设计基准，所以它必须指内容区：
    // 默认的 width/height 含窗口边框，实测内容区会掉到 1439x872，跨平台不可比。
    useContentSize: true,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    // 主色调是白：窗口底色先于首帧就位，避免 Windows 上黑底闪一下
    backgroundColor: '#ffffff',
    title: 'mathmodel-studio',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  win.once('ready-to-show', () => {
    // 分数缩放（本机 150%）下，Windows 会把 useContentSize 的结果再抖动 1–2 DIP；
    // 布局基准是内容区 1440×900，显示前再钉一次。
    win.setContentSize(1440, 900)
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
  // Windows/Linux 上默认的英文 File/Edit/View 菜单没有用武之地；中文界面不挂它。
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  // 默认工作区（桌面「赛题」）在首启就建出来，用户打开桌面就能看到。
  void ensureWorkspace().catch((err: unknown) => {
    console.error('[workspace] 创建失败:', err instanceof Error ? err.message : err)
  })
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
