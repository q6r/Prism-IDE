import { useEffect, useRef } from 'react'
import type { SettingsSectionId } from './definitions'
import { useSettingsUi } from './state'

const FLASH_ATTR = 'data-settings-anchor-flash'
const FLASH_MS = 1800
const DEADLINE_MS = 1500

/**
 * The settings-search reveal watcher (use-settings-anchor-reveal.ts): once the
 * requested section is on screen, wait for the anchor's element to mount and
 * become visible, scroll it into view and flash it. A page result (no anchor)
 * scrolls the pane to its top.
 */
export function useSettingsAnchorReveal(section: SettingsSectionId, pane: HTMLElement | null): void {
  const reveal = useSettingsUi((s) => s.reveal)
  const clearReveal = useSettingsUi((s) => s.clearReveal)
  useEffect(() => {
    if (!reveal || reveal.section !== section || !pane) return
    if (reveal.anchor === null) { pane.scrollTo({ top: 0 }); clearReveal(); return }
    const anchor = reveal.anchor
    const started = performance.now()
    let frame = 0
    const tick = (): void => {
      const el = pane.querySelector<HTMLElement>(`[data-settings-anchor="${CSS.escape(anchor)}"]`)
      if (el && el.getClientRects().length > 0) {
        el.scrollIntoView({ block: 'center', behavior: 'auto' })
        flash(el)
        clearReveal()
        return
      }
      if (performance.now() - started < DEADLINE_MS) frame = requestAnimationFrame(tick)
      else clearReveal()
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [reveal, section, pane, clearReveal])
}

// Outlives the effect on purpose: clearing the request re-runs it, and the
// mark must still come off when its time is up.
const flashTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()
function flash(el: HTMLElement): void {
  clearTimeout(flashTimers.get(el))
  el.removeAttribute(FLASH_ATTR)
  void el.offsetWidth // restarts the animation when the same row is picked again
  el.setAttribute(FLASH_ATTR, '')
  flashTimers.set(el, setTimeout(() => el.removeAttribute(FLASH_ATTR), FLASH_MS))
}

/**
 * For master-detail pages: a result whose anchor lives in another area (or
 * provider tab) switches to it first, so the watcher above can find the row.
 */
export function useRevealArea<A extends string>(section: SettingsSectionId, areaForAnchor: (anchor: string) => A | null, setArea: (area: A) => void): void {
  const reveal = useSettingsUi((s) => s.reveal)
  const latest = useRef({ areaForAnchor, setArea })
  latest.current = { areaForAnchor, setArea }
  useEffect(() => {
    if (!reveal || reveal.section !== section || reveal.anchor === null) return
    const area = latest.current.areaForAnchor(reveal.anchor)
    if (area !== null) latest.current.setArea(area)
  }, [reveal, section])
}
