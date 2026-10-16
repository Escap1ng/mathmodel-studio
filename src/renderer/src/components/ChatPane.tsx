interface Props {
  runtimeConnected: boolean
}

export default function ChatPane({ runtimeConnected }: Props) {
  return (
    <section className="chat" aria-label="对话">
      <div className="chat__stream">
        <div className="chat__column">
          <p className="chat__lead">把赛题丢进来，或者粘贴题目正文。</p>
          <p>
            对话流、选模卡、门禁结果与评分明细都会出现在这一列；右侧工作台放图、论文、代码与日志。
          </p>
        </div>
      </div>
      <div className="chat__composer">
        <div className="composer">
          <textarea
            className="composer__input"
            placeholder={runtimeConnected ? '描述这道题，或上传附件' : '运行时未连接'}
            disabled={!runtimeConnected}
          />
          <div className="composer__bar">
            <span className="pill" title="M2 接入 provider 注册表后可选">
              未选择模型
            </span>
            <span className="pill">阶段零 · 待开始</span>
            <button className="pill pill--send" disabled={!runtimeConnected} title="M2 起接 runtime">
              发送
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
