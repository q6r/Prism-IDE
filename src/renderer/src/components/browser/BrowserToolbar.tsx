import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import {
  ArrowLeft, ArrowRight, Bug, ChevronDown, ChevronRight, Cookie, EllipsisVertical, ExternalLink, Globe, Info, Lock,
  Minus, Plus, RotateCcw, RotateCw, Search, ShieldAlert, TriangleAlert, X
} from 'lucide-react'
import {
  Button, DropdownMenu, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioItem, DropdownMenuSeparator,
  InputAddon, InputGroup, Kbd, Spinner, Tooltip, cn
} from '../ui'
import { BrowserConfirmDialog } from './BrowserConfirmDialog'
import { browserMainBridge, openExternalUrl, tabHandle } from './browserBridge'
import {
  BROWSER_SEARCH_ENGINE_LABELS, addressDisplayValue, isBlankUrl, isWebOriginUrl, nextZoomPercent,
  normalizeBrowserAddressInput, registrableDomain, securityState, type BrowserSearchEngine, type SecurityState
} from './browserModel'
import { useBrowserStore, type BrowserTab } from './browserStore'
import { useStore } from '../../store'

/**
 * Traycer's BrowserTileToolbar: back / forward / reload-or-stop, the address
 * field (mono, borderless until hovered, "open in default browser" on hover),
 * and the trailing "more" menu with zoom, site information, clear cookies and
 * DevTools. Rendered for the active tab only.
 */
export function BrowserToolbar({ tab }: { tab: BrowserTab }) {
  return (
    <div className="brw-toolbar" data-testid="browser-toolbar">
      <BrowserToolbarNav tab={tab} />
      <BrowserAddress key={tab.id} tab={tab} />
      <BrowserToolbarTrailing tab={tab} />
    </div>
  )
}

function BrowserToolbarNav({ tab }: { tab: BrowserTab }) {
  const handle = tabHandle(tab.id)
  const live = tab.initialSrc !== null && handle !== null
  return (
    <div className="brw-toolbar-nav">
      <Tooltip label={<>Voltar <Kbd>Alt+←</Kbd></>} side="bottom">
        <Button variant="ghost" size="icon-sm" aria-label="Voltar" disabled={!live || !tab.canGoBack} onClick={() => handle?.back()}>
          <ArrowLeft />
        </Button>
      </Tooltip>
      <Tooltip label={<>Avançar <Kbd>Alt+→</Kbd></>} side="bottom">
        <Button variant="ghost" size="icon-sm" aria-label="Avançar" disabled={!live || !tab.canGoForward} onClick={() => handle?.forward()}>
          <ArrowRight />
        </Button>
      </Tooltip>
      {tab.loading && live ? (
        <>
          <Tooltip label="Parar" side="bottom">
            <Button variant="ghost" size="icon-sm" aria-label="Parar" onClick={() => handle?.stop()}>
              <X />
            </Button>
          </Tooltip>
          <span role="status" aria-label="Carregando a página" className="brw-toolbar-spinner">
            <Spinner tone="muted" />
          </span>
        </>
      ) : (
        <Tooltip label={<>Recarregar <Kbd>Ctrl+R</Kbd></>} side="bottom">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Recarregar"
            disabled={!live && tab.status !== 'failed'}
            onClick={(event: MouseEvent) => {
              if (live) handle?.reload(event.shiftKey)
              else useBrowserStore.getState().navigate(tab.id, tab.error?.url ?? tab.url)
            }}
          >
            <RotateCw />
          </Button>
        </Tooltip>
      )}
    </div>
  )
}

interface AddressDraft {
  readonly focused: boolean
  readonly submitted: boolean
  readonly value: string
}

const EMPTY_DRAFT: AddressDraft = { focused: false, submitted: false, value: '' }

/** tab id → the last address-focus request already acted on. */
const handledAddressFocus = new Map<string, number>()

/**
 * Traycer's address-draft policy: the draft is owned by focus (a navigation
 * underneath never rewrites what is being typed), a submitted draft outlives
 * blur but yields to the next navigation, and blur without submitting brings
 * the live address back.
 */
function BrowserAddress({ tab }: { tab: BrowserTab }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useState<AddressDraft>(EMPTY_DRAFT)
  const liveValue = addressDisplayValue(tab.url)
  const [seenUrl, setSeenUrl] = useState(tab.url)
  if (seenUrl !== tab.url) {
    setSeenUrl(tab.url)
    if (draft.submitted) setDraft(EMPTY_DRAFT)
  }
  const value = draft.focused || draft.submitted ? draft.value : liveValue

  // One-shot: a request is honoured once, not again every time the tab is shown.
  useEffect(() => {
    const nonce = tab.addressFocusNonce
    if (nonce === 0 || handledAddressFocus.get(tab.id) === nonce) return
    handledAddressFocus.set(tab.id, nonce)
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
  }, [tab.addressFocusNonce, tab.id])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const store = useBrowserStore.getState()
    const target = normalizeBrowserAddressInput(value, store.searchEngine)
    setDraft({ focused: false, submitted: true, value: addressDisplayValue(target) })
    store.navigate(tab.id, target)
    if (!isBlankUrl(target)) {
      inputRef.current?.blur()
      // The reader moves on to the page, as in any browser.
      requestAnimationFrame(() => tabHandle(tab.id)?.focusPage())
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    if (draft.value !== liveValue && draft.focused) {
      setDraft({ focused: true, submitted: false, value: liveValue })
      requestAnimationFrame(() => inputRef.current?.select())
      return
    }
    inputRef.current?.blur()
    tabHandle(tab.id)?.focusPage()
  }

  const canOpenExternally = isWebOriginUrl(tab.url)
  return (
    <form className="brw-address-form" onSubmit={submit}>
      <InputGroup className="brw-address">
        <InputAddon align="start" className="brw-address-start">
          <BrowserSecurityIndicator tab={tab} />
        </InputAddon>
        <input
          ref={inputRef}
          aria-label="Endereço do navegador"
          placeholder="Pesquise ou digite um endereço"
          value={value}
          spellCheck={false}
          autoComplete="off"
          className="brw-address-input"
          data-testid="browser-address"
          onChange={(event) => setDraft({ focused: true, submitted: false, value: event.target.value })}
          onMouseDown={(event) => {
            // First click selects the whole address, like every browser.
            if (event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus()
            }
          }}
          onFocus={(event) => {
            setDraft((current) => (current.focused ? current : { focused: true, submitted: false, value: liveValue }))
            const input = event.currentTarget
            requestAnimationFrame(() => input.select())
          }}
          onBlur={() => setDraft((current) => (current.submitted ? { ...current, focused: false } : EMPTY_DRAFT))}
          onKeyDown={onKeyDown}
        />
        {canOpenExternally ? (
          <InputAddon align="end" className="brw-address-end">
            <Tooltip label="Abrir no navegador padrão" side="top">
              <Button
                variant="muted"
                size="icon-xs"
                aria-label="Abrir no navegador padrão"
                className="brw-open-external"
                onClick={() => openExternalUrl(tab.url)}
              >
                <ExternalLink aria-hidden />
              </Button>
            </Tooltip>
          </InputAddon>
        ) : null}
      </InputGroup>
    </form>
  )
}

const SECURITY_COPY: Record<Exclude<SecurityState, 'blank'>, { readonly label: string; readonly detail: string }> = {
  secure: { label: 'Conexão segura', detail: 'As informações enviadas a este site são criptografadas (HTTPS).' },
  local: { label: 'Servidor local', detail: 'Servido por um servidor neste computador. A conexão não sai da máquina.' },
  insecure: { label: 'Não seguro', detail: 'Este site não usa uma conexão segura. Não envie senhas nem dados pessoais.' },
  certificate: { label: 'Certificado não confiável', detail: 'Você optou por prosseguir apesar de um aviso de certificado para esta origem.' },
  other: { label: 'Página local', detail: 'Não carregada de um endereço da web (por exemplo, uma aba em branco ou uma página interna).' }
}

function SecurityIcon({ state }: { state: SecurityState }) {
  switch (state) {
    case 'secure': return <Lock aria-hidden />
    case 'local': return <Info aria-hidden />
    case 'insecure': return <TriangleAlert aria-hidden />
    case 'certificate': return <ShieldAlert aria-hidden />
    case 'other': return <Globe aria-hidden />
    default: return <Search aria-hidden />
  }
}

function BrowserSecurityIndicator({ tab }: { tab: BrowserTab }) {
  const trusted = useBrowserStore((s) => s.trustedCertificateOrigins)
  const state = securityState(tab.url, trusted)
  if (state === 'blank') return <span className="brw-security blank" aria-hidden><Search /></span>
  const copy = SECURITY_COPY[state]
  const web = isWebOriginUrl(tab.url)
  return (
    <DropdownMenu
      align="start"
      side="bottom"
      sideOffset={6}
      className="brw-site-info-menu"
      label="Informações do site"
      trigger={
        <button type="button" className={cn('brw-security', state)} aria-label={`Informações do site: ${copy.label}`} data-testid="browser-security">
          <SecurityIcon state={state} />
        </button>
      }
    >
      <div className="brw-site-info">
        <div className="brw-site-info-host">{web ? new URL(tab.url).host : 'Página interna'}</div>
        <BrowserSiteInfoRow icon={<SecurityIcon state={state} />} tone={state} title={copy.label} detail={copy.detail} />
        <BrowserSiteInfoRow
          icon={<Globe aria-hidden />}
          tone="other"
          title={web ? 'Página da web' : 'Página local'}
          detail={web ? 'Servida pela rede a partir da origem desta página.' : SECURITY_COPY.other.detail}
        />
      </div>
    </DropdownMenu>
  )
}

function BrowserSiteInfoRow(props: { icon: ReactNode; tone: string; title: string; detail: string }) {
  return (
    <div className="brw-site-info-row">
      <span className={cn('brw-site-info-icon', props.tone)}>{props.icon}</span>
      <div className="brw-site-info-text">
        <div className="brw-site-info-title">{props.title}</div>
        <div className="brw-site-info-detail">{props.detail}</div>
      </div>
    </div>
  )
}

function BrowserToolbarTrailing({ tab }: { tab: BrowserTab }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  const bridge = browserMainBridge()
  const site = isWebOriginUrl(tab.url) ? registrableDomain(tab.url) : null
  const clear = async (): Promise<void> => {
    if (!bridge) return
    setClearing(true)
    try {
      const result = await bridge.clearSiteCookies(tab.url)
      useStore.getState().addToast('success', result.removed > 0 ? `Cookies de ${result.site ?? site} limpos` : `Nenhum cookie de ${result.site ?? site} para limpar`)
      tabHandle(tab.id)?.reload(false)
    } catch {
      useStore.getState().addToast('error', 'Não foi possível limpar os cookies. Tente novamente.')
    } finally {
      setClearing(false)
      setConfirmOpen(false)
    }
  }
  return (
    <div className="brw-toolbar-trailing">
      <BrowserMoreMenu
        tab={tab}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        clearSite={bridge === null ? null : { site }}
        onRequestClearSite={() => setConfirmOpen(true)}
      />
      {site === null ? null : (
        <BrowserConfirmDialog
          open={confirmOpen}
          pending={clearing}
          onOpenChange={setConfirmOpen}
          title={`Limpar cookies de ${site}?`}
          description={`Você sairá da sua conta em ${site} no navegador do Prism. Outros sites não são afetados.`}
          actionLabel="Limpar cookies"
          onConfirm={() => void clear()}
        />
      )}
    </div>
  )
}

function BrowserMoreMenu(props: {
  tab: BrowserTab
  open: boolean
  onOpenChange: (open: boolean) => void
  clearSite: { site: string | null } | null
  onRequestClearSite: () => void
}) {
  const { tab, clearSite } = props
  const [siteInfoOpen, setSiteInfoOpen] = useState(false)
  const searchEngine = useBrowserStore((s) => s.searchEngine)
  const setSearchEngine = useBrowserStore((s) => s.setSearchEngine)
  const handle = tabHandle(tab.id)
  const live = tab.initialSrc !== null && handle !== null && !isBlankUrl(tab.url)
  const web = isWebOriginUrl(tab.url)
  const setZoom = (percent: number): void => {
    useBrowserStore.getState().patch(tab.id, { zoomPercent: percent })
    handle?.setZoom(percent)
  }
  return (
    <DropdownMenu
      open={props.open}
      onOpenChange={(open) => { props.onOpenChange(open); if (!open) setSiteInfoOpen(false) }}
      align="end"
      side="bottom"
      className="brw-more-menu"
      label="Mais controles do navegador"
      trigger={
        <Button variant="muted" size="icon-sm" aria-label="Mais controles do navegador" data-testid="browser-more">
          <EllipsisVertical aria-hidden />
        </Button>
      }
    >
      <div className="brw-zoom" role="group" aria-label={`Controles de zoom, zoom atual ${tab.zoomPercent}%`}>
        <span className="brw-zoom-label">Zoom</span>
        <DropdownMenuItem aria-label="Diminuir zoom" className="brw-zoom-btn" disabled={!live} onSelect={(event) => { event.preventDefault(); setZoom(nextZoomPercent(tab.zoomPercent, -1)) }}>
          <Minus aria-hidden />
        </DropdownMenuItem>
        <span className="brw-zoom-value" aria-live="polite" aria-atomic="true">{tab.zoomPercent}%</span>
        <DropdownMenuItem aria-label="Aumentar zoom" className="brw-zoom-btn" disabled={!live} onSelect={(event) => { event.preventDefault(); setZoom(nextZoomPercent(tab.zoomPercent, 1)) }}>
          <Plus aria-hidden />
        </DropdownMenuItem>
        <DropdownMenuItem aria-label="Redefinir zoom" variant="muted" className="brw-zoom-btn reset" disabled={!live || tab.zoomPercent === 100} onSelect={(event) => { event.preventDefault(); setZoom(100) }}>
          <RotateCcw aria-hidden />
        </DropdownMenuItem>
      </div>
      <DropdownMenuItem
        aria-expanded={siteInfoOpen}
        className="brw-site-info-trigger"
        onSelect={(event) => { event.preventDefault(); setSiteInfoOpen((open) => !open) }}
      >
        <span className="tr-truncate">Informações do site</span>
        <span className="brw-site-info-summary">{web ? 'Página da web' : 'Página local'}</span>
        {siteInfoOpen ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
      </DropdownMenuItem>
      {siteInfoOpen ? (
        <div className="brw-site-info inline">
          <BrowserSiteInfoRow
            icon={<Globe aria-hidden />}
            tone="other"
            title={web ? 'Página da web' : 'Página local'}
            detail={web ? 'Servida pela rede a partir da origem desta página.' : SECURITY_COPY.other.detail}
          />
        </div>
      ) : null}
      {clearSite === null ? null : (
        <DropdownMenuItem disabled={clearSite.site === null} onSelect={props.onRequestClearSite}>
          <Cookie aria-hidden />
          <span className="tr-truncate">{clearSite.site === null ? 'Limpar cookies deste site' : `Limpar cookies de ${clearSite.site}`}</span>
        </DropdownMenuItem>
      )}
      <DropdownMenuLabel className="brw-menu-label">Pesquisar com</DropdownMenuLabel>
      {(Object.keys(BROWSER_SEARCH_ENGINE_LABELS) as BrowserSearchEngine[]).map((engine) => (
        <DropdownMenuRadioItem key={engine} checked={engine === searchEngine} onSelect={(event) => { event.preventDefault(); setSearchEngine(engine) }}>
          {BROWSER_SEARCH_ENGINE_LABELS[engine]}
        </DropdownMenuRadioItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="brw-menu-label">Desenvolvedor</DropdownMenuLabel>
      <DropdownMenuItem aria-label="Abrir DevTools do navegador" disabled={!live} onSelect={() => handle?.toggleDevTools()}>
        <Bug aria-hidden />
        <span className="tr-truncate">Abrir DevTools</span>
        <span className="tr-menu-shortcut">F12</span>
      </DropdownMenuItem>
    </DropdownMenu>
  )
}
