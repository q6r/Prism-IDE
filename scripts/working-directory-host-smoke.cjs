// Validate the packaged host over its real socket and database, without model turns.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const root = path.resolve(__dirname, '..')
const binary = path.resolve(process.argv[2] || path.join(root, 'dist-app/win-unpacked/resources/host/prism-host.exe'))
const expected = require('../package.json').version
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true })
assert.equal(version.status, 0, 'packaged host runs')
assert.equal(version.stdout.trim(), expected, 'packaged host matches the app version')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-directory-host-'))
const hostDir = path.join(temporary, 'host')
const home = path.join(temporary, 'home')
const appData = path.join(temporary, 'app-data')
const original = path.join(temporary, 'original')
const destination = path.join(temporary, 'novo projeto')
for (const dir of [home, appData, original, destination]) fs.mkdirSync(dir, { recursive: true })
const proc = spawn(binary, ['--data-dir', hostDir, '--idle-timeout', '0'], {
  stdio: 'ignore', windowsHide: true,
  env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: appData,
    XDG_DATA_HOME: path.join(home, '.local/share'), PRISM_APP_DATA_DIR: appData }
})
let ended = false
const exited = new Promise(resolve => { proc.once('exit', () => { ended = true; resolve() }); proc.once('error', () => { ended = true; resolve() }) })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let socket

async function run() {
  let instance
  for (let attempt = 0; attempt < 150 && !instance; attempt++) {
    if (ended) throw new Error('The packaged host exited before serving.')
    try { instance = JSON.parse(fs.readFileSync(path.join(hostDir, 'host-instance.json'), 'utf8')) } catch { await delay(50) }
  }
  assert.equal(instance?.pid, proc.pid, 'instance belongs to the isolated process')
  socket = new WebSocket(`ws://127.0.0.1:${instance.port}/rpc`)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const pending = new Map()
  let nextId = 0
  socket.onmessage = event => {
    const reply = JSON.parse(event.data)
    const done = pending.get(reply.id)
    if (done) { pending.delete(reply.id); done(reply) }
  }
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}`)) }, 10000)
    pending.set(id, reply => {
      clearTimeout(timeout)
      if (reply.error) reject(Object.assign(new Error(reply.error.message), { code: reply.error.data?.code ?? reply.error.code }))
      else resolve(reply.result)
    })
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  const hello = await call('host.hello', { protocol: { major: 1, minor: 1 }, client: { kind: 'desktop', version: expected }, token: instance.token })
  assert.ok(hello.capabilities.includes('chats.working-directory@1'))
  const turns = [{ id: 'u', role: 'user', text: 'Contexto preservado.' },
    { id: 'a', role: 'assistant', provider: 'claude', text: 'Ação já concluída.', segments: [{ kind: 'tool', name: 'Read', toolId: 'read', input: { file_path: 'antes.txt' }, result: 'Conteúdo preservado.', status: 'done' }] }]
  for (const provider of ['claude', 'codex']) {
    const id = `qa-directory-${provider}`
    const selection = { provider, profileId: `ambient-${provider}`, model: '', permissionMode: 'default' }
    await call('chats.create', { chat: { id, title: id, cwd: original, selection, turns, updatedAt: 1,
      resume: { route: `${provider}:ambient-${provider}`, sessionId: 'old-session' } } })
    await call('chats.changeWorkingDirectory', { chatId: id, cwd: destination })
    let chat = (await call('chats.list')).chats.find(chat => chat.id === id)
    assert.equal(chat.cwd, destination)
    assert.equal(chat.cwdPinned, true)
    assert.equal(chat.resume, undefined)
    assert.deepEqual(chat.turns, turns)
    assert.deepEqual(chat.selection, selection)
    await assert.rejects(call('chats.changeWorkingDirectory', { chatId: id, cwd: path.join(temporary, 'missing') }), { code: 'invalid' })
    chat = (await call('chats.list')).chats.find(chat => chat.id === id)
    assert.equal(chat.cwd, destination, 'invalid folder leaves the saved project unchanged')
    assert.deepEqual(chat.turns, turns)
  }
  await call('host.shutdown')
  await exited
  console.log(JSON.stringify({ packagedHostVersion: expected, providers: ['claude', 'codex'], folderSwitch: true, historyPreserved: true, modelTurnsStarted: 0 }))
}

run().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
  socket?.close()
  if (!ended) { proc.kill(); await exited }
  const resolved = path.resolve(temporary)
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('prism-directory-host-'))
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
