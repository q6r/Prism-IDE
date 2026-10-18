// Pure chat-timeline logic, ported from Traycer's chat-activity-groups.ts and
// friends. No runtime imports: tests load this file directly with node --test.
import type { SharedSegment } from '../../../../shared/agents'

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** Traycer's formatClockDuration: `12s`, `3m 4s`, `1h 2m 3s`. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  if (s < 60) return `${s}s`
  const minutes = Math.floor(s / 60)
  const seconds = s % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds}s`
}

/** Footer duration ("Worked for"): sub-second and invalid values read `<1s`. */
export function formatWorkedFor(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '<1s'
  return formatClock(Math.floor(ms / 1000))
}

/** Collapses whitespace to one line and caps the length with an ellipsis. */
export function singleLine(value: string, max = 160): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat
}

/** Path relative to the chat folder when it lives inside it. */
export function relativePath(path: string, cwd?: string): string {
  if (!cwd || !path) return path
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const p = norm(path), base = norm(cwd)
  const same = (a: string, b: string): boolean => /^[a-z]:/i.test(a) ? a.toLowerCase() === b.toLowerCase() : a === b
  if (same(p, base)) return '.'
  const head = p.slice(0, base.length + 1)
  return same(head, `${base}/`) ? p.slice(base.length + 1) : path
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path
}

/* ------------------------------------------------------------------ */
/* Playful verbs (Traycer working-verb.ts / ELAPSED_VERBS, in pt-BR)   */
/* ------------------------------------------------------------------ */

const WORKING_VERBS = ['Matutando', 'Ponderando', 'Processando', 'Fermentando', 'Divagando', 'Remoendo', 'Tramando', 'Chocando',
  'Ajustando', 'Conjurando', 'Destilando', 'Domando', 'Marinando', 'Improvisando', 'Investigando', 'Planejando', 'Cozinhando',
  'Forjando', 'Explorando', 'Canalizando'] as const
const ELAPSED_VERBS = ['Matutou', 'Ponderou', 'Processou', 'Fermentou', 'Divagou', 'Remoeu', 'Tramou', 'Chocou',
  'Ajustou', 'Conjurou', 'Destilou', 'Domou', 'Marinou', 'Improvisou', 'Investigou', 'Planejou', 'Cozinhou',
  'Forjou', 'Explorou', 'Canalizou'] as const

/** djb2, as Traycer seeds its verbs: stable per turn, distinct between turns. */
function seedIndex(seed: string, size: number): number {
  let hash = 5381
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) | 0
  return Math.abs(hash) % size
}
export function pickWorkingVerb(seed: string): string {
  return WORKING_VERBS[seedIndex(seed, WORKING_VERBS.length)]
}
export function pickElapsedVerb(seed: string): string {
  return ELAPSED_VERBS[seedIndex(seed, ELAPSED_VERBS.length)]
}

/* ------------------------------------------------------------------ */
/* Tool classification                                                 */
/* ------------------------------------------------------------------ */

export type ToolKind = 'read' | 'explore' | 'search' | 'edit' | 'run' | 'hook' | 'browser' | 'subagent' | 'tool'
/** Which row renders a tool call: a shell command, a file change or the generic tool row. */
export type RowKind = 'command' | 'file' | 'tool'

const READ_TOOLS = new Set(['read', 'read_file', 'readfile', 'view', 'open_file', 'notebookread'])
const EXPLORE_TOOLS = new Set(['glob', 'list', 'ls', 'list_files', 'listfiles', 'find'])
const SEARCH_TOOLS = new Set(['grep', 'search', 'rg', 'web_search', 'websearch', 'web_fetch', 'webfetch', 'toolsearch'])
const EDIT_TOOLS = new Set(['edit', 'edit_file', 'editfile', 'multi_edit', 'multiedit', 'write', 'write_file', 'writefile', 'apply_patch', 'notebookedit', 'notebook_edit', 'filechange'])
const RUN_TOOLS = new Set(['bash', 'shell', 'run_command', 'command', 'commandexecution', 'powershell', 'bashoutput', 'killshell', 'killbash'])
const SUBAGENT_TOOLS = new Set(['task', 'agent', 'spawn_agent'])

export function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[\s.-]+/g, '_')
}

export function toolKind(name: string): ToolKind {
  const n = normalizeToolName(name)
  if (n.includes('browser') || n === 'mcp__traycer_browser__repl') return 'browser'
  if (n.includes('hook')) return 'hook'
  if (READ_TOOLS.has(n)) return 'read'
  if (EXPLORE_TOOLS.has(n)) return 'explore'
  if (SEARCH_TOOLS.has(n)) return 'search'
  if (EDIT_TOOLS.has(n)) return 'edit'
  if (RUN_TOOLS.has(n)) return 'run'
  if (SUBAGENT_TOOLS.has(n) || n.endsWith('_spawn_agent')) return 'subagent'
  return 'tool'
}

const COMMAND_ROW_TOOLS = new Set(['bash', 'shell', 'run_command', 'command', 'commandexecution', 'powershell'])

export function rowKind(segment: Pick<SharedSegment, 'name' | 'input'>): RowKind {
  const n = normalizeToolName(segment.name || '')
  if (COMMAND_ROW_TOOLS.has(n) && typeof record(segment.input).command === 'string') return 'command'
  if (toolKind(segment.name || '') === 'edit' && fileChanges(segment.name || '', segment.input).length > 0) return 'file'
  return 'tool'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
const str = (v: unknown): string => typeof v === 'string' ? v : ''

/**
 * The one-line header summary of a tool call (Traycer's `inputSummary`): the
 * path, pattern, command or query that names what the call did.
 */
export function toolSummary(name: string, input: unknown, cwd?: string): string | null {
  const i = record(input)
  const n = normalizeToolName(name)
  const path = str(i.file_path) || str(i.notebook_path) || str(i.path)
  let out = ''
  if (n === 'grep') out = str(i.pattern) + (str(i.path) ? ` em ${relativePath(str(i.path), cwd)}` : '')
  else if (n === 'glob') out = str(i.pattern)
  else if (n === 'webfetch' || n === 'web_fetch') out = str(i.url)
  else if (n === 'websearch' || n === 'web_search') out = str(i.query)
  else if (SUBAGENT_TOOLS.has(n)) out = str(i.description) || str(i.prompt)
  else if (n === 'todowrite' && Array.isArray(i.todos)) out = `${i.todos.length} ${i.todos.length === 1 ? 'tarefa' : 'tarefas'}`
  else if (n === 'askuserquestion' && Array.isArray(i.questions)) out = str(record(i.questions[0]).question)
  else if (n === 'skill') out = str(i.skill) || str(i.command)
  else if (path) out = relativePath(path, cwd)
  else if (typeof i.command === 'string') out = i.command
  else {
    for (const key of ['pattern', 'query', 'url', 'description', 'prompt', 'name', 'title']) {
      if (str(i[key])) { out = str(i[key]); break }
    }
  }
  out = singleLine(out, 200)
  return out ? out : null
}

/* ------------------------------------------------------------------ */
/* Tool input detail (Traycer ToolInputDetail)                         */
/* ------------------------------------------------------------------ */

export type InputDetail =
  | { kind: 'command'; command: string }
  | { kind: 'fields'; entries: { key: string; label: string; value: string }[] }

const MAX_FIELD = 4000

function fieldValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(value, null, 2) } catch { return String(value) }
}

/**
 * The expanded input of a tool call as a `$ command` line or a label/value
 * list, never raw JSON. Null when the header summary already says it all.
 */
export function toolInputDetail(name: string, input: unknown, summary: string | null): InputDetail | null {
  const i = record(input)
  if (typeof i.command === 'string' && toolKind(name) === 'run') return { kind: 'command', command: i.command }
  const entries = Object.entries(i)
    .map(([key, value]) => ({ key, label: key.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(), value: fieldValue(value) }))
    .filter((e) => e.value.trim() !== '')
    .map((e) => e.value.length > MAX_FIELD ? { ...e, value: `${e.value.slice(0, MAX_FIELD)}…` } : e)
  if (!entries.length) return null
  if (entries.length === 1 && summary !== null) {
    const slash = (s: string): string => s.replace(/\\/g, '/')
    const only = slash(singleLine(entries[0].value, 200)), said = slash(summary)
    if (said === only || said.endsWith(only) || only.endsWith(said)) return null
  }
  return { kind: 'fields', entries }
}

/* ------------------------------------------------------------------ */
/* Diffs                                                               */
/* ------------------------------------------------------------------ */

export interface DiffLine { type: 'context' | 'add' | 'del' | 'hunk'; text: string }
export type FileOperation = 'edit' | 'create' | 'delete' | 'write'
/**
 * One file a tool call changed. `lines` is the lightweight unified view;
 * `original` / `modified` are the before/after text handed to the full diff
 * renderer (the exact snippets for Claude edits, rebuilt from the hunks for a
 * Codex patch).
 */
export interface FileChange { path: string; operation: FileOperation; lines: DiffLine[]; additions: number; deletions: number; original: string; modified: string }

const MAX_DIFF_SIDE = 600
const MAX_RENDERED_LINES = 800

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Unified line diff of two snippets: LCS for reasonable sizes (trimmed common
 * prefix/suffix otherwise), unchanged runs folded to `context` lines around
 * each change with a `hunk` marker between separated hunks.
 */
export function lineDiff(oldText: string, newText: string, context = 3): DiffLine[] {
  const a = splitLines(oldText), b = splitLines(newText)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let ea = a.length, eb = b.length
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) { ea--; eb-- }
  const ops: DiffLine[] = a.slice(0, start).map((text) => ({ type: 'context', text }))
  const midA = a.slice(start, ea), midB = b.slice(start, eb)
  if (midA.length <= MAX_DIFF_SIDE && midB.length <= MAX_DIFF_SIDE) {
    const n = midA.length, m = midB.length
    const dp = new Uint32Array((n + 1) * (m + 1))
    for (let x = n - 1; x >= 0; x--) {
      for (let y = m - 1; y >= 0; y--) {
        dp[x * (m + 1) + y] = midA[x] === midB[y] ? dp[(x + 1) * (m + 1) + y + 1] + 1 : Math.max(dp[(x + 1) * (m + 1) + y], dp[x * (m + 1) + y + 1])
      }
    }
    let x = 0, y = 0
    while (x < n || y < m) {
      if (x < n && y < m && midA[x] === midB[y]) { ops.push({ type: 'context', text: midA[x] }); x++; y++ }
      else if (y < m && (x >= n || dp[x * (m + 1) + y + 1] >= dp[(x + 1) * (m + 1) + y])) { ops.push({ type: 'add', text: midB[y] }); y++ }
      else { ops.push({ type: 'del', text: midA[x] }); x++ }
    }
    // LCS emits adds before dels inside a changed run; unified diffs read
    // removed-then-added, so reorder each run of changes.
    for (let k = start; k < ops.length;) {
      if (ops[k].type === 'context') { k++; continue }
      let end = k
      while (end < ops.length && ops[end].type !== 'context') end++
      const run = ops.slice(k, end)
      ops.splice(k, run.length, ...run.filter((l) => l.type === 'del'), ...run.filter((l) => l.type === 'add'))
      k = end
    }
  } else {
    ops.push(...midA.map((text) => ({ type: 'del' as const, text })), ...midB.map((text) => ({ type: 'add' as const, text })))
  }
  ops.push(...a.slice(ea).map((text) => ({ type: 'context' as const, text })))
  return foldContext(ops, context)
}

/** Keeps `context` unchanged lines around each change; separate hunks get a marker. */
export function foldContext(lines: DiffLine[], context = 3): DiffLine[] {
  if (!lines.some((l) => l.type === 'add' || l.type === 'del')) return []
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, i) => {
    if (l.type === 'context') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  })
  const out: DiffLine[] = []
  let skipped = false
  lines.forEach((l, i) => {
    if (!keep[i]) { skipped = true; return }
    if (skipped && out.length) out.push({ type: 'hunk', text: '' })
    skipped = false
    out.push(l)
  })
  return out
}

/** Parses a unified diff (git / apply_patch style) into renderable lines. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let inHunk = false
  for (const line of splitLines(diff)) {
    if (line.startsWith('@@')) { if (out.length) out.push({ type: 'hunk', text: '' }); inHunk = true; continue }
    if (!inHunk) continue
    if (line.startsWith('+')) out.push({ type: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) out.push({ type: 'del', text: line.slice(1) })
    else if (line.startsWith('\\')) continue
    else out.push({ type: 'context', text: line.startsWith(' ') ? line.slice(1) : line })
  }
  return out
}

function capped(lines: DiffLine[]): DiffLine[] {
  return lines.length > MAX_RENDERED_LINES ? lines.slice(0, MAX_RENDERED_LINES) : lines
}
function count(lines: DiffLine[], type: 'add' | 'del'): number {
  return lines.reduce((n, l) => n + (l.type === type ? 1 : 0), 0)
}
function capText(text: string): string {
  const lines = text.split('\n')
  return lines.length > MAX_RENDERED_LINES ? lines.slice(0, MAX_RENDERED_LINES).join('\n') : text
}
/** Before/after text rebuilt from diff lines: context and removals vs context and additions. */
export function diffSides(lines: readonly DiffLine[]): { original: string; modified: string } {
  const pick = (skip: DiffLine['type']): string => lines.filter((l) => l.type !== skip && l.type !== 'hunk').map((l) => l.text).join('\n')
  return { original: pick('add'), modified: pick('del') }
}
function change(path: string, operation: FileOperation, lines: DiffLine[], sides = diffSides(lines), additions = count(lines, 'add'), deletions = count(lines, 'del')): FileChange {
  return { path, operation, lines: capped(lines), additions, deletions, original: capText(sides.original), modified: capText(sides.modified) }
}

/**
 * The file changes a tool call made, from Claude's Edit / MultiEdit / Write /
 * NotebookEdit inputs or Codex's `fileChange` item (`input.changes`).
 */
export function fileChanges(name: string, input: unknown): FileChange[] {
  const i = record(input)
  const n = normalizeToolName(name)
  if (Array.isArray(i.changes) || (i.changes && typeof i.changes === 'object')) {
    const list: Record<string, unknown>[] = Array.isArray(i.changes)
      ? i.changes.map(record)
      : Object.entries(record(i.changes)).map(([path, value]) => ({ path, ...record(value) }))
    return list.filter((c) => str(c.path)).map((c) => {
      const kindValue = record(c.kind).type ?? c.kind ?? c.type
      const kind = typeof kindValue === 'string' ? kindValue.toLowerCase() : 'update'
      const diff = str(c.diff) || str(c.unified_diff) || str(c.content)
      const op: FileOperation = kind === 'add' || kind === 'create' ? 'create' : kind === 'delete' || kind === 'remove' ? 'delete' : 'edit'
      if (/^@@/m.test(diff)) return change(str(c.path), op, parseUnifiedDiff(diff))
      const lines = splitLines(diff)
      if (op === 'delete') return change(str(c.path), op, lines.map((text) => ({ type: 'del', text })), { original: diff, modified: '' })
      return change(str(c.path), op, lines.map((text) => ({ type: 'add', text })), { original: '', modified: diff })
    })
  }
  const path = str(i.file_path) || str(i.notebook_path) || str(i.path)
  if (!path) return []
  if (n === 'multiedit' || n === 'multi_edit') {
    const edits = Array.isArray(i.edits) ? i.edits.map(record) : []
    const lines: DiffLine[] = []
    for (const e of edits) {
      const d = lineDiff(str(e.old_string), str(e.new_string))
      if (d.length && lines.length) lines.push({ type: 'hunk', text: '' })
      lines.push(...d)
    }
    // Independent snippets: a blank line between edits keeps them apart as hunks.
    return [change(path, 'edit', lines, {
      original: edits.map((e) => str(e.old_string)).join('\n\n'),
      modified: edits.map((e) => str(e.new_string)).join('\n\n')
    })]
  }
  if (typeof i.old_string === 'string' || typeof i.new_string === 'string') {
    return [change(path, 'edit', lineDiff(str(i.old_string), str(i.new_string)), { original: str(i.old_string), modified: str(i.new_string) })]
  }
  if (typeof i.content === 'string') {
    const lines = splitLines(i.content).map((text) => ({ type: 'add' as const, text }))
    return [change(path, 'write', lines, { original: '', modified: i.content }, lines.length, 0)]
  }
  if (typeof i.new_source === 'string') {
    return [change(path, 'edit', splitLines(i.new_source).map((text) => ({ type: 'add' as const, text })), { original: '', modified: i.new_source })]
  }
  return []
}

/** Row verb for a file change (Traycer `fileChangeVerb`), in pt-BR. */
export function fileVerb(op: FileOperation): string {
  return op === 'create' ? 'Criar' : op === 'delete' ? 'Excluir' : op === 'write' ? 'Escrever' : 'Editar'
}

/* ------------------------------------------------------------------ */
/* Timeline / activity groups                                          */
/* ------------------------------------------------------------------ */

export interface ActivityItem {
  /** Stable key: the tool/segment id when present, else the segment index. */
  key: string
  index: number
  segment: SharedSegment
  /** Thinking still streaming, or a tool still running / awaiting approval. */
  streaming: boolean
}

export type TimelineItem =
  | { kind: 'user'; key: string; segment: SharedSegment }
  | { kind: 'subagent'; key: string; segment: SharedSegment }
  | { kind: 'text'; key: string; index: number; text: string; streaming: boolean }
  | { kind: 'error'; key: string; index: number; text: string }
  | { kind: 'group'; key: string; items: ActivityItem[]; active: boolean }

export function segmentKey(segment: SharedSegment, index: number): string {
  return segment.toolId ? `${segment.kind}:${segment.toolId}` : `i${index}`
}

/**
 * Folds a turn's segments into Traycer's timeline: every run of tool calls and
 * reasoning becomes one activity group, text stands on its own. The trailing
 * group of a running turn stays active (Traycer `markTrailingActivityGroupActive`).
 * An errored turn's last text segment is the error itself.
 */
export function buildTimeline(segments: readonly SharedSegment[], opts: { running: boolean; errored?: boolean }): TimelineItem[] {
  const out: TimelineItem[] = []
  // Native subagent events replace the generic call which spawned them.
  const spawned = new Set(segments.flatMap(s => s.subagent?.spawnToolCallId ? [s.subagent.spawnToolCallId] : []))
  let run: ActivityItem[] = []
  const flush = (): void => {
    if (!run.length) return
    out.push({ kind: 'group', key: `g:${run[0].key}`, items: run, active: run.some((r) => r.streaming) })
    run = []
  }
  const last = segments.length - 1
  segments.forEach((segment, index) => {
    const key = segmentKey(segment, index)
    if (segment.subagent) { flush(); out.push({ kind: 'subagent', key, segment }); return }
    if (segment.kind === 'tool' && segment.toolId && spawned.has(segment.toolId)) return
    if (segment.kind === 'user') { flush(); out.push({ kind: 'user', key, segment }); return }
    if (segment.kind === 'text') {
      const text = segment.text || ''
      if (opts.errored && index === last && !opts.running) { flush(); out.push({ kind: 'error', key, index, text }); return }
      if (!text.trim()) return
      flush()
      out.push({ kind: 'text', key, index, text, streaming: opts.running && index === last })
      return
    }
    const streaming = segment.kind === 'thinking'
      ? opts.running && index === last
      : segment.status === 'running' || segment.status === 'awaiting'
    if (segment.kind === 'thinking' && !(segment.text || '').trim() && !streaming) return
    run.push({ key, index, segment, streaming })
  })
  flush()
  const tail = out[out.length - 1]
  if (opts.running && tail?.kind === 'group' && !tail.active) out[out.length - 1] = { ...tail, active: true }
  return out
}

/* ------------------------------------------------------------------ */
/* Group summary ("Pensou por 5s, leu 3 arquivos, executou 2 comandos") */
/* ------------------------------------------------------------------ */

function countPhrase(n: number, verb: string, singular: string, plural: string): string | null {
  return n === 0 ? null : `${verb} ${n} ${n === 1 ? singular : plural}`
}
function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value
}
function thoughtClock(ms: number): string {
  return formatClock(Math.max(1, Math.round(ms / 1000)))
}

/** What a reasoning block calls itself: `Pensando` while streaming, else its total. */
export function reasoningLabel(streaming: boolean, durationMs: number | null): string {
  if (streaming) return 'Pensando'
  return durationMs === null ? 'Pensou' : `Pensou por ${thoughtClock(durationMs)}`
}

/**
 * Traycer `activityGroupSummary`, in pt-BR. `durations` holds the measured
 * duration (ms) of finished reasoning blocks by item key.
 */
export function groupSummary(items: readonly ActivityItem[], durations: ReadonlyMap<string, number> = new Map()): string {
  let thinkingPresent = false, thinkingCompleted = false, durationKnown = false, partial = false, thinkingMs = 0
  let explored = 0, read = 0, searched = 0, ran = 0, hooks = 0, browsed = 0, subagents = 0, denied = 0, used = 0
  const edited = new Set<string>()
  for (const item of items) {
    const s = item.segment
    if (s.kind === 'thinking') {
      thinkingPresent = true
      if (item.streaming) continue
      thinkingCompleted = true
      const d = durations.get(item.key)
      if (d === undefined) partial = true
      else { durationKnown = true; thinkingMs += d }
      continue
    }
    if (s.status === 'denied') { denied++; continue }
    const kind = toolKind(s.name || '')
    if (kind === 'edit') {
      const files = fileChanges(s.name || '', s.input)
      if (files.length) files.forEach((f) => edited.add(f.path))
      else edited.add(item.key)
    } else if (kind === 'explore') explored++
    else if (kind === 'read') read++
    else if (kind === 'search') searched++
    else if (kind === 'run') ran++
    else if (kind === 'hook') hooks++
    else if (kind === 'browser') browsed++
    else if (kind === 'subagent') subagents++
    else used++
  }
  let thinking: string | null = null
  if (thinkingPresent) {
    if (durationKnown) thinking = `pensou por ${thoughtClock(thinkingMs)}${partial ? '+' : ''}`
    else thinking = thinkingCompleted ? 'pensou' : 'pensando'
  }
  const parts = [
    thinking,
    countPhrase(explored, 'explorou', 'arquivo', 'arquivos'),
    countPhrase(read, 'leu', 'arquivo', 'arquivos'),
    countPhrase(searched, 'buscou em', 'lugar', 'lugares'),
    countPhrase(edited.size, 'editou', 'arquivo', 'arquivos'),
    countPhrase(ran, 'executou', 'comando', 'comandos'),
    countPhrase(hooks, 'executou', 'hook', 'hooks'),
    countPhrase(browsed, 'navegou em', 'página', 'páginas'),
    countPhrase(subagents, 'criou', 'subagente', 'subagentes'),
    countPhrase(denied, 'negou', 'solicitação', 'solicitações'),
    countPhrase(used, 'usou', 'ferramenta', 'ferramentas')
  ].filter((p): p is string => p !== null)
  return parts.length ? capitalize(parts.join(', ')) : 'Executou atividade'
}

/** True when a group is nothing but one reasoning block, which then drops its own header. */
export function soleReasoning(items: readonly ActivityItem[]): boolean {
  return items.length === 1 && items[0].segment.kind === 'thinking'
}

/** Plain text of a reply for the footer copy button: its text segments only. */
export function replyText(segments: readonly SharedSegment[], fallback = ''): string {
  const text = segments.filter((s) => s.kind === 'text').map((s) => (s.text || '').trim()).filter(Boolean).join('\n\n')
  return text || fallback.trim()
}
