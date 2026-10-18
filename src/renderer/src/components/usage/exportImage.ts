import { redactEmails } from '../../lib/usageAnalytics/format'
import { toRgba } from './palette'

// Shareable PNG of the usage summary (Traycer's usage-export-image.ts): the
// live region is deep-cloned into an offscreen card with a title, the period
// and a footer, then rasterised with html-to-image (loaded on demand).

/** The live summary region; resolved under the page root at click time. */
export const USAGE_EXPORT_REGION_SELECTOR = '[data-usage-export-region]'
/** Inside the region, but never in the image (workspace detail, controls). */
const EXCLUDE_SELECTOR = '[data-usage-export-exclude]'
/** A horizontal scroller whose whole content is scaled into the image. */
const FIT_SELECTOR = '[data-usage-export-fit]'
const SVG_COLOR_ATTRIBUTES = ['fill', 'stroke', 'stop-color']

export interface UsageImageParams {
  readonly region: HTMLElement
  readonly title: string
  readonly subtitle: string
  readonly footer: string
  /** Prism's mark as a data URL, or null to omit it. */
  readonly logo: string | null
  /** The app font's @font-face rules with inlined files (from the main process); '' to let html-to-image find fonts itself. */
  readonly fontCss: string
}

export async function captureUsageImage(params: UsageImageParams): Promise<Blob> {
  const { toBlob } = await import('html-to-image')
  const { region } = params
  const background = opaqueBackground(region)
  const frame = document.createElement('div')
  frame.className = 'usg-root usg-export'
  Object.assign(frame.style, { position: 'fixed', left: '-100000px', top: '0', width: `${region.getBoundingClientRect().width}px`, backgroundColor: background, pointerEvents: 'none' })
  frame.append(header(params), cloneRegion(region), footer(params.footer))
  // Parked offscreen but in the document: keep keyboard and assistive tech off the clone.
  frame.setAttribute('inert', '')
  frame.setAttribute('aria-hidden', 'true')
  document.body.appendChild(frame)
  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    // html-to-image inlines COMPUTED styles, so the offscreen offset must be reset or the canvas paints empty.
    // With the font CSS supplied, nothing is fetched: the app font is embedded as given.
    const options = { pixelRatio: 2, backgroundColor: background, cacheBust: false, preferredFontFormat: 'woff2', style: { position: 'static', left: '0', top: '0' },
      ...(params.fontCss ? { fontEmbedCSS: params.fontCss } : {}) }
    let blob: Blob | null
    try { blob = await toBlob(frame, options) }
    // A font file the page cannot fetch must not cost the whole export.
    catch { blob = await toBlob(frame, { ...options, skipFonts: true }) }
    if (!blob) throw new Error('A captura não gerou imagem.')
    return blob
  } finally { frame.remove() }
}

function header(params: UsageImageParams): HTMLElement {
  const head = document.createElement('div')
  head.className = 'usg-export-head'
  const brand = document.createElement('div')
  brand.className = 'usg-export-brand'
  if (params.logo) {
    const img = document.createElement('img')
    img.src = params.logo
    img.alt = ''
    brand.appendChild(img)
  }
  const title = document.createElement('span')
  title.className = 'usg-export-title'
  title.textContent = params.title
  brand.appendChild(title)
  const sub = document.createElement('span')
  sub.className = 'usg-export-sub'
  sub.textContent = redactEmails(params.subtitle)
  head.append(brand, sub)
  return head
}

function footer(text: string): HTMLElement {
  const foot = document.createElement('div')
  foot.className = 'usg-export-foot'
  const left = document.createElement('span')
  left.textContent = 'Prism IDE'
  const right = document.createElement('span')
  right.textContent = text
  foot.append(left, right)
  return foot
}

/**
 * Deep clone with what `cloneNode` loses fixed up: SVG colors held as var()
 * resolved from the live node, marked scrollers scaled to their full width,
 * excluded nodes dropped and emails redacted (an account label can be one).
 * Original and clone are walked in parallel; removals run after the walk.
 */
function cloneRegion(region: HTMLElement): HTMLElement {
  const clone = region.cloneNode(true) as HTMLElement
  const sources = region.querySelectorAll('*'), targets = clone.querySelectorAll('*')
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i], target = targets[i]
    if (source instanceof SVGElement && target instanceof SVGElement) {
      for (const name of SVG_COLOR_ATTRIBUTES) {
        const value = source.getAttribute(name)
        if (!value?.includes('var(')) continue
        const computed = getComputedStyle(source).getPropertyValue(name)
        if (computed) target.setAttribute(name, computed)
      }
    }
    if (source instanceof HTMLElement && target instanceof HTMLElement && source.matches(FIT_SELECTOR)) fitScroller(source, target)
  }
  for (const node of clone.querySelectorAll(EXCLUDE_SELECTOR)) node.remove()
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    if (text.includes('@')) node.textContent = redactEmails(text)
  }
  return clone
}

/** Scales a scroller's clone so its whole content fits the width it has on screen. */
function fitScroller(source: HTMLElement, target: HTMLElement): void {
  const { clientWidth, scrollWidth, scrollHeight } = source
  if (scrollWidth <= 0) return
  const scale = Math.min(1, clientWidth / scrollWidth)
  if (scale >= 1) return
  target.style.overflow = 'hidden'
  target.style.height = `${scrollHeight * scale}px`
  for (const child of target.children) {
    if (!(child instanceof HTMLElement)) continue
    child.style.width = `${scrollWidth}px`
    child.style.transform = `scale(${scale})`
    child.style.transformOrigin = 'top left'
  }
}

/** The nearest fully opaque ancestor background, so the PNG is never see-through. */
function opaqueBackground(node: HTMLElement): string {
  for (let el: HTMLElement | null = node; el; el = el.parentElement) {
    const bg = toRgba(getComputedStyle(el).backgroundColor)
    if (/,\s*1\)$/.test(bg)) return bg
  }
  return toRgba(getComputedStyle(document.body).backgroundColor) || '#111111'
}
