export interface EditorState {
  file: string | null
  language: string | null
  workspace: string | null
  dirty: boolean
  folder?: string | null
  relativePath?: string | null
  working?: boolean
  problems?: number
}

export type ExtensionStatus =
  | 'disabled'
  | 'needs-config'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'error'

export interface ConfigField {
  key: string
  label: string
  type: 'text' | 'password' | 'boolean'
  placeholder?: string
  help?: string
}

export interface ExtensionMeta {
  id: string
  name: string
  description: string
  version: string
  author: string
  icon: string
  configSchema: ConfigField[]
  defaultConfig: Record<string, unknown>
}

export interface ExtensionContext {
  config: Record<string, unknown>
  setStatus: (status: ExtensionStatus, detail?: string) => void
}

export interface Extension {
  meta: ExtensionMeta
  activate: (ctx: ExtensionContext) => void | Promise<void>
  deactivate: () => void | Promise<void>
  onEditorState?: (state: EditorState) => void
  onConfig?: (config: Record<string, unknown>) => void
}
