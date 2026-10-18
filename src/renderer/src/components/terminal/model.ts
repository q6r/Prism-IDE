export interface TerminalGroup { id: string; panes: string[] }
export interface TerminalLayout { groups: TerminalGroup[]; activeGroup: string; activePane: string }

/** Closing a background split must not move the user's active terminal. */
export function removeTerminalPane(layout: TerminalLayout, paneId: string): TerminalLayout {
  if (!layout.groups.some((group) => group.panes.includes(paneId))) return layout
  const groups = layout.groups
    .map((group) => ({ ...group, panes: group.panes.filter((id) => id !== paneId) }))
    .filter((group) => group.panes.length > 0)
  if (!groups.length) return { groups, activeGroup: '', activePane: '' }
  if (layout.activePane !== paneId) return { ...layout, groups }
  const group = groups.find((item) => item.id === layout.activeGroup) ?? groups[0]
  return { groups, activeGroup: group.id, activePane: group.panes[group.panes.length - 1] }
}

/**
 * The panel of a reopened window: one tab per host terminal nobody shows
 * (oldest first), each pane mapped to the terminal it attaches to. A fresh
 * shell is added — and selected — when there is none to adopt, or when a
 * command is waiting to run (it must not be typed into a running program).
 */
export function adoptTerminals(terminalIds: readonly string[], withFresh: boolean, newPane: () => string, newGroup: () => string): { layout: TerminalLayout; adopted: Record<string, string> } {
  const adopted: Record<string, string> = {}
  const groups: TerminalGroup[] = terminalIds.map((terminalId) => {
    const pane = newPane()
    adopted[pane] = terminalId
    return { id: newGroup(), panes: [pane] }
  })
  if (withFresh || !groups.length) groups.push({ id: newGroup(), panes: [newPane()] })
  const active = groups[groups.length - 1]
  return { layout: { groups, activeGroup: active.id, activePane: active.panes[0] }, adopted }
}

export function terminalTitle(title: string): string | null {
  return title.split(/[\\/]/).pop()?.trim() || null
}

export function canFitTerminal(width: number, height: number): boolean {
  return Number.isFinite(width) && Number.isFinite(height) && width >= 48 && height >= 48
}
