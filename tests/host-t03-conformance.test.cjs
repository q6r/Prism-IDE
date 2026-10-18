// T03 against the real prism-host binary: fs, /files transfer, search, git,
// workspace, sessions and commands, driven through the real TS façades with a
// real HostClient. The host's home (~/.claude) is a temp dir, never the user's.
const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const loadTypescript = require('./helpers/load-typescript.cjs')

const ROOT = path.resolve(__dirname, '..')
const HOST_DIR = path.join(ROOT, 'host')
const EXE = process.platform === 'win32' ? 'prism-host.exe' : 'prism-host'

function findBinary() {
  const found = ['release', 'debug'].map((p) => path.join(HOST_DIR, 'target', p, EXE)).filter((p) => fs.existsSync(p))
  return found.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
}
function hasCargo() {
  return spawnSync('cargo', ['--version'], { shell: process.platform === 'win32' }).status === 0
}
function ensureBinary() {
  const existing = findBinary()
  if (existing) return existing
  if (!hasCargo()) return null
  const build = spawnSync('cargo', ['build', '-p', 'prism-host'], { cwd: HOST_DIR, shell: process.platform === 'win32', encoding: 'utf8', timeout: 600_000 })
  if (build.status !== 0) throw new Error(`cargo build -p prism-host falhou:\n${build.stdout}\n${build.stderr}`)
  return findBinary()
}
const BIN = ensureBinary()
const hasGit = spawnSync('git', ['--version']).status === 0
const skip = BIN ? false : 'sem binário do prism-host e sem cargo para construí-lo'
if (skip) console.warn(`[host-t03-conformance] ${skip}; testes pulados`)

const version = loadTypescript('src/shared/host/version.ts')
const clientMod = loadTypescript('src/shared/host/client.ts', { './version': version })
const callMod = loadTypescript('src/shared/host/api/call.ts')
const transferMod = loadTypescript('src/shared/host/api/transfer.ts', { '../client': clientMod })
const fsMod = loadTypescript('src/shared/host/api/fs.ts', { './call': callMod, './transfer': transferMod })
const searchMod = loadTypescript('src/shared/host/api/search.ts', { './call': callMod })
const gitMod = loadTypescript('src/shared/host/api/git.ts', { './call': callMod })
const workspaceMod = loadTypescript('src/shared/host/api/workspace.ts', { './call': callMod })
const sessionsMod = loadTypescript('src/shared/host/api/sessions.ts', { './call': callMod })
const commandsMod = loadTypescript('src/shared/host/api/commands.ts', { './call': callMod })
const hostTransfer = loadTypescript('src/preload/hostTransfer.ts', {
  http, fs, '../shared/host/api/transfer': transferMod
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(predicate, label, timeout = 15_000) {
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > timeout) assert.fail(`timeout esperando ${label}`)
    await sleep(25)
  }
}

const running = new Set()
const clients = new Set()
const dirs = []
test.after(() => {
  for (const c of clients) c.stop()
  for (const host of running) host.proc.kill()
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) } catch { /* locked */ }
  }
})
function tempDir(label = 'prism-t03-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), label)))
  dirs.push(dir)
  return dir
}
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

/** One host + real client + façades, with HOME on a temp dir. */
async function setup() {
  const dir = tempDir('prism-t03-host-')
  const home = tempDir('prism-t03-home-')
  const proc = spawn(BIN, ['--data-dir', dir, '--idle-timeout', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, USERPROFILE: home, HOME: home }
  })
  let output = ''
  proc.stdout.on('data', (d) => { output += d })
  proc.stderr.on('data', (d) => { output += d })
  const host = { proc }
  running.add(host)
  const instance = await waitFor(async () => {
    try {
      const i = JSON.parse(fs.readFileSync(path.join(dir, 'host-instance.json'), 'utf8'))
      if (i.pid !== proc.pid) return null
      return (await fetch(`http://127.0.0.1:${i.port}/health`)).ok ? i : null
    } catch { return null }
  }, `o host subir\n${output}`)
  const client = new clientMod.HostClient({
    resolve: async () => ({ url: `ws://127.0.0.1:${instance.port}/rpc`, token: instance.token }),
    client: { kind: 'desktop', version: 'test' }
  })
  clients.add(client)
  client.start()
  await waitFor(() => client.status().state === 'connected', 'conectar')
  const transfer = hostTransfer.nodeTransfer(() => client.http())
  const ipcFail = new Proxy({}, { get: (_, key) => () => Promise.reject(new Error(`IPC chamado: ${String(key)}`)) })
  return { dir, home, client, transfer, ipcFail, stop: async () => { client.stop(); proc.kill() } }
}

// ------------------------------------------------------------------ fs

test('fs: round trip through the real host', { skip }, async () => {
  const h = await setup()
  const api = fsMod.createHostFs({ client: h.client, transfer: h.transfer, local: hostTransfer.nodeLocalFiles, ipc: h.ipcFail })
  const root = tempDir()
  write(path.join(root, 'b.txt'), 'bee')
  write(path.join(root, 'A.md'), 'ay')
  fs.mkdirSync(path.join(root, 'zdir'))
  fs.mkdirSync(path.join(root, 'adir'))
  write(path.join(root, 'src', 'main.ts'), 'x')
  write(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x')
  write(path.join(root, '.git', 'HEAD'), 'x')

  const entries = await api.readDir(root)
  const byName = (x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' })
  assert.deepEqual(entries.map((e) => e.name), [...['.git', 'adir', 'node_modules', 'src', 'zdir'].sort(byName), ...['A.md', 'b.txt'].sort(byName)])
  assert.equal(entries.find((e) => e.name === 'adir').isDir, true)

  const listed = (await api.listFiles(root)).map((f) => f.rel.replace(/\\/g, '/')).sort()
  assert.deepEqual(listed, ['A.md', 'b.txt', 'src/main.ts'], 'node_modules and .git are ignored')

  await assert.rejects(api.readFile(path.join(root, 'nope.txt')), (e) => e.message.startsWith('Arquivo não encontrado: ') && e.message.includes('nope.txt'))
  assert.equal(await api.readFile(path.join(root, 'b.txt')), 'bee')

  assert.equal(await api.writeFile(path.join(root, 'w.txt'), 'olá ✓'), true)
  assert.equal(await api.readFile(path.join(root, 'w.txt')), 'olá ✓')
  const created = await api.createFile(path.join(root, 'new.txt'))
  assert.equal(created.isDir, false)
  assert.equal((await api.createDir(path.join(root, 'newdir'))).isDir, true)

  assert.equal(await api.rename(path.join(root, 'new.txt'), path.join(root, 'renamed.txt')), true)
  assert.ok(fs.existsSync(path.join(root, 'renamed.txt')) && !fs.existsSync(path.join(root, 'new.txt')))

  const moved = await api.move(path.join(root, 'renamed.txt'), path.join(root, 'newdir'))
  assert.equal(moved, path.join(root, 'newdir', 'renamed.txt'))
  assert.ok(fs.existsSync(moved))

  const copied = await api.copyPath(path.join(root, 'b.txt'), root)
  assert.equal(copied, path.join(root, 'b copy.txt'))
  assert.equal(fs.readFileSync(copied, 'utf8'), 'bee')
  assert.equal(await api.copyPath(path.join(root, 'b.txt'), root), path.join(root, 'b copy 2.txt'))
  assert.equal(await api.duplicate(path.join(root, 'b.txt')), path.join(root, 'b copy 3.txt'))
  const dupDir = await api.duplicate(path.join(root, 'src'))
  assert.equal(dupDir, path.join(root, 'src copy'))
  assert.equal(fs.readFileSync(path.join(dupDir, 'main.ts'), 'utf8'), 'x')

  assert.equal(await api.delete(path.join(root, 'b copy.txt')), true)
  assert.ok(!fs.existsSync(path.join(root, 'b copy.txt')))
  assert.equal(await api.delete(dupDir), true)
  assert.ok(!fs.existsSync(dupDir))

  await assert.rejects(api.trash(''), /inválido/i)
  await h.stop()
})

test('fs: bytes and temp images over /files', { skip }, async () => {
  const h = await setup()
  const api = fsMod.createHostFs({ client: h.client, transfer: h.transfer, local: hostTransfer.nodeLocalFiles, ipc: h.ipcFail })
  const root = tempDir()
  const bytes = Buffer.from([0, 1, 2, 250, 255, 128])
  fs.writeFileSync(path.join(root, 'bin.dat'), bytes)
  assert.equal(await api.readFileBytes(path.join(root, 'bin.dat')), bytes.toString('base64'))
  await assert.rejects(api.readFileBytes(path.join(root, 'nope.dat')), (e) => e.code === 'not_found')
  await assert.rejects(api.readFileBytes(root), (e) => e.code === 'invalid', 'a folder is a 400')

  // Big text goes over /files instead of JSON-RPC.
  const big = 'ab'.repeat(fsMod.WRITE_OVER_HTTP_CHARS / 2 + 5)
  assert.equal(await api.writeFile(path.join(root, 'big.txt'), big), true)
  assert.equal(fs.readFileSync(path.join(root, 'big.txt'), 'utf8'), big)

  const tmp = await api.saveTempImage(`data:image/jpeg;base64,${bytes.toString('base64')}`)
  try {
    assert.match(path.basename(tmp), /^prism-img-.*\.jpg$/)
    assert.deepEqual(fs.readFileSync(tmp), bytes)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  await assert.rejects(api.saveTempImage('lixo'), /Formato de imagem inválido\./)
  await h.stop()
})

test('fs.importPaths: copies a local folder (recursively) and a file into the host', { skip }, async () => {
  const h = await setup()
  const api = fsMod.createHostFs({ client: h.client, transfer: h.transfer, local: hostTransfer.nodeLocalFiles, ipc: h.ipcFail })
  const local = tempDir('prism-t03-local-')
  write(path.join(local, 'pasta', 'a.txt'), 'A')
  write(path.join(local, 'pasta', 'sub', 'b.bin'), Buffer.from([1, 2, 3]))
  fs.mkdirSync(path.join(local, 'pasta', 'vazia'))
  write(path.join(local, 'solto.txt'), 'S')
  const dest = tempDir()
  write(path.join(dest, 'solto.txt'), 'já existia')

  const out = await api.importPaths([path.join(local, 'pasta'), path.join(local, 'solto.txt'), path.join(local, 'inexistente')], dest)
  assert.deepEqual(out, [path.join(dest, 'pasta'), path.join(dest, 'solto copy.txt')])
  assert.equal(fs.readFileSync(path.join(dest, 'pasta', 'a.txt'), 'utf8'), 'A')
  assert.deepEqual([...fs.readFileSync(path.join(dest, 'pasta', 'sub', 'b.bin'))], [1, 2, 3])
  assert.ok(fs.statSync(path.join(dest, 'pasta', 'vazia')).isDirectory())
  assert.equal(fs.readFileSync(path.join(dest, 'solto.txt'), 'utf8'), 'já existia', 'existing file untouched')
  assert.equal(fs.readFileSync(path.join(dest, 'solto copy.txt'), 'utf8'), 'S')
  await h.stop()
})

// -------------------------------------------------------------- search

test('search: results and done by id, case sensitivity, cancel, findDef', { skip }, async () => {
  const h = await setup()
  const ipcCalls = []
  const ipc = { run: (p) => ipcCalls.push(p), cancel() {}, onResult: () => () => {}, onDone: () => () => {} }
  const search = searchMod.createHostSearch({ client: h.client, ipc })
  const nav = searchMod.createHostNav({ client: h.client, ipc: { findDef: async () => assert.fail('IPC') } })
  const root = tempDir()
  write(path.join(root, 'a.ts'), 'const Needle = 1\nconst needle = 2\nlet other = 3\n')
  write(path.join(root, 'sub', 'b.ts'), 'function useNeedle() {}\n')
  write(path.join(root, 'node_modules', 'x.ts'), 'needle needle\n')

  const results = []; const dones = []
  search.onResult((r) => results.push(r))
  search.onDone((d) => dones.push(d))

  search.run({ id: 11, root, query: 'needle', caseSensitive: false })
  await waitFor(() => dones.some((d) => d.id === 11), 'search.done 11')
  const done = dones.find((d) => d.id === 11)
  assert.equal(done.truncated, false)
  assert.equal(done.files, 2)
  assert.equal(done.matches, 3)
  assert.ok(results.every((r) => r.id === 11))
  const a = results.find((r) => r.name === 'a.ts')
  assert.deepEqual(a.matches.map((m) => [m.line, m.col]), [[1, 7], [2, 7]])
  assert.equal(a.rel.replace(/\\/g, '/'), 'a.ts')
  assert.equal(a.matches[0].preview, 'const Needle = 1')

  search.run({ id: 12, root, query: 'needle', caseSensitive: true })
  await waitFor(() => dones.some((d) => d.id === 12), 'search.done 12')
  assert.deepEqual(dones.find((d) => d.id === 12), { id: 12, files: 1, matches: 1, truncated: false })

  // Cancel: no done afterwards for a cancelled run (or it ends early; never a hang).
  search.run({ id: 13, root, query: 'zzz-no-match', caseSensitive: false })
  search.cancel()
  await sleep(300)
  assert.equal(ipcCalls.length, 0, 'never fell back to IPC')

  const def = await nav.findDef({ root, word: 'Needle', fromPath: path.join(root, 'sub', 'b.ts') })
  assert.ok(Array.isArray(def.matches))
  assert.ok(def.matches.length >= 1)
  for (const m of def.matches) assert.ok(m.path && m.line >= 1 && m.col >= 1 && typeof m.preview === 'string')
  await h.stop()
})

// ----------------------------------------------------------------- git

function git(cwd, ...args) {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(run.status, 0, `git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout
}

test('git: init, status with untracked, stage, commit, diff scopes, branches', { skip: skip || (!hasGit && 'git não instalado') }, async () => {
  const h = await setup()
  const api = gitMod.createHostGit({ client: h.client, ipc: h.ipcFail })
  const root = tempDir('prism-t03-git-')

  assert.deepEqual(await api.status(root), { isRepo: false })
  const init = await api.init(root)
  assert.equal(init.code, 0)
  git(root, 'config', 'user.name', 'Teste')
  git(root, 'config', 'user.email', 'teste@example.com')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')

  write(path.join(root, 'a.txt'), 'um\n')
  let st = await api.status(root)
  assert.equal(st.isRepo, true)
  const file = st.files.find((f) => f.path === 'a.txt')
  assert.equal(file.untracked, true)
  assert.equal(file.staged, false)

  assert.equal((await api.stage(root, 'a.txt')).code, 0)
  st = await api.status(root)
  assert.equal(st.files.find((f) => f.path === 'a.txt').staged, true)
  assert.equal(st.files.find((f) => f.path === 'a.txt').x, 'A')

  const commit = await api.commit(root, 'primeiro')
  assert.equal(commit.code, 0, commit.message)
  assert.match(git(root, 'log', '--format=%s', '-1'), /primeiro/)
  st = await api.status(root)
  assert.deepEqual(st.files ?? [], [])

  // Diff scopes: staged = HEAD→index, working = index→disk, none = HEAD→disk.
  write(path.join(root, 'a.txt'), 'um\ndois\n')
  await api.stage(root, 'a.txt')
  write(path.join(root, 'a.txt'), 'um\ndois\ntres\n')
  const staged = await api.diff(root, 'a.txt', false, undefined, 'staged')
  assert.deepEqual(staged, { original: 'um\n', modified: 'um\ndois\n' })
  const working = await api.diff(root, 'a.txt', false, undefined, 'working')
  assert.deepEqual(working, { original: 'um\ndois\n', modified: 'um\ndois\ntres\n' })
  const whole = await api.diff(root, 'a.txt', false)
  assert.deepEqual(whole, { original: 'um\n', modified: 'um\ndois\ntres\n' })
  write(path.join(root, 'u.txt'), 'novo\n')
  const untracked = await api.diff(root, 'u.txt', true)
  assert.equal(untracked.modified, 'novo\n')
  assert.equal(untracked.original, '')

  assert.equal((await api.unstage(root, 'a.txt')).code, 0)
  assert.equal((await api.stageAll(root)).code, 0)
  assert.equal((await api.unstageAll(root)).code, 0)

  // Stats on request.
  const stats = await api.status(root, undefined, { stats: true })
  assert.ok(stats.files.some((f) => f.workingStats))

  // Branches (git only touches the temp repo).
  const branches = await api.branches(root)
  assert.ok(branches.local.includes(branches.current))
  const created = await api.createBranch(root, 'feature/x')
  assert.equal(created.code, 0, created.message)
  assert.equal((await api.branches(root)).current, 'feature/x')
  const back = await api.checkout(root, branches.current)
  assert.equal(back.code, 0, back.message)
  assert.equal((await api.branches(root)).current, branches.current)

  // Like the IPC side: only repositories, each root once.
  fs.mkdirSync(path.join(root, 'subdir'))
  const all = await api.statusAll([root, path.join(root, 'subdir'), tempDir()])
  assert.equal(all.length, 1)
  assert.equal(all[0].isRepo, true)

  // Discarding a tracked change (restores the committed content; nothing is trashed).
  write(path.join(root, 'a.txt'), 'rabisco\n')
  const discard = await api.discard(root, 'a.txt', false)
  assert.equal(discard.code, 0)
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8').replace(/\r\n/g, '\n'), 'um\n')
  await h.stop()
})

// ------------------------------------------------- workspace / sessions

test('workspace: write and read through a fake picker', { skip }, async () => {
  const h = await setup()
  const a = tempDir(); const b = tempDir()
  const file = path.join(tempDir(), 'x.prism-workspace')
  const picker = { savePath: async () => file, openPath: async () => file }
  const api = workspaceMod.createHostWorkspace({ client: h.client, picker, ipc: h.ipcFail })
  assert.equal(await api.save([a, b]), file)
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk.folders.map((f) => f.path), [a, b])
  assert.deepEqual(await api.open(), { file, folders: [a, b] })
  assert.deepEqual(await api.read(file), { file, folders: [a, b] })
  assert.equal(await api.read(path.join(a, 'missing.prism-workspace')), null)
  const nullPicker = workspaceMod.createHostWorkspace({ client: h.client, picker: { savePath: async () => null, openPath: async () => null }, ipc: h.ipcFail })
  assert.equal(await nullPicker.open(), null)
  await h.stop()
})

test('sessions and commands read the host home (.claude)', { skip }, async () => {
  const h = await setup()
  const project = tempDir('prism-t03-proj-')
  const enc = 'proj-enc'
  const jsonl = (...lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  const s1 = path.join(h.home, '.claude', 'projects', enc, 'sess-1.jsonl')
  const s2 = path.join(h.home, '.claude', 'projects', enc, 'sess-2.jsonl')
  write(s1, jsonl(
    { type: 'user', cwd: project, gitBranch: 'main', timestamp: '2026-01-02T03:04:05.000Z', message: { role: 'user', content: 'Olá   mundo\nsegunda linha' } },
    { type: 'assistant', cwd: project, message: { role: 'assistant', content: [{ type: 'text', text: 'Oi!' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'x' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'conteúdo' }] } },
    { type: 'ai-title', aiTitle: 'Título gerado', sessionId: 'sess-1' }
  ))
  write(s2, jsonl({ type: 'user', cwd: path.join(project, 'outro'), message: { role: 'user', content: 'segunda' } }))
  write(path.join(h.home, '.claude', 'projects', enc, 'vazio.jsonl'), '')

  const sessions = sessionsMod.createHostSessions({ client: h.client, ipc: h.ipcFail })
  const all = await sessions.list()
  assert.equal(all.length, 2, 'empty files are not sessions')
  const meta = all.find((m) => m.id === 'sess-1')
  assert.equal(meta.title, 'Título gerado')
  assert.equal(meta.preview, 'Olá mundo segunda linha')
  assert.equal(meta.cwd, project)
  assert.equal(meta.gitBranch, 'main')
  assert.equal(meta.file, s1)
  assert.equal(meta.messageCount, 3)
  assert.equal(meta.firstTs, Date.parse('2026-01-02T03:04:05.000Z'))
  assert.ok(all[0].mtime >= all[1].mtime, 'newest first')

  const filtered = await sessions.list(project.toUpperCase() === project ? project : project + path.sep)
  assert.deepEqual(filtered.map((m) => m.id), ['sess-1'], 'filter ignores trailing slash')

  const turns = await sessions.read(s1)
  assert.equal(turns[0].role, 'user')
  assert.ok(turns.length >= 2)
  assert.ok(JSON.stringify(turns).includes('Oi!'))
  assert.ok(JSON.stringify(turns).includes('conteúdo'))

  assert.equal(await sessions.delete(s2), true)
  assert.ok(!fs.existsSync(s2))
  assert.equal(await sessions.delete(s2), false, 'already gone')
  assert.deepEqual((await sessions.list()).map((m) => m.id), ['sess-1'])

  // commands
  write(path.join(h.home, '.claude', 'commands', 'review.md'), '---\ndescription: Revisa o código\n---\ncorpo')
  write(path.join(h.home, '.claude', 'commands', 'Zeta.md'), 'sem frontmatter')
  write(path.join(h.home, '.claude', 'commands', 'ignorado.txt'), 'x')
  write(path.join(h.home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: "Publica"\n---\n')
  write(path.join(h.home, '.claude', 'skills', 'semskill', 'README.md'), 'x')
  write(path.join(project, '.claude', 'commands', 'local.md'), '---\ndescription: do projeto\n---\n')
  const commands = commandsMod.createHostCommands({ client: h.client, ipc: h.ipcFail })
  const list = await commands.list(project)
  const names = list.map((c) => c.name)
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'sorted by localeCompare')
  assert.deepEqual(new Set(names), new Set(['/review', '/Zeta', '/deploy', '/local']))
  assert.deepEqual(list.find((c) => c.name === '/review'), { name: '/review', description: 'Revisa o código', source: 'user' })
  assert.deepEqual(list.find((c) => c.name === '/deploy'), { name: '/deploy', description: 'Publica', source: 'skill' })
  assert.deepEqual(list.find((c) => c.name === '/local'), { name: '/local', description: 'do projeto', source: 'project' })
  assert.ok(!(await commands.list()).some((c) => c.name === '/local'), 'project commands need projectDir')
  await h.stop()
})
