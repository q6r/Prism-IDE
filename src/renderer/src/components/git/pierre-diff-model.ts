import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs'

/** Preserve whitespace and EOF: they are meaningful parts of a diff cache identity. */
export function diffContentFingerprint(contents: string): string {
  let first = 2166136261
  let second = 5381
  for (let index = 0; index < contents.length; index++) {
    const code = contents.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second, 33) ^ code
  }
  return `${contents.length}:${first >>> 0}:${second >>> 0}`
}

/** Full contents keep native hunk expansion available without another Git request. */
export function buildPierreDiff(name: string, original: string, modified: string, ignoreWhitespace: boolean): FileDiffMetadata {
  const scope = `${name}:${ignoreWhitespace ? 'ignore-spaces' : 'exact'}`
  return parseDiffFromFile(
    { name, contents: original, cacheKey: `${scope}:old:${diffContentFingerprint(original)}` },
    { name, contents: modified, cacheKey: `${scope}:new:${diffContentFingerprint(modified)}` },
    { context: 3, ignoreWhitespace, stripTrailingCr: true }
  )
}

export function pierreDiffStats(diff: Pick<FileDiffMetadata, 'hunks'>): { insertions: number; deletions: number } {
  return diff.hunks.reduce((stats, hunk) => ({
    insertions: stats.insertions + hunk.additionLines,
    deletions: stats.deletions + hunk.deletionLines
  }), { insertions: 0, deletions: 0 })
}
