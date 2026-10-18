import Store from 'electron-store'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import { mkdirSync, existsSync, readFileSync, realpathSync, lstatSync, statSync } from 'fs'
import { join, dirname, basename, resolve, relative, isAbsolute } from 'path'
import { homedir } from 'os'
import { execFile, execFileSync } from 'child_process'
import type { Provider, ProviderProfile, UnifiedChat } from '../shared/agents'
import { AgentRepository } from './agentRepository'

const legacyStore = new Store<{ profiles: ProviderProfile[]; chats: UnifiedChat[] }>({
  name: 'prism-agents', defaults: { profiles: [], chats: [] }
})
export const agentStore = new AgentRepository(join(app.getPath('userData'), 'prism-agents.db'), legacyStore)

/**
 * A Prism profile that runs on a Traycer-managed account's own login, in place.
 * Copying a login forks one rotating refresh token between two apps: whichever
 * refreshes second is rejected and its CLI wipes the copy. Sharing the account
 * directory is what Traycer and the terminal already do for the ambient login.
 */
export interface CredentialLink { root: string; providerId: string; profileId: string }
export type StoredProfile = ProviderProfile & { credentialLink?: CredentialLink }

export function profiles(): StoredProfile[] {
  return [
    { id: 'ambient-claude', provider: 'claude', name: 'Conta do terminal', ambient: true },
    { id: 'ambient-codex', provider: 'codex', name: 'Conta do terminal', ambient: true },
    ...agentStore.get('profiles')
  ]
}

export function getProfile(provider: Provider, id: string): StoredProfile {
  const p = profiles().find((p) => p.id === id && p.provider === provider)
  if (!p || p.tombstoned) throw new Error('Conta não encontrada para este agente. Selecione outra conta.')
  return p
}

export function createProfile(provider: Provider, name: string): ProviderProfile {
  if (!['claude', 'codex'].includes(provider) || !name?.trim()) throw new Error('Informe o agente e o nome da conta.')
  const p: ProviderProfile = { id: randomUUID(), provider, name: name.trim().slice(0, 80) }
  mkdirSync(join(app.getPath('userData'), 'provider-profiles', p.id), { recursive: true, mode: 0o700 })
  agentStore.set('profiles', [...agentStore.get('profiles'), p])
  return p
}

const traycerProvider = (provider: Provider): string => provider === 'claude' ? 'claude-code' : 'codex'
export const credentialFile = (provider: Provider): string => provider === 'claude' ? '.credentials.json' : 'auth.json'
const within = (root: string, path: string): boolean => { const r = relative(root, path); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

/**
 * The live account directory Traycer runs a managed profile in, or null when the
 * profile is gone, tombstoned, for another provider or outside Traycer's store.
 * `home` is Traycer's own `dirPath` spelling: Claude Code keys state on it.
 */
export function traycerAccount(root: string, provider: Provider, profileId: string): { home: string; layout?: string } | null {
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) return null
    const data = JSON.parse(readFileSync(join(root, 'host', 'config', 'provider-accounts.json'), 'utf8'))
    const p = (Array.isArray(data.profiles) ? data.profiles : []).find((p: any) => p?.profileId === profileId && p.providerId === traycerProvider(provider))
    if (!p || p.kind !== 'managed' || p.tombstoned || p.enabled === false) return null
    const base = join(root, 'host', 'harness-accounts'), expected = join(base, traycerProvider(provider), profileId)
    if (!existsSync(expected) || !lstatSync(expected).isDirectory() || !within(realpathSync(base), realpathSync(expected))) return null
    if (typeof p.dirPath === 'string' && !samePath(p.dirPath, expected)) return null
    return { home: typeof p.dirPath === 'string' ? p.dirPath : expected, layout: typeof p.layout === 'string' ? p.layout : undefined }
  } catch { return null }
}

/** The linked Traycer account a profile currently runs in, if the link still resolves. */
export function linkedAccount(p: StoredProfile): { home: string; layout?: string } | null {
  const link = p.credentialLink
  if (!link || p.ambient || link.providerId !== traycerProvider(p.provider)) return null
  return traycerAccount(link.root, p.provider, link.profileId)
}

/** 'broken': linked, but Traycer disabled or removed the account (or its store is unreadable). */
export function linkState(p: StoredProfile): 'none' | 'linked' | 'broken' {
  if (!p.credentialLink || p.ambient) return 'none'
  return linkedAccount(p) ? 'linked' : 'broken'
}
/**
 * Profiles as the renderer sees them: the link reduced to its state, without
 * Traycer paths. Every IPC that returns the profile list should use this.
 */
export function publicProfiles(): (ProviderProfile & { traycerLink?: 'linked' | 'broken' })[] {
  return profiles().map(({ credentialLink, ...p }) => {
    const state = credentialLink ? linkState({ ...p, credentialLink }) : 'none'
    return state === 'none' ? p : { ...p, traycerLink: state }
  })
}
export const brokenLinkMessage = 'A conta vinculada ao Traycer está indisponível (desativada ou removida no Traycer). Reative-a no Traycer ou desvincule o perfil.'

export function profileEnvironment(provider: Provider, id?: string): NodeJS.ProcessEnv {
  const p = getProfile(provider, id || `ambient-${provider}`)
  const env = { ...process.env }
  if (p.enabled === false) throw new Error('Esta conta está desativada. Ative-a no gerenciador de contas.')
  if (p.ambient) return env
  // A linked profile never falls back to its own folder: that may hold an old
  // copy of the same login, and refreshing it would invalidate Traycer's.
  if (linkState(p) === 'broken') throw new Error(brokenLinkMessage)
  // Never mutate the app's global environment or swap the terminal's auth file.
  // An inherited API key/token must not override the selected subscription.
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CODEX_SQLITE_HOME']) delete env[key]
  const linked = linkedAccount(p)
  if (linked) {
    // Same variables Traycer sets for this account, so both apps share one login.
    if (provider === 'claude') env.CLAUDE_CONFIG_DIR = linked.home
    else {
      env.CODEX_HOME = linked.home
      if (linked.layout === 'overlay') {
        const shared = join(homedir(), '.codex')
        try { env.CODEX_SQLITE_HOME = realpathSync(shared) } catch { env.CODEX_SQLITE_HOME = shared }
      }
    }
    return env
  }
  const home = join(app.getPath('userData'), 'provider-profiles', p.id)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  if (provider === 'claude') env.CLAUDE_CONFIG_DIR = home
  else env.CODEX_HOME = home
  return env
}

export interface ProviderCommand { bin: string; args: string[] }

const lookup = (provider: Provider): [string, string[]] => process.platform === 'win32'
  ? ['where.exe', [provider]] : ['/bin/sh', ['-c', `command -v ${provider}`]]
function runAsync(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    try { execFile(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, out) => err ? reject(err) : resolve(String(out))) }
    catch (err) { reject(err) }
  })
}

function terminalCommand(provider: Provider): ProviderCommand | null {
  let paths: string[] = []
  try {
    const [bin, args] = lookup(provider)
    paths = execFileSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)
  } catch { /* Probe known installer paths below. */ }
  return terminalFrom(provider, paths)
}
async function terminalCommandAsync(provider: Provider): Promise<ProviderCommand | null> {
  let paths: string[] = []
  try { paths = (await runAsync(...lookup(provider))).trim().split(/\r?\n/) } catch { /* Probe known installer paths below. */ }
  return terminalFrom(provider, paths)
}
function terminalFrom(provider: Provider, paths: string[]): ProviderCommand | null {
  paths = [...paths.map((p) => p.trim()).filter(Boolean), join(homedir(), '.local', 'bin', provider + (process.platform === 'win32' ? '.exe' : ''))]
  for (const path of paths) {
    if (!existsSync(path)) continue
    if (/\.(cmd|bat|ps1)$/i.test(path) || (process.platform === 'win32' && !/\.exe$/i.test(path))) {
      const script = join(dirname(path), 'node_modules', provider === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js')
      if (existsSync(script)) return { bin: process.execPath, args: [script] }
      continue
    }
    return { bin: path, args: [] }
  }
  return null
}

const versionPattern = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
/** Numeric x.y.z order; a prerelease of the same core sorts first. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] => v.split(/[-+]/)[0].split('.').map((n) => Number(n) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return Number(!/-/.test(a)) - Number(!/-/.test(b))
}

/**
 * The CLI Traycer itself runs: its managed pack's `current` version. The model
 * catalog comes from the CLI binary, so this is what makes both apps list the
 * same models. Only regular files inside Traycer's pack store are accepted.
 */
export function traycerManagedCommand(provider: Provider, root = join(homedir(), '.traycer')): { command: ProviderCommand; version: string } | null {
  try {
    const base = join(root, 'host', 'providers', provider, `${process.platform}-${process.arch}`)
    const current = JSON.parse(readFileSync(join(base, 'current.json'), 'utf8'))
    if (current.pack !== provider || typeof current.version !== 'string' || !versionPattern.test(current.version)) return null
    const dir = join(base, current.version), pack = JSON.parse(readFileSync(join(dir, 'pack.json'), 'utf8'))
    const name = pack.executablePath
    if (pack.pack !== provider || pack.version !== current.version || typeof name !== 'string' || basename(name) !== name) return null
    const exe = join(dir, name), stat = lstatSync(exe)
    if (!stat.isFile() || !within(realpathSync(base), realpathSync(exe))) return null
    return { command: { bin: exe, args: [] }, version: current.version }
  } catch { return null }
}

const target = (command: ProviderCommand): string => command.args[0] || command.bin
const versionKey = (command: ProviderCommand): string | null => {
  try { const s = statSync(target(command)); return `${target(command)}\0${s.mtimeMs}\0${s.size}` } catch { return null }
}
const versions = new Map<string, string | null>()
const parseVersion = (text: unknown): string | null => {
  const v = typeof text === 'string' ? /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(text)?.[1] : null
  return v && versionPattern.test(v) ? v : null
}
/**
 * The terminal CLI's version when already known, else null. Never blocks: an
 * npm install's package.json is read in place, a binary's `--version` runs in
 * the background and is cached per path, mtime and size.
 */
function knownVersion(command: ProviderCommand): string | null {
  const key = versionKey(command)
  if (!key) return null
  if (versions.has(key)) return versions.get(key)!
  if (command.args.length) {
    // An npm install: read the package next to the script, never execute it.
    let version: string | null = null
    for (const dir of [dirname(target(command)), dirname(dirname(target(command)))]) {
      try { const pkg = join(dir, 'package.json'); if (existsSync(pkg)) { version = parseVersion(JSON.parse(readFileSync(pkg, 'utf8')).version); break } } catch { /* Unknown. */ }
    }
    versions.set(key, version)
    return version
  }
  void probeVersion(command, key)
  return null
}
const probing = new Set<string>()
async function probeVersion(command: ProviderCommand, key: string): Promise<void> {
  if (probing.has(key)) return
  probing.add(key)
  try { versions.set(key, parseVersion(await runAsync(command.bin, ['--version']))) } catch { versions.set(key, null) } finally { probing.delete(key) }
}

const terminals = new Map<Provider, { at: number; command: ProviderCommand | null }>()
const refreshing = new Set<Provider>()
async function refreshTerminal(provider: Provider): Promise<void> {
  if (refreshing.has(provider)) return
  refreshing.add(provider)
  try {
    const command = await terminalCommandAsync(provider)
    if (command) { const key = versionKey(command); if (key && !versions.has(key) && !command.args.length) await probeVersion(command, key) }
    terminals.set(provider, { at: Date.now(), command })
  } catch { /* Keep the previous answer. */ } finally { refreshing.delete(provider) }
}
/** The terminal's CLI. Lookups run in the background; only a cold or vanished entry probes synchronously. */
function cachedTerminal(provider: Provider): ProviderCommand | null {
  const hit = terminals.get(provider)
  if (hit && (!hit.command || existsSync(target(hit.command)))) {
    if (Date.now() - hit.at > 60000) void refreshTerminal(provider)
    return hit.command
  }
  const command = terminalCommand(provider)
  terminals.set(provider, { at: Date.now(), command })
  if (command) knownVersion(command)
  return command
}
// Warm the lookups at startup, off the main thread's critical path.
for (const provider of ['claude', 'codex'] as const) void refreshTerminal(provider)

/**
 * The CLI to run. A profile linked to a Traycer account always runs Traycer's
 * managed CLI: two versions in one account folder could migrate state the
 * other cannot read. Otherwise the newest available: the terminal's install,
 * or Traycer's when it is at least as new (or the terminal's version is not
 * known yet). Never downgrades a newer terminal CLI.
 *
 * The managed pack is re-read on every call, so a version Traycer swapped out
 * is never returned. Prism does not register a pin in Traycer's pack store
 * (`host/providers/pins`): Traycer may collect the version under a running
 * Prism process, in which case that one spawn fails and the next resolves anew.
 */
export function providerCommand(provider: Provider, profileId?: string): ProviderCommand | null {
  const managed = traycerManagedCommand(provider)
  if (managed && profileId && !profileId.startsWith('ambient-')) {
    const p = profiles().find((p) => p.id === profileId && p.provider === provider)
    if (p?.credentialLink) return managed.command
  }
  const terminal = cachedTerminal(provider)
  if (!managed) return terminal
  const own = terminal ? knownVersion(terminal) : null
  return !terminal || !own || compareVersions(managed.version, own) >= 0 ? managed.command : terminal
}
