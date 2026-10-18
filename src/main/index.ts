import { app, BrowserWindow, shell, ipcMain, Notification, nativeImage, clipboard } from 'electron'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerFsHandlers } from './ipc/fs'
import { registerDialogHandlers } from './ipc/dialog'
import { registerTerminalHandlers } from './ipc/terminal'
import { registerSettingsHandlers } from './ipc/settings'
import { registerClaudeAgentHandlers } from './ipc/claudeAgent'
import { registerAuthHandlers } from './ipc/auth'
import { registerProviderHandlers } from './ipc/providers'
import { registerNativeCodexHandlers } from './ipc/nativeCodex'
import { registerModelHandlers } from './ipc/agentModels'
import { registerAgentCommandHandlers } from './ipc/agentCommands'
import { registerTraycerLiveHandlers } from './ipc/traycerLive'
import { registerTraycerImportHandlers } from './ipc/traycerImport'
import { registerSessionHandlers } from './ipc/sessions'
import { registerSlashCommandHandlers } from './ipc/slashCommands'
import { registerWorkspaceHandlers } from './ipc/workspace'
import { registerSshHandlers } from './ipc/ssh'
import { registerSshHostHandlers } from './ipc/sshHosts'
import { registerWindowHandlers } from './ipc/window'
import { registerExtensionHandlers } from './ipc/extensions'
import { registerSearchHandlers } from './ipc/search'
import { registerGitHandlers } from './ipc/git'
import { registerRemoteControlHandlers } from './ipc/remoteControl'
import { registerBrowserHandlers } from './ipc/browser'
import { registerUsageHandlers } from './ipc/usage'
import { registerHostHandlers } from './host/supervisor'
import { drainHostWrites, pendingHostWrites } from './hostChats'
import { initExtensions } from './extensions'
import { store } from './store'

let mainWindow: BrowserWindow | null = null

// Safety net: a stray rejection/exception (a dropped SSH socket, a child process
// dying, a misbehaving dependency) must never take the whole app down. Log and
// keep running — the UI surfaces real errors through their own channels.
process.on('uncaughtException', (err) => {
  console.error('[prism] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[prism] unhandledRejection:', reason)
})

function resourcesDir(): string {
  return is.dev ? join(app.getAppPath(), 'resources') : join(process.resourcesPath, 'resources')
}

function resourceDataUrl(file: string): string {
  const data = readFileSync(join(resourcesDir(), file)).toString('base64')
  return `data:image/png;base64,${data}`
}

function createSplash(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 420,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    center: true,
    skipTaskbar: true,
    show: true,
    webPreferences: { sandbox: false }
  })

  const logo = resourceDataUrl('logo.png')
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { width:420px; height:420px; background:transparent; overflow:hidden;
      font-family:'Segoe UI',system-ui,sans-serif; user-select:none; }
    .card { position:relative; width:420px; height:420px; border-radius:16px; overflow:hidden;
      background:radial-gradient(circle at 50% 38%, #141418 0%, #0b0b0e 70%);
      border:1px solid #232329;
      box-shadow:0 24px 60px rgba(0,0,0,.55); }
    .wrap { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; }
    .logo { width:96px; height:96px; opacity:.92; margin-bottom:20px; }
    .title { font-size:24px; font-weight:600; letter-spacing:8px; color:#c3c6ce; }
    .sub { margin-top:5px; font-size:10px; letter-spacing:4px; color:#6a6c75; text-transform:uppercase; }
    .bar { margin-top:24px; width:140px; height:2px; border-radius:2px; background:rgba(255,255,255,.06); overflow:hidden; }
    .bar > i { display:block; height:100%; width:38%; border-radius:2px;
      background:#6f76e6; animation:slide 1.2s infinite ease-in-out; }
    @keyframes slide { 0%{transform:translateX(-120%)} 100%{transform:translateX(320%)} }
  </style></head><body>
    <div class="card">
      <div class="wrap">
        <img class="logo" src="${logo}" />
        <div class="title">PRISM</div><div class="sub">IDE</div>
        <div class="bar"><i></i></div>
      </div>
    </div>
  </body></html>`

  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  return splash
}

function createWindow(showWhenReady = false): BrowserWindow {
  const win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#0a0b14',
    titleBarStyle: 'hidden',
    icon: join(resourcesDir(), 'app_logo.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // The in-app browser panel hosts pages in <webview> guests (Traycer's
      // browser tile); guests are hardened in 'will-attach-webview' below.
      webviewTag: true
    }
  })
  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete (webPreferences as { preload?: string }).preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    // Every guest lives in the browser panel's own persistent partition, never
    // the app's default session (cookies, storage and permissions stay apart).
    params.partition = 'persist:prism-browser'
    if (!/^https?:|^about:blank$/.test(params.src || 'about:blank')) params.src = 'about:blank'
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.on('maximize', () => win.webContents.send('window:maximized', true))
  win.on('unmaximize', () => win.webContents.send('window:maximized', false))

  // Coming back to the window means the user has seen the pending work: stop the
  // taskbar flashing and clear the unread badge/overlay. The renderer resets its
  // own unread counter on the same focus event (see lib/notify.ts).
  win.on('focus', () => {
    win.flashFrame(false)
    try {
      win.setOverlayIcon(null, '')
    } catch {
      /* setOverlayIcon is Windows-only */
    }
    try {
      app.setBadgeCount(0)
    } catch {
      /* badge count is macOS/Linux */
    }
  })

  // Additional windows (not the first, splash-gated one) show as soon as ready.
  if (showWhenReady) win.once('ready-to-show', () => win.show())

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  // In dev, electron-vite can re-evaluate this module in the same process (HMR),
  // firing whenReady again. Guard on a global flag so IPC handlers are only
  // registered once — re-registering throws "second handler for …".
  const g = globalThis as unknown as { __prismHandlersReady?: boolean }
  if (g.__prismHandlersReady) return
  g.__prismHandlersReady = true

  electronApp.setAppUserModelId('com.prism.ide')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  // App-level handlers (branding assets for the renderer)
  ipcMain.handle('app:logo', () => resourceDataUrl('logo.png'))
  ipcMain.handle('app:info', () => ({ platform: process.platform, version: app.getVersion() }))
  ipcMain.handle('app:revealInFolder', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('app:openExternal', (_e, url: string) => shell.openExternal(url))

  // Read files (or an image) the user copied from the OS file manager, so the
  // explorer can paste them with Ctrl+V (local copy or SFTP upload to a remote).
  ipcMain.handle('clipboard:files', () => {
    const paths: string[] = []
    let image: string | null = null
    const addUri = (raw: string): void => {
      const t = raw.trim()
      if (!t || t.startsWith('#') || !t.startsWith('file://')) return
      try {
        paths.push(fileURLToPath(t))
      } catch {
        /* not a usable file url */
      }
    }
    try {
      const uriList = clipboard.read('text/uri-list')
      if (uriList) uriList.split(/\r?\n/).forEach(addUri)
    } catch {
      /* format unavailable */
    }
    if (!paths.length && process.platform === 'win32') {
      try {
        const buf = clipboard.readBuffer('FileNameW')
        if (buf && buf.length) {
          buf
            .toString('ucs2')
            .split('\0')
            .map((s) => s.trim())
            .filter(Boolean)
            .forEach((p) => paths.push(p))
        }
      } catch {
        /* not on the clipboard */
      }
    }
    if (!paths.length && process.platform === 'darwin') {
      try {
        const u = clipboard.read('public.file-url')
        if (u) addUri(u)
      } catch {
        /* unavailable */
      }
    }
    if (!paths.length) {
      try {
        const img = clipboard.readImage()
        if (img && !img.isEmpty()) image = img.toDataURL()
      } catch {
        /* no image */
      }
    }
    return { paths, image }
  })

  // Native OS notification (e.g. when Claude asks for permission). Skipped when
  // the window is already focused — no point pinging the user who's looking.
  ipcMain.on('app:notify', (e, payload: { title: string; body: string; force?: boolean }) => {
    if (!Notification.isSupported()) return
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!payload.force && win?.isFocused()) return
    const n = new Notification({
      title: payload.title,
      body: payload.body,
      icon: join(resourcesDir(), 'app_logo.png'),
      silent: false
    })
    n.on('click', () => {
      win?.show()
      win?.focus()
    })
    n.show()
    // Keep the taskbar button flashing until the user comes back to the window.
    win?.flashFrame(true)
  })

  // Taskbar unread badge. The renderer draws a small numeric overlay (canvas)
  // and we paint it onto the window's taskbar button (Windows) / set the app
  // badge count (macOS/Linux). Cleared with count 0.
  ipcMain.on('app:set-badge', (e, payload: { count: number; dataUrl: string | null }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    try {
      const img =
        payload.count > 0 && payload.dataUrl
          ? nativeImage.createFromDataURL(payload.dataUrl)
          : null
      win.setOverlayIcon(img, payload.count > 0 ? `${payload.count} tarefas concluídas` : '')
    } catch {
      /* setOverlayIcon is Windows-only */
    }
    try {
      app.setBadgeCount(payload.count)
    } catch {
      /* badge count is macOS/Linux */
    }
  })

  registerWindowHandlers(() => createWindow(true))
  registerWorkspaceHandlers()
  registerSshHandlers()
  registerSshHostHandlers()
  registerFsHandlers()
  registerDialogHandlers(() => mainWindow)
  registerTerminalHandlers()
  registerSettingsHandlers()
  registerClaudeAgentHandlers()
  registerAuthHandlers()
  registerProviderHandlers()
  registerNativeCodexHandlers()
  registerModelHandlers()
  registerAgentCommandHandlers()
  registerTraycerImportHandlers()
  registerTraycerLiveHandlers()
  registerSessionHandlers()
  registerSlashCommandHandlers()
  registerExtensionHandlers()
  registerSearchHandlers()
  registerGitHandlers()
  registerRemoteControlHandlers()
  registerBrowserHandlers()
  registerUsageHandlers()
  registerHostHandlers()
  initExtensions(store, (channel, payload) => mainWindow?.webContents.send(channel, payload))

  const splash = createSplash()
  mainWindow = createWindow()

  mainWindow?.once('ready-to-show', () => {
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.destroy()
      mainWindow?.show()
      mainWindow?.focus()
    }, 1500)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// The windows' last saves to the host (chats:flush, tasks:flush) finish before
// the app exits. They arrive before `before-quit` when the last window is
// closed, and between it and `will-quit` when the app quits with windows open;
// each stage waits at most once, so quitting never loops.
const drainedAt = new Set<string>()
const awaitHostWrites = (stage: string) => (event: Electron.Event): void => {
  if (drainedAt.has(stage) || !pendingHostWrites()) return
  drainedAt.add(stage)
  event.preventDefault()
  void drainHostWrites(3000).finally(() => app.quit())
}
app.on('before-quit', awaitHostWrites('before-quit'))
app.on('will-quit', awaitHostWrites('will-quit'))
