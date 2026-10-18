import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { useStore } from '../store'
import { fsApi } from '../lib/fsApi'
import { FileTypeIcon } from '../lib/fileIcon'
import { basename } from '../lib/lang'
import { InputAddon, InputGroup, Spinner } from './ui'
import Dialog from './shell/Dialog'
import { fuzzyScore } from './shell/logic'
import '../styles/shell.css'

interface FileItem { path: string; rel: string }

export default function QuickOpen() {
  const folderPath = useStore((s) => s.folderPath)
  const remoteId = useStore((s) => s.remote?.id)
  const openFile = useStore((s) => s.openFile)
  const [files, setFiles] = useState<FileItem[]>([])
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    setFiles([]); setIndex(0)
    if (!folderPath) { setLoading(false); return }
    let alive = true
    setLoading(true)
    fsApi.listFiles(folderPath).then((items) => { if (alive) setFiles(items) }).catch((err: Error) => { if (alive) useStore.getState().addToast('error', `Não foi possível buscar arquivos: ${err.message}`) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [folderPath, remoteId])
  const results = useMemo(() => {
    const q = query.toLowerCase().trim()
    return files.map((item) => {
      const base = fuzzyScore(q, basename(item.rel))
      return { item, score: Math.max(base >= 0 ? base + 6 : -1, fuzzyScore(q, item.rel)) }
    }).filter((item) => item.score >= 0).sort((a, b) => b.score - a.score || a.item.rel.length - b.item.rel.length).slice(0, 80).map((item) => item.item)
  }, [files, query])
  const selected = Math.min(index, Math.max(0, results.length - 1))
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const close = (): void => { if (useStore.getState().quickOpenOpen) useStore.getState().toggleQuickOpen() }
  const execute = (item: FileItem | undefined): void => { if (item) { close(); void openFile(item.path) } }
  return <Dialog title="Buscar arquivo" hideHeader className="ps-shell-command-dialog" onClose={close}>
    <div className="ps-shell-command"><div className="ps-shell-command-input-wrap"><InputGroup variant="search"><InputAddon><Search size={16} /></InputAddon><input role="combobox" aria-label="Buscar arquivo por nome" aria-expanded="true" aria-controls="ps-shell-file-list" aria-activedescendant={results[selected] ? `ps-shell-file-${selected}` : undefined}
      placeholder={folderPath ? 'Buscar arquivo por nome…' : 'Abra uma pasta primeiro (Ctrl+O)'} value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0) }} onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => Math.min(i + 1, Math.max(0, results.length - 1))) }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
        else if (event.key === 'Enter') { event.preventDefault(); execute(results[selected]) }
      }} /></InputGroup></div>
      <div className="ps-shell-command-list" id="ps-shell-file-list" ref={list} role="listbox" aria-label="Arquivos">
        {loading && <div className="ps-shell-command-empty" role="status"><Spinner />Indexando arquivos…</div>}
        {!loading && results.map((item, i) => <button type="button" tabIndex={-1} role="option" aria-selected={selected === i} id={`ps-shell-file-${i}`} key={item.path} className="ps-shell-command-item" onPointerMove={() => setIndex(i)} onClick={() => execute(item)}><FileTypeIcon name={item.rel} size={16} /><span className="ps-shell-file-name">{basename(item.rel)}</span><span className="ps-shell-file-path">{item.rel}</span></button>)}
        {!loading && !results.length && <div className="ps-shell-command-empty" role="status">{folderPath ? 'Nenhum arquivo encontrado.' : 'Nenhuma pasta aberta.'}</div>}
      </div>
    </div>
  </Dialog>
}
