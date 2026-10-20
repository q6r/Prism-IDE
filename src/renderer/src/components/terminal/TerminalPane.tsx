import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Button, Spinner } from '../ui'
import { useStore } from '../../store'
import { canFitTerminal, terminalTitle } from './model'
import { readTerminalAppearance } from './theme'
import { createTerminalInputBuffer } from './startup-input'

export interface PaneApi {
  input: (data: string) => boolean
  clear: () => void
  focus: () => void
  getSelection: () => string
  paste: (text: string) => void
}

interface Props {
  paneId: string
  remoteId: string | null
  /** A host terminal that is already running (adopted by a reopened window). */
  attachTo?: string
  active: boolean
  visible: boolean
  onFocus: () => void
  onClose: () => void
  onTitle: (title: string) => void
  onContextMenu: (paneId: string, x: number, y: number) => void
  registerApi: (api: PaneApi | null) => void
}

export default function TerminalPane(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<(() => void) | null>(null)
  const startupInputRef = useRef<ReturnType<typeof createTerminalInputBuffer> | null>(null)
  if (!startupInputRef.current) startupInputRef.current = createTerminalInputBuffer()
  const latest = useRef(props)
  latest.current = props
  const folderPath = useStore((s) => s.folderPath)
  const fontSize = useStore((s) => s.settings.fontSize)
  const [attempt, setAttempt] = useState(0)
  // 'lost': the host no longer has this terminal (it restarted).
  const [status, setStatus] = useState<'starting' | 'ready' | 'failed' | 'lost'>('starting')

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const { paneId, remoteId, attachTo } = latest.current
    // An adopted terminal is shown as is; "Reconectar" starts a new one.
    const adopting = !remoteId && attempt === 0 && !!attachTo
    const localTermId = adopting && attachTo ? attachTo : `${paneId}:${attempt}`
    const startupInput = startupInputRef.current!
    let disposed = false
    let ready = false
    let remoteTermId = ''
    // SSH can send its prompt before createTerm's IPC reply gives us its ID.
    const earlyRemoteData = new Map<string, string>()
    const earlyRemoteExits = new Set<string>()
    let earlyBytes = 0
    let resizeFrame = 0
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    setStatus('starting')
    const appearance = readTerminalAppearance(host)
    const term = new Terminal({
      ...appearance, fontSize: useStore.getState().settings.fontSize,
      cursorBlink: true, cursorStyle: 'block', cursorInactiveStyle: 'outline',
      allowProposedApi: true, scrollback: 5000, lineHeight: 1, letterSpacing: 0
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    termRef.current = term
    const fitNow = (): void => {
      if (disposed || !canFitTerminal(host.clientWidth, host.clientHeight)) return
      try {
        fit.fit()
        if (!ready) return
        if (remoteId) window.prism.ssh.termResize({ id: remoteId, termId: remoteTermId, cols: term.cols, rows: term.rows })
        else window.prism.terminal.resize({ id: localTermId, cols: term.cols, rows: term.rows })
      } catch { /* The host can detach during panel resize. */ }
    }
    const scheduleFit = (): void => {
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(fitNow)
    }
    fitRef.current = scheduleFit
    fitNow()
    const sendInput = (data: string): void => {
      if (remoteId) window.prism.ssh.termInput({ id: remoteId, termId: remoteTermId, data })
      else window.prism.terminal.input({ id: localTermId, data })
    }
    const input = (data: string): boolean => {
      if (disposed) return false
      startupInput.write(data, ready ? sendInput : undefined)
      return true
    }
    const copy = (): void => {
      const selection = term.getSelection()
      if (selection) void navigator.clipboard.writeText(selection).catch(() => {})
    }
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      // Keep Ctrl+C available to the foreground process, even with selected
      // output. Copy has its own Ctrl+Shift+C shortcut in the terminal menu.
      if (mod && key === 'c' && event.shiftKey) { copy(); return false }
      if (mod && event.shiftKey && key === 'v') {
        void navigator.clipboard.readText().then((text) => { if (!disposed && text) term.paste(text) }).catch(() => {})
        return false
      }
      return true
    })
    const inputSub = term.onData(input)
    const titleSub = term.onTitleChange((title) => {
      const name = terminalTitle(title)
      if (name) latest.current.onTitle(name)
    })
    const markReady = (): void => {
      if (disposed || ready) return
      clearTimeout(startupTimer)
      ready = true
      startupInput.flush(sendInput)
      setStatus('ready')
      scheduleFit()
      if (latest.current.active && latest.current.visible) term.focus()
    }
    const stop = (reason: 'failed' | 'lost'): void => {
      if (disposed) return
      ready = false
      clearTimeout(startupTimer)
      setStatus(reason)
    }
    const fail = (): void => stop('failed')
    // The host answers once the shell is up (and queues keystrokes until
    // then); the IPC side is confirmed by the first output instead.
    const confirm = (result: { ok: boolean; persistent?: boolean }): void => {
      if (disposed) return
      if (!result.ok) fail()
      else if (result.persistent !== false) markReady()
    }
    // Subscribe before spawning so an initial prompt or an immediate exit is retained.
    const offData = remoteId
      ? window.prism.ssh.onTermData(({ termId, data }) => {
        if (disposed) return
        if (termId === remoteTermId) term.write(data)
        else if (!remoteTermId && earlyBytes + data.length <= 131072) {
          earlyRemoteData.set(termId, (earlyRemoteData.get(termId) ?? '') + data)
          earlyBytes += data.length
        }
      })
      : window.prism.terminal.onData(({ id, data }) => { if (!disposed && id === localTermId) { markReady(); term.write(data) } })
    const offExit = remoteId
      ? window.prism.ssh.onTermExit(({ termId }) => {
        if (disposed) return
        if (termId === remoteTermId) latest.current.onClose()
        else if (!remoteTermId) earlyRemoteExits.add(termId)
      })
      : window.prism.terminal.onExit(({ id, lost }) => {
        if (disposed || id !== localTermId) return
        if (lost) stop('lost')
        else latest.current.onClose()
      })
    latest.current.registerApi({ input, clear: () => term.clear(), focus: () => term.focus(),
      getSelection: () => term.getSelection(), paste: (text) => { if (!disposed) term.paste(text) } })
    if (remoteId) {
      startupTimer = setTimeout(fail, 15000)
      void window.prism.ssh.createTerm({ id: remoteId, cols: term.cols, rows: term.rows }).then((result) => {
        if (disposed) {
          if (result.ok && result.termId) window.prism.ssh.termKill({ id: remoteId, termId: result.termId })
          return
        }
        if (!result.ok || !result.termId) { fail(); return }
        remoteTermId = result.termId
        const earlyOutput = earlyRemoteData.get(remoteTermId)
        if (earlyOutput) term.write(earlyOutput)
        earlyRemoteData.clear()
        if (earlyRemoteExits.has(remoteTermId)) { latest.current.onClose(); return }
        earlyRemoteExits.clear()
        markReady()
      }).catch(fail)
    } else {
      startupTimer = setTimeout(fail, 15000)
      // Adopting replays what the terminal kept through onData, then goes live.
      const started = adopting
        ? window.prism.terminal.attach(localTermId)
        : window.prism.terminal.create({ id: localTermId, cols: term.cols, rows: term.rows, cwd: folderPath ?? undefined })
      void started.then(confirm).catch(fail)
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(host)
    const themeObserver = new MutationObserver(() => {
      if (disposed) return
      const appearance = readTerminalAppearance(host)
      term.options.theme = appearance.theme
      term.options.fontFamily = appearance.fontFamily
      scheduleFit()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-appearance', 'class', 'style'] })
    void document.fonts.ready.then(() => { if (!disposed) scheduleFit() })
    if (latest.current.active && latest.current.visible) term.focus()
    return () => {
      disposed = true
      ready = false
      clearTimeout(startupTimer)
      cancelAnimationFrame(resizeFrame)
      observer.disconnect()
      themeObserver.disconnect()
      inputSub.dispose()
      titleSub.dispose()
      offData()
      offExit()
      latest.current.registerApi(null)
      if (remoteId) { if (remoteTermId) window.prism.ssh.termKill({ id: remoteId, termId: remoteTermId }) }
      else window.prism.terminal.kill(localTermId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // A pane keeps the working directory and transport it was created with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  useEffect(() => {
    if (!termRef.current) return
    termRef.current.options.fontSize = fontSize
    fitRef.current?.()
  }, [fontSize])
  useEffect(() => {
    if (!props.visible) return
    fitRef.current?.()
    if (props.active && (status === 'starting' || status === 'ready')) termRef.current?.focus()
  }, [props.active, props.visible, status])

  return <div className="prism-terminal-pane" onMouseDown={props.onFocus}
    onContextMenu={(event) => { event.preventDefault(); props.onFocus(); props.onContextMenu(props.paneId, event.clientX, event.clientY) }}>
    <div className="prism-terminal-xterm" ref={hostRef} />
    {status !== 'ready' && <div className="prism-terminal-overlay" role={status === 'starting' ? 'status' : 'alert'} aria-busy={status === 'starting'}>
      {status === 'starting' ? <><span>Iniciando terminal</span><Spinner /></> : <div className="prism-terminal-error">
        <p>{status === 'lost' ? 'Este terminal não existe mais no host do Prism.' : 'Não foi possível conectar ao terminal.'}</p>
        <Button variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>{status === 'lost' ? 'Abrir novo terminal' : 'Reconectar'}</Button>
      </div>}
    </div>}
  </div>
}
