import { useEffect, useRef } from 'react'
import { Search } from 'lucide-react'
import { InputAddon, InputGroup, useMenuContext } from '../ui'

export default function BranchSearchInput({ value, onChange, onSubmit }: { value: string; onChange: (value: string) => void; onSubmit: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const content = useMenuContext()?.content
  useEffect(() => {
    if (!content) return
    let frame = 0
    const focus = (): void => {
      if (content.dataset.measuring !== 'false') return
      observer.disconnect()
      // The kit first places/focuses the menu; focus its search after that commit.
      frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
    }
    const observer = new MutationObserver(focus)
    observer.observe(content, { attributes: true, attributeFilter: ['data-measuring'] })
    focus()
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [content])
  return <div className="pg-branch-search"><InputGroup variant="search"><InputAddon><Search size={14} /></InputAddon><input ref={input} value={value} aria-label="Buscar ou criar branch" placeholder="Buscar ou criar branch…" onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && value.trim()) { event.preventDefault(); onSubmit() } }} /></InputGroup></div>
}
