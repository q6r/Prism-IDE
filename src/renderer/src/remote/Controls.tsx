import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ChevronDown, FilePen, ImageIcon, Play, Trash2, X } from 'lucide-react'
import type { AgentModel, AgentSelection } from '../../../shared/agents'
import type { RemoteImageIpc, RemoteQueuedMessageIpc } from '../../../preload'
export type Request = (action: string, payload?: Record<string, unknown>) => Promise<any>
export const RemoteContext = createContext<{ request: Request; command: (action: string, payload?: Record<string, unknown>) => void }>({ request: async () => { throw new Error('Sem conexão') }, command: () => {} })

export function RemoteImage({ src, asset, alt = 'Imagem da conversa' }: { src?: string; asset?: RemoteImageIpc['ref']; alt?: string }) {
  const { request } = useContext(RemoteContext)
  const direct = src && /^(https?:|data:image\/(png|jpeg|gif|webp);base64,)/i.test(src) ? src : undefined
  const [url, setUrl] = useState<string | undefined>(direct)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    let alive = true; setUrl(direct); setError('')
    if ((src || asset) && !direct) {
      const path = src ? decodeURIComponent(src.replace(/^file:\/\//i, '').replace(/^\/(?:([A-Za-z]:))/, '$1')) : ''
      void request('image', asset ? { ...asset } : { path }).then(data => { if (alive) setUrl(data.url) }, e => { if (alive) setError(e.message) })
    }
    return () => { alive = false }
  }, [src, asset?.turnId, asset?.toolId, asset?.queueId, asset?.index, request])
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  return <span className="rm-image-wrap">{url ? <button type="button" className="rm-image" onClick={() => setOpen(true)} aria-label={`Ampliar ${alt}`}><img src={url} alt={alt} loading="lazy" onError={() => setError('Imagem indisponível')} /></button> : <span role="status"><ImageIcon size={16} /> {error || 'Carregando imagem…'}</span>}
    <dialog ref={dialog} className="rm-image-dialog" aria-label={alt} onCancel={() => setOpen(false)} onClick={e => { if (e.target === e.currentTarget) setOpen(false) }}><button type="button" className="rm-icon" aria-label="Fechar imagem" onClick={() => setOpen(false)}><X size={20} /></button><img src={url} alt={alt} /></dialog></span>
}
export function Images({ images }: { images?: RemoteImageIpc[] }) {
  return images?.length ? <div className="rm-images">{images.map((image, index) => <span className="rm-numbered-image" key={index}>
    <RemoteImage asset={image.ref} src={image.data ? `data:${image.mime};base64,${image.data}` : undefined} alt={image.name || `#image ${image.number ?? index + 1}`} />
    {image.number ? <span className="ch-image-number">#image {image.number}</span> : null}
  </span>)}</div> : null
}
const MODES = [['default', 'Supervisionado'], ['plan', 'Planejar'], ['acceptEdits', 'Aceitar edições'], ['bypassPermissions', 'Acesso total']]
export function Controls({ selection, busy, disabled }: { selection?: AgentSelection; busy: boolean; disabled: boolean }) {
  const { request, command } = useContext(RemoteContext)
  const [models, setModels] = useState<AgentModel[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open || !selection) return
    let alive = true; setLoading(true); setError('')
    void request('models').then(data => { if (alive) setModels(Array.isArray(data) ? data : []) }, e => { if (alive) setError(e.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, selection?.provider, selection?.profileId, request])
  if (!selection) return null
  const update = (patch: Partial<AgentSelection>): void => command('configure', { selection: patch })
  const model = models.find(m => m.id === selection.model) ?? models.find(m => m.default)
  return <details className="rm-controls" onToggle={e => setOpen(e.currentTarget.open)}><summary><span>{model?.label || selection.model || selection.provider}</span><span>{MODES.find(([mode]) => mode === selection.permissionMode)?.[1]}</span><ChevronDown size={16} /></summary><div className="rm-controls-fields">
    {busy ? <p>{selection.provider === 'codex' ? 'Modelo e modo escolhidos valem para o próximo turno e a fila.' : 'Modelo e permissões podem mudar durante a execução. Esforço e Fast valem para o próximo turno.'}</p> : null}
    <label>Modelo<select disabled={disabled || loading} value={selection.model} onChange={e => update({ model: e.target.value, effort: (models.find(m => m.id === e.target.value)?.defaultEffort || selection.effort) as AgentSelection['effort'] })}><option value="">Padrão do agente</option>{selection.model && !models.some(m => m.id === selection.model) ? <option value={selection.model}>{selection.model}</option> : null}{models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
    {loading ? <span role="status">Carregando modelos…</span> : error ? <p role="alert">{error}</p> : null}
    <label>Modo de uso<select disabled={disabled} value={selection.permissionMode} onChange={e => update({ permissionMode: e.target.value as AgentSelection['permissionMode'] })}>{MODES.map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}</select></label>
    {model?.efforts?.length ? <label>Esforço<select disabled={disabled} value={selection.effort} onChange={e => update({ effort: e.target.value as AgentSelection['effort'] })}>{model.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label> : null}
    {model?.fast ? <label className="rm-fast"><input type="checkbox" disabled={disabled} checked={selection.serviceTier === model.fast.id} onChange={e => update({ serviceTier: e.target.checked ? model.fast!.id : '' })} />{model.fast.label}</label> : null}
    <p>{selection.permissionMode === 'acceptEdits' ? 'Edições na pasta de trabalho passam direto; ações que pedirem acesso extra continuam aguardando aprovação.' : selection.permissionMode === 'bypassPermissions' ? 'Acesso total: ações passam sem pedir aprovação.' : selection.permissionMode === 'plan' ? 'Planeja sem alterar arquivos.' : 'Ações que precisam de permissão aguardam sua aprovação.'}</p>
  </div></details>
}
export function Queue({ rows = [], paused, disabled }: { rows?: RemoteQueuedMessageIpc[]; paused?: boolean; disabled: boolean }) {
  const { command } = useContext(RemoteContext)
  const [editing, setEditing] = useState<string>()
  const [text, setText] = useState('')
  if (!rows.length) return null
  return <section className="rm-queue" aria-label="Mensagens na fila"><header><strong>Fila · {rows.length}</strong><button type="button" disabled={disabled} onClick={() => command('queue', { operation: 'pause', paused: !paused })}>{paused ? 'Retomar' : 'Pausar'}</button></header>{rows.map(row => <div className="rm-queue-item" key={row.id}>{editing === row.id ? <><textarea aria-label="Editar mensagem na fila" value={text} onChange={e => setText(e.target.value)} /><div className="rm-actions"><button type="button" disabled={disabled || !text.trim()} onClick={() => { command('queue', { operation: 'replace', id: row.id, message: { text, context: row.context } }); setEditing(undefined) }}>Salvar</button><button type="button" onClick={() => setEditing(undefined)}>Cancelar</button></div></> : <><p>{row.text}</p><Images images={row.images} /><div className="rm-queue-actions"><button type="button" disabled={disabled} aria-label="Enviar mensagem da fila agora" onClick={() => command('queue', { operation: 'send', id: row.id })}><Play size={14} />Enviar agora</button><button type="button" disabled={disabled} onClick={() => { if (!paused) command('queue', { operation: 'pause', paused: true }); setEditing(row.id); setText(row.text) }}>Editar</button><button type="button" disabled={disabled} aria-label="Remover mensagem da fila" onClick={() => command('queue', { operation: 'remove', id: row.id })}><Trash2 size={16} /></button></div></>}</div>)}</section>
}
export function Files({ revision }: { revision: unknown }) {
  const { request } = useContext(RemoteContext)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<any[]>([])
  const [file, setFile] = useState<any>()
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!open) return
    let alive = true
    void request('changes').then(data => { if (alive) { setRows(data); setError('') } }, e => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [open, revision, request])
  const show = (path: string): void => {
    setLoading(true); setError(''); setFile(undefined)
    void request('file', { path }).then(setFile, e => setError(e.message)).finally(() => setLoading(false))
  }
  return <details className="rm-files" onToggle={e => setOpen(e.currentTarget.open)}><summary><FilePen size={16} />Arquivos alterados<ChevronDown size={16} /></summary><div>{rows.map(row => <button type="button" key={row.path} onClick={() => show(row.path)}>{row.path}</button>)}{!rows.length && !error ? <p>Nenhum arquivo alterado nesta conversa.</p> : null}{loading ? <p role="status">Abrindo arquivo completo…</p> : null}{error ? <p role="alert">{error}</p> : null}{file ? <section><h3>{file.path}</h3>{file.diff ? <details open><summary>Alterações completas</summary><pre>{file.diff}</pre></details> : <details open><summary>Alteração registrada pela ferramenta</summary><pre>{JSON.stringify(file.tool, null, 2)}</pre></details>}{file.content != null ? <details><summary>Arquivo completo</summary><pre>{file.content}</pre></details> : <p>Arquivo removido ou indisponível no disco; o registro da alteração está acima.</p>}</section> : null}</div></details>
}
