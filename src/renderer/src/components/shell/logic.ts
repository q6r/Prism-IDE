/** Literal search offsets preserve source indices even for Unicode case folds. */
export function matchRanges(text: string, query: string, caseSensitive: boolean): { start: number; end: number }[] {
  if (!query) return []
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu')
  return Array.from(text.matchAll(expression), (match) => ({ start: match.index, end: match.index + match[0].length }))
}

export function relativeTime(ms: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60000)
  if (minutes < 1) return 'agora'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  return new Date(ms).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

export function workspacePathKey(path: string | null): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Quick-open score: consecutive characters outrank scattered subsequences. */
export function fuzzyScore(query: string, text: string): number {
  if (query === '') return 1
  const target = text.toLowerCase()
  let position = 0
  let score = 0
  let streak = 0
  for (const character of query.toLowerCase()) {
    const index = target.indexOf(character, position)
    if (index === -1) return -1
    streak = index === position ? streak + 1 : 0
    score += index === position ? 3 + streak : 1
    position = index + character.length
  }
  return score
}

/** Blank SSH ports use the default; non-integer/out-of-range values are invalid. */
export function sshPort(value: string): number | null {
  if (!value.trim()) return 22
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

export interface AttentionItem { id: string; title: string; kind: 'permission' | 'question' }

/** Transcript/turn/runtime deltas that do not change attention leave this key stable. */
export function attentionKey(chats: readonly { id: string; title?: string }[], runtime: Record<string, { permission?: unknown; question?: unknown }>): string {
  const items: AttentionItem[] = []
  for (const chat of chats) {
    const run = runtime[chat.id]
    if (run?.permission || run?.question) items.push({ id: chat.id, title: chat.title || 'Conversa', kind: run.permission ? 'permission' : 'question' })
  }
  return JSON.stringify(items)
}

/** saveTab may report failure through a toast; never discard a still-dirty file. */
export async function saveBeforeClose(path: string, actions: {
  save: (path: string) => Promise<void>
  isSaved: (path: string) => boolean
  close: (path: string) => void
}): Promise<void> {
  await actions.save(path)
  if (!actions.isSaved(path)) throw new Error('Não foi possível salvar o arquivo. Suas alterações continuam abertas.')
  actions.close(path)
}
