const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

function fixture() {
  return load('src/renderer/src/components/files/fileTreeModel.ts')
}

function actionsFixture() {
  return load('src/renderer/src/components/files/fileTreeActions.ts')
}

function entry(path, isDir = false) {
  return { path, name: path.split(/[\\/]/).pop(), isDir }
}

// pathKey

test('pathKey: lowercases a Windows drive path and strips a trailing slash', () => {
  const m = fixture()
  assert.equal(m.pathKey('C:\\Users\\Foo\\Bar\\'), 'c:/users/foo/bar')
  assert.equal(m.pathKey('C:/Users/Foo/Bar'), 'c:/users/foo/bar')
})

test('pathKey: lowercases a UNC (//) path', () => {
  const m = fixture()
  assert.equal(m.pathKey('//Server/Share/Dir'), '//server/share/dir')
})

test('pathKey: preserves case for a POSIX/SSH path (no drive letter, no leading //)', () => {
  const m = fixture()
  assert.equal(m.pathKey('/home/User/Project/'), '/home/User/Project')
})

test('pathKey: a single trailing slash is stripped but an internal empty segment is not collapsed', () => {
  const m = fixture()
  assert.equal(m.pathKey('/a/b/'), '/a/b')
})

test('pathKey: the POSIX filesystem root "/" normalizes to itself, not an empty string', () => {
  const m = fixture()
  assert.equal(m.pathKey('/'), '/')
})

test('pathKey: a bare Windows drive root ("C:\\\\" or "C:/") lowercases to "c:"', () => {
  const m = fixture()
  assert.equal(m.pathKey('C:\\'), 'c:')
  assert.equal(m.pathKey('C:/'), 'c:')
})

// isWithinPath

test('isWithinPath: a path equal to the root is within it', () => {
  const m = fixture()
  assert.equal(m.isWithinPath('/root', '/root'), true)
  assert.equal(m.isWithinPath('C:\\root\\', 'c:/ROOT'), true)
})

test('isWithinPath: a proper child path is within the root', () => {
  const m = fixture()
  assert.equal(m.isWithinPath('/root/a/b.txt', '/root'), true)
})

test('isWithinPath: a sibling whose name merely starts with the root string is NOT within it (boundary check)', () => {
  const m = fixture()
  assert.equal(m.isWithinPath('/root-other/file.txt', '/root'), false)
  assert.equal(m.isWithinPath('/root-other', '/root'), false)
})

test('isWithinPath: an unrelated path is not within the root', () => {
  const m = fixture()
  assert.equal(m.isWithinPath('/other/file.txt', '/root'), false)
})

test('isWithinPath: comparison is case-insensitive for Windows drive paths', () => {
  const m = fixture()
  assert.equal(m.isWithinPath('C:\\Root\\Sub\\file.txt', 'c:/root'), true)
})

test('isWithinPath: the POSIX root "/" contains any absolute path', () => {
  const m = fixture()
  assert.equal(m.isWithinPath('/src/a.ts', '/'), true)
  assert.equal(m.isWithinPath('/', '/'), true)
})

test('isWithinPath: a bare Windows drive root ("C:\\\\") contains any path on that drive', () => {
  const m = fixture()
  assert.equal(m.isWithinPath('C:\\src\\a.ts', 'C:\\'), true)
  assert.equal(m.isWithinPath('C:\\', 'C:\\'), true)
})

// relativeTreePath

test('relativeTreePath: strips the matching root prefix and leading separator', () => {
  const m = fixture()
  assert.equal(m.relativeTreePath('/root/a/b.txt', ['/root']), 'a/b.txt')
  assert.equal(m.relativeTreePath('C:\\root\\a\\b.txt', ['C:\\root']), 'a\\b.txt')
})

test('relativeTreePath: picks the longest (most specific) matching root among nested roots', () => {
  const m = fixture()
  const roots = ['/root', '/root/nested']
  assert.equal(m.relativeTreePath('/root/nested/file.txt', roots), 'file.txt')
  assert.equal(m.relativeTreePath('/root/other/file.txt', roots), 'other/file.txt')
})

test('relativeTreePath: falls back to the basename when no root matches', () => {
  const m = fixture()
  assert.equal(m.relativeTreePath('/elsewhere/deep/file.txt', ['/root']), 'file.txt')
})

test('relativeTreePath: a path equal to the root returns an empty string', () => {
  const m = fixture()
  assert.equal(m.relativeTreePath('/root', ['/root']), '')
})

// ancestorDirectories

test('ancestorDirectories: returns root plus each intermediate directory, excluding the file itself', () => {
  const m = fixture()
  assert.deepEqual(m.ancestorDirectories('/root/a/b/c.txt', '/root'), ['/root', '/root/a', '/root/a/b'])
})

test('ancestorDirectories: a direct child of root returns only the root', () => {
  const m = fixture()
  assert.deepEqual(m.ancestorDirectories('/root/file.txt', '/root'), ['/root'])
})

test('ancestorDirectories: the root itself has no ancestors (empty array)', () => {
  const m = fixture()
  assert.deepEqual(m.ancestorDirectories('/root', '/root'), [])
})

test('ancestorDirectories: a path outside the root returns an empty array', () => {
  const m = fixture()
  assert.deepEqual(m.ancestorDirectories('/other/file.txt', '/root'), [])
})

test('ancestorDirectories: uses backslash separators when the root is a Windows path', () => {
  const m = fixture()
  assert.deepEqual(m.ancestorDirectories('C:\\root\\a\\b\\c.txt', 'C:\\root'), ['C:\\root', 'C:\\root\\a', 'C:\\root\\a\\b'])
})

test('ancestorDirectories: the POSIX filesystem root "/" as root yields "/" plus each intermediate dir', () => {
  const m = fixture()
  assert.deepEqual(m.ancestorDirectories('/src/a.ts', '/'), ['/', '/src'])
})

test('ancestorDirectories: a bare Windows drive root ("C:\\\\") yields the drive root plus each intermediate dir', () => {
  const m = fixture()
  assert.deepEqual(m.ancestorDirectories('C:\\src\\a.ts', 'C:\\'), ['C:\\', 'C:\\src'])
})

// sortTreeEntries

test('sortTreeEntries: directories sort before files regardless of name', () => {
  const m = fixture()
  const entries = [entry('/root/z.txt'), entry('/root/a-dir', true)]
  assert.deepEqual(m.sortTreeEntries(entries).map((e) => e.path), ['/root/a-dir', '/root/z.txt'])
})

test('sortTreeEntries: within the same kind, names sort naturally (numeric-aware)', () => {
  const m = fixture()
  const entries = [entry('/root/file10.txt'), entry('/root/file2.txt'), entry('/root/file1.txt')]
  assert.deepEqual(m.sortTreeEntries(entries).map((e) => e.name), ['file1.txt', 'file2.txt', 'file10.txt'])
})

test('sortTreeEntries: comparison is case-insensitive (base sensitivity)', () => {
  const m = fixture()
  const entries = [entry('/root/Banana.txt'), entry('/root/apple.txt')]
  assert.deepEqual(m.sortTreeEntries(entries).map((e) => e.name), ['apple.txt', 'Banana.txt'])
})

test('sortTreeEntries: does not mutate the input array', () => {
  const m = fixture()
  const entries = [entry('/root/z.txt'), entry('/root/a.txt')]
  const copy = [...entries]
  m.sortTreeEntries(entries)
  assert.deepEqual(entries, copy)
})

test('sortTreeEntries: returns a new array (not the same reference)', () => {
  const m = fixture()
  const entries = [entry('/root/a.txt')]
  assert.notEqual(m.sortTreeEntries(entries), entries)
})

// sameTreeEntries

test('sameTreeEntries: true for two arrays with identical path/name/isDir in the same order', () => {
  const m = fixture()
  const a = [entry('/root/a.txt'), entry('/root/b', true)]
  const b = [entry('/root/a.txt'), entry('/root/b', true)]
  assert.equal(m.sameTreeEntries(a, b), true)
})

test('sameTreeEntries: false when lengths differ', () => {
  const m = fixture()
  assert.equal(m.sameTreeEntries([entry('/root/a.txt')], []), false)
})

test('sameTreeEntries: false when order differs', () => {
  const m = fixture()
  const a = [entry('/root/a.txt'), entry('/root/b.txt')]
  const b = [entry('/root/b.txt'), entry('/root/a.txt')]
  assert.equal(m.sameTreeEntries(a, b), false)
})

test('sameTreeEntries: false when isDir differs for an otherwise identical entry', () => {
  const m = fixture()
  assert.equal(m.sameTreeEntries([entry('/root/a', false)], [entry('/root/a', true)]), false)
})

test('sameTreeEntries: false when the first argument is undefined', () => {
  const m = fixture()
  assert.equal(m.sameTreeEntries(undefined, [entry('/root/a.txt')]), false)
})

// flattenVisibleEntries

test('flattenVisibleEntries: lists a single root\'s children with nested dirs collapsed by default (not in expanded set)', () => {
  const m = fixture()
  const children = {
    '/root': [entry('/root/dir', true), entry('/root/file.txt')],
    '/root/dir': [entry('/root/dir/inner.txt')]
  }
  const result = m.flattenVisibleEntries(['/root'], children, new Set(), new Set())
  assert.deepEqual(result.map((e) => e.path), ['/root/dir', '/root/file.txt'])
})

test('flattenVisibleEntries: recurses into a directory present in the expanded set', () => {
  const m = fixture()
  const children = {
    '/root': [entry('/root/dir', true), entry('/root/file.txt')],
    '/root/dir': [entry('/root/dir/inner.txt')]
  }
  const result = m.flattenVisibleEntries(['/root'], children, new Set(['/root/dir']), new Set())
  assert.deepEqual(result.map((e) => e.path), ['/root/dir', '/root/dir/inner.txt', '/root/file.txt'])
})

test('flattenVisibleEntries: a root listed in collapsedRoots contributes nothing', () => {
  const m = fixture()
  const children = { '/root': [entry('/root/file.txt')] }
  const result = m.flattenVisibleEntries(['/root'], children, new Set(), new Set(['/root']))
  assert.deepEqual(result, [])
})

test('flattenVisibleEntries: multiple roots are each visited in order', () => {
  const m = fixture()
  const children = {
    '/root1': [entry('/root1/a.txt')],
    '/root2': [entry('/root2/b.txt')]
  }
  const result = m.flattenVisibleEntries(['/root1', '/root2'], children, new Set(), new Set())
  assert.deepEqual(result.map((e) => e.path), ['/root1/a.txt', '/root2/b.txt'])
})

test('flattenVisibleEntries: a directory missing from `children` (not yet lazily loaded) yields no children, no throw', () => {
  const m = fixture()
  const children = { '/root': [entry('/root/dir', true)] }
  const result = m.flattenVisibleEntries(['/root'], children, new Set(['/root/dir']), new Set())
  assert.deepEqual(result.map((e) => e.path), ['/root/dir'])
})

// buildFilteredTree

test('buildFilteredTree: includes a matching file plus all of its ancestor directories', () => {
  const m = fixture()
  const files = [{ path: '/root/a/b/target.txt', rel: 'a/b/target.txt' }]
  const tree = m.buildFilteredTree(['/root'], files, 'target')
  assert.deepEqual(tree['/root'].map((e) => e.path), ['/root/a'])
  assert.equal(tree['/root'][0].isDir, true)
  assert.deepEqual(tree['/root/a'].map((e) => e.path), ['/root/a/b'])
  assert.deepEqual(tree['/root/a/b'].map((e) => e.path), ['/root/a/b/target.txt'])
  assert.equal(tree['/root/a/b'][0].isDir, false)
})

test('buildFilteredTree: a file not present in the lazily-loaded `children` map is still included, since the search operates on the full file list', () => {
  const m = fixture()
  const files = [{ path: '/root/never/loaded/deep.ts', rel: 'never/loaded/deep.ts' }]
  const tree = m.buildFilteredTree(['/root'], files, 'deep')
  assert.ok(tree['/root'])
  assert.ok(tree['/root/never'])
  assert.ok(tree['/root/never/loaded'])
  assert.deepEqual(tree['/root/never/loaded'].map((e) => e.path), ['/root/never/loaded/deep.ts'])
})

test('buildFilteredTree: only matching files and their ancestors are included, not sibling files/dirs', () => {
  const m = fixture()
  const files = [
    { path: '/root/a/match.txt', rel: 'a/match.txt' },
    { path: '/root/a/other.txt', rel: 'a/other.txt' },
    { path: '/root/b/unrelated.txt', rel: 'b/unrelated.txt' }
  ]
  const tree = m.buildFilteredTree(['/root'], files, 'match')
  assert.deepEqual(tree['/root'].map((e) => e.path), ['/root/a'])
  assert.deepEqual(tree['/root/a'].map((e) => e.path), ['/root/a/match.txt'])
  assert.equal(tree['/root/b'], undefined)
})

test('buildFilteredTree: matching is case-insensitive and matches on the basename only', () => {
  const m = fixture()
  const files = [{ path: '/root/Deep/Target.TXT', rel: 'Deep/Target.TXT' }]
  const tree = m.buildFilteredTree(['/root'], files, 'target')
  assert.deepEqual(tree['/root/Deep'].map((e) => e.path), ['/root/Deep/Target.TXT'])
})

test('buildFilteredTree: an empty/whitespace query matches every file', () => {
  const m = fixture()
  const files = [{ path: '/root/a.txt', rel: 'a.txt' }, { path: '/root/b.txt', rel: 'b.txt' }]
  const tree = m.buildFilteredTree(['/root'], files, '   ')
  assert.deepEqual(tree['/root'].map((e) => e.path).sort(), ['/root/a.txt', '/root/b.txt'])
})

test('buildFilteredTree: a file outside every root is dropped', () => {
  const m = fixture()
  const files = [{ path: '/outside/match.txt', rel: 'match.txt' }]
  const tree = m.buildFilteredTree(['/root'], files, 'match')
  assert.deepEqual(tree, {})
})

test('buildFilteredTree: directory entries from two different matching files under the same parent are de-duplicated and sorted', () => {
  const m = fixture()
  const files = [
    { path: '/root/a/x-match.txt', rel: 'a/x-match.txt' },
    { path: '/root/a/y-match.txt', rel: 'a/y-match.txt' }
  ]
  const tree = m.buildFilteredTree(['/root'], files, 'match')
  assert.deepEqual(tree['/root/a'].map((e) => e.name), ['x-match.txt', 'y-match.txt'])
})

test('buildFilteredTree: a query matching a directory name (derived from a file\'s ancestors) returns that directory plus its own ancestors, marked isDir, without pulling in its sibling/child files', () => {
  const m = fixture()
  const files = [{ path: '/root/a/b/c.txt', rel: 'a/b/c.txt' }]
  const tree = m.buildFilteredTree(['/root'], files, 'b')
  assert.deepEqual(tree['/root'], [{ path: '/root/a', name: 'a', isDir: true }])
  assert.deepEqual(tree['/root/a'], [{ path: '/root/a/b', name: 'b', isDir: true }])
  assert.equal(tree['/root/a/b'], undefined)
})

test('buildFilteredTree: a matched directory is never emitted with isDir false, even though it reaches the output through the same code path as a file', () => {
  const m = fixture()
  const files = [{ path: '/root/dir/leaf.txt', rel: 'dir/leaf.txt' }]
  const tree = m.buildFilteredTree(['/root'], files, 'dir')
  const match = tree['/root'].find((e) => e.name === 'dir')
  assert.equal(match.isDir, true)
})

test('buildFilteredTree: an explicit empty directory entry (isDir: true, no files beneath it) is searchable and appears with no children', () => {
  const m = fixture()
  const files = [{ path: '/root/empty', rel: 'empty', isDir: true }]
  const tree = m.buildFilteredTree(['/root'], files, 'empty')
  assert.deepEqual(tree['/root'], [{ path: '/root/empty', name: 'empty', isDir: true }])
  assert.equal(tree['/root/empty'], undefined)
})

test('buildFilteredTree: an explicit empty directory entry that does not match the query is excluded entirely', () => {
  const m = fixture()
  const files = [{ path: '/root/empty', rel: 'empty', isDir: true }]
  const tree = m.buildFilteredTree(['/root'], files, 'nomatch')
  assert.deepEqual(tree, {})
})

test('buildFilteredTree: an index entry equal to the root path itself is excluded, even when it matches the query and is marked isDir', () => {
  const m = fixture()
  const files = [
    { path: '/root', rel: '', isDir: true },
    { path: '/root/a.txt', rel: 'a.txt' }
  ]
  const tree = m.buildFilteredTree(['/root'], files, '')
  assert.deepEqual(tree['/root'], [{ path: '/root/a.txt', name: 'a.txt', isDir: false }])
  const allPaths = Object.values(tree).flat().map((e) => e.path)
  assert.ok(!allPaths.includes('/root'))
})

test('buildFilteredTree: a root-equal index entry is excluded even when nothing else is indexed, producing an empty tree', () => {
  const m = fixture()
  const files = [{ path: '/root/sub', rel: '', isDir: true }]
  const tree = m.buildFilteredTree(['/root/sub'], files, 'sub')
  assert.deepEqual(tree, {})
})

test('buildFilteredTree: a plain file query still returns only the matching file and its ancestors, unaffected by directory candidates derived from unrelated files', () => {
  const m = fixture()
  const files = [
    { path: '/root/src/target.txt', rel: 'src/target.txt' },
    { path: '/root/src/other.txt', rel: 'src/other.txt' }
  ]
  const tree = m.buildFilteredTree(['/root'], files, 'target')
  assert.deepEqual(tree['/root'], [{ path: '/root/src', name: 'src', isDir: true }])
  assert.deepEqual(tree['/root/src'], [{ path: '/root/src/target.txt', name: 'target.txt', isDir: false }])
})

// gitDecoration

test('gitDecoration: conflict codes (DD, AU, UD, UA, DU, AA, UU) map to the conflict status regardless of staged/untracked flags', () => {
  const m = fixture()
  for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
    const d = m.gitDecoration({ path: 'f', x: xy[0], y: xy[1], untracked: true })
    assert.equal(d.status, 'conflict', xy)
    assert.equal(d.label, 'U')
  }
})

test('gitDecoration: untracked flag wins over a status letter that would otherwise classify as modified', () => {
  const m = fixture()
  const d = m.gitDecoration({ path: 'f', x: ' ', y: 'M', untracked: true })
  assert.equal(d.status, 'untracked')
})

test('gitDecoration: "??" xy code maps to untracked even without the flag set', () => {
  const m = fixture()
  const d = m.gitDecoration({ path: 'f', x: '?', y: '?', untracked: false })
  assert.equal(d.status, 'untracked')
})

test('gitDecoration: a D in x or y (not a conflict code) maps to deleted', () => {
  const m = fixture()
  assert.equal(m.gitDecoration({ path: 'f', x: 'D', y: ' ', untracked: false }).status, 'deleted')
  assert.equal(m.gitDecoration({ path: 'f', x: ' ', y: 'D', untracked: false }).status, 'deleted')
})

test('gitDecoration: an R maps to renamed', () => {
  const m = fixture()
  assert.equal(m.gitDecoration({ path: 'f', x: 'R', y: ' ', untracked: false }).status, 'renamed')
})

test('gitDecoration: an A maps to added', () => {
  const m = fixture()
  assert.equal(m.gitDecoration({ path: 'f', x: 'A', y: ' ', untracked: false }).status, 'added')
})

test('gitDecoration: M, T, or C maps to modified', () => {
  const m = fixture()
  assert.equal(m.gitDecoration({ path: 'f', x: 'M', y: ' ', untracked: false }).status, 'modified')
  assert.equal(m.gitDecoration({ path: 'f', x: 'T', y: ' ', untracked: false }).status, 'modified')
  assert.equal(m.gitDecoration({ path: 'f', x: 'C', y: ' ', untracked: false }).status, 'modified')
})

test('gitDecoration: priority order is conflict > untracked > deleted > renamed > added > modified (DR picks deleted, not renamed)', () => {
  const m = fixture()
  assert.equal(m.gitDecoration({ path: 'f', x: 'D', y: 'R', untracked: false }).status, 'deleted')
})

test('gitDecoration: a clean/unmapped xy code (e.g. two blanks) returns null', () => {
  const m = fixture()
  assert.equal(m.gitDecoration({ path: 'f', x: ' ', y: ' ', untracked: false }), null)
})

// @pierre/trees icon resolver (real package, not a mock)

test('resolveFileIcon: resolves real icon tokens for common extensions via the complete set', async () => {
  const { createFileTreeIconResolver } = await import('@pierre/trees')
  const resolver = createFileTreeIconResolver({ set: 'complete' })
  const resolveFileIcon = (name) => resolver.resolveIcon('file-tree-icon-file', name)

  assert.equal(resolveFileIcon('index.ts').token, 'typescript')
  assert.equal(resolveFileIcon('Component.tsx').token, 'react')
  assert.equal(resolveFileIcon('package.json').token, 'json')
  assert.equal(resolveFileIcon('.gitignore').token, 'git')
  assert.equal(resolveFileIcon('weird.unknownext123').token, 'default')
})

test('resolveFileIcon: an icon result always carries its origin token (file-tree-icon-file)', async () => {
  const { createFileTreeIconResolver } = await import('@pierre/trees')
  const resolver = createFileTreeIconResolver({ set: 'complete' })
  const icon = resolver.resolveIcon('file-tree-icon-file', 'index.ts')
  assert.equal(icon.remappedFrom, 'file-tree-icon-file')
  assert.ok(icon.name.startsWith('file-tree-builtin-'))
})

test('getBuiltInSpriteSheet: the complete sprite sheet is a non-empty SVG-bearing string', async () => {
  const { getBuiltInSpriteSheet } = await import('@pierre/trees')
  const sheet = getBuiltInSpriteSheet('complete')
  assert.equal(typeof sheet, 'string')
  assert.ok(sheet.length > 0)
  assert.ok(sheet.includes('<svg') || sheet.includes('<symbol'))
})

// prepareFileTreeSearchIndex / filterFileTreeSearchIndex

test('prepareFileTreeSearchIndex: one index entry is produced per file plus one per distinct ancestor directory, with ancestors precomputed', () => {
  const m = fixture()
  const index = m.prepareFileTreeSearchIndex(['/root'], [{ path: '/root/a/b.txt', rel: 'a/b.txt' }])
  const byPath = Object.fromEntries(index.map((e) => [e.path, e]))
  assert.deepEqual(Object.keys(byPath).sort(), ['/root/a', '/root/a/b.txt'])
  assert.equal(byPath['/root/a'].isDir, true)
  assert.deepEqual(byPath['/root/a'].ancestors, ['/root'])
  assert.equal(byPath['/root/a/b.txt'].isDir, false)
  assert.deepEqual(byPath['/root/a/b.txt'].ancestors, ['/root', '/root/a'])
})

test('prepareFileTreeSearchIndex: lowerName is the lowercased basename, usable for case-insensitive matching', () => {
  const m = fixture()
  const index = m.prepareFileTreeSearchIndex(['/root'], [{ path: '/root/Target.TXT', rel: 'Target.TXT' }])
  const e = index.find((x) => x.path === '/root/Target.TXT')
  assert.equal(e.name, 'Target.TXT')
  assert.equal(e.lowerName, 'target.txt')
})

test('prepareFileTreeSearchIndex: a file outside every root is excluded from the index, and an entry equal to the root is excluded', () => {
  const m = fixture()
  const index = m.prepareFileTreeSearchIndex(['/root'], [
    { path: '/outside/a.txt', rel: 'a.txt' },
    { path: '/root', rel: '', isDir: true }
  ])
  assert.deepEqual(index, [])
})

test('filterFileTreeSearchIndex: the same prepared index can be queried multiple times without mutation, each query producing an independent, correct tree', () => {
  const m = fixture()
  const index = m.prepareFileTreeSearchIndex(['/root'], [
    { path: '/root/src/alpha.ts', rel: 'src/alpha.ts' },
    { path: '/root/src/beta.ts', rel: 'src/beta.ts' }
  ])
  const snapshotBefore = JSON.stringify(index)

  const alphaTree = m.filterFileTreeSearchIndex(index, 'alpha')
  assert.deepEqual(alphaTree['/root/src'].map((e) => e.name), ['alpha.ts'])

  const betaTree = m.filterFileTreeSearchIndex(index, 'beta')
  assert.deepEqual(betaTree['/root/src'].map((e) => e.name), ['beta.ts'])

  assert.equal(JSON.stringify(index), snapshotBefore)
})

test('filterFileTreeSearchIndex + prepareFileTreeSearchIndex together match buildFilteredTree\'s output for the same inputs (the wrapper stays compatible)', () => {
  const m = fixture()
  const roots = ['/root']
  const files = [
    { path: '/root/a/match.txt', rel: 'a/match.txt' },
    { path: '/root/a/other.txt', rel: 'a/other.txt' },
    { path: '/root/empty', rel: 'empty', isDir: true }
  ]
  const viaIndex = m.filterFileTreeSearchIndex(m.prepareFileTreeSearchIndex(roots, files), 'match')
  const viaWrapper = m.buildFilteredTree(roots, files, 'match')
  assert.deepEqual(viaIndex, viaWrapper)
})

// isFileTreeSearchTruncated

test('isFileTreeSearchTruncated: a single root at or above the default cap (8000) is truncated', () => {
  const m = fixture()
  assert.equal(m.isFileTreeSearchTruncated([new Array(8000).fill(0)]), true)
  assert.equal(m.isFileTreeSearchTruncated([new Array(8001).fill(0)]), true)
})

test('isFileTreeSearchTruncated: a single root below the default cap is not truncated', () => {
  const m = fixture()
  assert.equal(m.isFileTreeSearchTruncated([new Array(7999).fill(0)]), false)
})

test('isFileTreeSearchTruncated: per-root cap check — the sum across roots reaching the cap does NOT count if each individual root stays below it', () => {
  const m = fixture()
  const listings = [new Array(4000).fill(0), new Array(4000).fill(0), new Array(4000).fill(0)]
  assert.equal(m.isFileTreeSearchTruncated(listings), false)
})

test('isFileTreeSearchTruncated: any single root reaching the cap makes the whole result truncated, even if other roots are small', () => {
  const m = fixture()
  const listings = [new Array(10).fill(0), new Array(8000).fill(0)]
  assert.equal(m.isFileTreeSearchTruncated(listings), true)
})

test('isFileTreeSearchTruncated: a custom cap is honored instead of the 8000 default', () => {
  const m = fixture()
  assert.equal(m.isFileTreeSearchTruncated([new Array(50).fill(0)], 100), false)
  assert.equal(m.isFileTreeSearchTruncated([new Array(100).fill(0)], 100), true)
})

test('isFileTreeSearchTruncated: no roots/listings is never truncated', () => {
  const m = fixture()
  assert.equal(m.isFileTreeSearchTruncated([]), false)
})

// reconcileFileTreeSearchSnapshot

function searchSnapshot(overrides = {}) {
  return { scope: 'root', files: [{ path: '/root/a.txt', rel: 'a.txt' }], truncated: false, ...overrides }
}

test('reconcileFileTreeSearchSnapshot: identical scope/files/truncated returns the SAME previous object reference', () => {
  const m = fixture()
  const prev = searchSnapshot()
  const next = searchSnapshot()
  assert.equal(m.reconcileFileTreeSearchSnapshot(prev, next), prev)
})

test('reconcileFileTreeSearchSnapshot: a different scope returns next', () => {
  const m = fixture()
  const prev = searchSnapshot()
  const next = searchSnapshot({ scope: 'other' })
  assert.equal(m.reconcileFileTreeSearchSnapshot(prev, next), next)
})

test('reconcileFileTreeSearchSnapshot: a different truncated flag returns next', () => {
  const m = fixture()
  const prev = searchSnapshot()
  const next = searchSnapshot({ truncated: true })
  assert.equal(m.reconcileFileTreeSearchSnapshot(prev, next), next)
})

test('reconcileFileTreeSearchSnapshot: a different file count returns next', () => {
  const m = fixture()
  const prev = searchSnapshot()
  const next = searchSnapshot({ files: [...searchSnapshot().files, { path: '/root/b.txt', rel: 'b.txt' }] })
  assert.equal(m.reconcileFileTreeSearchSnapshot(prev, next), next)
})

test('reconcileFileTreeSearchSnapshot: a differing path on an otherwise-matching file returns next', () => {
  const m = fixture()
  const prev = searchSnapshot()
  const next = searchSnapshot({ files: [{ path: '/root/b.txt', rel: 'a.txt' }] })
  assert.equal(m.reconcileFileTreeSearchSnapshot(prev, next), next)
})

test('reconcileFileTreeSearchSnapshot: a differing rel on an otherwise path-matching file returns next (not identity-preserved)', () => {
  const m = fixture()
  const prev = searchSnapshot()
  const next = searchSnapshot({ files: [{ path: '/root/a.txt', rel: 'renamed.txt' }] })
  assert.equal(m.reconcileFileTreeSearchSnapshot(prev, next), next)
})

// reconcileTreeGitSnapshot

function gitSnapshot(overrides = {}) {
  return {
    scope: 'root',
    decorations: { '/root/a.txt': { status: 'modified', label: 'M', title: 'Modificado' } },
    changedDirs: new Set(['/root']),
    ...overrides
  }
}

test('reconcileTreeGitSnapshot: identical scope/decorations/changedDirs returns the SAME previous object reference', () => {
  const m = fixture()
  const prev = gitSnapshot()
  const next = gitSnapshot()
  assert.equal(m.reconcileTreeGitSnapshot(prev, next), prev)
})

test('reconcileTreeGitSnapshot: changedDirs equal as sets but built/iterated in a different insertion order still preserves identity', () => {
  const m = fixture()
  const prev = gitSnapshot({ changedDirs: new Set(['/root/a', '/root/b']) })
  const next = gitSnapshot({ changedDirs: new Set(['/root/b', '/root/a']) })
  assert.equal(m.reconcileTreeGitSnapshot(prev, next), prev)
})

test('reconcileTreeGitSnapshot: decoration keys in a different object insertion order still preserve identity when content matches', () => {
  const m = fixture()
  const prev = gitSnapshot({
    decorations: {
      '/root/a.txt': { status: 'modified', label: 'M', title: 'Modificado' },
      '/root/b.txt': { status: 'added', label: 'A', title: 'Adicionado' }
    }
  })
  const next = gitSnapshot({
    decorations: {
      '/root/b.txt': { status: 'added', label: 'A', title: 'Adicionado' },
      '/root/a.txt': { status: 'modified', label: 'M', title: 'Modificado' }
    }
  })
  assert.equal(m.reconcileTreeGitSnapshot(prev, next), prev)
})

test('reconcileTreeGitSnapshot: a different scope returns next', () => {
  const m = fixture()
  const prev = gitSnapshot()
  const next = gitSnapshot({ scope: 'other' })
  assert.equal(m.reconcileTreeGitSnapshot(prev, next), next)
})

test('reconcileTreeGitSnapshot: a changedDirs set of a different size returns next', () => {
  const m = fixture()
  const prev = gitSnapshot({ changedDirs: new Set(['/root']) })
  const next = gitSnapshot({ changedDirs: new Set(['/root', '/root/sub']) })
  assert.equal(m.reconcileTreeGitSnapshot(prev, next), next)
})

test('reconcileTreeGitSnapshot: a changedDirs set of the same size but different members returns next', () => {
  const m = fixture()
  const prev = gitSnapshot({ changedDirs: new Set(['/root/a']) })
  const next = gitSnapshot({ changedDirs: new Set(['/root/b']) })
  assert.equal(m.reconcileTreeGitSnapshot(prev, next), next)
})

test('reconcileTreeGitSnapshot: a new decoration path (added) returns next', () => {
  const m = fixture()
  const prev = gitSnapshot()
  const next = gitSnapshot({
    decorations: { ...gitSnapshot().decorations, '/root/b.txt': { status: 'added', label: 'A', title: 'Adicionado' } }
  })
  assert.equal(m.reconcileTreeGitSnapshot(prev, next), next)
})

test('reconcileTreeGitSnapshot: a removed decoration path returns next', () => {
  const m = fixture()
  const prev = gitSnapshot({
    decorations: {
      '/root/a.txt': { status: 'modified', label: 'M', title: 'Modificado' },
      '/root/b.txt': { status: 'added', label: 'A', title: 'Adicionado' }
    }
  })
  const next = gitSnapshot()
  assert.equal(m.reconcileTreeGitSnapshot(prev, next), next)
})

test('reconcileTreeGitSnapshot: the same path with a different status returns next', () => {
  const m = fixture()
  const prev = gitSnapshot()
  const next = gitSnapshot({ decorations: { '/root/a.txt': { status: 'deleted', label: 'D', title: 'Excluído' } } })
  assert.equal(m.reconcileTreeGitSnapshot(prev, next), next)
})

test('reconcileTreeGitSnapshot: the same path/status with a different label or title returns next', () => {
  const m = fixture()
  const prev = gitSnapshot()
  const nextLabel = gitSnapshot({ decorations: { '/root/a.txt': { status: 'modified', label: 'X', title: 'Modificado' } } })
  const nextTitle = gitSnapshot({ decorations: { '/root/a.txt': { status: 'modified', label: 'M', title: 'Outro' } } })
  assert.equal(m.reconcileTreeGitSnapshot(prev, nextLabel), nextLabel)
  assert.equal(m.reconcileTreeGitSnapshot(prev, nextTitle), nextTitle)
})

// deleteConfirmedTreeEntry (fileTreeActions.ts)

test('deleteConfirmedTreeEntry: a null remoteId routes to trashLocal only, with the literal path, never calling deleteRemote', async () => {
  const m = actionsFixture()
  const calls = []
  const api = {
    trashLocal: async (path) => { calls.push(['trashLocal', path]); return true },
    deleteRemote: async (id, path) => { calls.push(['deleteRemote', id, path]); return true }
  }
  await m.deleteConfirmedTreeEntry('/root/a.txt', null, api)
  assert.deepEqual(calls, [['trashLocal', '/root/a.txt']])
})

test('deleteConfirmedTreeEntry: a non-null remoteId routes to deleteRemote only, pinning that exact remoteId and path, never calling trashLocal', async () => {
  const m = actionsFixture()
  const calls = []
  const api = {
    trashLocal: async (path) => { calls.push(['trashLocal', path]); return true },
    deleteRemote: async (id, path) => { calls.push(['deleteRemote', id, path]); return true }
  }
  await m.deleteConfirmedTreeEntry('/remote/dir/file.txt', 'ssh-host-1', api)
  assert.deepEqual(calls, [['deleteRemote', 'ssh-host-1', '/remote/dir/file.txt']])
})

test('deleteConfirmedTreeEntry: an empty-string remoteId is still a remote route (only null selects local), calling deleteRemote', async () => {
  const m = actionsFixture()
  const calls = []
  const api = {
    trashLocal: async (path) => { calls.push(['trashLocal', path]); return true },
    deleteRemote: async (id, path) => { calls.push(['deleteRemote', id, path]); return true }
  }
  await m.deleteConfirmedTreeEntry('/remote/file.txt', '', api)
  assert.deepEqual(calls, [['deleteRemote', '', '/remote/file.txt']])
})

test('deleteConfirmedTreeEntry: trashLocal resolving to false throws and never falls back to any other route', async () => {
  const m = actionsFixture()
  const calls = []
  const api = {
    trashLocal: async (path) => { calls.push(['trashLocal', path]); return false },
    deleteRemote: async (id, path) => { calls.push(['deleteRemote', id, path]); return true }
  }
  await assert.rejects(() => m.deleteConfirmedTreeEntry('/root/a.txt', null, api))
  assert.deepEqual(calls, [['trashLocal', '/root/a.txt']])
})

test('deleteConfirmedTreeEntry: deleteRemote resolving to false throws and never falls back to trashLocal', async () => {
  const m = actionsFixture()
  const calls = []
  const api = {
    trashLocal: async (path) => { calls.push(['trashLocal', path]); return true },
    deleteRemote: async (id, path) => { calls.push(['deleteRemote', id, path]); return false }
  }
  await assert.rejects(() => m.deleteConfirmedTreeEntry('/remote/file.txt', 'host', api))
  assert.deepEqual(calls, [['deleteRemote', 'host', '/remote/file.txt']])
})

test('deleteConfirmedTreeEntry: a rejected trashLocal promise propagates the rejection rather than being swallowed or retried on another route', async () => {
  const m = actionsFixture()
  const calls = []
  const api = {
    trashLocal: async (path) => { calls.push(['trashLocal', path]); throw new Error('disk busy') },
    deleteRemote: async (id, path) => { calls.push(['deleteRemote', id, path]); return true }
  }
  await assert.rejects(() => m.deleteConfirmedTreeEntry('/root/a.txt', null, api), /disk busy/)
  assert.deepEqual(calls, [['trashLocal', '/root/a.txt']])
})

test('deleteConfirmedTreeEntry: a rejected deleteRemote promise propagates the rejection rather than falling back to trashLocal', async () => {
  const m = actionsFixture()
  const calls = []
  const api = {
    trashLocal: async (path) => { calls.push(['trashLocal', path]); return true },
    deleteRemote: async (id, path) => { calls.push(['deleteRemote', id, path]); throw new Error('ssh dropped') }
  }
  await assert.rejects(() => m.deleteConfirmedTreeEntry('/remote/file.txt', 'host', api), /ssh dropped/)
  assert.deepEqual(calls, [['deleteRemote', 'host', '/remote/file.txt']])
})
