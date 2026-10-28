import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 磁盘上只有 safeStorage 的密文。safeStorage 不可用时**拒绝保存**，
// 不退回明文——这条比"让用户先存上"重要。
interface StoredProvider {
  model?: string
  baseUrl?: string
  key?: string
}

interface SettingsFile {
  version: 1
  activeProvider?: string
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
}

/** 只给渲染层展示用的合并视图，不含密文。 */
export function publicProviders(): Record<string, PublicProvider> {
  const file = loadSettings()
  const out: Record<string, PublicProvider> = {}
  for (const [id, item] of Object.entries(file.providers)) {
    out[id] = { configured: Boolean(item.key), model: item.model, baseUrl: item.baseUrl }
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
}

export function saveProvider(input: SaveProviderInput): void {
  const id = String(input.id || '').trim()
  const model = String(input.model || '').trim()
  if (!id) throw new Error('缺少 provider id')
  if (!model) throw new Error('缺少模型名')
  const file = loadSettings()
  const prev = file.providers[id] ?? {}
  const next: StoredProvider = { ...prev, model }
  if (typeof input.baseUrl === 'string') next.baseUrl = input.baseUrl.trim()
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
