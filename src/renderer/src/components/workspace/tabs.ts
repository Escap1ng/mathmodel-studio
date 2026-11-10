export const TABS = [
  { id: 'process', label: '总览', icon: '览' },
  { id: 'figure', label: '图表', icon: '图' },
  { id: 'paper', label: '论文', icon: '论' },
  { id: 'code', label: '代码', icon: '码' },
  { id: 'score', label: '评分', icon: '评' },
  { id: 'gate', label: '门禁', icon: '门' },
  { id: 'log', label: '日志', icon: '志' },
  { id: 'files', label: '文件', icon: '件' }
] as const
export type TabId = (typeof TABS)[number]['id']

/** 通用模式只留文件页；数模模式恢复全量标签。 */
export function tabsForMode(mode: 'workflow' | 'chat'): (typeof TABS)[number][] {
  return mode === 'chat' ? TABS.filter((tab) => tab.id === 'files') : [...TABS]
}

export const TAB_GROUPS: { label: string; ids: TabId[] }[] = [
  { label: '过程', ids: ['process'] },
  { label: '产出', ids: ['figure', 'paper', 'code'] },
  { label: '评审', ids: ['score', 'gate'] },
  { label: '资料', ids: ['log', 'files'] }
]
