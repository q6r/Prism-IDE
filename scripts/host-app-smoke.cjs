// T07 acceptance on the real app: the built main, preload and renderer (run
// `npm run build` first) with the release host (`npm run host:build`), on a
// temporary profile. Costs one short Haiku turn on the terminal account.
//   node scripts/host-app-smoke.cjs
// Run 1 seeds Prism 0.2 data (a Haiku chat and its task; the host imports
// them on its first start), sends a prompt that needs an approval and closes
// the app while the approval is pending. Run 2 reopens the app on the same
// profile: the host kept the turn, the approval is still there, approving it
// finishes the turn. Screenshots go to out/qa/host/.
//
// T08, no prompt at all:
//   node scripts/host-app-smoke.cjs accounts
// seeds a profile in the desktop's old store, with its own login folder; the
// host takes it over on its first start, the app lists it from the host and
// shows it in Settings ▸ Provedores, the Usage records come from the host,
// and the login folder stays where the desktop keeps it (never copied).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'out', 'qa', 'host')
const EXE = process.platform === 'win32' ? 'prism-host.exe' : 'prism-host'
const PROMPT = 'Use a ferramenta Write para criar o arquivo prova-t07.txt nesta pasta com o conteúdo ok. Depois responda só: pronto.'

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-host-app-'))
  const env = { ...process.env, PRISM_SMOKE_USER_DATA: userData, PRISM_HOST_BIN: path.join(root, 'host', 'target', 'release', EXE) }
  delete env.ELECTRON_RUN_AS_NODE
  const run = (phase) => {
    const result = spawnSync(require('electron'), [__filename, phase], { env, stdio: 'inherit', windowsHide: true, timeout: 240000 })
    if (result.error) throw result.error
    return result.status ?? 1
  }
  let code = 1
  const phases = process.argv[2] === 'accounts' ? ['accounts'] : ['send', 'reopen']
  const main = async () => {
    try {
      for (const phase of phases) {
        code = run(phase)
        if (code !== 0) break
      }
    } finally {
      await stopHost(path.join(userData, 'host')).catch((err) => console.warn('host shutdown:', err.message))
      fs.rmSync(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
    }
    process.exit(code)
  }
  void main()
} else {
  inElectron()
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
  await new Promise((resolve) => setTimeout(resolve, 1500))
}

function inElectron() {
  const { app, BrowserWindow } = require('electron')
  const phase = process.argv.at(-1)
  const userData = process.env.PRISM_SMOKE_USER_DATA
  const demo = path.join(userData, 't07-demo')
  app.setPath('userData', userData)
  // The built main resolves its resources and dev host candidates from here.
  app.getAppPath = () => root
  // The windows open off screen and out of the taskbar: nothing pops up on the
  // desktop, yet they paint (a never-shown window's captures lag its DOM).
  BrowserWindow.prototype.show = function () { this.setSkipTaskbar(true); this.setPosition(-32000, -32000); this.showInactive() }
  BrowserWindow.prototype.focus = function () {}
  fs.mkdirSync(outDir, { recursive: true })

  const account = { id: 't08-work', provider: 'claude', name: 'Trabalho T08', color: '#3366ff' }
  const loginFolder = path.join(userData, 'provider-profiles', account.id)
  if (phase === 'send' || phase === 'accounts') {
    fs.mkdirSync(demo, { recursive: true })
    fs.writeFileSync(path.join(demo, 'README.md'), '# Prova do T07\n')
    // Prism 0.2's database, as the AgentRepository writes it.
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(path.join(userData, 'prism-agents.db'))
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE documents (kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE state (key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT,chat_id TEXT NOT NULL,turn_id TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX events_chat ON events(chat_id,seq);`)
    const now = Date.now()
    const chat = { id: 't07-chat', title: 'Prova do T07', taskId: 't07-task', cwd: demo, createdAt: now, updatedAt: now, turns: [],
      selection: { provider: 'claude', profileId: 'ambient-claude', model: 'haiku', effort: 'low', permissionMode: 'default' } }
    const task = { id: 't07-task', title: 'Prova do T07', cwd: demo, updatedAt: now, activeChatId: 't07-chat' }
    const put = db.prepare('INSERT INTO documents VALUES (?,?,?)')
    put.run('chats', chat.id, JSON.stringify(chat))
    put.run('tasks', task.id, JSON.stringify(task))
    const state = db.prepare('INSERT INTO state VALUES (?,?)')
    state.run('migrated-json', 'true')
    state.run('task-tabs', JSON.stringify({ openIds: [task.id], activeId: task.id }))
    if (phase === 'accounts') {
      // A Prism account as the desktop kept it until T08; its login folder
      // holds no login (the CLI reports it logged out), only a marker.
      put.run('profiles', account.id, JSON.stringify(account))
      fs.mkdirSync(loginFolder, { recursive: true })
      fs.writeFileSync(path.join(loginFolder, 'marker.txt'), 'stays here')
    }
    db.close()
  }

  require(path.join(root, 'out', 'main', 'index.js'))

  const started = Date.now()
  const log = (event) => console.log(`[${phase} ${((Date.now() - started) / 1000).toFixed(1)}s] ${event}`)
  for (const event of ['window-all-closed', 'before-quit', 'will-quit', 'quit']) app.on(event, () => log(event))
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
    const until = async (source, label, timeout = 30000) => {
      const start = Date.now()
      while (Date.now() - start < timeout) { if (await js(source).catch(() => false)) return; await pause(150) }
      throw new Error(`Timed out: ${label}`)
    }
    const shot = async (name) => {
      // A hidden window's frames lag its DOM: repaint and let it settle before capturing.
      win.webContents.invalidate()
      await pause(1500)
      const image = await win.webContents.capturePage(undefined, { stayHidden: true })
      fs.writeFileSync(path.join(outDir, `${name}.png`), image.toPNG())
      console.log('shot', path.relative(root, path.join(outDir, `${name}.png`)))
    }
    try {
      win = await mainWindow()
      // Hidden, the app's window would throttle its painting.
      win.webContents.setBackgroundThrottling(false)
      win.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message) })
      win.on('close', () => log('window close'))
      win.on('closed', () => log('window closed'))
      win.webContents.on('will-prevent-unload', () => log('will-prevent-unload: a beforeunload handler kept the window open'))
      await until('!!document.querySelector(".tcm-shell")', 'composer ready', 60000)
      if (phase === 'accounts') {
        // Asked right away: before the window's first hello it waits for the host.
        const listed = await js(`window.prism.providers.list().then((list) => list.map((p) => p.id + ':' + p.name))`)
        console.log('accounts listed:', JSON.stringify(listed))
        if (!listed.includes(`${account.id}:${account.name}`)) throw new Error('the desktop account was not taken over by the host')
        console.log('providers route:', await js(`window.prism.host.route('providers')`))
        await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`)
        await until(`!!document.querySelector('[data-testid="settings-sidebar-item-providers"]')`, 'settings open')
        await js(`document.querySelector('[data-testid="settings-sidebar-item-providers"]').click()`)
        await until(`!!document.querySelector('.stg-profiles .trp-trigger')`, 'Settings ▸ Provedores', 30000)
        await pause(4000)
        await shot('app-accounts-providers')
        // The other accounts are in the profile menu.
        await js(`document.querySelector('.stg-profiles .trp-trigger').click()`)
        await until(`document.body.textContent.includes(${JSON.stringify(account.name)})`, 'the account in the profile menu', 30000)
        await pause(1500)
        await shot('app-accounts-menu')
        const usage = await js(`window.prism.usage.records().then((r) => ({ turns: r.observations.length, import: r.importState.status }))`)
        console.log('usage records:', JSON.stringify(usage))
        const kept = fs.existsSync(path.join(loginFolder, 'marker.txt'))
        const copied = fs.existsSync(path.join(userData, 'host', 'provider-profiles'))
        console.log('login folder kept in place:', kept, '· copied into the host folder:', copied)
        if (!kept || copied) throw new Error('the login folder moved or was copied')
        if (errors.length) console.log('renderer console errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'))
        app.quit()
        return
      }
      await until(`window.prism.host.capabilities().includes('chats@1')`, 'host serves chats', 60000)
      await until(`[...document.querySelectorAll('*')].some(e => e.childElementCount === 0 && e.textContent.trim() === 'Prova do T07')`, 'the imported chat is open', 60000)
      if (phase === 'send') {
        await js(`(() => {
          const box = document.querySelector('[data-composer-shell] textarea')
          const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          set.call(box, ${JSON.stringify(PROMPT)})
          box.dispatchEvent(new Event('input', { bubbles: true }))
        })()`)
        await pause(300)
        await js(`document.querySelector('.tcm-send:not(.stop)').click()`)
        await until(`!!document.querySelector('.ch-approval')`, 'approval while the app is open', 180000)
        await shot('app-1-approval')
        console.log('closing the app with the approval pending')
        win.close()
      } else {
        await until(`!!document.querySelector('.ch-approval')`, 'approval still pending after reopening', 60000)
        await shot('app-2-reopened')
        await js(`[...document.querySelectorAll('.ch-approval-actions button')].find(b => b.textContent.includes('Aprovar')).click()`)
        await until(`[...document.querySelectorAll('.ch-msg.assistant')].at(-1)?.textContent.toLowerCase().includes('pronto') && !document.querySelector('.tcm-send.stop')`, 'turn finished after reopening', 180000)
        await shot('app-3-done')
        const file = path.join(demo, 'prova-t07.txt')
        console.log('file written by the turn:', fs.existsSync(file) ? JSON.stringify(fs.readFileSync(file, 'utf8')) : '(missing)')
        if (errors.length) console.log('renderer console errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'))
        app.quit()
      }
    } catch (err) {
      console.error(`${phase} failed: ${err.message}`)
      if (win) await shot(`app-${phase}-failure`).catch(() => {})
      if (errors.length) console.log('renderer console errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'))
      app.exit(1)
    }
  })
}
