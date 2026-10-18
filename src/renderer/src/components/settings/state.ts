import { create } from 'zustand'
import type { SettingsSectionId } from './definitions'

export interface SettingsReveal {
  readonly section: SettingsSectionId
  /** `data-settings-anchor` to scroll to and flash; null scrolls the pane to its top. */
  readonly anchor: string | null
  /** Re-arms the same target when a result is picked twice. */
  readonly nonce: number
}

interface SettingsUiState {
  /** The rail's search query; scoped to one modal mount (cleared on close). */
  query: string
  setQuery: (query: string) => void
  reveal: SettingsReveal | null
  requestReveal: (section: SettingsSectionId, anchor: string | null) => void
  clearReveal: () => void
}

/** Settings-local UI state (Traycer's settings-search-store). */
export const useSettingsUi = create<SettingsUiState>((set) => ({
  query: '',
  setQuery: (query) => set({ query }),
  reveal: null,
  requestReveal: (section, anchor) => set((s) => ({ reveal: { section, anchor, nonce: (s.reveal?.nonce ?? 0) + 1 } })),
  clearReveal: () => set({ reveal: null })
}))
