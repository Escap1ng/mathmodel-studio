import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ChatCore, ThinkingDepth } from '../shared/api'

export type { ChatCore }

// 对话内核：python 是主线，dsh 是 DeepSeek 备用内核（env 显式设置时优先于该设置）。
const CORES = new Set<ChatCore>(['python', 'dsh'])

// 磁盘上只有 safeStorage 的密文。safeStorage 不可用时**拒绝保存**，
// 不退回明文——这条比"让用户先存上"重要。
interface StoredProvider {
  model?: string
  baseUrl?: string
  key?: string
  context?: number
  depth?: ThinkingDepth
  sendThinking?: boolean
}

interface SettingsFile {
  version: 1
  activeProvider?: string
  workspace?: string
  chatCore?: ChatCore
  providers: Record<string, StoredProvider>
}

let cache: SettingsFile | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function defaults(): SettingsFile {
  return { version: 1, providers: {} }
}

export function loadSettings(): SettingsFile {
  if (cache) return cache
  const path = filePath()
  if (!existsSync(path)) {
    cache = defaults()
    return cache
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SettingsFile>
    const providers =
      raw.providers && typeof raw.providers === 'object' ? (raw.providers as Record<string, StoredProvider>) : {}
    cache = {
      version: 1,
      activeProvider: typeof raw.activeProvider === 'string' ? raw.activeProvider : undefined,
      workspace: typeof raw.workspace === 'string' && raw.workspace ? raw.workspace : undefined,
      chatCore: CORES.has(raw.chatCore as ChatCore) ? (raw.chatCore as ChatCore) : undefined,
      providers
    }
  } catch {
    cache = defaults()
  }
  return cache
}

function persist(next: SettingsFile): void {
  const path = filePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  cache = next
}

export interface PublicProvider {
  configured: boolean
  model?: string
  baseUrl?: string
  context?: number
  depth?: ThinkingDepth
  sendThinking?: boolean
}

/** 只给渲染层展示用的合并视图，不含密文。 */
export function publicProviders(): Record<string, PublicProvider> {
  const file = loadSettings()
  const out: Record<string, PublicProvider> = {}
  for (const [id, item] of Object.entries(file.providers)) {
    out[id] = {
      configured: Boolean(item.key),
      model: item.model,
      baseUrl: item.baseUrl,
      context: item.context,
      depth: item.depth,
      sendThinking: item.sendThinking
    }
  }
  return out
}

export function activeProviderId(): string | undefined {
  return loadSettings().activeProvider
}

export interface SaveProviderInput {
  id: string
  model: string
  apiKey?: string
  baseUrl?: string
  contextTokens?: number
  thinkingDepth?: ThinkingDepth
  sendThinking?: boolean
}

const CONTEXTS = new Set([200_000, 400_000, 1_000_000])
const DEPTHS = new Set<ThinkingDepth>(['medium', 'high', 'max'])

export function saveProvider(input: SaveProviderInput): void {
  const id = String(input.id || '').trim()
  const model = String(input.model || '').trim()
  if (!id) throw new Error('缺少服务商标识')
  if (!model) throw new Error('缺少模型名')
  if (input.contextTokens !== undefined && !CONTEXTS.has(input.contextTokens)) {
    throw new Error('上下文预算只能是 200k / 400k / 1m')
  }
  if (input.thinkingDepth !== undefined && !DEPTHS.has(input.thinkingDepth)) {
    throw new Error('思维深度只能是中 / 高 / 最大')
  }
  const file = loadSettings()
  const prev = file.providers[id] ?? {}
  const next: StoredProvider = { ...prev, model }
  if (typeof input.baseUrl === 'string') next.baseUrl = input.baseUrl.trim()
  if (input.contextTokens !== undefined) next.context = input.contextTokens
  if (input.thinkingDepth !== undefined) next.depth = input.thinkingDepth
  if (typeof input.sendThinking === 'boolean') next.sendThinking = input.sendThinking
  const apiKey = String(input.apiKey || '').trim()
  if (apiKey) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，拒绝以明文保存 API Key')
    }
    next.key = safeStorage.encryptString(apiKey).toString('base64')
  }
  persist({
    ...file,
    activeProvider: id,
    providers: { ...file.providers, [id]: next }
  })
}

export function clearProviderKey(id: string): void {
  const file = loadSettings()
  const prev = file.providers[id]
  if (!prev) return
  const next: StoredProvider = { ...prev }
  delete next.key
  const providers = { ...file.providers }
  if (next.model || next.baseUrl) providers[id] = next
  else delete providers[id]
  persist({ ...file, providers })
}

export function apiKeyFor(id: string): string | null {
  const item = loadSettings().providers[id]
  if (!item?.key) return null
  try {
    return safeStorage.decryptString(Buffer.from(item.key, 'base64'))
  } catch {
    return null
  }
}

/** 用户自选的工作区目录；未设置时用桌面的「赛题」。 */
export function savedWorkspace(): string | undefined {
  return loadSettings().workspace
}

export function saveWorkspace(path: string | undefined): void {
  const file = loadSettings()
  const next: SettingsFile = { ...file }
  if (path) next.workspace = path
  else delete next.workspace
  persist(next)
}

/** 未设置时回退 python；MMS_CORE 环境变量优先权在 channel 启动处处理。 */
export function savedChatCore(): ChatCore {
  return loadSettings().chatCore ?? 'python'
}

export function saveChatCore(core: ChatCore): void {
  if (!CORES.has(core)) throw new Error('对话内核只能是 python / dsh')
  persist({ ...loadSettings(), chatCore: core })
}
