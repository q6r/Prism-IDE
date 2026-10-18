import { useSyncExternalStore } from 'react'

// One shared 60s clock for every relative time in the list (Traycer's
// createSharedClock): rows repaint together once a minute instead of each
// owning a timer.
let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => { now = Date.now(); for (const l of listeners) l() }, 60_000)
  }
  return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = undefined } }
}
const snapshot = (): number => now

export function useMinuteClock(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
