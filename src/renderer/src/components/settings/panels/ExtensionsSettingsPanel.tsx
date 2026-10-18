import { useEffect, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useStore } from '../../../store'
import { Badge, Button, Switch, type BadgeVariant } from '../../ui'
import { COPY, sectionMeta } from '../definitions'
import { SettingsGroup, SettingsGroupStack, SettingsPanelShell, SettingsRow } from '../layout'

const META = sectionMeta('extensions')
const DISCORD_ID = 'discord-presence'

/** pt-BR copy for the presence fields; the main process ships the schema in English. */
const FIELD_COPY: Record<string, { label: string; help?: string }> = {
  showFileName: { label: 'Mostrar nome do arquivo' },
  showWorkspace: { label: 'Mostrar workspace' },
  showElapsed: { label: 'Mostrar tempo decorrido' },
  detailsTemplate: { label: 'Texto de detalhes', help: 'Primeira linha abaixo de Prism IDE. Deixe em branco para ocultar.' },
  stateTemplate: { label: 'Texto de atividade', help: 'Segunda linha. Exemplo: {action} {file} in {folder}. Deixe em branco para ocultar.' },
  idleTemplate: { label: 'Texto sem arquivo', help: 'Exibido quando nenhum arquivo está aberto.' },
  largeImageTemplate: { label: 'Dica do ícone do Prism' },
  viewingText: { label: 'Rótulo de visualização' },
  workingText: { label: 'Rótulo de edição', help: 'Usado por {action} durante a edição e por 10 segundos após a última edição.' }
}

const STATUS: Record<string, { text: string; variant: BadgeVariant }> = {
  connected: { text: 'Conectado', variant: 'success' },
  connecting: { text: 'Conectando', variant: 'muted' },
  offline: { text: 'Discord fechado', variant: 'warning' },
  'needs-config': { text: 'Requer configuração', variant: 'warning' },
  error: { text: 'Erro', variant: 'destructive' }
}

const VARIABLES: readonly [string, string][] = [
  ['{workspace}', 'nome do workspace'],
  ['{file}', 'nome do arquivo'],
  ['{folder}', 'pasta pai (ex.: auth em src/auth/auth.ts)'],
  ['{relativePath}', 'caminho relativo ao workspace'],
  ['{language}', 'linguagem'],
  ['{action}', 'Viewing / Working'],
  ['{problems}', 'erros e avisos nos arquivos abertos'],
  ['{problemWord}', 'problem / problems'],
  ['{dirty}', 'Saved / Unsaved']
]

/** Optional integrations; today the Discord Rich Presence. */
export function ExtensionsSettingsPanel() {
  const discord = useStore((s) => s.extensions.find((e) => e.id === DISCORD_ID))
  const setExtEnabled = useStore((s) => s.setExtEnabled)
  const setExtConfig = useStore((s) => s.setExtConfig)
  if (!discord) {
    return <SettingsPanelShell title={META.label} description={META.description}>
      <div className="stg-empty">Nenhuma extensão disponível.</div>
    </SettingsPanelShell>
  }
  const status = discord.enabled ? STATUS[discord.status] : undefined
  const save = (patch: Record<string, unknown>): void => { void setExtConfig(DISCORD_ID, patch) }
  return <SettingsPanelShell title={META.label} description={META.description} plainBody>
    <SettingsGroupStack>
      <SettingsGroup title={COPY.extensions.discord.label} anchor="extensions-discord-group">
        <SettingsRow anchor="extensions-discord" label={COPY.extensions.discord.label}
          labelStatus={status ? <Badge variant={status.variant} size="xs">{status.text}</Badge> : undefined}
          description={COPY.extensions.discord.description}
          hint={discord.enabled && discord.detail && (discord.status === 'error' || discord.status === 'offline' || discord.status === 'needs-config') ? discord.detail : undefined}
          control={<Switch checked={discord.enabled} onCheckedChange={(v) => void setExtEnabled(DISCORD_ID, v)} aria-label={COPY.extensions.discord.label} />} />
        {discord.enabled ? discord.configSchema.filter((f) => f.type === 'boolean').map((f) => {
          const copy = FIELD_COPY[f.key]
          return <SettingsRow key={f.key} label={copy?.label ?? f.label} description={copy?.help ?? f.help}
            control={<Switch checked={discord.config[f.key] !== false} onCheckedChange={(v) => save({ [f.key]: v })} aria-label={copy?.label ?? f.label} />} />
        }) : null}
        {discord.enabled ? <SettingsRow anchor="extensions-discord-reset" label={COPY.extensions.reset.label} description={COPY.extensions.reset.description}
          control={<Button variant="outline" size="sm" onClick={() => save(discord.defaultConfig)}><RotateCcw />Restaurar padrões</Button>} /> : null}
      </SettingsGroup>
      {discord.enabled ? <SettingsGroup title={COPY.extensions.texts.label} anchor="extensions-discord-texts">
        <div className="stg-note">
          <p>Variáveis disponíveis nos textos. {COPY.extensions.texts.description}</p>
          <ul className="stg-variables">
            {VARIABLES.map(([name, meaning]) => <li key={name}><code>{name}</code><span>{meaning}</span></li>)}
          </ul>
          <p>O Discord limita cada texto a 128 caracteres. Variáveis desconhecidas continuam visíveis. Ocultar o arquivo ou o workspace também esconde as variáveis correspondentes.</p>
        </div>
        {discord.configSchema.filter((f) => f.type === 'text').map((f) => {
          const copy = FIELD_COPY[f.key]
          return <PresenceTextRow key={f.key} label={copy?.label ?? f.label} help={copy?.help ?? f.help} placeholder={f.placeholder}
            value={String(discord.config[f.key] ?? '')} onSave={(value) => save({ [f.key]: value })} />
        })}
      </SettingsGroup> : null}
    </SettingsGroupStack>
  </SettingsPanelShell>
}

const SAVE_DELAY_MS = 600

/**
 * A template field: saved a moment after typing stops, on blur or Enter, and
 * on unmount, so closing Settings with Escape never drops what was typed. The
 * stored value only replaces the draft while the field is not being edited.
 */
function PresenceTextRow({ label, help, placeholder, value, onSave }: { label: string; help?: string; placeholder?: string; value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  const input = useRef<HTMLInputElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef({ draft, value, onSave })
  latest.current = { draft, value, onSave }
  const flush = (): void => {
    clearTimeout(timer.current)
    timer.current = undefined
    const { draft: text, value: saved, onSave: save } = latest.current
    if (text !== saved) save(text)
  }
  useEffect(() => { if (document.activeElement !== input.current && timer.current === undefined) setDraft(value) }, [value])
  useEffect(() => () => flush(), [])
  return <SettingsRow label={label} description={help} controlSpansLine
    control={<input ref={input} className="tr-input stg-text-input" value={draft} placeholder={placeholder} aria-label={label} spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value)
        latest.current = { ...latest.current, draft: e.target.value }
        clearTimeout(timer.current)
        timer.current = setTimeout(flush, SAVE_DELAY_MS)
      }}
      onBlur={flush}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />} />
}
