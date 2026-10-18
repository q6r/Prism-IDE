import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'
import { useInsertionEffect } from 'react'
import '../styles/files.css'

const resolver = createFileTreeIconResolver({ set: 'complete' })
const spriteSheet = getBuiltInSpriteSheet('complete')
const SPRITE_ID = 'prism-traycer-file-icon-sprite'

// The package supplies this static SVG, never filesystem/user markup. Keep one
// sheet for every consumer, including tabs mounted while Explorer is hidden.
function useFileIconSprite(): void {
  useInsertionEffect(() => {
    if (document.getElementById(SPRITE_ID)) return
    const host = document.createElement('span')
    host.id = SPRITE_ID
    host.setAttribute('aria-hidden', 'true')
    host.style.display = 'none'
    host.innerHTML = spriteSheet
    document.body.appendChild(host)
  }, [])
}

export function FileIconSpriteSheet() {
  useFileIconSprite()
  return null
}

export const resolveFileIcon = (name: string) => resolver.resolveIcon('file-tree-icon-file', name)

export function FileTypeIcon({ name, size = 15 }: { name: string; size?: number }) {
  useFileIconSprite()
  const icon = resolveFileIcon(name)
  return <svg aria-hidden="true" data-icon-name={icon.name} data-icon-token={icon.token}
    className="pr-files-type-icon" width={size} height={size}
    viewBox={icon.viewBox ?? `0 0 ${icon.width ?? 16} ${icon.height ?? 16}`}
    style={{ color: `var(--tr-files-icon-${icon.token ?? 'default'}, var(--tr-muted-foreground))` }}>
    <use href={`#${icon.name.replace(/^#/, '')}`} />
  </svg>
}

// Pierre's complete tree uses its filled chevron as the folder glyph. Files and
// folders share one 14px icon column; an extra folder/spacer shifts the names.
export function FileTreeChevron({ expanded, size = 14 }: { expanded: boolean; size?: number }) {
  useFileIconSprite()
  return <svg aria-hidden="true" className={'pr-files-chevron' + (expanded ? ' is-open' : '')}
    width={size} height={size} viewBox="0 0 16 16">
    <use href="#file-tree-icon-chevron" />
  </svg>
}
