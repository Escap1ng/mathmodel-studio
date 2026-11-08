import DropZone from './DropZone'
import type { StagedFile } from '../../../../shared/api'

const CHAT_PROMPTS = [
  '什么问题适合灰色预测 GM(1,1)？举两个例子',
  '蒙特卡洛模拟的基本步骤和适用场景',
  '写个 Python 脚本：读取 Excel 两列并画趋势图',
  '线性规划和整数规划怎么选？'
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
          {mode === 'workflow' ? '把赛题贴进来' : '今天做哪道题'}
        </h1>
        <p className="welcome__lead">
          {mode === 'workflow'
            ? '直接粘贴题目正文，或把文件拖进下面的框；完全不会的地方先说「帮我理解这道题」。'
            : '先随便聊，聊明白再投进全流程建模也不迟。'}
        </p>
      </div>
      <DropZone
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
            进入全流程建模 →
          </button>
        </>
      ) : null}
    </div>
  )
}
