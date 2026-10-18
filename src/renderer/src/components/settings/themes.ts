// Prism's built-in themes as the theme picker lists them. Swatch colors are the
// theme's panel background, text and accent (styles/theme.css + agents.css),
// the three tokens Traycer's PaletteSwatch draws (background, foreground, primary).

export interface ThemeOption {
  readonly id: string
  readonly label: string
  readonly appearance: 'dark' | 'light'
  readonly colors: { readonly background: string; readonly foreground: string; readonly primary: string }
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: 'prism-dark', label: 'Prism Dark', appearance: 'dark', colors: { background: '#121216', foreground: '#d8dade', primary: '#6f76e6' } },
  { id: 'prism-neutral', label: 'Prism Neutral', appearance: 'dark', colors: { background: '#202020', foreground: '#ededed', primary: '#b7a4ef' } },
  { id: 'prism-ocean', label: 'Ocean', appearance: 'dark', colors: { background: '#0e151c', foreground: '#cdd9e0', primary: '#4db6c4' } },
  { id: 'prism-nord', label: 'Nord Slate', appearance: 'dark', colors: { background: '#2e3440', foreground: '#d8dee9', primary: '#88c0d0' } },
  { id: 'prism-forest', label: 'Evergreen', appearance: 'dark', colors: { background: '#111817', foreground: '#cdd8d2', primary: '#7cb89a' } },
  { id: 'prism-amethyst', label: 'Amethyst', appearance: 'dark', colors: { background: '#141119', foreground: '#d6d2de', primary: '#a982d6' } },
  { id: 'prism-light-pink', label: 'White & Pink', appearance: 'light', colors: { background: '#f6eef2', foreground: '#2c2530', primary: '#d65a8e' } },
  { id: 'prism-sepia', label: 'Sepia Paper', appearance: 'light', colors: { background: '#ece3d2', foreground: '#463a2c', primary: '#b07a3c' } },
  { id: 'prism-daylight', label: 'Daylight', appearance: 'light', colors: { background: '#eceef1', foreground: '#2b2e36', primary: '#5b62d6' } }
]

/** The theme to show for a stored id; an unknown id falls back to Prism Dark (the app default). */
export function themeOption(id: string): ThemeOption {
  return THEME_OPTIONS.find((t) => t.id === id) ?? THEME_OPTIONS[0]
}
