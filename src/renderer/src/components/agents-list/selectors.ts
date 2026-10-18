import type { UnifiedChat } from '../../../../shared/agents'

/** What a list row needs from a chat - no turns, so streaming output never touches it. */
export interface ChatRow {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly createdAt?: number
  readonly archived?: boolean
  readonly parentChatId?: string
  readonly taskId?: string
  readonly sourceHarness?: string
  readonly readOnly?: boolean
  readonly fromTraycer?: boolean
  readonly nativeAgent?: boolean
  readonly nativeStatus?: NonNullable<UnifiedChat['nativeAgent']>['status']
  readonly cwd: string
  readonly remoteId?: string
  readonly selection: { readonly provider: string }
}

const cache = new Map<string, ChatRow>()
function sameRow(row: ChatRow, c: UnifiedChat): boolean {
  return row.title === c.title && row.updatedAt === c.updatedAt && row.createdAt === c.createdAt && row.archived === c.archived
    && row.parentChatId === c.parentChatId && row.taskId === c.taskId && row.sourceHarness === c.sourceHarness && row.readOnly === c.readOnly
    && row.fromTraycer === !!c.traycerSource && row.nativeAgent === !!c.nativeAgent && row.nativeStatus === c.nativeAgent?.status
    && row.cwd === c.cwd && row.remoteId === c.remoteId && row.selection.provider === c.selection.provider
}

/**
 * Chat rows with stable identity: an unchanged chat yields the very same row
 * object, so `useShallow(s => chatRows(s.chats))` re-renders the list only
 * when a row actually changed - not on every 40ms streaming flush.
 */
export function chatRows(chats: readonly UnifiedChat[]): ChatRow[] {
  if (cache.size > chats.length * 2 + 64) for (const id of cache.keys()) if (!chats.some((c) => c.id === id)) cache.delete(id)
  return chats.map((c) => {
    const prev = cache.get(c.id)
    if (prev && sameRow(prev, c)) return prev
    const row: ChatRow = { id: c.id, title: c.title, updatedAt: c.updatedAt, createdAt: c.createdAt, archived: c.archived, parentChatId: c.parentChatId,
      taskId: c.taskId, sourceHarness: c.sourceHarness, readOnly: c.readOnly, fromTraycer: !!c.traycerSource, nativeAgent: !!c.nativeAgent, nativeStatus: c.nativeAgent?.status, cwd: c.cwd, remoteId: c.remoteId, selection: { provider: c.selection.provider } }
    cache.set(c.id, row)
    return row
  })
}
