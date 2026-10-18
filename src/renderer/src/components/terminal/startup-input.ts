/** Retain startup keystrokes and bracketed pastes in their original order. */
export function createTerminalInputBuffer() {
  const pending: string[] = []
  const flush = (send: (data: string) => void): void => {
    while (pending.length) {
      send(pending[0])
      pending.shift()
    }
  }
  return {
    write(data: string, send?: (data: string) => void): void {
      pending.push(data)
      if (send) flush(send)
    },
    flush
  }
}
