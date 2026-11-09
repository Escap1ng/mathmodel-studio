import type { FigureVersion, ScoreRound, WorkbenchState } from '../../../../shared/api'

export function findVersion(state: WorkbenchState | null, id: string | null): FigureVersion | undefined {
  return state?.figure.versions.find((version) => version.id === id)
}

export function verdictText(round: ScoreRound): string {
  if (round.veto) return '一票否决'
  return round.pass ? '达标' : '需优化'
}

export const DIM_SHORT: Record<string, string> = {
  abstract: '摘要',
  model: '模型',
  innovation: '创新',
  writing: '写作',
  layout: '排版'
}
