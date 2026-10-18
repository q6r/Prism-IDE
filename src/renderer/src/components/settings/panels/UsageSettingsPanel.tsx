import { useState } from 'react'
import { sectionMeta } from '../definitions'
import { RefreshIconButton, SettingsPanelShell } from '../layout'
import { UsageDashboard } from '../../usage/UsageDashboard'
import { ImportTraycerButton, useImportTraycer } from '../../usage/UsageSources'
import { useUsageData } from '../../usage/useUsageData'
import '../../../styles/usage.css'

const META = sectionMeta('usage')

/**
 * Settings ▸ Uso (Traycer's usage-settings-panel). Loaded on demand by the
 * modal, so the dashboard, ECharts and html-to-image stay out of the main
 * bundle. The header carries the Traycer import and a refresh.
 */
export default function UsageSettingsPanel() {
  const data = useUsageData()
  const runImport = useImportTraycer(data.importTraycer)
  const [now] = useState(() => Date.now())
  return <SettingsPanelShell title={META.label} description={META.description} plainBody
    headerAction={<div className="usg-header-actions">
      <ImportTraycerButton state={data.importState} importing={data.importing} onImport={() => { void runImport() }} now={data.loadedAt ?? now} />
      <RefreshIconButton label="Atualizar uso" onRefresh={data.reload} refreshing={data.refreshing} />
    </div>}>
    <UsageDashboard data={data} onImport={(root) => { void runImport(root) }} />
  </SettingsPanelShell>
}
