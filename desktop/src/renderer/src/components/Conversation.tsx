import { useEffect, useState, type JSX } from 'react'
import type { Conversation } from '../lib/store'
import RunView, { type LiveRun } from './RunView'

interface Props {
  conversation: Conversation
  live?: LiveRun
  providerLabel: string
  runtimeReady: boolean
  onSend: (problem: string, dataPaths: string[]) => void
  onCancel: () => void
  onOpen: (path?: string) => void
  onReveal: (path?: string) => void
  onNewConversation: () => void
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

export default function Conversation(props: Props): JSX.Element {
  const { conversation } = props
  const [problem, setProblem] = useState(conversation.problem)
  const [dataPaths, setDataPaths] = useState<string[]>(conversation.dataPaths)
  const [error, setError] = useState('')

  useEffect(() => {
    setProblem(conversation.problem)
    setDataPaths(conversation.dataPaths)
    setError(conversation.error ?? '')
  }, [conversation.id, conversation.error])

  async function pickProblem(): Promise<void> {
    try {
      const file = await window.studio.files.pickProblem()
      if (file) setProblem(file.text)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function pickData(): Promise<void> {
    try {
      const paths = await window.studio.files.pickData()
      if (paths.length) setDataPaths((prev) => [...new Set([...prev, ...paths])].slice(0, 10))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function send(): void {
    if (problem.trim().length < 10) {
      setError('先把题目写完整（至少一句描述）。')
      return
    }
    setError('')
    props.onSend(problem.trim(), dataPaths)
  }

  const idle = conversation.status === 'idle'
  const running = conversation.status === 'running'

  return (
    <div className="conversation">
      <div className="thread">
        {conversation.problem && (
          <div className="msg user">
            <div className="msg-body">{conversation.problem}</div>
            {conversation.dataPaths.length > 0 && (
              <div className="chips">
                {conversation.dataPaths.map((path) => (
                  <span className="chip" key={path} title={path}>{baseName(path)}</span>
                ))}
              </div>
            )}
          </div>
        )}
        {(conversation.runId || props.live || conversation.status !== 'idle') && (
          <div className="msg assistant">
            <RunView
              live={props.live}
              conversation={conversation}
              onOpen={props.onOpen}
              onReveal={props.onReveal}
            />
          </div>
        )}
        {idle && !conversation.problem && (
          <p className="thread-hint">写下赛题开始一次建模；一个对话对应一次完整运行。</p>
        )}
      </div>

      {idle || running ? (
        <div className="composer">
          <textarea
            className="composer-input"
            value={problem}
            onChange={(event) => setProblem(event.target.value)}
            placeholder="粘贴赛题，或导入文本文件……"
            disabled={running}
            spellCheck={false}
          />
          {dataPaths.length > 0 && (
            <div className="chips">
              {dataPaths.map((path) => (
                <span className="chip" key={path} title={path}>
                  {baseName(path)}
                  <button className="chip-x" onClick={() => setDataPaths((prev) => prev.filter((item) => item !== path))}>×</button>
                </span>
              ))}
            </div>
          )}
          <div className="composer-bar">
            <button className="ghost small" onClick={pickProblem} disabled={running}>导入题面</button>
            <button className="ghost small" onClick={pickData} disabled={running}>附件</button>
            <span className="composer-provider">{props.providerLabel}</span>
            {running ? (
              <button className="danger small" onClick={props.onCancel}>取消</button>
            ) : (
              <button className="primary small" onClick={send} disabled={!props.runtimeReady}>开始建模</button>
            )}
          </div>
          {error && <p className="banner error">{error}</p>}
        </div>
      ) : (
        <div className="composer done-bar">
          <button className="ghost small" onClick={props.onNewConversation}>新对话</button>
        </div>
      )}
    </div>
  )
}
