import { claudeContext, claudeMetrics, claudeTurnUsage, NO_CLAUDE_TOTALS, type ClaudeTotals } from '../../shared/providerUsage'
import type { EventEmitter } from 'events'
import type { ChatImage, UnifiedChat, SharedSegment, TurnUsage, SteerMessage } from '../../shared/agents'
import { ipcMain, WebContents, app, BrowserWindow } from 'electron'
import { spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import { readFile, readdir } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { agentStore, profileEnvironment, providerCommand } from '../providers'
import type { Client, ClientChannel } from 'ssh2'
import { getSshClient, matchesSshTarget } from './ssh'
import { ClaudeSubagents } from './claudeSubagents'

// Resolve the locally-installed Claude Code CLI. The Agent SDK ships an optional
// per-platform native binary that package managers (pnpm) may omit; when that
// happens the SDK throws "Native CLI binary … not found". Pointing it at the
// user's own `claude` install via `pathToClaudeCodeExecutable` makes the agent
// work regardless, and uses their real subscription login.
let cliPath: string | null | undefined

// Where the official installer (claude.ai/install.*) drops the binary — it isn't
// on the running process's PATH until a restart, so we look here explicitly.
function localBinPath(): string {
  return join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
}

// Find `claude` fresh (PATH, then ~/.local/bin) and cache the result. Pass
// force=true to re-probe after an install.
function findClaude(force = false): string | null {
  if (!force && cliPath !== undefined) return cliPath
  let found: string | null = null
  try {
    const cmd = process.platform === 'win32' ? 'where claude' : 'command -v claude'
    const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
    found = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null
  } catch {
    found = null
  }
  if (!found) {
    const lb = localBinPath()
    if (existsSync(lb)) found = lb
  }
  cliPath = found
  return found
}

// Runs use the same CLI the model catalog reads (Traycer's managed build when it
// is at least as new as the terminal's, and always for a profile linked to a
// Traycer login), so a model id resolves identically.
function resolveCliPath(profileId?: string): string | undefined {
  const command = providerCommand('claude', profileId)
  return command ? command.args[0] || command.bin : findClaude() ?? undefined
}

/** The SDK's report (init/result) of whether Fast actually serves the session, and why not. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fastModeOf(msg: Record<string, any>): { state: string; reason?: string } | undefined {
  if (typeof msg.fast_mode_state !== 'string') return undefined
  return { state: msg.fast_mode_state, reason: typeof msg.fast_mode_disabled_reason === 'string' ? msg.fast_mode_disabled_reason : undefined }
}

/** Absolute path to the local `claude` binary, or just "claude" as a fallback. */
export function localClaudeBin(): string {
  return findClaude(true) || 'claude'
}

/**
 * Agentic backend powered by the official Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`). The SDK drives the locally-installed
 * Claude Code CLI, so this uses the user's Pro/Max subscription login — no API
 * key required. It gives us real tool-use (Edit/Write/Bash/Read…), live
 * permission prompts (`canUseTool`), permission modes (plan/acceptEdits/…),
 * effort + adaptive thinking, and session resume.
 *
 * The SDK is ESM-only; we load it lazily via dynamic import from this CJS bundle.
 */

type Decision = 'allow' | 'allow_always' | 'deny'

interface PermResponse {
  decision: Decision
  updatedInput?: Record<string, unknown>
}

interface DialogResponse {
  cancelled?: boolean
  answers?: Record<string, string>
  response?: string
}

/** Register the answer before publishing the question, including SDK cancellation. */
function waitForQuestion(
  emit: (channel: string, payload: Record<string, unknown>) => void,
  id: string,
  dialogs: Map<string, (reply: DialogResponse) => void>,
  input: Record<string, unknown>,
  signal: AbortSignal,
  toolUseId: string
): Promise<{ behavior: 'allow'; updatedInput: Record<string, unknown> }> {
  if (signal.aborted) return Promise.resolve({ behavior: 'allow', updatedInput: input })
  const dialogId = `dlg${dialogSeq++}`
  return new Promise(resolve => {
    const onAbort = (): void => {
      if (!dialogs.delete(dialogId)) return
      resolve({ behavior: 'allow', updatedInput: input })
    }
    dialogs.set(dialogId, ({ cancelled, answers }) => {
      signal.removeEventListener('abort', onAbort)
      resolve({ behavior: 'allow', updatedInput: !cancelled && answers && Object.keys(answers).length ? { ...input, answers } : input })
    })
    signal.addEventListener('abort', onAbort, { once: true })
    emit('agent:question', { id, dialogId, toolUseId, questions: input.questions ?? [] })
  })
}

interface Turn {
  abort: AbortController
  owner?: number
  scope?: string
  perms: Map<string, (r: PermResponse) => void>
  dialogs: Map<string, (r: DialogResponse) => void>
}

interface SendPayload {
  chat?: UnifiedChat
  id: string
  profileId?: string
  permissionScope?: string
  remoteTarget?: { host: string; port: number; username: string }
  // When set, this is a local streaming-input chat (long-lived query, supports
  // queue + mid-turn steering). When absent, it's the legacy single-shot path.
  chatId?: string
  prompt: string
  images?: ChatImage[]
  cwd?: string
  resume?: string
  model: string
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
  /** 'fast' turns on Claude Code fast mode for the session (flag settings layer). */
  serviceTier?: string
  thinking?: boolean
  contextNote?: string
  // When set, the agent runs on this SSH connection's remote host instead of
  // locally — driving the remote `claude` CLI over the SSH channel.
  remote?: string
}

// Active turns keyed by the renderer-supplied assistant turn id.
const turns = new Map<string, Turn>()
// Tool names the user chose to "always allow" for this app session.
const alwaysAllow = new Set<string>()
const scopedPermissions = new Map<string, Set<string>>()
function permissionsFor(payload: SendPayload): Set<string> {
  if (!payload.permissionScope) return alwaysAllow
  const key = `${payload.permissionScope}:${payload.profileId || 'ambient-claude'}`
  let permissions = scopedPermissions.get(key)
  if (!permissions) { permissions = new Set(); scopedPermissions.set(key, permissions) }
  return permissions
}
let permSeq = 0
let dialogSeq = 0

// Lazily-loaded SDK module (ESM).
let sdkPromise: Promise<typeof import('@anthropic-ai/claude-agent-sdk')> | null = null
function loadSdk(): Promise<typeof import('@anthropic-ai/claude-agent-sdk')> {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk')
  return sdkPromise
}

// ---------------------------------------------------------------------------
// Streaming-input sessions (local agent). Instead of one single-shot query per
// message, a chat keeps ONE long-lived `query()` driven by an async-iterable of
// user messages. New messages are pushed in while a turn runs — the SDK either
// picks them up at the next tool boundary (steer) or after the current turn ends
// (queue), exactly like Claude Code. `system/init` marks each turn's start and
// `result` its end (verified against the binary), so the renderer's assistant
// bubbles are created on turn-start.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkUserMessage = any

function makeInputPump(): {
  gen: AsyncGenerator<SdkUserMessage>
  push: (m: SdkUserMessage) => void
  end: () => void
} {
  const queue: SdkUserMessage[] = []
  let wake: (() => void) | null = null
  let done = false
  const gen = (async function* () {
    while (true) {
      if (queue.length) {
        yield queue.shift()
        continue
      }
      if (done) return
      await new Promise<void>((r) => (wake = r))
    }
  })()
  return {
    gen,
    push: (m) => {
      queue.push(m)
      if (wake) {
        const w = wake
        wake = null
        w()
      }
    },
    end: () => {
      done = true
      if (wake) {
        const w = wake
        wake = null
        w()
      }
    }
  }
}

function userMsg(text: string, priority?: 'now' | 'next' | 'later', images?: ChatImage[]): SdkUserMessage {
  const m: SdkUserMessage = {
    type: 'user',
    message: { role: 'user', content: images?.length ? [...(text ? [{ type: 'text', text }] : []), ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }))] : text },
    parent_tool_use_id: null
  }
  if (priority) m.priority = priority
  return m
}

interface StreamSession {
  contextUsage?: unknown
  chatId: string
  owner?: number
  unified?: boolean
  signature?: string
  sessionId?: string
  send?: SendFn
  closed?: Promise<void>
  release?: () => void
  closing?: boolean
  restarting?: boolean
  abort: AbortController
  activeTurnId: string | null
  stoppingTurnId?: string
  model: string
  permissionMode: string
  perms: Map<string, (r: PermResponse) => void>
  dialogs: Map<string, (r: DialogResponse) => void>
  push: (text: string, priority?: 'now' | 'next' | 'later', images?: ChatImage[]) => void
  end: () => void
  close: () => void
  isClosed: () => boolean
  reusable: () => boolean
  interrupt: () => void
  setModel: (m: string) => void
  setPermissionMode: (m: string) => void
  /** This query's usage totals before the next result; null when unknown. */
  usageBase: ClaudeTotals | null
  /** The model `system/init` reported (an alias such as "opus" resolved). */
  resolvedModel?: string
}

const streamSessions = new Map<string, StreamSession>()
/**
 * Last usage totals seen per native session id, across query() restarts in
 * this run: a resumed query continues from the session's saved totals, so
 * they are its base when they match. Nothing is known after an app restart.
 */
const sessionTotals = new Map<string, ClaudeTotals>()
const usageBaseFor = (resume: string | undefined): ClaudeTotals | null => resume ? sessionTotals.get(resume) ?? null : NO_CLAUDE_TOTALS
/** This result's own usage, and the base for the query's next result. */
function measureTurn(msg: Record<string, any>, base: ClaudeTotals | null): { turn: TurnUsage | undefined; base: ClaudeTotals | null } {
  const { turn, next } = claudeTurnUsage(msg, base)
  if (next && typeof msg.session_id === 'string' && msg.session_id) sessionTotals.set(msg.session_id, next)
  return { turn, base: next }
}
let turnSeq = 0

type SendFn = (channel: string, data: unknown) => void

/** The SDK bounds its process cleanup; a broken iterator must not park the new turn. */
async function retireStreamingSession(session: StreamSession): Promise<void> {
  session.close()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([session.closed, new Promise<never>((_, reject) => {
      // Leave one second for the iterator's bounded finally to release its slot.
      timer = setTimeout(() => reject(new Error('O Claude não encerrou a sessão anterior. Feche e reabra o Prism para reiniciar essa sessão.')), 6000)
      timer.unref()
    })])
  } finally { clearTimeout(timer) }
}

async function sendToStreamingSession(payload: SendPayload, send: SendFn, owner?: number): Promise<void> {
  const chatId = payload.chatId
  if (!chatId) return
  const text = payload.contextNote ? `${payload.prompt}\n\n${payload.contextNote}` : payload.prompt

  let existing = streamSessions.get(chatId)
  const signature = JSON.stringify([payload.profileId,payload.cwd,payload.model,payload.effort,payload.permissionMode,payload.serviceTier||''])
  if (existing && payload.chat) {
    if(existing.owner!==owner || existing.activeTurnId) {send('agent:error',{id:payload.id,message:'Este chat já está executando uma tarefa.'});return}
    if(existing.restarting) {send('agent:error',{id:payload.id,message:'A sessão anterior do Claude está sendo encerrada. Tente novamente.'});return}
    if(existing.signature!==signature || !payload.resume || existing.sessionId!==payload.resume || !existing.reusable()) {
      existing.restarting = true
      try { await retireStreamingSession(existing) }
      catch (error) { existing.restarting = false; send('agent:error', { id: payload.id, message: (error as Error).message }); return }
      existing=undefined
    } else {
      existing.activeTurnId=payload.id;existing.send=send
      send('agent:system',{id:payload.id,sessionId:existing.sessionId,model:existing.model})
      existing.push(text, undefined, payload.images);return
    }
  }
  if (existing) {
    // Live session: apply any model/permission change, then inject the message.
    if (payload.model && payload.model !== existing.model) {
      existing.model = payload.model
      existing.setModel(payload.model)
    }
    if (payload.permissionMode && payload.permissionMode !== existing.permissionMode) {
      existing.permissionMode = payload.permissionMode
      existing.setPermissionMode(payload.permissionMode)
    }
    existing.push(text, undefined, payload.images)
    return
  }

  const isHaiku = payload.model === 'haiku' || payload.model.startsWith('claude-haiku')
  const abort = new AbortController()
  const pump = makeInputPump()

  // Register the session SYNCHRONOUSLY (before any await) and buffer the first
  // message, so a second rapid send finds this session and pushes into it rather
  // than spinning up a duplicate query for the same chat. The pump holds early
  // messages until the query starts consuming the generator.
  let release!:()=>void
  const closed=new Promise<void>(resolve=>{release=resolve})
  const session: StreamSession = {
    chatId, owner, unified:!!payload.chat, signature, send, closed, release,
    abort,
    activeTurnId: payload.chat ? payload.id : null,
    model: payload.model,
    permissionMode: payload.permissionMode || 'default',
    perms: new Map(),
    dialogs: new Map(),
    push: (t, priority, images) => pump.push(userMsg(t, priority, images)),
    end: () => pump.end(),
    close: () => { session.closing = true; abort.abort(); pump.end() },
    isClosed: () => false,
    reusable: () => !abort.signal.aborted && !session.closing,
    interrupt: () => abort.abort(),
    setModel: () => undefined,
    setPermissionMode: () => undefined,
    usageBase: usageBaseFor(payload.resume)
  }
  streamSessions.set(chatId, session)
  session.push(text, undefined, payload.images)

  let sdk: typeof import('@anthropic-ai/claude-agent-sdk')
  try {
    sdk = await loadSdk()
  } catch (err) {
    streamSessions.delete(chatId)
    send('agent:error', {
      id: payload.id,
      chatId,
      message: 'Falha ao carregar o Claude Agent SDK: ' + ((err as Error)?.message || String(err))
    })
    session.release?.()
    return
  }

  const allowedTools = permissionsFor(payload)
  const emit: SendFn = (channel,data) => (session.send || send)(channel,data)
  const canUseTool = async (
    toolName: string,
    input: Record<string, unknown>,
    opts: {
      signal: AbortSignal
      suggestions?: unknown[]
      toolUseID: string
      title?: string
      displayName?: string
      description?: string
      blockedPath?: string
    }
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
    | { behavior: 'deny'; message: string; interrupt?: boolean }
  > => {
    const id = session.activeTurnId ?? ''
    if (toolName === 'AskUserQuestion') {
      return waitForQuestion(emit, id, session.dialogs, input, opts.signal, opts.toolUseID)
    }

    if (allowedTools.has(toolName)) return { behavior: 'allow', updatedInput: input }

    const permId = `perm${permSeq++}`
    emit('agent:permission', {
      id,
      permId,
      toolName,
      toolUseId: opts.toolUseID,
      input,
      title: opts.title,
      displayName: opts.displayName,
      description: opts.description,
      blockedPath: opts.blockedPath
    })
    return new Promise((resolve) => {
      const onAbort = (): void => {
        if (session.perms.has(permId)) {
          session.perms.delete(permId)
          resolve({ behavior: 'deny', message: 'Cancelado.' })
        }
      }
      opts.signal.addEventListener('abort', onAbort, { once: true })
      session.perms.set(permId, ({ decision, updatedInput }) => {
        opts.signal.removeEventListener('abort', onAbort)
        if (decision === 'deny') {
          resolve({ behavior: 'deny', message: 'Negado pelo usuário.' })
          return
        }
        if (decision === 'allow_always') {
          allowedTools.add(toolName)
          resolve({
            behavior: 'allow',
            updatedInput: updatedInput ?? input,
            updatedPermissions: opts.suggestions as unknown[] | undefined
          })
          return
        }
        resolve({ behavior: 'allow', updatedInput: updatedInput ?? input })
      })
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options: any = {
    cwd: payload.cwd || undefined,
    env: profileEnvironment('claude', payload.profileId),
    model: payload.model || undefined,
    permissionMode: payload.permissionMode || 'default',
    includePartialMessages: true,
    forwardSubagentText: true,
    abortController: abort,
    toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
    canUseTool,
    // Unknown CLI dialog kinds use their default behavior instead of parking the turn.
    onUserDialog: async () => ({ behavior: 'cancelled' }),
    enableFileCheckpointing: true,
    settingSources: ['user', 'project', 'local']
  }
  const exe = resolveCliPath(payload.profileId)
  if (exe) options.pathToClaudeCodeExecutable = exe
  if (payload.resume) options.resume = payload.resume
  if (!isHaiku) {
    if (payload.effort) options.effort = payload.effort === 'ultra' ? 'max' : payload.effort
    options.thinking = payload.thinking === false ? { type: 'disabled' } : { type: 'adaptive' }
  }
  // Explicit both ways: "off" must also override a fastMode in the user's settings.json.
  options.settings = { fastMode: payload.serviceTier === 'fast' }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any
  try { q = sdk.query({prompt:pump.gen,options}) }
  catch(err) {streamSessions.delete(chatId);session.release?.();emit('agent:error',{id:payload.id,message:(err as Error).message});return}
  session.close = () => {
    session.closing = true; abort.abort(); session.end()
    try { q.close?.() } catch { /* Already closed. */ }
  }
  session.reusable = () => !abort.signal.aborted && !session.closing && !(typeof q.isClosed === 'function' && q.isClosed())
  session.isClosed = () => typeof q.isClosed === 'function' && q.isClosed() === true
  session.interrupt = () => {
    const turnId = session.activeTurnId
    if (!turnId || session.stoppingTurnId === turnId) return
    session.stoppingTurnId = turnId
    for (const answer of session.perms.values()) answer({ decision: 'deny' })
    for (const answer of session.dialogs.values()) answer({ cancelled: true })
    session.perms.clear(); session.dialogs.clear()
    const terminate = (): void => {
      if (session.activeTurnId === turnId) session.close()
    }
    void Promise.resolve().then(() => q.interrupt()).catch(terminate)
    const timer = setTimeout(terminate, 2000); timer.unref()
  }
  session.setModel = (m) => {
    try {
      void q.setModel?.(m)
    } catch {
      /* ignore */
    }
  }
  session.setPermissionMode = (m) => {
    try {
      void q.setPermissionMode?.(m)
    } catch {
      /* ignore */
    }
  }

  // The first message was already buffered into the pump; just drive the stream.
  void consumeStream(session, q, emit)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function consumeStream(session: StreamSession, q: any, send: SendFn): Promise<void> {
  const { chatId } = session
  const subagents = new ClaudeSubagents()
  try {
    for await (const msg of q as AsyncIterable<Record<string, any>>) {
      if (subagents.handle(msg, session.activeTurnId, send)) continue
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            session.sessionId=msg.session_id
            if (typeof msg.model === 'string' && msg.model) session.resolvedModel = msg.model
            if(session.unified) {
              send('agent:system',{id:session.activeTurnId,sessionId:msg.session_id,model:msg.model,tools:msg.tools,fastMode:fastModeOf(msg)});break
            }
            // A new turn is beginning — mint its id and tell the renderer to open
            // an assistant bubble for it. (init repeats per turn; same session_id.)
            const tid = `at${turnSeq++}`
            session.activeTurnId = tid
            send('agent:turn-start', {
              chatId,
              id: tid,
              sessionId: msg.session_id,
              model: msg.model,
              permissionMode: msg.permissionMode,
              tools: msg.tools
            })
          }
          break

        case 'stream_event': {
          const id = session.activeTurnId
          if (!id) break
          const ev = msg.event
          if (ev?.type === 'content_block_delta') {
            if (ev.delta?.type === 'text_delta') send('agent:text', { id, text: ev.delta.text })
            else if (ev.delta?.type === 'thinking_delta')
              send('agent:thinking', { id, text: ev.delta.thinking })
          } else if (ev?.type === 'message_start' && ev.message?.usage) {
            session.contextUsage = ev.message.usage
            send('agent:context', { id, usage: ev.message.usage })
          }
          break
        }

        case 'assistant': {
          if (msg.message?.usage) session.contextUsage = msg.message.usage
          const id = session.activeTurnId
          if (!id) break
          for (const b of msg.message?.content ?? []) {
            if (b.type === 'tool_use')
              send('agent:tool', { id, toolId: b.id, name: b.name, input: b.input })
          }
          break
        }

        case 'user': {
          const id = session.activeTurnId
          if (!id) break
          const content = msg.message?.content
          if (Array.isArray(content)) {
            for (const b of content) {
              if (b.type === 'tool_result') {
                const c =
                  typeof b.content === 'string'
                    ? b.content
                    : Array.isArray(b.content)
                      ? b.content
                          .map((x: { type: string; text?: string }) =>
                            x.type === 'text' ? x.text : `[${x.type}]`
                          )
                          .join('')
                      : JSON.stringify(b.content)
                send('agent:tool-result', { id, toolId: b.tool_use_id, content: c, isError: !!b.is_error })
              }
            }
          }
          break
        }

        case 'result': {
          const id = session.activeTurnId
          const terminalSend = session.send || send
          const aborted = session.stoppingTurnId === id || (!!msg.subtype && msg.subtype !== 'success')
          // Measured even without an open turn, so the base stays in step.
          const measured = measureTurn(msg, session.usageBase)
          session.usageBase = measured.base
          // Publish terminal events only after this slot is free. A queue can
          // start the next turn immediately; keep both events on this turn's sink.
          session.activeTurnId = null
          session.stoppingTurnId = undefined
          if (id) {
            terminalSend('agent:result', {
              id,
              chatId,
              sessionId: msg.session_id,
              isError: !!msg.is_error,
              subtype: msg.subtype,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              numTurns: msg.num_turns,
              resultText: msg.result,
              usage: msg.usage,
              turn: measured.turn,
              model: session.resolvedModel,
              ...claudeContext(session.contextUsage, msg.modelUsage, session.resolvedModel),
              fastMode: fastModeOf(msg)
            })
            // A non-"success" subtype means the turn was interrupted/stopped, not
            // a real failure — surface it as a (graceful) "done", not an error.
            terminalSend('agent:done', { id, aborted })
          }
          break
        }
      }
    }
    // Input generator ended (session torn down) — finalize any open turn.
    if (session.activeTurnId) {
      send('agent:done', { id: session.activeTurnId, aborted: true })
      session.activeTurnId = null
    }
  } catch (err) {
    const id = session.activeTurnId ?? ''
    if (session.abort.signal.aborted) {
      if (id) send('agent:done', { id, aborted: true })
    } else {
      send('agent:error', { id, message: (err as Error)?.message || String(err) })
    }
    session.activeTurnId = null
  } finally {
    subagents.close(send)
    session.closing = true
    let released = false
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      q.close?.()
      await Promise.race([Promise.resolve(q.return?.()), new Promise<never>((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error('Claude iterator cleanup did not complete.')), 5000)
        cleanupTimer.unref()
      })])
      released = true
    } catch {
      // The SDK's close() disposes its native transport. A stuck iterator may
      // be abandoned only when the SDK confirms it is closed, never while open.
      released = session.isClosed()
    } finally { clearTimeout(cleanupTimer) }
    if (released) {
      if(streamSessions.get(chatId)===session) streamSessions.delete(chatId)
      session.release?.()
    }
  }
}

// ---------------------------------------------------------------------------
// Remote agent: run the *remote* `claude` CLI over the SSH channel so the agent
// reads/edits files on the server. We speak the same stream-json + stdio
// control protocol the Agent SDK uses, and translate events to the identical
// `agent:*` IPC the renderer already consumes.
// ---------------------------------------------------------------------------

// Single-quote a string for a POSIX shell.
const shq = (s: string): string => "'" + String(s).replace(/'/g, "'\\''") + "'"

// Cached absolute path to `claude` per SSH connection (avoids re-probing).
const remoteClaudeBin = new Map<string, string>()

function execCapture(client: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err)
      let out = ''
      stream.on('data', (d: Buffer) => (out += d.toString()))
      stream.stderr.on('data', (d: Buffer) => (out += d.toString()))
      stream.on('close', () => resolve(out))
    })
  })
}

// Resolve the remote `claude` binary. A non-interactive SSH session does NOT
// source ~/.profile/.bashrc, so `~/.local/bin` (where the official install.sh
// drops claude) isn't on PATH and a bare `command -v claude` finds nothing even
// when it's installed. So we probe a login shell *and* the well-known install
// locations explicitly. Cached per connection; pass force=true after an install.
export async function findRemoteClaude(remoteId: string, force = false): Promise<string | null> {
  if (!force) {
    const cached = remoteClaudeBin.get(remoteId)
    if (cached) return cached
  }
  const client = getSshClient(remoteId)
  if (!client) return null
  const probe =
    `sh -lc 'command -v claude 2>/dev/null' 2>/dev/null || true; ` +
    `for p in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" "$HOME/.bun/bin/claude" ` +
    `"/usr/local/bin/claude" "/usr/bin/claude"; do [ -x "$p" ] && printf '%s\\n' "$p" && break; done`
  let out = ''
  try {
    out = await execCapture(client, probe)
  } catch {
    return null
  }
  const path = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null
  if (path) remoteClaudeBin.set(remoteId, path)
  else remoteClaudeBin.delete(remoteId)
  return path
}

/** Forget the cached remote claude path (e.g. right after installing it). */
export function clearRemoteClaude(remoteId: string): void {
  remoteClaudeBin.delete(remoteId)
}

/** Ensure `claude` exists on the remote, installing it via the official
 *  installer (install.sh, → ~/.local/bin) if missing. */
async function ensureRemoteClaude(
  client: Client,
  connId: string,
  note: (msg: string) => void
): Promise<string> {
  const found = await findRemoteClaude(connId)
  if (found) return found
  note('⏳ Instalando o Claude Code no servidor (claude.ai/install.sh)…\n')
  await execCapture(client, 'curl -fsSL https://claude.ai/install.sh | bash 2>&1')
  const check = await findRemoteClaude(connId, true)
  if (!check) {
    throw new Error(
      'Não consegui instalar o Claude Code no servidor. Confirme que há `curl` e acesso à internet no remoto.'
    )
  }
  note('✓ Claude Code instalado no servidor.\n')
  return check
}

function runRemoteTurn(
  payload: SendPayload,
  turn: Turn,
  send: (channel: string, data: unknown) => void
): Promise<void> {
  return new Promise<void>((resolve) => {
    const { id, prompt, cwd, resume, model, effort, permissionMode, thinking, contextNote } = payload
    const allowedTools = permissionsFor(payload)
    const subagents = new ClaudeSubagents()
    const client = getSshClient(payload.remote!)
    if (!client) {
      send('agent:error', { id, message: 'Conexão SSH não encontrada (reconecte o servidor).' })
      return resolve()
    }

    let finished = false
    const finish = (ev?: { aborted?: boolean }): void => {
      if (finished) return
      finished = true
      subagents.close(send)
      send('agent:done', { id, ...(ev || {}) })
      resolve()
    }

    const run = async (): Promise<void> => {
      let claudeBin: string
      try {
        claudeBin = await ensureRemoteClaude(client, payload.remote!, (m) =>
          send('agent:text', { id, text: m })
        )
      } catch (err) {
        send('agent:error', { id, message: (err as Error).message })
        return resolve()
      }
      if (turn.abort.signal.aborted) return finish({ aborted: true })

      const isHaiku = (model==='haiku' || model.startsWith('claude-haiku'))
      const fullPrompt = contextNote ? `${prompt}\n\n${contextNote}` : prompt

      const args = [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--input-format',
        'stream-json',
        '--include-partial-messages',
        '--forward-subagent-text',
        '--permission-prompt-tool',
        'stdio',
        '--setting-sources=user,project,local',
        '--permission-mode',
        permissionMode || 'default'
      ]
      if (model) args.push('--model', model)
      if (!isHaiku) {
        if (effort) args.push('--effort', effort === 'ultra' ? 'max' : effort)
        args.push('--thinking', thinking === false ? 'disabled' : 'adaptive')
      }
      if (payload.serviceTier === 'fast') args.push('--settings', '{"fastMode":true}')
      if (resume) args.push('--resume', resume)

      const cmd = `cd ${shq(cwd || '.')} && exec ${shq(claudeBin)} ${args.map(shq).join(' ')}`
      // One process per turn: a resumed one starts from the session's saved totals.
      let usageBase = usageBaseFor(resume)
      let resolvedModel: string | undefined

      client.exec(cmd, { pty: false }, (err, stream: ClientChannel) => {
        if (err) {
          send('agent:error', { id, message: err.message })
          return resolve()
        }

        const writeLine = (obj: unknown): void => {
          try {
            stream.write(JSON.stringify(obj) + '\n')
          } catch {
            /* channel closed */
          }
        }

        const onAbort = (): void => {
          try {
            stream.signal('TERM')
          } catch {
            /* server may ignore signals */
          }
          try {
            stream.end()
          } catch {
            /* already closed */
          }
          finish({ aborted: true })
        }
        turn.abort.signal.addEventListener('abort', onAbort, { once: true })

        // Kick off the turn with the user's message (stdin stays open for
        // control responses; we EOF it once the result arrives).
        writeLine({
          type: 'user',
          session_id: '',
          message: { role: 'user', content: [...(fullPrompt ? [{ type: 'text', text: fullPrompt }] : []), ...(payload.images || []).map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data } }))] },
          parent_tool_use_id: null
        })

        const handleControl = (req: Record<string, any>): void => {
          const r = req.request || {}
          if (r.subtype === 'request_user_dialog') {
            writeLine({ type: 'control_response', response: {
              subtype: 'success', request_id: req.request_id, response: { behavior: 'cancelled' }
            } })
            return
          }
          if (r.subtype !== 'can_use_tool') {
            writeLine({
              type: 'control_response',
              response: { subtype: 'error', request_id: req.request_id, error: 'unsupported' }
            })
            return
          }
          const respond = (resp: Record<string, unknown>): void =>
            writeLine({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: req.request_id,
                response: { ...resp, toolUseID: r.tool_use_id }
              }
            })
          // AskUserQuestion (remote): show the question UI, answer via updatedInput.
          if (r.tool_name === 'AskUserQuestion') {
            const dialogId = `dlg${dialogSeq++}`
            send('agent:question', {
              id,
              dialogId,
              toolUseId: r.tool_use_id,
              questions: (r.input as { questions?: unknown[] })?.questions ?? []
            })
            turn.dialogs.set(dialogId, ({ cancelled, answers }) => {
              if (cancelled || !answers || Object.keys(answers).length === 0)
                respond({ behavior: 'allow', updatedInput: r.input })
              else respond({ behavior: 'allow', updatedInput: { ...r.input, answers } })
            })
            return
          }
        if (allowedTools.has(r.tool_name)) {
            respond({ behavior: 'allow', updatedInput: r.input })
            return
          }
          const permId = `perm${permSeq++}`
          send('agent:permission', {
            id,
            permId,
            toolName: r.tool_name,
            toolUseId: r.tool_use_id,
            input: r.input,
            title: r.title,
            displayName: r.display_name,
            description: r.description,
            blockedPath: r.blocked_path
          })
          turn.perms.set(permId, ({ decision, updatedInput }) => {
            if (decision === 'deny') {
              respond({ behavior: 'deny', message: 'Negado pelo usuário.' })
            } else if (decision === 'allow_always') {
              allowedTools.add(r.tool_name)
              respond({
                behavior: 'allow',
                updatedInput: updatedInput ?? r.input,
                updatedPermissions: r.permission_suggestions
              })
            } else {
              respond({ behavior: 'allow', updatedInput: updatedInput ?? r.input })
            }
          })
        }

        const handle = (msg: Record<string, any>): void => {
          if (subagents.handle(msg, id, send)) return
          switch (msg.type) {
            case 'control_request':
              handleControl(msg)
              break
            case 'control_cancel_request':
              break
            case 'system':
              if (msg.subtype === 'init') {
                if (typeof msg.model === 'string' && msg.model) resolvedModel = msg.model
                send('agent:system', {
                  id,
                  sessionId: msg.session_id,
                  model: msg.model,
                  permissionMode: msg.permissionMode,
                  tools: msg.tools,
                  fastMode: fastModeOf(msg)
                })
              }
              break
            case 'stream_event': {
              const ev = msg.event
              if (ev?.type === 'content_block_delta') {
                if (ev.delta?.type === 'text_delta') send('agent:text', { id, text: ev.delta.text })
                else if (ev.delta?.type === 'thinking_delta')
                  send('agent:thinking', { id, text: ev.delta.thinking })
              } else if (ev?.type === 'message_start' && ev.message?.usage) {
                send('agent:context', { id, usage: ev.message.usage })
              }
              break
            }
            case 'assistant':
              for (const b of msg.message?.content ?? []) {
                if (b.type === 'tool_use')
                  send('agent:tool', { id, toolId: b.id, name: b.name, input: b.input })
              }
              break
            case 'user': {
              const content = msg.message?.content
              if (Array.isArray(content)) {
                for (const b of content) {
                  if (b.type === 'tool_result') {
                    const c =
                      typeof b.content === 'string'
                        ? b.content
                        : Array.isArray(b.content)
                          ? b.content
                              .map((x: { type: string; text?: string }) =>
                                x.type === 'text' ? x.text : `[${x.type}]`
                              )
                              .join('')
                          : JSON.stringify(b.content)
                    send('agent:tool-result', {
                      id,
                      toolId: b.tool_use_id,
                      content: c,
                      isError: !!b.is_error
                    })
                  }
                }
              }
              break
            }
            case 'result': {
              const measured = measureTurn(msg, usageBase)
              usageBase = measured.base
              send('agent:result', {
                id,
                sessionId: msg.session_id,
                isError: !!msg.is_error,
                subtype: msg.subtype,
                costUsd: msg.total_cost_usd,
                durationMs: msg.duration_ms,
                numTurns: msg.num_turns,
                resultText: msg.result,
                usage: msg.usage,
                turn: measured.turn,
                model: resolvedModel,
                fastMode: fastModeOf(msg)
              })
              // Surface auth/usage errors (e.g. remote not logged in) clearly.
              if (msg.is_error && msg.result) send('agent:error', { id, message: msg.result })
              // Turn complete — EOF stdin so the remote CLI exits cleanly.
              try {
                stream.end()
              } catch {
                /* already closed */
              }
              break
            }
          }
        }

        let buffer = ''
        let stderr = ''
        let sawResult = false
        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString()
          let nl: number
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line) continue
            try {
              const ev = JSON.parse(line)
              if (ev.type === 'result') sawResult = true
              handle(ev)
            } catch {
              /* non-JSON (banner / log line) — ignore */
            }
          }
        })
        stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
        stream.on('close', (code: number) => {
          turn.abort.signal.removeEventListener('abort', onAbort)
          if (turn.abort.signal.aborted) return finish({ aborted: true })
          if (!sawResult && code) {
            send('agent:error', {
              id,
              message:
                stderr.trim() ||
                `O Claude saiu com código ${code} no servidor. Verifique a autenticação remota (claude login / ANTHROPIC_API_KEY).`
            })
          }
          finish()
        })
      })
    }

    run()
  })
}

/**
 * Journals one turn's `agent:*` events into the run journal (folded into the
 * chat on load, so a partial turn survives a crash). Writes stop at the first
 * error, error result or done; returns whether the turn is finished.
 */
function journalWriter(chatId: string, id: string): (channel: string, raw: unknown) => boolean {
  let finished = false
  const segments = new Map<string, SharedSegment>()
  return (channel, raw) => {
    const data = raw as any
    // Background agents outlive a parent result and can finish after the next
    // turn installs its sink. Their native origin ID is authoritative.
    if (channel === 'agent:subagent' && typeof data?.id === 'string' && data.agent) {
      agentStore.appendEvent(chatId, data.id, { kind: 'subagent', agent: data.agent })
      return finished
    }
    if (finished) return true
    const put = (event: any): void => agentStore.appendEvent(chatId,id,event)
    if (channel === 'agent:result') put({kind:'metrics',metrics:claudeMetrics(data)})
    if (channel === 'agent:text' || channel === 'agent:thinking') put({kind: channel === 'agent:text' ? 'text' : 'thinking',text:data.text})
    else if (channel === 'agent:system') put({kind:'session',sessionId:data.sessionId})
    else if (channel === 'agent:tool') {const segment: SharedSegment = {kind:'tool',toolId:data.toolId,name:data.name,input:data.input,status:'running'}; segments.set(data.toolId,segment);put({kind:'segment',segment})}
    else if (channel === 'agent:tool-result') {const original=segments.get(data.toolId);if(original){const segment: SharedSegment={...original,result:data.content,resultIsError:data.isError,status:data.isError?'error':'done'};segments.set(data.toolId,segment);put({kind:'segment',segment})}}
    else if (channel === 'agent:error' || channel === 'agent:result' && data.isError) {put({kind:'error',message:data.message || data.resultText || 'Falha no Claude.'});finished=true}
    else if (channel === 'agent:done') {put({kind:'done',aborted:data.aborted});finished=true}
    return finished
  }
}

export function registerClaudeAgentHandlers(): void {
  const watchedWindows = new Set<number>()

  ;(app as unknown as EventEmitter).on('prism:profile-changed', (id: unknown) => {
    for(const session of streamSessions.values()) if(!session.activeTurnId && session.signature && JSON.parse(session.signature)[0]===id) {
      session.close()
    }
    for(const key of scopedPermissions.keys()) if(key.endsWith(`:${id}`)) scopedPermissions.delete(key)
    // The host's Claude sessions too (its preload forwards it): temporary until the host owns the accounts (T08).
    for (const win of BrowserWindow?.getAllWindows?.() ?? []) if (!win.webContents.isDestroyed()) win.webContents.send('claude:profile-changed', id)
  })
  app.on('before-quit', () => {
    for (const t of turns.values()) t.abort.abort()
    for (const s of streamSessions.values()) s.close()
  })
  // Is the Claude Code CLI installed? (subscription engine). Re-probes fresh so
  // a just-installed CLI (e.g. via the install button) is detected without a
  // restart — checking PATH and ~/.local/bin.
  ipcMain.handle('agent:available', () => {
    return new Promise((resolve) => {
      let done = false
      const finish = (available: boolean, version: string): void => {
        if (done) return
        done = true
        resolve({ available, version })
      }
      const bin = findClaude(true)
      if (!bin) return finish(false, '')
      try {
        const c = spawn(bin, ['--version'], { shell: false })
        let out = ''
        c.stdout?.on('data', (d: Buffer) => (out += d.toString()))
        c.on('close', (code) => finish(code === 0, out.trim()))
        c.on('error', () => finish(false, ''))
        setTimeout(() => {
          c.kill()
          finish(false, '')
        }, 6000)
      } catch {
        finish(false, '')
      }
    })
  })

  // Is `claude` installed on the *remote* host? (force re-probes ~/.local/bin etc.)
  ipcMain.handle('agent:remoteAvailable', async (_e, remoteId: string) => {
    const path = await findRemoteClaude(remoteId, true)
    return { available: !!path, path: path || '' }
  })

  ipcMain.on('agent:permission-response', (e, p: { id: string; permId: string } & PermResponse) => {
    const turn = turns.get(p.id)
    const resolve = turn?.perms.get(p.permId)
    if (resolve && turn?.owner===e.sender.id) {
      turn!.perms.delete(p.permId)
      resolve({ decision: p.decision, updatedInput: p.updatedInput })
      return
    }
    // Streaming sessions key perms globally (permId is unique) — find the owner.
    for (const s of streamSessions.values()) {
      const r = s.perms.get(p.permId)
      if (r && (!s.owner || s.owner===e.sender.id) && (!s.unified || s.activeTurnId===p.id)) {
        s.perms.delete(p.permId)
        r({ decision: p.decision, updatedInput: p.updatedInput })
        return
      }
    }
  })

  ipcMain.on(
    'agent:question-response',
    (e, p: { id: string; dialogId: string } & DialogResponse) => {
      const turn = turns.get(p.id)
      const resolve = turn?.dialogs.get(p.dialogId)
      if (resolve && turn?.owner===e.sender.id) {
        turn!.dialogs.delete(p.dialogId)
        resolve({ cancelled: p.cancelled, answers: p.answers, response: p.response })
        return
      }
      for (const s of streamSessions.values()) {
        const r = s.dialogs.get(p.dialogId)
        if (r && (!s.owner || s.owner===e.sender.id) && (!s.unified || s.activeTurnId===p.id)) {
          s.dialogs.delete(p.dialogId)
          r({ cancelled: p.cancelled, answers: p.answers, response: p.response })
          return
        }
      }
    }
  )

  ipcMain.handle('agent:steer', (e, p: SteerMessage) => {
    const s = streamSessions.get(`unified:${p.chatId}`) ?? streamSessions.get(p.chatId)
    if (!s || s.owner !== e.sender.id || s.activeTurnId !== p.turnId || s.stoppingTurnId === p.turnId || s.abort.signal.aborted) {
      throw new Error('O turno já terminou ou está sendo interrompido. A mensagem continua na fila.')
    }
    if (s.perms.size || s.dialogs.size) throw new Error('Responda à aprovação ou pergunta antes de enviar durante o turno.')
    if (!p.text.trim() && !p.images?.length) throw new Error('Digite uma mensagem.')
    const text = p.context ? `${p.text}\n\n${p.context}` : p.text
    if (s.unified) agentStore.appendEvent(p.chatId, p.turnId, { kind: 'segment', segment: { kind: 'user', toolId: p.messageId || crypto.randomUUID(), text, images: p.images, sentAt: Date.now() } })
    s.push(text, 'now', p.images)
  })

  ipcMain.on('agent:abort', (e, id: string) => {
    const turn=turns.get(id); if(turn?.owner===e.sender.id)turn.abort.abort()
    for(const session of streamSessions.values())if(session.activeTurnId===id && session.owner===e.sender.id)session.interrupt()
  })

  // Stop the *current turn* of a streaming chat but keep the session alive (the
  // user can keep chatting). Uses the SDK's graceful interrupt.
  ipcMain.on('agent:interrupt', (_e, chatId: string) => {
    streamSessions.get(chatId)?.interrupt()
  })

  // Tear a streaming chat down entirely (new chat / tab closed).
  ipcMain.on('agent:end', (_e, chatId: string) => {
    const s = streamSessions.get(chatId)
    if (!s) return
    s.close()
  })

  // ---- Checkpoints: fork conversation / rewind code (local sessions only) ----

  const findTranscriptFile = async (sessionId: string): Promise<string | null> => {
    try {
      const projects = join(homedir(), '.claude', 'projects')
      const dirs = await readdir(projects)
      for (const d of dirs) {
        const f = join(projects, d, `${sessionId}.jsonl`)
        if (existsSync(f)) return f
      }
    } catch {
      /* noop */
    }
    return null
  }

  // Ordered UUIDs of the user's *prompt* messages in a session transcript
  // (skipping tool-result/meta user entries) — index N maps to the Nth user
  // message in the chat.
  ipcMain.handle('agent:checkpoint-ids', async (_e, sessionId: string) => {
    try {
      const file = await findTranscriptFile(sessionId)
      if (!file) return []
      const raw = await readFile(file, 'utf8')
      const out: string[] = []
      for (const ln of raw.split('\n')) {
        if (!ln.trim()) continue
        let o: any
        try {
          o = JSON.parse(ln)
        } catch {
          continue
        }
        if (o.type !== 'user' || o.isSidechain || o.isMeta) continue
        const c = o.message?.content
        const isToolResult = Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')
        const hasText =
          typeof c === 'string' || (Array.isArray(c) && c.some((b: any) => b?.type === 'text'))
        if (isToolResult || !hasText || !o.uuid) continue
        out.push(o.uuid)
      }
      return out
    } catch {
      return []
    }
  })

  // Fork the conversation into a new branch up to the given message — pure
  // transcript copy, non-destructive. Returns the new session id.
  ipcMain.handle(
    'agent:fork',
    async (_e, p: { sessionId: string; upToMessageId: string }) => {
      try {
        const sdk = await loadSdk()
        const r = await (sdk as any).forkSession(p.sessionId, { upToMessageId: p.upToMessageId })
        const file = await findTranscriptFile(r.sessionId)
        return { ok: true, sessionId: r.sessionId, file }
      } catch (err) {
        return { ok: false, error: (err as Error)?.message || String(err) }
      }
    }
  )

  // Rewind the working-tree files to their state at a given user message.
  // DESTRUCTIVE (overwrites files) — the renderer confirms first.
  ipcMain.handle(
    'agent:rewind',
    async (
      _e,
      p: { sessionId: string; userMessageId: string; cwd?: string; dryRun?: boolean }
    ) => {
      try {
        const sdk = await loadSdk()
        const ac = new AbortController()
        // Keep the session process alive (no prompt) just long enough to issue
        // the rewind control request.
        async function* idle(): AsyncGenerator<never> {
          await new Promise<void>((res) =>
            ac.signal.addEventListener('abort', () => res(), { once: true })
          )
        }
        const options: any = {
          resume: p.sessionId,
          cwd: p.cwd || undefined,
          enableFileCheckpointing: true,
          permissionMode: 'bypassPermissions',
          abortController: ac,
          settingSources: ['user', 'project', 'local']
        }
        const exe = resolveCliPath()
        if (exe) options.pathToClaudeCodeExecutable = exe
        const q: any = sdk.query({ prompt: idle(), options })
        try {
          const res = await q.rewindFiles(p.userMessageId, { dryRun: !!p.dryRun })
          return { ok: true, ...res }
        } finally {
          ac.abort()
          try {
            await q.return?.()
          } catch {
            /* noop */
          }
        }
      } catch (err) {
        return { ok: false, error: (err as Error)?.message || String(err) }
      }
    }
  )

  ipcMain.on('agent:send', async (e, payload: SendPayload) => {
    const { id, prompt, cwd, resume, model, effort, permissionMode, thinking, contextNote } = payload
    const wc: WebContents = e.sender
    if (!watchedWindows.has(wc.id)) {
      watchedWindows.add(wc.id)
      wc.once('destroyed', () => {
        watchedWindows.delete(wc.id)
        for (const t of turns.values()) if (t.owner === wc.id) t.abort.abort()
        for (const session of streamSessions.values()) if(session.owner===wc.id)session.close()
      })
    }
    const allowedTools = permissionsFor(payload)
    let journalStarted = false
    const journal = payload.chat ? journalWriter(payload.chat.id, id) : null
    const send = (channel: string, raw: unknown): void => {
      if (journal && journalStarted) journal(channel, raw)
      if (!wc.isDestroyed()) wc.send(channel, raw)
    }
    let profileEnv: NodeJS.ProcessEnv
    try {
      profileEnv = profileEnvironment('claude', payload.profileId)
      if (payload.permissionScope && [...turns.values()].some(t => t.scope === payload.permissionScope)) throw new Error('Este chat já está executando uma tarefa.')
      if (payload.remote && payload.profileId && payload.profileId !== 'ambient-claude') {
        throw new Error('Contas gerenciadas são locais. No SSH, use a conta do terminal do servidor.')
      }
      if (payload.remote && payload.remoteTarget && !matchesSshTarget(payload.remote, payload.remoteTarget, wc.id)) {
        throw new Error('A conexão SSH não corresponde ao servidor e usuário desta conversa. Reconecte o destino correto.')
      }
    } catch (err) {
      send('agent:error', { id, message: (err as Error).message })
      return
    }

    if (payload.chat) {
      const live=streamSessions.get(`unified:${payload.chat.id}`)
      if(live && (live.owner!==wc.id || live.activeTurnId)){send('agent:error',{id,message:'Este chat já está executando uma tarefa.'});return}
      agentStore.beginRun(payload.chat,id); journalStarted=true
    }

    // Local streaming chat: push into (or start) the long-lived query for this
    // chat. Supports sending while busy — queue or mid-turn steer.
    if ((payload.chatId || payload.chat) && !payload.remote) {
      if(payload.chat)payload.chatId=`unified:${payload.chat.id}`
      await sendToStreamingSession(payload, send, wc.id)
      return
    }

    const abort = new AbortController()
    const turn: Turn = { abort, owner: wc.id, scope: payload.permissionScope, perms: new Map(), dialogs: new Map() }
    turns.set(id, turn)

    // Remote connection: drive the remote `claude` over SSH instead of the
    // local SDK, so the agent operates on the server's files.
    if (payload.remote) {
      try {
        await runRemoteTurn(payload, turn, send)
      } finally {
        turns.delete(id)
      }
      return
    }

    let sdk: typeof import('@anthropic-ai/claude-agent-sdk')
    try {
      sdk = await loadSdk()
    } catch (err) {
      send('agent:error', {
        id,
        message: 'Falha ao carregar o Claude Agent SDK: ' + ((err as Error)?.message || String(err))
      })
      turns.delete(id)
      return
    }

    const fullPrompt = contextNote ? `${prompt}\n\n${contextNote}` : prompt
    const isHaiku = (model==='haiku' || model.startsWith('claude-haiku'))

    const canUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
      opts: {
        signal: AbortSignal
        suggestions?: unknown[]
        toolUseID: string
        title?: string
        displayName?: string
        description?: string
        blockedPath?: string
      }
    ): Promise<
      | { behavior: 'allow'; updatedInput: Record<string, unknown>; updatedPermissions?: unknown[] }
      | { behavior: 'deny'; message: string; interrupt?: boolean }
    > => {
      // AskUserQuestion is answered (not permission-gated): show the question UI
      // and return the chosen answers via `updatedInput.answers` (the exact shape
      // the CLI reads — verified against the binary).
      if (toolName === 'AskUserQuestion') {
        return waitForQuestion(send, id, turn.dialogs, input, opts.signal, opts.toolUseID)
      }

      if (allowedTools.has(toolName)) return { behavior: 'allow', updatedInput: input }

      const permId = `perm${permSeq++}`
      send('agent:permission', {
        id,
        permId,
        toolName,
        toolUseId: opts.toolUseID,
        input,
        title: opts.title,
        displayName: opts.displayName,
        description: opts.description,
        blockedPath: opts.blockedPath
      })

      return new Promise((resolve) => {
        const onAbort = (): void => {
          if (turn.perms.has(permId)) {
            turn.perms.delete(permId)
            resolve({ behavior: 'deny', message: 'Cancelado.' })
          }
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })

        turn.perms.set(permId, ({ decision, updatedInput }) => {
          opts.signal.removeEventListener('abort', onAbort)
          if (decision === 'deny') {
            resolve({ behavior: 'deny', message: 'Negado pelo usuário.' })
            return
          }
          if (decision === 'allow_always') {
            allowedTools.add(toolName)
            resolve({
              behavior: 'allow',
              updatedInput: updatedInput ?? input,
              updatedPermissions: opts.suggestions as unknown[] | undefined
            })
            return
          }
          resolve({ behavior: 'allow', updatedInput: updatedInput ?? input })
        })
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = {
      cwd: cwd || undefined,
      env: profileEnv,
      model: model || undefined,
      permissionMode: permissionMode || 'default',
      includePartialMessages: true,
      forwardSubagentText: true,
      abortController: abort,
      toolConfig: { askUserQuestion: { previewFormat: 'markdown' } },
      canUseTool,
      onUserDialog: async () => ({ behavior: 'cancelled' }),
      // Snapshot files before edits so the conversation can be "rewound" to a
      // previous message (Fork/Rewind menu).
      enableFileCheckpointing: true,
      // Respect the user's real Claude Code config: saved allow-rules, CLAUDE.md,
      // project + local settings, skills and custom commands.
      settingSources: ['user', 'project', 'local']
    }
    // Use the user's installed CLI when available (robust against a missing SDK
    // native binary; carries their subscription login).
    const exe = resolveCliPath(payload.profileId)
    if (exe) options.pathToClaudeCodeExecutable = exe
    if (resume) options.resume = resume
    if (!isHaiku) {
      if (effort) options.effort = effort === 'ultra' ? 'max' : effort
      options.thinking = thinking === false ? { type: 'disabled' } : { type: 'adaptive' }
    }
    options.settings = { fastMode: payload.serviceTier === 'fast' }

    // A query of its own: a resumed one starts from the session's saved totals.
    let usageBase = usageBaseFor(resume)
    let resolvedModel: string | undefined
    const subagents = new ClaudeSubagents()
    try {
      async function* imagePrompt() { yield userMsg(fullPrompt, undefined, payload.images) }
      const q = sdk.query({ prompt: payload.images?.length ? imagePrompt() : fullPrompt, options })

      for await (const msg of q as AsyncIterable<Record<string, any>>) {
        if (subagents.handle(msg, id, send)) continue
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init') {
              if (typeof msg.model === 'string' && msg.model) resolvedModel = msg.model
              send('agent:system', {
                id,
                sessionId: msg.session_id,
                model: msg.model,
                permissionMode: msg.permissionMode,
                tools: msg.tools,
                fastMode: fastModeOf(msg)
              })
            }
            break

          case 'stream_event': {
            const ev = msg.event
            if (ev?.type === 'content_block_delta') {
              if (ev.delta?.type === 'text_delta') {
                send('agent:text', { id, text: ev.delta.text })
              } else if (ev.delta?.type === 'thinking_delta') {
                send('agent:thinking', { id, text: ev.delta.thinking })
              }
            } else if (ev?.type === 'message_start' && ev.message?.usage) {
              // Live context usage — the input tokens here = the whole context
              // sent for this turn, so the donut updates as the reply begins.
              send('agent:context', { id, usage: ev.message.usage })
            }
            break
          }

          case 'assistant':
            for (const b of msg.message?.content ?? []) {
              if (b.type === 'tool_use') {
                send('agent:tool', { id, toolId: b.id, name: b.name, input: b.input })
              }
            }
            break

          case 'user': {
            const content = msg.message?.content
            if (Array.isArray(content)) {
              for (const b of content) {
                if (b.type === 'tool_result') {
                  const c =
                    typeof b.content === 'string'
                      ? b.content
                      : Array.isArray(b.content)
                        ? b.content
                            .map((x: { type: string; text?: string }) =>
                              x.type === 'text' ? x.text : `[${x.type}]`
                            )
                            .join('')
                        : JSON.stringify(b.content)
                  send('agent:tool-result', {
                    id,
                    toolId: b.tool_use_id,
                    content: c,
                    isError: !!b.is_error
                  })
                }
              }
            }
            break
          }

          case 'result': {
            const measured = measureTurn(msg, usageBase)
            usageBase = measured.base
            send('agent:result', {
              id,
              sessionId: msg.session_id,
              isError: !!msg.is_error,
              subtype: msg.subtype,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              numTurns: msg.num_turns,
              resultText: msg.result,
              usage: msg.usage,
              turn: measured.turn,
              model: resolvedModel,
              fastMode: fastModeOf(msg)
            })
            break
          }
        }
      }
      send('agent:done', { id })
    } catch (err) {
      if (abort.signal.aborted) {
        send('agent:done', { id, aborted: true })
      } else {
        send('agent:error', { id, message: (err as Error)?.message || String(err) })
      }
    } finally {
      subagents.close(send)
      turns.delete(id)
    }
  })
}
