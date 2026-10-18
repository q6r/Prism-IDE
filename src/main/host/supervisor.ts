import { app, ipcMain } from 'electron'
import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { HOST_PROTOCOL } from '../../shared/host/version'
import type { HostInstance } from '../../shared/host/generated/HostInstance'

/**
 * Keeps a Prism host running for this machine: reuses a live, compatible
 * host (found through `host-instance.json`) or starts one detached, so that
 * closing the window does not stop it. The renderer never sees the binary or
 * the data directory; the preload asks for a connection (`host:connection`).
 */

export interface HostConnection {
  readonly port: number
  readonly token: string
  readonly version: string
  readonly hostId: string
}

const INSTANCE_FILE = 'host-instance.json'
const START_TIMEOUT_MS = 15000

export function hostDataDir(): string {
  return join(app.getPath('userData'), 'host')
}

/** A parsed `host-instance.json`, or null when missing, partial or corrupt. */
export function parseInstance(raw: string): HostInstance | null {
  try {
    const v = JSON.parse(raw) as Partial<HostInstance>
    const ok = typeof v.pid === 'number' && typeof v.port === 'number' && v.port > 0 && typeof v.token === 'string' && v.token.length >= 32
      && typeof v.version === 'string' && typeof v.hostId === 'string' && typeof v.startedAt === 'number'
      && typeof v.protocol?.major === 'number' && typeof v.protocol?.minor === 'number'
    return ok ? (v as HostInstance) : null
  } catch {
    return null
  }
}

/** Same protocol major: anything else needs an update of one side (T12). */
export function compatible(instance: Pick<HostInstance, 'protocol'>): boolean {
  return instance.protocol.major === HOST_PROTOCOL.major
}

/** Where the host binary can be, most specific first. */
export function hostBinaryCandidates(input: {
  env: Record<string, string | undefined>
  packaged: boolean
  resourcesPath: string
  appPath: string
  platform: string
}): string[] {
  const exe = input.platform === 'win32' ? 'prism-host.exe' : 'prism-host'
  const list = [input.env.PRISM_HOST_BIN]
  if (input.packaged) list.push(join(input.resourcesPath, 'host', exe))
  // Development: `npm run host:build` (release) or `cargo build` (debug).
  list.push(join(input.appPath, 'host', 'target', 'release', exe), join(input.appPath, 'host', 'target', 'debug', exe))
  return list.filter((p): p is string => !!p)
}

let binaryPresent: boolean | undefined
/**
 * Whether this install has a host binary (checked once). With one, the host
 * owns the chats and tasks once it serves `chats@1`, and nothing may write
 * them to `prism-agents.db` anymore (src/main/hostChats.ts).
 */
export function hostBinaryPresent(): boolean {
  binaryPresent ??= hostBinaryCandidates({
    env: process.env, packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), platform: process.platform
  }).some((p) => existsSync(p))
  return binaryPresent
}

function readInstance(dir: string): HostInstance | null {
  try {
    return parseInstance(readFileSync(join(dir, INSTANCE_FILE), 'utf8'))
  } catch {
    return null
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function healthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
    const body = (await res.json()) as { ok?: boolean; protocol?: { major?: number } }
    return res.ok && body.ok === true && body.protocol?.major === HOST_PROTOCOL.major
  } catch {
    return false
  }
}

async function usable(instance: HostInstance | null): Promise<HostConnection | null> {
  if (!instance || !compatible(instance) || !pidAlive(instance.pid) || !(await healthy(instance.port))) return null
  return { port: instance.port, token: instance.token, version: instance.version, hostId: instance.hostId }
}

let ensuring: Promise<HostConnection | null> | null = null
let warnedMissing = false

/** A connection to a running host, starting one if needed; null if none can run. */
export function ensureHost(): Promise<HostConnection | null> {
  ensuring ??= start().finally(() => { ensuring = null })
  return ensuring
}

async function start(): Promise<HostConnection | null> {
  const dir = hostDataDir()
  const running = await usable(readInstance(dir))
  if (running) return running
  const bin = hostBinaryCandidates({
    env: process.env, packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), platform: process.platform
  }).find((p) => existsSync(p))
  if (!bin) {
    if (!warnedMissing) console.warn('[host] binário do prism-host não encontrado; rode `npm run host:build`. O app segue sem o host.')
    warnedMissing = true
    return null
  }
  try {
    // Detached and unreferenced: the host outlives this window. If another
    // Prism window won the race, this child exits (code 3) and we use the
    // winner's instance below. The profiles' logins and the Usage store stay
    // in this app's own data folder (`PRISM_APP_DATA_DIR`): a copied login
    // would fork its rotating refresh token.
    const env = { ...process.env, PRISM_APP_DATA_DIR: app.getPath('userData') }
    const child = spawn(bin, ['--data-dir', dir], { detached: true, stdio: 'ignore', windowsHide: true, env })
    child.on('error', (err) => console.warn('[host] falha ao iniciar o prism-host:', err.message))
    child.unref()
  } catch (err) {
    console.warn('[host] falha ao iniciar o prism-host:', (err as Error).message)
    return null
  }
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const ready = await usable(readInstance(dir))
    if (ready) return ready
  }
  console.warn('[host] o prism-host não ficou pronto a tempo')
  return null
}

export function registerHostHandlers(): void {
  ipcMain.handle('host:connection', async () => {
    const connection = await ensureHost()
    return connection && { ...connection, clientVersion: app.getVersion() }
  })
  ipcMain.handle('host:owns-chats', () => hostBinaryPresent())
  // Warm the host up while the window loads.
  void ensureHost()
}
