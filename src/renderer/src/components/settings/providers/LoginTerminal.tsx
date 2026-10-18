import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ProviderProfile } from '../../../../../shared/agents'

function themeColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/**
 * The provider CLI's own login, run in an isolated terminal for one profile
 * (moved from AccountsModal). Every event is matched by this mount's session
 * id, so a previous login's late exit never ends this one; the pty follows the
 * terminal's size; unmounting cancels a login still in flight. A login that
 * cannot start at all reports `onExit(undefined)`.
 */
export function LoginTerminal({ profile, onExit, autoFocus }: { profile: ProviderProfile; onExit: (code: number | undefined) => void; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const exit = useRef(onExit)
  exit.current = onExit
  useEffect(() => {
    const session = crypto.randomUUID()
    let ended = false
    const end = (code: number | undefined): void => { if (!ended) { ended = true; exit.current(code) } }
    const terminal = new Terminal({
      fontSize: 12, convertEol: true,
      fontFamily: themeColor('--tr-font-mono', 'Consolas, monospace'),
      theme: { background: themeColor('--bg-editor', '#181818'), foreground: themeColor('--text', '#e4e4e4') }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current!)
    try { fit.fit() } catch { /* Not laid out yet. */ }
    if (autoFocus) terminal.focus()
    const input = terminal.onData((text) => window.prism.providers.loginInput(profile.id, text))
    const resize = terminal.onResize(({ cols, rows }) => window.prism.providers.loginResize(profile.id, { cols, rows }))
    const off = window.prism.providers.onLogin((event) => {
      if (event.profileId !== profile.id || event.session !== session) return
      if (event.kind === 'data') terminal.write(event.text || '')
      else { terminal.writeln(`\r\nLogin encerrado (código ${event.code}).`); end(event.code ?? undefined) }
    })
    window.prism.providers.login(profile.provider, profile.id, { session, cols: terminal.cols, rows: terminal.rows })
      .catch((err: Error) => { setError(err.message); end(undefined) })
    const observer = new ResizeObserver(() => { try { fit.fit() } catch { /* Detached. */ } })
    observer.observe(host.current!)
    return () => {
      window.prism.providers.loginCancel(profile.id, session)
      off(); input.dispose(); resize.dispose(); observer.disconnect(); terminal.dispose()
    }
  }, [profile.id])
  return <div className="stg-login">
    {error ? <p className="stg-error" role="alert">{error}</p> : null}
    <div ref={host} className="stg-login-terminal" />
  </div>
}
