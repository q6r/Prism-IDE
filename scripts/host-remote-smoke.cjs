// T09 acceptance on the real app, through a real Cloudflare quick tunnel:
// the built main, preload and renderer (`npm run build`) with the release
// host (`npm run host:build`), on a temporary profile. Costs one short Haiku
// turn on the terminal account.
//   node scripts/host-remote-smoke.cjs
// Run 1 opens the app on a seeded chat, shares it from the chat's menu
// (Controle remoto), reads its link from the dialog and closes the app. With
// no window left, a "phone" (this script) opens the link's page and socket
// through the tunnel, sends a prompt that needs an approval, approves it and
// sees the turn finish. Run 2 reopens the app: the chat still shows as shared
// (the host kept it), the dialog shows the connected phone, and stopping the
// share from the chat's menu revokes the link: the phone is told and a new
// socket on the same link is refused. Screenshots go to out/qa/remote/.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'out', 'qa', 'remote')
const EXE = process.platform === 'win32' ? 'prism-host.exe' : 'prism-host'
const CHAT = 't09-chat'
const PROMPT = 'Use a ferramenta Write para criar o arquivo prova-t09.txt nesta pasta com o conteúdo ok. Depois responda só: pronto.'

if (!process.versions.electron) {
  void outer()
} else {
  inElectron()
}

/* ------------------------------ the phone ------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check, label, timeout = 60_000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await sleep(200)
  }
}

/** A phone on a shared chat's link, applying `state`/`delta` like the mobile page. */
function phoneOn(link) {
  const url = new URL(link)
  const token = new URLSearchParams(url.hash.slice(1)).get('t')
  const socket = `${url.protocol === 'https:' ? 'wss' : 'ws'}://${url.host}/?t=${encodeURIComponent(token)}`
  const phone = { messages: [], chat: null, open: false, closed: false, ws: null }
  phone.connect = () => new Promise((resolve) => {
    const ws = new WebSocket(socket)
    phone.ws = ws
    ws.onopen = () => { phone.open = true; resolve(true) }
    ws.onerror = () => resolve(false)
    ws.onclose = () => { phone.closed = true; phone.open = false; resolve(false) }
    ws.onmessage = (event) => {
      const m = JSON.parse(String(event.data))
      phone.messages.push(m)
      if (m.t === 'state') phone.chat = m.chat
      if (m.t === 'delta' && phone.chat) {
        const byId = Object.fromEntries((phone.chat.turns || []).map((t) => [t.id, t]))
        for (const t of m.turns || []) byId[t.id] = t
        Object.assign(phone.chat, { title: m.title, streaming: m.streaming, contextPct: m.contextPct, turns: (m.ids || []).map((id) => byId[id]).filter(Boolean) })
      }
    }
  })
  phone.cmd = (action, payload) => phone.ws.send(JSON.stringify({ t: 'cmd', tabId: CHAT, action, payload }))
  phone.acked = (action) => phone.messages.find((m) => m.t === 'ack' && m.stage === 'done' && m.action === action)
  return phone
}

async function outer() {
  const { spawn } = require('node:child_process')
  fs.mkdirSync(outDir, { recursive: true })
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-host-remote-'))
  const env = { ...process.env, PRISM_SMOKE_USER_DATA: userData, PRISM_HOST_BIN: path.join(root, 'host', 'target', 'release', EXE) }
  delete env.ELECTRON_RUN_AS_NODE
  // The cloudflared the app already downloaded, when there is one (else the host downloads it).
  const known = path.join(process.env.APPDATA || '', 'prism-ide', 'cloudflared', 'cloudflared.exe')
  if (!env.PRISM_CLOUDFLARED_BIN && process.platform === 'win32' && fs.existsSync(known)) env.PRISM_CLOUDFLARED_BIN = known
  const run = (phase) => new Promise((resolve) => {
    const child = spawn(require('electron'), [__filename, phase], { env, stdio: 'inherit', windowsHide: true })
    const timer = setTimeout(() => child.kill(), 240_000)
    child.on('exit', (code) => { clearTimeout(timer); resolve(code ?? 1) })
  })
  let code = 1
  try {
    code = await run('share')
    if (code !== 0) throw new Error('share failed')
    const link = fs.readFileSync(path.join(userData, 'remote-link.txt'), 'utf8').trim()
    console.log('[phone] link through', new URL(link).host)
    const page = await until(async () => {
      try { const res = await fetch(new URL('/', link)); return res.ok ? res : null } catch { return null }
    }, 'the page through the tunnel', 90_000)
    console.log('[phone] page', page.status, page.headers.get('content-type'))
    const phone = phoneOn(link)
    await until(() => phone.connect(), 'the phone socket through the tunnel', 60_000)
    await until(() => phone.chat, 'the chat on the phone')
    console.log('[phone] connected, chat:', phone.chat.title, '· turns', phone.chat.turns.length)
    phone.cmd('send', { text: PROMPT })
    const sent = await until(() => phone.acked('send'), 'the send ack')
    console.log('[phone] send ack', JSON.stringify(sent))
    if (!sent.ok) throw new Error(`the host refused the send: ${sent.reason}`)
    const asking = await until(() => phone.chat?.turns?.find((t) => t.pendingPerm), 'the approval on the phone', 180_000)
    console.log('[phone] approval:', asking.pendingPerm.toolName, '·', String(asking.pendingPerm.preview).split('\n')[0])
    phone.cmd('perm', { permId: asking.pendingPerm.permId, decision: 'allow', turnId: asking.id })
    const approved = await until(() => phone.acked('perm'), 'the approval ack')
    console.log('[phone] perm ack', JSON.stringify(approved))
    await until(() => {
      const last = phone.chat?.turns?.at(-1)
      const text = JSON.stringify(last?.segments ?? last?.text ?? '').toLowerCase()
      return !phone.chat.streaming && last?.role === 'assistant' && text.includes('pronto')
    }, 'the turn finishing on the phone', 180_000)
    const file = path.join(userData, 't09-demo', 'prova-t09.txt')
    console.log('[phone] turn done; file written by the turn:', fs.existsSync(file) ? JSON.stringify(fs.readFileSync(file, 'utf8')) : '(missing)')

    code = await run('reopen')
    if (code !== 0) throw new Error('reopen failed')
    await until(() => phone.messages.some((m) => m.t === 'revoked'), 'the phone told the link is revoked', 30_000)
    await until(() => phone.closed, 'the phone socket closed', 30_000)
    const again = phoneOn(link)
    const reopened = await again.connect()
    console.log('[phone] revoked and closed; a new socket on the same link:', reopened ? 'OPENED (bad)' : 'refused')
    if (reopened) code = 1
  } catch (err) {
    console.error('remote smoke failed:', err.message)
    code = 1
  } finally {
    await stopHost(path.join(userData, 'host')).catch((err) => console.warn('host shutdown:', err.message))
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  }
  process.exit(code)
}

/** Asks the profile's host to stop (owner token from its instance file). */
async function stopHost(hostDir) {
  const instance = JSON.parse(fs.readFileSync(path.join(hostDir, 'host-instance.json'), 'utf8'))
  const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/rpc`)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const replies = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); replies.get(m.id)?.(m) }
  const call = (id, method, params) => new Promise((resolve) => { replies.set(id, resolve); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })) })
  await call(1, 'host.hello', { protocol: { major: 1, minor: 0 }, client: { kind: 'desktop', version: 'smoke' }, token: instance.token })
  await call(2, 'host.shutdown', {})
  ws.close()
  await sleep(1500)
}

/* ------------------------------ the app ------------------------------ */

function inElectron() {
  const { app, BrowserWindow } = require('electron')
  const phase = process.argv.at(-1)
  const userData = process.env.PRISM_SMOKE_USER_DATA
  const demo = path.join(userData, 't09-demo')
  app.setPath('userData', userData)
  app.getAppPath = () => root
  // Off screen and out of the taskbar, yet painting (see host-app-smoke.cjs).
  BrowserWindow.prototype.show = function () { this.setSkipTaskbar(true); this.setPosition(-32000, -32000); this.showInactive() }
  BrowserWindow.prototype.focus = function () {}

  if (phase === 'share') {
    fs.mkdirSync(demo, { recursive: true })
    fs.writeFileSync(path.join(demo, 'README.md'), '# Prova do T09\n')
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(path.join(userData, 'prism-agents.db'))
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE state (key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,turn_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX events_chat ON events(chat_id,seq);`)
    const now = Date.now()
    const chat = { id: CHAT, title: 'Prova do T09', taskId: 't09-task', cwd: demo, createdAt: now, updatedAt: now, turns: [],
      selection: { provider: 'claude', profileId: 'ambient-claude', model: 'haiku', effort: 'low', permissionMode: 'default' } }
    const task = { id: 't09-task', title: 'Prova do T09', cwd: demo, updatedAt: now, activeChatId: CHAT }
    const put = db.prepare('INSERT INTO documents VALUES (?,?,?)')
    put.run('chats', chat.id, JSON.stringify(chat))
    put.run('tasks', task.id, JSON.stringify(task))
    const state = db.prepare('INSERT INTO state VALUES (?,?)')
    state.run('migrated-json', 'true')
    state.run('task-tabs', JSON.stringify({ openIds: [task.id], activeId: task.id }))
    db.close()
  }

  require(path.join(root, 'out', 'main', 'index.js'))

  const started = Date.now()
  const log = (event) => console.log(`[${phase} ${((Date.now() - started) / 1000).toFixed(1)}s] ${event}`)
  for (const event of ['window-all-closed', 'quit']) app.on(event, () => log(event))
  const pause = (ms) => new Promise((r) => setTimeout(r, ms))
  const mainWindow = async () => {
    for (let i = 0; i < 300; i++) {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().endsWith('index.html'))
      if (win) return win
      await pause(100)
    }
    throw new Error('the app window did not open')
  }
  const errors = []
  app.whenReady().then(async () => {
    let win
    const js = (source) => win.webContents.executeJavaScript(source, true)
    const waitFor = async (source, label, timeout = 60000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) { if (await js(source).catch(() => false)) return; await pause(200) }
      throw new Error(`Timed out: ${label}`)
    }
    const shot = async (name) => {
      win.webContents.invalidate()
      await pause(1500)
      const image = await win.webContents.capturePage(undefined, { stayHidden: true })
      fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG())
      console.log('shot', path.relative(root, path.join(outDir, `${name}.png`)))
    }
    const clickMenu = async (label) => {
      await js(`document.querySelector('[aria-label="Mais ações do chat"]').click()`)
      await waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.trim() === ${JSON.stringify(label)})`, `menu item ${label}`, 15000)
      await js(`[...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim() === ${JSON.stringify(label)}).click()`)
    }
    try {
      win = await mainWindow()
      win.webContents.setBackgroundThrottling(false)
      win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message) })
      await waitFor('!!document.querySelector(".tcm-shell")', 'composer ready')
      await waitFor(`window.prism.host.capabilities().includes('remote@1')`, 'host serves remote')
      await waitFor(`[...document.querySelectorAll('*')].some(e => e.childElementCount === 0 && e.textContent.trim() === 'Prova do T09')`, 'the chat is open')
      if (phase === 'share') {
        await clickMenu('Controle remoto')
        await waitFor(`!!document.querySelector('[aria-label="Link de controle remoto"]')?.value`, 'the link in the dialog', 150000)
        const link = await js(`document.querySelector('[aria-label="Link de controle remoto"]').value`)
        fs.writeFileSync(path.join(userData, 'remote-link.txt'), link)
        log(`shared through ${new URL(link).host}`)
        await waitFor(`!!document.querySelector('.ps-shell-control-qr[src]')`, 'the QR code', 15000)
        await shot('remote-1-shared')
        console.log('closing the app with the chat shared')
        win.close()
      } else {
        // The host kept the share: the header says so without anything clicked.
        await waitFor(`!!document.querySelector('.ch-header-remote')`, 'the chat still shared after reopening', 30000)
        await js(`document.querySelector('.ch-header-remote').click()`)
        await waitFor(`!!document.querySelector('.ps-shell-control-status.on')`, 'the phone shown as connected', 30000)
        await shot('remote-2-reopened')
        await js(`document.querySelector('.ps-shell-remote-control-dialog [aria-label="Fechar"], .ps-shell-remote-control-dialog button[aria-label*="echar"]')?.click()`).catch(() => {})
        await clickMenu('Parar controle remoto')
        await waitFor(`!document.querySelector('.ch-header-remote')`, 'the share stopped', 30000)
        // The window may close only once the host has it (the unshare is fire-and-forget).
        await waitFor(`window.prism.remoteControl.status().then((s) => !s.running && s.chats.length === 0)`, 'the host no longer sharing', 30000)
        await shot('remote-3-stopped')
        if (errors.length) console.log('renderer console errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'))
        app.quit()
      }
    } catch (err) {
      console.error(`${phase} failed: ${err.message}`)
      if (win) await shot(`remote-${phase}-failure`).catch(() => {})
      if (errors.length) console.log('renderer console errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'))
      app.exit(1)
    }
  })
}
