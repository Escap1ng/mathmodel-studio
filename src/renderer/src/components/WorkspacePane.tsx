import { useState } from 'react'

const TABS = [
  { id: 'figure', label: '图表', empty: '300 DPI 的 PNG / PDF / SVG 会在这里并排预览，可换模板、换主题、回滚上一版。' },
  { id: 'paper', label: '论文', empty: '论文 PDF 与 Word 文档的页级预览在这里；正文数字可点回产出它的脚本。' },
  { id: 'code', label: '代码', empty: '按问题编号命名的代码文件与运行输出。' },
  { id: 'score', label: '评分', empty: '五维评分（摘要 30 / 算法模型 20 / 创新性 20 / 写作 15 / 排版 15）与扣分明细。' },
  { id: 'gate', label: '门禁', empty: '降 AI 三道检查与章节结构门槛的结果；未过项可点进具体那一句。' },
  { id: 'log', label: '日志', empty: '技能脚本的调用、退出码与错误输出。' }
] as const

export default function WorkspacePane() {
  const [active, setActive] = useState<(typeof TABS)[number]['id']>('figure')
  const current = TABS.find((t) => t.id === active)!

  return (
    <aside className="workspace" aria-label="工作台">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            className="tab"
            aria-selected={t.id === active}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="workspace__body" role="tabpanel">
        <div className="card">{current.empty}</div>
      </div>
    </aside>
  )
}
