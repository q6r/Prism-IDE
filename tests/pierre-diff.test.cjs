const { test } = require('node:test')
const assert = require('node:assert/strict')
const load = require('./helpers/load-typescript.cjs')

async function fixture() {
  const pierre = await import('@pierre/diffs')
  return load('src/renderer/src/components/git/pierre-diff-model.ts', { '@pierre/diffs': pierre })
}

// diffContentFingerprint

test('diffContentFingerprint: identical contents produce identical fingerprints', async () => {
  const m = await fixture()
  assert.equal(m.diffContentFingerprint('hello\nworld\n'), m.diffContentFingerprint('hello\nworld\n'))
})

test('diffContentFingerprint: contents that differ only in whitespace produce different fingerprints', async () => {
  const m = await fixture()
  assert.notEqual(m.diffContentFingerprint('a\nb\n'), m.diffContentFingerprint('a\n b\n'))
})

test('diffContentFingerprint: contents that differ only in trailing EOF newline produce different fingerprints', async () => {
  const m = await fixture()
  assert.notEqual(m.diffContentFingerprint('a\nb'), m.diffContentFingerprint('a\nb\n'))
})

test('diffContentFingerprint: empty content is stable and distinct from non-empty content', async () => {
  const m = await fixture()
  assert.equal(m.diffContentFingerprint(''), m.diffContentFingerprint(''))
  assert.notEqual(m.diffContentFingerprint(''), m.diffContentFingerprint('a'))
})

// buildPierreDiff / pierreDiffStats: no-op cases

test('buildPierreDiff: identical contents produce no hunks and zero stats', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\nb\nc\n', 'a\nb\nc\n', false)
  assert.deepEqual(diff.hunks, [])
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 0, deletions: 0 })
})

test('buildPierreDiff: empty original and empty modified produce no hunks and zero stats', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', '', '', false)
  assert.deepEqual(diff.hunks, [])
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 0, deletions: 0 })
})

// addition / removal / multiple hunks count only changed lines, not context

test('buildPierreDiff: a pure addition counts only the added line as insertion, not surrounding context', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\nb\n', 'a\nb\nc\n', false)
  assert.equal(diff.hunks.length, 1)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 1, deletions: 0 })
})

test('buildPierreDiff: a pure removal counts only the removed line as deletion, not surrounding context', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\nb\nc\n', 'a\nb\n', false)
  assert.equal(diff.hunks.length, 1)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 0, deletions: 1 })
})

test('buildPierreDiff: two changes far enough apart produce two separate hunks, stats sum across all hunks', async () => {
  const m = await fixture()
  const oldLines = Array.from({ length: 30 }, (_, i) => `line${i}\n`)
  const newLines = [...oldLines]
  newLines[2] = 'CHANGED2\n'
  newLines[25] = 'CHANGED25\n'
  const diff = m.buildPierreDiff('a.txt', oldLines.join(''), newLines.join(''), false)
  assert.equal(diff.hunks.length, 2)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 2, deletions: 2 })
})

// new / deleted file (empty side)

test('buildPierreDiff: empty original with non-empty modified is classified as a new file and counts only insertions', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('new.txt', '', 'hello\nworld\n', false)
  assert.equal(diff.type, 'new')
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 2, deletions: 0 })
})

test('buildPierreDiff: non-empty original with empty modified is classified as a deleted file and counts only deletions', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('old.txt', 'hello\nworld\n', '', false)
  assert.equal(diff.type, 'deleted')
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 0, deletions: 2 })
})

// EOF newline differences

test('buildPierreDiff: a trailing EOF newline difference alone produces a hunk with mismatched noEOFCR flags', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\nb', 'a\nb\n', false)
  assert.equal(diff.hunks.length, 1)
  assert.equal(diff.hunks[0].noEOFCRDeletions, true)
  assert.equal(diff.hunks[0].noEOFCRAdditions, false)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 1, deletions: 1 })
})

// ignoreWhitespace

test('buildPierreDiff: ignoreWhitespace true eliminates a whitespace-only change (no hunks)', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\n  b\n', 'a\nb\n', true)
  assert.deepEqual(diff.hunks, [])
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 0, deletions: 0 })
})

test('buildPierreDiff: ignoreWhitespace false reports the same whitespace-only change as a real hunk', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\n  b\n', 'a\nb\n', false)
  assert.equal(diff.hunks.length, 1)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 1, deletions: 1 })
})

test('buildPierreDiff: ignoreWhitespace true still reports a real content change alongside whitespace noise', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\n  b\nc\n', 'a\nb\nCHANGED\n', true)
  assert.equal(diff.hunks.length, 1)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 1, deletions: 1 })
  assert.ok(diff.additionLines.includes('CHANGED\n'))
  assert.ok(diff.deletionLines.includes('c\n'))
})

// isPartial / full metadata for context expansion

test('buildPierreDiff: parsing from full file contents always yields isPartial false and complete line arrays', async () => {
  const m = await fixture()
  const oldLines = Array.from({ length: 10 }, (_, i) => `line${i}\n`)
  const newLines = [...oldLines]
  newLines[5] = 'CHANGED\n'
  const diff = m.buildPierreDiff('a.txt', oldLines.join(''), newLines.join(''), false)
  assert.equal(diff.isPartial, false)
  assert.equal(diff.deletionLines.length, 10)
  assert.equal(diff.additionLines.length, 10)
  assert.deepEqual(diff.deletionLines, oldLines)
  assert.deepEqual(diff.additionLines, newLines)
})

// cacheKey stability and sensitivity

test('cacheKey: identical inputs produce the identical cacheKey', async () => {
  const m = await fixture()
  const a = m.buildPierreDiff('a.txt', 'same\n', 'same\nmodified\n', false)
  const b = m.buildPierreDiff('a.txt', 'same\n', 'same\nmodified\n', false)
  assert.equal(a.cacheKey, b.cacheKey)
})

test('cacheKey: changes of the same size (same line count, same length) still change the cacheKey', async () => {
  const m = await fixture()
  const a = m.buildPierreDiff('a.txt', 'xxxx\n', 'yyyy\n', false)
  const b = m.buildPierreDiff('a.txt', 'xxxx\n', 'zzzz\n', false)
  assert.notEqual(a.cacheKey, b.cacheKey)
})

test('cacheKey: differs when only the filename changes, contents held constant', async () => {
  const m = await fixture()
  const a = m.buildPierreDiff('a.txt', 'old\n', 'new\n', false)
  const b = m.buildPierreDiff('b.txt', 'old\n', 'new\n', false)
  assert.notEqual(a.cacheKey, b.cacheKey)
})

test('cacheKey: differs when only ignoreWhitespace mode changes, contents held constant', async () => {
  const m = await fixture()
  const a = m.buildPierreDiff('a.txt', 'old\n', 'new\n', false)
  const b = m.buildPierreDiff('a.txt', 'old\n', 'new\n', true)
  assert.notEqual(a.cacheKey, b.cacheKey)
})

test('cacheKey: differs when only an EOF newline changes, visible content held constant', async () => {
  const m = await fixture()
  const a = m.buildPierreDiff('a.txt', 'old\n', 'new\n', false)
  const b = m.buildPierreDiff('a.txt', 'old\n', 'new', false)
  assert.notEqual(a.cacheKey, b.cacheKey)
})

// LF original vs CRLF modified (stripTrailingCr regression)

test('buildPierreDiff: identical content with only an LF-vs-CRLF line-ending difference produces zero hunks (stripTrailingCr)', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\nb\nc\n', 'a\r\nb\r\nc\r\n', false)
  assert.deepEqual(diff.hunks, [])
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 0, deletions: 0 })
})

test('buildPierreDiff: a real edit alongside an LF-vs-CRLF difference still reports correct stats for just that edit', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\nb\nc\n', 'a\r\nCHANGED\r\nc\r\n', false)
  assert.equal(diff.hunks.length, 1)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 1, deletions: 1 })
})

test('buildPierreDiff: a genuine trailing EOF-newline difference is still detected despite stripTrailingCr', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\nb', 'a\r\nb\r\n', false)
  assert.equal(diff.hunks.length, 1)
  assert.equal(diff.hunks[0].noEOFCRDeletions, true)
  assert.equal(diff.hunks[0].noEOFCRAdditions, false)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 1, deletions: 1 })
})

// Unicode / CRLF parsing

test('buildPierreDiff: parses Unicode content (accents, emoji) correctly and counts the changed line', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'héllo\n🙂\n', 'héllo\n🙃\n', false)
  assert.equal(diff.hunks.length, 1)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 1, deletions: 1 })
  assert.ok(diff.additionLines.includes('🙃\n'))
  assert.ok(diff.deletionLines.includes('🙂\n'))
})

test('buildPierreDiff: parses CRLF line endings and preserves them in the line arrays', async () => {
  const m = await fixture()
  const diff = m.buildPierreDiff('a.txt', 'a\r\nb\r\n', 'a\r\nc\r\n', false)
  assert.equal(diff.hunks.length, 1)
  assert.deepEqual(m.pierreDiffStats(diff), { insertions: 1, deletions: 1 })
  assert.ok(diff.deletionLines.includes('b\r\n'))
  assert.ok(diff.additionLines.includes('c\r\n'))
})
