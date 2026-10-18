import { useEffect, useRef, useState } from 'react'
import { X, FolderOpen, Download, Loader2 } from 'lucide-react'
import type { TraycerImportPreview, TraycerImportResult } from '../../../shared/traycerImport'
import { chatForest } from '../../../shared/traycerImport'
import { useAgentChats } from '../lib/agentChats'

export default function TraycerImportModal({ onClose }: { onClose: () => void }) {
  const [preview, setPreview] = useState<TraycerImportPreview | null>(null)
  const [profileIds, setProfileIds] = useState<string[]>([])
  const [chatIds, setChatIds] = useState<string[]>([])
  const [copyCredentials, setCopyCredentials] = useState(true)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<TraycerImportResult | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)
  const load = async (root?: string): Promise<void> => {
    setBusy(true); setError(''); setResult(null)
    try {
      const data = await window.prism.traycer.preview(root)
      if (alive.current) { setPreview(data); setProfileIds(data.profiles.map((p) => p.id)); setChatIds([]) }
    } catch (err) { if (alive.current) setError((err as Error).message) }
    finally { if (alive.current) setBusy(false) }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    close.current?.focus()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); if (!busy) onClose() }
      if (e.key === 'Tab') {
        const elements = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)') || [])]
        const first = elements[0], last = elements.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('keydown', key, true); previous?.focus() }
  }, [busy, onClose])
  const choose = async (): Promise<void> => {
    try { const root = await window.prism.traycer.chooseRoot(); if (root) await load(root) }
    catch (err) { setError((err as Error).message) }
  }
  const run = async (): Promise<void> => {
    if (!preview || busy) return
    setBusy(true); setError('')
    try {
      const imported = await window.prism.traycer.import({ root: preview.root, profileIds, chatIds, copyCredentials })
      await useAgentChats.getState().refreshImported()
      setResult(imported)
      setChatIds([]); setProfileIds([])
    } catch (err) { setError((err as Error).message) }
    finally { setBusy(false) }
  }
  const toggle = (ids: string[], id: string): string[] => ids.includes(id) ? ids.filter((i) => i !== id) : [...ids, id]
  const visibleChats = preview?.chats.filter((c) => `${c.title} ${c.taskTitle} ${c.epicId}`.toLowerCase().includes(query.toLowerCase())) || []
  return <div className="accounts-overlay" onMouseDown={(e) => { if (!busy && e.target === e.currentTarget) onClose() }}>
    <div className="accounts-dialog traycer-import-dialog" role="dialog" aria-modal="true" aria-labelledby="traycer-import-title" ref={dialog}>
      <header><h2 id="traycer-import-title">Importar do Traycer</h2><button ref={close} disabled={busy} aria-label="Fechar importação" onClick={onClose}><X size={18} /></button></header>
      <p className="accounts-intro">Traga conversas e perfis locais de Claude e Codex. Os dados existentes no Prism são preservados.</p>
      <div className="traycer-import-source"><code>{preview?.root || 'Pasta .traycer deste computador'}</code><button disabled={busy} onClick={() => void choose()}><FolderOpen size={14} /> Escolher pasta</button></div>
      {busy && <p role="status"><Loader2 size={15} className="spin" /> Processando…</p>}
      {error && <p className="account-error" role="alert">{error}</p>}
      {result ? <div className="traycer-import-result" role="status"><strong>Importação concluída</strong><p>{result.chats} chats e {result.profiles} perfis adicionados. {result.credentials} logins do Traycer vinculados. {result.skipped} itens já importados.</p>
        {result.warnings.map((w, i) => <p key={i}>{w}</p>)}<button onClick={onClose}>Ver conversas</button></div> : preview && <>
        <h3>Perfis ({preview.profiles.length})</h3>
        <div className="traycer-import-list">{preview.profiles.map((p) => <label key={p.id}><input type="checkbox" disabled={busy} checked={profileIds.includes(p.id)} onChange={() => setProfileIds(toggle(profileIds, p.id))} />
          <span><strong>{p.name}</strong><small>{p.provider === 'claude' ? 'Claude Code' : 'Codex'} · {p.credentialsAvailable ? 'Login do Traycer disponível' : 'Login necessário no Prism'}</small></span></label>)}
          {!preview.profiles.length && <p>Nenhum perfil adicional encontrado. As contas do terminal já estão disponíveis no Prism.</p>}</div>
        <label className="traycer-copy-logins"><input type="checkbox" disabled={busy} checked={copyCredentials} onChange={(e) => setCopyCredentials(e.target.checked)} /> Usar os logins do Traycer nos perfis selecionados</label>
        <p className="traycer-import-note">O Prism usa o login salvo pelo Traycer, sem copiar: a renovação fica compartilhada entre os dois apps. Para entrar de novo nessas contas, use o Traycer.</p>
        <h3>Conversas ({preview.chats.length})</h3>
        <div className="traycer-import-filter"><input aria-label="Buscar chats do Traycer" placeholder="Buscar conversas…" value={query} disabled={busy} onChange={(e) => setQuery(e.target.value)} />
          <button disabled={busy} onClick={() => setChatIds(visibleChats.map((c) => c.id))}>Selecionar visíveis</button><button disabled={busy} onClick={() => setChatIds([])}>Limpar</button></div>
        <div className="traycer-import-list chats">{[...new Set(visibleChats.map(c=>c.epicId))].map(epic=><section key={epic}><h4>{preview.chats.find(c=>c.epicId===epic)?.taskTitle || epic}</h4>{chatForest(preview.chats.filter(c=>c.epicId===epic).map(c=>({...c,parentChatId:c.parentId}))).filter(({item})=>!query || visibleChats.some(c=>c.id===item.id)).map(({item:c,depth})=><label key={c.id} style={{paddingLeft:12+Math.min(depth,8)*16}}><input type="checkbox" disabled={busy} checked={chatIds.includes(c.id)} onChange={()=>setChatIds(toggle(chatIds,c.id))}/><span><strong>{c.title}</strong><small>{c.unsupportedHarness || (c.provider==='claude'?'Claude Code':'Codex')} · {c.messageCount} mensagens{c.parentId?' · agente filho':''}{c.archived?' · arquivado':''}{c.imported?' · atualizar organização':''}</small></span></label>)}</section>)}{!visibleChats.length&&<p>Nenhuma conversa local encontrada.</p>}</div>
        <p className="traycer-import-note">Cada tarefa fica separada. Ao selecionar um agente filho, seus pais também são incluídos. Chats já importados recebem somente a correção de organização; seu histórico no Prism é preservado.</p>
        <p className="traycer-import-note">Os chats continuam pelo histórico importado. Algumas saídas de ferramentas e anexos não são persistidos pelo Traycer. Escolha a pasta do projeto se ela não existir neste computador.</p>
        {preview.warnings.map((w, i) => <p className="account-error" key={i}>{w}</p>)}
        <footer><span>{chatIds.length} chats · {profileIds.length} perfis selecionados</span><button disabled={busy || (!chatIds.length && !profileIds.length)} onClick={() => void run()}><Download size={14} /> Importar selecionados</button></footer>
      </>}
    </div>
  </div>
}
