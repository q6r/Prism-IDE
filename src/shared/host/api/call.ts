/**
 * Shared rules for the `window.prism` domains served by the host
 * (src/shared/host/api/*). Each domain keeps the IPC implementation as its
 * fallback: SSH workspaces (`remoteId`) stay on IPC until T10, and read-only
 * calls caught by a dropped connection are retried there.
 */

/** Calls that may legitimately run long: copying folders, git network commands, reading every transcript. */
export const LONG_CALL_MS = 10 * 60_000

export function isDisconnected(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'disconnected'
}

/**
 * A read-only call on the host that falls back to IPC when the connection
 * drops before the answer. Mutations never use this: the host may already
 * have applied them.
 */
export async function readWithFallback<T>(host: () => Promise<T>, ipc: () => Promise<T>): Promise<T> {
  try {
    return await host()
  } catch (err) {
    if (isDisconnected(err)) return ipc()
    throw err
  }
}

/** The last path segment of a local or host path (`/` and `\` both separate). */
export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}
