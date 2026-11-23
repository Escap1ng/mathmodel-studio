import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { RunEvent, RuntimeStatus } from '../shared/api'

// 与 core/src/mms/server.py 的握手契约。渲染层永远拿不到 port 与 token。
export interface ChannelHandshake {
  port: number
  token: string
  pid: number
  fake: boolean
  version: string
}

export interface RuntimeProvider {
  id: string
  display: string
  models: string[]
  model: string
  base_url: string
  requires_key: boolean
  custom: boolean
  note?: string
}

interface RunBody {
  problem: string
  dataPaths: string[]
  provider: { id: string; model: string; baseUrl?: string; apiKey: string }
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
    private readonly python: string,
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
    if (this.handshake) return Promise.resolve()
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
    const child = spawn(this.python, [join(this.root, 'core', 'cli.py'), 'serve', '--port', '0'], {
      cwd: this.root,
      windowsHide: true,
      env: {
        ...process.env,
        MMS_HOME: this.root,
        ...(this.dataDir ? { MMS_DATA_DIR: this.dataDir } : {}),
        MMS_PYTHON: this.python,
        ...(this.dataDir ? { PYTHONPYCACHEPREFIX: join(this.dataDir, 'pycache') } : {}),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1'
      }
    })
    this.child = child

    try {
      const handshake = await this.readHandshake(child)
      if (this.child !== child) throw new Error('runtime 启动被新的启动请求取代')
      this.handshake = handshake
      this.setStatus({ state: 'ready', version: handshake.version })

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
    } catch (err) {
      child.kill()
      this.child = null
      this.handshake = null
      const message = err instanceof Error ? err.message : String(err)
      if (!this.stopping) this.setStatus({ state: 'error', message })
      throw err
    }
  }

  private readHandshake(child: ChildProcessWithoutNullStreams): Promise<ChannelHandshake> {
    return new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('runtime 握手超时'))
      }, 20_000)
      const cleanup = (): void => {
        clearTimeout(timer)
        child.stdout.off('data', onData)
        child.off('exit', onExit)
      }
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8')
        const index = buffer.indexOf('\n')
        if (index < 0) return
        const line = buffer.slice(0, index).trim()
        cleanup()
        try {
          resolve(JSON.parse(line) as ChannelHandshake)
        } catch {
          reject(new Error('runtime 握手不是合法 JSON'))
        }
      }
      const onExit = (code: number | null): void => {
        cleanup()
        reject(new Error(`runtime 启动即退出（code ${code ?? '?'}）`))
      }
      child.stdout.on('data', onData)
      child.on('exit', onExit)
    })
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.start()
    const handshake = this.handshake
    if (!handshake) throw new Error('runtime 未就绪')
    const response = await fetch(`http://127.0.0.1:${handshake.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${handshake.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await response.text()
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error(`runtime 返回非 JSON（HTTP ${response.status}）`)
    }
    const payload = data as { ok?: boolean; error?: { message?: string } }
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error?.message || `HTTP ${response.status}`)
    }
    return data as T
  }

  async providers(): Promise<{ ok: true; providers: RuntimeProvider[] }> {
    return this.request('GET', '/providers')
  }

  async startRun(body: RunBody): Promise<{ ok: true; runId: string }> {
    return this.request('POST', '/runs', body)
  }

  async cancelRun(runId: string): Promise<{ ok: true }> {
    return this.request('POST', `/runs/${encodeURIComponent(runId)}/cancel`)
  }

  async stream(runId: string, cb: (event: RunEvent) => void, signal: AbortSignal): Promise<void> {
    await this.start()
    const handshake = this.handshake
    if (!handshake) throw new Error('runtime 未就绪')
    const response = await fetch(
      `http://127.0.0.1:${handshake.port}/runs/${encodeURIComponent(runId)}/events`,
      { headers: { Authorization: `Bearer ${handshake.token}` }, signal }
    )
    if (!response.ok || !response.body) throw new Error(`事件流打开失败（HTTP ${response.status}）`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        this.parseFrame(frame, runId, cb)
      }
    }
  }

  private parseFrame(frame: string, runId: string, cb: (event: RunEvent) => void): void {
    let id = '0'
    let event = 'message'
    let data = ''
    for (const line of frame.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim()
      else if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) return
    try {
      cb({ runId, id, event, data: JSON.parse(data) as Record<string, unknown> })
    } catch {
      // 坏帧只跳过，不打断流
    }
  }

  stop(): void {
    this.stopping = true
    const child = this.child
    this.child = null
    this.handshake = null
    if (child) child.kill()
  }
}
