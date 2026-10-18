const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

function fixture() {
  return load('src/renderer/src/components/git/git-model.ts')
}

function file(path, x, y, extra = {}) {
  return { path, x, y, staged: false, untracked: false, ...extra }
}

// groupGitFiles

test('groupGitFiles: a file modified both staged and in the working tree (MM) appears in both staged and working groups', () => {
  const m = fixture()
  const f = file('a.txt', 'M', 'M', { staged: true })
  const groups = m.groupGitFiles([f])
  assert.deepEqual(groups.staged, [f])
  assert.deepEqual(groups.working, [f])
  assert.deepEqual(groups.conflicts, [])
  assert.deepEqual(groups.untracked, [])
})

test('groupGitFiles: an untracked file (??) is placed only in the untracked group, never staged or working', () => {
  const m = fixture()
  const f = file('new.txt', '?', '?', { untracked: true })
  const groups = m.groupGitFiles([f])
  assert.deepEqual(groups.untracked, [f])
  assert.deepEqual(groups.staged, [])
  assert.deepEqual(groups.working, [])
})

test('groupGitFiles: conflicted files (U, AA, DD) go only into conflicts, even if also marked staged or with a dirty working status', () => {
  const m = fixture()
  const uFile = file('u.txt', 'U', 'U', { staged: true })
  const aaFile = file('aa.txt', 'A', 'A', { staged: true })
  const ddFile = file('dd.txt', 'D', 'D', { staged: true })
  const groups = m.groupGitFiles([uFile, aaFile, ddFile])
  assert.deepEqual(groups.conflicts, [uFile, aaFile, ddFile])
  assert.deepEqual(groups.staged, [])
  assert.deepEqual(groups.working, [])
})

test('groupGitFiles: a staged-only file (x set, y blank) appears only in staged', () => {
  const m = fixture()
  const f = file('added.txt', 'A', ' ', { staged: true })
  const groups = m.groupGitFiles([f])
  assert.deepEqual(groups.staged, [f])
  assert.deepEqual(groups.working, [])
})

test('groupGitFiles: a working-only file (y set, not staged) appears only in working', () => {
  const m = fixture()
  const f = file('dirty.txt', ' ', 'M', { staged: false })
  const groups = m.groupGitFiles([f])
  assert.deepEqual(groups.working, [f])
  assert.deepEqual(groups.staged, [])
})

// isConflict

test('isConflict: detects U in either x or y position', () => {
  const m = fixture()
  assert.equal(m.isConflict(file('a', 'U', ' ')), true)
  assert.equal(m.isConflict(file('a', ' ', 'U')), true)
})

test('isConflict: detects AA and DD combinations', () => {
  const m = fixture()
  assert.equal(m.isConflict(file('a', 'A', 'A')), true)
  assert.equal(m.isConflict(file('a', 'D', 'D')), true)
})

test('isConflict: a plain modified or added/deleted pair (not AA/DD/U) is not a conflict', () => {
  const m = fixture()
  assert.equal(m.isConflict(file('a', 'M', 'M')), false)
  assert.equal(m.isConflict(file('a', 'A', ' ')), false)
  assert.equal(m.isConflict(file('a', 'D', ' ')), false)
})

// statusBadge

test('statusBadge: a conflicted file always reports the conflict badge regardless of section', () => {
  const m = fixture()
  const badge = m.statusBadge(file('a', 'U', 'U'), 'staged')
  assert.deepEqual(badge, { letter: '!', label: 'Conflito', tone: 'destructive' })
})

test('statusBadge: an untracked file reports the new-file badge regardless of section argument', () => {
  const m = fixture()
  const badge = m.statusBadge(file('a', '?', '?', { untracked: true }), 'untracked')
  assert.deepEqual(badge, { letter: 'A', label: 'Novo arquivo', tone: 'success' })
})

test('statusBadge: in the staged section, reads the status from x; in working, from y', () => {
  const m = fixture()
  const f = file('a', 'A', 'D')
  assert.deepEqual(m.statusBadge(f, 'staged'), { letter: 'A', label: 'Adicionado', tone: 'success' })
  assert.deepEqual(m.statusBadge(f, 'working'), { letter: 'D', label: 'Excluído', tone: 'destructive' })
})

test('statusBadge: maps R (renamed), C (copied), T (type changed) and an unrecognized code to M (modified)', () => {
  const m = fixture()
  assert.deepEqual(m.statusBadge(file('a', 'R', ' '), 'staged'), { letter: 'R', label: 'Renomeado', tone: 'primary' })
  assert.deepEqual(m.statusBadge(file('a', 'C', ' '), 'staged'), { letter: 'C', label: 'Copiado', tone: 'muted' })
  assert.deepEqual(m.statusBadge(file('a', 'T', ' '), 'staged'), { letter: 'T', label: 'Tipo alterado', tone: 'warning' })
  assert.deepEqual(m.statusBadge(file('a', 'Z', ' '), 'staged'), { letter: 'M', label: 'Modificado', tone: 'warning' })
})

// filterGitFiles

test('filterGitFiles: an empty or whitespace-only query returns every file unchanged', () => {
  const m = fixture()
  const files = [file('src/a.ts', 'M', ' '), file('src/b.ts', 'M', ' ')]
  assert.deepEqual(m.filterGitFiles(files, ''), files)
  assert.deepEqual(m.filterGitFiles(files, '   '), files)
})

test('filterGitFiles: multi-word query requires every word to match (AND), case-insensitively', () => {
  const m = fixture()
  const files = [file('src/components/Git/git-model.ts', 'M', ' '), file('src/components/App.tsx', 'M', ' ')]
  assert.deepEqual(m.filterGitFiles(files, 'git MODEL'), [files[0]])
  assert.deepEqual(m.filterGitFiles(files, 'src app'), [files[1]])
  assert.deepEqual(m.filterGitFiles(files, 'git missing'), [])
})

test('filterGitFiles: extra whitespace between query words is ignored', () => {
  const m = fixture()
  const files = [file('src/components/git/git-model.ts', 'M', ' ')]
  assert.deepEqual(m.filterGitFiles(files, '  git   model  '), files)
})

// buildGitTree

test('buildGitTree: groups files under shared directory ancestors and sorts directories before files', () => {
  const m = fixture()
  const files = [file('src/a.ts', 'M', ' '), file('src/dir/b.ts', 'M', ' ')]
  const tree = m.buildGitTree(files)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].name, 'src')
  const [first, second] = tree[0].children
  assert.equal(first.name, 'dir')
  assert.ok(first.children.length > 0 && !first.file)
  assert.equal(second.name, 'a.ts')
  assert.ok(second.file)
})

test('buildGitTree: a directory and a file sharing the same name at the same level stay as distinct nodes', () => {
  const m = fixture()
  const files = [file('build', 'M', ' '), file('build/output.txt', 'M', ' ')]
  const tree = m.buildGitTree(files)
  assert.equal(tree.length, 2)
  const dirNode = tree.find((n) => !n.file)
  const fileNode = tree.find((n) => n.file)
  assert.equal(dirNode.name, 'build')
  assert.equal(fileNode.name, 'build')
  assert.equal(dirNode.children.length, 1)
  assert.equal(dirNode.children[0].name, 'output.txt')
})

test('buildGitTree: Windows-style backslash paths are split into the same tree structure as forward slashes', () => {
  const m = fixture()
  const files = [file('src\\dir\\file.ts', 'M', ' ')]
  const tree = m.buildGitTree(files)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].name, 'src')
  assert.equal(tree[0].children[0].name, 'dir')
  assert.equal(tree[0].children[0].children[0].name, 'file.ts')
  assert.equal(tree[0].children[0].children[0].path, 'src/dir/file.ts')
})

test('buildGitTree: repeated files under the same directory do not duplicate the directory node', () => {
  const m = fixture()
  const files = [file('src/a.ts', 'M', ' '), file('src/b.ts', 'M', ' '), file('src/c.ts', 'M', ' ')]
  const tree = m.buildGitTree(files)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].name, 'src')
  assert.equal(tree[0].children.length, 3)
})

// diffLineStats

test('diffLineStats: a pure addition (zero original range) counts only insertions', () => {
  const m = fixture()
  const stats = m.diffLineStats([
    { originalStartLineNumber: 5, originalEndLineNumber: 0, modifiedStartLineNumber: 5, modifiedEndLineNumber: 7 }
  ])
  assert.deepEqual(stats, { insertions: 3, deletions: 0 })
})

test('diffLineStats: a pure deletion (zero modified range) counts only deletions', () => {
  const m = fixture()
  const stats = m.diffLineStats([
    { originalStartLineNumber: 10, originalEndLineNumber: 12, modifiedStartLineNumber: 9, modifiedEndLineNumber: 0 }
  ])
  assert.deepEqual(stats, { insertions: 0, deletions: 3 })
})

test('diffLineStats: a modification counts both insertions and deletions, and multiple changes accumulate', () => {
  const m = fixture()
  const stats = m.diffLineStats([
    { originalStartLineNumber: 1, originalEndLineNumber: 2, modifiedStartLineNumber: 1, modifiedEndLineNumber: 1 },
    { originalStartLineNumber: 5, originalEndLineNumber: 0, modifiedStartLineNumber: 5, modifiedEndLineNumber: 5 }
  ])
  assert.deepEqual(stats, { insertions: 2, deletions: 2 })
})

test('diffLineStats: an empty change list produces zero stats', () => {
  const m = fixture()
  assert.deepEqual(m.diffLineStats([]), { insertions: 0, deletions: 0 })
})

// gitFailure

test('gitFailure: a result with code 0 (or no result) is not a failure', () => {
  const m = fixture()
  assert.equal(m.gitFailure({ code: 0, stderr: 'ignored' }), null)
  assert.equal(m.gitFailure(null), null)
  assert.equal(m.gitFailure(undefined), null)
})

test('gitFailure: a non-zero code prefers message, then stderr, then stdout', () => {
  const m = fixture()
  assert.equal(m.gitFailure({ code: 1, message: 'boom', stderr: 'err', stdout: 'out' }), 'boom')
  assert.equal(m.gitFailure({ code: 1, stderr: 'err', stdout: 'out' }), 'err')
  assert.equal(m.gitFailure({ code: 1, stdout: 'out' }), 'out')
})

test('gitFailure: a non-zero code with no usable text falls back to a generic Portuguese message', () => {
  const m = fixture()
  assert.equal(m.gitFailure({ code: 1 }), 'Falha na operação Git')
  assert.equal(m.gitFailure({ code: 1, message: '   ' }), 'Falha na operação Git')
})

test('gitFailure: a whitespace-only message does not mask a useful stderr', () => {
  const m = fixture()
  assert.equal(m.gitFailure({ code: 1, message: '   ', stderr: 'useful detail' }), 'useful detail')
})

test('gitFailure: message, stderr and stdout all whitespace-only falls back to the generic message', () => {
  const m = fixture()
  assert.equal(m.gitFailure({ code: 1, message: '  ', stderr: '\t', stdout: '\n' }), 'Falha na operação Git')
})

test('gitFailure: a non-object or code-less value is not treated as a failure', () => {
  const m = fixture()
  assert.equal(m.gitFailure('error string'), null)
  assert.equal(m.gitFailure({ stderr: 'no code field' }), null)
})
