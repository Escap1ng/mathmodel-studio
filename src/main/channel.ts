import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'

// 与 runtime/src/mms/server.py 的握手契约。渲染层永远拿不到 port 与 token。
export interface ChannelHandshake {
  port: number
  token: string
  pid: number
  fake: boolean
  version: string
}

export type RuntimeState = 'starting' | 'ready' | 'error'

export interface RuntimeStatus {
  state: RuntimeState
  message?: string
  version?: string
  fake?: boolean
}

export interface ProviderRow {
  id: string
  display: string
  base_url?: string
  models?: string[]
  tool_calling?: boolean
  requires_key?: boolean
  custom?: boolean
  note?: string
}

export interface ChatEventPayload {
  id: string
  event: string
  data: Record<string, unknown>
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

export class Channel {
  private child: ChildProcessWithoutNullStreams | null = null
  private handshake: ChannelHandshake | null = null
  private status: RuntimeStatus = { state: 'starting' }
  private readonly listeners = new Set<(s: RuntimeStatus) => void>()
  private startPromise: Promise<void> | null = null
  private stopping = false

  constructor(
    private readonly root: string,
    private readonly dataDir?: string
  ) {}

  onStatus(cb: (s: RuntimeStatus) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  current(): RuntimeStatus {
    return this.status
  }

  private setStatus(next: RuntimeStatus): void {
    this.status = next
    for (const cb of this.listeners) cb(next)
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    this.stopping = false
    this.startPromise = this.launch().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async restart(): Promise<void> {
    this.stop()
    await this.start()
  }

  private async launch(): Promise<void> {
    this.setStatus({ state: 'starting' })
    const python =
      process.env['MMS_PYTHON'] || (process.platform === 'win32' ? 'python' : 'python3')
    const child = spawn(python, [join(this.root, 'runtime', 'cli.py'), 'serve', '--port', '0'], {
      cwd: this.root,
      windowsHide: true,
      env: {
        ...process.env,
        MMS_HOME: this.root,
        ...(this.dataDir ? { MMS_DATA_DIR: this.dataDir } : {}),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
    })
    this.child = child

    try {
      const handshake = await this.readHandshake(child)
      if (this.child !== child) throw new Error('运行时启动被新的启动请求取代')
      this.handshake = handshake

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim()
        if (text) console.warn('[runtime stdout]', text.slice(0, 500))
      })
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8').trim()
        if (text) console.warn('[runtime]', text.slice(0, 500))
      })
      child.on('exit', (code) => {
        if (this.child !== child) return
        this.child = null
        this.handshake = null
        if (!this.stopping) {
          this.setStatus({ state: 'error', message: `runtime 已退出（code ${code ?? '?'}）` })
        }
      })

      const health = await this.request('/health')
      this.setStatus({
        state: 'ready',
        version: String(health['version'] ?? ''),
        fake: Boolean(health['fake'])
      })
    } catch (err) {
      if (this.child === child) {
        this.child = null
        this.handshake = null
        if (child.exitCode === null) child.kill()
      }
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus({ state: 'error', message })
      throw err
    }
  }

  private readHandshake(child: ChildProcessWithoutNullStreams): Promise<ChannelHandshake> {
    return new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('runtime 15 秒内没有完成握手'))
      }, 15000)
      const cleanup = (): void => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('error', onError)
        child.off('exit', onExit)
      }
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline).trim()
        try {
          const parsed = JSON.parse(line) as Partial<ChannelHandshake>
          if (!parsed.port || !parsed.token) throw new Error('握手字段不完整')
          cleanup()
          resolve(parsed as ChannelHandshake)
        } catch (err) {
          cleanup()
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
      const onError = (err: Error): void => {
        cleanup()
        reject(new Error(`无法启动 Python（${process.env['MMS_PYTHON'] || 'python'}）：${err.message}`))
      }
      const onExit = (code: number | null): void => {
        cleanup()
        reject(new Error(`runtime 在握手前退出（code ${code ?? '?'}）`))
      }
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
    })
  }

  private async request(path: string, options: RequestOptions = {}): Promise<Record<string, unknown>> {
    const hs = this.handshake
    if (!hs) throw new Error('运行时未连接')
    const headers: Record<string, string> = { Authorization: `Bearer ${hs.token}` }
    let body: string | undefined
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    const res = await fetch(`http://127.0.0.1:${hs.port}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: options.signal
    })
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      json = {}
    }
    if (!res.ok) {
      const detail = (json['error'] as { message?: string } | undefined)?.message
      throw new Error(detail || `运行时 HTTP ${res.status}`)
    }
    return json
  }

  async providers(): Promise<{ providers: ProviderRow[]; fake: boolean }> {
    const data = await this.request('/providers')
    return {
      providers: (data['providers'] as ProviderRow[]) ?? [],
      fake: Boolean(data['fake'])
    }
  }

  async startChat(payload: Record<string, unknown>): Promise<string> {
    const data = await this.request('/chats', { method: 'POST', body: payload })
    const chatId = String(data['chatId'] ?? '')
    if (!chatId) throw new Error('运行时没有返回会话 id')
    return chatId
  }

  async cancel(chatId: string): Promise<void> {
    await this.request(`/chats/${encodeURIComponent(chatId)}/cancel`, { method: 'POST', body: {} })
  }

  async resumeSession(sessionId: string, action: string, choice: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/resume`, {
      method: 'POST',
      body: { action, choice }
    })
  }

  async latestSession(): Promise<Record<string, unknown> | null> {
    const data = await this.request('/sessions/latest')
    const session = data['session']
    return session && typeof session === 'object' ? (session as Record<string, unknown>) : null
  }

  async workbenchState(): Promise<Record<string, unknown>> {
    return this.request('/workbench/state')
  }

  async renderFigure(template: string, theme: string): Promise<Record<string, unknown>> {
    return this.request('/workbench/render', {
      method: 'POST',
      body: { template, theme }
    })
  }

  async rollbackFigure(version: string): Promise<Record<string, unknown>> {
    return this.request('/workbench/rollback', {
      method: 'POST',
      body: { version }
    })
  }

  async buildPaper(): Promise<Record<string, unknown>> {
    return this.request('/workbench/paper/build', {
      method: 'POST',
      body: {}
    })
  }

  async stream(
    chatId: string,
    onEvent: (ev: ChatEventPayload) => void,
    signal: AbortSignal
  ): Promise<void> {
    const hs = this.handshake
    if (!hs) throw new Error('运行时未连接')
    const res = await fetch(`http://127.0.0.1:${hs.port}/chats/${encodeURIComponent(chatId)}/events`, {
      headers: { Authorization: `Bearer ${hs.token}` },
      signal
    })
    if (!res.ok || !res.body) throw new Error(`事件流打开失败（HTTP ${res.status}）`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '')
        let split = buffer.indexOf('\n\n')
        while (split >= 0) {
          const frame = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          this.emitFrame(frame, onEvent)
          split = buffer.indexOf('\n\n')
        }
      }
      if (buffer.trim()) this.emitFrame(buffer, onEvent)
    } finally {
      reader.releaseLock()
    }
  }

  private emitFrame(frame: string, onEvent: (ev: ChatEventPayload) => void): void {
    let id = ''
    let event = ''
    const dataLines: string[] = []
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const key = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (key === 'id') id = value
      else if (key === 'event') event = value
      else if (key === 'data') dataLines.push(value)
    }
    if (!event || dataLines.length === 0) return
    try {
      const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>
      onEvent({ id, event, data })
    } catch {
      // 坏帧不往渲染层送；流还会继续。
    }
  }

  stop(): void {
    this.stopping = true
    const child = this.child
    this.child = null
    this.handshake = null
    if (!child || child.exitCode !== null) return
    child.kill()
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 3000)
    timer.unref()
  }
}
