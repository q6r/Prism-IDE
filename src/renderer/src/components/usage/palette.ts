import { useEffect, useMemo, useState, type RefObject } from 'react'

// Resolves the usage palette (CSS custom properties in usage.css) to concrete
// rgba() strings for ECharts, which cannot read var() or oklch(). Re-resolves
// when the app's theme changes.

let canvas: CanvasRenderingContext2D | null | undefined
function context(): CanvasRenderingContext2D | null {
  if (canvas === undefined) {
    const element = document.createElement('canvas')
    element.width = element.height = 1
    canvas = element.getContext('2d', { willReadFrequently: true })
  }
  return canvas
}

const resolved = new Map<string, string>()

/** Any CSS color (hex, oklch, color-mix…) as `rgba(r, g, b, a)`, through a 1px canvas. */
export function toRgba(color: string): string {
  const hit = resolved.get(color)
  if (hit) return hit
  const ctx = context()
  if (!ctx || !color) return color
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = '#010203'
  ctx.fillStyle = color
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  const value = `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 1000) / 1000})`
  resolved.set(color, value)
  return value
}

/** `rgba()` with its alpha multiplied by `alpha`. */
export function withAlpha(rgba: string, alpha: number): string {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(rgba)
  if (!match) return rgba
  const base = match[4] === undefined ? 1 : Number(match[4])
  return `rgba(${match[1]}, ${match[2]}, ${match[3]}, ${Math.round(base * alpha * 1000) / 1000})`
}

/** A custom property's color on `element`, or `fallback`. */
export function cssColor(element: Element, property: string, fallback = 'rgba(128, 128, 128, 1)'): string {
  const value = getComputedStyle(element).getPropertyValue(property).trim()
  return value ? toRgba(value) : fallback
}

/** Bumps whenever the document's theme attributes or classes change. */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => { resolved.clear(); setVersion((v) => v + 1) })
    for (const node of [document.documentElement, document.body]) observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-appearance'] })
    return () => observer.disconnect()
  }, [])
  return version
}

/** The named custom properties of `ref`'s element, resolved; empty until mounted. */
export function usePalette(ref: RefObject<HTMLElement | null>, properties: readonly string[]): Readonly<Record<string, string>> {
  const version = useThemeVersion()
  const [element, setElement] = useState<HTMLElement | null>(null)
  useEffect(() => { setElement(ref.current) }, [ref])
  const key = properties.join('|')
  return useMemo(() => {
    if (!element) return {}
    const out: Record<string, string> = {}
    for (const p of key.split('|')) if (p) out[p] = cssColor(element, p)
    return out
    // `version` re-resolves after a theme switch.
  }, [element, key, version])
}

/** Whether motion should be skipped: the OS setting or Prism's own Animations switch. */
export function prefersReducedMotion(): boolean {
  return document.documentElement.classList.contains('no-anim') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}
