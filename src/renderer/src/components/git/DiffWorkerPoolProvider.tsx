import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { WorkerPoolManager } from '@pierre/diffs/worker'

interface PoolState { pool?: WorkerPoolManager; settled: boolean; request: () => void }
const PoolContext = createContext<PoolState>({ settled: true, request: () => {} })

/** App lifetime owner. The renderer and worker bundle load only on first diff demand. */
export function DiffWorkerPoolProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ pool?: WorkerPoolManager; settled: boolean }>({ settled: false })
  const owned = useRef<WorkerPoolManager | undefined>(undefined)
  const loading = useRef(false)
  const generation = useRef(0)
  const request = useCallback(() => {
    if (loading.current || owned.current) return
    loading.current = true
    const version = generation.current
    void import('./diff-worker-runtime').then(({ createDiffWorkerPool }) => {
      if (version !== generation.current) return
      const pool = createDiffWorkerPool()
      owned.current = pool
      setState({ pool, settled: true })
    }).catch(() => { if (version === generation.current) setState({ settled: true }) })
  }, [])
  useEffect(() => () => {
    generation.current++
    loading.current = false
    owned.current?.terminate()
    owned.current = undefined
  }, [])
  const value = useMemo(() => ({ ...state, request }), [state, request])
  return <PoolContext.Provider value={value}>{children}</PoolContext.Provider>
}

export function useSharedDiffWorkerPool(): Omit<PoolState, 'request'> {
  const { pool, settled, request } = useContext(PoolContext)
  useEffect(request, [request])
  return { pool, settled }
}
