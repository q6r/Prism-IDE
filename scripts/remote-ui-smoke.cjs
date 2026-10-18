// Real browser, real same-origin WebSockets, isolated mock chats. No real accounts/tunnel.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-remote-ui-'))
  const env = { ...process.env, PRISM_REMOTE_QA: temp }; delete env.ELECTRON_RUN_AS_NODE
  let result
  try { result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 120000 }) }
  finally { const resolved = path.resolve(temp); if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('prism-remote-ui-')) fs.rmSync(resolved, { recursive: true, force: true }) }
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const { WebSocketServer } = require('ws')
app.setPath('userData', process.env.PRISM_REMOTE_QA)
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const root = path.resolve(__dirname, '..')
const page = fs.readFileSync(path.join(root, 'host/crates/prism-host/src/domains/remote/page.html'))
const output = path.join(root, 'out/qa/remote'); fs.mkdirSync(output, { recursive: true })
const chats = [{ tabId: 'a', title: 'Ajustar o seletor de modelos', token: 'token-a' }, { tabId: 'b', title: 'Revisar as mudanças', token: 'token-b' }]
const states = {
  a: { tabId: 'a', title: chats[0].title, streaming: false, contextPct: 0, turns: [
    { id: 'u1', role: 'user', text: 'Deixa o controle remoto com a aparência do chat.' },
    { id: 'a1', role: 'assistant', text: '', segments: [
      { kind: 'thinking', text: 'Vou reutilizar os estilos e o renderizador do chat.' },
      { kind: 'tool', name: 'Edit', status: 'done', preview: 'src/components/ModelPicker.tsx' },
      { kind: 'text', text: 'O controle remoto agora usa a **mesma formatação** do chat.\n\n- Troque de conversa pelo menu\n- Continue na mesma guia\n\n```ts\nconst chat = selectedConversation\nconsole.log(chat.title)\n```\n\n| Recurso | Estado |\n| --- | --- |\n| Markdown | Pronto |\n| Conversas | Pronto |\n\n[Documentação](https://example.invalid)\n\n<script>window.remoteXss=true</script>\n[perigoso](javascript:alert(1))' }
    ] }
  ] },
  b: { tabId: 'b', title: chats[1].title, streaming: true, contextPct: 0, turns: [{ id: 'b1', role: 'assistant', text: '', segments: [{ kind: 'text', text: 'Revisei os arquivos. Posso executar o teste?' }], pendingPerm: { permId: 'p1', title: 'Executar npm test', toolName: 'Bash', preview: 'npm test' } }] }
}
const selection = { provider: 'codex', profileId: 'ambient-codex', model: 'model-a', effort: 'high', permissionMode: 'default' }
states.a.selection = { ...selection }; states.b.selection = { ...selection }
states.a.queued = []; states.b.queued = []
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='
states.a.turns[0].images = [{ mime: 'image/png', data: pixel.split(',')[1], name: 'primeira.png', number: 1 }]
states.a.turns[1].segments.push({ kind: 'text', text: '![Preview](out/preview.png)' })
const nativeChild = { id: 'native-audit', chatId: 'child-without-a-grant', name: 'Auditar API', status: 'running', startedAt: Date.now() - 1000, updatedAt: Date.now(), description: 'Revisar os endpoints.', activity: 'Lendo os arquivos de API.' }
states.a.turns[1].segments.push({ kind: 'tool', name: 'Agent', status: 'done', subagent: nativeChild })
const commands = [], connections = [], failures = []
const peers = new Map()
let rejectNextQueueSend = false
let queueAddDelay = 60
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page) })
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const row = chats.find(c => c.token === new URL(req.url, 'http://localhost').searchParams.get('t'))
  if (!row) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
  wss.handleUpgrade(req, socket, head, ws => {
    peers.set(row.tabId, ws)
    connections.push(row.tabId)
    ws.send(JSON.stringify({ t: 'chats', chats: [{ ...row, token: undefined }] }))
    ws.send(JSON.stringify({ t: 'state', chat: states[row.tabId] }))
    ws.on('message', data => {
      const m = JSON.parse(String(data)); if (m.t === 'ping') { ws.send('{"t":"pong"}'); return }
      commands.push(m)
      if (m.tabId !== row.tabId) { ws.send(JSON.stringify({ t: 'ack', stage: 'pc', action: m.action, ok: false, reason: 'forbidden' })); return }
      ws.send(JSON.stringify({ t: 'ack', stage: 'pc', action: m.action, requestId: m.requestId, ok: true }))
      setTimeout(() => {
        const reject = m.payload?.text === 'recusar' || m.action === 'queue' && m.payload.operation === 'send' && rejectNextQueueSend
        if (reject && m.action === 'queue') rejectNextQueueSend = false
        let data
        if (m.action === 'models') data = [{ id: 'model-a', label: 'Model A', efforts: ['low', 'high'], defaultEffort: 'high' }, { id: 'model-b', label: 'Model B', efforts: ['low', 'high'], defaultEffort: 'high' }]
        if (m.action === 'configure') Object.assign(states[row.tabId].selection, m.payload.selection)
        if (m.action === 'image') data = { url: pixel, path: m.payload.path }
        if (m.action === 'changes') data = [{ path: 'src/changed.ts' }]
        if (m.action === 'file') data = { path: 'src/changed.ts', content: Array.from({length: 1200}, (_, i) => 'line-' + i).join('\n'), diff: '-before\n+after' }
        if (!reject && m.action === 'queue') {
          const q = states[row.tabId].queued, p = m.payload
          if (p.operation === 'add') { const item = { ...p.message, id: p.message.id || 'queued-' + commands.length }; if (!q.some(row => row.id === item.id)) q.push(item); data = { id: item.id } }
          if (p.operation === 'send') { const item = q.find(item => item.id === p.id); if (item) { if (states[row.tabId].streaming) states[row.tabId].turns.at(-1).segments.push({ kind: 'user', text: item.text }); else states[row.tabId].turns.push({ id: 'sent-' + commands.length, role: 'user', text: item.text }) } }
          if (p.operation === 'send' || p.operation === 'remove') states[row.tabId].queued = q.filter(item => item.id !== p.id)
          if (p.operation === 'replace') states[row.tabId].queued = q.map(item => item.id === p.id ? { ...item, ...p.message } : item)
          if (p.operation === 'pause') states[row.tabId].queuePaused = p.paused
        }
        if (!reject && m.action === 'send') { if (states[row.tabId].streaming) states[row.tabId].queued.push({ id: 'queued-' + commands.length, text: m.payload.text }); else states[row.tabId].turns.push({ id: 'sent-' + commands.length, role: 'user', text: m.payload.text }) }
        if (!reject && m.action === 'stop') states[row.tabId].streaming = false
        if (!reject && m.action === 'perm') delete states[row.tabId].turns.at(-1).pendingPerm
        if (!reject && m.action === 'question') delete states[row.tabId].turns.at(-1).pendingQuestion
        ws.send(JSON.stringify({ t: 'ack', stage: 'done', action: m.action, data, requestId: m.requestId, ok: !reject, reason: reject ? 'blocked' : '' }))
        ws.send(JSON.stringify({ t: 'state', chat: states[row.tabId] }))
      }, m.action === 'queue' && m.payload.operation === 'add' ? queueAddDelay : 60)
    })
  })
})
let window
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = async code => { try { return await window.webContents.executeJavaScript(code, true) } catch(error) { console.error('Failed browser check:', code, failures); throw error } }
async function until(code, label) { for (let i = 0; i < 100; i++) { if (await js(code)) return; await wait(30) } console.error('Browser errors:', failures); console.error('Screen:', await js('document.body.innerText')); throw new Error('Timeout: ' + label) }
async function click(selector) { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await wait(80) }
async function type(text) { await js(`(() => { const e=document.querySelector('#message'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`); await wait(60) }
async function shot(name) { console.log('shot', name); await js('document.fonts.ready'); await wait(350); await window.webContents.capturePage(undefined, { stayHidden: true }); await wait(80); const png = await window.webContents.capturePage(undefined, { stayHidden: true }); fs.writeFileSync(path.join(output, name + '.png'), png.toPNG()) }
async function layout() {
  const metrics = await js(`({ width:innerWidth, scroll:document.documentElement.scrollWidth, size:getComputedStyle(document.querySelector('#message')).fontSize, buttons:[...document.querySelectorAll('.rm-header button,.rm-composer button,.ch-code-copy')].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})), bottom:document.querySelector('.rm-composer').getBoundingClientRect().bottom, height:innerHeight })`)
  assert.ok(metrics.scroll <= metrics.width, JSON.stringify(metrics))
  assert.equal(metrics.size, '16px')
  assert.ok(metrics.buttons.every(b => b.width >= 44 && b.height >= 44), JSON.stringify(metrics))
  assert.ok(metrics.bottom <= metrics.height + 1)
}
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/`
  const fragment = new URLSearchParams({ t: chats[0].token, c: 'a', sessions: JSON.stringify(chats), theme: 'prism-dark' })
  window = new BrowserWindow({ show: false, frame: false, width: 375, height: 812, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false, nodeIntegration: false, contextIsolation: true } })
  window.webContents.on('console-message', e => { if (e.level === 'error') failures.push(e.message) })
  window.webContents.debugger.attach('1.3');
  window.webContents.debugger.on('message', (_e, method, params) => { if (method === 'Runtime.exceptionThrown') console.error(params.exceptionDetails.exception?.description) });
  await window.loadURL(base + '#' + fragment)
  await until('document.querySelector(".ch-md table") && document.querySelector(".ch-code")', 'Markdown')
  await until('!!document.querySelector(".rm-subagent[data-status=running]")', 'native subagent live after parent completion')
  assert.equal(await js('document.querySelector(".rm-subagent summary").textContent.includes("Lendo os arquivos de API")'), true)
  await click('.rm-subagent summary')
  assert.equal(await js('document.querySelector(".rm-subagent").open'), true)
  assert.equal(await js('document.querySelector(".rm-subagent-detail").textContent.includes("Revisar os endpoints")'), true)
  assert.equal(await js('document.querySelectorAll(".rm-subagent a, .rm-subagent button").length'), 0, 'parent grant does not create child access')
  nativeChild.status = 'completed'; nativeChild.summary = 'Auditoria concluída.'; nativeChild.updatedAt = Date.now()
  peers.get('a').send(JSON.stringify({ t: 'state', chat: states.a }))
  await until('!!document.querySelector(".rm-subagent[data-status=completed]")', 'native child completion streams to phone')
  await click('.rm-subagent summary')
  assert.equal(await js('document.querySelector(".rm-subagent summary").textContent.includes("Auditoria concluída")'), true)
  assert.equal(await js('!!window.remoteXss'), false)
  assert.equal(await js('[...document.querySelectorAll("a")].some(a=>a.href.startsWith("javascript:"))'), false)
  const viewport = await js('document.querySelector("meta[name=viewport]").content')
  assert.ok(!/user-scalable=no|maximum-scale|minimum-scale/.test(viewport))
  await until('document.querySelector(".rm-image img")?.complete', 'generated image')
  assert.equal(await js('document.querySelector(".rm-numbered-image .ch-image-number").textContent'), '#image 1')
  await click('.rm-image'); assert.equal(await js('document.querySelector(".rm-image-dialog").open'), true); await click('[aria-label="Fechar imagem"]')
  await click('.rm-files summary'); await until('document.querySelector(".rm-files button")', 'changed files'); await click('.rm-files button')
  await until('document.querySelector(".rm-files").textContent.includes("line-1199")', 'full file without preview cutoff')
  await click('.rm-files summary')
  await layout(); await shot('phone-375')
  await type('rascunho da primeira conversa')
  await click('[aria-label="Trocar conversa"]'); await shot('conversations')
  await click('.rm-chat-item:nth-child(2)')
  await until('document.querySelector(".rm-card")', 'second chat permission')
  assert.equal(await js('document.querySelector("#message").value'), '')
  await click('.rm-controls summary')
  await until('document.querySelectorAll(".rm-controls select:first-of-type option").length >= 3', 'models during active turn')
  await js(`(() => { const e = document.querySelector('.rm-controls select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'model-b'); e.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await until('document.querySelector(".rm-controls summary").textContent.includes("Model B")', 'model accepted while busy')
  await js(`(() => { const e = document.querySelectorAll('.rm-controls select')[1]; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'acceptEdits'); e.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  await until('document.querySelector(".rm-controls summary").textContent.includes("Aceitar edições")', 'mode accepted while busy')
  await click('.rm-controls summary')
  await type('mensagem na fila'); await click('[aria-label="Adicionar à fila"]')
  await until('document.querySelector(".rm-queue-item") && document.querySelector("#message").value === ""', 'queue confirmed by computer')
  await shot('queue-and-controls')
  await type('rascunho da segunda conversa')
  await click('.rm-card .rm-primary'); await until('!document.querySelector(".rm-card")', 'approve')
  assert.equal(commands.at(-1).tabId, 'b'); assert.equal(commands.at(-1).action, 'perm')
  await click('[aria-label="Enviar mensagem da fila agora"]'); await until('!document.querySelector(".rm-queue-item")', 'send queued entry now')
  assert.equal(commands.at(-1).action, 'queue'); assert.equal(commands.at(-1).payload.operation, 'send')
  await click('[aria-label="Parar o agente"]'); await until('!document.querySelector(".rm-stop")', 'stop')
  assert.equal(commands.at(-1).tabId, 'b'); assert.equal(commands.at(-1).action, 'stop')
  await click('[aria-label="Trocar conversa"]'); await click('.rm-chat-item:nth-child(1)')
  await until('document.querySelector(".rm-heading h1").textContent.includes("seletor")', 'switch back')
  assert.equal(await js('document.querySelector("#message").value'), 'rascunho da primeira conversa')
  await type('recusar'); await click('[aria-label="Enviar mensagem"]'); await wait(180)
  assert.equal(await js('document.querySelector("#message").value'), 'recusar', 'rejected send keeps draft')
  await type('envio confirmado'); await click('[aria-label="Enviar mensagem"]'); await until('document.querySelector("#message").value === ""', 'ack clears confirmed send')
  assert.equal(commands.at(-1).tabId, 'a')
  assert.deepEqual(connections.slice(0, 3), ['a', 'b', 'a'])
  states.a.turns.push({ id: 'async-idle', role: 'assistant', text: '', segments: [{ kind: 'text', toolId: 'async-idle-call', text: 'Qual uso está sem cálculo?', questions: [{ title: 'Qual uso está sem cálculo?', options: ['Tokens/contexto', 'Limites da conta', 'Os dois'] }, { title: 'Detalhes' }] }] })
  peers.get('a').send(JSON.stringify({ t: 'state', chat: states.a }))
  await until('document.querySelector(".rm-async-question")', 'idle async question card')
  await type('rascunho preservado durante a resposta')
  await click('.rm-async-question input[type="radio"]')
  await js(`(() => { const e = document.querySelectorAll('.rm-async-question input[type="text"]')[1]; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Quero comparar os dois'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`)
  await shot('async-questions')
  await click('.rm-async-question .rm-primary')
  await until('!document.querySelector(".rm-async-question")', 'idle async answer acknowledged')
  assert.equal(commands.at(-1).action, 'send'); assert.ok(commands.at(-1).payload.text.includes('Tokens/contexto')); assert.ok(commands.at(-1).payload.text.includes('Quero comparar os dois'))
  assert.equal(await js('document.querySelector("#message").value'), 'rascunho preservado durante a resposta')
  states.a.streaming = true
  states.a.turns.push({ id: 'async-busy', role: 'assistant', text: '', segments: [{ kind: 'text', toolId: 'async-busy-call', text: 'Escolha a prioridade', questions: [{ title: 'Escolha a prioridade', options: ['Desempenho', 'Imagens'] }] }], pendingQuestion: { dialogId: 'native-before-async', questions: [{ question: 'Continuar?', header: 'Confirmar', multiSelect: false, options: [{ label: 'Sim', description: '' }] }] } })
  peers.get('a').send(JSON.stringify({ t: 'state', chat: states.a }))
  await until('document.querySelector(".rm-card[aria-label=\\"Responder ao agente\\"]")', 'native question has priority')
  assert.equal(await js('!!document.querySelector(".rm-async-question")'), false)
  await click('.rm-card[aria-label="Responder ao agente"] input[type="radio"]'); await click('.rm-card[aria-label="Responder ao agente"] .rm-primary')
  await until('document.querySelector(".rm-async-question")', 'async card after native question')
  assert.equal(commands.at(-1).action, 'question')
  await click('.rm-async-question input[type="radio"]')
  const beforeAsyncQueue = commands.length
  rejectNextQueueSend = true
  await click('.rm-async-question .rm-primary')
  await until('document.querySelector(".rm-async-question [role=alert]") && document.querySelector(".rm-queue-item")', 'failed immediate send retains queued answer')
  assert.equal(await js('document.querySelector("#message").value'), 'rascunho preservado durante a resposta')
  await click('.rm-async-question .rm-primary')
  await until('!document.querySelector(".rm-async-question") && !document.querySelector(".rm-queue-item")', 'queued async retry acknowledged')
  const asyncCommands = commands.slice(beforeAsyncQueue)
  assert.deepEqual(asyncCommands.map(command => [command.action, command.payload.operation]), [['queue','add'],['queue','send'],['queue','send']])
  assert.equal(asyncCommands.filter(command => command.payload.operation === 'add').length, 1, 'retry reuses the existing answer row')
  assert.ok(asyncCommands[0].payload.message.text.includes('Desempenho'))
  assert.equal(await js('document.querySelector("#message").value'), 'rascunho preservado durante a resposta')
  await click('[aria-label="Parar o agente"]'); await until('!document.querySelector(".rm-stop")', 'async fixture finished')
  states.a.streaming = true
  states.a.turns.push({ id: 'async-scope', role: 'assistant', text: '', segments: [{ kind: 'text', toolId: 'async-scope-call', questions: [{ title: 'Conversa original?', options: ['Continuar aqui'] }] }] })
  peers.get('a').send(JSON.stringify({ t: 'state', chat: states.a }))
  await until('document.querySelector(".rm-async-question")', 'async scope fixture')
  await click('.rm-async-question input[type="radio"]')
  queueAddDelay = 350
  const beforeScope = commands.length
  await click('.rm-async-question .rm-primary')
  await click('[aria-label="Trocar conversa"]'); await click('.rm-chat-item:nth-child(2)')
  await wait(450)
  assert.ok(states.a.queued.some(row => row.text.includes('Continuar aqui')), 'the accepted answer remains in the original chat')
  assert.equal(commands.slice(beforeScope).some(command => command.action === 'queue' && command.tabId !== 'a'), false, 'switching cannot redirect an answer into another chat')
  queueAddDelay = 60
  await click('[aria-label="Trocar conversa"]'); await click('.rm-chat-item:nth-child(1)')
  await until('document.querySelector(".rm-async-question") && document.querySelector(".rm-queue-item")', 'original question and queue restore after switch')
  await click('.rm-async-question input[type="radio"]'); await click('.rm-async-question .rm-primary')
  await until('!document.querySelector(".rm-async-question") && !document.querySelector(".rm-queue-item")', 'retry sends only the original accepted row')
  assert.equal(await js('document.querySelector("#message").value'), 'rascunho preservado durante a resposta')
  await click('[aria-label="Parar o agente"]'); await until('!document.querySelector(".rm-stop")', 'scope fixture finished')
  for (const [name, width, height] of [['phone-390', 390, 844], ['landscape', 812, 375], ['tablet', 768, 1024], ['keyboard', 390, 450]]) {
    window.setContentSize(width, height); await wait(160); await layout(); await shot(name)
  }
  window.setContentSize(375, 812); await wait(160)
  await js('document.documentElement.dataset.theme="prism-light-pink";document.documentElement.dataset.appearance="light"')
  await shot('phone-light')
  await js('document.documentElement.style.fontSize="24px"')
  await layout(); await shot('phone-large-text')
  await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await js('matchMedia("(prefers-reduced-motion: reduce)").matches'), true); window.webContents.debugger.detach()
  assert.deepEqual(failures, [])
  console.log('Remote mobile QA passed: two chats, preserved drafts, safe Markdown, reject/confirm send, approve/stop, 375/390/tablet/landscape/keyboard/light/large text, 44px targets, 16px inputs and accessible zoom.')
}).then(() => { window?.destroy(); wss.close(); server.close(); app.quit() }, err => { console.error(err); window?.destroy(); wss.close(); server.close(); app.exit(1) })
