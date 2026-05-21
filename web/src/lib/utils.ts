export function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const diff = now.getTime() - ts

  if (diff < 60_000) return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`

  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export function groupByDate(items: { timestamp: number }[]): Map<string, typeof items> {
  const map = new Map<string, typeof items>()
  for (const item of items) {
    const key = new Date(item.timestamp).toLocaleDateString('zh-CN')
    const arr = map.get(key) || []
    arr.push(item)
    map.set(key, arr)
  }
  return map
}
