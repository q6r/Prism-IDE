import { useEffect, useState } from 'react'
import type { AgentModel } from '../../../../../shared/agents'
import { useStore } from '../../../store'
import { Button, Select } from '../../ui'
import { COPY, sectionMeta, type SettingsSectionId } from '../definitions'
import { SettingsGroup, SettingsGroupStack, SettingsPanelShell, SettingsRow } from '../layout'

const META = sectionMeta('general')

/** General (general-settings-panel.tsx): how new agent chats start, and where accounts live. */
export function GeneralSettingsPanel({ onNavigate }: { onNavigate: (section: SettingsSectionId) => void }) {
  const model = useStore((s) => s.settings.model)
  const updateSetting = useStore((s) => s.updateSetting)
  const [catalog, setCatalog] = useState<AgentModel[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let live = true
    window.prism.providers.models('claude', 'ambient-claude')
      .then((list) => { if (live) setCatalog(list) })
      .catch(() => undefined)
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])
  // A stored model the catalog no longer lists stays selectable rather than silently changing.
  const options = [
    { value: '', label: 'Padrão da conta' },
    ...(model && !catalog.some((m) => m.id === model) ? [{ value: model, label: model }] : []),
    ...catalog.map((m) => ({ value: m.id, label: m.label }))
  ]
  return <SettingsPanelShell title={META.label} description={META.description} plainBody>
    <SettingsGroupStack>
      <SettingsGroup title={COPY.general.agents} anchor="general-agents">
        <SettingsRow anchor="general-model" label={COPY.general.model.label} description={COPY.general.model.description} controlSpansLine
          control={<Select size="sm" ariaLabel="Modelo inicial" className="stg-select" value={model} options={options}
            placeholder={loading ? 'Carregando modelos' : 'Padrão da conta'} onValueChange={(v) => updateSetting('model', v)} />} />
        <SettingsRow anchor="general-accounts" label={COPY.general.accounts.label} description={COPY.general.accounts.description}
          control={<Button variant="outline" size="sm" onClick={() => onNavigate('providers')}>Gerenciar contas</Button>} />
      </SettingsGroup>
    </SettingsGroupStack>
  </SettingsPanelShell>
}
