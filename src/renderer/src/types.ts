export interface Tab {
  path: string
  name: string
  language: string
  content: string
  savedContent: string
  kind?: 'file' | 'diff' | 'media'
  original?: string
  mediaUrl?: string
  mediaKind?: 'image' | 'video' | 'audio'
}

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
export type ChatEngine = 'agent' | 'api'

export interface Settings {
  model: string
  oneMillionContext: boolean
  effort: Effort
  thinkingEnabled: boolean
  chatEngine: ChatEngine
  permissionMode: PermissionMode
  animations: boolean
  notifyOnAsk: boolean
  notifyOnDone: boolean
  fontSize: number
  tabSize: number
  theme: string
  wordWrap: boolean
  autoSave: boolean
  recentFolders: string[]
  recentWorkspaces: string[]
  recentRemotes: RecentRemote[]
  sidebarWidth: number
  chatWidth: number
  terminalHeight: number
  apiKeyConfigured: boolean
}

export type ExtInfo = Awaited<ReturnType<Window['prism']['ext']['list']>>[number]

export type SidebarView = 'explorer' | 'search' | 'extensions' | 'git' | 'sessions' | 'remote'

export interface RemoteState {
  id: string
  name: string
  host: string
  port: number
  username: string
  cwd: string
}

export interface RecentRemote {
  hostId?: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  keyPath?: string
}

export interface SessionRef {
  file: string
  id: string
  title: string
  cwd?: string
}

export type ToolStatus = 'running' | 'done' | 'error' | 'denied' | 'awaiting'

export interface AgentSegment {
  kind: 'text' | 'thinking' | 'tool'
  text?: string
  // tool fields
  toolId?: string
  name?: string
  input?: unknown
  result?: string
  resultIsError?: boolean
  status?: ToolStatus
}

export interface CodeAttachment {
  text: string
  lang?: string
  source?: string
}

export interface PendingPerm {
  permId: string
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  description?: string
}

export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string; preview?: string }[]
}

export interface PendingQuestion {
  dialogId: string
  toolUseId?: string
  questions: Question[]
}

export type Activity = 'starting' | 'thinking' | 'responding' | 'tool' | 'processing'

export interface ChatTurn {
  id: string
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  segments?: AgentSegment[] // agentic timeline (text/thinking/tool, in order)
  activity?: Activity // what the agent is doing right now (live status line)
  pendingPerm?: PendingPerm // permission awaiting the user's decision
  pendingQuestion?: PendingQuestion // AskUserQuestion awaiting an answer
  streaming?: boolean
  error?: boolean
  images?: { dataUrl: string }[]
  attachments?: CodeAttachment[] // pasted code snippets attached to a user turn
  compacted?: boolean
  cost?: number
  queued?: boolean // user message waiting in the queue while the agent is busy
}

export interface Toast {
  id: string
  kind: 'info' | 'error' | 'success'
  message: string
}

export type LayoutKey = 'sidebarWidth' | 'chatWidth' | 'terminalHeight'
