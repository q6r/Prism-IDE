import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react'
import { FileDiff, WorkerPoolContext, useWorkerPool } from '@pierre/diffs/react'
import type { FileDiffMetadata } from '@pierre/diffs'
import { useStore } from '../../store'
import { useSharedDiffWorkerPool } from './DiffWorkerPoolProvider'
import { groupDiffSearchMatches } from './diff-find-model'
import { Button, InputAddon, InputGroup, Spinner, Tooltip } from '../ui'
import { buildPierreDiff, pierreDiffStats } from './pierre-diff-model'
import type { DiffViewerPreferences } from './GitDiffView'

const THEMES = { dark: 'pierre-dark', light: 'pierre-light' } as const

// This CSS lives inside Pierre's Shadow DOM, following Traycer's diff-tokens-css.
const DIFF_UNSAFE_CSS = `
  :host, [data-diffs-host] {
    --diffs-font-family: var(--tr-font-mono);
    --diffs-font-size: var(--tr-diff-font-size, 13px);
    --diffs-line-height: var(--tr-diff-line-height, 20px);
  }
  [data-code] {
    --diffs-bg: var(--tr-canvas);
    --diffs-fg: var(--tr-foreground);
  }
  [data-interactive-lines] [data-line] { cursor: text; }
  [data-prism-diff-find-match] {
    --diffs-line-bg: color-mix(in srgb, var(--tr-primary) 22%, var(--diffs-computed-diff-line-bg));
  }
  [data-prism-diff-find-active] {
    --diffs-line-bg: color-mix(in srgb, var(--tr-primary) 52%, var(--diffs-computed-diff-line-bg));
    outline: 1px solid color-mix(in srgb, var(--tr-primary) 70%, transparent);
    outline-offset: -1px;
  }
`

interface Props {
  name: string
  original: string
  modified: string
  view: DiffViewerPreferences
  themeType: 'light' | 'dark'
  onStats: (stats: { insertions: number; deletions: number }) => void
  findOpen: boolean
  onCloseFind: () => void
}

/** Imported only when a visible, expanded, non-binary diff needs rendering. */
export default function PierreDiffContent(props: Props) {
  const { pool, settled } = useSharedDiffWorkerPool()
  const result = useMemo(() => {
    try { return { diff: buildPierreDiff(props.name, props.original, props.modified, props.view.ignoreWhitespace), error: null } }
    catch (error) { return { diff: null, error: error instanceof Error ? error.message : 'Não foi possível preparar o diff' } }
  }, [props.name, props.original, props.modified, props.view.ignoreWhitespace])
  const { onStats } = props
  useEffect(() => { if (result.diff) onStats(pierreDiffStats(result.diff)) }, [result.diff, onStats])
  if (!result.diff) return <div className="pg-error" role="alert">{result.error}</div>
  if (!result.diff.hunks.length) return <div className="pg-empty pg-empty-small">{props.view.ignoreWhitespace && props.original !== props.modified ? 'Sem alterações ao ignorar espaços em branco' : 'Sem alterações'}</div>
  if (!settled) return <div className="pg-empty" role="status"><Spinner />Preparando destaque de sintaxe…</div>
  return <WorkerPoolContext.Provider value={pool}>
    <HighlightedDiff fileDiff={result.diff} view={props.view} themeType={props.themeType} findOpen={props.findOpen} onCloseFind={props.onCloseFind} />
  </WorkerPoolContext.Provider>
}

function HighlightedDiff({ fileDiff, view, themeType, findOpen, onCloseFind }: { fileDiff: FileDiffMetadata; view: DiffViewerPreferences; themeType: 'light' | 'dark'; findOpen: boolean; onCloseFind: () => void }) {
  const pool = useWorkerPool()
  const fontSize = useStore((s) => s.settings.fontSize)
  const [ready, setReady] = useState(false)
  const [query, setQuery] = useState('')
  const [matchIndex, setMatchIndex] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const effectiveQuery = findOpen ? query.toLocaleLowerCase() : ''
  const findState = useRef({ query: effectiveQuery, index: matchIndex })
  findState.current = { query: effectiveQuery, index: matchIndex }
  const applyFind = useCallback((): void => {
    const shadow = hostRef.current?.querySelector('diffs-container')?.shadowRoot
    if (!shadow) return
    const rows = [...shadow.querySelectorAll<HTMLElement>('[data-code] [data-line]')]
    const { query: needle, index } = findState.current
    const matches = groupDiffSearchMatches(rows.map((row) => ({ index: row.getAttribute('data-line-index'), type: row.getAttribute('data-line-type'), text: row.textContent ?? '' })), needle)
    for (const row of rows) { row.removeAttribute('data-prism-diff-find-match'); row.removeAttribute('data-prism-diff-find-active') }
    for (const group of matches) for (const position of group) rows[position].setAttribute('data-prism-diff-find-match', '')
    const active = matches[index % (matches.length || 1)]
    for (const position of active ?? []) rows[position].setAttribute('data-prism-diff-find-active', '')
    if (active) rows[active[0]].scrollIntoView({ block: 'center', inline: 'nearest' })
    setMatchCount(matches.length)
  }, [])
  useEffect(() => { if (findOpen) inputRef.current?.focus() }, [findOpen, ready])
  useEffect(applyFind, [applyFind, ready, effectiveQuery, matchIndex])
  const nextMatch = (direction: number): void => setMatchIndex((current) => (current + direction + matchCount) % (matchCount || 1))
  useEffect(() => {
    let live = true
    // Hold first paint for Shiki, as Traycer does. A failed pool must still release
    // the gate so the library can use its built-in highlighting fallback.
    const settle = (): void => { if (live) setReady(true) }
    if (pool) void pool.primeDiffHighlightCache(fileDiff).then(settle, settle)
    else settle()
    return () => { live = false }
  }, [fileDiff, pool])
  if (!ready) return <div className="pg-empty" role="status"><Spinner />Preparando destaque de sintaxe…</div>
  return <div ref={hostRef} style={{ '--tr-diff-font-size': `${fontSize}px`, '--tr-diff-line-height': `${Math.round(fontSize * 1.5)}px` } as React.CSSProperties}>
    {findOpen && <div className="pg-diff-find" role="search" aria-label="Buscar no diff"><InputGroup variant="search"><InputAddon><Search size={14} /></InputAddon><input ref={inputRef} aria-label="Buscar texto no diff" placeholder="Buscar no diff…" value={query} onChange={(event) => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCloseFind() } else if (event.key === 'Enter') { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1) } }} /></InputGroup><span className="pg-diff-find-count" aria-live="polite">{matchCount ? `${matchIndex % matchCount + 1}/${matchCount}` : '0/0'}</span><Tooltip label="Resultado anterior"><Button variant="muted" size="icon-xs" aria-label="Resultado anterior" disabled={!matchCount} onClick={() => nextMatch(-1)}><ArrowUp size={14} /></Button></Tooltip><Tooltip label="Próximo resultado"><Button variant="muted" size="icon-xs" aria-label="Próximo resultado" disabled={!matchCount} onClick={() => nextMatch(1)}><ArrowDown size={14} /></Button></Tooltip><Button variant="muted" size="icon-xs" aria-label="Fechar busca" onClick={onCloseFind}><X size={14} /></Button></div>}
    <FileDiff fileDiff={fileDiff} edit={false} className="pg-pierre-file" options={{
    disableFileHeader: true,
    collapsed: false,
    diffStyle: view.mode,
    diffIndicators: view.indicatorStyle,
    disableBackground: !view.backgrounds,
    disableLineNumbers: !view.lineNumbers,
    lineDiffType: 'none',
    useTokenTransformer: true,
    overflow: view.wordWrap ? 'wrap' : 'scroll',
    theme: THEMES,
    themeType,
    preferredHighlighter: 'shiki-js',
    unsafeCSS: DIFF_UNSAFE_CSS,
    // Search includes hidden context; closing it restores the native hunk view.
    expandUnchanged: Boolean(effectiveQuery),
    onPostRender: applyFind
  }} />
  </div>
}
