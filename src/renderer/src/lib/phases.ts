export interface PhaseDef {
  num: number
  label: string
  name: string
}

/** 阶段零～六取自上游 mathmodel-core 的强制流程名。
 * M3 接上注册表后，这份常量由 runtime 经 IPC 提供，界面不再内置技能清单。 */
export const PHASES: PhaseDef[] = [
  { num: 0, label: '零', name: '环境预检' },
  { num: 1, label: '一', name: '赛题分析与背景调研' },
  { num: 2, label: '二', name: '工作目录创建' },
  { num: 3, label: '三', name: '算法选择' },
  { num: 4, label: '四', name: '代码实现' },
  { num: 5, label: '五', name: '论文输出' },
  { num: 6, label: '六', name: '评分与优化' }
]

export type PhaseState = 'idle' | 'running' | 'waiting' | 'passed' | 'failed'

export const STATE_TEXT: Record<PhaseState, string> = {
  idle: '未开始',
  running: '进行中',
  waiting: '等你确认',
  passed: '已过门禁',
  failed: '未过'
}
