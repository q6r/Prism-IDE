// Run: node scripts/agents-ui-smoke.cjs (after npm run build).
// Starts only this mock main process, the built renderer, and the real preload.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-agents-smoke-'))
  const env = { ...process.env, PRISM_QA_USER_DATA: temporary }; delete env.ELECTRON_RUN_AS_NODE
  let code = 1
  try {
    const run = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 130000 })
    if (run.error) throw run.error
    code = run.status ?? 1
  } finally {
    // Chromium releases its userData locks when the Electron process exits.
    if (path.dirname(temporary) === path.resolve(os.tmpdir()) && path.basename(temporary).startsWith('prism-agents-smoke-'))
      fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  process.exit(code)
}

const { app, BrowserWindow, ipcMain, session } = require('electron')
const root = path.resolve(__dirname, '..')
const qa = path.join(root, 'out', 'qa')
const temporary = process.env.PRISM_QA_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'prism-agents-smoke-'))
app.setPath('userData', temporary)
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const chatFile = path.join(temporary, 'mock-chats.json')
const profiles = [
  { id: 'ambient-claude', provider: 'claude', name: 'Claude do terminal', ambient: true },
  { id: 'ambient-codex', provider: 'codex', name: 'Codex do terminal', ambient: true },
  { id: 'claude-work', provider: 'claude', name: 'Claude Trabalho' },
  { id: 'codex-work', provider: 'codex', name: 'Codex Trabalho' }
]
const requests = [], checks = [], screenshots = [], errors = [], pending = new Map(), performanceChecks = {}
const readChats = () => fs.existsSync(chatFile) ? JSON.parse(fs.readFileSync(chatFile, 'utf8')) : []
const writeChats = (chats) => fs.writeFileSync(chatFile, JSON.stringify(chats))
const handle = (channel, fn) => ipcMain.handle(channel, (_event, ...args) => fn(...args))
ipcMain.on('window:close', event => BrowserWindow.fromWebContents(event.sender)?.close())
const fixtures = {
  'app:logo': '', 'app:info': { platform: 'win32', version: 'QA' },
  'app:getRecents': [], 'app:getRecentRemotes': [], 'window:is-maximized': false,
  'settings:getAll': { animations: false, notifyOnAsk: false, notifyOnDone: false, recentFolders: [], recentWorkspaces: [] },
  'ext:list': [], 'claude:configured': false, 'claude:cli-available': { available: true, version: 'mock' },
  'agent:available': { available: true, version: 'mock' },
  'auth:status': { loggedIn: true, email: 'qa@example.invalid' },
  'rc:status': { enabled: false }, 'ssh:hosts:list': [], 'sessions:list': [], 'commands:list': [],
  'fs:readDir': [], 'fs:listFiles': [], 'fs:readFile': '// mock file\n',
  'dialog:openFolder': 'C:\\QA\\prism-demo', 'dialog:openFile': null,
  'workspace:open': null, 'workspace:read': null, 'workspace:save': null,
  'terminal:init': 'C:\\QA\\prism-demo', 'terminal:setCwd': 'C:\\QA\\prism-demo',
  'app:addRecent': [], 'app:addRecentWorkspace': [], 'app:openExternal': null,
  'settings:set': true,
  // Channels added after the smoke was written: answered so the log stays clean.
  'traycer:pending-links': [], 'git:branches': { current: 'main', local: ['main'], remote: [] },
  // No Prism host in the mock: the UI must work on IPC alone.
  'host:connection': null
}
fixtures['git:status'] = { isRepo: true, root: 'C:\\QA\\prism-demo', branch: 'main', files: [
  { path: 'src/App.tsx', x: ' ', y: 'M', staged: false, untracked: false, workingStats: { insertions: 12, deletions: 3, binary: false } }
] }
for (const [channel, value] of Object.entries(fixtures)) handle(channel, () => value)
let taskState={tasks:[],openIds:[],activeId:null}
handle('host:owns-chats', () => false)
handle('tasks:load',()=>taskState)
handle('tasks:save',(tasks,openIds,activeId)=>{taskState={tasks,openIds,activeId}})
ipcMain.on('tasks:flush',(e,tasks,openIds,activeId)=>{taskState={tasks,openIds,activeId};e.returnValue={ok:true}})
handle('providers:models',(provider)=>[{provider,id:provider==='codex'?'gpt-qa':'claude-qa',label:provider==='codex'?'GPT QA':'Claude QA',description:'Native catalog fixture',efforts:['low','high'],default:true}])
handle('providers:update',(id,patch)=>{Object.assign(profiles.find(p=>p.id===id),patch);return profiles})
handle('providers:list', () => profiles)
let usageFails=false
const usageRequests=[]
handle('providers:details',(provider,id,force)=>{usageRequests.push({provider,id,force});return {email:'qa@example.invalid',tier:'QA',updatedAt:Date.now(),stale:usageFails,error:usageFails?'QA_USAGE_UNAVAILABLE':undefined,limits:[{label:'Sessão · 5h',usedPercent:35,windowMinutes:300,resetsAt:Math.floor(Date.now()/1000)+500},{label:'Todos os modelos · 7 dias',usedPercent:78,windowMinutes:10080}],extras:[{label:'Uso extra',value:'Ativado'}]}})
handle('providers:status', () => ({ installed: true, loggedIn: true, detail: 'Conectada · simulação QA' }))
handle('providers:create', (provider, name) => {
  const p = { id: `${provider}-qa-${profiles.length}`, provider, name }; profiles.push(p); return p
})
handle('providers:login', () => true)
handle('traycer:preview', () => ({ root: 'C:\\QA\\.traycer', profiles: [{ id: 'traycer-profile-fixture', provider: 'codex', name: 'Conta Traycer QA', credentialsAvailable: true, ambient: false }],
  chats: [{ id: 'task/chat', epicId: 'task', title: 'Conversa Traycer QA', provider: 'codex', profileId: 'traycer-profile-fixture', updatedAt: Date.now(), messageCount: 2, imported: false }], warnings: [] }))
handle('traycer:tasks',()=>[{id:'live-task',title:'Tarefa Traycer QA',count:3}])
handle('traycer:activity',()=>({taskId:'live-task',checkedAt:Date.now(),agents:[
 {id:'live-parent',title:'Orquestrador QA',harness:'codex',surface:'gui',archived:false,active:true,sessionState:null},
 {id:'live-child',parentChatId:'live-parent',title:'Revisor filho QA',harness:'claude',surface:'gui',archived:false,active:false,sessionState:null},
 {id:'live-other',title:'Agente remoto QA',harness:'codex',surface:'tui',archived:false,active:null,sessionState:null}
]}))
handle('traycer:transcript',(_task,id)=>[{id:'live-turn',role:'user',text:id==='live-child'?'Contexto exclusivo do filho':'Contexto exclusivo do pai'}])
handle('traycer:choose-root' , () => null)
handle('traycer:import', request => {
  assert.deepEqual(request.profileIds, ['traycer-profile-fixture']); assert.deepEqual(request.chatIds, ['task/chat']); assert.equal(request.copyCredentials, false)
  taskState.tasks.push({id:'traycer-task-fixture',title:'Tarefa importada QA',cwd:'',updatedAt:Date.now()})
  profiles.push({ id: 'traycer-profile-fixture', provider: 'codex', name: 'Conta Traycer QA' })
  writeChats([...readChats(), { id: 'traycer-chat-fixture', taskId:'traycer-task-fixture', traycerSource:{root:'C:\\QA\\.traycer',epicId:'task',chatId:'chat'}, title: 'Conversa Traycer QA', cwd: '', workspaceNeedsBinding: true, updatedAt: Date.now(),
    selection: { provider: 'codex', profileId: 'traycer-profile-fixture', model: '', effort: 'high', permissionMode: 'default' },
    turns: [{ id: 'traycer-turn-fixture', role: 'user', text: 'Histórico importado de teste' }] }])
  return { profiles: 1, chats: 1, credentials: 0, skipped: 0, warnings: [] }
})
handle('chats:list', readChats)
handle('chats:save', (chat) => {
  const chats = readChats().filter(c => c.id !== chat.id); chats.push(chat); writeChats(chats); return true
})
ipcMain.on('chats:flush', (event, snapshots) => {
  const chats = readChats()
  for (const chat of snapshots) {
    const index = chats.findIndex(c => c.id === chat.id)
    if (index < 0) chats.push(chat); else chats[index] = chat
  }
  writeChats(chats); event.returnValue = { ok: true }
})
handle('chats:delete', (id) => { writeChats(readChats().filter(c => c.id !== id)); return true })
for (const channel of ['agent:send', 'codex:send']) ipcMain.on(channel, (event, payload) => {
  requests.push({ channel, payload }); pending.set(payload.id, { sender: event.sender, channel })
})

let win
const pause = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))
const js = (source) => win.webContents.executeJavaScript(source, true)
async function until(source, label) {
  const start = Date.now()
  while (Date.now() - start < 10000) { if (await js(source)) return; await pause(100) }
  throw new Error(`Timed out: ${label}`)
}
async function click(selector) {
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing DOM target'); el.click() })()`)
  await pause()
}
async function value(selector, next) {
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing input');
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(next)});
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); })()`)
  await pause()
}
async function key(selector, name, init = {}) {
  await js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing key target');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true, ...${JSON.stringify(init)} })) })()`)
  await pause()
}
// Composer (Traycer's composer shell): the agent, account, model and effort live in the model picker popover.
const composer = '[data-composer-shell] textarea[aria-label="Mensagem para o agente"]'
const send = '[data-composer-shell] .tcm-send[aria-label="Enviar"]'
const idle = '!document.querySelector("[data-composer-shell] .tcm-send.stop")'
const modelTrigger = '[data-composer-shell] .tmp-trigger'
const permissionTrigger = '[data-composer-shell] .tpm-trigger'
const HARNESS_LABELS = { claude: 'Claude Code', codex: 'Codex' }
async function openModelPicker() {
  if (!await js('!!document.querySelector(".tmp-panel")')) await click(modelTrigger)
  await until('!!document.querySelector(".tmp-panel")', 'model picker open')
}
async function closeModelPicker() {
  if (await js('!!document.querySelector(".tmp-panel")')) await click(modelTrigger)
  await until('!document.querySelector(".tmp-panel")', 'model picker closed')
}
async function inModelPicker(fn) {
  await openModelPicker()
  try { return await fn() } finally { await closeModelPicker() }
}
const chatProvider = () => inModelPicker(async () =>
  (await js('document.querySelector(".tmp-rail-btn[aria-selected=true]").getAttribute("aria-label")')).startsWith(HARNESS_LABELS.codex) ? 'codex' : 'claude')
const setProvider = (next) => inModelPicker(() => click(`.tmp-rail-btn[aria-label^="${HARNESS_LABELS[next]}"]`))
const chatAccount = () => inModelPicker(async () => {
  const name = await js('document.querySelector(".tmp-profile-slot .trp-trigger-name")?.textContent ?? null')
  return profiles.find(p => p.name === name)?.id ?? null
})
const setAccount = (id) => inModelPicker(async () => {
  const name = profiles.find(p => p.id === id).name
  await click('.tmp-profile-slot .trp-trigger')
  await until('!!document.querySelector(".tmp-panel .trp-item")', 'profile menu open')
  await js(`[...document.querySelectorAll(".tmp-panel .trp-item")].find(i => i.getAttribute("aria-label").startsWith(${JSON.stringify(name)})).click()`); await pause()
})
// Settings modal (stg-*): the accounts live in Provedores, one provider and one profile at a time.
const settingsFrame = '.stg-frame'
const settingsTabbables = `[...document.querySelector(".stg-frame").querySelectorAll('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')].filter(el => !el.closest("[inert]") && el.getClientRects().length > 0)`
const bindingNotice = '[...document.querySelectorAll(".ch-notice")].find(n => n.textContent.includes("Escolha uma pasta local"))'
async function verify(label, fn) { await fn(); checks.push(label); console.log(`PASS ${label}`) }
async function screenshot(name, width, height) {
  win.setContentSize(width, height); await pause(200)
  if (name === 'agents-chat') await js('(() => { const el = document.querySelector(".ch-scroll"); el.scrollTop = el.scrollHeight })()')
  await js('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))')
  const file = path.join(qa, `${name}-${width}x${height}.png`)
  const image = await win.webContents.capturePage(undefined, { stayHidden: true })
  assert.equal(image.getSize().width, width); assert.equal(image.getSize().height, height)
  fs.writeFileSync(file, image.toPNG()); screenshots.push(file)
}
async function captures(name) {
  for(const [width,height] of [[1380,880],[900,600]]) {
    await screenshot(name,width,height)
    const bounds=await js(`({height:document.scrollingElement.scrollHeight,viewport:innerHeight,width:document.scrollingElement.scrollWidth,screen:innerWidth})`)
    assert.ok(bounds.height<=bounds.viewport+1,`${name}: page escapes viewport at ${width}x${height}: ${JSON.stringify(bounds)}`)
    assert.ok(bounds.width<=bounds.screen+1,`${name}: horizontal page overflow`)
  }
  win.setContentSize(1380,880);await pause()
}
async function openWindow() {
  win = new BrowserWindow({ width: 1380, height: 880, useContentSize: true, frame: false, show: false,
    // Same as the app's main window (src/main/index.ts): the preload is not sandboxed.
    webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } })
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') errors.push(event.message)
  })
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`Renderer exited: ${details.reason}`))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  if (process.env.PRISM_QA_RENDERER_URL) await win.loadURL(process.env.PRISM_QA_RENDERER_URL)
  else await win.loadFile(path.join(root, 'out/renderer/index.html'))
  await until(`!!document.querySelector('[aria-label="Novo agente"]:not(:disabled)') && !!document.querySelector(".al-sidebar .al-row")`, 'agent workspace ready')
}
async function closeWindow() {
  const closed = new Promise(resolve => win.once('closed', resolve))
  await click('.ps-shell-window-close')
  await closed
}
function emit(channel, event) { win.webContents.send(channel, event) }
async function completeClaude(request) {
  const id = request.payload.id
  emit('agent:system', { id, sessionId: 'qa-claude-session', model: 'mock', tools: [] })
  emit('agent:thinking', { id, text: 'QA_PRIVATE_REASONING' })
  emit('agent:text', { id, text: '## Projeto explorado\n\n' })
  emit('agent:text', { id, text: 'O fluxo principal está pronto para revisão.' })
  emit('agent:tool', { id, toolId: 'qa-tool', name: 'Bash', input: { command: 'npm test' } })
  emit('agent:tool-result', { id, toolId: 'qa-tool', content: 'QA_TOOL_RESULT: 14 tests passed', isError: false })
  await pause(100)
  assert.equal(await js(`document.querySelector(${JSON.stringify(modelTrigger)}).disabled`), true)
  emit('agent:done', { id }); pending.delete(id)
  await until(idle, 'Claude finished')
}
async function run() {
  fs.mkdirSync(qa, { recursive: true })
  await app.whenReady()
  // Prevent external requests, including model calls and documentation navigation.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: !process.env.PRISM_QA_RENDERER_URL || !_details.url.startsWith(process.env.PRISM_QA_RENDERER_URL) }))
  await openWindow()
  await verify('original Prism palette is default; neutral is selectable and restores to dark', async () => {
    assert.equal(await js('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()'), '#0b0b0e')
    await click('.ps-shell-rail [aria-label="Configurações (Ctrl+,)"]')
    await click('[data-testid="settings-sidebar-item-appearance"]')
    await click('.stg-theme-trigger')
    await js('[...document.querySelectorAll(".stg-theme-menu [role=menuitemradio]")].find(b => b.textContent.includes("Prism Neutral")).click()'); await pause()
    assert.equal(await js('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()'), '#181818')
    await captures('agents-neutral')
    await click('.stg-theme-trigger')
    await js('[...document.querySelectorAll(".stg-theme-menu [role=menuitemradio]")].find(b => b.textContent.includes("Prism Dark")).click()'); await pause()
    assert.equal(await js('getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()'), '#0b0b0e')
    await click('[data-testid="system-tab-modal-close-settings"]')
  })
  await captures('agents-welcome')
  await verify('per-chat provider, account and draft isolation', async () => {
    await value(composer, 'DRAFT_A')
    await click('[aria-label="Novo agente"]')
    assert.equal(await js(`document.querySelector(${JSON.stringify(composer)}).value`), '')
    await setProvider('codex'); await setAccount('codex-work'); await value(composer, 'DRAFT_B')
    await click('.al-sidebar .al-row:not(.active)')
    assert.equal(await js(`document.querySelector(${JSON.stringify(composer)}).value`), 'DRAFT_A')
    assert.equal(await chatProvider(), 'claude')
    await click('.al-sidebar .al-row:not(.active)')
    assert.equal(await js(`document.querySelector(${JSON.stringify(composer)}).value`), 'DRAFT_B')
    assert.equal(await chatAccount(), 'codex-work')
    await click('.al-sidebar .al-row:not(.active)')
  })
  await click('.al-workspace-trigger')
  await verify('Claude streaming and busy controls', async () => {
    await value(composer, 'Explore o projeto de demonstração')
    await click(send)
    await pause(100); assert.equal(requests.length, 1); assert.equal(requests[0].channel, 'agent:send')
    assert.equal(readChats().find(c => c.turns.length)?.turns[0].text, 'Explore o projeto de demonstração', 'Send must persist the prompt immediately')
    // Output arrives faster than the old debounce period for over one second.
    const id = requests[0].payload.id
    for (let i = 0; i < 14; i++) { emit('agent:text', { id, text: `stream-${i} ` }); await pause(100) }
    assert.ok(readChats().find(c => c.turns.length).turns[1].segments.some(s => s.text?.includes('stream-')), 'Continuous output must save before it stops')
    await verify('stream bursts are batched; completed history does not repaint on the runtime clock',async()=>{
      await js(`window.qaMutations=0;window.qaObserver=new MutationObserver(()=>window.qaMutations++);window.qaObserver.observe(document.querySelector('.ch-msg.assistant .ch-assistant'),{childList:true,subtree:true,characterData:true})`)
      for(let n=0;n<400;n++)emit('agent:text',{id,text:` burst-${n}`})
      await until('document.querySelector(".ch-scroll").textContent.includes("burst-399")','batched burst')
      const renders=await js('window.qaMutations');performanceChecks.domBatchesFor400Deltas=renders;assert.ok(renders<40,`400 deltas caused ${renders} DOM batches`)
      await js('window.qaObserver.disconnect()')
    })
    await completeClaude(requests[0])
    await until('document.querySelector(".ch-scroll").textContent.includes("fluxo principal")', 'transcript content visible')
  })
  await verify('changed files and workspace details; images and queue preserve message order', async () => {
    await until('!!document.querySelector(".acd-summary")', 'changed files summary')
    assert.match(await js('document.querySelector(".acd-summary").textContent'), /1 arquivo alterado/)
    await click('.acd-summary')
    assert.match(await js('document.querySelector(".acd-files").textContent'), /src\/App.tsx/)
    assert.match(await js('document.querySelector(".acd-footer").textContent'), /Local.*prism-demo.*main/)
    await value(composer, 'Start queue test'); await click(send); await pause()
    const current = requests.at(-1), before = requests.length
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(atob('${png}'), c => c.charCodeAt(0))], 'pixel.png', {type:'image/png'})); document.querySelector(${JSON.stringify(composer)}).dispatchEvent(new ClipboardEvent('paste', {clipboardData:dt,bubbles:true,cancelable:true})); })()`)
    await until('!!document.querySelector(".tcm-thumb img")', 'pasted image thumbnail')
    await value(composer, 'First queued with image'); await click('[aria-label="Adicionar à fila"]')
    await value(composer, 'Second queued'); await key(composer, 'Enter')
    assert.equal(requests.length, before)
    assert.equal(await js('document.querySelectorAll(".tcm-queue-item").length'), 2)
    await captures('chat-queue-and-context')
    emit('agent:done', {id:current.payload.id}); pending.delete(current.payload.id)
    await until('document.querySelectorAll(".tcm-queue-item").length === 1', 'first queued send')
    const first=requests.at(-1); assert.match(first.payload.prompt, /First queued with image/)
    assert.equal(first.payload.images[0].data, png)
    emit('agent:done', {id:first.payload.id}); pending.delete(first.payload.id)
    await until('!document.querySelector(".tcm-queue-item")', 'second queued send')
    const second=requests.at(-1); assert.match(second.payload.prompt, /Second queued/)
    emit('agent:done', {id:second.payload.id}); pending.delete(second.payload.id)
    await until(idle, 'queue finished')
    await until('!!document.querySelector(".ch-bubble-img-button")', 'image in transcript')
    await click('.ch-bubble-img-button'); await until('!!document.querySelector(".ch-image-preview[open]")', 'image preview')
    await click('.ch-image-preview[open] button')
    assert.equal(await js('document.querySelectorAll(".ch-image-preview[open]").length'), 0)
    await captures('chat-image-message')
    const sent=readChats().flatMap(c=>c.turns).find(t=>t.text==='First queued with image')
    assert.equal(sent.images[0].data, png)
  })
  await verify('provider handoff includes visible common transcript and tool results without reasoning', async () => {
    await setProvider('codex'); await setAccount('codex-work')
    assert.ok(await js('document.querySelector(".ps-shell-status-model").textContent.includes("Codex")'), 'Status bar must reflect the selected chat provider')
    await value(composer, 'Continue com os testes'); await click(send); await pause(100)
    const r = requests.at(-1); assert.equal(r.channel, 'codex:send'); assert.equal(r.payload.resume, undefined)
    for (const text of ['Explore o projeto', 'fluxo principal', 'npm test', 'QA_TOOL_RESULT']) assert.ok(r.payload.prompt.includes(text))
    assert.ok(!r.payload.prompt.includes('QA_PRIVATE_REASONING'))
    emit('codex:event', { id: r.payload.id, kind: 'session', sessionId: 'qa-codex-session' })
    emit('codex:event', { id: r.payload.id, kind: 'segment', segment: { kind: 'text', toolId: 'm1', text: 'Preparando testes…' } })
    emit('codex:event', { id: r.payload.id, kind: 'segment', segment: { kind: 'text', toolId: 'm1', text: '### Testes concluídos\n\nAs conversas e contas permanecem independentes.' } })
    emit('codex:event', { id:r.payload.id,kind:'metrics',metrics:{scope:'session',totalTokens:200,inputTokens:140,outputTokens:60,cachedTokens:20} })
    emit('codex:event', { id: r.payload.id, kind: 'done' }); pending.delete(r.payload.id)
    await until(idle, 'Codex finished')
    assert.ok(!(await js('document.querySelector(".ch-scroll").textContent')).includes('Preparando testes'))
  })
  await verify('agent monitor shows live clock, permission waits, tokens and preserved completion history',async()=>{
    await click('[aria-label="Monitor de agentes"]');await js('[...document.querySelectorAll(".al-monitor [role=tab]")].find(b=>b.textContent==="Todos").click()')
    assert.ok((await js('document.querySelector(".al-monitor").textContent')).includes('200 tokens'))
    await value(composer,'Verifique o monitor');await click(send);await pause(100)
    const r=requests.at(-1)
    await js(`window.qaHistoryMutations=0;window.qaHistoryObserver=new MutationObserver(()=>window.qaHistoryMutations++);[...document.querySelectorAll('.ch-msg.assistant')].slice(0,-1).forEach(el=>window.qaHistoryObserver.observe(el,{subtree:true,childList:true,characterData:true}))`)
    await pause(1100)
    assert.equal(await js('window.qaHistoryMutations'),0,'clock must not re-render completed messages');await js('window.qaHistoryObserver.disconnect()')
    assert.ok((await js('document.querySelector(".al-monitor").textContent')).includes('1 ativo'))
    assert.ok(await js('[...document.querySelectorAll(".al-run")].some(r=>r.textContent.includes("Iniciando") && !r.querySelector(".al-run-time").textContent.includes("0s"))'))
    emit('agent:permission',{id:r.payload.id,permId:'qa-monitor',toolUseId:'monitor-tool',toolName:'Bash',input:{command:'echo QA'}})
    await until('document.querySelector(".al-monitor").textContent.includes("Aguardando permissão")','waiting monitor')
    await captures('agents-monitor')
    emit('codex:event',{id:r.payload.id,kind:'done',aborted:true});pending.delete(r.payload.id)
    await until('document.querySelector(".al-monitor").textContent.includes("Interrompido")','monitor completed')
    await click('[aria-label="Fechar monitor de agentes"]')
    assert.ok(readChats().some(c=>c.turns.some(t=>t.completedAt && t.durationMs>=1000)))
    await value(composer,'Finalize o acompanhamento');await click(send);await pause(100)
    const final=requests.at(-1);emit('codex:event',{id:final.payload.id,kind:'session',sessionId:'qa-codex-session'});emit('codex:event',{id:final.payload.id,kind:'done'});pending.delete(final.payload.id)
    await until(idle,'monitor final success')
  })
  await captures('agents-chat')
  await verify('agent options are disclosed on demand and preserve permission and effort controls',async()=>{
    assert.equal(await js('!!document.querySelector(".tpm-menu")'),false)
    await click(permissionTrigger);await until('!!document.querySelector(".tpm-menu")','permission options')
    assert.equal(await js('document.querySelectorAll(".tpm-menu .tpm-item").length'),4)
    assert.ok(await js('document.querySelector(".tpm-menu").getBoundingClientRect().top>=0'))
    await captures('agents-options');await click(permissionTrigger);await until('!document.querySelector(".tpm-menu")','permission options closed')
    await inModelPicker(()=>until('!!document.querySelector(".tmp-panel .tmp-effort")','effort control'))
  })
  await verify('accounts dialog displays static status, focuses close and dismisses with Escape', async () => {
    await click('.al-account-row')
    await until(`document.activeElement === document.querySelector(${JSON.stringify(settingsFrame)})`, 'settings focus')
    await key(settingsFrame, 'Tab', { shiftKey: true })
    assert.equal(await js(`document.activeElement === ${settingsTabbables}.at(-1)`), true)
    await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }))'); await pause()
    assert.equal(await js('document.activeElement.dataset.testid'), 'system-tab-modal-close-settings')
    // One provider and one profile at a time: walk all four and add up their windows.
    let windows = 0, text = ''
    for (const harness of ['claude', 'codex']) {
      await click(`.stg-provider-list button[aria-label="${HARNESS_LABELS[harness]}"]`)
      for (const profile of profiles.filter(p => p.provider === harness)) {
        await click('.stg-profiles .trp-trigger')
        await js(`[...document.querySelectorAll(".tr-menu .trp-item")].find(i => i.getAttribute("aria-label").startsWith(${JSON.stringify(profile.name)})).click()`); await pause()
        await until(`document.querySelector(".stg-profiles .trp-trigger-name")?.textContent === ${JSON.stringify(profile.name)}`, `${profile.id} selected`)
        await until(`document.querySelector(".stg-profiles .stg-summary-badge:not(.plan)")?.textContent.trim() === "Conectado"`, `${profile.id} status`)
        await until('document.querySelectorAll(".stg-usage .tr-meter").length===2', `${profile.id} usage windows`)
        windows += await js('document.querySelectorAll(".stg-usage .tr-meter").length'); text += await js('document.querySelector(".stg-usage").textContent')
      }
    }
    assert.equal(windows, 8, 'usage windows')
    await verify('both providers expose named windows, reset time, extras and stale errors',async()=>{
      assert.ok(usageRequests.some(r=>r.provider==='claude'));assert.ok(usageRequests.some(r=>r.provider==='codex'))
      assert.ok(text.includes('35% usado'));assert.ok(text.includes('Renova em'));assert.ok(text.includes('Uso extra'))
      const refresh='[data-testid="providers-global-status"] .stg-refresh'
      usageFails=true;await click(refresh)
      await until('document.querySelector(".stg-usage").textContent.includes("QA_USAGE_UNAVAILABLE")','quota failure')
      assert.equal(await js('document.querySelectorAll(".stg-usage .tr-meter").length'),2)
      await until(`!document.querySelector(${JSON.stringify(refresh)}).disabled`,'refresh settled')
      usageFails=false;await click(refresh)
      await until('!document.querySelector(".stg-usage").textContent.includes("QA_USAGE_UNAVAILABLE")','quota retry')
    })
    await captures('agents-accounts')
    await js('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))')
    await pause(); assert.equal(await js(`!!document.querySelector(${JSON.stringify(settingsFrame)})`), false)
  })
  await verify('closing and reopening restores persisted chats, selections and transcript', async () => {
    await pause(900)
    const saved = readChats(); assert.equal(saved.length, 2)
    const active = saved.find(c => c.turns.length); assert.equal(active.selection.profileId, 'codex-work')
    await closeWindow(); await openWindow()
    assert.equal(await js('document.querySelectorAll(".al-sidebar .al-row").length'), 2)
    assert.equal(await chatProvider(), 'codex')
    assert.equal(await chatAccount(), 'codex-work')
    await until('document.querySelector(".ch-scroll").textContent.includes("conversas e contas")', 'restored transcript measured')
    assert.equal(await js(`document.querySelector(${JSON.stringify(composer)}).value`), '')
  })
  await verify('same-route request resumes native session after reopening', async () => {
    await value(composer, 'Retome esta conversa'); await click(send); await pause(100)
    const r = requests.at(-1); assert.equal(r.payload.resume, 'qa-codex-session'); assert.equal(r.payload.prompt, 'Retome esta conversa')
    emit('codex:event', { id: r.payload.id, kind: 'done' }); pending.delete(r.payload.id)
  })
  await verify('close during streaming flushes partial output and restart clears native resume', async () => {
    await until(idle, 'previous run finished')
    await value(composer, 'Tarefa interrompida no fechamento'); await click(send); await pause(100)
    const r = requests.at(-1)
    emit('codex:event', { id: r.payload.id, kind: 'session', sessionId: 'unfinished-session' })
    emit('codex:event', { id: r.payload.id, kind: 'segment', segment: { kind: 'text', toolId: 'partial', text: 'QA_PARTIAL_BEFORE_CLOSE' } })
    await until('document.querySelector(".ch-scroll").textContent.includes("QA_PARTIAL_BEFORE_CLOSE")', 'partial visible output')
    // Close before the periodic persistence timer; flush must retain this chunk.
    await closeWindow()
    const saved = readChats().find(c => c.pendingTurnId === r.payload.id)
    assert.ok(saved?.turns.at(-1).segments.some(s => s.text === 'QA_PARTIAL_BEFORE_CLOSE'))
    pending.delete(r.payload.id)
    await openWindow()
    await until('document.querySelector(".ch-scroll").textContent.includes("QA_PARTIAL_BEFORE_CLOSE")', 'transcript content visible')
    await value(composer, 'Continue após fechar'); await click(send); await pause(100)
    const next = requests.at(-1)
    assert.equal(next.payload.resume, undefined)
    assert.ok(next.payload.prompt.includes('QA_PARTIAL_BEFORE_CLOSE'))
    emit('codex:event', { id: next.payload.id, kind: 'done' }); pending.delete(next.payload.id)
  })
  await verify('Traycer live browser separates parent/child agents and uses authoritative activity',async()=>{
    await js('[...document.querySelectorAll(".al-nav-row")].find(b=>b.textContent.includes("Agentes do Traycer")).click()');await until('[...document.querySelectorAll(".al-browser [aria-level]")].some(el=>el.getAttribute("aria-level")==="2")','Traycer hierarchy')
    assert.ok((await js('document.querySelector(".al-browser").textContent')).includes('1 trabalhando'))
    assert.ok((await js('document.querySelector(".al-browser").textContent')).includes('indisponível'))
    await js('[...document.querySelectorAll(".al-browser .al-row")].find(b=>b.textContent.includes("Revisor filho QA")).click()')
    await until('document.querySelector(".al-browser-transcript").textContent.includes("Contexto exclusivo do filho")','child transcript')
    assert.equal((await js('document.querySelector(".al-browser-transcript").textContent')).includes('Contexto exclusivo do pai'),false)
    await captures('agents-traycer-live');await js('[...document.querySelectorAll(".al-browser .al-row")].find(b=>b.textContent.includes("Orquestrador QA")).querySelector(".al-chevron").click()');await pause()
    assert.equal(await js('[...document.querySelectorAll(".al-browser [aria-level]")].filter(el=>el.getAttribute("aria-level")==="2").length'),0)
    await click('[aria-label="Fechar visão do Traycer"]')
  })
  await verify('Traycer import preview, selection, metadata-only option and visible imported chat', async () => {
    const db = new (require('node:sqlite').DatabaseSync)(':memory:'); db.close()
    await js('[...document.querySelectorAll(".al-nav-row")].find(b => b.textContent.includes("Importar conversas")).click()'); await pause()
    await js('[...document.querySelectorAll(".tr-menu [role=menuitem]")].find(b => b.textContent.includes("Importar do Traycer")).click()')
    await until('!!document.querySelector(".traycer-import-list.chats input") && !document.querySelector(".traycer-import-dialog header button").disabled', 'Traycer import ready')
    await click('.traycer-copy-logins input')
    await click('.traycer-import-list.chats input')
    await captures('agents-traycer-import')
    await click('.traycer-import-dialog footer button')
    await until('!!document.querySelector(".traycer-import-result")', 'Traycer import complete')
    assert.ok((await js('document.querySelector(".traycer-import-result").textContent')).includes('0 logins do Traycer vinculados'))
    await click('.traycer-import-result button')
    await js('[...document.querySelectorAll(".al-sidebar .al-row")].find(b => b.textContent.includes("Conversa Traycer QA")).click()'); await pause()
    assert.equal(await chatAccount(), 'traycer-profile-fixture')
    await until(`document.querySelector(".ch-scroll").textContent.includes('Histórico importado de teste')`, "imported transcript visible")
    assert.ok(await js(`!!${bindingNotice}`))
    await js(`${bindingNotice}.querySelector(".ch-notice-action button").click()`); await pause()
    await until(`!${bindingNotice}`, 'Imported workspace bound')
    await until(`document.querySelector(".ch-scroll").textContent.includes('Histórico importado de teste')`, "imported transcript visible")
  })
  await verify('project tabs preserve chat and draft; close and reopen keeps conversations',async()=>{
    const original=await js('document.querySelector(".al-tab.active .al-tab-title").textContent')
    await value(composer,'PROJECT_A_DRAFT')
    await click('.al-tab-new')
    assert.equal(await js('document.querySelectorAll(".al-sidebar .al-row").length'),1)
    assert.equal(await js(`document.querySelector(${JSON.stringify(composer)}).value`),'')
    await value(composer,'PROJECT_B_DRAFT')
    await js(`[...document.querySelectorAll('.al-tab')].find(b=>b.querySelector('.al-tab-title')?.textContent===${JSON.stringify(original)}).click()`)
    assert.equal(await js(`document.querySelector(${JSON.stringify(composer)}).value`),'PROJECT_A_DRAFT')
    await click('.al-tab-frame:last-child .al-tab')
    assert.equal(await js(`document.querySelector(${JSON.stringify(composer)}).value`),'PROJECT_B_DRAFT')
    await click('.al-tab.active .al-tab-close')
    await click('[aria-label="Tarefas abertas e recentes"]')
    assert.ok(await js('[...document.querySelectorAll(".tr-menu [role^=menuitem]")].some(b=>b.textContent.includes("Nova tarefa"))'))
    await js('[...document.querySelectorAll(".tr-menu [role^=menuitem]")].filter(b=>b.textContent.includes("Nova tarefa")).at(-1).click()'); await pause()
    assert.equal(await js(`document.querySelector(${JSON.stringify(composer)}).value`),'PROJECT_B_DRAFT')
    await captures('agents-project-tabs')
  })
  await verify('picker searches native models, uses keyboard and restores focus',async()=>{
    const search='.tmp-search input'
    await openModelPicker()
    await click(`.tmp-rail-btn[aria-label^="${HARNESS_LABELS.claude}"]`)
    await value(search,'Claude QA')
    await until('document.querySelectorAll(".tmp-list [role=option]").length===1','model search')
    await key(search,'Enter')
    assert.equal(await js('document.querySelector(".tmp-list [role=option][aria-selected=true]")?.dataset.rowId'),'claude-qa')
    // The panel stays open after a pick (Traycer); Escape clears the search, then closes onto the composer editor.
    await key(search,'Escape');await key(search,'Escape')
    await until(`!document.querySelector(".tmp-panel") && document.activeElement===document.querySelector(${JSON.stringify(composer)})`,'picker closed onto the editor')
    await openModelPicker();await captures('agents-model-picker')
    await key(search,'Escape')
    assert.equal(await js('!!document.querySelector(".tmp-panel")'),false)
  })
  await verify('editor side chat uses the same conversation and account controls',async()=>{
    assert.equal(await js('performance.getEntriesByType("resource").filter(r=>r.name.includes("EditorArea-")).length'),0,'Monaco must load only when opening the editor')
    await js('[...document.querySelectorAll(".ps-shell-workspace-tabs [role=tab]")].find(b=>b.textContent.includes("Editor")).click()');await pause(200)
    assert.ok(await js('!!document.querySelector(".agent-editor-dock .agent-workspace.compact")'))
    assert.equal(await js('document.querySelectorAll(".agent-workspace").length'),1,'editor must not mount a hidden second conversation')
    await until('!document.querySelector(".editor-loading")','lazy editor ready')
    assert.equal(await js('document.querySelector(".agent-editor-dock textarea").value'),'PROJECT_B_DRAFT')
    await js('[...document.querySelectorAll(".ps-shell-workspace-tabs [role=tab]")].find(b=>b.textContent.includes("Conversas")).click()');await pause()
  })
  await verify('22k turns stay virtualized, scroll through history and follow streaming only at the bottom', async () => {
    await closeWindow()
    const selection = { provider: 'claude', profileId: 'ambient-claude', model: 'claude-qa', effort: 'high', permissionMode: 'default' }
    const base = { taskId: taskState.activeId, cwd: 'C:\\QA', selection, updatedAt: Date.now() }
    writeChats([
      { ...base, id: 'large-qa', title: 'Large QA', turns: Array.from({length: 22187}, (_, i) => ({
        id: `large-${i}`, role: i % 2 ? 'assistant' : 'user', text: `HISTORY_${i}\n` + 'Variable height text. '.repeat(i % 8 + 1),
        ...(i % 2 ? { startedAt: Date.now() - 30000, completedAt: Date.now() - 20000, segments: [{kind:'text',text:`HISTORY_${i}\n` + 'Variable height text. '.repeat(i % 8 + 1)}] } : {})
      })) },
      { ...base, id: 'small-qa', title: 'Small QA', turns: [{id:'small-turn',role:'user',text:'SMALL_QA'}] }
    ])
    await openWindow()
    await js(`[...document.querySelectorAll('.al-sidebar .al-row')].find(e => e.textContent.includes('Large QA')).click()`)
    await until(`!!document.querySelector('[data-turn-id="large-22186"]')`, 'last item of large chat')
    performanceChecks.largeChatMountedRows = await js(`document.querySelectorAll('.ch-list-row').length`)
    assert.ok(performanceChecks.largeChatMountedRows < 60, 'history must mount only the viewport')
    await js(`document.querySelector('.ch-scroll').scrollTop = 0`)
    await until(`!!document.querySelector('[data-turn-id="large-0"]')`, 'first item of large chat')
    await js(`[...document.querySelectorAll('.al-sidebar .al-row')].find(e => e.textContent.includes('Small QA')).click()`)
    await until(`document.querySelector('.ch-scroll').textContent.includes('SMALL_QA')`, 'small chat switch')
    await js(`[...document.querySelectorAll('.al-sidebar .al-row')].find(e => e.textContent.includes('Large QA')).click()`)
    await until(`!!document.querySelector('[data-turn-id="large-22186"]')`, 'large chat resets to bottom')
    await value(composer, 'Virtual streaming QA'); await click(send); await pause(150)
    const request = requests.at(-1), id = request.payload.id
    emit('agent:text', {id, text: 'STREAM_START'} )
    await until(`document.querySelector('.ch-scroll').textContent.includes('STREAM_START')`, 'new response follows')
    for (let i=0;i<25;i++) emit('agent:text', {id, text: '\nGrowing response '.repeat(20)})
    await pause(400)
    const gap = await js(`(() => {const e=document.querySelector('.ch-scroll');return e.scrollHeight-e.scrollTop-e.clientHeight})()`)
    assert.ok(gap < 110, `stream growth must stay at bottom: ${gap}`)
    await js(`document.querySelector('.ch-scroll').scrollTop = 0`)
    await until(`!!document.querySelector('[data-turn-id="large-0"]')`, 'reading history during streaming')
    emit('agent:text', {id, text: 'UNSEEN_STREAM_END'})
    await pause(300)
    assert.ok(await js(`!!document.querySelector('[data-turn-id="large-0"]')`), 'stream must not pull reader away')
    await click('.ch-pill[data-visible]')
    await until(`document.querySelector('.ch-scroll').textContent.includes('UNSEEN_STREAM_END')`, 'jump to latest')
    emit('agent:done', {id}); pending.delete(id)
    await until(idle, 'large chat run finished')
    assert.ok(await js(`document.querySelectorAll('.ch-list-row').length < 60`))
  })
  assert.deepEqual(errors, [], 'Renderer console errors')
  const report = { performanceChecks, passed: checks.length, failed: 0, checks, screenshots, requests: requests.map(r => ({ channel: r.channel, profileId: r.payload.profileId || r.payload.selection?.profileId })), errors }
  fs.writeFileSync(path.join(qa, 'agents-ui-smoke.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}

// Keep the application alive across the deliberate close/reopen check.
app.on('window-all-closed', () => {})
const watchdog = setTimeout(() => { console.error('UI smoke exceeded 120 seconds'); app.exit(1) }, 120000)
run().then(() => finish(0), error => {
  console.error(error)
  fs.mkdirSync(qa, { recursive: true })
  fs.writeFileSync(path.join(qa, 'agents-ui-smoke.json'), JSON.stringify({ passed: checks.length, failed: 1, checks, screenshots, errors, failure: error.stack }, null, 2))
  finish(1)
})
function finish(code) {
  clearTimeout(watchdog)
  if (win && !win.isDestroyed()) win.destroy()
  app.exit(code)
}
