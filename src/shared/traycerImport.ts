import type { Provider, SharedSegment, SharedTurn } from './agents'

export interface TraycerImportPreview {
  root: string
  /** `imported`: already a Prism profile; `linked`: that profile already runs on this Traycer login. */
  profiles: { id: string; provider: Provider; name: string; credentialsAvailable: boolean; ambient: boolean; imported?: boolean; linked?: boolean }[]
  chats: { id: string; epicId: string; title: string; parentId?: string; unsupportedHarness?: string; taskTitle?: string; archived?: boolean; provider: Provider; profileId: string; updatedAt: number; messageCount: number; imported: boolean }[]
  warnings: string[]
}
export interface TraycerImportRequest {
  root: string
  profileIds: string[]
  chatIds: string[]
  copyCredentials: boolean
  /** "Atualizar do Traycer": refresh the history of chats already imported,
   * but only those still untouched in Prism (`reimportTraycerChat`). */
  refreshHistory?: boolean
}
export interface TraycerImportResult { profiles: number; chats: number; updated: number; credentials: number; skipped: number; warnings: string[] }

// Traycer persists TipTap documents for user messages and structured blocks for
// replies. Only visible context is migrated; native sessions are never resumed.
type RecordValue = Record<string, any>
export function documentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  if (Array.isArray(value)) return value.map(documentText).join('')
  const node = value as RecordValue
  if (node.type === 'hardBreak') return '\n'
  if (typeof node.text === 'string') return node.text
  const content = documentText(node.content)
  if (['paragraph', 'heading', 'listItem', 'codeBlock'].includes(node.type)) return content + '\n'
  if (!content && node.type === 'image') return '[Imagem anexada no Traycer]'
  if (!content && node.attrs?.label) return String(node.attrs.label)
  return content
}
function readable(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value)
}
export function traycerTurn(message: RecordValue, provider: Provider): SharedTurn | null {
  if (!['user', 'assistant', 'system'].includes(message.role)) return null
  const role = message.role === 'assistant' ? 'assistant' : 'user'
  const segments: SharedSegment[] = []
  for (const b of Array.isArray(message.blocks) ? message.blocks : []) {
    if (b.type === 'reasoning') continue
    if (b.type === 'text' || b.type === 'error' || b.type === 'compaction' || b.type === 'steer') {
      const text = b.type === 'error' ? b.message : b.type === 'compaction' ? b.summary : b.type === 'steer' ? documentText(b.content) : b.text
      if (text) segments.push({ kind: 'text', text })
    } else if (b.type === 'tool_call' || b.type === 'command' || b.type === 'file_change') {
      const failed = b.status === 'errored' || b.status === 'error' || !!b.error
      const interrupted = ['streaming', 'pending', 'running'].includes(b.status) || b.stopped
      segments.push({ kind: 'tool', toolId: b.blockId, name: b.toolName || (b.type === 'command' ? 'Bash' : 'FileChange'),
        input: b.type === 'command' ? { command: b.command, cwd: b.cwd } : b.type === 'file_change'
          ? { filePath: b.filePath, operation: b.operation, additions: b.additions, deletions: b.deletions }
          : b.inputDetail ?? b.inputSummary ?? '[Entrada não persistida pelo Traycer]',
        result: readable(b.output ?? b.result ?? b.backgroundOutput ?? b.error) || (b.type === 'command' && b.exitCode != null
          ? `Comando encerrado com código ${b.exitCode}. Saída não persistida pelo Traycer.`
          : interrupted ? 'Execução interrompida ou ainda ativa no Traycer; confira o estado antes de repetir.'
          : 'Ação registrada no Traycer. O resultado completo não foi persistido; confira o estado antes de repetir.'),
        resultIsError: failed || interrupted, status: failed || interrupted ? 'error' : 'done' })
    } else if (b.type === 'interview') {
      segments.push({ kind: 'text', text: `[Perguntas do Traycer]\n${readable(b.questions)}\nRespostas: ${readable(b.answers)}` })
    } else {
      segments.push({ kind: 'text', text: `[Registro ${String(b.type || 'desconhecido')} do Traycer]\n${readable(b)}` })
    }
  }
  const text = segments.length ? '' : documentText(message.message?.content ?? message.content).trim()
  if (!text && !segments.length) return null
  return { id: String(message.messageId), role, text, segments: segments.length ? segments : undefined,
    provider: role === 'assistant' ? provider : undefined,
    profileName: message.turnProfile?.labelSnapshot || undefined,
    error: message.blocks?.some((b: RecordValue) => b.type === 'error') || false,
    interrupted: message.blocks?.some((b: RecordValue) => ['streaming', 'running', 'pending'].includes(b.status)) || false }
}

// Records form a forest, not a list of turns. Missing parents and malformed
// cycles remain visible as roots; siblings never move to a different task.
export function chatForest<T extends { id: string; parentChatId?: string }>(items: T[]): { item: T; depth: number; hasChildren: boolean }[] {
  const ids = new Set(items.map(i => i.id)), children = new Map<string, T[]>()
  const roots: T[] = []
  for (const item of items) {
    if (!item.parentChatId || item.parentChatId === item.id || !ids.has(item.parentChatId)) roots.push(item)
    else children.set(item.parentChatId, [...(children.get(item.parentChatId) || []), item])
  }
  const seen = new Set<string>(), rows: { item: T; depth: number; hasChildren: boolean }[] = []
  function visit(root: T): void {
    const stack = [{ item: root, depth: 0 }]
    while (stack.length) {
      const row = stack.pop()!
      if (seen.has(row.item.id)) continue
      seen.add(row.item.id)
      const nested = children.get(row.item.id) || []
      rows.push({ ...row, hasChildren: nested.length > 0 })
      for (let i = nested.length - 1; i >= 0; i--) stack.push({ item: nested[i], depth: row.depth + 1 })
    }
  }
  roots.forEach(visit); items.forEach(visit)
  return rows
}
export interface TraycerAgentRecord {
  id: string; parentChatId?: string; title: string; harness: string; archived: boolean
  surface: string; active: boolean | null; sessionState: string | null; hostId?: string; model?: string
}
export interface TraycerTaskRecord { id: string; title: string; count: number }
export interface TraycerActivity { taskId: string; checkedAt: number; agents: TraycerAgentRecord[]; error?: string }

export function withChatAncestors<T extends {id:string;parentChatId?:string}>(items:T[],matches:(item:T)=>boolean):T[] {
  const map=new Map(items.map(i=>[i.id,i])), keep=new Set(items.filter(matches).map(i=>i.id))
  for(const id of [...keep]) {
    let parent=map.get(id)?.parentChatId
    const seen=new Set<string>([id])
    while(parent && !seen.has(parent)) {seen.add(parent);if(!map.has(parent))break;keep.add(parent);parent=map.get(parent)?.parentChatId}
  }
  return items.filter(i=>keep.has(i.id))
}
