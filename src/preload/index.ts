import { contextBridge, ipcRenderer, webUtils, IpcRendererEvent } from 'electron'
import type { Provider, ProviderProfile, ProfileStatus, UnifiedChat, AgentTask, AgentModel, ProfileDetails, ChatImage, CodexSend, CodexEvent, SteerMessage, LoginEvent, SubagentUpdate, SubagentInfo } from '../shared/agents'
import type { TraycerImportPreview, TraycerImportRequest, TraycerImportResult, TraycerActivity, TraycerTaskRecord } from '../shared/traycerImport'
import { HostClient, type HostStatus } from '../shared/host/client'
import { firstHelloGate, gated, routeFor, stickyRoute, type Route } from '../shared/host/routing'
import { createHostTerminal, hostSettled, routedTerminal, type TerminalCreateOptions, type TerminalDataEvent, type TerminalExitEvent, type TerminalStart } from '../shared/host/api/terminal'
import { routed } from '../shared/host/routing'
import { createHostFs } from '../shared/host/api/fs'
import { createHostNav, createHostSearch } from '../shared/host/api/search'
import { createHostGit } from '../shared/host/api/git'
import { createHostWorkspace } from '../shared/host/api/workspace'
import { createHostSessions } from '../shared/host/api/sessions'
import { createHostCommands } from '../shared/host/api/commands'
import { CLAUDE_EVENT_MEMBERS, createHostClaude, hostCommitMessage } from '../shared/host/api/claude'
import { createHostCodex, hostCodexPrompts } from '../shared/host/api/codex'
import { createHostChats } from '../shared/host/api/chats'
import { createHostAgentCommands, createHostProviders } from '../shared/host/api/providers'
import { createHostUsage } from '../shared/host/api/usage'
import { createHostRemote, type RemoteControlAck, type RemoteControlEnableResult, type RemoteControlStatus, type RemoteControlStopReason } from '../shared/host/api/remote'
import type { CliAvailability } from '../shared/host/generated/CliAvailability'
import { nodeLocalFiles, nodeTransfer } from './hostTransfer'

type Unsub = () => void

/**
 * This window's connection to the Prism host (Rust backend). The main
 * process starts or finds the host and hands over port and token; the token
 * stays here in the preload and is never exposed to the page.
 */
const hostClient = new HostClient({
  client: { kind: 'desktop', version: '' },
  resolve: async () => {
    const connection = (await ipcRenderer.invoke('host:connection')) as { port: number; token: string; clientVersion?: string } | null
    return connection && { url: `ws://127.0.0.1:${connection.port}/rpc`, token: connection.token, clientVersion: connection.clientVersion }
  }
})
hostClient.start()

/**
 * Which side serves a domain right now. A domain moves to the host by
 * wrapping its IPC object: `fs: routed('fs', { ...ipc }, () => hostFs, route)`,
 * with the host implementation in src/shared/host/api/ and the domain name
 * added to HOST_READY_DOMAINS (src/shared/host/routing.ts). The accounts
 * stay on the host once it served them (HOST_STICKY_DOMAINS).
 */
const route = stickyRoute((domain: string): Route => routeFor(domain, hostClient.capabilities()))

function on<T>(channel: string, cb: (data: T) => void): Unsub {
  const listener = (_e: IpcRendererEvent, data: T): void => cb(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** Both subscriptions, undone together. */
function both(a: Unsub, b: Unsub): Unsub {
  return () => { a(); b() }
}

/** Bytes to and from the host's `/files` (the token never leaves the preload). */
const hostFiles = nodeTransfer(() => hostClient.http())

/**
 * A domain served by the host when it can, with its IPC object as the
 * fallback the host implementation also uses. Members in `always` take the
 * host implementation on both routes (subscriptions that must hear both).
 * With a `gate`, the members the host serves wait for it before picking a
 * side (subscriptions never wait: they already hear both).
 */
function withHost<T extends object>(domain: string, ipc: T, make: (ipc: T) => Partial<T>, always: (keyof T)[] = [], gate?: () => Promise<void> | null): T {
  const host = make(ipc)
  const base: T = { ...ipc }
  for (const key of always) {
    const member = host[key]
    if (typeof member === 'function') base[key] = member as T[keyof T]
  }
  const api = routed(domain, base, () => host, route)
  if (!gate) return api
  return gated(api, (Object.keys(host) as (keyof T)[]).filter((key) => typeof host[key] === 'function' && !always.includes(key)), gate)
}

/** A call made while connecting waits this long in HostClient too. */
const FIRST_HELLO_MS = 30_000
let binary: Promise<boolean> | undefined
/** The app has a host binary: the host owns the chats and, from T08, the accounts. Asked once. */
const hostBinary = (): Promise<boolean> => binary ??= ipcRenderer.invoke('host:owns-chats').then((owned) => owned === true, () => false)
/**
 * The accounts never reach IPC before this window's first `hello` when there
 * is a host binary: the host took them over from `prism-agents.db` once, so
 * the IPC side's copy is old (src/shared/host/routing.ts). Remote control
 * waits the same way (T09): the host owns the sharing.
 */
const accountsGate = firstHelloGate({ owned: hostBinary, onStatus: (listener) => hostClient.onStatus(listener), ms: FIRST_HELLO_MS })

const api = {
  // The Prism host connection (src/shared/host). Domains move from IPC to
  // the host one by one through `routed()` (src/shared/host/routing.ts).
  host: {
    status: (): HostStatus => hostClient.status(),
    onStatus: (cb: (status: HostStatus) => void): Unsub => hostClient.onStatus(cb),
    capabilities: (): readonly string[] => hostClient.capabilities(),
    /** Which side serves a `window.prism` domain right now. */
    route: (domain: string): Route => route(domain)
  },
  // Embedded browser panel (components/browser; main: ipc/browser.ts).
  browser: {
    onEvent: (cb: (event: unknown) => void): Unsub => on('browser:event', cb),
    clearSiteCookies: (url: string): Promise<{ site: string | null; removed: number }> => ipcRenderer.invoke('browser:clear-site-cookies', url),
    trustCertificate: (origin: string, fingerprint: string): Promise<void> => ipcRenderer.invoke('browser:trust-certificate', origin, fingerprint),
    localServers: (): Promise<{ port: number; pid: number; processName: string }[]> => ipcRenderer.invoke('browser:local-servers'),
    favicon: (url: string): Promise<string | null> => ipcRenderer.invoke('browser:favicon', url)
  },
  traycer: {
    tasks: (): Promise<TraycerTaskRecord[]> => ipcRenderer.invoke('traycer:tasks'),
    activity: (epicId: string): Promise<TraycerActivity> => ipcRenderer.invoke('traycer:activity', epicId),
    transcript: (epicId: string, chatId: string): Promise<import('../shared/agents').SharedTurn[]> => ipcRenderer.invoke('traycer:transcript', epicId, chatId),
    preview: (root?: string): Promise<TraycerImportPreview> => ipcRenderer.invoke('traycer:preview', root),
    chooseRoot: (): Promise<string | null> => ipcRenderer.invoke('traycer:choose-root'),
    import: (request: TraycerImportRequest): Promise<TraycerImportResult> => ipcRenderer.invoke('traycer:import', request),
    /** Refresh one already-imported chat's history from Traycer, unless it was continued in Prism. */
    reimportChat: (chatId: string): Promise<TraycerImportResult> => ipcRenderer.invoke('traycer:reimport-chat', chatId)
  },
  tasks: {
    flush: (tasks: AgentTask[], openIds: string[], activeId: string | null): {ok: boolean} => ipcRenderer.sendSync('tasks:flush',tasks,openIds,activeId),
    load: (): Promise<{tasks: AgentTask[]; openIds: string[]; activeId: string | null}> => ipcRenderer.invoke('tasks:load'),
    save: (tasks: AgentTask[], openIds: string[], activeId: string | null): Promise<void> => ipcRenderer.invoke('tasks:save', tasks, openIds, activeId)
  },
  // Accounts, logins, limits and catalogs (T08): on the host when it serves
  // `providers@1` (src/shared/host/api/providers.ts); the Traycer links stay
  // here. `onLogin` and `onChanged` hear both sides.
  providers: withHost('providers', {
    details: (provider: Provider, profileId: string, refresh = false): Promise<ProfileDetails> => ipcRenderer.invoke('providers:details',provider,profileId,refresh),
    /** Spends one real Codex manual reset; `idempotencyKey` is per confirmed attempt, so a retry never spends twice. */
    codexReset: (profileId: string, idempotencyKey: string, creditId: string | null): Promise<{ outcome: import('../shared/providerUsage').CodexResetOutcome }> => ipcRenderer.invoke('providers:codex-reset', profileId, idempotencyKey, creditId),
    models: (provider: Provider, profileId: string, refresh = false): Promise<AgentModel[]> => ipcRenderer.invoke('providers:models', provider, profileId, refresh),
    update: (id: string, patch: {name?: string; enabled?: boolean; color?: string}): Promise<ProviderProfile[]> => ipcRenderer.invoke('providers:update', id, patch),
    list: (): Promise<ProviderProfile[]> => ipcRenderer.invoke('providers:list'),
    create: (provider: Provider, name: string): Promise<ProviderProfile> => ipcRenderer.invoke('providers:create', provider, name),
    rename: (id: string, name: string): Promise<ProviderProfile[]> => ipcRenderer.invoke('providers:rename', id, name),
    status: (provider: Provider, id: string): Promise<ProfileStatus> => ipcRenderer.invoke('providers:status', provider, id),
    /** Starts the CLI login; resolves to the session id every event of this login carries. */
    login: (provider: Provider, id: string, options?: { session?: string; cols?: number; rows?: number }): Promise<string> => ipcRenderer.invoke('providers:login', provider, id, options),
    loginInput: (id: string, text: string): void => ipcRenderer.send('providers:login-input', id, text),
    loginResize: (id: string, size: { cols: number; rows: number }): void => ipcRenderer.send('providers:login-resize', id, size),
    /** `session` limits the cancel to that login, so a stale cancel never ends a newer one. */
    loginCancel: (id: string, session?: string): void => ipcRenderer.send('providers:login-cancel', id, session),
    onLogin: (cb: (event: LoginEvent & { session?: string }) => void): Unsub => on('providers:login-event', cb),
    /** Tombstones a profile, ends its login and moves its chats to the terminal account. */
    remove: (id: string): Promise<ProviderProfile[]> => ipcRenderer.invoke('providers:remove', id),
    /** Is the provider's CLI installed, and (on the host) is its version a verified one. */
    available: (provider: Provider): Promise<CliAvailability> => provider === 'claude'
      ? ipcRenderer.invoke('agent:available')
      : (ipcRenderer.invoke('providers:status', provider, `ambient-${provider}`) as Promise<ProfileStatus>).then((s) => ({ available: s.installed, version: '' })),
    /** The new profile list after any change; only the host announces it. */
    onChanged: (_cb: (profiles: ProviderProfile[]) => void): Unsub => () => undefined,
    /** Profiles imported from Traycer still on their old login copy while Traycer's own login is available. */
    traycerLinks: (): Promise<{ id: string; provider: Provider; name: string }[]> => ipcRenderer.invoke('traycer:pending-links'),
    /** The user's consent: the profile drops its old copy and shares Traycer's login. Resolves to the profile list. */
    linkTraycer: (id: string): Promise<ProviderProfile[]> => ipcRenderer.invoke('traycer:link-login', id),
    /** Back to the profile's own login (a Prism sign-in is needed afterwards). Resolves to the profile list. */
    unlinkTraycer: (id: string): Promise<ProviderProfile[]> => ipcRenderer.invoke('traycer:unlink-login', id)
  }, (ipc) => createHostProviders(hostClient, ipc), ['onLogin', 'onChanged'], accountsGate),
  chats: {
    list: (): Promise<UnifiedChat[]> => ipcRenderer.invoke('chats:list'),
    save: (chat: UnifiedChat): Promise<boolean> => ipcRenderer.invoke('chats:save', chat),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('chats:delete', id),
    flush: (chats: UnifiedChat[]): { ok: boolean; error?: string } => ipcRenderer.sendSync('chats:flush', chats),
    /** The host binary exists, so the host owns the chats once it serves `chats@1` (T07). */
    hostOwned: (): Promise<boolean> => ipcRenderer.invoke('host:owns-chats').then((owned) => owned === true, () => false),
    /** The host's `chats.*` (src/shared/host/api/chats.ts), when it owns the chats. */
    host: createHostChats(hostClient)
  },
  // Codex chats (T05): the host's app-server client when connected, else
  // ipc/nativeCodex.ts. The bridge forwards login changes (src/shared/host/api/codex.ts).
  codex: withHost('codex', {
    permission: (chatId: string, requestId: string, decision: string): void => ipcRenderer.send('codex:permission', chatId, requestId, decision),
    question: (chatId: string, requestId: string, answers?: Record<string, string>): void => ipcRenderer.send('codex:question', chatId, requestId, answers),
    send: (payload: CodexSend): void => ipcRenderer.send('codex:send', payload),
    abort: (chatId: string): void => ipcRenderer.send('codex:abort', chatId),
    steer: (payload: SteerMessage): Promise<void> => ipcRenderer.invoke('codex:steer', payload),
    onEvent: (cb: (event: CodexEvent) => void): Unsub => on('codex:event', cb)
  }, (ipc) => createHostCodex(hostClient, ipc, {
    onProfileChanged: (cb) => on('codex:profile-changed', cb)
  }), ['onEvent']),
  app: {
    logo: (): Promise<string> => ipcRenderer.invoke('app:logo'),
    info: (): Promise<{ platform: string; version: string }> => ipcRenderer.invoke('app:info'),
    addRecent: (folder: string): Promise<string[]> => ipcRenderer.invoke('app:addRecent', folder),
    getRecents: (): Promise<string[]> => ipcRenderer.invoke('app:getRecents'),
    addRecentWorkspace: (file: string): Promise<string[]> =>
      ipcRenderer.invoke('app:addRecentWorkspace', file),
    addRecentRemote: (remote: RecentRemoteIpc): Promise<RecentRemoteIpc[]> =>
      ipcRenderer.invoke('app:addRecentRemote', remote),
    getRecentRemotes: (): Promise<RecentRemoteIpc[]> =>
      ipcRenderer.invoke('app:getRecentRemotes'),
    // Resolve the absolute OS path of a File dropped from outside the app.
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
    // Files / image copied from the OS file manager (for explorer Ctrl+V paste).
    clipboardFiles: (): Promise<{ paths: string[]; image: string | null }> =>
      ipcRenderer.invoke('clipboard:files'),
    notify: (title: string, body: string, force = false): void =>
      ipcRenderer.send('app:notify', { title, body, force }),
    // Taskbar unread badge: count + a pre-rendered overlay image (renderer-drawn).
    setBadge: (count: number, dataUrl: string | null): void =>
      ipcRenderer.send('app:set-badge', { count, dataUrl }),
    revealInFolder: (p: string): Promise<void> => ipcRenderer.invoke('app:revealInFolder', p),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url)
  },
  // Manage the Claude login used by the agent (local, or remote when an SSH
  // connection id is passed).
  auth: {
    status: (remoteId?: string): Promise<AuthStatusIpc> =>
      ipcRenderer.invoke('auth:status', remoteId),
    logout: (remoteId?: string): Promise<{ ok: boolean; out: string }> =>
      ipcRenderer.invoke('auth:logout', remoteId),
    loginStart: (remoteId: string | undefined, mode: 'claudeai' | 'console'): void =>
      ipcRenderer.send('auth:loginStart', { remoteId, mode }),
    loginInput: (data: string): void => ipcRenderer.send('auth:loginInput', data),
    loginCancel: (): void => ipcRenderer.send('auth:loginCancel'),
    onLoginData: (cb: (data: string) => void): Unsub => on('auth:login-data', cb),
    onLoginExit: (cb: (d: { code: number }) => void): Unsub => on('auth:login-exit', cb)
  },
  // Install the Claude Code CLI locally (official installer), streaming output.
  cli: {
    install: (remoteId?: string): void => ipcRenderer.send('cli:install', { remoteId }),
    cancel: (): void => ipcRenderer.send('cli:install-cancel'),
    onData: (cb: (data: string) => void): Unsub => on('cli:install-data', cb),
    onExit: (cb: (d: { code: number }) => void): Unsub => on('cli:install-exit', cb)
  },
  window: {
    minimize: (): void => ipcRenderer.send('window:minimize'),
    toggleMaximize: (): void => ipcRenderer.send('window:maximize-toggle'),
    close: (): void => ipcRenderer.send('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    onMaximizeChange: (cb: (v: boolean) => void): Unsub => on('window:maximized', cb),
    newWindow: (): void => ipcRenderer.send('window:new')
  },
  // T03 domains (src/shared/host/api/): on the host when it serves them; the
  // IPC side (main: ipc/*.ts) is the fallback and keeps SSH workspaces.
  workspace: withHost('workspace', {
    save: (folders: string[]): Promise<string | null> =>
      ipcRenderer.invoke('workspace:save', folders),
    open: (): Promise<{ file: string; folders: string[] } | null> =>
      ipcRenderer.invoke('workspace:open'),
    read: (file: string): Promise<{ file: string; folders: string[] } | null> =>
      ipcRenderer.invoke('workspace:read', file)
  }, (ipc) => createHostWorkspace({ client: hostClient, ipc, picker: {
    savePath: (folders) => ipcRenderer.invoke('dialog:workspaceSavePath', folders),
    openPath: () => ipcRenderer.invoke('dialog:workspaceOpenPath')
  } })),
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
    openFile: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile')
  },
  fs: withHost('fs', {
    readDir: (p: string): Promise<{ name: string; path: string; isDir: boolean }[]> =>
      ipcRenderer.invoke('fs:readDir', p),
    listFiles: (root: string): Promise<{ path: string; rel: string }[]> =>
      ipcRenderer.invoke('fs:listFiles', root),
    readFile: (p: string): Promise<string> => ipcRenderer.invoke('fs:readFile', p),
    readFileBytes: (p: string): Promise<string> => ipcRenderer.invoke('fs:readFileBytes', p),
    writeFile: (p: string, c: string): Promise<boolean> => ipcRenderer.invoke('fs:writeFile', p, c),
    createFile: (p: string): Promise<{ name: string; path: string; isDir: boolean }> =>
      ipcRenderer.invoke('fs:createFile', p),
    createDir: (p: string): Promise<{ name: string; path: string; isDir: boolean }> =>
      ipcRenderer.invoke('fs:createDir', p),
    rename: (a: string, b: string): Promise<boolean> => ipcRenderer.invoke('fs:rename', a, b),
    move: (src: string, destDir: string): Promise<string> =>
      ipcRenderer.invoke('fs:move', src, destDir),
    copyPath: (src: string, destDir: string): Promise<string> =>
      ipcRenderer.invoke('fs:copyPath', src, destDir),
    duplicate: (src: string): Promise<string> => ipcRenderer.invoke('fs:duplicate', src),
    delete: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:delete', p),
    /** Recoverable delete into the OS trash / Recycle Bin (local paths only). */
    trash: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:trash', p),
    importPaths: (paths: string[], destDir: string): Promise<string[]> =>
      ipcRenderer.invoke('fs:importPaths', paths, destDir),
    saveTempImage: (dataUrl: string): Promise<string> =>
      ipcRenderer.invoke('fs:saveTempImage', dataUrl)
  }, (ipc) => createHostFs({ client: hostClient, transfer: hostFiles, local: nodeLocalFiles, ipc })),
  // Terminals (src/shared/host/api/terminal.ts): on the host they outlive
  // the window; each terminal stays on the side that created it. The IPC
  // side (main: ipc/terminal.ts) is the fallback when there is no host.
  terminal: routedTerminal({
    init: (cwd?: string): Promise<string> => ipcRenderer.invoke('terminal:init', cwd),
    setCwd: (cwd: string): Promise<string> => ipcRenderer.invoke('terminal:setCwd', cwd),
    create: (opts: TerminalCreateOptions): Promise<TerminalStart> => {
      ipcRenderer.send('terminal:create', opts)
      return Promise.resolve({ ok: true, persistent: false })
    },
    input: (p: { id: string; data: string }): void => ipcRenderer.send('terminal:input', p),
    resize: (p: { id: string; cols: number; rows: number }): void =>
      ipcRenderer.send('terminal:resize', p),
    kill: (id: string): void => ipcRenderer.send('terminal:kill', { id }),
    onData: (cb: (d: TerminalDataEvent) => void): Unsub => on('terminal:data', cb),
    onExit: (cb: (d: TerminalExitEvent) => void): Unsub => on('terminal:exit', cb),
    list: () => Promise.resolve([]),
    attach: () => Promise.resolve({ ok: false, error: 'O host do Prism não está conectado.' })
  }, createHostTerminal(hostClient), () => route('terminal'), () => hostSettled(hostClient)),
  settings: {
    getAll: (): Promise<{
      model: string
      oneMillionContext: boolean
      effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      thinkingEnabled: boolean
      chatEngine: 'agent' | 'api'
      permissionMode: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
      animations: boolean
      notifyOnAsk: boolean
      notifyOnDone: boolean
      fontSize: number
      tabSize: number
      theme: string
      wordWrap: boolean
      recentFolders: string[]
      recentWorkspaces: string[]
      sidebarWidth: number
      chatWidth: number
      terminalHeight: number
      apiKeyConfigured: boolean
    }> => ipcRenderer.invoke('settings:getAll'),
    set: (key: string, value: unknown): Promise<boolean> =>
      ipcRenderer.invoke('settings:set', key, value)
  },
  // Claude chats: the host's native Claude Code client when it serves
  // `claude@1` (src/shared/host/api/claude.ts), else the Agent SDK in main.
  // Subscriptions hear both sides (SSH chats stay on IPC).
  claude: withHost('claude', {
    // --- Agentic engine (official Claude Agent SDK; subscription, real tools) ---
    agentAvailable: (): Promise<{ available: boolean; version: string }> =>
      ipcRenderer.invoke('agent:available'),
    // Is `claude` installed on the remote host (resolved via ~/.local/bin etc.)?
    agentRemoteAvailable: (remoteId: string): Promise<{ available: boolean; path: string }> =>
      ipcRenderer.invoke('agent:remoteAvailable', remoteId),
    agentSend: (payload: {
      id: string
      chat?: UnifiedChat
      profileId?: string
      permissionScope?: string
      remoteTarget?: { host: string; port: number; username: string }
      // Local streaming chat key (long-lived query, queue + mid-turn steering).
      chatId?: string
      prompt: string
      cwd?: string
      resume?: string
      model: string
      effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
      permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
      serviceTier?: string
      thinking?: boolean
      contextNote?: string
      images?: ChatImage[]
      remote?: string
    }): void => ipcRenderer.send('agent:send', payload),
    agentAbort: (id: string): void => ipcRenderer.send('agent:abort', id),
    agentSteer: (payload: SteerMessage): Promise<void> => ipcRenderer.invoke('agent:steer', payload),
    // Streaming chats: gracefully stop the current turn (session stays alive) /
    // tear the whole chat session down.
    agentInterrupt: (chatId: string): void => ipcRenderer.send('agent:interrupt', chatId),
    agentEnd: (chatId: string): void => ipcRenderer.send('agent:end', chatId),
    onAgentSubagent: (cb: (d: { id: string; agent: SubagentUpdate }) => void): Unsub => on('agent:subagent', cb),
    // A new assistant turn began in a streaming chat — the renderer opens a bubble.
    onAgentTurnStart: (
      cb: (d: {
        chatId: string
        id: string
        sessionId: string
        model: string
        permissionMode: string
        tools: string[]
      }) => void
    ): Unsub => on('agent:turn-start', cb),
    // Checkpoints: fork conversation / rewind code at a given message.
    agentCheckpointIds: (sessionId: string): Promise<string[]> =>
      ipcRenderer.invoke('agent:checkpoint-ids', sessionId),
    agentFork: (p: { sessionId: string; upToMessageId: string }): Promise<{
      ok: boolean
      sessionId?: string
      file?: string
      error?: string
    }> => ipcRenderer.invoke('agent:fork', p),
    agentRewind: (p: {
      sessionId: string
      userMessageId: string
      cwd?: string
      dryRun?: boolean
    }): Promise<{
      ok: boolean
      canRewind?: boolean
      filesChanged?: string[]
      insertions?: number
      deletions?: number
      error?: string
    }> => ipcRenderer.invoke('agent:rewind', p),
    agentRespondPermission: (payload: {
      id: string
      permId: string
      decision: 'allow' | 'allow_always' | 'deny'
      updatedInput?: Record<string, unknown>
    }): void => ipcRenderer.send('agent:permission-response', payload),
    // Interactive question (AskUserQuestion) from the agent.
    // Codex questions arrive here too: by IPC (nativeCodex.ts) or from the host (T05).
    onAgentQuestion: (
      cb: (d: {
        id: string
        dialogId: string
        toolUseId?: string
        questions: QuestionIpc[]
      }) => void
    ): Unsub => both(on('agent:question', cb), hostCodexPrompts(hostClient).onQuestion(cb)),
    agentRespondQuestion: (payload: {
      id: string
      dialogId: string
      cancelled?: boolean
      answers?: Record<string, string>
      response?: string
    }): void => ipcRenderer.send('agent:question-response', payload),
    onAgentSystem: (
      cb: (d: {
        id: string
        sessionId: string
        model: string
        permissionMode: string
        tools: string[]
        /** Whether Fast actually serves this session ('on' | 'off' | 'cooldown') and why not. */
        fastMode?: { state: string; reason?: string }
      }) => void
    ): Unsub => on('agent:system', cb),
    onAgentText: (cb: (d: { id: string; text: string }) => void): Unsub => on('agent:text', cb),
    onAgentThinking: (cb: (d: { id: string; text: string }) => void): Unsub =>
      on('agent:thinking', cb),
    onAgentTool: (
      cb: (d: { id: string; toolId: string; name: string; input: unknown }) => void
    ): Unsub => on('agent:tool', cb),
    onAgentToolResult: (
      cb: (d: { id: string; toolId: string; content: string; isError: boolean }) => void
    ): Unsub => on('agent:tool-result', cb),
    // Codex approvals arrive here too: by IPC (nativeCodex.ts) or from the host (T05).
    onAgentPermission: (
      cb: (d: {
        id: string
        permId: string
        toolName: string
        toolUseId: string
        input: Record<string, unknown>
        title?: string
        displayName?: string
        description?: string
        blockedPath?: string
      }) => void
    ): Unsub => both(on('agent:permission', cb), hostCodexPrompts(hostClient).onPermission(cb)),
    onAgentResult: (
      cb: (d: {
        id: string
        chatId?: string
        sessionId: string
        isError: boolean
        subtype: string
        costUsd?: number
        durationMs?: number
        numTurns?: number
        resultText?: string
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
        fastMode?: { state: string; reason?: string }
        /** Why it failed, when known (`cli_auth`: the login is gone; the host's Claude sends it). */
        code?: string
      }) => void
    ): Unsub => on('agent:result', cb),
    onAgentContext: (
      cb: (d: {
        id: string
        usage?: {
          input_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }) => void
    ): Unsub => on('agent:context', cb),
    onAgentDone: (cb: (d: { id: string; aborted?: boolean }) => void): Unsub =>
      on('agent:done', cb),
    onAgentError: (cb: (d: { id: string; message: string }) => void): Unsub =>
      on('agent:error', cb)
  }, (ipc) => createHostClaude(hostClient, ipc, (listener) => { ipcRenderer.on('claude:profile-changed', (_e, id: string) => listener(id)) }), CLAUDE_EVENT_MEMBERS),
  // --- Remote control: drive a chat from the phone via a Cloudflare tunnel ---
  // On the host when it serves `remote@1` (T09, src/shared/host/api/remote.ts):
  // sharing then outlives the window and the renderer's bridge stays off.
  // Like the accounts, nothing reaches IPC before the first `hello` when there
  // is a host binary (the host owns the sharing).
  remoteControl: withHost('remote', {
    // Start the server/tunnel (idempotent) and share a chat; returns THAT chat's
    // deep-link and token (a link reads and commands only its own chat).
    enable: (p: { tabId: string; title: string }): Promise<RemoteControlEnableResult> =>
      ipcRenderer.invoke('rc:enable', p),
    // Push the latest trimmed snapshot of a shared chat (main sends phones only the delta).
    pushState: (snap: RemoteChatSnapshotIpc): void => ipcRenderer.send('rc:state', snap),
    // A chat stopped sharing: revokes its link; the last one also stops the tunnel.
    remove: (tabId: string): void => ipcRenderer.send('rc:remove', { tabId }),
    // Confirm to the phone that a command was handled (or why it wasn't).
    ack: (p: RemoteControlAck): void => ipcRenderer.send('rc:ack', p),
    /** On the host each chat also carries its `token` and `url`. */
    status: (): Promise<RemoteControlStatus> => ipcRenderer.invoke('rc:status'),
    stop: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('rc:stop'),
    // A command arrived from the phone (accept/deny/answer/send/stop).
    onCommand: (
      cb: (d: { tabId: string; action: string; payload: Record<string, unknown> }) => void
    ): Unsub => on('rc:command', cb),
    onClients: (cb: (d: { count: number }) => void): Unsub => on('rc:clients', cb),
    // The server stopped on its own (last chat unshared, tunnel died, error):
    // every link is dead and the renderer must forget its shared chats.
    onStopped: (cb: (d: { reason: RemoteControlStopReason }) => void): Unsub =>
      on('rc:stopped', cb),
    /** The whole sharing state after any change, from any window; only the host announces it. */
    onChanged: (_cb: (status: RemoteControlStatus) => void): Unsub => () => undefined
  }, (ipc) => createHostRemote(hostClient, ipc), ['onClients', 'onStopped', 'onChanged'], accountsGate),
  sessions: withHost('sessions', {
    list: (filterCwd?: string, remoteId?: string): Promise<SessionMetaIpc[]> =>
      ipcRenderer.invoke('sessions:list', filterCwd, remoteId),
    read: (file: string, remoteId?: string): Promise<TranscriptTurnIpc[]> =>
      ipcRenderer.invoke('sessions:read', file, remoteId),
    delete: (file: string, remoteId?: string): Promise<boolean> =>
      ipcRenderer.invoke('sessions:delete', file, remoteId)
  }, (ipc) => createHostSessions({ client: hostClient, ipc })),
  commands: withHost('commands', {
    list: (projectDir?: string): Promise<SlashCommandIpc[]> =>
      ipcRenderer.invoke('commands:list', projectDir)
  }, (ipc) => createHostCommands({ client: hostClient, ipc })),
  // The provider's own `/` catalog: Claude's supportedCommands(), Codex's
  // skills/list, cached per account and folder. The host's `providers.commands`
  // when it serves the accounts, else main's ipc/agentCommands.ts.
  agentCommands: withHost('providers', {
    list: (provider: Provider, profileId: string, cwd: string, refresh = false): Promise<{ name: string; description: string; argumentHint: string | null; kind: 'slash-command' | 'skill'; builtin: boolean }[]> =>
      ipcRenderer.invoke('agents:commands', provider, profileId, cwd, refresh)
  }, () => createHostAgentCommands(hostClient), [], accountsGate),
  ssh: {
    connect: (cfg: SshConnectIpc): Promise<{ ok: boolean; id?: string; error?: string }> =>
      ipcRenderer.invoke('ssh:connect', cfg),
    disconnect: (id: string): void => ipcRenderer.send('ssh:disconnect', id),
    home: (id: string): Promise<string | null> => ipcRenderer.invoke('ssh:home', id),
    onStatus: (
      cb: (d: { id: string; status: string; host?: string; name?: string; message?: string }) => void
    ): Unsub => on('ssh:status', cb),
    hosts: {
      list: (): Promise<SshHostIpc[]> => ipcRenderer.invoke('ssh:hosts:list'),
      save: (host: Partial<SshHostIpc>): Promise<SshHostIpc[]> =>
        ipcRenderer.invoke('ssh:hosts:save', host),
      delete: (id: string): Promise<SshHostIpc[]> => ipcRenderer.invoke('ssh:hosts:delete', id),
      getSecret: (id: string): Promise<string | null> =>
        ipcRenderer.invoke('ssh:hosts:getSecret', id),
      setSecret: (id: string, password: string | null): Promise<boolean> =>
        ipcRenderer.invoke('ssh:hosts:setSecret', id, password)
    },
    // Remote terminal
    createTerm: (payload: { id: string; cols?: number; rows?: number }): Promise<{ ok: boolean; termId?: string }> =>
      ipcRenderer.invoke('ssh:term:create', payload),
    termInput: (payload: { id: string; termId: string; data: string }): void =>
      ipcRenderer.send('ssh:term:input', payload),
    termResize: (payload: { id: string; termId: string; cols: number; rows: number }): void =>
      ipcRenderer.send('ssh:term:resize', payload),
    termKill: (payload: { id: string; termId: string }): void =>
      ipcRenderer.send('ssh:term:kill', payload),
    onTermData: (cb: (d: { termId: string; data: string }) => void): Unsub =>
      on('ssh:term:data', cb),
    onTermReady: (cb: (d: { termId: string }) => void): Unsub => on('ssh:term:ready', cb),
    onTermExit: (cb: (d: { termId: string }) => void): Unsub => on('ssh:term:exit', cb),
    onTermError: (cb: (d: { termId: string; message: string }) => void): Unsub =>
      on('ssh:term:error', cb),
    // Remote files (SFTP) — mirrors window.prism.fs for a connection id.
    fs: {
      readDir: (id: string, p: string): Promise<{ name: string; path: string; isDir: boolean }[]> =>
        ipcRenderer.invoke('ssh:fs:readDir', id, p),
      readFile: (id: string, p: string): Promise<string> =>
        ipcRenderer.invoke('ssh:fs:readFile', id, p),
      readFileBytes: (id: string, p: string): Promise<string> =>
        ipcRenderer.invoke('ssh:fs:readFileBytes', id, p),
      writeFile: (id: string, p: string, c: string): Promise<boolean> =>
        ipcRenderer.invoke('ssh:fs:writeFile', id, p, c),
      stat: (id: string, p: string): Promise<{ exists: boolean; isDir: boolean }> =>
        ipcRenderer.invoke('ssh:fs:stat', id, p),
      createFile: (id: string, p: string): Promise<{ name: string; path: string; isDir: boolean }> =>
        ipcRenderer.invoke('ssh:fs:createFile', id, p),
      createDir: (id: string, p: string): Promise<{ name: string; path: string; isDir: boolean }> =>
        ipcRenderer.invoke('ssh:fs:createDir', id, p),
      rename: (id: string, a: string, b: string): Promise<boolean> =>
        ipcRenderer.invoke('ssh:fs:rename', id, a, b),
      move: (id: string, src: string, destDir: string): Promise<string> =>
        ipcRenderer.invoke('ssh:fs:move', id, src, destDir),
      copyPath: (id: string, src: string, destDir: string): Promise<string> =>
        ipcRenderer.invoke('ssh:fs:copy', id, src, destDir),
      duplicate: (id: string, src: string): Promise<string> =>
        ipcRenderer.invoke('ssh:fs:duplicate', id, src),
      delete: (id: string, p: string): Promise<boolean> =>
        ipcRenderer.invoke('ssh:fs:delete', id, p),
      listFiles: (id: string, root: string): Promise<{ path: string; rel: string }[]> =>
        ipcRenderer.invoke('ssh:fs:listFiles', id, root),
      upload: (id: string, localPaths: string[], destDir: string): Promise<string[]> =>
        ipcRenderer.invoke('ssh:fs:upload', id, localPaths, destDir)
    }
  },
  // A run goes to one side; `onResult`/`onDone` always listen to both.
  search: withHost('search', {
    run: (payload: {
      id: number
      root: string
      query: string
      caseSensitive: boolean
      remoteId?: string
    }): void => ipcRenderer.send('search:run', payload),
    cancel: (): void => ipcRenderer.send('search:cancel'),
    onResult: (
      cb: (data: {
        id: number
        path: string
        rel: string
        name: string
        matches: { line: number; col: number; preview: string }[]
      }) => void
    ): Unsub => on('search:result', cb),
    onDone: (
      cb: (data: { id: number; files: number; matches: number; truncated: boolean }) => void
    ): Unsub => on('search:done', cb)
  }, (ipc) => createHostSearch({ client: hostClient, ipc }), ['onResult', 'onDone']),
  // Code navigation: cross-file "Go to Definition" (workspace symbol lookup),
  // served by the host's `search` domain.
  nav: withHost('search', {
    findDef: (payload: {
      root: string
      word: string
      remoteId?: string
      fromPath?: string
    }): Promise<{
      matches: { path: string; rel: string; name: string; line: number; col: number; preview: string }[]
    }> => ipcRenderer.invoke('nav:findDef', payload)
  }, (ipc) => createHostNav({ client: hostClient, ipc })),
  // `aiCommitMessage` runs on the host's Claude domain (claude.commitMessage)
  // when the host serves `claude@1`; SSH roots and the SDK fallback stay on IPC.
  git: withHost('git', {
    status: (
      dir: string,
      remoteId?: string,
      options?: { stats?: boolean }
    ): Promise<{
      isRepo: boolean
      root?: string
      branch?: string
      ahead?: number
      behind?: number
      files?: { path: string; origPath?: string; x: string; y: string; staged: boolean; untracked: boolean; stagedStats?: { insertions: number; deletions: number; binary: boolean }; workingStats?: { insertions: number; deletions: number; binary: boolean } }[]
    }> => ipcRenderer.invoke('git:status', dir, remoteId, options),
    statusAll: (
      folders: string[],
      remoteId?: string,
      options?: { stats?: boolean }
    ): Promise<
      {
        isRepo: boolean
        root?: string
        branch?: string
        ahead?: number
        behind?: number
        files?: { path: string; origPath?: string; x: string; y: string; staged: boolean; untracked: boolean; stagedStats?: { insertions: number; deletions: number; binary: boolean }; workingStats?: { insertions: number; deletions: number; binary: boolean } }[]
      }[]
    > => ipcRenderer.invoke('git:statusAll', folders, remoteId, options),
    branches: (
      root: string,
      remoteId?: string
    ): Promise<{ current: string; local: string[]; remote: string[] }> =>
      ipcRenderer.invoke('git:branches', root, remoteId),
    checkout: (root: string, branch: string, remoteId?: string): Promise<{ code: number; message: string }> =>
      ipcRenderer.invoke('git:checkout', root, branch, remoteId),
    createBranch: (root: string, name: string, remoteId?: string): Promise<{ code: number; message: string }> =>
      ipcRenderer.invoke('git:createBranch', root, name, remoteId),
    fetch: (root: string, remoteId?: string): Promise<{ code: number; message: string }> =>
      ipcRenderer.invoke('git:fetch', root, remoteId),
    pull: (root: string, remoteId?: string): Promise<{ code: number; message: string }> =>
      ipcRenderer.invoke('git:pull', root, remoteId),
    push: (root: string, remoteId?: string): Promise<{ code: number; message: string }> =>
      ipcRenderer.invoke('git:push', root, remoteId),
    stage: (root: string, file: string, remoteId?: string): Promise<unknown> =>
      ipcRenderer.invoke('git:stage', root, file, remoteId),
    unstage: (root: string, file: string, remoteId?: string): Promise<unknown> =>
      ipcRenderer.invoke('git:unstage', root, file, remoteId),
    stageAll: (root: string, remoteId?: string): Promise<unknown> =>
      ipcRenderer.invoke('git:stageAll', root, remoteId),
    unstageAll: (root: string, remoteId?: string): Promise<unknown> =>
      ipcRenderer.invoke('git:unstageAll', root, remoteId),
    discard: (root: string, file: string, untracked: boolean, remoteId?: string): Promise<unknown> =>
      ipcRenderer.invoke('git:discard', root, file, untracked, remoteId),
    commit: (root: string, message: string, remoteId?: string): Promise<{ code: number; message: string }> =>
      ipcRenderer.invoke('git:commit', root, message, remoteId),
    aiCommitMessage: (
      root: string,
      remoteId?: string
    ): Promise<{ ok: boolean; message?: string; error?: string }> =>
      ipcRenderer.invoke('git:aiCommitMessage', root, remoteId),
    init: (dir: string, remoteId?: string): Promise<unknown> =>
      ipcRenderer.invoke('git:init', dir, remoteId),
    diff: (
      root: string,
      file: string,
      untracked: boolean,
      remoteId?: string,
      /** 'staged' = HEAD → index; 'working' = index → disk; omitted = HEAD → disk. */
      scope?: 'staged' | 'working',
      origPath?: string
    ): Promise<{ original: string; modified: string }> =>
      ipcRenderer.invoke('git:diff', root, file, untracked, remoteId, scope, origPath)
  }, (ipc) => ({ ...createHostGit({ client: hostClient, ipc }), aiCommitMessage: hostCommitMessage(hostClient, ipc.aiCommitMessage) })),
  ext: {
    list: (): Promise<ExtensionInfo[]> => ipcRenderer.invoke('ext:list'),
    setEnabled: (id: string, enabled: boolean): Promise<ExtensionInfo[]> =>
      ipcRenderer.invoke('ext:setEnabled', id, enabled),
    setConfig: (id: string, config: Record<string, unknown>): Promise<ExtensionInfo[]> =>
      ipcRenderer.invoke('ext:setConfig', id, config),
    updateEditorState: (state: {
      file: string | null
      language: string | null
      workspace: string | null
      dirty: boolean
      folder?: string | null
      relativePath?: string | null
      working?: boolean
      problems?: number
    }): void => ipcRenderer.send('editor:state', state),
    onStatus: (
      cb: (data: { id: string; status: string; detail?: string }) => void
    ): Unsub => on('ext:status', cb)
  },
  // Settings ▸ Uso (components/usage; main: ipc/usage.ts). The records come
  // from the host when it serves `usage@1`; the rest is the desktop's.
  usage: withHost('usage', {
    records: (): Promise<import('../shared/usage').UsageRecordsResponse> => ipcRenderer.invoke('usage:records'),
    importTraycer: (root?: string): Promise<import('../shared/usage').UsageImportState> => ipcRenderer.invoke('usage:import-traycer', root),
    copyImage: (png: Uint8Array): Promise<void> => ipcRenderer.invoke('usage:copy-image', png),
    fontCss: (): Promise<string> => ipcRenderer.invoke('usage:font-css'),
    saveFile: (request: import('../shared/usage').UsageSaveRequest): Promise<string | null> => ipcRenderer.invoke('usage:save-file', request),
    revealFile: (path: string): Promise<void> => ipcRenderer.invoke('usage:reveal-file', path)
  }, (ipc) => createHostUsage(hostClient, ipc))
}

export interface SessionMetaIpc {
  id: string
  title: string
  preview: string
  cwd: string
  project: string
  mtime: number
  firstTs: number
  messageCount: number
  gitBranch?: string
  file: string
}

export interface TranscriptSegmentIpc {
  kind: 'text' | 'thinking' | 'tool'
  text?: string
  toolId?: string
  name?: string
  input?: unknown
  result?: string
  resultIsError?: boolean
}

export interface TranscriptTurnIpc {
  id: string
  role: 'user' | 'assistant'
  text?: string
  segments?: TranscriptSegmentIpc[]
}

export interface SlashCommandIpc {
  name: string
  description: string
  source: 'user' | 'project' | 'skill' | 'client'
}

export interface SshHostIpc {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  keyPath?: string
}

export interface QuestionIpc {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string; preview?: string }[]
}

export interface AuthStatusIpc {
  loggedIn: boolean
  authMethod?: string
  email?: string
  orgName?: string
  subscriptionType?: string
  raw?: string
}

export interface RecentRemoteIpc {
  hostId?: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  keyPath?: string
}

export interface SshConnectIpc {
  name?: string
  host: string
  port?: number
  username: string
  authType: 'password' | 'key'
  password?: string
  keyPath?: string
  passphrase?: string
}

export interface ExtensionConfigField {
  key: string
  label: string
  type: 'text' | 'password' | 'boolean'
  placeholder?: string
  help?: string
}

export interface ExtensionInfo {
  id: string
  name: string
  description: string
  version: string
  author: string
  icon: string
  configSchema: ExtensionConfigField[]
  defaultConfig: Record<string, unknown>
  enabled: boolean
  status: string
  detail?: string
  config: Record<string, unknown>
}

// Trimmed view of a chat the phone renders. Built in the renderer
// (lib/remoteControlModel) to keep the payload small, forwarded verbatim by the main process.
export interface RemoteImageIpc {
  mime: string; data?: string; name?: string; number?: number
  ref?: { turnId?: string; toolId?: string; queueId?: string; index: number }
}
export type RemoteQueuedMessageIpc = Omit<import('../shared/agents').QueuedMessage, 'images'> & { images?: RemoteImageIpc[] }
export interface RemoteTurnIpc {
  id: string
  role: 'user' | 'assistant'
  text: string
  error?: boolean
  images?: RemoteImageIpc[]
  segments?: {
    kind: 'text' | 'thinking' | 'tool' | 'user'
    subagent?: SubagentInfo
    toolId?: string
    questions?: { title: string; options?: string[] }[]
    images?: RemoteImageIpc[]
    input?: unknown
    result?: string
    text?: string
    name?: string
    status?: string
    preview?: string
  }[]
  pendingPerm?: { permId: string; toolName: string; title?: string; desc?: string; preview?: string }
  pendingQuestion?: {
    dialogId: string
    questions: {
      question: string
      header: string
      multiSelect: boolean
      options: { label: string; description: string }[]
    }[]
  }
}

export interface RemoteChatSnapshotIpc {
  selection?: import('../shared/agents').AgentSelection
  queued?: RemoteQueuedMessageIpc[]
  queuePaused?: boolean
  tabId: string
  title: string
  streaming: boolean
  contextPct: number
  turns: RemoteTurnIpc[]
  updatedAt?: number
}

contextBridge.exposeInMainWorld('prism', api)

export type PrismApi = typeof api
