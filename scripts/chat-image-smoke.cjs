// Isolated real Electron preview: real temporary PNG bytes, no accounts or provider calls.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const ROOT = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-chat-image-'))
  const env = { ...process.env, PRISM_CHAT_IMAGE_QA: temp }; delete env.ELECTRON_RUN_AS_NODE
  let result
  try { result = spawnSync(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true, timeout: 120000 }) }
  finally {
    const target = path.resolve(temp)
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('prism-chat-image-'))
    fs.rmSync(target, { recursive: true, force: true })
  }
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
const { app, BrowserWindow, ipcMain } = require('electron')
const { buildSync } = require('esbuild')
const http = require('node:http')
const temp = process.env.PRISM_CHAT_IMAGE_QA
app.setPath('userData', path.join(temp, 'profile'))
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const local = path.join(temp, 'modal preview.png')
fs.writeFileSync(local, image)
const calls = []
ipcMain.handle('qa:image', async (_event, remoteId, target) => {
  calls.push({ remoteId, target })
  if (remoteId) { assert.equal(remoteId, 'ssh-test'); assert.equal(target, '/srv/project/modal.png'); return image.toString('base64') }
  assert.ok(path.resolve(target).startsWith(path.resolve(temp) + path.sep))
  if (!fs.existsSync(target)) return { error: 'missing test fixture' }
  return fs.readFileSync(target).toString('base64')
})
const preload = path.join(temp, 'preload.cjs')
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');const read=(id,p)=>ipcRenderer.invoke('qa:image',id,p).then(value=>{if(value&&value.error)throw new Error(value.error);return value});contextBridge.exposeInMainWorld('prism',{fs:{readFileBytes:p=>read(null,p)},ssh:{fs:{readFileBytes:(id,p)=>read(id,p)}}});`)
let window
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'image/png'); res.end(image) })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const js = source => window.webContents.executeJavaScript(source, true)
async function until(source, label) {
  for (let i = 0; i < 100; i++) { if (await js(source)) return; await pause(30) }
  throw new Error(`Timeout: ${label}`)
}
app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://localhost:${server.address().port}/preview.png`
  const markdown = ['![Relative](./modal%20preview.png)', `![Absolute](${encodeURI(local.replace(/\\/g, '/'))})`, `![File](${pathToFileURL(local).href})`, `![Remote](${url})`, '![Missing](./missing.png)'].join('\n\n')
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{ChatImage}from'./src/renderer/src/components/chat/ChatImage';import{MarkdownContent}from'./src/renderer/src/components/chat/MarkdownContent';import{RemoteImage,RemoteContext}from'./src/renderer/src/remote/Controls';import './src/renderer/src/styles/chat.css';
  const route={cwd:${JSON.stringify(temp)}};const Image=props=><ChatImage {...props} route={route}/>;
  const remote={request:async(action,payload)=>{window.mobileImageRequests.push({action,payload});return{url:${JSON.stringify(`data:image/png;base64,${image.toString('base64')}`)}}},command:()=>{}};window.mobileImageRequests=[];
  createRoot(document.getElementById('root')).render(<><MarkdownContent text={${JSON.stringify(markdown)}} Image={Image} openLink={()=>{}} CodeBlock={({code})=><pre>{code}</pre>}/><section id="ssh"><ChatImage src="./modal.png" alt="SSH" route={{cwd:'/srv/project',remoteId:'ssh-test',remoteReady:true}}/></section><section id="disconnected"><ChatImage src="./modal.png" alt="Disconnected" route={{cwd:'/srv/project',remoteId:'ssh-wrong',remoteReady:false}}/></section><RemoteContext.Provider value={remote}><section id="mobile"><RemoteImage src="./modal%20preview.png" alt="Mobile"/></section><section id="mobile-malformed"><RemoteImage src="bad%XX.png" alt="Malformed"/></section></RemoteContext.Provider></>);`
  const result = buildSync({ absWorkingDir: ROOT, stdin: { contents: entry, resolveDir: ROOT, loader: 'tsx' }, bundle: true, write: false, outfile: 'qa.js', jsx: 'automatic', platform: 'browser' })
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text.replace(/<\/script/gi, '<\\/script')
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text || ''
  const productionHtml = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8')
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/m.exec(productionHtml)?.[1]
  assert.ok(csp)
  const page = path.join(temp, 'index.html')
  fs.writeFileSync(page, `<html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css}</style></head><body><div id="root"></div><script>${script}</script></body></html>`)
  window = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { preload, offscreen: true, contextIsolation: true, nodeIntegration: false, sandbox: false } })
  const errors = []
  window.webContents.on('console-message', event => { if (event.level === 'error' && !event.message.includes('ERR_FILE_NOT_FOUND')) errors.push(event.message) })
  await window.loadFile(page)
  await until('document.querySelectorAll(".ch-markdown-image img").length===5 && [...document.querySelectorAll(".ch-markdown-image img")].every(image=>image.complete&&image.naturalWidth===1)', 'local/absolute/file/HTTP/SSH image pixels')
  await until('document.body.textContent.includes("não existe ou não está acessível") && document.querySelector("#disconnected").textContent.includes("Reconecte")', 'missing image and disconnected SSH fallback')
  await until('document.querySelector("#mobile img")?.naturalWidth===1 && document.querySelector("#mobile-malformed").textContent.includes("não é válido")', 'mobile image and malformed address fallback')
  assert.deepEqual(await js('window.mobileImageRequests'), [{ action: 'image', payload: { path: './modal%20preview.png' } }], 'mobile grants receive the original encoded reference')
  assert.equal(calls.filter(call => call.remoteId === 'ssh-test').length, 1)
  assert.equal(calls.some(call => call.remoteId === 'ssh-wrong'), false)
  await js('document.querySelector(".ch-markdown-image-button").click()')
  await until('!!document.querySelector("dialog[open] img")', 'image lightbox')
  await js('document.querySelector("dialog[open] button").click()')
  await until('!document.querySelector("dialog[open]")', 'close lightbox')
  assert.deepEqual(errors, [])
  console.log('Chat image QA passed: local relative/absolute/file URLs and HTTP load real pixels; SSH uses owning route; mobile preserves encoded grants; missing/disconnected/malformed image errors remain visible; lightbox opens and closes.')
}).then(() => { window?.destroy(); server.close(); app.quit() }, error => { console.error(error); window?.destroy(); server.close(); app.exit(1) })
