// Pure logic behind the agents list (Traycer's epic sidebar "Agents" panel),
// the task tab strip and the run monitor. No React, no stores: everything here
// is data in, data out, so it can be unit tested in Node.
import type { AgentTask, SharedTurn, UnifiedChat } from '../../../../shared/agents'

/* ---------------- View: ordering, visibility, filters ---------------- */

export type SortField = 'updated' | 'created' | 'name'
export type SortDirection = 'desc' | 'asc'
export interface SortMode { readonly field: SortField; readonly direction: SortDirection }
export type ArchiveVisibility = 'unarchived' | 'archived' | 'all'
export type HarnessFilter = 'all' | 'claude' | 'codex'
export interface AgentView { readonly sort: SortMode; readonly archive: ArchiveVisibility; readonly harness: HarnessFilter }

export const DEFAULT_SORT: SortMode = { field: 'updated', direction: 'desc' }
export const DEFAULT_VIEW: AgentView = { sort: DEFAULT_SORT, archive: 'unarchived', harness: 'all' }

export const SORT_FIELDS: readonly SortField[] = ['updated', 'created', 'name']
export const SORT_FIELD_LABELS: Readonly<Record<SortField, string>> = { updated: 'Última atualização', created: 'Data de criação', name: 'Nome' }
export const ARCHIVE_OPTIONS: readonly { readonly value: ArchiveVisibility; readonly label: string }[] = [
  { value: 'unarchived', label: 'Somente não arquivados' },
  { value: 'archived', label: 'Somente arquivados' },
  { value: 'all', label: 'Todos os chats' }
]
export const HARNESS_OPTIONS: readonly { readonly value: HarnessFilter; readonly label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' }
]

export function isSortActive(sort: SortMode): boolean {
  return sort.field !== DEFAULT_SORT.field || sort.direction !== DEFAULT_SORT.direction
}
/** Facet filters only; ordering and visibility carry no count badge. */
export function filterCount(view: AgentView): number {
  return view.harness === 'all' ? 0 : 1
}
export function isViewActive(view: AgentView): boolean {
  return filterCount(view) > 0 || isSortActive(view.sort) || view.archive !== DEFAULT_VIEW.archive
}
export function sortSummary(sort: SortMode): string {
  return `${SORT_FIELD_LABELS[sort.field]} ${sort.direction === 'asc' ? '↑' : '↓'}`
}
export function archiveLabel(visibility: ArchiveVisibility): string {
  return ARCHIVE_OPTIONS.find((o) => o.value === visibility)?.label ?? ARCHIVE_OPTIONS[0].label
}
export function harnessLabel(harness: HarnessFilter): string {
  return HARNESS_OPTIONS.find((o) => o.value === harness)?.label ?? 'Todos'
}
/** Accessible name of the view-menu trigger: says everything the view is doing (viewTriggerLabel). */
export function viewTriggerLabel(view: AgentView): string {
  const details: string[] = []
  const count = filterCount(view)
  if (count > 0) details.push(`${count} ${count === 1 ? 'filtro ativo' : 'filtros ativos'}`)
  if (isSortActive(view.sort)) details.push(`ordenado por ${SORT_FIELD_LABELS[view.sort.field]} ${view.sort.direction === 'asc' ? 'crescente' : 'decrescente'}`)
  if (view.archive !== DEFAULT_VIEW.archive) details.push(`mostrando ${archiveLabel(view.archive).toLocaleLowerCase('pt-BR')}`)
  return details.length ? `Filtrar agentes, ${details.join(', ')}` : 'Filtrar agentes'
}
/** Reads a persisted view, falling back field by field so a stale value never breaks the list. */
export function parseView(raw: unknown): AgentView {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AgentView, unknown>>
  const sort = (v.sort && typeof v.sort === 'object' ? v.sort : {}) as Partial<Record<keyof SortMode, unknown>>
  return {
    sort: {
      field: SORT_FIELDS.includes(sort.field as SortField) ? sort.field as SortField : DEFAULT_SORT.field,
      direction: sort.direction === 'asc' || sort.direction === 'desc' ? sort.direction : DEFAULT_SORT.direction
    },
    archive: ARCHIVE_OPTIONS.some((o) => o.value === v.archive) ? v.archive as ArchiveVisibility : DEFAULT_VIEW.archive,
    harness: HARNESS_OPTIONS.some((o) => o.value === v.harness) ? v.harness as HarnessFilter : DEFAULT_VIEW.harness
  }
}

/** Per-task views (Traycer keeps the Agents view per epic), read back field by field; invalid entries are dropped. */
export function parseViews(raw: unknown): Record<string, AgentView> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw).filter(([id, v]) => !!id && !!v && typeof v === 'object' && !Array.isArray(v)).map(([id, v]) => [id, parseView(v)]))
}
/** A task's view; a task never configured starts from `fallback` (the default view). */
export function viewFor(views: Readonly<Record<string, AgentView>>, taskId: string | null | undefined, fallback: AgentView = DEFAULT_VIEW): AgentView {
  return (taskId && views[taskId]) || fallback
}
/** Stores a task's view; one back at the default is dropped instead of kept, so storage only holds real choices. */
export function withView(views: Readonly<Record<string, AgentView>>, taskId: string, view: AgentView, fallback: AgentView = DEFAULT_VIEW): Record<string, AgentView> {
  const next = { ...views }
  if (JSON.stringify(view) === JSON.stringify(fallback)) delete next[taskId]
  else next[taskId] = view
  return next
}

/* ---------------- Search ---------------- */

/** Case- and accent-insensitive form used by every search box here. */
export function normalizeSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR').trim()
}
/** Every whitespace-separated term of `query` must appear in `text`. */
export function matchesQuery(text: string, query: string): boolean {
  const terms = normalizeSearch(query).split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  const haystack = normalizeSearch(text)
  return terms.every((t) => haystack.includes(t))
}

/* ---------------- Chat list selection ---------------- */

type ChatLike = Pick<UnifiedChat, 'id' | 'title' | 'updatedAt' | 'createdAt' | 'archived' | 'parentChatId' | 'taskId' | 'sourceHarness'> & { selection: { provider: string } }

/** The harness a row stands for: an imported record keeps its source harness. */
export function harnessOf(chat: { sourceHarness?: string; selection: { provider: string } }): string {
  return chat.sourceHarness || chat.selection.provider
}
function harnessMatches(chat: ChatLike, filter: HarnessFilter): boolean {
  if (filter === 'all') return true
  const h = harnessOf(chat).toLowerCase()
  return filter === 'codex' ? h === 'codex' : h === 'claude' || h === 'claude-code'
}
export function compareChats(sort: SortMode): (a: ChatLike, b: ChatLike) => number {
  const dir = sort.direction === 'asc' ? 1 : -1
  return (a, b) => {
    // Chats saved before `createdAt` existed fall back to their last update.
    const primary = sort.field === 'name' ? a.title.localeCompare(b.title, 'pt-BR', { sensitivity: 'base', numeric: true })
      : sort.field === 'created' ? (a.createdAt ?? a.updatedAt) - (b.createdAt ?? b.updatedAt)
      : a.updatedAt - b.updatedAt
    return primary * dir || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  }
}
/** Keeps every ancestor of a kept row, so a nested match never floats loose (withChatAncestors). */
export function withAncestors<T extends { id: string; parentChatId?: string }>(items: readonly T[], keep: (item: T) => boolean): T[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const kept = new Set(items.filter(keep).map((i) => i.id))
  for (const id of [...kept]) {
    const seen = new Set([id])
    let parent = byId.get(id)?.parentChatId
    while (parent && !seen.has(parent) && byId.has(parent)) { seen.add(parent); kept.add(parent); parent = byId.get(parent)?.parentChatId }
  }
  return items.filter((i) => kept.has(i.id))
}
/**
 * Rows hidden by the archive visibility (useSidebarArchiveHiddenIds):
 * - unarchived only: every archived row AND its whole subtree, except the path
 *   down to a row that is open, working or unread (revealArchiveHiddenIds);
 * - archived only: everything but the archived rows and their ancestors, kept
 *   as tree context;
 * - all chats: nothing.
 */
export function archiveHiddenIds<T extends { id: string; parentChatId?: string; archived?: boolean }>(items: readonly T[], visibility: ArchiveVisibility, pinnedIds: ReadonlySet<string> = new Set()): Set<string> {
  if (visibility === 'all') return new Set()
  const byId = new Map(items.map((i) => [i.id, i]))
  const ancestry = (id: string, visit: (id: string) => void): void => {
    const seen = new Set<string>()
    for (let current: string | undefined = id; current && !seen.has(current) && byId.has(current); current = byId.get(current)?.parentChatId) { seen.add(current); visit(current) }
  }
  if (visibility === 'archived') {
    const visible = new Set<string>()
    for (const item of items) if (item.archived) ancestry(item.id, (id) => visible.add(id))
    return new Set(items.filter((i) => !visible.has(i.id)).map((i) => i.id))
  }
  const children = new Map<string, string[]>()
  for (const item of items) if (item.parentChatId && item.parentChatId !== item.id) children.set(item.parentChatId, [...(children.get(item.parentChatId) ?? []), item.id])
  const hidden = new Set<string>()
  const stack = items.filter((i) => i.archived).map((i) => i.id)
  while (stack.length) {
    const id = stack.pop()!
    if (hidden.has(id)) continue
    hidden.add(id)
    stack.push(...(children.get(id) ?? []))
  }
  for (const id of pinnedIds) if (byId.has(id)) ancestry(id, (a) => hidden.delete(a))
  return hidden
}
/**
 * The rows the Agents panel lists for one task: the archive visibility, the
 * harness facet (a match keeps its ancestors as context), then the order.
 * `pinnedIds` are rows that must stay reachable in the default view: the open
 * chat, working ones and unread ones.
 */
export function visibleChats<T extends ChatLike>(chats: readonly T[], taskId: string | null | undefined, view: AgentView, pinnedIds: ReadonlySet<string> = new Set()): T[] {
  const inTask = chats.filter((c) => c.taskId === taskId)
  const hidden = archiveHiddenIds(inTask, view.archive, pinnedIds)
  const pool = inTask.filter((c) => !hidden.has(c.id))
  return withAncestors(pool, (c) => harnessMatches(c, view.harness) && (view.archive !== 'archived' || !!c.archived)).sort(compareChats(view.sort))
}
/** Why the panel is empty: no agents, the archive view hides them all, or the filters do. */
export function emptyReason(chats: readonly ChatLike[], taskId: string | null | undefined, view: AgentView, visibleCount: number, pinnedIds: ReadonlySet<string> = new Set()): 'none' | 'archived' | 'no-archived' | 'filtered' | null {
  if (visibleCount > 0) return null
  const inTask = chats.filter((c) => c.taskId === taskId)
  if (!inTask.length) return 'none'
  if (view.archive !== 'all' && !visibleChats(chats, taskId, { ...view, harness: 'all' }, pinnedIds).length) return view.archive === 'archived' ? 'no-archived' : 'archived'
  return 'filtered'
}

/* ---------------- Tree ---------------- */

export interface TreeNode<T> {
  readonly item: T
  readonly depth: number
  /** Has rows under it in the current view (search narrows this). */
  readonly hasChildren: boolean
  readonly expanded: boolean
  /** Rendered children: empty while collapsed. */
  readonly children: TreeNode<T>[]
  /** Every row nested under this one in the current view, for a collapsed parent's rollup. */
  readonly descendants: T[]
}

/**
 * Builds the nested tree. Same forest rules as chatForest: a missing parent,
 * a self-parent or a cycle leaves the row visible as a root, and siblings keep
 * the input order. With a query, only matches and their ancestors stay and
 * every kept branch is open. Otherwise `isOpen` decides (default: not in `collapsed`).
 */
export function buildTree<T extends { id: string; parentChatId?: string; title: string }>(items: readonly T[], options: { query?: string; collapsed?: ReadonlySet<string>; isOpen?: (id: string, depth: number) => boolean } = {}): TreeNode<T>[] {
  const query = options.query?.trim() || ''
  const collapsed = options.collapsed ?? new Set<string>()
  const isOpen = options.isOpen ?? ((id: string) => !collapsed.has(id))
  const list = query ? withAncestors(items, (i) => matchesQuery(i.title, query)) : [...items]
  const ids = new Set(list.map((i) => i.id))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const item of list) {
    const p = item.parentChatId
    if (!p || p === item.id || !ids.has(p)) roots.push(item)
    else children.set(p, [...(children.get(p) ?? []), item])
  }
  const seen = new Set<string>()
  const build = (item: T, depth: number): TreeNode<T> => {
    seen.add(item.id)
    const built: TreeNode<T>[] = []
    for (const child of children.get(item.id) ?? []) if (!seen.has(child.id)) built.push(build(child, depth + 1))
    const expanded = !!query || isOpen(item.id, depth)
    const descendants = built.flatMap((n) => [n.item, ...n.descendants])
    return { item, depth, hasChildren: built.length > 0, expanded, children: expanded ? built : [], descendants }
  }
  const forest: TreeNode<T>[] = []
  for (const root of roots) if (!seen.has(root.id)) forest.push(build(root, 0))
  // Rows caught in a parent cycle are reachable from no root: surface them as roots.
  for (const item of list) if (!seen.has(item.id)) forest.push(build(item, 0))
  return forest
}
/** Visible rows in display order, for keyboard navigation. */
export function flattenTree<T>(nodes: readonly TreeNode<T>[]): TreeNode<T>[] {
  return nodes.flatMap((n) => [n, ...flattenTree(n.children)])
}
/** Ids of every row with children, for "Collapse all". */
export function parentIds<T extends { id: string; parentChatId?: string }>(items: readonly T[]): Set<string> {
  const ids = new Set(items.map((i) => i.id))
  return new Set(items.filter((i) => i.parentChatId && i.parentChatId !== i.id && ids.has(i.parentChatId)).map((i) => i.parentChatId!))
}

/* ---------------- Status ---------------- */

export type ChatStatusKind = 'failure' | 'interview' | 'approval' | 'running' | 'done' | 'read-only' | 'idle'
export interface ChatStatusInput {
  readonly busy?: boolean
  readonly permission?: boolean
  readonly question?: boolean
  /** A finished run the user has not opened yet. */
  readonly unread?: 'done' | 'failure' | null
  readonly readOnly?: boolean
}
/** Traycer's precedence lattice: attention (failure > interview > approval) > running > unread done > read-only > idle. */
export function chatStatusKind(s: ChatStatusInput): ChatStatusKind {
  if (s.unread === 'failure' && !s.busy) return 'failure'
  if (s.busy && s.question) return 'interview'
  if (s.busy && s.permission) return 'approval'
  if (s.busy) return 'running'
  if (s.unread === 'done') return 'done'
  if (s.readOnly) return 'read-only'
  return 'idle'
}
export type RollupKind = 'failure' | 'interview' | 'approval' | 'running' | 'done'
export const STATUS_RANKS: Readonly<Record<ChatStatusKind, number>> = { failure: 8, interview: 6, approval: 5, running: 4, done: 2, 'read-only': 0, idle: 0 }
export const STATUS_TITLES: Readonly<Record<ChatStatusKind, string>> = {
  failure: 'Tarefa precisa de atenção',
  interview: 'Tarefa aguardando sua resposta',
  approval: 'Tarefa aguardando sua aprovação',
  running: 'Trabalhando',
  done: 'Tarefa concluída',
  'read-only': 'Agente somente leitura',
  idle: 'Chat'
}
export interface StatusRollup { readonly kind: RollupKind; readonly counts: Readonly<Record<RollupKind, number>> }
const ROLLUP_ORDER: readonly RollupKind[] = ['failure', 'interview', 'approval', 'running', 'done']
/** A collapsed parent's hidden descendants: the most urgent kind plus per-kind counts. */
export function rollupStatus(kinds: readonly ChatStatusKind[]): StatusRollup | null {
  const counts: Record<RollupKind, number> = { failure: 0, interview: 0, approval: 0, running: 0, done: 0 }
  for (const k of kinds) if (k in counts) counts[k as RollupKind]++
  const kind = ROLLUP_ORDER.find((k) => counts[k] > 0)
  return kind ? { kind, counts } : null
}
/** The rollup owns the leading slot only when strictly more urgent; ties go to the parent. */
export function rollupWins(self: ChatStatusKind, rollup: StatusRollup | null): boolean {
  return !!rollup && STATUS_RANKS[rollup.kind] > STATUS_RANKS[self]
}
/** "Aninhados: 1 precisa de atenção · 2 em execução" - non-zero tiers, priority order. */
export function rollupSummary(rollup: StatusRollup): string {
  const c = rollup.counts, parts: string[] = []
  if (c.failure) parts.push(`${c.failure} ${c.failure === 1 ? 'precisa' : 'precisam'} de atenção`)
  if (c.interview) parts.push(`${c.interview} aguardando resposta`)
  if (c.approval) parts.push(`${c.approval} aguardando aprovação`)
  if (c.running) parts.push(`${c.running} em execução`)
  if (c.done) parts.push(`${c.done} ${c.done === 1 ? 'concluído' : 'concluídos'}`)
  return `Aninhados: ${parts.join(' · ')}`
}

/* ---------------- Time ---------------- */

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, WEEK = 7 * DAY
/** Traycer's compact ladder: agora / 10m / 4h / 1d / 1sem, then a short date. */
export function formatCompactRelativeTime(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp)
  if (diff < MINUTE) return 'agora'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  if (diff < WEEK) return `${Math.floor(diff / DAY)}d`
  if (diff < 4 * WEEK) return `${Math.floor(diff / WEEK)}sem`
  return new Date(timestamp).toLocaleDateString('pt-BR', { month: 'short', day: 'numeric' })
}
/** Elapsed time of a live run (StripElapsedTime): <1m, 12m, 1h 5m, 2d. */
export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d`
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/* ---------------- Task tabs ---------------- */

/** Open tasks in strip order, pinned first (stable). */
export function openTaskList<T extends Pick<AgentTask, 'id' | 'pinned'>>(tasks: readonly T[], openIds: readonly string[]): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return openIds.map((id) => byId.get(id)).filter((t): t is T => !!t).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
}
export type TaskActivity = 'waiting' | 'running' | 'idle'
/** A task's strongest live state across its chats. */
export function taskActivity(chats: readonly Pick<UnifiedChat, 'id' | 'taskId'>[], runtime: Readonly<Record<string, { busy: boolean; permission?: unknown; question?: unknown } | undefined>>, taskId: string): TaskActivity {
  let running = false
  for (const c of chats) {
    if (c.taskId !== taskId) continue
    const r = runtime[c.id]
    if (!r?.busy) continue
    if (r.permission || r.question) return 'waiting'
    running = true
  }
  return running ? 'running' : 'idle'
}

export type TaskStatus = 'failure' | 'waiting' | 'running' | 'done' | 'idle'
/**
 * Every task's tab status in one pass over the chats (one Map instead of
 * tabs x chats): an unread failure, then a run waiting for the user, then a
 * running one, then an unread completion.
 */
export function taskStatuses(chats: readonly Pick<UnifiedChat, 'id' | 'taskId'>[], runtime: Readonly<Record<string, { busy: boolean; permission?: unknown; question?: unknown } | undefined>>,
  unread: Readonly<Record<string, 'done' | 'failure' | undefined>> = {}): Record<string, TaskStatus> {
  const rank: Record<TaskStatus, number> = { failure: 4, waiting: 3, running: 2, done: 1, idle: 0 }
  const out: Record<string, TaskStatus> = {}
  for (const c of chats) {
    if (!c.taskId) continue
    const r = runtime[c.id]
    const status: TaskStatus = r?.busy ? (r.permission || r.question ? 'waiting' : 'running') : unread[c.id] ?? 'idle'
    if (rank[status] > rank[out[c.taskId] ?? 'idle']) out[c.taskId] = status
    else out[c.taskId] ??= 'idle'
  }
  return out
}
/**
 * The open-tab order after dropping `dragId` before/after `targetId`, or null
 * when the strip would look the same - pinned tabs always lead, so moving an
 * unpinned tab in front of a pinned one changes nothing and shows no marker.
 */
export function dropOrder<T extends Pick<AgentTask, 'id' | 'pinned'>>(tasks: readonly T[], openIds: readonly string[], dragId: string, targetId: string, side: 'before' | 'after'): string[] | null {
  if (dragId === targetId || !openIds.includes(dragId) || !openIds.includes(targetId)) return null
  const rest = openIds.filter((id) => id !== dragId)
  const at = rest.indexOf(targetId) + (side === 'after' ? 1 : 0)
  const next = [...rest.slice(0, at), dragId, ...rest.slice(at)]
  const shown = (ids: readonly string[]): string => openTaskList(tasks, ids).map((t) => t.id).join('|')
  return shown(next) === shown(openIds) ? null : next
}
/** Live run state per chat, for row glyphs: only chats with a run in flight. */
export function runStates(runtime: Readonly<Record<string, { busy: boolean; permission?: unknown; question?: unknown } | undefined>>): Record<string, 'running' | 'approval' | 'interview'> {
  const out: Record<string, 'running' | 'approval' | 'interview'> = {}
  for (const [id, r] of Object.entries(runtime)) if (r?.busy) out[id] = r.question ? 'interview' : r.permission ? 'approval' : 'running'
  return out
}

/* ---------------- Run monitor ---------------- */

export type MonitorFilter = 'active' | 'waiting' | 'finished' | 'all'
export interface MonitorRuntime { readonly turnId: string; readonly busy: boolean; readonly permission?: unknown; readonly question?: unknown }
export interface MonitorRow<C, R> { readonly chat: C; readonly turn: SharedTurn; readonly run: R | undefined }

/** Each row is one assistant run inside a chat; live runs first, newest first. */
export function monitorRows<C extends Pick<UnifiedChat, 'id' | 'title' | 'taskId' | 'turns'>, R extends MonitorRuntime>(
  chats: readonly C[], runtime: Readonly<Record<string, R | undefined>>, tasks: readonly Pick<AgentTask, 'id' | 'title'>[], filter: MonitorFilter, query: string
): MonitorRow<C, R>[] {
  const taskTitle = new Map(tasks.map((t) => [t.id, t.title]))
  return chats.flatMap((chat) => {
    const live = runtime[chat.id]
    // Inactive chats may have tens of thousands of turns. The live filters
    // need only the runtime's turn, usually the tail, never the full history.
    const liveOnly = filter === 'active' || filter === 'waiting'
    if (liveOnly && (!live || (filter === 'active' ? !live.busy : !live.permission && !live.question))) return []
    let current: SharedTurn | undefined
    if (liveOnly) for (let i = chat.turns.length - 1; i >= 0; i--) {
      if (chat.turns[i].id === live?.turnId) { current = chat.turns[i]; break }
    }
    const turns = liveOnly ? (current ? [current] : []) : chat.turns
    return turns.filter((t) => t.role === 'assistant' && t.startedAt).map((turn) => ({ chat, turn, run: live?.turnId === turn.id ? live : undefined }))
  })
    .filter((r) => filter === 'all' || (filter === 'active' && !!r.run?.busy) || (filter === 'waiting' && !!(r.run?.permission || r.run?.question)) || (filter === 'finished' && !r.run?.busy))
    .filter((r) => matchesQuery(`${r.chat.title} ${r.turn.profileName || ''} ${r.turn.model || ''} ${taskTitle.get(r.chat.taskId || '') || ''}`, query))
    .sort((a, b) => Number(!!b.run?.busy) - Number(!!a.run?.busy) || (b.turn.startedAt ?? 0) - (a.turn.startedAt ?? 0))
}
/** Counts for the monitor's filter tabs. */
export function monitorCounts(runtime: Readonly<Record<string, MonitorRuntime | undefined>>): { active: number; waiting: number } {
  const live = Object.values(runtime).filter((r): r is MonitorRuntime => !!r?.busy)
  return { active: live.length, waiting: live.filter((r) => r.permission || r.question).length }
}
