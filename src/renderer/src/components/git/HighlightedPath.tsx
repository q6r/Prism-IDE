import type { ReactNode } from 'react'

/** Matches the same literal, case-insensitive words as the changed-file filter. */
export function HighlightedPath({ text, query, matchText = text, offset = 0 }: { text: string; query: string; matchText?: string; offset?: number }) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return text
  const lower = matchText.toLocaleLowerCase()
  const hit = new Array<boolean>(text.length).fill(false)
  for (const word of words) {
    let from = 0
    while (from < lower.length) {
      const index = lower.indexOf(word, from)
      if (index < 0) break
      for (let char = Math.max(index - offset, 0); char < Math.min(index + word.length - offset, text.length); char++) hit[char] = true
      from = index + word.length
    }
  }
  const parts: ReactNode[] = []
  let start = 0
  for (let end = 1; end <= text.length; end++) {
    if (end !== text.length && hit[end] === hit[start]) continue
    const part = text.slice(start, end)
    parts.push(hit[start] ? <mark key={start} className="pg-path-highlight">{part}</mark> : part)
    start = end
  }
  return parts
}

export function GitFileName({ name, query }: { name: string; query: string }) {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return <span className="pg-file-name"><HighlightedPath text={name} query={query} /></span>
  return <span className="pg-file-name pg-file-name-extension"><span><HighlightedPath text={name.slice(0, dot)} matchText={name} query={query} /></span><span><HighlightedPath text={name.slice(dot)} matchText={name} offset={dot} query={query} /></span></span>
}
