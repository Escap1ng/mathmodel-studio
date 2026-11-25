import { useEffect, useRef, useState, type JSX } from 'react'
import type { DoneData, LogData } from '../../../shared/api'
import type { Conversation } from '../lib/store'

export interface PhaseView {
  label: string
  status: 'idle' | 'running' | 'ok' | 'error'
  detail?: string
}

export interface LiveRun {
  phases: Record<number, PhaseView>
  logs: LogData[]
  progress: string
  done: DoneData | null
}

export const PHASE_ROWS = [
  { id: 1, label: '题面拆解' },
  { id: 2, label: '方法选择' },
  { id: 3, label: '生成代码' },
  { id: 4, label: '运行求解' },
  { id: 5, label: '论文排版' }
]

export function initialPhases(): Record<number, PhaseView> {
  return Object.fromEntries(PHASE_ROWS.map((row) => [row.id, { label: row.label, status: 'idle' as const }]))
}

const SOURCE_LABELS: Record<string, string> = {
  questions: '拆题',
  method: '选模',
  code: '代码',
  paper: '论文'
}

interface Props {
  live?: LiveRun
  conversation: Conversation
  onOpen: (path?: string) => void
  onReveal: (path?: string) => void
}

export default function RunView({ live, conversation, onOpen, onReveal }: Props): JSX.Element {
  const done = live?.done ?? null
  const outputs = done?.outputs ?? conversation.outputs
  const picked = done?.picked ?? conversation.picked
  const sources = done?.sources ?? conversation.sources
  const seconds = done?.seconds ?? conversation.seconds
  const failed = done ? !done.ok : conversation.status === 'error'
  const error = done?.error ?? conversation.error
  const [image, setImage] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const path = outputs?.png
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
  }, [outputs?.png])

  useEffect(() => {
    const element = logRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [live?.logs, live?.progress])

  return (
    <div className="run">
      {live && (
        <>
          <ol className="phases">
            {PHASE_ROWS.map((row) => {
              const view = live.phases[row.id] ?? { label: row.label, status: 'idle' as const }
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
            {live.logs.map((line, index) => (
              <div className={`log-line ${line.level}`} key={index}>{line.text}</div>
            ))}
            {live.progress && <div className="log-progress">{live.progress}</div>}
          </div>
        </>
      )}

      {(outputs || failed) && (
        <div className="result">
          <div className={`result-head ${failed ? 'error' : 'ok'}`}>
            <strong>{conversation.status === 'running' && !done ? '运行中' : failed ? '运行失败' : '运行完成'}</strong>
            {seconds ? <span>{seconds}s</span> : null}
          </div>
          {picked && <p className="result-method">方法：{picked}</p>}
          {sources && (
            <div className="sources">
              {Object.entries(sources).map(([key, value]) => (
                <span key={key}>{SOURCE_LABELS[key] ?? key}：{value}</span>
              ))}
            </div>
          )}
          {image && <img className="figure" src={image} alt="求解图" />}
          {outputs?.paperError && <p className="hint">{outputs.paperError}</p>}
          {failed && error && <p className="banner error">{error}</p>}
          <div className="buttons">
            <button className="ghost" onClick={() => onOpen(outputs?.paperPdf)} disabled={!outputs?.paperPdf}>打开 PDF</button>
            <button className="ghost" onClick={() => onOpen(outputs?.paperDocx)} disabled={!outputs?.paperDocx}>打开 Word</button>
            <button className="ghost" onClick={() => onReveal(outputs?.dir)} disabled={!outputs?.dir}>结果文件夹</button>
          </div>
        </div>
      )}
    </div>
  )
}
