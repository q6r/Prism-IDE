import type { EventEmitter } from 'events'
import type { Dirent } from 'fs'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { ipcMain, app } from 'electron'
import { CodexServer } from '../codexServer'
import { profileEnvironment, providerCommand } from '../providers'
import type { Provider } from '../../shared/agents'

/** One row of the provider's own `/` catalog (Traycer's GuiAgentCommandOption). */
export interface AgentCommand {
  /** Without the leading slash. */
  name: string
  description: string
  argumentHint: string | null
  kind: 'slash-command' | 'skill'
  /** Claude Code's own command, as opposed to a user, project, plugin or MCP one. */
  builtin: boolean
}

/** A Codex skill as `turn/start` takes it (SkillUserInput). */
export interface CodexSkillRef {
  name: string
  path: string
}

const cache = new Map<string, { profileId: string; expires: number; result: Promise<AgentCommand[]> }>()
// The last `skills/list` answer per Codex account and folder, kept for the
// structured skill items of a turn (see codexSkillInputs).
const codexSkillCache = new Map<string, { profileId: string; skills: CodexSkillRef[] }>()
const codexSkillKey = (profileId: string, cwd: string): string => JSON.stringify([profileId, cwd || ''])

/**
 * The Codex skills the `/` menu last listed for this account and folder, or
 * null when it has not listed them yet. Synchronous on purpose: a turn never
 * waits for a listing.
 */
export function cachedCodexSkills(profileId: string, cwd: string): readonly CodexSkillRef[] | null {
  return codexSkillCache.get(codexSkillKey(profileId, cwd))?.skills ?? null
}

export function registerAgentCommandHandlers(): void {
  ;(app as unknown as EventEmitter).on('prism:profile-changed', (id: unknown) => {
    for (const [key, entry] of cache) if (entry.profileId === String(id)) cache.delete(key)
    for (const [key, entry] of codexSkillCache) if (entry.profileId === String(id)) codexSkillCache.delete(key)
  })
  // Per account and folder: project commands and skills live in the folder.
  ipcMain.handle('agents:commands', (_e, provider: Provider, profileId: string, cwd: string, refresh = false) => {
    const key = JSON.stringify([provider, profileId, cwd || '']), hit = cache.get(key)
    if (!refresh && hit && hit.expires > Date.now()) return hit.result
    const result = discoverCommands(provider, profileId, cwd || '').catch((err) => { cache.delete(key); throw err })
    cache.set(key, { profileId, expires: Date.now() + 300000, result })
    return result
  })
}

export async function discoverCommands(provider: Provider, profileId: string, cwd: string): Promise<AgentCommand[]> {
  if (provider === 'codex') {
    // Codex exposes no slash commands outside its TUI; its skills it lists.
    const server = new CodexServer(profileId, cwd || undefined)
    try {
      await server.ready
      const response = await server.request('skills/list', { cwds: cwd ? [cwd] : [] })
      codexSkillCache.set(codexSkillKey(profileId, cwd), { profileId, skills: codexSkillRefs(response) })
      return codexSkillCommands(response)
    } finally { server.close() }
  }
  if (provider !== 'claude') throw new Error('Agente inválido.')
  // A Traycer-linked profile always runs Traycer's managed CLI.
  const command = providerCommand('claude', profileId)
  if (!command) throw new Error('Instale o Claude Code para consultar seus comandos.')
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const controller = new AbortController()
  // Empty input, as in discoverModels: the control protocol answers the
  // catalog without a model request. Same folder and setting sources as a
  // real turn, so project commands and skills are the ones the run will see.
  async function* input(): AsyncGenerator<any> { await new Promise<void>((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true })) }
  const query = sdk.query({ prompt: input(), options: { abortController: controller, cwd: cwd || undefined,
    pathToClaudeCodeExecutable: command.args[0] || command.bin, env: profileEnvironment(provider, profileId), persistSession: false,
    settingSources: ['user', 'project', 'local'] } })
  const timer = setTimeout(() => controller.abort(), 25000)
  try {
    const [rows, skills] = await Promise.all([query.supportedCommands(), claudeSkillNames(cwd)])
    return claudeCommands(rows, skills)
  } finally { clearTimeout(timer); controller.abort(); query.close() }
}

/**
 * Claude's rows. The SDK marks its own commands (`builtin`) but does not tell
 * a skill from a custom command, so a non-built-in row whose name is a skill
 * folder on disk (user or project `.claude/skills/<name>/SKILL.md`) is a skill.
 */
export function claudeCommands(rows: readonly { name?: unknown; description?: unknown; argumentHint?: unknown; builtin?: unknown }[], skills: ReadonlySet<string>): AgentCommand[] {
  const out: AgentCommand[] = []
  for (const row of rows) {
    const name = typeof row?.name === 'string' ? row.name.trim().replace(/^\//, '') : ''
    if (!name) continue
    const builtin = row.builtin === true
    const hint = typeof row.argumentHint === 'string' ? row.argumentHint.trim() : ''
    out.push({ name, description: typeof row.description === 'string' ? row.description : '', argumentHint: hint || null,
      kind: !builtin && skills.has(name) ? 'skill' : 'slash-command', builtin })
  }
  return out
}

/** Enabled skills from Codex's `skills/list`, first occurrence of a name wins. */
export function codexSkillCommands(response: unknown): AgentCommand[] {
  const out: AgentCommand[] = []
  const seen = new Set<string>()
  const entries = Array.isArray((response as { data?: unknown })?.data) ? (response as { data: unknown[] }).data : []
  for (const entry of entries) {
    const skills = Array.isArray((entry as { skills?: unknown })?.skills) ? (entry as { skills: any[] }).skills : []
    for (const skill of skills) {
      const name = typeof skill?.name === 'string' ? skill.name.trim() : ''
      if (!name || skill.enabled === false || seen.has(name)) continue
      seen.add(name)
      const description = [skill.description, skill.interface?.shortDescription, skill.shortDescription].find((d) => typeof d === 'string' && d.trim())
      out.push({ name, description: description || '', argumentHint: null, kind: 'skill', builtin: false })
    }
  }
  return out
}

/** Enabled skills with a path from Codex's `skills/list`, first occurrence of a name wins. */
export function codexSkillRefs(response: unknown): CodexSkillRef[] {
  const out: CodexSkillRef[] = []
  const seen = new Set<string>()
  const entries = Array.isArray((response as { data?: unknown })?.data) ? (response as { data: unknown[] }).data : []
  for (const entry of entries) {
    const skills = Array.isArray((entry as { skills?: unknown })?.skills) ? (entry as { skills: any[] }).skills : []
    for (const skill of skills) {
      const name = typeof skill?.name === 'string' ? skill.name.trim() : ''
      if (!name || skill.enabled === false || seen.has(name)) continue
      seen.add(name)
      if (typeof skill.path === 'string' && skill.path.trim()) out.push({ name, path: skill.path })
    }
  }
  return out
}

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/

/**
 * The structured skill items for a Codex turn: every `$name` token in the
 * prompt (at the start or after whitespace, as Codex's own composer writes
 * them) whose name is exactly an enabled skill's — tried as typed, then
 * without trailing sentence punctuation (`$pdf.`). Each skill once, in order
 * of appearance. The text keeps the tokens; these items only tell Codex which
 * skill files they name.
 */
export function codexSkillInputs(prompt: string, skills: readonly CodexSkillRef[]): { type: 'skill'; name: string; path: string }[] {
  if (!skills.length || !prompt.includes('$')) return []
  const byName = new Map(skills.map((s) => [s.name, s]))
  const out: { type: 'skill'; name: string; path: string }[] = []
  const used = new Set<string>()
  for (const match of prompt.matchAll(/(?:^|\s)\$([^\s$]+)/g)) {
    const token = match[1]
    const skill = byName.get(token) ?? byName.get(token.replace(TRAILING_PUNCTUATION, ''))
    if (!skill || used.has(skill.name)) continue
    used.add(skill.name)
    out.push({ type: 'skill', name: skill.name, path: skill.path })
  }
  return out
}

async function claudeSkillNames(cwd: string): Promise<Set<string>> {
  const roots = [join(homedir(), '.claude', 'skills'), ...(cwd ? [join(cwd, '.claude', 'skills')] : [])]
  const names = new Set<string>()
  await Promise.all(roots.map(async (root) => {
    let entries: Dirent[]
    try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return }
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) return
      try { await fs.access(join(root, entry.name, 'SKILL.md')); names.add(entry.name) } catch { /* not a skill */ }
    }))
  }))
  return names
}
