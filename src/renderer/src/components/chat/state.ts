import { create } from 'zustand'

/**
 * Disclosure state for transcript rows (activity groups, tool rows, reasoning),
 * keyed by `${turnId}:${rowKey}`. Lives outside the components so a row keeps
 * its state when it moves between the live activity window and the expanded
 * group body (Traycer's tool-open / activity-group-open stores).
 */
interface OpenStore { open: Record<string, boolean>; set: (key: string, value: boolean) => void }
export const useOpenStore = create<OpenStore>((set) => ({
  open: {},
  set: (key, value) => set((s) => s.open[key] === value ? s : { open: { ...s.open, [key]: value } })
}))

export function useOpen(key: string, fallback = false): [boolean, (next: boolean) => void] {
  const value = useOpenStore((s) => s.open[key])
  const setOpen = useOpenStore((s) => s.set)
  return [value ?? fallback, (next) => setOpen(key, next)]
}

// Prism's segments carry no per-tool or per-thought timing, so the transcript
// measures what it sees live: when a tool was first seen running and when a
// reasoning block started/stopped streaming. Persisted history reads like
// Traycer's legacy rows ("Pensou", no elapsed).
const toolStarts = new Map<string, number>()
export function toolStartedAt(key: string): number {
  let at = toolStarts.get(key)
  if (at === undefined) { at = Date.now(); toolStarts.set(key, at) }
  return at
}

const reasoning = new Map<string, { start: number; end?: number }>()
/** Records a reasoning block's streaming edge; idempotent across re-renders. */
export function noteReasoning(key: string, streaming: boolean): void {
  const entry = reasoning.get(key)
  if (streaming) { if (!entry) reasoning.set(key, { start: Date.now() }) }
  else if (entry && entry.end === undefined) entry.end = Date.now()
}
export function reasoningDuration(key: string): number | null {
  const entry = reasoning.get(key)
  return entry?.end === undefined ? null : entry.end - entry.start
}
