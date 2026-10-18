import { useCallback, useEffect, useRef, useState } from 'react'
import { useAgentChats } from '../../lib/agentChats'
import { deriveTurnUsage } from '../../lib/usageAnalytics/deltas'
import { followUsageUpdates } from '../../lib/usageUpdates'
import type { UsageFact, UsageImportState } from '../../../../shared/usage'

export interface UsageData {
  readonly status: 'loading' | 'ready' | 'error'
  readonly facts: readonly UsageFact[]
  readonly importState: UsageImportState | null
  readonly error: string | null
  /** When the records were read; windows end on this day. */
  readonly loadedAt: number | null
  readonly refreshing: boolean
  readonly importing: boolean
  readonly reload: () => Promise<void>
  readonly importTraycer: (root?: string) => Promise<UsageImportState | null>
}

/**
 * The usage records (Prism's turns plus imported Traycer turns) as per-turn
 * facts. Reloads quietly a moment after any agent turn ends, so the page
 * follows live work while it is open.
 */
export function useUsageData(): UsageData {
  const [state, setState] = useState<Omit<UsageData, 'reload' | 'importTraycer' | 'importing'>>({
    status: 'loading', facts: [], importState: null, error: null, loadedAt: null, refreshing: false
  })
  const [importing, setImporting] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, refreshing: s.status === 'ready' }))
    try {
      const records = await window.prism.usage.records()
      if (!alive.current) return
      setState({ status: 'ready', facts: deriveTurnUsage(records.observations), importState: records.importState, error: null, loadedAt: records.generatedAt, refreshing: false })
    } catch (err) {
      if (!alive.current) return
      const message = err instanceof Error ? err.message : String(err)
      // A failed refresh keeps the data already on screen.
      setState((s) => s.status === 'ready' ? { ...s, refreshing: false } : { ...s, status: 'error', error: message, refreshing: false })
    }
  }, [])

  useEffect(() => { void reload() }, [reload])

  useEffect(() => followUsageUpdates(useAgentChats.subscribe, () => { void reload() }), [reload])

  const importTraycer = useCallback(async (root?: string) => {
    setImporting(true)
    try {
      const result = await window.prism.usage.importTraycer(root)
      if (alive.current) setState((s) => ({ ...s, importState: result }))
      await reload()
      return result
    } catch (err) {
      if (alive.current) setState((s) => ({ ...s, importState: s.importState ? { ...s.importState, status: 'error', error: err instanceof Error ? err.message : String(err) } : s.importState }))
      return null
    } finally { if (alive.current) setImporting(false) }
  }, [reload])

  return { ...state, importing, reload, importTraycer }
}
