/** One URL, explicitly selected existing per-chat grants. Secrets stay in the fragment. */
export interface RemoteLinkChat { tabId: string; title: string; token: string }
export const MAX_REMOTE_CHATS = 24
export function remoteLink(baseUrl: string, chats: readonly RemoteLinkChat[], activeId?: string): string {
  if (!chats.length) return ''
  const first = chats.find(c => c.tabId === activeId) ?? chats[0]
  const params = new URLSearchParams({ t: first.token, c: first.tabId })
  if (chats.length > 1) params.set('sessions', JSON.stringify(chats.slice(0, MAX_REMOTE_CHATS)))
  return `${baseUrl.replace(/\/$/, '')}/#${params}`
}
export function parseRemoteLink(hash: string): { chats: RemoteLinkChat[]; activeId: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const activeId = params.get('c') ?? ''
  const chats: RemoteLinkChat[] = []
  try {
    const rows: unknown = JSON.parse(params.get('sessions') ?? '[]')
    if (Array.isArray(rows)) for (const row of rows.slice(0, MAX_REMOTE_CHATS)) {
      if (row && typeof row.tabId === 'string' && row.tabId && typeof row.token === 'string' && row.token
        && !chats.some(c => c.tabId === row.tabId)) chats.push({ tabId: row.tabId, token: row.token, title: typeof row.title === 'string' ? row.title : 'Chat' })
    }
  } catch { /* A damaged collection still opens the legacy single-chat grant. */ }
  if (!chats.length && params.get('t')) chats.push({ tabId: activeId, token: params.get('t')!, title: 'Chat' })
  return { chats, activeId: chats.some(c => c.tabId === activeId) ? activeId : chats[0]?.tabId ?? '' }
}
