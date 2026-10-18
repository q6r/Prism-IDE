import { create } from 'zustand'

/**
 * The Agents tree's open branches, per task, in a store that outlives the
 * sidebar (epic-sidebar-expansion-store): roots start open, nested parents
 * start closed, and what the user opens or closes is remembered until the app
 * restarts.
 */
export interface PanelExpansion { readonly expanded: ReadonlySet<string>; readonly collapsed: ReadonlySet<string> }
const EMPTY: PanelExpansion = { expanded: new Set(), collapsed: new Set() }

interface ExpansionState {
  panels: Readonly<Record<string, PanelExpansion>>
  setOpen: (panel: string, id: string, open: boolean) => void
  /** Forces branches open (a newly active chat's ancestors). */
  reveal: (panel: string, ids: readonly string[]) => void
  collapseAll: (panel: string, parentIds: Iterable<string>) => void
}

export const useTreeExpansion = create<ExpansionState>((set) => ({
  panels: {},
  setOpen: (panel, id, open) => set((s) => {
    const p = s.panels[panel] ?? EMPTY
    const expanded = new Set(p.expanded), collapsed = new Set(p.collapsed)
    if (open) { expanded.add(id); collapsed.delete(id) } else { expanded.delete(id); collapsed.add(id) }
    return { panels: { ...s.panels, [panel]: { expanded, collapsed } } }
  }),
  reveal: (panel, ids) => set((s) => {
    const p = s.panels[panel] ?? EMPTY
    if (ids.every((id) => p.expanded.has(id) && !p.collapsed.has(id))) return s
    const expanded = new Set(p.expanded), collapsed = new Set(p.collapsed)
    for (const id of ids) { expanded.add(id); collapsed.delete(id) }
    return { panels: { ...s.panels, [panel]: { expanded, collapsed } } }
  }),
  collapseAll: (panel, parentIds) => set((s) => ({ panels: { ...s.panels, [panel]: { expanded: new Set(), collapsed: new Set(parentIds) } } }))
}))

export function panelExpansion(panels: Readonly<Record<string, PanelExpansion>>, panel: string): PanelExpansion {
  return panels[panel] ?? EMPTY
}
/** Effective state of one branch: a user choice wins; otherwise roots open, nested parents closed. */
export function branchOpen(panel: PanelExpansion, id: string, depth: number): boolean {
  if (panel.collapsed.has(id)) return false
  return panel.expanded.has(id) || depth === 0
}
