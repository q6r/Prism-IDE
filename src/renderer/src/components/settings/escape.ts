// Escape routing inside Settings (Traycer's settings-escape-consumers.ts).
// The modal owns ONE capture-phase Escape listener; a nested layer (a dialog
// inside a panel) pushes a consumer while it is open, and the topmost one that
// returns true takes the key. Only when nothing consumes it does the modal
// clear a running search, and only an idle Escape closes Settings.

export type EscapeConsumer = () => boolean

const consumers: EscapeConsumer[] = []

/** Registers `consumer` on top of the stack; the returned function removes it. */
export function pushEscapeConsumer(consumer: EscapeConsumer): () => void {
  consumers.push(consumer)
  return () => {
    const index = consumers.lastIndexOf(consumer)
    if (index >= 0) consumers.splice(index, 1)
  }
}

/** Offers the key to the consumers, newest first; true when one of them took it. */
export function consumeEscape(): boolean {
  for (let i = consumers.length - 1; i >= 0; i--) if (consumers[i]()) return true
  return false
}

export function escapeConsumerCount(): number {
  return consumers.length
}
