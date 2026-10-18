import { useEffect, useState } from 'react'
import { useStore } from '../../store'

// Fenced-code highlighting through Monaco's colorizer: the editor already ships
// Monaco and Prism's themes, so chat code reads in the same colours as the
// editor without a second highlighter. Loaded lazily, cached per block.

const ALIASES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', node: 'javascript',
  py: 'python', python3: 'python', rb: 'ruby', rs: 'rust', kt: 'kotlin', kts: 'kotlin',
  sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', shellsession: 'shell',
  ps: 'powershell', ps1: 'powershell', pwsh: 'powershell',
  yml: 'yaml', md: 'markdown', mdx: 'markdown', htm: 'html', vue: 'html', svelte: 'html',
  cs: 'csharp', 'c#': 'csharp', 'c++': 'cpp', cc: 'cpp', hpp: 'cpp', h: 'cpp', fs: 'fsharp',
  golang: 'go', dockerfile: 'dockerfile', docker: 'dockerfile', jsonc: 'json', json5: 'json',
  tf: 'hcl', proto: 'protobuf', objc: 'objective-c', bat: 'bat', cmd: 'bat'
}

type Monaco = typeof import('monaco-editor')
let loading: Promise<Monaco> | null = null
let themed = ''
const cache = new Map<string, string>()

async function monaco(theme: string): Promise<Monaco> {
  loading ||= Promise.all([import('monaco-editor'), import('../../lib/monaco-setup')]).then(([m, setup]) => {
    setup.defineprismTheme(m)
    return m
  })
  const m = await loading
  if (themed !== theme) {
    const setup = await import('../../lib/monaco-setup')
    m.editor.setTheme(setup.monacoThemeFor(theme))
    themed = theme
    cache.clear()
  }
  return m
}

/** Monaco language id for a fence info string, or null when Monaco has none. */
function languageFor(m: Monaco, fence: string): string | null {
  const id = (ALIASES[fence.toLowerCase()] || fence.toLowerCase()).trim()
  if (!id) return null
  const langs = m.languages.getLanguages()
  const hit = langs.find((l) => l.id === id || l.aliases?.some((a) => a.toLowerCase() === id) || l.extensions?.includes(`.${id}`))
  return hit?.id ?? null
}

/** Colorized HTML for a fenced block, or null while loading / when unsupported. */
export function useHighlighted(code: string, fence: string, enabled: boolean): string | null {
  const theme = useStore((s) => s.settings.theme)
  const key = `${theme}\u0000${fence}\u0000${code}`
  const [html, setHtml] = useState<string | null>(() => cache.get(key) ?? null)
  useEffect(() => {
    if (!enabled || !fence) { setHtml(null); return }
    const hit = cache.get(key)
    if (hit !== undefined) { setHtml(hit); return }
    let alive = true
    // Streaming text changes every few frames; colorize once it settles.
    const timer = setTimeout(() => {
      void monaco(theme).then(async (m) => {
        const lang = languageFor(m, fence)
        if (!lang || !alive) return
        const out = await m.editor.colorize(code, lang, { tabSize: 2 })
        if (cache.size > 300) cache.clear()
        cache.set(key, out)
        if (alive) setHtml(out)
      }).catch(() => {})
    }, 150)
    return () => { alive = false; clearTimeout(timer) }
  }, [key, enabled])
  return enabled ? html : null
}
