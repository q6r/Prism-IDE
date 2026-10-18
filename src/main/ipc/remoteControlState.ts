// Pure bookkeeping for the remote-control server (no Electron / network
// imports, so tests load it directly): per-chat access tokens and the
// per-turn delta sent to phones instead of the whole chat on every change.

/**
 * One secret per shared chat. A link carries its chat's token, and the server
 * scopes that socket to that chat alone: it can neither read nor command any
 * other shared chat. Revoking (stop sharing) makes the token useless at once;
 * sharing again mints a new one.
 */
export class ChatGrants {
  private readonly byToken = new Map<string, string>()
  private readonly byChat = new Map<string, string>()

  /** The chat's token, minted on first grant and kept while it stays shared. */
  grant(tabId: string, mint: () => string): string {
    const existing = this.byChat.get(tabId)
    if (existing) return existing
    let token = mint()
    while (this.byToken.has(token)) token = mint()
    this.byToken.set(token, tabId)
    this.byChat.set(tabId, token)
    return token
  }

  /** Drops the chat's token; returns it (or undefined when it was not shared). */
  revoke(tabId: string): string | undefined {
    const token = this.byChat.get(tabId)
    if (token === undefined) return undefined
    this.byChat.delete(tabId)
    this.byToken.delete(token)
    return token
  }

  chatFor(token: string | null | undefined): string | undefined {
    return token ? this.byToken.get(token) : undefined
  }

  has(tabId: string): boolean {
    return this.byChat.has(tabId)
  }

  get size(): number {
    return this.byChat.size
  }

  clear(): void {
    this.byToken.clear()
    this.byChat.clear()
  }
}

export interface TurnLike { id: string; pendingPerm?: unknown; pendingQuestion?: unknown }
export interface SnapshotLike { tabId: string; title: string; streaming: boolean; contextPct: number; turns: TurnLike[] }

/** Serialized turns of the last snapshot sent, by turn id. */
export type TurnCache = Map<string, string>

export interface SnapshotDelta {
  /** Anything the phone should hear about at all. */
  changed: boolean
  /** Title / streaming / context changed. */
  metaChanged: boolean
  /** Turn ids in order (always sent so the phone can drop and reorder). */
  ids: string[]
  /** Only the turns that are new or differ from the last send. */
  turns: TurnLike[]
  /** The cache to keep for the next diff. */
  cache: TurnCache
}

/**
 * Diffs a new snapshot against what was last sent. During streaming only the
 * running turn changes, so a delta carries one turn instead of the whole chat.
 */
export function snapshotDelta(prev: SnapshotLike | undefined, prevCache: TurnCache | undefined, next: SnapshotLike): SnapshotDelta {
  const cache: TurnCache = new Map()
  const turns: TurnLike[] = []
  for (const turn of next.turns) {
    const json = JSON.stringify(turn)
    cache.set(turn.id, json)
    if (prevCache?.get(turn.id) !== json) turns.push(turn)
  }
  const ids = next.turns.map((t) => t.id)
  const idsChanged = !prev || prev.turns.length !== ids.length || prev.turns.some((t, i) => t.id !== ids[i])
  const extra = (snap: SnapshotLike): string => JSON.stringify([ (snap as any).selection, (snap as any).queued, (snap as any).queuePaused ])
  const metaChanged = !prev || extra(prev) !== extra(next) || prev.title !== next.title || prev.streaming !== next.streaming || prev.contextPct !== next.contextPct
  return { changed: metaChanged || idsChanged || turns.length > 0, metaChanged, ids, turns, cache }
}

export interface ChatListEntry { tabId: string; title: string; streaming: boolean; pending: boolean }

/** What the phone's chat list shows for one chat. */
export function listEntry(snap: SnapshotLike): ChatListEntry {
  return {
    tabId: snap.tabId,
    title: snap.title,
    streaming: snap.streaming,
    pending: snap.turns.some((t) => !!t.pendingPerm || !!t.pendingQuestion)
  }
}

export function sameEntry(a: ChatListEntry | undefined, b: ChatListEntry): boolean {
  return !!a && a.title === b.title && a.streaming === b.streaming && a.pending === b.pending
}
