// Settings sections, their groups and the search index (Traycer's
// lib/settings-sections.ts + lib/settings-search/*). Pure data and functions:
// no React, no icons (those live in sections.tsx), so tests load it directly.

export type SettingsSectionId = 'general' | 'appearance' | 'editor' | 'extensions' | 'providers' | 'usage' | 'notifications'
export type SettingsGroupId = 'app' | 'agents'

export interface SettingsSectionGroup { readonly id: SettingsGroupId; readonly label: string }
export interface SettingsSectionMeta {
  readonly id: SettingsSectionId
  readonly label: string
  readonly group: SettingsGroupId
  readonly description: string
}

/** Scope headings of the rail, in order (Traycer's "Application" / "Host"). */
export const SETTINGS_SECTION_GROUPS: readonly SettingsSectionGroup[] = [
  { id: 'app', label: 'Aplicativo' },
  { id: 'agents', label: 'Agentes' }
]

/** Rail order; entries stay contiguous per group. Ids are a compatibility surface (openSettings('providers')). */
export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  { id: 'general', label: 'Geral', group: 'app', description: 'Comportamento do app e das conversas com agentes.' },
  { id: 'appearance', label: 'Aparência', group: 'app', description: 'Temas, movimento e preferências de exibição.' },
  { id: 'editor', label: 'Editor', group: 'app', description: 'Texto, tabulação e salvamento no editor de código.' },
  { id: 'extensions', label: 'Extensões', group: 'app', description: 'Integrações opcionais que rodam junto do Prism.' },
  { id: 'providers', label: 'Provedores', group: 'agents', description: 'Conecte as contas de Claude Code e Codex. Escolha a conta de cada conversa sem sair das outras; cada conversa mantém a conta e o modelo escolhidos.' },
  { id: 'usage', label: 'Uso', group: 'agents', description: 'Uso de tokens e custo dos seus agentes.' },
  { id: 'notifications', label: 'Notificações', group: 'agents', description: 'Quais eventos o Prism avisa enquanto o app está em segundo plano. Gerencie banners nas configurações de notificação do sistema operacional.' }
]

export function isSettingsSectionId(value: string | null | undefined): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((s) => s.id === value)
}

/** The remembered section can name one this build no longer offers; that falls back to General. */
export function resolveSettingsSection(value: string | null | undefined): SettingsSectionId {
  return isSettingsSectionId(value) ? value : 'general'
}

export function sectionMeta(id: SettingsSectionId): SettingsSectionMeta {
  return SETTINGS_SECTIONS.find((s) => s.id === id) ?? SETTINGS_SECTIONS[0]
}

/* ------------------------------------------------------------------ */
/* Search index                                                        */
/* ------------------------------------------------------------------ */

export type SettingsSearchEntryKind = 'section' | 'group' | 'setting'
export interface SettingsSearchEntry {
  readonly kind: SettingsSearchEntryKind
  readonly section: SettingsSectionId
  readonly label: string
  /** The group inside the page, for the breadcrumb (null for pages and groups). */
  readonly group: string | null
  readonly description: string | null
  readonly keywords: readonly string[]
  /** `data-settings-anchor` the result scrolls to; null lands on the page top. */
  readonly anchor: string | null
}

const page = (section: SettingsSectionId, keywords: string[]): SettingsSearchEntry => {
  const meta = sectionMeta(section)
  return { kind: 'section', section, label: meta.label, group: null, description: meta.description, keywords, anchor: null }
}
const group = (section: SettingsSectionId, label: string, anchor: string, keywords: string[] = []): SettingsSearchEntry =>
  ({ kind: 'group', section, label, group: null, description: null, keywords, anchor })
const row = (section: SettingsSectionId, groupLabel: string, label: string, anchor: string, description: string | null, keywords: string[] = []): SettingsSearchEntry =>
  ({ kind: 'setting', section, label, group: groupLabel, description, keywords, anchor })

/** Copy shared by the panels and the index, so a result and the row it lands on say the same thing. */
export const COPY = {
  general: {
    agents: 'Agentes',
    model: { label: 'Modelo inicial', description: 'Modelo inicial para novos chats do Claude; altere por conversa quando quiser.' },
    accounts: { label: 'Contas de agentes', description: 'As contas de Claude Code e Codex ficam em Provedores. Cada conversa mantém a conta e o modelo escolhidos.' }
  },
  appearance: {
    themes: { label: 'Temas', description: 'Os temas claros e escuros e qual está em uso.' },
    theme: { label: 'Tema', description: 'A paleta usada em toda a interface, no editor e no terminal.' },
    interface: { label: 'Interface', description: 'Movimento e efeitos em todo o app.' },
    animations: { label: 'Animações', description: 'Transições e efeitos pela interface. Desligue para uma experiência mais direta.' }
  },
  editor: {
    text: 'Texto',
    fontSize: { label: 'Tamanho da fonte', description: 'Tamanho do texto no editor de código.' },
    tabSize: { label: 'Tamanho da tabulação', description: 'Quantos espaços uma tabulação ocupa.' },
    behavior: 'Comportamento',
    wordWrap: { label: 'Quebra de linha', description: 'Quebra linhas longas na largura do editor.' },
    autoSave: { label: 'Salvar automaticamente', description: 'Grava o arquivo sozinho enquanto você digita. Também em Arquivo → Salvar automaticamente.' }
  },
  extensions: {
    discord: { label: 'Discord Rich Presence', description: 'Mostre no seu perfil o que você está editando. Mantenha o Discord aberto.' },
    texts: { label: 'Textos da presença', description: 'Salvos automaticamente enquanto você digita.' },
    reset: { label: 'Restaurar padrões', description: 'Volta todos os textos e opções da presença para os valores originais.' }
  },
  notifications: {
    inApp: 'Notificações no app',
    needsAction: { label: 'Precisa de ação', description: 'Pedidos de permissão e perguntas do agente.' },
    done: { label: 'Concluído', description: 'Turnos concluídos: notifica, pisca a barra de tarefas e conta as conversas concluídas.' }
  },
  providers: {
    profiles: { label: 'Perfis', description: 'Contas conectadas de cada provedor, com login separado por perfil.' },
    usage: { label: 'Limites de uso', description: 'Uso da sessão atual e da janela semanal de cada perfil.' },
    addProfile: { label: 'Adicionar perfil', description: 'Conecte outra assinatura sem sair das contas atuais.' },
    importTraycer: { label: 'Importar do Traycer', description: 'Traga conversas do Traycer para o Prism.' },
    cli: { label: 'CLI', description: 'Instalação do CLI de cada provedor.' }
  },
  usage: {
    chart: { label: 'Gráfico de uso', description: 'Uso por dia, hora ou semana, agrupado por provedor, modelo, conta, projeto, tarefa ou origem.' },
    activity: { label: 'Atividade', description: 'Calendário dos últimos 12 meses e os horários de mais uso.' },
    limits: { label: 'Limites das contas', description: 'As janelas de uso atuais de cada conta conectada.' },
    breakdown: { label: 'Detalhamento', description: 'Turnos, tokens, custo e tempo por grupo, e os chats com mais uso.' },
    export: { label: 'Exportar uso', description: 'Copie ou salve o resumo como imagem, ou exporte os turnos em CSV ou JSON.' },
    importTraycer: { label: 'Importar uso do Traycer', description: 'Traga o histórico de uso do Traycer para o Prism, sem alterar o Traycer.' }
  }
} as const

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  page('general', ['preferências', 'opções', 'diversos']),
  group('general', COPY.general.agents, 'general-agents', ['conversas', 'chat']),
  row('general', COPY.general.agents, COPY.general.model.label, 'general-model', COPY.general.model.description, ['modelo', 'claude', 'opus', 'sonnet', 'haiku', 'padrão']),
  row('general', COPY.general.agents, COPY.general.accounts.label, 'general-accounts', COPY.general.accounts.description, ['contas', 'login', 'assinatura']),

  page('appearance', ['visual', 'estilo', 'tema', 'modo escuro', 'modo claro', 'paleta', 'cores']),
  group('appearance', COPY.appearance.themes.label, 'appearance-themes', ['paleta', 'cores', 'esquema de cores']),
  row('appearance', COPY.appearance.themes.label, COPY.appearance.theme.label, 'appearance-theme', COPY.appearance.theme.description,
    ['modo escuro', 'modo claro', 'dark', 'light', 'ocean', 'nord', 'evergreen', 'amethyst', 'sepia', 'daylight', 'neutral', 'rosa']),
  group('appearance', COPY.appearance.interface.label, 'appearance-interface', ['movimento']),
  row('appearance', COPY.appearance.interface.label, COPY.appearance.animations.label, 'appearance-animations', COPY.appearance.animations.description,
    ['movimento', 'transições', 'efeitos', 'reduzir movimento']),

  page('editor', ['código', 'monaco']),
  group('editor', COPY.editor.text, 'editor-text', ['fonte', 'tipografia']),
  row('editor', COPY.editor.text, COPY.editor.fontSize.label, 'editor-font-size', COPY.editor.fontSize.description, ['fonte', 'tamanho', 'zoom', 'texto']),
  row('editor', COPY.editor.text, COPY.editor.tabSize.label, 'editor-tab-size', COPY.editor.tabSize.description, ['tab', 'espaços', 'indentação', 'recuo']),
  group('editor', COPY.editor.behavior, 'editor-behavior'),
  row('editor', COPY.editor.behavior, COPY.editor.wordWrap.label, 'editor-word-wrap', COPY.editor.wordWrap.description, ['word wrap', 'linhas longas']),
  row('editor', COPY.editor.behavior, COPY.editor.autoSave.label, 'editor-auto-save', COPY.editor.autoSave.description, ['auto save', 'salvar', 'gravar']),

  page('extensions', ['plugins', 'integrações']),
  row('extensions', COPY.extensions.discord.label, COPY.extensions.discord.label, 'extensions-discord', COPY.extensions.discord.description, ['discord', 'rpc', 'presença', 'status']),
  group('extensions', COPY.extensions.texts.label, 'extensions-discord-texts', ['discord', 'variáveis', 'detalhes', 'estado']),
  row('extensions', COPY.extensions.discord.label, COPY.extensions.reset.label, 'extensions-discord-reset', COPY.extensions.reset.description, ['discord', 'padrão', 'resetar']),

  page('providers', ['contas', 'claude code', 'codex', 'login', 'assinatura', 'agentes']),
  row('providers', COPY.providers.profiles.label, COPY.providers.profiles.label, 'providers-profiles', COPY.providers.profiles.description,
    ['contas', 'login', 'entrar', 'assinatura', 'cor', 'renomear', 'ativar', 'desativar']),
  row('providers', COPY.providers.profiles.label, COPY.providers.usage.label, 'providers-usage', COPY.providers.usage.description,
    ['uso', 'cota', 'limite', 'sessão', 'semanal', 'rate limit']),
  row('providers', COPY.providers.profiles.label, COPY.providers.addProfile.label, 'providers-add-profile', COPY.providers.addProfile.description, ['nova conta', 'adicionar conta']),
  row('providers', COPY.providers.profiles.label, COPY.providers.importTraycer.label, 'providers-import', COPY.providers.importTraycer.description, ['traycer', 'importar', 'conversas']),
  row('providers', COPY.providers.cli.label, COPY.providers.cli.label, 'providers-cli', COPY.providers.cli.description, ['instalar', 'binário', 'terminal']),

  page('usage', ['tokens', 'custo', 'gastos', 'consumo', 'cobrança', 'créditos', 'cota', 'análise', 'estatísticas', 'dashboard']),
  row('usage', COPY.usage.chart.label, COPY.usage.chart.label, 'usage-chart', COPY.usage.chart.description, ['gráfico', 'por dia', 'por modelo', 'comparar', 'período anterior']),
  row('usage', COPY.usage.activity.label, COPY.usage.activity.label, 'usage-activity', COPY.usage.activity.description, ['calendário', 'mapa de calor', 'sequência', 'horário']),
  row('usage', COPY.usage.limits.label, COPY.usage.limits.label, 'usage-limits', COPY.usage.limits.description, ['limite', 'janela', 'rate limit', 'semanal']),
  row('usage', COPY.usage.breakdown.label, COPY.usage.breakdown.label, 'usage-breakdown', COPY.usage.breakdown.description, ['tabela', 'chats', 'turnos', 'por conta']),
  row('usage', COPY.usage.export.label, COPY.usage.export.label, 'usage-export', COPY.usage.export.description, ['imagem', 'png', 'csv', 'json', 'copiar', 'compartilhar']),
  row('usage', COPY.usage.importTraycer.label, COPY.usage.importTraycer.label, 'usage-sources', COPY.usage.importTraycer.description, ['traycer', 'importar', 'histórico']),

  page('notifications', ['avisos', 'alertas', 'barra de tarefas']),
  group('notifications', COPY.notifications.inApp, 'notifications-in-app'),
  row('notifications', COPY.notifications.inApp, COPY.notifications.needsAction.label, 'notifications-needs-action', COPY.notifications.needsAction.description, ['permissão', 'pergunta', 'aprovação']),
  row('notifications', COPY.notifications.inApp, COPY.notifications.done.label, 'notifications-done', COPY.notifications.done.description, ['concluída', 'tarefa', 'terminou'])
]

export interface SettingsSearchResult {
  readonly entry: SettingsSearchEntry
  /** The page's own name, for the breadcrumb. */
  readonly sectionLabel: string
  /** "Aplicativo" / "Agentes": which scope the page belongs to. */
  readonly scopeLabel: string
}

/** How many hits the result list shows (a relevance limit, not a layout one). */
export const MAX_SETTINGS_RESULTS = 12

/** Field weights: what a row calls itself dominates; a description shares words with anything. */
const WEIGHTS = { label: 1, keywords: 0.55, group: 0.25, sectionLabel: 0.2, scopeLabel: 0.12, description: 0.12 } as const
/** Near-ties go to the more specific kind (the row is what the user came to change). */
const KIND_FACTOR: Record<SettingsSearchEntryKind, number> = { setting: 1.04, group: 1.02, section: 1 }

/** Lowercase, accent-free text, so "notificacoes" finds "Notificações". */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** The one definition of "searching": the rail hides its sections while a query is non-blank. */
export function isSettingsSearchActive(query: string): boolean {
  return query.trim().length > 0
}

/**
 * 1 for a word-prefix hit, 0.8 for a substring, up to 0.45 for a tight
 * in-order letter match (only when `fuzzy`, needle ≥ 3 letters, and the
 * letters span at most twice the needle's length), 0 for none.
 */
export function matchStrength(haystack: string, needle: string, fuzzy = true): number {
  if (!needle) return 0
  const text = normalizeSearchText(haystack)
  if (!text) return 0
  const hit = text.indexOf(needle)
  if (hit >= 0) {
    // Any occurrence at a word start counts, not just the first one.
    for (let i = hit; i >= 0; i = text.indexOf(needle, i + 1)) {
      if (i === 0 || /[^a-z0-9]/.test(text[i - 1])) return 1
    }
    return 0.8
  }
  if (!fuzzy || needle.length < 3) return 0
  // Fuzzy: every letter in order, from the tightest start; typos like "notifcações" still land.
  let best = 0
  for (let start = text.indexOf(needle[0]); start >= 0; start = text.indexOf(needle[0], start + 1)) {
    let at = start
    for (let i = 1; i < needle.length && at >= 0; i++) at = text.indexOf(needle[i], at + 1)
    if (at < 0) break
    const span = at - start + 1
    if (span <= needle.length * 2) best = Math.max(best, 0.45 * (needle.length / span))
  }
  return best
}

function entryScore(entry: SettingsSearchEntry, tokens: readonly string[], sectionLabel: string, scopeLabel: string): number {
  // Fuzzy matching only on the short names; a sentence contains almost any letters in order.
  const fields: [keyof typeof WEIGHTS, string, boolean][] = [
    ['label', entry.label, true], ['group', entry.group ?? '', false], ['sectionLabel', sectionLabel, false],
    ['scopeLabel', scopeLabel, false], ['description', entry.description ?? '', false],
    ...entry.keywords.map((k): [keyof typeof WEIGHTS, string, boolean] => ['keywords', k, true])
  ]
  let total = 0
  for (const token of tokens) {
    let best = 0
    for (const [key, value, fuzzy] of fields) best = Math.max(best, WEIGHTS[key] * matchStrength(value, token, fuzzy))
    if (best === 0) return 0
    total += best
  }
  return (total / tokens.length) * KIND_FACTOR[entry.kind]
}

/** 0: label starts with the query; 1: label contains it; 2: anything else. */
function nameTier(label: string, query: string): number {
  const text = normalizeSearchText(label)
  if (text.startsWith(query)) return 0
  return text.includes(query) ? 1 : 2
}

/**
 * Ranks the index against `query`, best first. A blank query returns nothing:
 * the rail shows its normal section list in that state.
 */
export function searchSettings(query: string, entries: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_ENTRIES): SettingsSearchResult[] {
  const normalized = normalizeSearchText(query)
  if (!normalized) return []
  const tokens = normalized.split(/\s+/).filter(Boolean)
  const scored: { result: SettingsSearchResult; score: number; tier: number; order: number }[] = []
  entries.forEach((entry, order) => {
    const meta = sectionMeta(entry.section)
    const scopeLabel = SETTINGS_SECTION_GROUPS.find((g) => g.id === meta.group)?.label ?? ''
    const score = entryScore(entry, tokens, meta.label, scopeLabel)
    if (score <= 0) return
    scored.push({ result: { entry, sectionLabel: meta.label, scopeLabel }, score, tier: nameTier(entry.label, normalized), order })
  })
  scored.sort((a, b) => a.tier - b.tier || b.score - a.score || a.order - b.order)
  return scored.slice(0, MAX_SETTINGS_RESULTS).map((s) => s.result)
}

/** Stable key for a result: section + anchor, or the label for anchorless entries. */
export function settingsSearchResultKey(entry: SettingsSearchEntry): string {
  return `${entry.section}:${entry.anchor ?? entry.label}`
}

/** "Aplicativo › Aparência › Temas": the scope, the page and the group inside it. */
export function settingsSearchBreadcrumb(result: SettingsSearchResult): string[] {
  const parts = [result.scopeLabel, result.sectionLabel]
  if (result.entry.group && result.entry.group !== result.entry.label) parts.push(result.entry.group)
  return parts.filter((p) => p.length > 0)
}
