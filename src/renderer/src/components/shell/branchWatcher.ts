/** Metadata-only branch refresh: one request at a time, paused while hidden. */
export function watchBranch({ read, update, isVisible, onVisibilityChange, every = 60000 }: {
  read: () => Promise<string>
  update: (branch: string) => void
  isVisible: () => boolean
  onVisibilityChange: (listener: () => void) => () => void
  every?: number
}): () => void {
  let disposed = false
  let busy = false
  let timer: ReturnType<typeof setInterval> | undefined
  const refresh = async (): Promise<void> => {
    if (disposed || busy || !isVisible()) return
    busy = true
    try {
      const branch = await read()
      if (!disposed) update(branch)
    } catch {
      // Keep the last successful branch through transient filesystem/SSH errors.
    } finally { busy = false }
  }
  const syncVisibility = (): void => {
    clearInterval(timer)
    timer = undefined
    if (disposed || !isVisible()) return
    void refresh()
    timer = setInterval(refresh, every)
  }
  const off = onVisibilityChange(syncVisibility)
  syncVisibility()
  return () => { disposed = true; clearInterval(timer); off() }
}
