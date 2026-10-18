import { useEffect, useState } from 'react'
import { ChevronDown, Eye, FilePen, ListChecks, ShieldOff, type LucideIcon } from 'lucide-react'
import type { AgentSelection, Provider } from '../../../../shared/agents'
import { DropdownMenu, DropdownMenuRadioItem, ToolbarChip } from '../ui'

type Mode = AgentSelection['permissionMode']

interface Option { readonly id: Mode; readonly label: string; readonly description: (provider: Provider) => string; readonly icon: LucideIcon }

/** landing-options.ts PERMISSION_PICKER_OPTIONS, mapped to the modes Prism's agents run. */
const OPTIONS: readonly Option[] = [
  { id: 'default', label: 'Supervisionado', icon: Eye,
    description: (p) => p === 'codex' ? 'Somente leitura. Pede aprovação para comandos e alterações.' : 'Pergunta antes de cada comando e alteração de arquivo.' },
  { id: 'plan', label: 'Planejar', icon: ListChecks, description: () => 'Somente leitura. O agente planeja sem alterar arquivos.' },
  { id: 'acceptEdits', label: 'Aceitar edições', icon: FilePen, description: () => 'Edições na pasta de trabalho passam direto. Acessos adicionais pedem aprovação.' },
  { id: 'bypassPermissions', label: 'Acesso total', icon: ShieldOff, description: () => 'Executa tudo. Nada pergunta.' }
]

/** Traycer's PermissionsPicker: shield chip + radio menu with descriptions. */
export default function PermissionPicker({ value, provider, disabled, onChange, onCloseFocus }: {
  value: Mode
  provider: Provider
  disabled: boolean
  onChange: (next: Mode) => void
  onCloseFocus: () => void
}) {
  const current = OPTIONS.find((o) => o.id === value) ?? OPTIONS[0]
  const Icon = current.icon
  // Read-only conversations lock the access mode; active turns keep the picker available.
  const [open, setOpen] = useState(false)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <DropdownMenu align="start" className="tpm-menu" label="Permissões" onCloseAutoFocus={onCloseFocus}
    open={open && !disabled} onOpenChange={(next) => setOpen(next && !disabled)}
    trigger={<ToolbarChip className="tpm-trigger" aria-label={current.label} disabled={disabled}>
      <Icon size={16} />
      <span className="tpm-trigger-label tr-truncate">{current.label}</span>
      <ChevronDown size={14} className="tpm-trigger-chevron" />
    </ToolbarChip>}>
    {OPTIONS.map((option) => {
      const OptionIcon = option.icon
      return <DropdownMenuRadioItem key={option.id} checked={option.id === value} className="tpm-item" onSelect={() => onChange(option.id)}>
        <OptionIcon size={16} className="tpm-item-icon" />
        <span className="tpm-item-body">
          <span className="tpm-item-label">{option.label}</span>
          <span className="tpm-item-description">{option.description(provider)}</span>
        </span>
      </DropdownMenuRadioItem>
    })}
  </DropdownMenu>
}
