/**
 * Pure logic behind the composer's `/` (commands, skills) and `@` (workspace
 * files) menus — Traycer's composer pickers (chat/composer/picker/*,
 * lib/composer/slash-command-ranking.ts, lib/composer/mentions/*) adapted to a
 * plain textarea. No runtime imports: tests load this file on its own.
 *
 * Mentions are inserted as text, `@caminho/relativo` (folders end in `/`,
 * paths with spaces are quoted: `@"a b/c.ts"`). Claude Code reads that syntax
 * itself. For Codex the text is sent as is, not expanded: the agent runs in the
 * chat's folder with its own file tools, so a path relative to it is
 * unambiguous, the prompt does not grow by whole files, and the transcript
 * shows exactly what was typed.
 */

export type TriggerKind = 'slash' | 'mention' | 'image'

export interface ComposerTrigger {
  readonly kind: TriggerKind
  /** Index of the trigger character (`/`, `@` or `#`). */
  readonly start: number
  /** End of the token (first whitespace at or after the caret): the span a commit replaces. */
  readonly end: number
  /** Text typed between the trigger and the caret. */
  readonly query: string
  /** Only whitespace precedes the trigger, so a whole-prompt command is legal here. */
  readonly leading: boolean
}

const TRIGGERS: Readonly<Record<string, TriggerKind>> = { '/': 'slash', '@': 'mention' }
const SPACE = /\s/

/**
 * The trigger token the caret is in, if any. A trigger opens only at the start
 * of a word (start of the text or after whitespace) and its query never
 * contains whitespace or a second trigger character — `a/b`, `/src/x`,
 * `nome@site.com` and `@a@b` stay plain text, as with Traycer's suggestion
 * matcher.
 */
export function findTrigger(text: string, caret: number): ComposerTrigger | null {
  if (!Number.isInteger(caret) || caret < 1 || caret > text.length) return null
  const image = findImageTrigger(text, caret)
  if (image) return image
  let start = caret
  while (start > 0 && !SPACE.test(text[start - 1])) start--
  const char = text[start]
  const kind = TRIGGERS[char]
  if (!kind || start >= caret) return null
  const query = text.slice(start + 1, caret)
  if (query.includes(char)) return null
  let end = caret
  while (end < text.length && !SPACE.test(text[end])) end++
  return { kind, start, end, query, leading: text.slice(0, start).trim() === '' }
}

/** Image references include a space before their number, unlike other tokens. */
function findImageTrigger(text: string, caret: number): ComposerTrigger | null {
  const candidates = /(^|\s)#(?:image(?:[ \t]*\d+|[ \t]*)?|imag|ima|im|i)?(?=$|[\s.,!?;:)])/gi
  for (const match of text.matchAll(candidates)) {
    const start = match.index! + match[1].length
    const end = match.index! + match[0].length
    if (caret <= start || caret > end || /^(?:\.[\p{L}_]|[/\\])/u.test(text.slice(end)) || insideCode(text, start)) continue
    return { kind: 'image', start, end, query: text.slice(start + 1, caret), leading: text.slice(0, start).trim() === '' }
  }
  return null
}

/** Keep literal references in inline code and fenced examples out of the picker. */
function insideCode(text: string, at: number): boolean {
  const prefix = text.slice(0, at)
  let fence: string | null = null
  for (const line of prefix.split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (!marker) continue
    if (fence === null) fence = marker
    else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
  }
  if (fence !== null) return true
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1)
  let ticks = 0
  for (const match of line.matchAll(/`+/g)) {
    if (ticks === 0) ticks = match[0].length
    else if (ticks === match[0].length) ticks = 0
  }
  return ticks > 0
}

/** Numeric queries filter image labels; an unfinished `#image` lists every image. */
export function rankImageReferences<T extends { readonly number: number }>(images: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q || ['i', 'im', 'ima', 'imag', 'image'].includes(q)) return [...images]
  const number = q.replace(/^image\s*/, '')
  return /^\d+$/.test(number) ? images.filter(image => String(image.number).startsWith(number)) : []
}

/** Stable identity of one trigger occurrence, for "Esc keeps this one closed". */
export function triggerKey(trigger: ComposerTrigger | null): string | null {
  return trigger ? `${trigger.kind}:${trigger.start}` : null
}

/** Text after replacing `[start, end)` with `insert`, and where the caret lands. */
export function applyCompletion(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + insert + text.slice(end), caret: start + insert.length }
}

/** Follow an image's insertion point while its file is being read. */
export function rebaseInsertionPoint(before: string, after: string, at: number, affinity: 'left' | 'right' = 'left'): number {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let suffix = 0
  while (suffix < before.length - start && suffix < after.length - start && before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  const end = before.length - suffix
  const nextEnd = after.length - suffix
  if (at < start || (at === start && affinity === 'left')) return at
  if (at >= end) return Math.max(0, Math.min(after.length, at + nextEnd - end))
  return nextEnd
}

/** Automatic uploads insert references in place without replacing existing prose. */
export function imageReferenceInsertion(text: string, at: number, numbers: readonly number[]): { text: string; insert: string; caret: number } {
  at = Math.max(0, Math.min(at, text.length))
  const labels = numbers.map(number => `#image ${number}`).join(' ')
  if (!labels) return { text, insert: '', caret: at }
  const prefix = at > 0 && !/\s/.test(text[at - 1]) ? ' ' : ''
  const suffix = text[at] && /\s/.test(text[at]) ? '' : ' '
  const insert = `${prefix}${labels}${suffix}`
  return { ...applyCompletion(text, at, at, insert), insert }
}

/** Removing a new upload also removes its automatic references from the prose. */
export function imageReferenceRemoval(text: string, number: number): { text: string; start: number; end: number; insert: string } | null {
  const ranges: { start: number; end: number }[] = []
  const pattern = new RegExp(`(^|[\\s([{\"'<>:,;!?])#image[ \\t]*${number}(?![\\p{L}\\p{N}_]|[.,]\\d|\\.[\\p{L}\\p{N}_]|[/\\\\])`, 'giu')
  for (const match of text.matchAll(pattern)) {
    const start = (match.index || 0) + match[1].length
    if (insideCode(text, start)) continue
    const end = (match.index || 0) + match[0].length
    ranges.push({ start, end: text[end] === ' ' ? end + 1 : end })
  }
  if (!ranges.length) return null
  const start = ranges[0].start, end = ranges[ranges.length - 1].end
  let insert = text.slice(start, end)
  for (const range of ranges.reverse()) insert = insert.slice(0, range.start - start) + insert.slice(range.end - start)
  return { text: text.slice(0, start) + insert + text.slice(end), start, end, insert }
}

/**
 * Span a run-and-vanish command removes: its token plus one following space,
 * so `/limpar resto` leaves `resto` rather than ` resto`.
 */
export function removalRange(text: string, trigger: Pick<ComposerTrigger, 'start' | 'end'>): { start: number; end: number } {
  return { start: trigger.start, end: text[trigger.end] === ' ' ? trigger.end + 1 : trigger.end }
}

/** Arrow-key movement through the rows, wrapping at both ends (Traycer's moveActive). */
export function wrapIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  const from = Math.min(Math.max(index, 0), length - 1)
  return (((from + delta) % length) + length) % length
}

/* ---------------- Ranking ---------------- */

/**
 * Subsequence match of `query` in `text` (case-insensitive): lower is better
 * (where the match starts plus the gaps inside it), null when `query` is not a
 * subsequence. Stands in for Traycer's Fuse pass, which this app cannot ship.
 */
export function fuzzyScore(text: string, query: string): number | null {
  const t = text.toLowerCase(), q = query.toLowerCase()
  if (!q) return 0
  let score = 0, from = 0
  for (let i = 0; i < q.length; i++) {
    const at = t.indexOf(q[i], from)
    if (at < 0) return null
    score += i === 0 ? at : at - from
    from = at + 1
  }
  return score
}

/**
 * Traycer's literal-hit tiers on the row's primary text: 0 prefix, 1
 * substring, 2 anything else that still matched. Null drops the row.
 */
function nameTier(name: string, query: string): number | null {
  const n = name.toLowerCase(), q = query.toLowerCase()
  if (n.startsWith(q)) return 0
  if (n.includes(q)) return 1
  return null
}

export interface SlashCommandItem {
  /** Unique across groups, e.g. `prism:limpar` or `skill:frontend-design`. */
  readonly id: string
  /** Without the leading slash. */
  readonly name: string
  readonly description: string
  readonly argumentHint: string | null
  readonly group: CommandGroup
  /** How the provider invokes it: `/name`, or `$name` for a Codex skill. */
  readonly prefix: '/' | '$'
  /**
   * `run`: a Prism action, the token disappears. `insert`: `/name ` goes into
   * the prompt for the provider to execute. `template`: the token becomes a
   * ready prompt about the open file.
   */
  readonly action: 'run' | 'insert' | 'template'
  readonly template: string | null
  /** Only legal as the first token of the prompt (everything but skills). */
  readonly leadingOnly: boolean
  /** Why the row cannot be chosen right now; null when it can. */
  readonly disabledReason: string | null
}

/**
 * Name hits first (prefix, then substring), then name subsequences and
 * description substrings ordered by fuzzy score; rows matching nothing are
 * dropped. Ties keep the input order, which callers pass alphabetical.
 */
export function rankSlashCommands<T extends Pick<SlashCommandItem, 'name' | 'description'>>(commands: readonly T[], query: string): T[] {
  const q = query.trim()
  if (!q) return [...commands]
  const scored: { item: T; tier: number; score: number; index: number }[] = []
  commands.forEach((item, index) => {
    const tier = nameTier(item.name, q)
    if (tier !== null) { scored.push({ item, tier, score: 0, index }); return }
    const fuzzy = fuzzyScore(item.name, q)
    const inDescription = item.description.toLowerCase().includes(q.toLowerCase())
    if (fuzzy === null && !inDescription) return
    scored.push({ item, tier: 2, score: fuzzy ?? item.name.length + 1, index })
  })
  return scored.sort((a, b) => a.tier - b.tier || a.score - b.score || a.index - b.index).map((s) => s.item)
}

/* ---------------- Slash catalog ---------------- */

export type CommandGroup = 'prism' | 'custom' | 'native' | 'skill'

export const COMMAND_GROUP_LABEL: Readonly<Record<CommandGroup, string>> = {
  prism: 'Prism',
  custom: 'Personalizados',
  native: 'Comandos do Claude',
  skill: 'Skills'
}

const GROUP_ORDER: readonly CommandGroup[] = ['prism', 'custom', 'native', 'skill']
// Which row keeps a shared name: Prism's own (Traycer's local-first dedupe),
// then the provider's built-in (Claude runs it over a same-named user one).
const DEDUPE_ORDER: readonly CommandGroup[] = ['prism', 'native', 'custom', 'skill']

/** Traycer's NATIVE_COMMAND_DISABLED_REASON, for a command typed mid-prompt. */
export const LEADING_ONLY_REASON = 'Este comando só pode ser usado no início da mensagem.'

export interface PrismCommandContext {
  readonly provider: 'claude' | 'codex'
  /** A turn is running in this chat. */
  readonly busy: boolean
  /** There is a Claude session on the chat's current route to compact. */
  readonly canCompact: boolean
  /** The editor has an active file the templates can attach. */
  readonly hasOpenFile: boolean
  /** Claude's own catalog lists `/compact`: that row replaces `/compactar`, as in Traycer. */
  readonly nativeCompact?: boolean
}

const BUSY_REASON = 'Aguarde o turno atual terminar.'
const NO_FILE_REASON = 'Abra um arquivo no editor para usar este comando.'

function prismCommand(name: string, description: string, action: SlashCommandItem['action'], extra: Partial<SlashCommandItem> = {}): SlashCommandItem {
  return { id: `prism:${name}`, name, description, argumentHint: null, group: 'prism', prefix: '/', action, template: null, leadingOnly: true, disabledReason: null, ...extra }
}

/**
 * The commands the old chat panel handled itself, mapped onto the unified
 * chat: `/limpar` opens a new chat, the account commands open Settings ›
 * Provedores, `/compactar` sends Claude's `/compact` (hidden for Codex, which
 * has no equivalent here, and once Claude's own `/compact` is listed).
 * Alphabetical, as Traycer sorts its catalog.
 */
export function prismCommands(ctx: PrismCommandContext): SlashCommandItem[] {
  const template = (name: string, description: string, text: string): SlashCommandItem =>
    prismCommand(name, description, 'template', { template: text, disabledReason: ctx.hasOpenFile ? null : NO_FILE_REASON })
  return [
    ...(ctx.provider === 'claude' && !ctx.nativeCompact ? [prismCommand('compactar', 'Compactar o contexto da conversa', 'run', {
      disabledReason: ctx.busy ? BUSY_REASON : ctx.canCompact ? null : 'Ainda não há uma sessão do Claude para compactar neste chat.'
    })] : []),
    prismCommand('conta', 'Ver contas e uso em Configurações › Provedores', 'run'),
    template('corrigir', 'Corrigir bugs do arquivo aberto', 'Revise o arquivo aberto e corrija possíveis bugs.'),
    template('explicar', 'Explicar o arquivo aberto', 'Explique o que o arquivo aberto faz, em alto nível.'),
    prismCommand('limpar', 'Limpar conversa (novo chat)', 'run'),
    prismCommand('login', 'Entrar em outra conta em Configurações › Provedores', 'run'),
    prismCommand('logout', 'Sair de uma conta em Configurações › Provedores', 'run'),
    prismCommand('remote-control', 'Controlar esta conversa de outro dispositivo', 'run'),
    prismCommand('sessoes', 'Ver sessões anteriores', 'run'),
    template('testes', 'Escrever testes para o arquivo aberto', 'Escreva testes para o arquivo aberto.')
  ]
}

/** Shape of `window.prism.commands.list()` rows (SlashCommandIpc). */
export interface DiskCommand {
  readonly name: string
  readonly description: string
  readonly source: 'user' | 'project' | 'skill' | 'client'
}

/**
 * Claude's custom commands (`.claude/commands`) and skills (`.claude/skills`)
 * read from disk — the fallback while the provider's own catalog loads or
 * when it fails. They only reach Claude Code, and only the local machine's,
 * so a Codex or SSH chat lists none.
 */
export function diskCommandItems(list: readonly DiskCommand[], ctx: { provider: 'claude' | 'codex'; remote: boolean }): SlashCommandItem[] {
  if (ctx.provider !== 'claude' || ctx.remote) return []
  return list.filter((c) => c.source !== 'client' && c.name.replace(/^\//, '')).map((c): SlashCommandItem => {
    const name = c.name.replace(/^\//, '')
    const skill = c.source === 'skill'
    return { id: `${skill ? 'skill' : 'custom'}:${name}`, name, description: c.description, argumentHint: null,
      group: skill ? 'skill' : 'custom', prefix: '/', action: 'insert', template: null, leadingOnly: !skill, disabledReason: null }
  })
}

/** Shape of `window.prism.agentCommands.list()` rows (main: ipc/agentCommands.ts). */
export interface NativeCommand {
  readonly name: string
  readonly description: string
  readonly argumentHint: string | null
  readonly kind: 'slash-command' | 'skill'
  /** Claude Code's own command, as opposed to a user, project, plugin or MCP one. */
  readonly builtin: boolean
}

/**
 * The provider's own catalog: Claude's built-in commands, its custom ones
 * (user, project, plugin, MCP) and skills; Codex's skills, which Codex invokes
 * as `$name`. The server's catalog is not reachable over SSH, so a remote
 * chat lists none.
 */
export function nativeCommandItems(list: readonly NativeCommand[], ctx: { provider: 'claude' | 'codex'; remote: boolean }): SlashCommandItem[] {
  if (ctx.remote) return []
  const out: SlashCommandItem[] = []
  for (const c of list) {
    const name = c.name.trim().replace(/^[/$]/, '')
    if (!name) continue
    const skill = c.kind === 'skill' || ctx.provider === 'codex'
    const group: CommandGroup = skill ? 'skill' : c.builtin ? 'native' : 'custom'
    out.push({ id: `${group}:${name}`, name, description: c.description, argumentHint: c.argumentHint?.trim() || null, group,
      prefix: ctx.provider === 'codex' ? '$' : '/', action: 'insert', template: null, leadingOnly: !skill, disabledReason: null })
  }
  return out
}

export interface CommandSection {
  readonly group: CommandGroup
  readonly label: string
  readonly items: readonly SlashCommandItem[]
}

/**
 * The `/` menu for a typed query. A name typed the same way (`/x` or `$x`)
 * keeps one row: Prism's, then a built-in, then a custom command, then a skill
 * (Traycer's local-before-provider dedupe). Each group is ranked on its own and
 * empty groups disappear. Past the start of the prompt only skills can be
 * chosen; the other rows stay listed and say why (Traycer's slashItemsForScope).
 */
export function buildCommandSections(commands: readonly SlashCommandItem[], query: string, leading: boolean): CommandSection[] {
  const seen = new Set<string>()
  const unique: SlashCommandItem[] = []
  for (const group of DEDUPE_ORDER) {
    for (const c of commands) {
      const key = `${c.prefix}${c.name.toLowerCase()}`
      if (c.group !== group || seen.has(key)) continue
      seen.add(key)
      unique.push(c)
    }
  }
  return GROUP_ORDER.map((group) => {
    const ranked = rankSlashCommands(unique.filter((c) => c.group === group)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })), query)
    const items = ranked.map((c) => !leading && c.leadingOnly && c.disabledReason === null ? { ...c, disabledReason: LEADING_ONLY_REASON } : c)
    return { group, label: COMMAND_GROUP_LABEL[group], items }
  }).filter((s) => s.items.length > 0)
}

/* ---------------- File mentions ---------------- */

export interface MentionEntry {
  /** Unique row id, e.g. `file:src/a.ts`. */
  readonly id: string
  readonly kind: 'file' | 'folder'
  /** Path relative to the chat's folder, always with `/`. */
  readonly rel: string
  /** Last path segment: the row's label. */
  readonly name: string
  /** Parent directory relative to the folder ('' at the root): the row's trailing detail. */
  readonly dir: string
  readonly absolutePath: string
  readonly depth: number
}

export function basenameOf(rel: string): string {
  const trimmed = rel.replace(/\/+$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export function dirnameOf(rel: string): string {
  const trimmed = rel.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  return at < 0 ? '' : trimmed.slice(0, at)
}

/** `root` joined with a `/`-relative path, in the root's own separator style. */
export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.split('/').join(sep)}`
}

/**
 * Rows for the files the workspace listing returned, plus every folder that
 * holds them (Traycer offers Files and Folders). `rel` from the listing may
 * use `\\`; rows always use `/`.
 */
export function mentionEntries(files: readonly { path: string; rel: string }[], root: string): MentionEntry[] {
  const out: MentionEntry[] = []
  const folders = new Set<string>()
  for (const file of files) {
    const rel = file.rel.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!rel) continue
    const segments = rel.split('/')
    for (let i = 1; i < segments.length; i++) folders.add(segments.slice(0, i).join('/'))
    out.push({ id: `file:${rel}`, kind: 'file', rel, name: segments[segments.length - 1], dir: dirnameOf(rel), absolutePath: file.path, depth: segments.length - 1 })
  }
  for (const rel of folders) {
    out.push({ id: `folder:${rel}`, kind: 'folder', rel, name: basenameOf(rel), dir: dirnameOf(rel), absolutePath: joinPath(root, rel), depth: rel.split('/').length - 1 })
  }
  return out
}

/** Traycer fills a provider's list up to 25 rows. */
export const MENTION_LIMIT = 25

/**
 * Ranks mention rows for a query. Empty query: the files open in the editor
 * first (in `pinned` order), then the tree from the top (shallow first,
 * folders before files, alphabetical). Otherwise name prefix, name substring,
 * then path substring/subsequence by fuzzy score, shorter paths first.
 */
export function rankMentions(entries: readonly MentionEntry[], query: string, pinned: readonly string[] = [], limit = MENTION_LIMIT): MentionEntry[] {
  const q = query.trim().replace(/\\/g, '/')
  if (!q) {
    const byRel = new Map(entries.map((e) => [e.rel, e]))
    const top: MentionEntry[] = []
    for (const rel of pinned) {
      const entry = byRel.get(rel)
      if (entry && entry.kind === 'file' && !top.includes(entry)) top.push(entry)
    }
    const rest = entries.filter((e) => !top.includes(e)).sort((a, b) => a.depth - b.depth
      || (a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1) || a.rel.localeCompare(b.rel, undefined, { sensitivity: 'base', numeric: true }))
    return [...top, ...rest].slice(0, limit)
  }
  const scored: { entry: MentionEntry; tier: number; score: number }[] = []
  for (const entry of entries) {
    const tier = nameTier(entry.name, q)
    if (tier !== null) { scored.push({ entry, tier, score: entry.rel.length }); continue }
    const inPath = entry.rel.toLowerCase().indexOf(q.toLowerCase())
    const fuzzy = inPath >= 0 ? inPath : fuzzyScore(entry.rel, q)
    if (fuzzy === null) continue
    scored.push({ entry, tier: 2, score: fuzzy * 4 + entry.rel.length })
  }
  return scored.sort((a, b) => a.tier - b.tier || a.score - b.score
    || (a.entry.kind === b.entry.kind ? 0 : a.entry.kind === 'file' ? -1 : 1)
    || a.entry.rel.localeCompare(b.entry.rel, undefined, { sensitivity: 'base', numeric: true }))
    .slice(0, limit).map((s) => s.entry)
}

/** The prompt text for a mention: `@rel`, `@rel/` for folders, quoted when it has spaces. */
export function mentionText(entry: Pick<MentionEntry, 'rel' | 'kind'>): string {
  const path = entry.kind === 'folder' ? `${entry.rel.replace(/\/+$/, '')}/` : entry.rel
  return SPACE.test(path) ? `@"${path}"` : `@${path}`
}

/** Rel paths (within `root`) of the files open in the editor, for the empty `@` list. */
export function relativeTo(root: string, absolute: string): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const r = norm(root), a = norm(absolute)
  if (!r) return null
  const insensitive = /^[a-z]:\//i.test(r)
  const head = a.slice(0, r.length)
  if (!(insensitive ? head.toLowerCase() === r.toLowerCase() : head === r) || a[r.length] !== '/') return null
  return a.slice(r.length + 1) || null
}

/**
 * Traycer's mentionPathTree: the preview's folder rows — a root label that
 * absorbs everything above the last two folders, those folders, then the leaf.
 */
export interface MentionPathTree {
  readonly rootLabel: string
  readonly midDirs: readonly string[]
  readonly leaf: string
  readonly leafIsFile: boolean
}

export function mentionPathTree(path: string, leafIsFile: boolean): MentionPathTree {
  const trimmed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const isAbsolute = trimmed.startsWith('/')
  const segments = trimmed.split('/').filter((s) => s.length > 0)
  if (segments.length === 0) return { rootLabel: '', midDirs: [], leaf: '', leafIsFile }
  const leafSegment = segments[segments.length - 1]
  const dirs = segments.slice(0, -1)
  const topIndex = Math.max(0, dirs.length - 3)
  const rootDirs = dirs.slice(0, topIndex + 1)
  const rootLabel = rootDirs.length === 0 ? '' : `${isAbsolute ? '/' : ''}${rootDirs.join('/')}`
  const leaf = isAbsolute && dirs.length === 0 ? `/${leafSegment}` : leafSegment
  return { rootLabel, midDirs: dirs.slice(topIndex + 1), leaf, leafIsFile }
}

/** Past this the root row is middle-elided (Traycer's ROOT_LABEL_CHAR_BUDGET). */
const ROOT_LABEL_CHAR_BUDGET = 42

export function middleElideRootLabel(rootLabel: string): string {
  if (rootLabel.length <= ROOT_LABEL_CHAR_BUDGET) return rootLabel
  const isAbsolute = rootLabel.startsWith('/')
  const segments = (isAbsolute ? rootLabel.slice(1) : rootLabel).split('/')
  if (segments.length <= 2) return rootLabel
  return `${isAbsolute ? '/' : ''}${segments[0]}/…/${segments[segments.length - 1]}`
}
