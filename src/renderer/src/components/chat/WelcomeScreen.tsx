import DropZone from './DropZone'
import type { StagedFile } from '../../../../shared/api'

const CHAT_PROMPTS = [
  '帮我把这段话改写得更清楚',
  '列出两种方案，比较成本与风险',
  '解释一个概念，并给个生活里的例子',
  '把这份表格的要点总结成三条'
]

interface Props {
  mode: 'workflow' | 'chat'
  files: StagedFile[]
  rejected: string[]
  failure: string | null
  dragging: boolean
  busy: boolean
  onPick: () => void
  onRemove: (file: StagedFile) => void
  onReveal: () => void
  onSend: (text: string) => void
  onEnterWorkflow: () => void
}

export default function WelcomeScreen({
  mode,
  files,
  rejected,
  failure,
  dragging,
  busy,
  onPick,
  onRemove,
  onReveal,
  onSend,
  onEnterWorkflow
}: Props) {
  return (
    <div className="welcome">
      <div className="welcome__intro">
        <h1 className="welcome__title">
          {mode === 'workflow' ? '把赛题贴进来' : '今天聊点什么'}
        </h1>
        <p className="welcome__lead">
          {mode === 'workflow'
            ? '直接粘贴题目正文，或把文件拖进下面的框；完全不会的地方先说「帮我理解这道题」。'
            : '问答、写作、分析都可以；要跑建模全流程时，切到「数模」。'}
        </p>
      </div>
      <DropZone
        mode={mode}
        files={files}
        rejected={rejected}
        failure={failure}
        dragging={dragging}
        busy={busy}
        onPick={onPick}
        onRemove={onRemove}
        onReveal={onReveal}
      />
      {mode === 'chat' ? (
        <>
          <div className="welcome__chips" role="list" aria-label="快捷提问">
            {CHAT_PROMPTS.map((prompt) => (
              <button
                type="button"
                className="welcome__chip"
                role="listitem"
                key={prompt}
                onClick={() => onSend(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="welcome__tour"
            data-action="enter-workflow"
            onClick={onEnterWorkflow}
          >
            进入数模模式 →
          </button>
        </>
      ) : null}
    </div>
  )
}
