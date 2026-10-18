import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DatabaseSync } from 'node:sqlite'
import { profiles as prismProfiles } from '../providers'
import { chatsBackend, listChats, listTasks, type ChatsBackend } from '../hostChats'
import { hostDataDir } from '../host/supervisor'
import { database, rootPath } from './traycerImport'
import type { AgentTask, RunMetrics, UnifiedChat } from '../../shared/agents'
import type {
  UsageImportState, UsageObservation, UsageOutcome, UsageRecordsResponse, UsageSaveRequest
} from '../../shared/usage'

// Settings ▸ Uso. Reads Prism's own turns (chats + the run journal), imports
// Traycer's per-turn usage into Prism's own store (userData/prism-usage.db),
// and puts exported images and files on the clipboard or disk. Traycer's
// databases are only ever opened read-only; nothing is written there and no
// credential is read.

type Row = Record<string, unknown>
const TERMINAL_ACCOUNT = 'Conta do terminal'
const MAX_EXPORT_BYTES = 64 * 1024 * 1024
const UUID = /^[a-zA-Z0-9_-]+$/

const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null
const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
const parse = (v: unknown): Row => { try { return typeof v === 'string' ? JSON.parse(v) ?? {} : {} } catch { return {} } }

/** The last path segment, for a workspace's display name. */
export function projectName(cwd: string | null | undefined): string | null {
  const parts = (cwd || '').split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? null
}

/** Traycer's harness ids, in Prism's vocabulary. */
export function normalizeHarness(id: unknown): string {
  const value = text(id)?.toLowerCase()
  if (!value) return 'traycer'
  return value === 'claude-code' ? 'claude' : value
}

/* ---------------- Prism turns ---------------- */

interface JournalTurn { sessionId?: string; route?: string }

/**
 * Session id and route of every journaled run, keyed `${chatId}\0${turnId}`.
 * With the host owning the chats its journal (`host/prism-host.db`, 0.2's
 * runs imported) comes last and wins; `prism-agents.db` still holds the runs
 * a window drives itself (SSH). Both are only read.
 */
function journalTurns(backend: ChatsBackend): Map<string, JournalTurn> {
  const turns = new Map<string, JournalTurn>()
  readJournal(join(app.getPath('userData'), 'prism-agents.db'), turns)
  if (backend === 'host') readJournal(join(hostDataDir(), 'prism-host.db'), turns)
  return turns
}

function readJournal(path: string, turns: Map<string, JournalTurn>): void {
  if (!existsSync(path)) return
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    // "kind" wherever the writer put it (the host may order keys differently); quotes
    // inside a JSON string are escaped, so streamed text never matches.
    const rows = db.prepare(`SELECT chat_id, turn_id, json_extract(body,'$.kind') AS kind, json_extract(body,'$.sessionId') AS session_id,
      json_extract(body,'$.route') AS route FROM events WHERE body LIKE '%"kind":"session"%' OR body LIKE '%"kind":"begin"%' ORDER BY seq`).all() as Row[]
    for (const row of rows) {
      const key = `${row.chat_id}\0${row.turn_id}`
      const entry = turns.get(key) ?? {}
      if (row.kind === 'session' && text(row.session_id)) entry.sessionId = row.session_id as string
      if (row.kind === 'begin' && text(row.route)) entry.route = row.route as string
      turns.set(key, entry)
    }
  } catch { /* Unreadable journal: deltas fall back to the session heuristics. */ } finally { db?.close() }
}

/**
 * Prism's assistant turns that actually ran here. Transcripts imported from
 * Traycer carry neither a start time nor metrics, so they are skipped (their
 * usage comes from the Traycer import instead). A turn still running is
 * picked up once it completes.
 */
export function prismObservations(chats: readonly UnifiedChat[], tasks: readonly AgentTask[], profileNames: ReadonlyMap<string, string>,
  journal: ReadonlyMap<string, JournalTurn>): UsageObservation[] {
  const taskTitles = new Map(tasks.map((t) => [t.id, t.title]))
  const observations: UsageObservation[] = []
  for (const chat of chats) {
    for (const turn of chat.turns) {
      if (turn.role !== 'assistant' || chat.pendingTurnId === turn.id) continue
      if (!turn.metrics && !turn.startedAt) continue
      const run = journal.get(`${chat.id}\0${turn.id}`)
      const [routeProvider, ...routeRest] = (run?.route ?? '').split(':')
      const provider = turn.provider || text(routeProvider) || chat.selection.provider
      const profileId = text(routeRest.join(':')) ?? (provider === chat.selection.provider ? chat.selection.profileId : null)
      const startedAt = turn.startedAt ?? turn.completedAt ?? chat.updatedAt
      const completedAt = turn.completedAt ?? null
      const outcome: UsageOutcome = turn.error ? 'error' : turn.interrupted ? 'interrupted' : 'completed'
      observations.push({
        id: `prism:${chat.id}:${turn.id}`, source: 'prism', chatId: chat.id, turnId: turn.id, chatTitle: chat.title,
        taskId: chat.taskId ?? null, taskTitle: chat.taskId ? taskTitles.get(chat.taskId) ?? null : null, project: projectName(chat.cwd),
        // The model the provider reported, when recorded; else the one chosen (maybe an alias).
        provider, model: turn.metrics?.model || turn.model || '', profileId,
        profileName: turn.profileName || (profileId ? profileNames.get(profileId) : undefined) || TERMINAL_ACCOUNT,
        sessionKey: run?.sessionId ?? null, startedAt, completedAt,
        durationMs: turn.durationMs ?? (turn.startedAt && completedAt ? Math.max(0, completedAt - turn.startedAt) : null),
        outcome, prismChatId: chat.id, ...prismCounters(provider, turn.metrics)
      })
    }
  }
  return observations
}

type Counters = Pick<UsageObservation, 'tokenBasis' | 'costBasis' | 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens' | 'costUsd'>

/**
 * What a run's metrics mean, per provider:
 * - the runtime's per-turn measure (`metrics.turn`), when it has one, as is
 *   (a cost it could not measure stays absent);
 * - older Claude runs: `result.usage` is the turn's own main-loop usage,
 *   while `total_cost_usd` is the session's running total;
 * - older Codex runs: `tokenUsage.total` is the thread's running total, input
 *   including cached input; no cost.
 */
export function prismCounters(provider: string, metrics: RunMetrics | undefined): Counters {
  const none: Counters = { tokenBasis: 'none', costBasis: 'none', inputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null }
  if (!metrics) return none
  const turn = metrics.turn
  if (turn && typeof turn === 'object') {
    return { tokenBasis: 'turn', costBasis: num(turn.costUsd) !== null ? 'turn' : 'none', inputTokens: num(turn.inputTokens), cacheReadTokens: num(turn.cacheReadTokens),
      cacheWriteTokens: num(turn.cacheWriteTokens), outputTokens: num(turn.outputTokens), reasoningTokens: num(turn.reasoningTokens), costUsd: num(turn.costUsd) }
  }
  const input = num(metrics.inputTokens), cached = num(metrics.cachedTokens)
  if (provider === 'codex') {
    return { tokenBasis: 'cumulative', costBasis: 'none', inputTokens: input === null ? null : Math.max(0, input - (cached ?? 0)), cacheReadTokens: cached,
      cacheWriteTokens: null, outputTokens: num(metrics.outputTokens), reasoningTokens: num(metrics.reasoningTokens), costUsd: null }
  }
  const cost = num(metrics.costUsd)
  return { tokenBasis: 'turn', costBasis: cost === null ? 'none' : 'cumulative', inputTokens: input, cacheReadTokens: cached,
    cacheWriteTokens: num(metrics.cacheWriteTokens), outputTokens: num(metrics.outputTokens), reasoningTokens: num(metrics.reasoningTokens), costUsd: cost }
}

/* ---------------- Prism's usage store ---------------- */

let usageDb: DatabaseSync | null = null
function usageStore(): DatabaseSync {
  if (usageDb) return usageDb
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'prism-usage.db'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS traycer_turns (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, chat_id TEXT NOT NULL, body TEXT NOT NULL, imported_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, body TEXT NOT NULL);`)
  usageDb = db
  return db
}

/** Closes the store (tests, and app shutdown). */
export function closeUsageStore(): void {
  usageDb?.close()
  usageDb = null
}

const NEVER_IMPORTED: UsageImportState = { status: 'never', at: null, root: null, tasks: 0, chats: 0, turns: 0, added: 0, updated: 0, unchanged: 0, warnings: [], error: null }

export function importState(): UsageImportState {
  const row = usageStore().prepare("SELECT body FROM state WHERE key='traycer-import'").get() as Row | undefined
  return row ? { ...NEVER_IMPORTED, ...parse(row.body) } : NEVER_IMPORTED
}
function saveImportState(state: UsageImportState): void {
  usageStore().prepare("INSERT INTO state VALUES ('traycer-import',?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(JSON.stringify(state))
}

/** Imported Traycer turns, linked to their Prism copy when the chat was imported too. */
export function traycerObservations(chats: readonly UnifiedChat[]): UsageObservation[] {
  const linked = new Map<string, string>()
  for (const c of chats) if (c.traycerSource) linked.set(`${c.traycerSource.epicId}/${c.traycerSource.chatId}`, c.id)
  const rows = usageStore().prepare('SELECT body FROM traycer_turns').all() as Row[]
  const observations: UsageObservation[] = []
  for (const row of rows) {
    const o = parse(row.body) as unknown as UsageObservation
    if (!o || typeof o.id !== 'string' || typeof o.chatId !== 'string') continue
    observations.push({ ...o, prismChatId: linked.get(o.chatId) ?? null })
  }
  return observations
}

export async function usageRecords(): Promise<UsageRecordsResponse> {
  const backend = await chatsBackend()
  const [chats, { tasks = [] }] = await Promise.all([listChats(), listTasks()])
  const names = new Map(prismProfiles().map((p) => [p.id, p.name]))
  return {
    observations: [...prismObservations(chats, tasks, names, journalTurns(backend)), ...traycerObservations(chats)],
    importState: importState(),
    generatedAt: Date.now()
  }
}

/* ---------------- Traycer import ---------------- */

/** Thrown for a database whose tables don't have the columns this importer reads. */
export class UnknownTraycerSchema extends Error {}

function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)))
}

const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  chat_projection_head: ['chat_id', 'title', 'lifecycle_state', 'settings_json'],
  chat_event: ['chat_id', 'turn_id', 'event_type', 'body', 'insert_seq'],
  chat_message: ['chat_id', 'turn_key', 'body', 'removed_seq', 'insert_seq']
}

/** The plain-language reason an epic could not be read. */
export function describeTraycerError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof UnknownTraycerSchema) return message
  if (/SQLITE_BUSY|database is locked|locked/i.test(message)) return 'o banco está em uso pelo Traycer; tente novamente em instantes.'
  if (/no such table|no such column|malformed/i.test(message)) return 'formato do banco do Traycer não reconhecido.'
  if (/SQLITE_CANTOPEN|unable to open|ENOENT/i.test(message)) return 'não foi possível abrir o banco do Traycer.'
  return message
}

interface EpicContext {
  readonly epicId: string
  readonly epicTitle: string | null
  readonly accountLabels: ReadonlyMap<string, string>
}

interface TurnEvents { started: number | null; ended: number | null; outcome: UsageOutcome | null; usage: Row | null }

/**
 * Every finished turn in one epic's chat.db, as observations. Tokens are
 * Traycer's per-turn record (the turn's last model call); `costUsd` is the
 * Claude session's running total, so it becomes a delta later. Deleted chats
 * and turns that never finished are left out.
 */
export function readTraycerEpic(db: DatabaseSync, context: EpicContext): { observations: UsageObservation[]; chats: number } {
  for (const [table, needed] of Object.entries(REQUIRED)) {
    const have = columns(db, table)
    if (!needed.every((c) => have.has(c))) {
      const version = (() => { try { return text((db.prepare("SELECT value FROM chat_db_meta WHERE key='schema_version'").get() as Row | undefined)?.value) } catch { return null } })()
      throw new UnknownTraycerSchema(`formato do banco do Traycer não reconhecido${version ? ` (versão ${version})` : ''}.`)
    }
  }
  const heads = new Map<string, Row>()
  for (const h of db.prepare("SELECT chat_id, title, settings_json FROM chat_projection_head WHERE lifecycle_state != 'deleted'").all() as Row[]) heads.set(String(h.chat_id), h)
  const turns = new Map<string, TurnEvents>()
  const events = db.prepare(`SELECT chat_id, turn_id, event_type, body FROM chat_event
    WHERE event_type IN ('turn.started','turn.completed','turn.interrupted') AND turn_id IS NOT NULL ORDER BY insert_seq`).all() as Row[]
  for (const e of events) {
    const chatId = String(e.chat_id)
    if (!heads.has(chatId)) continue
    const key = `${chatId}\0${e.turn_id}`
    const body = parse(e.body)
    const at = num(body.timestamp)
    const t = turns.get(key) ?? { started: null, ended: null, outcome: null, usage: null }
    if (e.event_type === 'turn.started') { if (at !== null && (t.started === null || at < t.started)) t.started = at }
    else {
      t.ended = at ?? t.ended
      const metadata = (body.metadata && typeof body.metadata === 'object' ? body.metadata : {}) as Row
      if (e.event_type === 'turn.completed') {
        t.outcome = 'completed'
        if (metadata.usage && typeof metadata.usage === 'object') t.usage = metadata.usage as Row
      } else t.outcome = body.severity === 'error' ? 'error' : 'interrupted'
    }
    turns.set(key, t)
  }
  const senders = new Map<string, Row>()
  for (const m of db.prepare(`SELECT chat_id, turn_key, json_extract(body,'$.sender.harnessId') AS harness, json_extract(body,'$.sender.agentId') AS model,
      json_extract(body,'$.turnProfile.labelSnapshot') AS label, json_extract(body,'$.turnProfile.profileId') AS profile_id, json_extract(body,'$.startedAt') AS started_at
    FROM chat_message WHERE removed_seq IS NULL AND turn_key IS NOT NULL
      AND (CASE WHEN json_valid(body) THEN json_extract(body,'$.role') END)='assistant' ORDER BY insert_seq`).all() as Row[]) {
    const key = `${m.chat_id}\0${m.turn_key}`
    const prior = senders.get(key) ?? {}
    // The latest message of the turn wins, without losing a field it lacks.
    senders.set(key, Object.fromEntries(Object.keys({ ...prior, ...m }).map((k) => [k, m[k] ?? prior[k]])))
  }
  const anchors = new Map<string, Row>()
  if (columns(db, 'chat_row_index').has('unit_state')) {
    // A unit whose state is not JSON simply has no anchor (CASE keeps json_extract off it).
    for (const r of db.prepare(`SELECT chat_id, unit_key, anchor ->> '$.sessionId' AS session_id,
        anchor ->> '$.sessionWorkspaceSnapshot.primaryWorkspace' AS workspace, anchor ->> '$.labelSnapshot' AS label,
        anchor ->> '$.profileId' AS profile_id, anchor ->> '$.harnessId' AS harness
      FROM (SELECT chat_id, unit_key, CASE WHEN json_valid(unit_state) THEN json_extract(unit_state,'$.sessionAnchor') END AS anchor
        FROM chat_row_index WHERE role='assistant' AND unit_state IS NOT NULL) WHERE anchor IS NOT NULL`).all() as Row[]) {
      const unit = String(r.unit_key ?? '')
      if (unit.startsWith('t:')) anchors.set(`${r.chat_id}\0${unit.slice(2)}`, r)
    }
  }
  const observations: UsageObservation[] = []
  for (const [key, t] of turns) {
    if (t.outcome === null || t.ended === null) continue
    const [chatId, turnId] = key.split('\0')
    const head = heads.get(chatId)!
    const settings = parse(head.settings_json)
    const sender = senders.get(key) ?? {}, anchor = anchors.get(key) ?? {}
    const provider = normalizeHarness(sender.harness ?? anchor.harness ?? settings.harnessId)
    const profileId = text(sender.profile_id) ?? text(anchor.profile_id)
    const label = text(sender.label) ?? text(anchor.label) ?? (profileId ? context.accountLabels.get(profileId) ?? null : null)
    const usage = t.usage
    const input = num(usage?.inputTokens), cacheRead = num(usage?.cacheReadInputTokens)
    const cost = num(usage?.costUsd)
    // The assistant message can open a little before Traycer logs the turn start.
    const startedAt = Math.min(t.started ?? Number.POSITIVE_INFINITY, num(sender.started_at) ?? Number.POSITIVE_INFINITY, t.ended)
    const sourceChat = `${context.epicId}/${chatId}`
    observations.push({
      id: `traycer:${sourceChat}:${turnId}`, source: 'traycer', chatId: sourceChat, turnId, chatTitle: text(head.title) ?? 'Chat do Traycer',
      taskId: context.epicId, taskTitle: context.epicTitle, project: projectName(text(anchor.workspace)),
      provider, model: text(sender.model) ?? text(settings.model) ?? '', profileId,
      profileName: !label || label === 'Terminal account' ? TERMINAL_ACCOUNT : label,
      sessionKey: text(anchor.session_id), startedAt, completedAt: t.ended, durationMs: Math.max(0, t.ended - startedAt),
      outcome: t.outcome, prismChatId: null,
      tokenBasis: usage ? 'last-call' : 'none', costBasis: cost === null ? 'none' : 'cumulative',
      // Codex reports input including cached input; Claude reports them apart.
      inputTokens: input === null ? null : provider === 'codex' ? Math.max(0, input - (cacheRead ?? 0)) : input,
      cacheReadTokens: usage ? cacheRead ?? 0 : null, cacheWriteTokens: usage ? num(usage.cacheCreationInputTokens) ?? 0 : null,
      outputTokens: num(usage?.outputTokens), reasoningTokens: null, costUsd: cost
    })
  }
  return { observations, chats: new Set(observations.map((o) => o.chatId)).size }
}

/** Account names Traycer shows, by profile id (labels only; credentials are never read). */
function accountLabels(root: string): Map<string, string> {
  const labels = new Map<string, string>()
  try {
    const data = JSON.parse(readFileSync(join(root, 'host', 'config', 'provider-accounts.json'), 'utf8'))
    for (const p of Array.isArray(data.profiles) ? data.profiles : []) if (text(p?.profileId) && text(p?.label)) labels.set(p.profileId, p.label)
  } catch { /* No account file: labels come from each turn's own snapshot. */ }
  return labels
}

/** Task titles from Traycer's epic list (read-only). */
function epicTitles(root: string): Map<string, string> {
  const titles = new Map<string, string>()
  const path = join(root, 'host', 'epic-homes', 'epic-homes.db')
  if (!existsSync(path)) return titles
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    for (const r of db.prepare(`SELECT epic_id, CASE WHEN json_valid(list_projection_json) THEN json_extract(list_projection_json,'$.title') END AS title
      FROM local_epic WHERE list_projection_json IS NOT NULL`).all() as Row[]) {
      if (text(r.title)) titles.set(String(r.epic_id), String(r.title))
    }
  } catch { /* Titles fall back to each task's first chat. */ } finally { db?.close() }
  return titles
}

/** A task's name when the epic list has none: its earliest top-level chat. */
function rootChatTitle(db: DatabaseSync): string | null {
  try {
    const row = db.prepare(`SELECT title FROM chat_projection_head WHERE parent_chat_id IS NULL AND lifecycle_state != 'deleted' ORDER BY created_at LIMIT 1`).get() as Row | undefined
    return text(row?.title)
  } catch { return null }
}

let running: Promise<UsageImportState> | null = null

/**
 * Imports every finished Traycer turn into Prism's store, idempotently: rows
 * are keyed by Traycer's own ids, so importing again only adds new turns and
 * refreshes changed ones. Yields between tasks so the app stays responsive.
 */
export function importTraycerUsage(path?: string): Promise<UsageImportState> {
  running ||= runImport(path).finally(() => { running = null })
  return running
}

async function runImport(path?: string): Promise<UsageImportState> {
  const at = Date.now()
  try { return await importFrom(rootPath(path), at) } catch (err) {
    // The previous counts stay: they still describe what the store holds.
    const state: UsageImportState = { ...importState(), status: 'error', at, error: err instanceof Error ? err.message : String(err) }
    saveImportState(state)
    return state
  }
}

async function importFrom(root: string, at: number): Promise<UsageImportState> {
  const warnings: string[] = []
  const stateDir = join(root, 'host', 'epic-state')
  const epics = existsSync(stateDir) ? readdirSync(stateDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && UUID.test(e.name) && existsSync(join(stateDir, e.name, 'chat', 'chat.db'))).map((e) => e.name) : []
  if (!epics.length) warnings.push('Nenhum banco de chats do Traycer foi encontrado nesta pasta.')
  const labels = accountLabels(root), titles = epicTitles(root)
  const store = usageStore()
  const existing = new Map((store.prepare('SELECT id, body FROM traycer_turns').all() as Row[]).map((r) => [String(r.id), String(r.body)]))
  const upsert = store.prepare(`INSERT INTO traycer_turns (id, epic_id, chat_id, body, imported_at, updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body, updated_at=excluded.updated_at`)
  let tasks = 0, chats = 0, turns = 0, added = 0, updated = 0, unchanged = 0
  for (const epicId of epics) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    let db: DatabaseSync | undefined
    let read: { observations: UsageObservation[]; chats: number }
    const title = titles.get(epicId) ?? null
    try {
      db = database(root, epicId)
      // One read transaction: a consistent snapshot while Traycer keeps writing.
      db.exec('BEGIN')
      try { read = readTraycerEpic(db, { epicId, epicTitle: title ?? rootChatTitle(db), accountLabels: labels }) } finally { db.exec('COMMIT') }
    } catch (err) {
      warnings.push(`Tarefa “${title ?? epicId}”: ${describeTraycerError(err)}`)
      continue
    } finally { db?.close() }
    if (!read.observations.length) continue
    tasks++; chats += read.chats; turns += read.observations.length
    store.exec('BEGIN IMMEDIATE')
    try {
      for (const o of read.observations) {
        const { prismChatId: _linked, ...stored } = o
        const body = JSON.stringify(stored)
        const id = o.id.slice('traycer:'.length)
        const before = existing.get(id)
        if (before === body) { unchanged++; continue }
        upsert.run(id, epicId, o.chatId, body, at, at)
        if (before === undefined) added++
        else updated++
      }
      store.exec('COMMIT')
    } catch (err) { store.exec('ROLLBACK'); throw err }
  }
  const state: UsageImportState = { status: 'ok', at, root, tasks, chats, turns, added, updated, unchanged, warnings, error: null }
  saveImportState(state)
  return state
}

/* ---------------- Clipboard and files ---------------- */

let figtree: string | null = null
/**
 * Figtree's @font-face rules with the woff2 files inlined as data URLs, for
 * the image export: the renderer cannot fetch its own font files from
 * file:// in production, and a PNG without them falls back to a system font.
 * Read once, from the packaged dependency; '' when it can't be found.
 */
export function figtreeFontCss(): string {
  figtree ??= inlineFontCss([app.getAppPath(), process.cwd()])
  return figtree
}

/** The first root whose Figtree package inlines cleanly; '' when none does. */
export function inlineFontCss(roots: readonly string[]): string {
  for (const root of roots) {
    const dir = join(root, 'node_modules', '@fontsource-variable', 'figtree')
    try {
      const css = readFileSync(join(dir, 'index.css'), 'utf8')
      const inlined = css.replace(/url\(\.\/files\/([\w.-]+\.woff2)\)/g, (_m, name: string) => `url(data:font/woff2;base64,${readFileSync(join(dir, 'files', name)).toString('base64')})`)
      if (inlined.includes('data:font/woff2') && !/url\(\.\//.test(inlined)) return inlined
    } catch { /* Try the next root. */ }
  }
  return ''
}

function bytesOf(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error('Imagem inválida.')
  if (value.byteLength > MAX_EXPORT_BYTES) throw new Error('Imagem grande demais para exportar.')
  return Buffer.from(value)
}

export function copyImage(value: unknown): void {
  const image = nativeImage.createFromBuffer(bytesOf(value))
  if (image.isEmpty()) throw new Error('Imagem inválida.')
  clipboard.writeImage(image)
}

const SAVE_FILTERS: Readonly<Record<UsageSaveRequest['kind'], { name: string; extension: string }>> = {
  png: { name: 'Imagem PNG', extension: 'png' },
  csv: { name: 'Planilha CSV', extension: 'csv' },
  json: { name: 'JSON', extension: 'json' }
}
const saved = new Set<string>()

/** A file name that is just a name: no folders, no reserved characters, the right extension. */
export function safeFileName(name: unknown, extension: string): string {
  const base = (typeof name === 'string' ? name : '').split(/[\\/]/).pop()!.replace(/[<>:"|?*\u0000-\u001f]/g, '').trim().slice(0, 120)
  const stem = base.replace(/\.[^.]*$/, '') || 'prism-uso'
  return `${stem}.${extension}`
}

export async function saveFile(window: BrowserWindow | null, request: unknown): Promise<string | null> {
  const r = request as Partial<UsageSaveRequest> | null
  const kind = r?.kind
  if (kind !== 'png' && kind !== 'csv' && kind !== 'json') throw new Error('Formato de exportação inválido.')
  const data = kind === 'png' ? bytesOf(r!.data) : typeof r!.data === 'string' ? r!.data : null
  if (data === null) throw new Error('Conteúdo de exportação inválido.')
  if (typeof data === 'string' && Buffer.byteLength(data) > MAX_EXPORT_BYTES) throw new Error('Arquivo grande demais para exportar.')
  const filter = SAVE_FILTERS[kind]
  const options = { title: 'Salvar uso', defaultPath: join(app.getPath('downloads'), safeFileName(r!.fileName, filter.extension)),
    filters: [{ name: filter.name, extensions: [filter.extension] }] }
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return null
  writeFileSync(result.filePath, data)
  saved.add(result.filePath)
  return result.filePath
}

export function registerUsageHandlers(): void {
  ipcMain.handle('usage:records', () => usageRecords())
  ipcMain.handle('usage:import-traycer', (_e, root?: unknown) => importTraycerUsage(typeof root === 'string' && root ? root : undefined))
  ipcMain.handle('usage:copy-image', (_e, png: unknown) => copyImage(png))
  ipcMain.handle('usage:font-css', () => figtreeFontCss())
  ipcMain.handle('usage:save-file', (e, request: unknown) => saveFile(BrowserWindow.fromWebContents(e.sender), request))
  // Only files this session saved can be revealed.
  ipcMain.handle('usage:reveal-file', (_e, path: unknown) => { if (typeof path === 'string' && saved.has(path)) shell.showItemInFolder(path) })
  app.on('will-quit', closeUsageStore)
}
