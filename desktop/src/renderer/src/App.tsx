import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  DoneData,
  LogData,
  PhaseData,
  ProviderList,
  RuntimeStatus,
  StudioMeta
} from '../../shared/api'
import SettingsDialog from './components/SettingsDialog'

const PHASE_ROWS = [
  { id: 1, label: '题面拆解' },
  { id: 2, label: '方法选择' },
  { id: 3, label: '生成代码' },
  { id: 4, label: '运行求解' },
  { id: 5, label: '论文排版' }
]

type PhaseView = { label: string; status: 'idle' | 'running' | 'ok' | 'error'; detail?: string }

const SOURCE_LABELS: Record<string, string> = {
  questions: '拆题',
  method: '选模',
  code: '代码',
  paper: '论文'
}

function initialPhases(): Record<number, PhaseView> {
  return Object.fromEntries(PHASE_ROWS.map((row) => [row.id, { label: row.label, status: 'idle' as const }]))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function runtimeText(status: RuntimeStatus): string {
  if (status.state === 'ready') return '运行时就绪'
  if (status.state === 'error') return '运行时错误'
  return '启动中'
}

export default function App(): JSX.Element {
  const [meta, setMeta] = useState<StudioMeta | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: 'starting' })
  const [providers, setProviders] = useState<ProviderList | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [problem, setProblem] = useState('')
  const [dataPaths, setDataPaths] = useState<string[]>([])
  const [running, setRunning] = useState(false)
  const [runId, setRunId] = useState<string | null>(null)
  const [phases, setPhases] = useState<Record<number, PhaseView>>(initialPhases)
  const [logs, setLogs] = useState<LogData[]>([])
  const [progress, setProgress] = useState('')
  const [done, setDone] = useState<DoneData | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [error, setError] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const active = providers?.providers.find((item) => item.id === providers.activeProvider) ?? null

  useEffect(() => {
    void window.studio.meta().then(setMeta)
    void window.studio.runtime.status().then(setRuntime)
    return window.studio.runtime.onStatus(setRuntime)
  }, [])

  useEffect(() => {
    if (runtime.state !== 'ready') return
    void window.studio.providers
      .list()
      .then(setProviders)
      .catch((err: unknown) => setError(errorText(err)))
  }, [runtime.state])

  useEffect(() => {
    return window.studio.run.onEvent((payload) => {
      if (payload.event === 'phase') {
        const data = payload.data as unknown as PhaseData
        setPhases((prev) => ({
          ...prev,
          [data.id]: { label: data.label, status: data.status, detail: data.detail }
        }))
      } else if (payload.event === 'log') {
        const data = payload.data as unknown as LogData
        setLogs((prev) => [...prev.slice(-400), { level: data.level, text: data.text }])
      } else if (payload.event === 'progress') {
        const data = payload.data as unknown as { stage?: string; chars?: number }
        if (data.stage) setProgress(`${data.stage} · ${data.chars ?? 0} 字`)
      } else if (payload.event === 'done') {
        const data = payload.data as unknown as DoneData
        setDone(data)
        setRunning(false)
        setRunId(null)
        setProgress('')
        if (!data.ok && data.error) setError(data.error)
      }
    })
  }, [])

  useEffect(() => {
    const element = logRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [logs, progress])

  useEffect(() => {
    const path = done?.outputs?.png
    if (!path) {
      setImage(null)
      return
    }
    let alive = true
    void window.studio.artifacts.image(path).then((url) => {
      if (alive) setImage(url)
    })
    return () => {
      alive = false
    }
  }, [done])

  async function pickProblem(): Promise<void> {
    try {
      const file = await window.studio.files.pickProblem()
      if (file) setProblem(file.text)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function pickData(): Promise<void> {
    try {
      const paths = await window.studio.files.pickData()
      if (paths.length) setDataPaths(paths.slice(0, 1))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function start(): Promise<void> {
    if (!active || running) return
    if (problem.trim().length < 10) {
      setError('先把题目写完整（至少一句描述）。')
      return
    }
    setError('')
    setDone(null)
    setImage(null)
    setLogs([])
    setProgress('')
    setPhases(initialPhases())
    setRunning(true)
    try {
      const result = await window.studio.run.start({
        problem: problem.trim(),
        dataPaths,
        providerId: active.id,
        model: active.model
      })
      setRunId(result.runId)
    } catch (err) {
      setRunning(false)
      setError(errorText(err))
    }
  }

  async function cancel(): Promise<void> {
    if (!runId) return
    try {
      await window.studio.run.cancel(runId)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function openArtifact(path?: string): Promise<void> {
    if (!path) return
    try {
      await window.studio.artifacts.open(path)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function revealArtifact(path?: string): Promise<void> {
    if (!path) return
    try {
      await window.studio.artifacts.reveal(path)
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">MM</span>
          <div>
            <h1>MathModel Studio</h1>
            <p>题面 → 选模 → 代码 → 论文</p>
          </div>
        </div>
        <div className="topbar-right">
          <button className="ghost" onClick={() => setSettingsOpen(true)}>
            设置 · {active?.display ?? '读取中'}
          </button>
          <span className={`pill ${runtime.state}`} title={runtime.message || ''}>
            {runtimeText(runtime)}
          </span>
        </div>
      </header>

      <main className="layout">
        <section className="panel">
          <header className="panel-head">
            <h2>赛题</h2>
            <span>粘贴题目，或导入文本文件</span>
          </header>
          <textarea
            className="problem"
            value={problem}
            onChange={(event) => setProblem(event.target.value)}
            placeholder="例如：某工厂有 200 条生产线，附件给出每条产线的温度、压力与产量记录。问题一：建立产量与温度、压力的关系模型并做预测……"
            spellCheck={false}
          />
          <div className="file-actions">
            <button className="ghost" onClick={pickProblem}>导入题面文件</button>
            <button className="ghost" onClick={pickData}>选择数据（CSV/TSV）</button>
          </div>
          {dataPaths.length > 0 && (
            <div className="chips">
              {dataPaths.map((path) => (
                <span className="chip" key={path} title={path}>
                  {baseName(path)}
                  <button
                    className="chip-x"
                    aria-label="移除数据文件"
                    onClick={() => setDataPaths((prev) => prev.filter((item) => item !== path))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <p className="hint">
            {active
              ? `当前服务商：${active.display} · ${active.model || '未设模型'}${
                  active.id === 'fake' ? '（离线模式：内置基线与样例论文）' : ''
                }`
              : '运行时启动后自动读取服务商。'}
          </p>
          <div className="actions">
            {running ? (
              <button className="danger" onClick={cancel}>取消运行</button>
            ) : (
              <button
                className="primary"
                onClick={start}
                disabled={!active || runtime.state !== 'ready'}
              >
                开始建模
              </button>
            )}
            {meta && <span className="version">v{meta.version}</span>}
          </div>
          {error && <p className="banner error">{error}</p>}
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>进度</h2>
            <span>{running ? '运行中' : done ? '已结束' : '等待开始'}</span>
          </header>
          <ol className="phases">
            {PHASE_ROWS.map((row) => {
              const view = phases[row.id] ?? { label: row.label, status: 'idle' as const }
              return (
                <li className={`phase ${view.status}`} key={row.id}>
                  <span className="phase-dot" />
                  <span className="phase-label">{view.label}</span>
                  <span className="phase-detail">{view.detail ?? ''}</span>
                </li>
              )
            })}
          </ol>
          <div className="log" ref={logRef}>
            {logs.length === 0 && !progress && <p className="empty">日志会随运行出现。</p>}
            {logs.map((line, index) => (
              <div className={`log-line ${line.level}`} key={index}>{line.text}</div>
            ))}
            {progress && <div className="log-progress">{progress}</div>}
          </div>
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>结果</h2>
            <span>{done?.seconds ? `${done.seconds}s` : done ? '完成' : '暂无'}</span>
          </header>
          {!done && <p className="empty">跑完一次，求解图与论文会出现在这里。</p>}
          {done && (
            <div className="result">
              <div className={`result-head ${done.ok ? 'ok' : 'error'}`}>
                <strong>{done.cancelled ? '已取消' : done.ok ? '运行完成' : '运行失败'}</strong>
                {done.picked && <span>方法：{done.picked}</span>}
              </div>
              {done.sources && (
                <div className="sources">
                  {Object.entries(done.sources).map(([key, value]) => (
                    <span key={key}>{SOURCE_LABELS[key] ?? key}：{value}</span>
                  ))}
                </div>
              )}
              {image && <img className="figure" src={image} alt="求解图" />}
              {done.outputs?.paperError && <p className="hint">{done.outputs.paperError}</p>}
              {!done.ok && done.error && <p className="banner error">{done.error}</p>}
              <div className="buttons">
                <button
                  className="ghost"
                  onClick={() => openArtifact(done.outputs?.paperPdf)}
                  disabled={!done.outputs?.paperPdf}
                >
                  打开 PDF
                </button>
                <button
                  className="ghost"
                  onClick={() => openArtifact(done.outputs?.paperDocx)}
                  disabled={!done.outputs?.paperDocx}
                >
                  打开 Word
                </button>
                <button
                  className="ghost"
                  onClick={() => revealArtifact(done.outputs?.dir)}
                  disabled={!done.outputs?.dir}
                >
                  结果文件夹
                </button>
              </div>
            </div>
          )}
        </section>
      </main>

      <SettingsDialog
        open={settingsOpen}
        providers={providers}
        onClose={() => setSettingsOpen(false)}
        onChanged={setProviders}
      />
    </div>
  )
}
