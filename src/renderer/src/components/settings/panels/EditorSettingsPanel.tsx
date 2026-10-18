import { useStore } from '../../../store'
import { Switch } from '../../ui'
import { COPY, sectionMeta } from '../definitions'
import { SettingsGroup, SettingsGroupStack, SettingsNumberInput, SettingsPanelShell, SettingsRow } from '../layout'

const META = sectionMeta('editor')
const DEFAULT_FONT_SIZE = 14
const DEFAULT_TAB_SIZE = 2

/** The code editor's text and saving behavior. */
export function EditorSettingsPanel() {
  const fontSize = useStore((s) => s.settings.fontSize)
  const tabSize = useStore((s) => s.settings.tabSize)
  const wordWrap = useStore((s) => s.settings.wordWrap)
  const autoSave = useStore((s) => s.settings.autoSave)
  const updateSetting = useStore((s) => s.updateSetting)
  return <SettingsPanelShell title={META.label} description={META.description} plainBody>
    <SettingsGroupStack>
      <SettingsGroup title={COPY.editor.text} anchor="editor-text">
        <SettingsRow anchor="editor-font-size" label={COPY.editor.fontSize.label} description={COPY.editor.fontSize.description}
          control={<SettingsNumberInput value={fontSize} min={10} max={28} unit="px" ariaLabel={COPY.editor.fontSize.label}
            defaultValue={DEFAULT_FONT_SIZE} onChange={(v) => updateSetting('fontSize', v)} />} />
        <SettingsRow anchor="editor-tab-size" label={COPY.editor.tabSize.label} description={COPY.editor.tabSize.description}
          control={<SettingsNumberInput value={tabSize} min={1} max={8} unit="espaços" ariaLabel={COPY.editor.tabSize.label}
            defaultValue={DEFAULT_TAB_SIZE} onChange={(v) => updateSetting('tabSize', v)} />} />
      </SettingsGroup>
      <SettingsGroup title={COPY.editor.behavior} anchor="editor-behavior">
        <SettingsRow anchor="editor-word-wrap" label={COPY.editor.wordWrap.label} description={COPY.editor.wordWrap.description}
          control={<Switch checked={wordWrap} onCheckedChange={(v) => updateSetting('wordWrap', v)} aria-label={COPY.editor.wordWrap.label} />} />
        <SettingsRow anchor="editor-auto-save" label={COPY.editor.autoSave.label} description={COPY.editor.autoSave.description}
          control={<Switch checked={autoSave} onCheckedChange={(v) => updateSetting('autoSave', v)} aria-label={COPY.editor.autoSave.label} />} />
      </SettingsGroup>
    </SettingsGroupStack>
  </SettingsPanelShell>
}
