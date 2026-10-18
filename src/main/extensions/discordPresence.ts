import { Client } from '@xhayper/discord-rpc'
import { Extension, ExtensionContext, EditorState } from './types'
import { languageIcon, PRISM_LARGE_ICON } from './langIcons'
import { PRESENCE_DEFAULTS, presenceText } from './presenceTemplates'

// Prism's own Discord application — fixed, not user-editable.
const DISCORD_CLIENT_ID = '1515186257083498627'

export function createDiscordPresence(): Extension {
  let client: Client | null = null
  let connected = false
  let active = false
  let startTimestamp = Date.now()
  let config: Record<string, unknown> = {}
  let setStatus: ExtensionContext['setStatus'] = () => {}
  let state: EditorState = { file: null, language: null, workspace: null, dirty: false }
  let debounce: ReturnType<typeof setTimeout> | null = null
  let retry: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (debounce) clearTimeout(debounce)
    if (retry) clearTimeout(retry)
    debounce = null
    retry = null
  }

  const disconnect = async (): Promise<void> => {
    clearTimers()
    connected = false
    const c = client
    client = null
    if (c) {
      try {
        await c.user?.clearActivity()
      } catch {
        /* ignore */
      }
      try {
        await c.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  const pushActivity = (): void => {
    if (!connected || !client) return
    const idle = !state.file
    const showElapsed = config.showElapsed !== false
    const lang = languageIcon(state.language)

    client.user
      ?.setActivity({
        name: 'Prism IDE',
        // Big image is the Prism brand; the language sits in the small "mini"
        // badge. Both pass an image URL via the `*ImageKey` (`large_image`/
        // `small_image`) field — Discord renders those; `large_url` it ignores.
        largeImageKey: PRISM_LARGE_ICON,
        largeImageText: presenceText('largeImageTemplate', config, state),
        details: presenceText(idle ? 'idleTemplate' : 'detailsTemplate', config, state),
        ...(!idle ? { smallImageKey: lang.url, smallImageText: lang.text } : {}),
        ...(!idle ? { state: presenceText('stateTemplate', config, state) } : {}),
        ...(showElapsed ? { startTimestamp } : {})
      })
      .catch((err) => {
        // Surface real errors (e.g. Discord rejecting an asset URL) for diagnosis;
        // transient socket/rate-limit errors are harmless.
        const msg = (err as Error)?.message || String(err)
        if (msg && !/closed|destroyed|rate/i.test(msg)) console.warn('[discord-rpc] setActivity:', msg)
      })
  }

  const scheduleUpdate = (immediate = false): void => {
    if (!connected) return
    if (immediate) {
      pushActivity()
      return
    }
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(pushActivity, 1800)
  }

  const scheduleRetry = (): void => {
    if (!active) return
    if (retry) clearTimeout(retry)
    retry = setTimeout(connect, 20000)
  }

  function connect(): void {
    if (!active) return
    clearTimers()
    setStatus('connecting')
    const c = new Client({ clientId: DISCORD_CLIENT_ID })
    client = c
    c.on('ready', () => {
      connected = true
      setStatus('connected')
      pushActivity()
    })
    c.on('disconnected', () => {
      connected = false
      if (active) {
        setStatus('offline', 'Discord connection closed')
        scheduleRetry()
      }
    })
    c.login().catch(() => {
      connected = false
      client = null
      setStatus('offline', 'Is Discord running?')
      scheduleRetry()
    })
  }

  return {
    meta: {
      id: 'discord-presence',
      name: 'Discord Rich Presence',
      description:
        'Show your Prism workspace, file, language, problems and elapsed time on Discord. Customize the text with template variables in Settings.',
      version: '1.1.0',
      author: 'Prism',
      icon: 'discord',
      configSchema: [
        { key: 'showFileName', label: 'Show file name', type: 'boolean' },
        { key: 'showWorkspace', label: 'Show workspace', type: 'boolean' },
        { key: 'showElapsed', label: 'Show elapsed time', type: 'boolean' },
        { key: 'detailsTemplate', label: 'Details text', type: 'text', placeholder: PRESENCE_DEFAULTS.detailsTemplate, help: 'First line below Prism IDE. Leave blank to hide.' },
        { key: 'stateTemplate', label: 'Activity text', type: 'text', placeholder: PRESENCE_DEFAULTS.stateTemplate, help: 'Second line. Example: {action} {file} in {folder}. Leave blank to hide.' },
        { key: 'idleTemplate', label: 'Idle text', type: 'text', placeholder: PRESENCE_DEFAULTS.idleTemplate, help: 'Shown when no file is open.' },
        { key: 'largeImageTemplate', label: 'Prism icon tooltip', type: 'text', placeholder: PRESENCE_DEFAULTS.largeImageTemplate },
        { key: 'viewingText', label: 'Viewing label', type: 'text', placeholder: PRESENCE_DEFAULTS.viewingText },
        { key: 'workingText', label: 'Working label', type: 'text', placeholder: PRESENCE_DEFAULTS.workingText, help: 'Used by {action} while editing and for 10 seconds after the last edit.' }
      ],
      defaultConfig: PRESENCE_DEFAULTS
    },

    activate: (ctx) => {
      active = true
      config = ctx.config
      setStatus = ctx.setStatus
      startTimestamp = Date.now()
      connect()
    },

    deactivate: async () => {
      active = false
      await disconnect()
    },

    onEditorState: (next) => {
      state = next
      scheduleUpdate()
    },

    onConfig: (next) => {
      config = next
      scheduleUpdate(true)
    }
  }
}
