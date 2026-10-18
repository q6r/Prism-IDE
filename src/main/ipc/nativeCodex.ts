import type { EventEmitter } from 'events'
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { CodexServer } from '../codexServer'
import { codexMetrics, codexSubtract, codexTurnUsage, type CodexBreakdown } from '../../shared/providerUsage'
import { agentStore, getProfile } from '../providers'
import { cachedCodexSkills, codexSkillInputs } from './agentCommands'
import type { CodexSend, CodexEvent, SharedSegment, SteerMessage } from '../../shared/agents'
import { CodexSubagents } from './codexSubagents'

/** Current app-server async questions belong to agentMessage, not a blocking RPC. */
function asyncQuestions(value: unknown): { title: string; options?: string[] }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rows = value.filter(row => row && typeof row.title === 'string' && row.title.trim()).slice(0, 12)
    .map(row => ({ title: row.title, ...(Array.isArray(row.options) ? { options: row.options.filter((option: unknown): option is string => typeof option === 'string').slice(0, 24) } : {}) }))
  return rows.length ? rows : undefined
}

function contentImages(value: any, depth = 0): import('../../shared/agents').ChatImage[] {
  if (depth > 8 || !value) return []
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return typeof parsed === 'string' ? [] : contentImages(parsed, depth + 1) } catch { return [] } }
  if (Array.isArray(value)) return value.flatMap(row => contentImages(row, depth + 1)).slice(0, 8)
  if (value.type === 'imageGeneration' && typeof value.result === 'string') {
    const mime = [['iVBORw0KGgo', 'image/png'], ['/9j/', 'image/jpeg'], ['R0lG', 'image/gif'], ['UklGR', 'image/webp']].find(([prefix]) => value.result.startsWith(prefix))?.[1]
    return mime && value.result.length <= 16 * 1024 * 1024 ? [{ mime, data: value.result }] : []
  }
  if (value.type === 'image') {
    const source = value.source || value, mime = source.media_type || source.mimeType || source.mime
    return ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) && typeof source.data === 'string' && source.data.length <= 16 * 1024 * 1024 ? [{ mime, data: source.data }] : []
  }
  return ['content', 'result', 'output'].flatMap(key => contentImages(value[key], depth + 1)).slice(0, 8)
}

export function nativeItem(item: any, complete: boolean): SharedSegment | undefined {
  const base = { toolId: item.id, status: complete ? (item.status === 'failed' || item.exitCode != null && item.exitCode !== 0 ? 'error' as const : 'done' as const) : 'running' as const }
  if (item.type === 'agentMessage') return { kind: 'text', toolId: item.id, text: item.text || '', ...(asyncQuestions(item.questions) ? { questions: asyncQuestions(item.questions) } : {}) }
  if (item.type === 'reasoning') return { kind: 'thinking', toolId: item.id, text: [...(item.summary || []), ...(item.content || [])].join('\n') }
  if (item.type === 'commandExecution') return { ...base, kind: 'tool', name: 'Bash', input: { command: item.command, cwd: item.cwd }, result: item.aggregatedOutput || '', resultIsError: base.status === 'error' }
  if (item.type === 'imageGeneration') return { kind: 'text', toolId: item.id, text: item.path || item.outputPath ? `![Imagem gerada](<${String(item.path || item.outputPath).replace(/>/g, '%3E')}>)` : 'Imagem gerada', images: contentImages(item) }
  if (item.type === 'fileChange') return { ...base, kind: 'tool', name: 'Write', input: { changes: item.changes }, result: JSON.stringify(item.changes) }
  if (item.type === 'collabAgentToolCall') return { ...base, kind: 'tool', name: item.tool || 'Agent', input: { prompt: item.prompt, model: item.model, receiverThreadIds: item.receiverThreadIds }, result: JSON.stringify(item.agentsStates || {}) }
  if (['mcpToolCall', 'webSearch', 'dynamicToolCall', 'plan', 'imageView'].includes(item.type)) return { ...base, kind: 'tool', name: item.tool || item.type, input: item.arguments || item, result: JSON.stringify(item.result || item.content || ''), ...(contentImages(item).length ? { images: contentImages(item) } : {}) }
}

interface Session { server: CodexServer; owner: WebContents; signature: string; threadId?: string; active?: CodexSend; nativeTurnId?: string; segments: Map<string, SharedSegment>; requests: Map<string, number | string>; abortRequested?: boolean; failure?: string; grants: Map<string, unknown>; questionKeys: Map<string, {id:string;question:string}[]>
  subagents?: CodexSubagents
  /** The thread total before the active turn (undefined until its first update; null when unknown). */
  turnBase?: CodexBreakdown | null
  /** The last thread total this process reported. */
  lastTotal?: CodexBreakdown }

/**
 * This turn's usage from a `thread/tokenUsage/updated`: the thread total
 * minus the total before the turn. The first update of a process has no
 * earlier total, so its base is that update's total minus its `last` call.
 */
function turnFromUpdate(s: Session, tokenUsage: any) {
  const total = tokenUsage?.total, last = tokenUsage?.last
  if (!total || typeof total !== 'object') return undefined
  if (s.turnBase === undefined) s.turnBase = s.lastTotal ?? (last && typeof last === 'object' ? codexSubtract(total, last) : null)
  s.lastTotal = total
  return s.turnBase ? codexTurnUsage(s.turnBase, total) : undefined
}

/** One Codex event in the run journal (agentStore), as a turn of this process writes it. */
function journalCodexEvent(chatId: string, turnId: string, event: CodexEvent): void {
  if (event.kind === 'metrics') agentStore.appendEvent(chatId, turnId, { kind: 'metrics', metrics: event.metrics })
  else if (event.kind === 'segment') agentStore.appendEvent(chatId, turnId, { kind: 'segment', segment: event.segment })
  else if (event.kind === 'session') agentStore.appendEvent(chatId, turnId, { kind: 'session', sessionId: event.sessionId })
  else if (event.kind === 'done') agentStore.appendEvent(chatId, turnId, { kind: 'done', aborted: event.aborted })
  else if (event.kind === 'subagent') agentStore.appendEvent(chatId, turnId, { kind: 'subagent', agent: event.agent })
  else agentStore.appendEvent(chatId, turnId, { kind: 'error', message: event.message })
}

/**
 * Login changes are forwarded to the windows, so the Prism host restarts its
 * idle Codex processes of that profile too (until the host owns the accounts, T08).
 */
function registerHostCodexBridge(): void {
  ;(app as unknown as EventEmitter).on('prism:profile-changed', (profileId: string) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.webContents.isDestroyed()) win.webContents.send('codex:profile-changed', profileId)
  })
}

export function registerNativeCodexHandlers(): void {
  registerHostCodexBridge()
  const sessions = new Map<string, Session>()
  const emit = (s: Session, event: CodexEvent): void => {
    if (!s.active) return
    const p = s.active
    if (p.chat) journalCodexEvent(p.chatId, p.id, event)
    if (!s.owner.isDestroyed()) s.owner.send('codex:event', event)
  }
  const finish = (s: Session, error?: string, aborted?: boolean): void => {
    if (!s.active) return
    emit(s, error ? { id: s.active.id, kind: 'error', message: error } : { id: s.active.id, kind: 'done', aborted })
    s.active = undefined; s.nativeTurnId = undefined; s.abortRequested = false; s.requests.clear(); s.questionKeys.clear(); s.grants.clear(); s.turnBase = undefined
  }
  const bind = (chatId: string, s: Session): void => {
    s.subagents = new CodexSubagents((origin, agent) => {
      const event: CodexEvent = { id: origin.id, kind: 'subagent', agent }
      if (origin.journal) journalCodexEvent(chatId, origin.id, event)
      if (!s.owner.isDestroyed()) s.owner.send('codex:event', event)
    }, nativeItem)
    s.server.onClose = (err) => { s.subagents?.close(); finish(s, s.abortRequested ? undefined : s.failure || err.message, !!s.abortRequested); if (sessions.get(chatId) === s) sessions.delete(chatId) }
    s.server.onMessage = (msg) => {
      const p = msg.params || {}, active = s.active
      if (s.subagents?.handle(s.threadId || '', active ? { id: active.id, journal: !!active.chat } : undefined, msg)) return
      const childRequest = msg.id !== undefined && !!active && s.subagents?.belongsTo(p.threadId, active.id)
      if (!active || s.failure || p.threadId && p.threadId !== s.threadId && !childRequest) { if (msg.id !== undefined) s.server.reject(msg.id); return }
      if (!childRequest && p.turnId && s.nativeTurnId && p.turnId !== s.nativeTurnId) return
      if (msg.id !== undefined) {
        const requestId = `codex:${chatId}:${msg.id}`
        s.requests.set(requestId, msg.id)
        if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) {
          s.owner.send('agent:permission', { id: active.id, permId: requestId, toolUseId: p.itemId, toolName: msg.method.includes('commandExecution') ? 'Bash' : 'Write', input: { command: p.command, cwd: p.cwd, grantRoot: p.grantRoot }, title: p.reason || 'Codex solicita permissão' })
        } else if (msg.method === 'item/permissions/requestApproval') {
          s.grants.set(requestId, p.permissions)
          s.owner.send('agent:permission', { id: active.id, permId: requestId, toolUseId: p.itemId, toolName: 'Permissões', input: { cwd: p.cwd, permissions: p.permissions }, title: p.reason || 'Codex solicita acesso a arquivos ou rede' })
        } else if (msg.method === 'item/tool/requestUserInput') {
          const questions = (Array.isArray(p.questions) ? p.questions : []).filter((q: any) => q && typeof q.question === 'string' && q.question.trim())
            .map((q: any, index: number) => ({ ...q, id: typeof q.id === 'string' ? q.id : typeof q.questionId === 'string' ? q.questionId : String(index), question: q.question, options: Array.isArray(q.options) ? q.options : [] }))
          if (!questions.length) { s.requests.delete(requestId); s.server.reject(msg.id); return }
          s.questionKeys.set(requestId, questions.map((q: any) => ({ id: q.id, question: q.question })))
          s.owner.send('agent:question', { id: active.id, dialogId: requestId, toolUseId: p.itemId, questions })
        } else { s.requests.delete(requestId); s.server.reject(msg.id) }
        return
      }
      if (msg.method === 'turn/started') { s.nativeTurnId = p.turn.id; if (s.abortRequested) void s.server.request('turn/interrupt', { threadId: s.threadId, turnId: s.nativeTurnId }).catch(() => s.server.close()) }
      else if (msg.method === 'thread/tokenUsage/updated') emit(s, { id: active.id, kind: 'metrics', metrics: codexMetrics(p.tokenUsage, turnFromUpdate(s, p.tokenUsage)) })
      else if (msg.method === 'item/started' || msg.method === 'item/completed') {
        const segment = nativeItem(p.item, msg.method === 'item/completed')
        if (segment) { s.segments.set(p.item.id, segment); emit(s, { id: active.id, kind: 'segment', segment }) }
      } else if (['item/agentMessage/delta', 'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta'].includes(msg.method)) {
        const segment = s.segments.get(p.itemId) || { kind: msg.method.includes('reasoning') ? 'thinking' : 'text', text: '', toolId: p.itemId } as SharedSegment
        const next = segment.kind === 'tool' ? { ...segment, result: (segment.result || '') + p.delta } : { ...segment, text: (segment.text || '') + p.delta }
        s.segments.set(p.itemId, next); emit(s, { id: active.id, kind: 'segment', segment: next })
      } else if (msg.method === 'turn/completed') finish(s, p.turn.status === 'failed' ? p.turn.error?.message || 'Falha no Codex.' : undefined, p.turn.status === 'interrupted')
    }
  }
  ipcMain.on('codex:send', async (e, payload: CodexSend) => {
    let s = sessions.get(payload.chatId)
    let accepted = false
    try {
      if (!payload.id || !payload.chatId || (!payload.prompt?.trim() && !payload.images?.length) || payload.selection.provider !== 'codex') throw new Error('Mensagem Codex inválida.')
      getProfile('codex', payload.selection.profileId)
      if (s && (s.owner.id !== e.sender.id || s.active)) throw new Error('Este chat já está ocupado em outra execução.')
      const signature = JSON.stringify([payload.selection.profileId, payload.cwd])
      // A route handoff must create a fresh native thread with transferred
      // history. Never silently reuse the older thread of the returning agent.
      if (s && (signature !== s.signature || !payload.resume || s.threadId !== payload.resume)) { s.server.close(); s = undefined }
      if (!s) {
        s = { server: new CodexServer(payload.selection.profileId, payload.cwd), owner: e.sender, signature, segments: new Map(), requests: new Map(), questionKeys: new Map(), grants: new Map() }
        sessions.set(payload.chatId, s); bind(payload.chatId, s)
        const created = s
        e.sender.once('destroyed', () => { if (sessions.get(payload.chatId) === created) created.server.close() })
      }
      s.active = payload; s.segments.clear(); s.abortRequested = false; s.turnBase = undefined
      accepted = true
      if (payload.chat) agentStore.beginRun(payload.chat, payload.id)
      await s.server.ready
      const full = payload.selection.permissionMode === 'bypassPermissions'
      const write = payload.selection.permissionMode === 'acceptEdits'
      const approvalPolicy = full || payload.selection.permissionMode === 'plan' ? 'never' : 'on-request'
      const sandbox = full ? 'danger-full-access' : write ? 'workspace-write' : 'read-only'
      // Fast mode is the model's upgrade service tier; null clears it on resume.
      const serviceTier = payload.selection.serviceTier || null
      if (!s.threadId) {
        const response = await s.server.request(payload.resume ? 'thread/resume' : 'thread/start', {
          ...(payload.resume ? { threadId: payload.resume } : {}), cwd: payload.cwd, approvalPolicy, sandbox,
          ...(payload.selection.model ? { model: payload.selection.model } : {}), serviceTier
        })
        s.threadId = response.thread.id
      }
      emit(s, { id: payload.id, kind: 'session', sessionId: s.threadId! })
      if (s.abortRequested) { finish(s, undefined, true); return }
      const sandboxPolicy = full ? { type: 'dangerFullAccess' } : write ? { type: 'workspaceWrite', writableRoots: [payload.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } : { type: 'readOnly' }
      // `$skill` tokens the `/` menu listed also go as structured skill items,
      // as Codex's own composer sends them; the text stays as typed. No
      // listing cached yet: text only, never a wait.
      const skills = codexSkillInputs(payload.prompt, cachedCodexSkills(payload.selection.profileId, payload.cwd) ?? [])
      const response = await s.server.request('turn/start', { threadId: s.threadId, input: [{ type: 'text', text: payload.prompt, text_elements: [] }, ...(payload.images || []).map(image => ({ type: 'image', url: `data:${image.mime};base64,${image.data}` })), ...skills], cwd: payload.cwd,
        approvalPolicy, sandboxPolicy, ...(payload.selection.model ? { model: payload.selection.model } : {}), effort: payload.selection.effort, serviceTier })
      if (s.active?.id === payload.id) {
        s.nativeTurnId = response.turn.id
        s.subagents?.rememberRootTurn(response.turn.id, { id: payload.id, journal: !!payload.chat })
        if (s.abortRequested) await s.server.request('turn/interrupt', { threadId: s.threadId, turnId: s.nativeTurnId })
      }
    } catch (err) {
      if (s?.active?.id === payload.id) { s.failure = (err as Error).message; s.server.close() }
      else if (!accepted && !e.sender.isDestroyed()) e.sender.send('codex:event', { id: payload.id, kind: 'error', message: (err as Error).message })
    }
  })
  ipcMain.handle('codex:steer', async (e, p: SteerMessage) => {
    const s = sessions.get(p.chatId)
    if (!s || s.owner.id !== e.sender.id || s.active?.id !== p.turnId || s.abortRequested || !s.nativeTurnId) {
      throw new Error('O Codex ainda está iniciando, já terminou ou está sendo interrompido. A mensagem continua na fila.')
    }
    if (s.requests.size) throw new Error('Responda à aprovação ou pergunta antes de enviar durante o turno.')
    if (!p.text.trim() && !p.images?.length) throw new Error('Digite uma mensagem.')
    const text = p.context ? `${p.text}\n\n${p.context}` : p.text
    await s.server.request('turn/steer', { threadId: s.threadId, expectedTurnId: s.nativeTurnId,
      input: [{ type: 'text', text, text_elements: [] }, ...(p.images || []).map(i => ({ type: 'image', url: `data:${i.mime};base64,${i.data}` }))] })
    if (s.active?.chat) agentStore.appendEvent(p.chatId, p.turnId, { kind: 'segment', segment: { kind: 'user', toolId: p.messageId || crypto.randomUUID(), text, images: p.images, sentAt: Date.now() } })
  })
  ipcMain.on('codex:abort', (e, chatId: string) => {
    const s = sessions.get(chatId)
    if (!s || s.owner.id !== e.sender.id || !s.active) return
    s.abortRequested = true
    const turnId = s.active.id
    const timer = setTimeout(() => { if (s.active?.id === turnId && s.abortRequested) s.server.close() }, 2000)
    timer.unref()
    if (s.nativeTurnId) void s.server.request('turn/interrupt', { threadId: s.threadId, turnId: s.nativeTurnId }).catch(() => s.server.close())
  })
  ipcMain.on('codex:permission', (e, chatId: string, requestId: string, decision: string) => {
    const s = sessions.get(chatId), request = s?.requests.get(requestId)
    if (!s?.active || s.owner.id !== e.sender.id || request === undefined) return
    s.requests.delete(requestId)
    if (s.grants.has(requestId)) {
      s.server.answer(request, { permissions: decision === 'deny' ? {} : s.grants.get(requestId), scope: decision === 'allow_always' ? 'session' : 'turn' })
      s.grants.delete(requestId)
    } else s.server.answer(request, { decision: decision === 'allow_always' ? 'acceptForSession' : decision === 'allow' ? 'accept' : 'decline' })
  })
  ipcMain.on('codex:question', (e, chatId: string, requestId: string, answers?: Record<string, string>) => {
    const s = sessions.get(chatId), request = s?.requests.get(requestId)
    if (!s?.active || s.owner.id !== e.sender.id || request === undefined) return
    s.requests.delete(requestId)
    const keys = s.questionKeys.get(requestId) || []; s.questionKeys.delete(requestId)
    s.server.answer(request, { answers: Object.fromEntries(keys.map(q => {
      const answer = answers?.[q.id] ?? answers?.[q.question]
      return [q.id, { answers: answer ? [answer] : [] }]
    })) })
  })
  app.on('before-quit', () => { for (const s of sessions.values()) s.server.close() })
  ;(app as unknown as EventEmitter).on('prism:profile-changed', (profileId: string) => {
    for (const [chatId,s] of sessions) if (!s.active && JSON.parse(s.signature)[0] === profileId) {
      sessions.delete(chatId); s.server.close()
    }
  })
}
