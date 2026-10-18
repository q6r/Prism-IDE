// T08 live QA, no paid prompt: the real prism-host on temporary folders reads
// the terminal accounts (Claude Code and Codex) through the `providers` and
// `usage` domains (versions, status, limits, model catalog, `/` commands, the
// Usage records) and creates, changes and removes a throwaway profile. The
// host's data and the app data (PRISM_APP_DATA_DIR) are temporary; the CLIs
// read the real ~/.claude and ~/.codex logins, as the terminal account does,
// and never change them. Emails are never printed; no Codex reset is spent.
//
//   node scripts/host-t08-qa.cjs [path-to-prism-host]
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const EXE = process.platform === 'win32' ? 'prism-host.exe' : 'prism-host'
const BIN = process.argv[2] || path.join(ROOT, 'host', 'target', 'debug', EXE)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failures = 0

function check(label, ok, detail = '') {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
}

async function waitInstance(dir, proc, log) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const instance = JSON.parse(fs.readFileSync(path.join(dir, 'host-instance.json'), 'utf8'))
      if (instance.pid === proc.pid) {
        const res = await fetch(`http://127.0.0.1:${instance.port}/health`)
        if (res.ok) return instance
      }
    } catch { /* not yet */ }
    await sleep(100)
  }
  throw new Error(`o host não subiu:\n${log()}`)
}

function connect(instance) {
  const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/rpc`)
  const pending = new Map()
  const notes = []
  let nextId = 1
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    } else {
      notes.push(message)
    }
  })
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error('falha ao abrir o WebSocket')), { once: true })
  })
  /** `{ result, error, ms }`: never throws for a host error. */
  const call = async (method, params, timeout = 60_000) => {
    await opened
    const id = nextId++
    const started = Date.now()
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sem resposta de ${method}`)), timeout)
      pending.set(id, (r) => { clearTimeout(timer); resolve(r) })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }))
    })
    return { result: reply.result, error: reply.error && { code: reply.error.data?.code, message: reply.error.message }, ms: Date.now() - started }
  }
  return { ws, notes, call, close: () => ws.close() }
}

const errorText = (r) => (r.error ? `${r.error.code}: ${r.error.message}` : '')

async function readAccount(client, provider) {
  const id = `ambient-${provider}`
  const available = await client.call('providers.available', { provider })
  const a = available.result
  check(`${provider}: available`, !!a?.available, a ? `versão "${a.version}"${a.verified === undefined ? '' : ` verified=${a.verified}`}${a.warning ? ` aviso="${a.warning}"` : ''}` : errorText(available))

  const status = await client.call('providers.status', { provider, id })
  const s = status.result
  check(`${provider}: status da conta do terminal`, !!s?.installed && !!s?.loggedIn,
    s ? `installed=${s.installed} loggedIn=${s.loggedIn} tier=${s.tier ?? '-'} email=${s.email ? 'presente' : 'ausente'} (${status.ms} ms)` : errorText(status))

  const details = await client.call('providers.details', { provider, profileId: id })
  const d = details.result
  check(`${provider}: limites`, !!d && !d.unavailable && Array.isArray(d.limits),
    d ? `plano="${d.plan ?? '-'}" janelas=${d.limits.map((l) => `${l.label ?? l.id}:${Math.round(l.usedPercent)}%`).join(', ') || '-'}${d.extras?.length ? ` extras=${d.extras.length}` : ''}${d.resetCredits ? ` resets=${d.resetCredits.availableCount}` : ''}${d.stale ? ' (stale)' : ''}${d.unavailable ? ` indisponível="${d.unavailable}"` : ''} (${details.ms} ms)` : errorText(details))
  const cached = await client.call('providers.details', { provider, profileId: id })
  check(`${provider}: limites vêm do cache na segunda leitura`, !cached.error && cached.ms < 200, `${cached.ms} ms`)

  const models = await client.call('providers.models', { provider, profileId: id })
  const m = models.result
  const fast = m?.filter((x) => x.fast).map((x) => `${x.id}→${x.fast.id}`) ?? []
  check(`${provider}: catálogo de modelos`, Array.isArray(m) && m.length > 0,
    m ? `${m.length} modelos, padrão=${m.find((x) => x.default)?.id ?? '-'}, fast=[${fast.join(', ')}] (${models.ms} ms)` : errorText(models))

  const commands = await client.call('providers.commands', { provider, profileId: id, cwd: ROOT })
  const c = commands.result
  check(`${provider}: comandos /`, Array.isArray(c),
    c ? `${c.length} comandos (${c.filter((x) => x.builtin).length} nativos, ${c.filter((x) => x.kind === 'skill').length} skills) (${commands.ms} ms)` : errorText(commands))
}

async function profileLifecycle(client, appData) {
  const before = client.notes.length
  const created = await client.call('providers.create', { provider: 'claude', name: 'QA T08' })
  const profile = created.result
  check('create', !!profile?.id, profile ? `id=${profile.id}` : errorText(created))
  if (!profile?.id) return
  const folder = path.join(appData, 'provider-profiles', profile.id)
  check('a pasta própria nasce na pasta de dados do app', fs.existsSync(folder), folder)
  await sleep(100)
  check('providers.changed chega ao cliente', client.notes.slice(before).some((n) => n.method === 'providers.changed'))

  const status = await client.call('providers.status', { provider: 'claude', id: profile.id })
  check('status de uma conta sem login', !!status.result && status.result.loggedIn === false, status.result ? `installed=${status.result.installed} loggedIn=${status.result.loggedIn}` : errorText(status))

  const badColor = await client.call('providers.update', { id: profile.id, color: 'vermelho' })
  check('update recusa cor inválida', badColor.error?.code === 'invalid', errorText(badColor))
  const disabled = await client.call('providers.update', { id: profile.id, enabled: false })
  const row = disabled.result?.profiles?.find((p) => p.id === profile.id)
  check('update desativa', row?.enabled === false, errorText(disabled))
  const detailsOff = await client.call('providers.details', { provider: 'claude', profileId: profile.id })
  check('limites de uma conta desativada recusam', !!detailsOff.error, errorText(detailsOff))
  await client.call('providers.update', { id: profile.id, enabled: true, color: '#3366ff' })
  const renamed = await client.call('providers.rename', { id: profile.id, name: 'QA T08 renomeada' })
  check('rename', renamed.result?.profiles?.some((p) => p.id === profile.id && p.name === 'QA T08 renomeada' && p.color === '#3366ff'), errorText(renamed))

  const ambientLogin = await client.call('providers.login', { provider: 'claude', id: 'ambient-claude' })
  check('login da conta do terminal recusa', ambientLogin.error?.code === 'invalid', errorText(ambientLogin))

  const stored = await client.call('providers.stored', {})
  check('stored (dono)', stored.result?.profiles?.some((p) => p.id === profile.id), errorText(stored))

  const removed = await client.call('providers.remove', { id: profile.id })
  check('remove', removed.result?.profiles?.some((p) => p.id === profile.id && p.tombstoned), errorText(removed))
  check('a pasta própria foi apagada', !fs.existsSync(folder))
  const again = await client.call('providers.remove', { id: profile.id })
  check('remover de novo responde not_found', again.error?.code === 'not_found', errorText(again))
}

async function main() {
  if (!fs.existsSync(BIN)) throw new Error(`binário não encontrado: ${BIN}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-t08-qa-'))
  const dataDir = path.join(tmp, 'host')
  const appData = path.join(tmp, 'app')
  fs.mkdirSync(appData, { recursive: true })
  const proc = spawn(BIN, ['--data-dir', dataDir, '--idle-timeout', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, PRISM_APP_DATA_DIR: appData }
  })
  let log = ''
  proc.stdout.on('data', (d) => { log += d })
  proc.stderr.on('data', (d) => { log += d })
  let client
  try {
    const instance = await waitInstance(dataDir, proc, () => log)
    client = connect(instance)
    const hello = await client.call('host.hello', { protocol: { major: 1, minor: 0 }, client: { kind: 'desktop', version: 'qa-t08' }, token: instance.token })
    const caps = hello.result?.capabilities ?? []
    check('hello anuncia providers@1 e usage@1', caps.includes('providers@1') && caps.includes('usage@1'), caps.join(' '))

    const list = await client.call('providers.list', {})
    const ids = list.result?.profiles?.map((p) => p.id) ?? []
    check('list traz as contas do terminal primeiro', ids[0] === 'ambient-claude' && ids[1] === 'ambient-codex', ids.join(', ') || errorText(list))

    for (const provider of ['claude', 'codex']) await readAccount(client, provider)

    const usage = await client.call('usage.records', {})
    check('usage.records', Array.isArray(usage.result?.observations), usage.result ? `${usage.result.observations.length} turnos, importação=${usage.result.importState?.status}` : errorText(usage))

    await profileLifecycle(client, appData)
  } finally {
    client?.close()
    proc.kill()
    await new Promise((resolve) => (proc.exitCode !== null ? resolve() : proc.once('exit', resolve)))
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* still locked */ }
  }
  console.log(failures ? `\n${failures} falha(s)` : '\ntudo certo')
  process.exitCode = failures ? 1 : 0
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
