import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import type { AgentTask, ProviderProfile, UnifiedChat } from '../shared/agents'
import { foldJournal, type JournalEvent } from '../shared/agentJournal'
import { projectSubagent, subagentActive, subagentChatId } from '../shared/subagents'

interface AgentData { profiles: ProviderProfile[]; chats: UnifiedChat[]; tasks?: AgentTask[] }

// Transactional documents plus a native event journal. Keep the former JSON
// store as a migration backup; never remove the user's original data.
export class AgentRepository {
  private db: DatabaseSync
  private pendingEvents: { chatId: string; turnId: string; event: JournalEvent & { recordedAt: number } }[] = []
  private eventTimer?: ReturnType<typeof setTimeout>
  private inTransaction = false
  private live = new Map<string, string>()
  constructor(path: string, legacy: { get: (key: 'profiles' | 'chats') => unknown }) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,turn_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_chat ON events(chat_id,seq);`)
    if (!this.db.prepare('SELECT 1 FROM state WHERE key=?').get('migrated-json')) {
      this.transaction(() => {
        for (const key of ['profiles', 'chats'] as const) this.replace(key, legacy.get(key) as any[] || [])
        this.writeState('migrated-json', true)
      })
    }
    // There is no live native process from the previous application instance.
    const raw = this.db.prepare("SELECT body FROM documents WHERE kind='chats'").all()
    for (const row of raw) {
      const chat: UnifiedChat = JSON.parse(row.body as string)
      if (!chat.pendingTurnId) continue
      const events = this.events(chat.id).filter((e) => e.turnId === chat.pendingTurnId)
      if (events.length && !events.some((e) => e.event.kind === 'done' || e.event.kind === 'error')) {
        this.appendEvent(chat.id, chat.pendingTurnId, { kind: 'done', aborted: true, at: events.at(-1)?.event.recordedAt || chat.updatedAt })
      }
    }
    for (const row of raw) {
      const chat: UnifiedChat = JSON.parse(row.body as string)
      if (chat.nativeAgent && subagentActive(chat.nativeAgent.status)) {
        const child = chat.nativeAgent
        this.appendEvent(child.rootChatId, child.rootTurnId, { kind: 'subagent', agent: { id: child.id, parentId: child.parentId, status: 'stopped' } })
      }
    }
  }
  private transaction(fn: () => void): void {
    if (this.inTransaction) { fn(); return }
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true
    try { fn(); this.db.exec('COMMIT') } catch (err) { this.db.exec('ROLLBACK'); throw err }
    finally { this.inTransaction = false }
  }
  private replace(kind: string, items: { id: string }[]): void {
    if (kind === 'chats' && items.some(item => this.live.has(item.id) && (item as UnifiedChat).pendingTurnId !== this.live.get(item.id))) {
      throw new Error('Uma conversa está em execução. Aguarde antes de substituir seu histórico.')
    }
    this.db.prepare('DELETE FROM documents WHERE kind=?').run(kind)
    const put = this.db.prepare('INSERT INTO documents VALUES (?,?,?)')
    for (const item of items) put.run(kind, item.id, JSON.stringify(kind === 'chats' ? foldJournal(item as UnifiedChat, this.events(item.id)) : item))
    if (kind === 'chats') this.db.exec("DELETE FROM events WHERE chat_id NOT IN (SELECT id FROM documents WHERE kind='chats')")
  }
  get(key: 'profiles'): ProviderProfile[]
  get(key: 'chats'): UnifiedChat[]
  get(key: 'tasks'): AgentTask[]
  get(key: 'profiles' | 'chats' | 'tasks'): any[] {
    return this.db.prepare('SELECT body FROM documents WHERE kind=?').all(key).map((r) => {
      const item = JSON.parse(r.body as string)
      return key === 'chats' ? foldJournal(item, this.events(item.id)) : item
    })
  }
  set(key: 'profiles', items: ProviderProfile[]): void
  set(key: 'chats', items: UnifiedChat[]): void
  set(key: 'tasks', items: AgentTask[]): void
  set(key: 'profiles' | 'chats' | 'tasks', items: any[]): void { this.flushEvents(); this.transaction(() => this.replace(key, items)) }
  get store(): AgentData { return { profiles: this.get('profiles'), chats: this.get('chats'), tasks: this.get('tasks') } }
  set store(value: AgentData) {
    this.flushEvents()
    this.transaction(() => {
      this.replace('profiles', value.profiles); this.replace('chats', value.chats)
      if (value.tasks) this.replace('tasks', value.tasks)
    })
  }
  upsert(kind: 'chats' | 'tasks', item: UnifiedChat | AgentTask): void {
    if (kind === 'chats' && this.live.has(item.id) && (item as UnifiedChat).pendingTurnId !== this.live.get(item.id)) {
      throw new Error('Esta conversa está em execução. Aguarde antes de substituir seu histórico.')
    }
    const value = kind === 'chats' ? foldJournal(item as UnifiedChat, this.events(item.id)) : item
    this.db.prepare('INSERT INTO documents VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind, item.id, JSON.stringify(value))
  }
  removeChat(id: string): void {
    this.flushEvents()
    if (this.live.has(id)) throw new Error('Pare a tarefa antes de excluir a conversa.')
    this.transaction(() => {
      this.db.prepare("DELETE FROM documents WHERE kind='chats' AND id=?").run(id)
      this.db.prepare('DELETE FROM events WHERE chat_id=?').run(id)
    })
  }
  beginRun(chat: UnifiedChat, turnId: string): void {
    if (this.live.has(chat.id)) throw new Error('Esta conversa já está em execução.')
    const turn = chat.turns.find((t) => t.id === turnId)
    if (!turn || turn.role !== 'assistant') throw new Error('Turno de conversa inválido.')
    this.flushEvents()
    this.transaction(() => {
      this.upsert('chats', { ...chat, lastRunId: turnId })
      this.appendEvent(chat.id, turnId, { kind: 'begin', turn: { ...turn, startedAt: turn.startedAt || Date.now(), model: turn.model || chat.selection.model }, route: `${chat.selection.provider}:${chat.selection.profileId}` })
    })
    this.live.set(chat.id, turnId)
  }
  private flushEvents(): void {
    clearTimeout(this.eventTimer); this.eventTimer = undefined
    if (!this.pendingEvents.length) return
    const batch = this.pendingEvents
    this.transaction(() => {
      const put = this.db.prepare('INSERT INTO events(chat_id,turn_id,body) VALUES(?,?,?)')
      for (const e of batch) put.run(e.chatId, e.turnId, JSON.stringify(e.event))
    })
    this.pendingEvents = []
  }
  appendEvent(chatId: string, turnId: string, event: JournalEvent): void {
    if (event.kind === 'subagent') {
      const update = event.agent
      this.flushEvents()
      this.transaction(() => {
        const at = Date.now()
        this.db.prepare('INSERT INTO events(chat_id,turn_id,body) VALUES(?,?,?)').run(chatId, turnId, JSON.stringify({ ...event, recordedAt: at }))
        const read = (id: string): UnifiedChat | undefined => {
          const row = this.db.prepare("SELECT body FROM documents WHERE kind='chats' AND id=?").get(id)
          return row ? foldJournal(JSON.parse(row.body as string), this.events(id)) : undefined
        }
        const root = read(chatId), child = read(subagentChatId(chatId, update.id))
        const parentId = update.parentId ?? child?.nativeAgent?.parentId
        const parent = parentId ? read(subagentChatId(chatId, parentId)) : undefined
        const chats = [root, child, parent].filter((chat): chat is UnifiedChat => !!chat)
        for (const projected of projectSubagent(chats, chatId, turnId, update, at)) this.upsert('chats', projected)
      })
      return
    }
    if (event.kind === 'done' || event.kind === 'error') event = { ...event, at: event.at || Date.now() }
    const record = { chatId, turnId, event: { ...event, recordedAt: Date.now() } }
    const streaming = ['text','thinking','segment','metrics'].includes(event.kind)
    if (streaming && !this.inTransaction) {
      // Absolute Codex item snapshots replace earlier queued snapshots for the
      // same item. Preserve relative text deltas and tool-event ordering.
      if (event.kind === 'segment' && event.segment.toolId) {
        const prior = this.pendingEvents.findIndex(e => e.chatId === chatId && e.turnId === turnId && e.event.kind === 'segment' && e.event.segment.toolId === event.segment.toolId)
        if (prior >= 0) { this.pendingEvents[prior] = record; return }
      }
      this.pendingEvents.push(record)
      this.eventTimer ||= setTimeout(() => this.flushEvents(), 80)
      if (this.pendingEvents.length >= 500) this.flushEvents()
      return
    }
    this.flushEvents()
    this.db.prepare('INSERT INTO events(chat_id,turn_id,body) VALUES(?,?,?)').run(chatId, turnId, JSON.stringify(record.event))
    if ((event.kind === 'done' || event.kind === 'error') && this.live.get(chatId) === turnId) this.live.delete(chatId)
  }
  events(chatId: string): { turnId: string; event: any }[] {
    this.flushEvents()
    return this.db.prepare('SELECT turn_id,body FROM events WHERE chat_id=? ORDER BY seq').all(chatId)
      .map((r) => ({ turnId: r.turn_id as string, event: JSON.parse(r.body as string) }))
  }
  readState<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT body FROM state WHERE key=?').get(key)
    return row ? JSON.parse(row.body as string) : fallback
  }
  writeState(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run(key, JSON.stringify(value))
  }
  close(): void { this.flushEvents(); this.db.close() }
}
