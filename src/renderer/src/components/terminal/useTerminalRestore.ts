import { useEffect } from 'react'
import { useStore } from '../../store'

/**
 * Once per window, when the host connects: if it runs terminals nobody shows
 * (the window was closed or reloaded while they ran), open the panel so they
 * come back — TerminalPanel adopts them on mount.
 */
export function useTerminalRestore(): void {
  useEffect(() => {
    let checked = false
    let mounted = true
    const off = window.prism.host.onStatus((status) => {
      if (checked || status.state !== 'connected') return
      checked = true
      void window.prism.terminal.list().then((terminals) => {
        const state = useStore.getState()
        if (!mounted || state.terminalOpen || state.remote) return
        if (terminals.some((terminal) => terminal.attached === 0)) state.openTerminal()
      }).catch(() => {})
    })
    return () => {
      mounted = false
      off()
    }
  }, [])
}
