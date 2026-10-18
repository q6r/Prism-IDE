const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

// ---------------------------------------------------------------------------
// workspace-path.ts — workspaceFilePath(file, folders, remote = false)
// ---------------------------------------------------------------------------

function loadWorkspacePath() {
  return load('src/renderer/src/components/git/workspace-path.ts')
}

test('workspaceFilePath: preserves the matched root folder\'s own spelling and separators', () => {
  const m = loadWorkspacePath()
  const result = m.workspaceFilePath('C:/Users/Dev/Project/src/app.ts', ['C:\\Users\\Dev\\Project'])
  assert.equal(result, 'C:\\Users\\Dev\\Project\\src\\app.ts')
})

test('workspaceFilePath: matches the deepest (most specific) root when multiple roots are nested', () => {
  const m = loadWorkspacePath()
  const result = m.workspaceFilePath('/root/sub/file.ts', ['/root', '/root/sub'])
  assert.equal(result, '/root/sub/file.ts')
})

test('workspaceFilePath: a sibling path that merely shares a prefix is not matched as a root (boundary check)', () => {
  const m = loadWorkspacePath()
  const result = m.workspaceFilePath('/root-other/file.ts', ['/root'])
  assert.equal(result, '/root-other/file.ts')
})

test('workspaceFilePath: falls back to the raw file path when no folder matches', () => {
  const m = loadWorkspacePath()
  const result = m.workspaceFilePath('unrelated/file.ts', ['/root'])
  assert.equal(result, 'unrelated/file.ts')
})

test('workspaceFilePath: local comparison is case-insensitive on the root (differing case still matches, root spelling wins)', () => {
  const m = loadWorkspacePath()
  const result = m.workspaceFilePath('/root/App.ts', ['/Root'], false)
  assert.equal(result, '/Root/App.ts')
})

test('workspaceFilePath: SSH (remote) comparison is case-sensitive on the root', () => {
  const m = loadWorkspacePath()
  const matched = m.workspaceFilePath('/root/App.ts', ['/root'], true)
  assert.equal(matched, '/root/App.ts')
  const unmatched = m.workspaceFilePath('/ROOT/App.ts', ['/root'], true)
  assert.equal(unmatched, '/ROOT/App.ts')
})

test('workspaceFilePath: exact match of file to root (no suffix) resolves to the root spelling alone', () => {
  const m = loadWorkspacePath()
  const result = m.workspaceFilePath('/root', ['/root'])
  assert.equal(result, '/root')
})

// ---------------------------------------------------------------------------
// diff-find-model.ts — groupDiffSearchMatches(rows, query)
// ---------------------------------------------------------------------------

function loadDiffFind() {
  return load('src/renderer/src/components/git/diff-find-model.ts')
}

test('groupDiffSearchMatches: duplicated split context rows (same index/type) merge into a single group with two positions', () => {
  const m = loadDiffFind()
  const rows = [
    { index: '5', type: 'context', text: 'shared line' },
    { index: '5', type: 'context', text: 'shared line' }
  ]
  const groups = m.groupDiffSearchMatches(rows, 'shared')
  assert.deepEqual(groups, [[0, 1]])
})

test('groupDiffSearchMatches: addition and deletion rows sharing the same index stay in distinct groups', () => {
  const m = loadDiffFind()
  const rows = [
    { index: '5', type: 'addition', text: 'needle here' },
    { index: '5', type: 'deletion', text: 'needle here' }
  ]
  const groups = m.groupDiffSearchMatches(rows, 'needle')
  assert.deepEqual(groups, [[0], [1]])
})

test('groupDiffSearchMatches: matches repeated on different lines produce separate groups', () => {
  const m = loadDiffFind()
  const rows = [
    { index: '1', type: 'context', text: 'needle one' },
    { index: '2', type: 'context', text: 'needle two' }
  ]
  const groups = m.groupDiffSearchMatches(rows, 'needle')
  assert.deepEqual(groups, [[0], [1]])
})

test('groupDiffSearchMatches: an empty query returns no groups', () => {
  const m = loadDiffFind()
  const rows = [{ index: '1', type: 'context', text: 'anything' }]
  assert.deepEqual(m.groupDiffSearchMatches(rows, ''), [])
})

test('groupDiffSearchMatches: matching is case-insensitive', () => {
  const m = loadDiffFind()
  const rows = [{ index: '1', type: 'context', text: 'Needle Case' }]
  assert.deepEqual(m.groupDiffSearchMatches(rows, 'needle'), [[0]])
})

test('groupDiffSearchMatches: a row with null index groups alone, keyed by its own position', () => {
  const m = loadDiffFind()
  const rows = [
    { index: null, type: null, text: 'needle plain' },
    { index: null, type: null, text: 'needle plain' }
  ]
  const groups = m.groupDiffSearchMatches(rows, 'needle')
  assert.deepEqual(groups, [[0], [1]])
})

// ---------------------------------------------------------------------------
// src/main/ipc/git.ts — parseGitStatus / parseNumstat (pure parsing)
// ---------------------------------------------------------------------------

function loadGitPure() {
  return load('src/main/ipc/git.ts', {
    electron: { ipcMain: { handle() {} }, shell: {} },
    child_process: { spawn: () => { throw new Error('spawn should not be called for pure parsing tests') } },
    fs: { promises: {} },
    path: require('node:path'),
    './claudeAgent': { localClaudeBin: () => 'claude' },
    './ssh': { sshExec: () => Promise.reject(new Error('sshExec should not be called for pure parsing tests')) }
  })
}

test('parseGitStatus: an unborn branch ("No commits yet") reports the branch with zero ahead/behind and no files', () => {
  const m = loadGitPure()
  const result = m.parseGitStatus('## No commits yet on main\0')
  assert.deepEqual(result, { branch: 'main', ahead: 0, behind: 0, files: [] })
})

test('parseGitStatus: parses ahead/behind counts from the branch header', () => {
  const m = loadGitPure()
  const result = m.parseGitStatus('## main...origin/main [ahead 2, behind 3]\0')
  assert.equal(result.branch, 'main')
  assert.equal(result.ahead, 2)
  assert.equal(result.behind, 3)
})

test('parseGitStatus: a rename/copy record puts the destination path first and the origPath next, without skipping the following file', () => {
  const m = loadGitPure()
  const result = m.parseGitStatus('## main\0R  new.txt\0old.txt\0M  other.txt\0')
  assert.equal(result.files.length, 2)
  assert.deepEqual(result.files[0], { path: 'new.txt', origPath: 'old.txt', x: 'R', y: ' ', staged: true, untracked: false })
  assert.deepEqual(result.files[1], { path: 'other.txt', x: 'M', y: ' ', staged: true, untracked: false })
})

test('parseGitStatus: a copy (C) record is also treated as a rename-shaped entry with origPath', () => {
  const m = loadGitPure()
  const result = m.parseGitStatus('## main\0C  copy.txt\0source.txt\0')
  assert.deepEqual(result.files[0], { path: 'copy.txt', origPath: 'source.txt', x: 'C', y: ' ', staged: true, untracked: false })
})

test('parseGitStatus: untracked files are flagged untracked and not staged', () => {
  const m = loadGitPure()
  const result = m.parseGitStatus('## main\0?? new-file.txt\0')
  assert.deepEqual(result.files[0], { path: 'new-file.txt', x: '?', y: '?', staged: false, untracked: true })
})

test('parseNumstat: a plain modified file reports insertions and deletions', () => {
  const m = loadGitPure()
  const stats = m.parseNumstat('5\t3\tfile.txt\0')
  assert.deepEqual(stats.get('file.txt'), { insertions: 5, deletions: 3, binary: false })
})

test('parseNumstat: a binary file ("- -") reports zero insertions/deletions with binary true', () => {
  const m = loadGitPure()
  const stats = m.parseNumstat('-\t-\timg.png\0')
  assert.deepEqual(stats.get('img.png'), { insertions: 0, deletions: 0, binary: true })
})

test('parseNumstat: a rename record (empty path field, then old\\0new) keys stats by the destination path', () => {
  const m = loadGitPure()
  const stats = m.parseNumstat('2\t1\t\0src.txt\0dst.txt\0')
  assert.deepEqual(stats.get('dst.txt'), { insertions: 2, deletions: 1, binary: false })
  assert.equal(stats.get('src.txt'), undefined)
})

// ---------------------------------------------------------------------------
// src/main/ipc/git.ts — registerGitHandlers IPC-level behavior
// ---------------------------------------------------------------------------

function makeIpcMain() {
  const handlers = {}
  return { handle(channel, fn) { handlers[channel] = fn }, handlers }
}

// Fakes `child_process.spawn` for local git calls: `router(args)` returns
// `{ code, stdout, stderr }` for the invoked argv, defaulting to a clean exit.
function makeSpawn(router) {
  const calls = []
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const resp = router(args, opts) || { code: 0, stdout: '', stderr: '' }
    const listeners = { stdout: [], stderr: [], close: [], error: [] }
    const proc = {
      stdout: { on: (ev, cb) => { if (ev === 'data') listeners.stdout.push(cb) } },
      stderr: { on: (ev, cb) => { if (ev === 'data') listeners.stderr.push(cb) } },
      on: (ev, cb) => { (listeners[ev] ||= []).push(cb) }
    }
    queueMicrotask(() => {
      if (resp.stdout) listeners.stdout.forEach((cb) => cb(Buffer.from(resp.stdout)))
      if (resp.stderr) listeners.stderr.forEach((cb) => cb(Buffer.from(resp.stderr)))
      listeners.close.forEach((cb) => cb(resp.code ?? 0))
    })
    return proc
  }
  return { spawn, calls }
}

// Fakes `./ssh`'s `sshExec(id, cmd)`: `router(cmd)` returns `{ code, out, err }`.
function makeSshExec(router) {
  const calls = []
  const sshExec = (id, cmd) => {
    calls.push({ id, cmd })
    const resp = router(cmd) || { code: 0, out: '', err: '' }
    return Promise.resolve(resp)
  }
  return { sshExec, calls }
}

function setup({ spawnRouter = () => ({ code: 0, stdout: '' }), sshRouter = () => ({ code: 0, out: '' }), fsPromises = {}, shellStub = {} } = {}) {
  const ipcMain = makeIpcMain()
  const { spawn, calls: spawnCalls } = makeSpawn(spawnRouter)
  const { sshExec, calls: sshCalls } = makeSshExec(sshRouter)
  const mod = load('src/main/ipc/git.ts', {
    electron: { ipcMain, shell: shellStub },
    child_process: { spawn },
    fs: { promises: fsPromises },
    path: require('node:path'),
    './claudeAgent': { localClaudeBin: () => 'claude' },
    './ssh': { sshExec }
  })
  mod.registerGitHandlers()
  return { handlers: ipcMain.handlers, spawnCalls, sshCalls }
}

test('git:status without options does not call numstat (only rev-parse + status)', async () => {
  const { handlers, spawnCalls } = setup({
    spawnRouter: (args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/repo\n' }
      if (args[0] === 'status') return { code: 0, stdout: '## main\0M  a.txt\0' }
      return { code: 0, stdout: '' }
    }
  })
  await handlers['git:status'](null, '/repo')
  const commands = spawnCalls.map((c) => c.args[0])
  assert.deepEqual(commands, ['rev-parse', 'status'])
})

test('git:status with { stats: true } additionally calls both cached and working numstat', async () => {
  const { handlers, spawnCalls } = setup({
    spawnRouter: (args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/repo\n' }
      if (args[0] === 'status') return { code: 0, stdout: '## main\0M  a.txt\0' }
      if (args[0] === 'diff' && args.includes('--cached')) return { code: 0, stdout: '1\t1\ta.txt\0' }
      if (args[0] === 'diff') return { code: 0, stdout: '2\t2\ta.txt\0' }
      return { code: 0, stdout: '' }
    }
  })
  const result = await handlers['git:status'](null, '/repo', undefined, { stats: true })
  const diffCalls = spawnCalls.filter((c) => c.args[0] === 'diff')
  assert.equal(diffCalls.length, 2)
  assert.ok(diffCalls.some((c) => c.args.includes('--cached')))
  assert.ok(diffCalls.some((c) => !c.args.includes('--cached')))
  assert.deepEqual(result.files[0].stagedStats, { insertions: 1, deletions: 1, binary: false })
  assert.deepEqual(result.files[0].workingStats, { insertions: 2, deletions: 2, binary: false })
})

test('git:status requests --untracked-files=all in its status invocation', async () => {
  const { handlers, spawnCalls } = setup({
    spawnRouter: (args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: '/repo\n' }
      return { code: 0, stdout: '## main\0' }
    }
  })
  await handlers['git:status'](null, '/repo')
  const statusCall = spawnCalls.find((c) => c.args[0] === 'status')
  assert.ok(statusCall.args.includes('--untracked-files=all'))
})

test('git:diff scope "staged" reads HEAD:origPath for the original side and :destPath for the modified side', async () => {
  const { handlers, spawnCalls } = setup({
    spawnRouter: (args) => {
      if (args[0] === 'show') return { code: 0, stdout: `contents of ${args[1]}\n` }
      return { code: 0, stdout: '' }
    }
  })
  const result = await handlers['git:diff'](null, '/repo', 'dest.txt', false, undefined, 'staged', 'orig.txt')
  const showArgs = spawnCalls.filter((c) => c.args[0] === 'show').map((c) => c.args[1])
  assert.ok(showArgs.includes('HEAD:orig.txt'))
  assert.ok(showArgs.includes(':dest.txt'))
  assert.equal(result.original, 'contents of HEAD:orig.txt\n')
  assert.equal(result.modified, 'contents of :dest.txt\n')
})

test('git:diff scope "working" reads the index (":file") for the original side using the destination name', async () => {
  const { handlers, spawnCalls } = setup({
    spawnRouter: (args) => {
      if (args[0] === 'show') return { code: 0, stdout: `contents of ${args[1]}\n` }
      return { code: 0, stdout: '' }
    },
    fsPromises: { readFile: () => Promise.resolve('disk contents\n') }
  })
  const result = await handlers['git:diff'](null, '/repo', 'dest.txt', false, undefined, 'working')
  const showArgs = spawnCalls.filter((c) => c.args[0] === 'show').map((c) => c.args[1])
  assert.ok(showArgs.includes(':dest.txt'))
  assert.equal(result.original, 'contents of :dest.txt\n')
  assert.equal(result.modified, 'disk contents\n')
})

test('git:discard over SSH removes with "rm -f --" (not recursive)', async () => {
  const { handlers, sshCalls } = setup({ sshRouter: () => ({ code: 0, out: '' }) })
  const result = await handlers['git:discard'](null, '/repo', 'untracked.txt', true, 'conn-1')
  assert.equal(result.code, 0)
  assert.equal(sshCalls.length, 1)
  assert.match(sshCalls[0].cmd, /rm -f -- /)
  assert.doesNotMatch(sshCalls[0].cmd, /rm -rf/)
  assert.doesNotMatch(sshCalls[0].cmd, /-r/)
})

test('git:discard over SSH surfaces a non-zero exit as an error message', async () => {
  const { handlers } = setup({ sshRouter: () => ({ code: 1, out: '', err: 'permission denied' }) })
  const result = await handlers['git:discard'](null, '/repo', 'untracked.txt', true, 'conn-1')
  assert.equal(result.code, 1)
  assert.equal(result.message, 'permission denied')
})

test('git:discard rejects an invalid untracked path (absolute, drive letter, trailing slash, or ".." segment) without touching ssh or the filesystem', async () => {
  const { handlers, sshCalls } = setup()
  const lstatCalls = []
  const badPaths = ['/abs/path.txt', 'C:\\drive\\path.txt', 'folder/', '../escape.txt', 'a/../b.txt']
  for (const file of badPaths) {
    const result = await handlers['git:discard'](null, '/repo', file, true, 'conn-1')
    assert.equal(result.code, 1)
    assert.equal(result.message, 'Caminho inválido para descartar arquivo')
  }
  assert.equal(sshCalls.length, 0)
  assert.equal(lstatCalls.length, 0)
})

test('git:discard locally moves an untracked file to the trash via shell.trashItem (not rm), after an lstat check', async () => {
  const trashed = []
  const { handlers } = setup({
    fsPromises: { lstat: () => Promise.resolve({ isDirectory: () => false }) },
    shellStub: { trashItem: (target) => { trashed.push(target); return Promise.resolve() } }
  })
  const result = await handlers['git:discard'](null, '/repo', 'untracked.txt', true, undefined)
  assert.equal(result.code, 0)
  assert.equal(trashed.length, 1)
  assert.ok(trashed[0].endsWith('untracked.txt'))
})

test('git:discard locally refuses to trash a directory path', async () => {
  const trashed = []
  const { handlers } = setup({
    fsPromises: { lstat: () => Promise.resolve({ isDirectory: () => true }) },
    shellStub: { trashItem: (target) => { trashed.push(target); return Promise.resolve() } }
  })
  const result = await handlers['git:discard'](null, '/repo', 'a-directory', true, undefined)
  assert.equal(result.code, 1)
  assert.equal(result.message, 'Selecione um arquivo para descartar')
  assert.equal(trashed.length, 0)
})
