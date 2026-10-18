import { useStore } from '../store'
import { LayoutKey } from '../types'

/**
 * Draggable resize handle. `axis='x'` resizes a horizontal width, `axis='y'` a
 * vertical height. `side` says which edge the handle sits on so the delta sign
 * is correct (e.g. the chat panel grows when dragging its LEFT edge leftward).
 */
export default function Splitter({
  layoutKey,
  axis,
  side,
  min,
  max
}: {
  layoutKey: LayoutKey
  axis: 'x' | 'y'
  side: 'left' | 'right' | 'top'
  min: number
  max: number
}) {
  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const start = axis === 'x' ? e.clientX : e.clientY
    const startSize = useStore.getState().settings[layoutKey]

    const onMove = (ev: MouseEvent): void => {
      const cur = axis === 'x' ? ev.clientX : ev.clientY
      let delta = cur - start
      if (side === 'left' || side === 'top') delta = -delta
      const next = Math.min(max, Math.max(min, startSize + delta))
      useStore.getState().setLayout(layoutKey, next)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      useStore.getState().persistLayout()
    }
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return <div className={`splitter splitter-${axis}`} onMouseDown={onMouseDown} />
}
