import { ArrowUpRight, FolderOpen, MessageSquare } from 'lucide-react'
import { Button } from '../ui'

const STARTERS: readonly (readonly [string, string])[] = [
  ['Entender o projeto', 'Explore o projeto e explique a arquitetura e os principais fluxos.'],
  ['Construir uma feature', 'Quero implementar uma nova funcionalidade. Primeiro, me ajude a definir o escopo.'],
  ['Encontrar um problema', 'Analise o projeto em busca de bugs e proponha correções.']
]

/** Traycer's chat empty state, plus Prism's prompt starters. */
export function EmptyState({ onStarter, needsFolder, onOpenFolder }: {
  onStarter: (text: string) => void
  needsFolder: boolean
  onOpenFolder: () => void
}) {
  return <div className="ch-empty">
    <div className="ch-empty-mark"><MessageSquare size={16} aria-hidden /></div>
    <div className="ch-empty-copy">
      <p className="ch-empty-title">Comece a conversa</p>
      <p className="ch-empty-sub">Envie uma mensagem para começar.</p>
    </div>
    <div className="ch-starters" role="list">
      {STARTERS.map(([title, text]) => <button key={title} type="button" role="listitem" className="ch-starter" onClick={() => onStarter(text)}>
        <span className="ch-starter-title">{title}</span>
        <span className="ch-starter-text">{text}</span>
        <ArrowUpRight size={14} aria-hidden className="ch-starter-arrow" />
      </button>)}
    </div>
    {needsFolder ? <Button variant="outline" size="sm" onClick={onOpenFolder}><FolderOpen aria-hidden /> Abrir uma pasta de projeto</Button> : null}
  </div>
}
