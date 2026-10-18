import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Search, ChevronRight, ChevronDown, CaseSensitive } from 'lucide-react'
import { useStore } from '../store'
import { FileTypeIcon } from '../lib/fileIcon'
import { gotoPosition } from '../lib/editorRef'
import { Button, InputAddon, InputGroup, Tooltip, Spinner } from './ui'
import PanelHeader from './shell/PanelHeader'
import { matchRanges } from './shell/logic'
import '../styles/shell.css'

interface Match {
  line: number
  col: number
  preview: string
}
interface ResultFile {
  path: string
  rel: string
  name: string
  matches: Match[]
}

function highlight(text: string, query: string, cs: boolean): ReactNode[] {
  if (!query) return [text]
  const out: ReactNode[] = []
  let i = 0
  for (const range of matchRanges(text, query, cs)) {
    if (range.start > i) out.push(text.slice(i, range.start))
    out.push(<mark key={range.start} className="ps-shell-search-hl">{text.slice(range.start, range.end)}</mark>)
    i = range.end
  }
  if (i < text.length) out.push(text.slice(i))
  return out
}

export default function SearchPanel() {
  const folderPath = useStore((s) => s.folderPath)
  const remote = useStore((s) => s.remote)
  const openFile = useStore((s) => s.openFile)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [results, setResults] = useState<ResultFile[]>([])
  const [status, setStatus] = useState<'idle' | 'waiting' | 'searching' | 'done'>('idle')
  const [displayedSearch, setDisplayedSearch] = useState({ query: '', caseSensitive: false })
  const [counts, setCounts] = useState({ files: 0, matches: 0, truncated: false })
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const idRef = useRef(0)
  const targetRef = useRef(JSON.stringify([folderPath, remote?.id]))

  useEffect(() => {
    const offResult = window.prism.search.onResult((data) => {
      if (data.id !== idRef.current) return
      setResults((prev) => [...prev, { path: data.path, rel: data.rel, name: data.name, matches: data.matches }])
    })
    const offDone = window.prism.search.onDone((data) => {
      if (data.id !== idRef.current) return
      setStatus('done')
      setCounts({ files: data.files, matches: data.matches, truncated: data.truncated })
    })
    return () => {
      offResult()
      offDone()
    }
  }, [])

  useEffect(() => {
    const q = query.trim()
    const id = ++idRef.current
    window.prism.search.cancel()
    const target = JSON.stringify([folderPath, remote?.id])
    if (target !== targetRef.current) {
      targetRef.current = target
      setResults([])
      setCounts({ files: 0, matches: 0, truncated: false })
    }
    if (!folderPath || q.length < 2) {
      setResults([])
      setCounts({ files: 0, matches: 0, truncated: false })
      setStatus('idle')
      return
    }
    setStatus('waiting')
    const t = setTimeout(() => {
      setResults([])
      setCounts({ files: 0, matches: 0, truncated: false })
      setDisplayedSearch({ query: q, caseSensitive })
      setCollapsed(new Set())
      setStatus('searching')
      window.prism.search.run({ id, root: folderPath, query: q, caseSensitive, remoteId: remote?.id })
    }, 180)
    return () => { clearTimeout(t); idRef.current++; window.prism.search.cancel() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, folderPath, remote?.id])

  const open = async (file: ResultFile, m: Match): Promise<void> => {
    await openFile(file.path)
    setTimeout(() => gotoPosition(m.line, m.col), 80)
  }

  const toggle = (path: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  if (!folderPath) {
    return (
      <div className="ps-shell-panel">
        <PanelHeader title="Buscar" />
        <div className="ps-shell-empty">
          <Search size={26} strokeWidth={1.4} />
          <p>Abra uma pasta para buscar.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="ps-shell-search-panel">
      <PanelHeader title="Buscar" />
      <div className="ps-shell-search-input-row">
        <InputGroup variant="search" className="ps-shell-search-box">
          <InputAddon><Search size={14} /></InputAddon>
          <input
            autoFocus
            aria-label="Buscar no projeto"
            placeholder="Buscar no projeto…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </InputGroup>
        <Tooltip label="Diferenciar maiúsculas e minúsculas"><Button variant="ghost" size="icon-sm"
          className={'ps-shell-search-toggle' + (caseSensitive ? ' on' : '')}
          aria-label="Diferenciar maiúsculas e minúsculas"
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((v) => !v)}
        >
          <CaseSensitive size={16} />
        </Button></Tooltip>
      </div>

      {status !== 'idle' && (
        <div className="ps-shell-search-summary" role="status">
          {status === 'waiting' || (status === 'searching' && results.length === 0) ? (
            <><Spinner />Buscando…</>
          ) : counts.matches === 0 && status === 'done' ? (
            'Nenhum resultado'
          ) : (
            <>
              {counts.matches || results.reduce((n, r) => n + r.matches.length, 0)} resultados em{' '}
              {counts.files || results.length} arquivos
              {counts.truncated && ' (limitado)'}
            </>
          )}
        </div>
      )}

      <div className="ps-shell-search-results" aria-busy={status === 'waiting' || status === 'searching'}>
        {results.map((file) => (
          <div key={file.path} className="ps-shell-search-file">
            <button type="button" className="ps-shell-search-file-head" aria-expanded={!collapsed.has(file.path)} onClick={() => toggle(file.path)}>
              {collapsed.has(file.path) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              <FileTypeIcon name={file.name} size={14} />
              <span className="ps-shell-search-file-name">{file.name}</span>
              <span className="ps-shell-search-file-path">{file.rel}</span>
              <span className="ps-shell-search-file-count">{file.matches.length}</span>
            </button>
            {!collapsed.has(file.path) &&
              file.matches.map((m, i) => (
                <button type="button"
                  key={i}
                  className="ps-shell-search-match"
                  onClick={() => open(file, m)}
                  title={`Linha ${m.line}`}
                >
                  <span className="ps-shell-search-line-no">{m.line}</span>
                  <span className="ps-shell-search-line">{highlight(m.preview.trimStart(), displayedSearch.query, displayedSearch.caseSensitive)}</span>
                </button>
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}
