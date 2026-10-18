import Store from 'electron-store'

export interface ExtensionState {
  enabled: boolean
  config: Record<string, unknown>
}

export interface SshHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  keyPath?: string
}

// A recently-opened remote. Mirrors the saved host it came from so the welcome
// screen / "Open recent" can reconnect (the password prompt is reused).
export interface RecentRemote {
  hostId?: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key'
  keyPath?: string
}

export interface PrismSettings {
  anthropicApiKey?: string
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
  autoSave: boolean
  recentFolders: string[]
  recentWorkspaces: string[]
  sidebarWidth: number
  chatWidth: number
  terminalHeight: number
  extensionsState: Record<string, ExtensionState>
  sshHosts: SshHost[]
  sshSecrets: Record<string, string>
  recentRemotes: RecentRemote[]
}

export const store = new Store<PrismSettings>({
  name: 'prism-settings',
  defaults: {
    anthropicApiKey: '',
    model: '',
    oneMillionContext: true,
    effort: 'high',
    thinkingEnabled: true,
    chatEngine: 'agent',
    permissionMode: 'default',
    animations: true,
    notifyOnAsk: true,
    notifyOnDone: true,
    fontSize: 14,
    tabSize: 2,
    theme: 'prism-dark',
    wordWrap: false,
    autoSave: false,
    recentFolders: [],
    recentWorkspaces: [],
    sidebarWidth: 252,
    chatWidth: 380,
    terminalHeight: 250,
    extensionsState: {},
    sshHosts: [],
    sshSecrets: {},
    recentRemotes: []
  }
})
