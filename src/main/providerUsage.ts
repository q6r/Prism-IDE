import type { Provider, ProfileDetails } from '../shared/agents'
import { claudeDetails, codexDetails, codexResetOutcome, type CodexResetOutcome } from '../shared/providerUsage'
import { profileEnvironment, providerCommand } from './providers'
import { CodexServer } from './codexServer'
import { homedir } from 'os'

const cache = new Map<string, { expires: number; value?: ProfileDetails; pending?: Promise<ProfileDetails> }>()
export function invalidateUsage(id: string): void { for (const key of cache.keys()) if (key.endsWith(`:${id}`)) cache.delete(key) }
export function profileUsage(provider: Provider, id: string, refresh = false): Promise<ProfileDetails> {
  // Validate routing and enabled state even when a cached snapshot exists.
  profileEnvironment(provider, id)
  const key = `${provider}:${id}`, hit = cache.get(key)
  if (hit?.pending) return hit.pending
  if (!refresh && hit?.value && hit.expires > Date.now()) return Promise.resolve(hit.value)
  const entry = { expires: 0, value: hit?.value, pending: undefined as Promise<ProfileDetails> | undefined }
  cache.set(key, entry)
  entry.pending = readUsage(provider, id).catch((): ProfileDetails => ({ ...(hit?.value || { limits: [] }), stale: !!hit?.value,
    error: 'Não foi possível consultar o uso. Verifique o login, a conexão e a versão da CLI e atualize novamente.' }))
    .then(value => { entry.value = value; entry.expires = Date.now() + (value.error ? 30000 : 60000); entry.pending = undefined; return value })
  return entry.pending
}
async function readUsage(provider: Provider, id: string): Promise<ProfileDetails> {
  if (provider === 'codex') {
    const server = new CodexServer(id)
    try { await server.ready; return codexDetails(await server.request('account/read', { refreshToken: false }), await server.request('account/rateLimits/read', {})) }
    finally { server.close() }
  }
  let read = await claudeUsage(id)
  // Traycer's second attempt: a cold account directory can answer before its
  // login has loaded, which reads exactly like an account without a plan.
  if (!read.usage?.rate_limits_available) read = await claudeUsage(id)
  const account = read.account && typeof read.account === 'object' ? read.account : {}
  const str = (v: unknown): string | undefined => typeof v === 'string' && v ? v : undefined
  return claudeDetails(read.usage, { email: str(account.email), subscriptionType: str(account.subscriptionType), rateLimitTier: await claudeRateLimitTier(id) })
}

/**
 * Which Max plan the login is ("default_claude_max_20x"): only the OAuth
 * login records it. Reads that one field; the tokens beside it are never
 * returned, logged or kept. Missing file or field (a keychain login) → undefined.
 */
export async function claudeRateLimitTier(id: string): Promise<string | undefined> {
  try {
    const [{ readFile }, { join }] = await Promise.all([import('fs/promises'), import('path')])
    const env = profileEnvironment('claude', id)
    const login = JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json'), 'utf8'))
    const tier = login?.claudeAiOauth?.rateLimitTier
    return typeof tier === 'string' && /^[a-z0-9_]{1,64}$/i.test(tier) ? tier : undefined
  } catch { return undefined }
}

const resetting = new Set<string>()
/**
 * Spends one Codex manual reset (`account/rateLimitResetCredit/consume`, as
 * Traycer's host does). The caller's idempotency key makes a retried click
 * safe; one reset at a time per account, and never for a disabled profile.
 * The usage snapshot is dropped afterwards so the next read is post-reset.
 */
export async function consumeCodexResetCredit(id: unknown, idempotencyKey: unknown, creditId: unknown): Promise<CodexResetOutcome> {
  if (typeof id !== 'string' || !id) throw new Error('Perfil inválido.')
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(idempotencyKey)) throw new Error('Chave de idempotência inválida.')
  if (creditId != null && (typeof creditId !== 'string' || !creditId || creditId.length > 256)) throw new Error('Redefinição manual inválida.')
  // Unknown, removed, non-Codex or disabled profiles stop here.
  const env = profileEnvironment('codex', id)
  // Profiles linked to the same Traycer account share its CODEX_HOME: one reset at a time per account.
  const home = env.CODEX_HOME ? env.CODEX_HOME.replace(/[\\/]+$/, '') : 'ambient'
  const account = process.platform === 'win32' ? home.toLowerCase() : home
  if (resetting.has(account)) throw new Error('Já há uma redefinição manual em andamento para esta conta.')
  resetting.add(account)
  let server: CodexServer | undefined
  try {
    server = new CodexServer(id)
    await server.ready
    const reply = await server.request('account/rateLimitResetCredit/consume', creditId ? { idempotencyKey, creditId } : { idempotencyKey })
    return codexResetOutcome(reply)
  } catch (err) {
    if (/^Tempo esgotado/.test((err as Error).message)) throw new Error('Tempo esgotado ao usar a redefinição manual do Codex.')
    throw err
  } finally {
    server?.close()
    resetting.delete(account)
    invalidateUsage(id)
  }
}

async function claudeUsage(id: string): Promise<{ usage: any; account?: any }> {
  const command = providerCommand('claude', id)
  if (!command) throw new Error('Claude indisponível')
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  const controller = new AbortController()
  async function* input(): AsyncGenerator<any> { await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })) }
  // Same metadata control request as Traycer. No user prompt, no transcript scan,
  // no credential exposure and no paid model generation.
  const q = sdk.query({ prompt: input(), options: { cwd: homedir(), settingSources: ['user'], abortController: controller,
    pathToClaudeCodeExecutable: command.args[0] || command.bin, env: profileEnvironment('claude', id), persistSession: false } })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Like Traycer, ask only once the CLI has initialized (and loaded its login).
    // The init reply's account ({email, subscriptionType}) is Traycer's identity source.
    return await Promise.race([q.initializationResult().then(async (init) => ({ account: init?.account,
      usage: await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Tempo esgotado')) }, 25000) })])
  } finally { clearTimeout(timer); controller.abort(); q.close() }
}
