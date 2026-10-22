import { useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { imageReferenceRanges, type ImageReference } from '../../../../shared/imageReferences'
import { syncTextareaMirror } from './caret'

/** Decorative backgrounds only: the native textarea owns text, selection and undo. */
export default function ComposerImageReferences({ inputRef, text, images }: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  text: string
  images: readonly ImageReference[]
}) {
  const content = useRef<HTMLDivElement>(null)
  const update = useRef<(() => void) | null>(null)
  const ranges = useMemo(() => {
    const known = new Set(images.map(image => image.number))
    return imageReferenceRanges(text).filter(range => known.has(range.number))
  }, [text, images])
  const visible = ranges.length > 0

  useLayoutEffect(() => {
    const editor = inputRef.current, mirror = content.current
    if (!editor || !mirror) return
    let disposed = false
    const scroll = (): void => { mirror.style.transform = `translate(${-editor.scrollLeft}px, ${-editor.scrollTop}px)` }
    const sync = (): void => { syncTextareaMirror(editor, mirror); scroll() }
    update.current = sync
    sync()
    const resize = new ResizeObserver(sync)
    resize.observe(editor)
    const theme = new MutationObserver(sync)
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    editor.addEventListener('scroll', scroll, { passive: true })
    document.fonts.addEventListener('loadingdone', sync)
    void document.fonts.ready.then(() => { if (!disposed) sync() })
    return () => {
      disposed = true
      update.current = null
      resize.disconnect()
      theme.disconnect()
      editor.removeEventListener('scroll', scroll)
      document.fonts.removeEventListener('loadingdone', sync)
    }
  }, [inputRef, visible])
  useLayoutEffect(() => { update.current?.() }, [text, images])

  if (!visible) return null
  const pieces: ReactNode[] = []
  let at = 0
  for (const range of ranges) {
    pieces.push(text.slice(at, range.start))
    pieces.push(<mark key={range.start} className="tcm-image-reference" data-image-number={range.number}>{text.slice(range.start, range.end)}</mark>)
    at = range.end
  }
  pieces.push(text.slice(at))
  return <div className="tcm-image-reference-viewport" aria-hidden="true">
    <div ref={content} className="tcm-image-reference-text">{pieces}</div>
  </div>
}
