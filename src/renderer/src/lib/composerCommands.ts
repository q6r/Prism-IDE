import { useStore } from '../store'
import { useAgentChats } from './agentChats'
import { startRemoteControl } from './remoteControl'

/**
 * What the Prism rows of the `/` menu do (their list and availability live in
 * composerMenu.ts). Each one maps an old chat-panel command onto the unified
 * chat model.
 */
export function runPrismCommand(name: string, chatId: string, focusEditor: () => void): void {
  const store = useStore.getState()
  switch (name) {
    case 'limpar':
      // The same new chat as the "Novo chat" button (AgentWorkspace).
      useAgentChats.getState().create(store.folderPath || '', store.remote?.id)
      focusEditor()
      return
    case 'sessoes':
      // setSidebarView toggles when the view is already showing; only open it.
      if (store.sidebarView !== 'sessions' || !store.sidebarOpen) store.setSidebarView('sessions')
      return
    case 'conta':
    case 'login':
    case 'logout':
      // Accounts live in Settings › Provedores now.
      store.openSettings('providers')
      return
    case 'compactar':
      // Claude Code's own command, on the chat's resumed session.
      useAgentChats.getState().send(chatId, '/compact')
      return
    case 'remote-control':
      void startRemoteControl(chatId)
      return
  }
}

/** The editor's active file, when it has text a prompt can carry. */
export function openFileTab(): { path: string; language: string; content: string } | null {
  const store = useStore.getState()
  const tab = store.tabs.find((t) => t.path === store.activePath)
  return tab && tab.kind !== 'media' ? tab : null
}

/**
 * Attaches the open file the way the composer's paperclip does, so a template
 * about "o arquivo aberto" reaches the agent with that file. An attachment the
 * user already chose is kept.
 */
export function attachOpenFileForTemplate(chatId: string): void {
  const tab = openFileTab()
  const chat = useAgentChats.getState().chats.find((c) => c.id === chatId)
  if (!tab || !chat || chat.contextDraft) return
  useAgentChats.getState().contextDraft(chatId, `${tab.path}\n\`\`\`${tab.language}\n${tab.content}\n\`\`\``)
}
