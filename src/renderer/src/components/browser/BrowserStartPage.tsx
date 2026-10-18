import { useEffect, useId, useState } from 'react'
import { AppWindow, RadioTower } from 'lucide-react'
import { browserMainBridge, type BrowserLocalServer } from './browserBridge'

const POLL_MS = 5000

type ServersQuery =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly servers: readonly BrowserLocalServer[] }

/**
 * Traycer's BrowserStartPage: what a blank tab shows instead of a page - the
 * servers listening on this computer that were started from Prism (its
 * terminals and agents), one click away. Polls only while it is on screen.
 */
export function BrowserStartPage({ visible, onNavigate }: { visible: boolean; onNavigate: (url: string) => void }) {
  const headingId = useId()
  const [query, setQuery] = useState<ServersQuery>(() => (browserMainBridge() === null ? { kind: 'unavailable' } : { kind: 'pending' }))

  useEffect(() => {
    const bridge = browserMainBridge()
    if (bridge === null || !visible) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = (): void => {
      bridge
        .localServers()
        .then((servers) => { if (!cancelled) setQuery({ kind: 'ready', servers }) })
        .catch(() => { if (!cancelled) setQuery((current) => (current.kind === 'ready' ? current : { kind: 'failed' })) })
        .finally(() => { if (!cancelled) timer = setTimeout(poll, POLL_MS) })
    }
    poll()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [visible])

  const servers = query.kind === 'ready' ? query.servers : []
  return (
    <div className="brw-start" data-testid="browser-start-page">
      <section aria-labelledby={headingId} className="brw-start-section">
        <div className="brw-start-heading">
          <RadioTower aria-hidden />
          <h2 id={headingId}>
            <span className="brw-start-title">Servidores locais</span>
            <span className="brw-start-host">neste computador</span>
          </h2>
        </div>
        {servers.length > 0 ? (
          <ul className="brw-start-list">
            {servers.map((server) => {
              const address = `localhost:${server.port}`
              const url = `http://${address}`
              return (
                <li key={`${server.port}-${server.pid}`}>
                  <button
                    type="button"
                    className="brw-start-server"
                    aria-label={`Abrir ${server.processName} em ${address} (em execução)`}
                    onClick={() => onNavigate(url)}
                  >
                    <span className="brw-start-server-icon"><AppWindow aria-hidden /></span>
                    <span className="brw-start-server-text">
                      <span className="brw-start-server-name">{server.processName}</span>
                      <span className="brw-start-server-address">{address}</span>
                    </span>
                    <span className="brw-start-server-dot" aria-hidden />
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="brw-start-empty" role="status">
            {startPageStatus(query)}
          </div>
        )}
      </section>
    </div>
  )
}

function startPageStatus(query: ServersQuery): string {
  switch (query.kind) {
    case 'unavailable': return 'Atalhos de servidores locais não estão disponíveis neste navegador. Pesquise ou digite um endereço acima.'
    case 'pending': return 'Procurando servidores locais…'
    case 'failed': return 'Não foi possível encontrar servidores locais. Pesquise ou digite um endereço acima.'
    default: return 'Nenhum servidor local detectado. Inicie um em um terminal aqui ou digite uma URL acima.'
  }
}
