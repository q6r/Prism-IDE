import { FolderOpen, Import, MonitorSmartphone, Waypoints } from 'lucide-react'
import { useStore } from '../../store'
import { Badge, Button, Spinner, Tooltip } from '../ui'
import { relativeTime } from '../../lib/providerUsage'
import { formatInteger, turnsLabel } from '../../lib/usageAnalytics/format'
import type { UsageImportState } from '../../../../shared/usage'
import { UsageCard } from './parts'

/** "Importado há 2 h · 1.428 turnos de 23 tarefas", or why not. */
export function importSummary(state: UsageImportState | null, now: number): string {
  if (!state || state.status === 'never' || state.at === null) return 'Ainda não importado.'
  const when = relativeTime(state.at, now)
  if (state.status === 'error') return `Falhou ${when}: ${state.error ?? 'erro desconhecido'}`
  return `Importado ${when} · ${turnsLabel(state.turns)} de ${formatInteger(state.tasks)} ${state.tasks === 1 ? 'tarefa' : 'tarefas'}`
}

/** Runs the import and reports it as a toast. */
export function useImportTraycer(importTraycer: (root?: string) => Promise<UsageImportState | null>) {
  const addToast = useStore((s) => s.addToast)
  return async (root?: string): Promise<void> => {
    const state = await importTraycer(root)
    if (!state) { addToast('error', 'Não foi possível importar o uso do Traycer.'); return }
    if (state.status === 'error') { addToast('error', `Importação do Traycer: ${state.error}`); return }
    const news = state.added ? `${turnsLabel(state.added)} novos` : 'nenhum turno novo'
    addToast(state.warnings.length ? 'info' : 'success', `Uso do Traycer importado: ${news}${state.updated ? `, ${formatInteger(state.updated)} atualizados` : ''}.${state.warnings.length ? ` ${state.warnings.length} aviso(s).` : ''}`)
  }
}

export function ImportTraycerButton({ state, importing, onImport, now }: { state: UsageImportState | null; importing: boolean; onImport: () => void; now: number }) {
  return <Tooltip label={importing ? 'Importando…' : importSummary(state, now)}>
    <Button variant="outline" size="sm" disabled={importing} onClick={onImport}>
      {importing ? <Spinner className="usg-btn-spinner" /> : <Import />}Importar do Traycer
    </Button>
  </Tooltip>
}

/** Where the numbers come from, and the Traycer import with its last result. */
export function UsageSources({ prismTurns, traycerTurns, state, importing, onImport, now, delay }: {
  prismTurns: number
  traycerTurns: number
  state: UsageImportState | null
  importing: boolean
  onImport: (root?: string) => void
  now: number
  delay: number
}) {
  const choose = async (): Promise<void> => {
    const root = await window.prism.traycer.chooseRoot().catch(() => null)
    if (root) onImport(root)
  }
  return <UsageCard title="Fontes de dados" icon={Waypoints} delay={delay} data-settings-anchor="usage-sources">
    <div className="usg-sources">
      <div className="usg-source">
        <span className="usg-source-icon"><MonitorSmartphone aria-hidden="true" /></span>
        <div className="usg-source-body">
          <span className="usg-source-title">Prism<Badge variant="success" size="xs">Ao vivo</Badge></span>
          <span className="usg-source-text">{turnsLabel(prismTurns)} registrados nos chats deste app. Atualiza sozinho quando um turno termina.</span>
        </div>
      </div>
      <div className="usg-source">
        <span className="usg-source-icon"><Import aria-hidden="true" /></span>
        <div className="usg-source-body">
          <span className="usg-source-title">Traycer{state?.status === 'ok' ? <Badge variant="muted" size="xs">{turnsLabel(traycerTurns)}</Badge> : null}</span>
          <span className={state?.status === 'error' ? 'usg-error-text' : 'usg-source-text'}>{importSummary(state, now)}</span>
          <span className="usg-source-text">Lê os bancos locais do Traycer só para leitura e guarda uma cópia do uso no Prism. Importar de novo só acrescenta o que mudou.</span>
          {state?.warnings.length ? <ul className="usg-warnings">{state.warnings.slice(0, 5).map((w) => <li key={w}>{w}</li>)}
            {state.warnings.length > 5 ? <li>e mais {state.warnings.length - 5}.</li> : null}</ul> : null}
          <div className="usg-source-actions">
            <Button variant="outline" size="sm" disabled={importing} onClick={() => onImport()}>
              {importing ? <Spinner className="usg-btn-spinner" /> : <Import />}{state?.status === 'ok' ? 'Importar novamente' : 'Importar do Traycer'}
            </Button>
            <Button variant="ghost" size="sm" disabled={importing} onClick={() => { void choose() }}><FolderOpen />Escolher pasta…</Button>
          </div>
        </div>
      </div>
    </div>
  </UsageCard>
}
