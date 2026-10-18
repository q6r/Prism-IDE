import { useEffect, useState } from 'react'
import { Globe2 } from 'lucide-react'
import { cn } from '../ui'
import { resolveFavicon } from './browserBridge'

/**
 * Traycer's BrowserFavicon: the globe until the page's icon has actually
 * loaded, so a broken or slow favicon never leaves an empty square.
 */
export function BrowserFavicon({ faviconUrl, className }: { faviconUrl: string | null; className?: string }) {
  const [resolved, setResolved] = useState<{ url: string; src: string | null } | null>(null)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)

  useEffect(() => {
    if (faviconUrl === null) return
    let cancelled = false
    void resolveFavicon(faviconUrl).then((src) => {
      if (!cancelled) setResolved({ url: faviconUrl, src })
    })
    return () => {
      cancelled = true
    }
  }, [faviconUrl])

  const src = faviconUrl !== null && resolved?.url === faviconUrl ? resolved.src : null
  const showImage = src !== null && loadedSrc === src
  return (
    <span className={cn('brw-favicon', className)}>
      {showImage ? null : <Globe2 className="brw-favicon-globe" aria-hidden />}
      {src === null ? null : (
        <img
          src={src}
          alt=""
          draggable={false}
          className={cn('brw-favicon-img', showImage && 'shown')}
          onLoad={() => setLoadedSrc(src)}
          onError={() => setLoadedSrc((current) => (current === src ? null : current))}
        />
      )}
    </span>
  )
}
