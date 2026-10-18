import { useStore } from '../../../store'
import { Switch } from '../../ui'
import { COPY, sectionMeta } from '../definitions'
import { SettingsGroup, SettingsGroupStack, SettingsPanelShell, SettingsRow } from '../layout'

const META = sectionMeta('notifications')

/** Which agent events Prism surfaces (notifications-settings-panel.tsx severity rows). */
export function NotificationsSettingsPanel() {
  const notifyOnAsk = useStore((s) => s.settings.notifyOnAsk)
  const notifyOnDone = useStore((s) => s.settings.notifyOnDone)
  const updateSetting = useStore((s) => s.updateSetting)
  return <SettingsPanelShell title={META.label} description={META.description} plainBody>
    <SettingsGroupStack>
      <SettingsGroup title={COPY.notifications.inApp} anchor="notifications-in-app">
        <SettingsRow anchor="notifications-needs-action" label={COPY.notifications.needsAction.label} description={COPY.notifications.needsAction.description}
          control={<Switch checked={notifyOnAsk} onCheckedChange={(v) => updateSetting('notifyOnAsk', v)} aria-label={`Notificar: ${COPY.notifications.needsAction.label}`} />} />
        <SettingsRow anchor="notifications-done" label={COPY.notifications.done.label} description={COPY.notifications.done.description}
          control={<Switch checked={notifyOnDone} onCheckedChange={(v) => updateSetting('notifyOnDone', v)} aria-label={`Notificar: ${COPY.notifications.done.label}`} />} />
      </SettingsGroup>
    </SettingsGroupStack>
  </SettingsPanelShell>
}
