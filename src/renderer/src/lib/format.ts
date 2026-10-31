export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 会话列表只显示粗略时间：刚刚 / N 分钟前 / 今天 HH:mm / 昨天 / MM-DD。 */
export function formatAgo(ms: number, now = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const date = new Date(ms)
  const today = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === today.toDateString()) return `今天 ${hm}`
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
