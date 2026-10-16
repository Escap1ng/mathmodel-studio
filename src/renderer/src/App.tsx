import { useEffect, useState } from 'react'
import ChatPane from './components/ChatPane'
import PhaseRail from './components/PhaseRail'
import WorkspacePane from './components/WorkspacePane'

// 类型由 src/preload/index.d.ts 声明的全局 window.studio 反推，
// 避免把依赖 electron 的 preload 源文件拉进渲染层类型图。
type StudioMeta = Awaited<ReturnType<typeof window.studio.meta>>

type Accent = 'a' | 'b' | 'c'
const ACCENTS: Record<Accent, string> = { a: '墨青', b: '靛蓝', c: '朱砂' }

function initialAccent(): Accent {
  const fromUrl = new URLSearchParams(window.location.search).get('accent')
  if (fromUrl === 'a' || fromUrl === 'b' || fromUrl === 'c') return fromUrl
  const saved = localStorage.getItem('studio.accent')
  return saved === 'b' || saved === 'c' ? saved : 'a'
}

export default function App() {
  const [meta, setMeta] = useState<StudioMeta | null>(null)
  const [accent, setAccent] = useState<Accent>(initialAccent)

  useEffect(() => {
    document.documentElement.dataset.accent = accent
    localStorage.setItem('studio.accent', accent)
  }, [accent])

  useEffect(() => {
    window.studio
      .meta()
      .then(setMeta)
      .catch(() => setMeta(null))
  }, [])

  // M2 起由 runtime 握手结果替换；M0 没有 Python 子进程，输入区就该是禁用的。
  const runtimeReady = false

  return (
    <div className="shell">
      <PhaseRail states={{}} />
      <ChatPane runtimeConnected={runtimeReady} />
      <WorkspacePane />
      <footer className="statusbar">
        <span>{meta ? `v${meta.version}` : '主进程未响应'}</span>
        <span>{runtimeReady ? 'runtime 已连接' : 'runtime 未连接'}</span>
        <span className="statusbar__spacer">强调色</span>
        <span className="swatches">
          {(Object.keys(ACCENTS) as Accent[]).map((key) => (
            <button
              key={key}
              className={`swatch swatch--${key}`}
              aria-pressed={accent === key}
              aria-label={ACCENTS[key]}
              title={ACCENTS[key]}
              onClick={() => setAccent(key)}
            />
          ))}
        </span>
        <span>{ACCENTS[accent]}</span>
        <span>{meta?.Electron ? `Electron ${meta.Electron}` : ''}</span>
      </footer>
    </div>
  )
}
