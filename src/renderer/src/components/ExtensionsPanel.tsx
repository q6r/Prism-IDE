import { Blocks, Settings as SettingsIcon } from 'lucide-react'
import { FaDiscord } from 'react-icons/fa6'
import { useStore } from '../store'
import { Button, Switch } from './ui'
import PanelHeader from './shell/PanelHeader'
import '../styles/shell.css'

const STATUS_LABEL: Record<string, string> = {
  connected: 'Conectado',
  connecting: 'Conectando…',
  offline: 'Discord offline',
  'needs-config': 'Falta configurar',
  error: 'Erro',
  disabled: 'Desativada'
}

function ExtIcon({ icon }: { icon: string }) {
  if (icon === 'discord') return <FaDiscord size={24} />
  return <Blocks size={24} />
}

export default function ExtensionsPanel() {
  const extensions = useStore((s) => s.extensions)
  const setExtEnabled = useStore((s) => s.setExtEnabled)

  return (
    <div className="ps-shell-ext-panel">
      <PanelHeader title="Extensões" />
      <div className="ps-shell-ext-list">
        {extensions.map((e) => (
          <div key={e.id} className="ps-shell-ext-card">
            <div className="ps-shell-ext-head">
              <div className="ps-shell-ext-icon">
                <ExtIcon icon={e.icon} />
              </div>
              <div className="ps-shell-ext-info">
                <div className="ps-shell-ext-name">
                  {e.name} <span className="ps-shell-ext-ver">v{e.version}</span>
                </div>
                <div className="ps-shell-ext-author">{e.author}</div>
              </div>
              <Switch checked={e.enabled} aria-label={`${e.enabled ? 'Desativar' : 'Ativar'} ${e.name}`} onCheckedChange={(next) => setExtEnabled(e.id, next)} />
            </div>

            <p className="ps-shell-ext-desc">{e.description}</p>

            {e.enabled && (
              <div className={'ps-shell-ext-status st-' + e.status}>
                <span className="ps-shell-dot" />
                {STATUS_LABEL[e.status] ?? e.status}
                {e.detail ? ` · ${e.detail}` : ''}
              </div>
            )}

            {e.enabled && e.configSchema.length > 0 && (
              <Button variant="link" size="xs" className="ps-shell-ext-config-link" onClick={() => useStore.getState().openSettings('extensions')}>
                <SettingsIcon size={13} /> Opções em Configurações
              </Button>
            )}
          </div>
        ))}

        <div className="ps-shell-ext-footnote">
          As opções de cada extensão ficam em Configurações (Ctrl+,). Suporte a extensões de
          terceiros chega na próxima fase.
        </div>
      </div>
    </div>
  )
}
