/**
 * Markdown 流式切分的纯函数：找出所有「可安全切开的空行」位置。
 * 安全 = 不落进未闭合的 ``` 围栏里，且切点前一行不是列表/引用/表格的续行，
 * 否则把同一个块锯成两半会让编号重开、表格断列。
 */
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s/

export function chunkBoundaries(text: string): number[] {
  const bounds: number[] = []
  let search = 0
  for (;;) {
    const hit = text.indexOf('\n\n', search)
    if (hit < 0) return bounds
    const prefix = text.slice(0, hit)
    if (((prefix.match(/^\s*```/gm) ?? []).length) % 2 === 1) {
      search = hit + 2
      continue
    }
    const lines = prefix.split('\n')
    const last = lines[lines.length - 1]
    if (!(LIST_RE.test(last) || last.startsWith('>') || last.startsWith('|'))) bounds.push(hit)
    search = hit + 2
  }
}

export function chunkAt(text: string, start: number, end?: number): string {
  return text.slice(start, end).trim()
}
