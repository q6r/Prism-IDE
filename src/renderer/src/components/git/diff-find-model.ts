export interface DiffSearchRow { index: string | null; type: string | null; text: string }

/** Split context is rendered twice; both columns represent one search result. */
export function groupDiffSearchMatches(rows: readonly DiffSearchRow[], query: string): number[][] {
  if (!query) return []
  const needle = query.toLocaleLowerCase()
  const groups = new Map<string, number[]>()
  rows.forEach((row, position) => {
    if (!row.text.toLocaleLowerCase().includes(needle)) return
    const key = row.index === null ? `row:${position}` : `${row.type}:${row.index}`
    const group = groups.get(key)
    if (group) group.push(position)
    else groups.set(key, [position])
  })
  return [...groups.values()]
}
