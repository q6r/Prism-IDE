import type * as Monaco from 'monaco-editor'

type MonacoNamespace = typeof Monaco

let instance: MonacoNamespace | null = null
const listeners = new Set<(monaco: MonacoNamespace) => void>()

/** Called by monaco-setup once the locally bundled Monaco is configured. */
export function notifyMonacoReady(monaco: MonacoNamespace): void {
  instance = monaco
  for (const listener of listeners) listener(monaco)
}

/**
 * Hands over the local Monaco as soon as something else loaded it, without
 * loading it here: `useMonaco()` would start @monaco-editor/react's CDN loader
 * at startup, which the app's CSP blocks.
 */
export function onMonacoReady(listener: (monaco: MonacoNamespace) => void): () => void {
  if (instance) listener(instance)
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
