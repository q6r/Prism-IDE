import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ImageOff, X } from 'lucide-react'
import { loadChatImage, resolveChatImageSource } from '../../../../shared/chatImageSource'

export interface ChatImageRoute { cwd?: string; remoteId?: string; remoteReady?: boolean }

/** Desktop Markdown preview: local bytes use IPC, rather than an unsafe file:// page load. */
export function ChatImage({ src, alt = 'Imagem da conversa', route }: { src?: string; alt?: string; route: ChatImageRoute }) {
  const source = useMemo(() => resolveChatImageSource(src, route.cwd), [src, route.cwd])
  const [result, setResult] = useState<{ key: unknown; url?: string; error?: string }>({ key: null })
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const key = useMemo(() => ({}), [source, route.remoteId, route.remoteReady, attempt])
  const url = result.key === key ? result.url : undefined
  const error = result.key === key ? result.error : undefined
  useEffect(() => {
    let alive = true
    setOpen(false)
    const read = async (path: string): Promise<string> => {
      if (!route.remoteId) return window.prism.fs.readFileBytes(path)
      if (!route.remoteReady) throw new Error('Reconecte o servidor desta conversa para abrir a imagem.')
      return window.prism.ssh.fs.readFileBytes(route.remoteId, path)
    }
    const ready = source.kind === 'file' && route.remoteId && !route.remoteReady
      ? Promise.reject(new Error('Reconecte o servidor desta conversa para abrir a imagem.'))
      : loadChatImage(source, read)
    void ready.then(url => { if (alive) setResult({ key, url }) }, error => {
      if (alive) setResult({ key, error: error instanceof Error ? error.message : 'Não foi possível carregar a imagem.' })
    })
    return () => { alive = false }
  }, [key])
  useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])
  return <span className="ch-markdown-image">
    {url && !error ? <button type="button" className="ch-markdown-image-button" onClick={() => setOpen(true)} aria-label={`Ampliar ${alt}`}>
      <img src={url} alt={alt} loading="lazy" onError={() => setResult({ key, error: 'Não foi possível exibir a imagem. O arquivo pode ter sido removido ou estar danificado.' })} />
    </button> : <span className="ch-markdown-image-status" role="status"><ImageOff size={16} aria-hidden /><span>{error ? `${alt}: ${error}` : `Carregando ${alt}…`}</span>
      {error ? <button type="button" onClick={() => setAttempt(value => value + 1)}>Tentar novamente</button> : null}
    </span>}
    {open && url && !error ? createPortal(<dialog ref={dialog} className="ch-image-preview" aria-label={alt} onCancel={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false) }}>
      <button type="button" autoFocus aria-label="Fechar imagem" onClick={() => setOpen(false)}><X size={16} />Fechar imagem</button>
      <img src={url} alt={alt} />
    </dialog>, document.body) : null}
  </span>
}
