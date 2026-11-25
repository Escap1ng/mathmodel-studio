import type { JSX } from 'react'

const EXAMPLE =
  '某工厂有 120 条生产线，附件给出每条产线的温度、压力与产量记录。问题一：建立产量与温度、压力的关系模型并做预测；问题二：分析异常产线并给出改进建议；问题三：评估模型稳健性。'

interface Props {
  onNewConversation: () => void
  onExample: (problem: string) => void
}

export default function Welcome({ onNewConversation, onExample }: Props): JSX.Element {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>把赛题变成可交付的论文</h1>
        <p className="welcome-sub">
          本地一键流水线：拆题 → 选模 → 生成并运行求解代码 → 按真实结果写论文、排 PDF/Word。
        </p>
        <ol className="welcome-steps">
          <li><b>粘贴或导入赛题</b><span>支持 txt / md / tex，或直接在输入框写题目。</span></li>
          <li><b>附上数据（可选）</b><span>CSV / TSV；不附数据时用内置样例跑通链路。</span></li>
          <li><b>开始建模</b><span>自动选模、写代码、运行与修复，全程进度可见。</span></li>
          <li><b>查看交付物</b><span>求解图、result.json、paper.pdf / paper.docx。</span></li>
        </ol>
        <p className="welcome-note">
          离线模式可先跑通；在设置里配置 DeepSeek 等服务商 Key 后，按本题真实生成。
        </p>
        <div className="welcome-actions">
          <button className="primary" onClick={onNewConversation}>新建对话</button>
          <button className="ghost" onClick={() => onExample(EXAMPLE)}>试用示例</button>
        </div>
      </div>
    </div>
  )
}
