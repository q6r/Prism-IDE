#!/usr/bin/env node
'use strict'
/**
 * Records Claude Code CLI protocol contracts for the Rust host (T06).
 *
 * The oracle is the current TypeScript backend: `src/main/ipc/claudeAgent.ts`
 * driving the real Agent SDK, loaded with the same stubs as the Node tests.
 * The SDK's process is spawned through `spawnClaudeCodeProcess`, so every
 * stdin line it writes and every stdout line the CLI answers is recorded,
 * together with the `agent:*` events claudeAgent.ts emits for them. The Rust
 * tests replay the CLI side and require the same stdin lines and events.
 *
 *   node host/tools/record-claude-contracts.cjs --list
 *   node host/tools/record-claude-contracts.cjs args            # no CLI run, free
 *   node host/tools/record-claude-contracts.cjs text tool ...   # real CLI, Haiku
 *
 * Only the terminal account (ambient profile) and Haiku are used. Fixtures go
 * to host/fixtures/claude/<cli version>/<scenario>/, with local paths, emails
 * and the CLI path replaced by placeholders.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const cp = require('node:child_process')
const { Transform, PassThrough, Writable } = require('node:stream')
const load = require('../../tests/helpers/load-typescript.cjs')

const ROOT = path.resolve(__dirname, '../..')
const SCRATCH = path.join(os.tmpdir(), 'prism-claude-contracts')
const SDK_DIR = path.join(ROOT, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
const SDK_VERSION = JSON.parse(fs.readFileSync(path.join(SDK_DIR, 'package.json'), 'utf8')).version
const CWD_PLACEHOLDER = (scenario) => `C:\\work\\${scenario}`
const HOME_PLACEHOLDER = 'C:\\Users\\user'
const TMP_PLACEHOLDER = 'C:\\Temp'

/* ---------------- environment ---------------- */

// The recorder may run inside Claude Code or Traycer; their session variables
// must not reach the recorded CLI (Prism's Electron process has none of them).
const SESSION_VARS = /^(CLAUDE|TRAYCER|ANTHROPIC_|CODEX_)/i
function cleanEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) if (!SESSION_VARS.test(key) && key !== 'NODE_OPTIONS') env[key] = value
  return env
}
const API_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN',
  'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CODEX_SQLITE_HOME']

/** The CLI `providerCommand('claude', 'ambient-claude')` resolves: Traycer's managed one when at least as new as the terminal's. */
function resolveCli() {
  const flag = process.argv.indexOf('--cli')
  if (flag > 0) return process.argv[flag + 1]
  let managed = null
  try {
    const base = path.join(os.homedir(), '.traycer', 'host', 'providers', 'claude', `${process.platform}-${process.arch}`)
    const current = JSON.parse(fs.readFileSync(path.join(base, 'current.json'), 'utf8'))
    const pack = JSON.parse(fs.readFileSync(path.join(base, current.version, 'pack.json'), 'utf8'))
    managed = { exe: path.join(base, current.version, pack.executablePath), version: current.version }
  } catch { /* No managed CLI. */ }
  let terminal = null
  try {
    const found = cp.execFileSync(process.platform === 'win32' ? 'where.exe' : 'sh', process.platform === 'win32' ? ['claude'] : ['-c', 'command -v claude'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map((s) => s.trim()).find((p) => p && /\.exe$|^[^.]*$/i.test(p))
    if (found) terminal = { exe: found, version: cliVersion(found) }
  } catch { /* No terminal CLI. */ }
  if (managed && (!terminal || compare(managed.version, terminal.version) >= 0)) return managed.exe
  if (terminal) return terminal.exe
  throw new Error('Claude Code CLI não encontrada.')
}
function cliVersion(exe) {
  const out = cp.execFileSync(exe, ['--version'], { encoding: 'utf8', env: cleanEnv(), windowsHide: true })
  const match = /(\d+\.\d+\.\d+)/.exec(out)
  if (!match) throw new Error(`Versão da CLI ilegível: ${out}`)
  return match[1]
}
function compare(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return 0
}

/* ---------------- normalization ---------------- */

const projectKey = (p) => p.replace(/[^a-zA-Z0-9]/g, '-')
const USER_NAME = os.userInfo().username
function normalizer(pairsIn) {
  const pairs = []
  // Account identities are fixture data; native session/run/tool ids must stay intact.
  const identityKeys = new Set(['organizationuuid', 'organizationid', 'accountuuid', 'accountid', 'useruuid', 'userid'])
  const identities = new Map()
  const fixtureIdentity = (value) => {
    if ((typeof value !== 'string' || !value.trim()) && typeof value !== 'number') return value
    if (typeof value === 'string' && /^11111111-1111-4111-8111-\d{12}$/.test(value)) return value
    const key = JSON.stringify(value)
    if (!identities.has(key)) {
      const index = identities.size + 1
      identities.set(key, typeof value === 'number' ? index : `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`)
    }
    return identities.get(key)
  }
  for (const [from, to] of pairsIn) {
    if (!from) continue
    const variants = new Map([[from, to], [from.replace(/\\/g, '/'), to.replace(/\\/g, '/')], [projectKey(from), projectKey(to)]])
    for (const [a, b] of [...variants]) {
      if (/^[A-Z]:/.test(a)) variants.set(a[0].toLowerCase() + a.slice(1), b)
      if (/^[a-z]:/.test(a)) variants.set(a[0].toUpperCase() + a.slice(1), b)
    }
    for (const [a, b] of variants) pairs.push([a, b])
  }
  pairs.sort((a, b) => b[0].length - a[0].length)
  const text = (s) => {
    for (const [a, b] of pairs) if (s.includes(a)) s = s.split(a).join(b)
    // Streamed tool input (input_json_delta) can split a path across chunks: scrub the OS user name on its own too.
    if (USER_NAME.length > 2) s = s.split(USER_NAME).join('user')
    return s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/g, 'user@example.com')
  }
  const deep = (v) => {
    if (typeof v === 'string') return text(v)
    if (Array.isArray(v)) return v.map(deep)
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(v)) {
        const identityKey = k.replace(/_/g, '').toLowerCase()
        if (identityKeys.has(identityKey)) { out[k] = fixtureIdentity(deep(val)); continue }
        if (/^(?:email|emailaddress|accountemail|useremail)$/.test(identityKey) && typeof val === 'string' && val.trim()) { out[k] = 'user@example.com'; continue }
        if (k === 'organization' || k === 'organizationName' || k === 'organization_name') { out[k] = typeof val === 'string' ? 'Org' : deep(val); continue }
        out[text(k)] = deep(val)
      }
      return out
    }
    return v
  }
  return deep
}

/* ---------------- recording spawn ---------------- */

class Recording {
  constructor(normalize, cli) {
    this.normalize = normalize
    this.cli = cli
    this.lines = []
    this.processes = []
    this.exits = []
  }
  push(entry) { this.lines.push(entry) }
  /** spawnClaudeCodeProcess: the real CLI, with stdin and stdout taps. */
  spawner({ dry = false } = {}) {
    return ({ command, args, cwd, env }) => {
      const p = this.processes.length
      const added = {}
      for (const [k, v] of Object.entries(env)) if (/^CLAUDE|^ANTHROPIC/.test(k) && v !== undefined) added[k] = v
      const removed = Object.keys(cleanEnv()).filter((k) => !(k in env))
      this.processes.push({ command: command === this.cli ? '<CLI>' : command, args: args.map((a) => a === this.cli ? '<CLI>' : a), env: added, removedEnv: removed })
      if (dry) return dryProcess(this, p)
      const child = cp.spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stderr = ''
      child.stderr.on('data', (d) => { stderr += d.toString() })
      let pending = ''
      const tap = new Transform({ transform: (chunk, _enc, done) => {
        pending += chunk.toString('utf8')
        let nl
        while ((nl = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, nl).replace(/\r$/, '')
          pending = pending.slice(nl + 1)
          if (line.trim()) this.recordOut(p, line)
        }
        done(null, chunk)
      } })
      child.stdout.pipe(tap)
      const write = child.stdin.write.bind(child.stdin)
      child.stdin.write = (chunk, ...rest) => {
        for (const line of String(chunk).split('\n')) if (line.trim()) this.recordIn(p, line)
        return write(chunk, ...rest)
      }
      const end = child.stdin.end.bind(child.stdin)
      child.stdin.end = (...rest) => { if (!this.lines.some((l) => l.p === p && l.d === 'eof')) this.push({ p, d: 'eof' }); return end(...rest) }
      const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
        if (pending.trim()) this.recordOut(p, pending)
        this.push({ p, d: 'exit', code, signal: signal || null })
        this.processes[p].exitCode = code
        this.processes[p].stderr = this.normalize(stderr.slice(-2000))
        resolve()
      }))
      this.exits.push(exited)
      return {
        stdin: child.stdin, stdout: tap,
        get killed() { return child.killed }, get exitCode() { return child.exitCode }, get signalCode() { return child.signalCode },
        kill: (sig) => child.kill(sig), on: (e, f) => child.on(e, f), once: (e, f) => child.once(e, f), off: (e, f) => child.off(e, f)
      }
    }
  }
  recordIn(p, line) {
    try { this.push({ p, d: 'in', m: this.normalize(JSON.parse(line)) }) } catch { this.push({ p, d: 'in', raw: this.normalize(line) }) }
  }
  recordOut(p, line) {
    try { this.push({ p, d: 'out', m: this.normalize(JSON.parse(line)) }) } catch { this.push({ p, d: 'out', raw: this.normalize(line) }) }
  }
}

/** A process that never runs: only the spawn arguments are recorded. */
function dryProcess(recording, p) {
  const stdout = new PassThrough()
  const listeners = { exit: [], error: [] }
  const stdin = new Writable({ write: (_c, _e, done) => done() })
  stdin.on('finish', () => {})
  setTimeout(() => { stdout.end(); for (const f of listeners.exit) f(0, null) }, 20)
  recording.exits.push(new Promise((resolve) => setTimeout(resolve, 40)))
  return { stdin, stdout, killed: false, exitCode: null, signalCode: null, kill: () => true,
    on: (e, f) => listeners[e]?.push(f), once: (e, f) => listeners[e]?.push(f), off: () => {} }
}

/* ---------------- oracle ---------------- */

async function loadOracle(recording, sdk, { profileEnv, cli, dry }) {
  const handlers = {}, invokes = {}, appEvents = {}
  const events = []
  const owner = { id: 1, isDestroyed: () => false, once: () => {}, send: (channel, payload) => events.push({ channel, data: JSON.parse(JSON.stringify(payload ?? null)) }) }
  const spawn = recording.spawner({ dry })
  const wrapped = { __esModule: true, ...sdk,
    query: ({ prompt, options }) => sdk.query({ prompt, options: { ...options, spawnClaudeCodeProcess: spawn } }) }
  const module = load('src/main/ipc/claudeAgent.ts', {
    '../../shared/providerUsage': load('src/shared/providerUsage.ts'),
    electron: { ipcMain: { on: (k, f) => { handlers[k] = f }, handle: (k, f) => { invokes[k] = f } }, app: { on: (n, f) => { appEvents[n] = f } } },
    child_process: cp, fs, 'fs/promises': fs.promises, os, path,
    '../providers': { profileEnvironment: () => profileEnv(), providerCommand: () => ({ bin: cli, args: [] }),
      agentStore: { beginRun: () => {}, appendEvent: () => {} } },
    './ssh': { matchesSshTarget: () => false, getSshClient: () => null },
    '@anthropic-ai/claude-agent-sdk': wrapped
  })
  module.registerClaudeAgentHandlers()
  return { handlers, invokes, appEvents, events, owner }
}

/* ---------------- scenarios ---------------- */

const base = (scenario, extra = {}) => ({ permissionScope: `chat-${scenario}`, chat: { id: `chat-${scenario}` }, cwd: CWD_PLACEHOLDER(scenario),
  model: 'haiku', permissionMode: 'default', profileId: 'ambient-claude', ...extra })
const after = (channel, nth = 0) => ({ channel, nth })

/**
 * Each scenario is data, written to the fixture as script.json so the Rust
 * harness performs the same sends, answers and calls. `$cwd`, `$session`
 * (the last agent:system sessionId) and `$checkpoint[n]` are resolved by both.
 */
const SCENARIOS = {
  text: { live: true, sends: [{ payload: { id: 'turn-1', prompt: 'Responda apenas com a palavra: pronto' } }], end: after('agent:done') },
  tool: { live: true, files: { 'nota.txt': 'conteudo secreto 42' },
    sends: [{ payload: { id: 'turn-1', prompt: 'Use a ferramenta Read para ler o arquivo nota.txt desta pasta e responda só com o conteúdo dele.' } }],
    end: after('agent:done') },
  'permission-allow': { live: true,
    sends: [{ payload: { id: 'turn-1', prompt: 'Use a ferramenta Write para criar o arquivo a.txt nesta pasta com o conteúdo "um". Não faça mais nada.' } },
      { after: after('agent:done', 0), payload: { id: 'turn-2', prompt: 'Agora use a ferramenta Write para criar b.txt com o conteúdo "dois". Não faça mais nada.', resume: '$session' } }],
    actions: [{ on: after('agent:permission', 0), do: { type: 'permission', decision: 'allow_always' } },
      { on: after('agent:permission', 1), do: { type: 'permission', decision: 'allow' } }],
    end: after('agent:done', 1),
    calls: [{ method: 'checkpointIds', args: { sessionId: '$session' } },
      { method: 'rewind', args: { sessionId: '$session', userMessageId: '$checkpoint[1]', cwd: '$cwd', dryRun: true } },
      { method: 'rewind', args: { sessionId: '$session', userMessageId: '$checkpoint[1]', cwd: '$cwd' } },
      { method: 'fork', args: { sessionId: '$session', upToMessageId: '$checkpoint[0]' } }] },
  'permission-deny': { live: true,
    sends: [{ payload: { id: 'turn-1', prompt: 'Use a ferramenta Write para criar o arquivo negado.txt nesta pasta com o conteúdo "x". Se for negado, responda só: negado.' } }],
    actions: [{ on: after('agent:permission', 0), do: { type: 'permission', decision: 'deny' } }],
    end: after('agent:done') },
  question: { live: true,
    sends: [{ payload: { id: 'turn-1', prompt: 'Use a ferramenta AskUserQuestion para me perguntar qual cor eu prefiro, com as opções Azul e Verde. Depois responda só com a cor escolhida.' } }],
    actions: [{ on: after('agent:question', 0), do: { type: 'question', answer: 'first' } }],
    end: after('agent:done') },
  interrupt: { live: true,
    sends: [{ payload: { id: 'turn-1', prompt: 'Escreva os números de 1 a 300 por extenso, um por linha, sem usar ferramentas.' } }],
    actions: [{ on: after('agent:text', 0), do: { type: 'abort', id: 'turn-1' } }],
    end: after('agent:done') },
  'model-switch': { live: true,
    sends: [{ payload: { id: 'turn-1', prompt: 'Responda apenas: um' } },
      { after: after('agent:done', 0), payload: { id: 'turn-2', prompt: 'Responda apenas: dois', model: 'claude-haiku-4-5', resume: '$session' } }],
    end: after('agent:done', 1) },
  'fast-refused': { live: true, sends: [{ payload: { id: 'turn-1', prompt: 'Responda apenas: rapido', serviceTier: 'fast' } }], end: after('agent:done') },
  'login-error': { live: true, loggedOut: true, sends: [{ payload: { id: 'turn-1', prompt: 'Responda apenas: oi' } }], end: after('agent:done'), endOn: ['agent:error'] },
  // Spawn arguments only (no CLI process runs): the option → flag mapping for routes Haiku never exercises.
  args: { live: false, dry: true, sends: [
    { payload: { id: 'a-1', prompt: 'x', model: 'sonnet', effort: 'high' } },
    { payload: { id: 'a-2', prompt: 'x', model: 'opus', effort: 'ultra', thinking: false, permissionMode: 'plan', serviceTier: 'fast', resume: 'resume-id' }, chat: 'b' },
    { payload: { id: 'a-3', prompt: 'x', model: 'claude-haiku-4-5', effort: 'max', permissionMode: 'acceptEdits' }, chat: 'c' },
    { payload: { id: 'a-4', prompt: 'x', model: '', permissionMode: 'bypassPermissions', thinking: true }, chat: 'd' }] },
  // The metadata reads (no prompt, no paid generation): agentModels.ts, agentCommands.ts and providerUsage.ts.
  metadata: { live: true, sends: [], calls: [{ method: 'models' }, { method: 'commands', args: { cwd: '$cwd' } }, { method: 'usage' }] }
}

/** The SDK calls the metadata readers make, with their exact options. */
async function metadataOracle(method, args, sdk, spawn, env, cli) {
  const controller = new AbortController()
  async function* input() { await new Promise((resolve) => controller.signal.addEventListener('abort', () => resolve(), { once: true })) }
  const common = { abortController: controller, pathToClaudeCodeExecutable: cli, env, persistSession: false, spawnClaudeCodeProcess: spawn }
  const options = method === 'models' ? common
    : method === 'commands' ? { ...common, cwd: args.cwd, settingSources: ['user', 'project', 'local'] }
    : { ...common, cwd: os.homedir(), settingSources: ['user'] }
  const q = sdk.query({ prompt: input(), options })
  try {
    if (method === 'models') return await q.supportedModels()
    if (method === 'commands') return await q.supportedCommands()
    const init = await q.initializationResult()
    return { account: init?.account, usage: await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }) }
  } finally { controller.abort(); q.close() }
}

/* ---------------- runner ---------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond, what, ms = 180000) {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error(`Tempo esgotado esperando ${what}`)
    await sleep(25)
  }
}
const count = (events, channel) => events.filter((e) => e.channel === channel).length
const reached = (events, on) => count(events, on.channel) > on.nth

function resolveRefs(value, ctx) {
  if (typeof value === 'string') {
    if (value === '$cwd') return ctx.cwd
    if (value === '$session') return ctx.session()
    const m = /^\$checkpoint\[(\d+)\]$/.exec(value)
    if (m) return ctx.checkpoints[Number(m[1])]
    return value
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, ctx))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, ctx)]))
  return value
}

async function record(name, cli, version, sdk) {
  const sc = SCENARIOS[name]
  const workdir = path.join(SCRATCH, name)
  fs.rmSync(workdir, { recursive: true, force: true })
  fs.mkdirSync(workdir, { recursive: true })
  for (const [file, text] of Object.entries(sc.files || {})) fs.writeFileSync(path.join(workdir, file), text)
  const loggedOutDir = path.join(SCRATCH, `${name}-config`)
  if (sc.loggedOut) { fs.rmSync(loggedOutDir, { recursive: true, force: true }); fs.mkdirSync(loggedOutDir, { recursive: true }) }
  const normalize = normalizer([[workdir, CWD_PLACEHOLDER(name)], [loggedOutDir, 'C:\\Temp\\logged-out-config'], [cli, '<CLI>'],
    [os.tmpdir(), TMP_PLACEHOLDER], [os.homedir(), HOME_PLACEHOLDER]])
  const recording = new Recording(normalize, cli)
  const profileEnv = () => {
    const env = cleanEnv()
    if (!sc.loggedOut) return env
    for (const key of API_KEYS) delete env[key]
    env.CLAUDE_CONFIG_DIR = loggedOutDir
    return env
  }
  const oracle = await loadOracle(recording, sdk, { profileEnv, cli, dry: sc.dry })
  const { events } = oracle
  const ctx = { cwd: workdir, checkpoints: [], session: () => [...events].reverse().find((e) => e.channel === 'agent:system')?.data?.sessionId }
  const real = (payload, chatSuffix) => {
    const p = { ...base(name), ...resolveRefs(payload, ctx) }
    if (chatSuffix) { p.chat = { id: `chat-${name}-${chatSuffix}` }; p.permissionScope = p.chat.id }
    if (p.cwd === CWD_PLACEHOLDER(name)) p.cwd = workdir
    return p
  }
  const done = new Set()
  const actionLoop = setInterval(() => {
    for (const [i, action] of (sc.actions || []).entries()) {
      if (done.has(i) || !reached(events, action.on)) continue
      done.add(i)
      const ev = events.filter((e) => e.channel === action.on.channel)[action.on.nth].data
      const act = action.do
      if (act.type === 'permission') oracle.handlers['agent:permission-response']({ sender: oracle.owner }, { id: ev.id, permId: ev.permId, decision: act.decision })
      else if (act.type === 'question') {
        const answers = {}
        for (const q of ev.questions || []) answers[q.question] = q.options?.[0]?.label ?? ''
        oracle.handlers['agent:question-response']({ sender: oracle.owner }, { id: ev.id, dialogId: ev.dialogId, answers })
      } else if (act.type === 'abort') oracle.handlers['agent:abort']({ sender: oracle.owner }, act.id)
    }
  }, 5)
  const calls = []
  try {
    for (const send of sc.sends) {
      if (send.after) await waitFor(() => reached(events, send.after), `${send.after.channel}#${send.after.nth}`)
      await oracle.handlers['agent:send']({ sender: oracle.owner }, real(send.payload, send.chat))
      if (sc.dry) await sleep(150)
    }
    if (sc.end) await waitFor(() => reached(events, sc.end) || (sc.endOn || []).some((c) => count(events, c) > 0), `${sc.end.channel}#${sc.end.nth}`)
    await sleep(300)
    const chats = new Set(sc.sends.map((s) => real(s.payload, s.chat).chat.id))
    for (const chat of chats) oracle.handlers['agent:end']({ sender: oracle.owner }, `unified:${chat}`)
    await Promise.race([Promise.all(recording.exits), sleep(15000)])
    await sleep(200)
    for (const call of sc.calls || []) {
      const args = resolveRefs(call.args, ctx)
      let result
      if (call.method === 'checkpointIds') { result = await oracle.invokes['agent:checkpoint-ids']({}, args.sessionId); ctx.checkpoints = result }
      else if (call.method === 'rewind') result = await oracle.invokes['agent:rewind']({}, args)
      else if (call.method === 'fork') result = await forkOracle(args, workdir, normalize)
      else result = await metadataOracle(call.method, args || {}, sdk, recording.spawner(), profileEnv(), cli)
      calls.push({ method: call.method, result })
      await Promise.race([Promise.all(recording.exits), sleep(15000)])
    }
  } finally {
    clearInterval(actionLoop)
  }
  const out = path.join(ROOT, 'host', 'fixtures', 'claude', version, name)
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const script = { scenario: name, cwd: CWD_PLACEHOLDER(name), files: sc.files || {}, loggedOut: !!sc.loggedOut,
    sends: sc.sends.map((s) => ({ ...(s.after ? { after: s.after } : {}), payload: { ...base(name), ...s.payload, ...(s.chat ? { chat: { id: `chat-${name}-${s.chat}` }, permissionScope: `chat-${name}-${s.chat}` } : {}) } })),
    actions: sc.actions || [], end: sc.end || null, calls: sc.calls || [] }
  const meta = { cliVersion: version, sdkVersion: SDK_VERSION, recordedAt: new Date().toISOString().slice(0, 10), platform: `${process.platform}-${process.arch}`,
    processes: recording.processes }
  fs.writeFileSync(path.join(out, 'script.json'), JSON.stringify(script, null, 2) + '\n')
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(normalize(meta), null, 2) + '\n')
  if (!sc.dry) fs.writeFileSync(path.join(out, 'cli.jsonl'), recording.lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  if (!sc.dry) fs.writeFileSync(path.join(out, 'expected.jsonl'), [...events.map((e) => normalize(e)), ...calls.map((c) => normalize({ call: c.method, result: c.result }))]
    .map((e) => JSON.stringify(e)).join('\n') + '\n')
  const session = ctx.session()
  if (session && !sc.dry) {
    const transcript = findTranscript(session)
    if (transcript) fs.writeFileSync(path.join(out, 'transcript.jsonl'), fs.readFileSync(transcript, 'utf8').split('\n').filter((l) => l.trim())
      .map((l) => { try { return JSON.stringify(normalize(JSON.parse(l))) } catch { return null } }).filter(Boolean).join('\n') + '\n')
  }
  return { events: events.length, lines: recording.lines.length, processes: recording.processes.length }
}

function findTranscript(sessionId) {
  const projects = path.join(os.homedir(), '.claude', 'projects')
  for (const dir of fs.existsSync(projects) ? fs.readdirSync(projects) : []) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

/**
 * The SDK's forkSession, run against a scratch copy of the transcript (a
 * CLAUDE_CONFIG_DIR of its own), so nothing is written to ~/.claude.
 */
async function forkOracle({ sessionId, upToMessageId }, workdir, normalize) {
  const source = findTranscript(sessionId)
  if (!source) return { ok: false, error: 'transcript not found' }
  const config = path.join(SCRATCH, 'fork-config')
  fs.rmSync(config, { recursive: true, force: true })
  const dir = path.join(config, 'projects', path.basename(path.dirname(source)))
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(source, path.join(dir, `${sessionId}.jsonl`))
  const script = `import(${JSON.stringify('file:///' + path.join(SDK_DIR, 'sdk.mjs').replace(/\\/g, '/'))}).then(async (sdk) => {
    const r = await sdk.forkSession(${JSON.stringify(sessionId)}, { upToMessageId: ${JSON.stringify(upToMessageId)} })
    process.stdout.write(JSON.stringify(r))
  }).catch((e) => { process.stdout.write(JSON.stringify({ error: String(e && e.message || e) })) })`
  const out = cp.execFileSync(process.execPath, ['-e', script], { env: { ...cleanEnv(), CLAUDE_CONFIG_DIR: config }, encoding: 'utf8', cwd: workdir })
  const result = JSON.parse(out)
  if (result.error) return { ok: false, error: result.error }
  const forked = fs.readFileSync(path.join(dir, `${result.sessionId}.jsonl`), 'utf8').split('\n').filter((l) => l.trim()).map((l) => normalize(JSON.parse(l)))
  return { ok: true, sessionId: result.sessionId, entries: forked }
}

async function main() {
  const names = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--cli')
  if (process.argv.includes('--list') || !names.length) {
    console.log('Cenários:', Object.keys(SCENARIOS).join(', '))
    return
  }
  for (const n of names) if (!SCENARIOS[n]) throw new Error(`Cenário desconhecido: ${n}`)
  // claudeAgent.ts's rewind passes no env, so the SDK falls back to process.env: clean it too.
  for (const key of Object.keys(process.env)) if (SESSION_VARS.test(key) || key === 'NODE_OPTIONS') delete process.env[key]
  const cli = resolveCli()
  const version = cliVersion(cli)
  const sdk = await import('file:///' + path.join(SDK_DIR, 'sdk.mjs').replace(/\\/g, '/'))
  console.log(`CLI ${version} (${cli}), SDK ${SDK_VERSION}`)
  for (const name of names) {
    const started = Date.now()
    const r = await record(name, cli, version, sdk)
    console.log(`${name}: ${r.processes} processo(s), ${r.lines} linhas da CLI, ${r.events} eventos (${Date.now() - started} ms)`)
  }
  process.exit(0)
}

main().catch((err) => { console.error(err); process.exit(1) })
