// Real TerminalPane -> IPC -> ConPTY -> PowerShell -> foreground process.
// Isolated profile and shell; no provider CLI, host or user's terminals.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const root = path.resolve(__dirname, '..')
if (!process.versions.electron) {
  if (process.platform !== 'win32') { console.log('Windows ConPTY smoke: skipped on this platform'); process.exit(0) }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-terminal-interrupt-'))
  const env = { ...process.env, PRISM_TERMINAL_QA: temporary }; delete env.ELECTRON_RUN_AS_NODE
  let run
  try {
    run = require('node:child_process').spawnSync(require('electron'), [__filename], { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 60000 })
  } finally {
    const resolved = path.resolve(temporary)
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('prism-terminal-interrupt-')) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  if (run.error) throw run.error
  process.exit(run.status ?? 1)
}
const { app, BrowserWindow, ipcMain } = require('electron')
const { build } = require('esbuild')
const temp = process.env.PRISM_TERMINAL_QA
app.setPath('userData', temp)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const pty = require('@homebridge/node-pty-prebuilt-multiarch')
const realSpawn = pty.spawn.bind(pty)
const processes = [], exited = new Set(), writes = [], output = []
// Exercise the actual fallback handlers; observe rather than replace transport.
require('../tests/helpers/load-typescript.cjs')('src/main/ipc/terminal.ts', {
  electron: { ipcMain }, fs, os,
  '@homebridge/node-pty-prebuilt-multiarch': { spawn(...args) {
    args[1] = ['-NoProfile']
    const proc = realSpawn(...args)
    processes.push(proc)
    proc.onData(data => output.push(data))
    proc.onExit(() => exited.add(proc))
    return proc
  } }
}).registerTerminalHandlers()
ipcMain.on('terminal:input', (_, payload) => writes.push(payload.data))
const preload = path.join(temp, 'preload.cjs')
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');
const on=(name,cb)=>{const listener=(_,value)=>cb(value);ipcRenderer.on(name,listener);return()=>ipcRenderer.removeListener(name,listener)};
contextBridge.exposeInMainWorld('prism',{terminal:{create:opts=>{ipcRenderer.send('terminal:create',opts);return Promise.resolve({ok:true,persistent:false})},input:opts=>ipcRenderer.send('terminal:input',opts),resize:opts=>ipcRenderer.send('terminal:resize',opts),kill:id=>ipcRenderer.send('terminal:kill',{id}),onData:cb=>on('terminal:data',cb),onExit:cb=>on('terminal:exit',cb)}});`)
async function createPage() {
const bundle = (await build({ absWorkingDir: root, stdin: { resolveDir: root, loader: 'tsx', contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {Terminal} from '@xterm/xterm';import TerminalPane from './src/renderer/src/components/terminal/TerminalPane';
const open=Terminal.prototype.open;Terminal.prototype.open=function(...args){window.qaTerm=this;return open.apply(this,args)};
window.qaCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.qaCopies.push(value)},readText:async()=>''}});
const root=createRoot(document.getElementById('root'));window.qaUnmount=()=>root.unmount();
root.render(<TerminalPane paneId="interrupt-smoke" remoteId={null} active visible onFocus={()=>{}} onClose={()=>{window.qaClosed=true}} onTitle={()=>{}} onContextMenu={()=>{}} registerApi={api=>{window.qaApi=api}}/>);` },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'isolated-terminal-state', setup(build) {
    build.onResolve({filter:/^\.\.\/\.\.\/store$/}, () => ({path:'store',namespace:'terminal-qa'}))
    build.onResolve({filter:/^\.\.\/ui$/}, args => args.importer.endsWith('TerminalPane.tsx') ? {path:'ui',namespace:'terminal-qa'} : undefined)
    build.onLoad({filter:/.*/,namespace:'terminal-qa'}, args => ({loader:'tsx',resolveDir:root,contents:args.path==='store'
      ? 'const state={folderPath:null,settings:{fontSize:14}};export const useStore=Object.assign(selector=>selector(state),{getState:()=>state});'
      : `import React from 'react';export const Spinner=()=>null;export const Button=({children,variant,size,...props})=><button {...props}>{children}</button>;`}))
  } }]
})).outputFiles[0].text
const page = path.join(temp, 'index.html')
fs.writeFileSync(page, `<html><head><style>${fs.readFileSync(path.join(root,'node_modules/@xterm/xterm/css/xterm.css'),'utf8')}body{margin:0}.prism-terminal-xterm{height:420px;width:800px}</style></head><body><div id="root"></div><script>${bundle.replace(/<\/script/gi,'<\\/script')}</script></body></html>`)
return page
}
let win
const js = code => win.webContents.executeJavaScript(code, true)
async function until(check, label, timeout = 10000) {
  const start = Date.now()
  while (Date.now()-start < timeout) { if (await check()) return; await pause(30) }
  throw new Error(`Timeout: ${label}\n${output.join('').slice(-2000)}`)
}
function plain() { return output.join('').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'') }
async function key(shift = false) {
  await js('qaTerm.focus()')
  win.webContents.focus()
  const modifiers = shift ? ['control','shift'] : ['control']
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'C',modifiers})
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'C',modifiers})
  await pause(100)
}
app.whenReady().then(async () => {
  win = new BrowserWindow({show:false,frame:false,width:840,height:500,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:false,offscreen:true,backgroundThrottling:false}})
  await win.loadFile(await createPage())
  await until(()=>js('!!window.qaApi && !document.querySelector(".prism-terminal-overlay")'),'terminal ready')
  const command = `node -e "console.log('QA_FOREGROUND_READY');process.on('SIGINT',()=>{console.log('QA_SIGINT_RECEIVED');process.exit(0)});setInterval(()=>{},1000)"\r`
  async function start() {
    output.length=0
    await js(`qaApi.input(${JSON.stringify(command)})`)
    await until(()=>/\nQA_FOREGROUND_READY\r?\n/.test(plain()),'foreground Node process started')
  }
  async function interrupt(label) {
    const count = writes.filter(data=>data==='\x03').length
    await key()
    await until(()=>/\nQA_SIGINT_RECEIVED\r?\n/.test(plain()),`${label}: SIGINT reached the process`)
    assert.equal(writes.filter(data=>data==='\x03').length,count+1,'one Ctrl+C sends exactly one ETX')
    assert.equal(await js('qaTerm.hasSelection()'),false,'interrupt clears the terminal selection')
    await until(()=>/PS [^\r\n]*> ?$/.test(plain().trimEnd()),'same PowerShell prompt returns')
    await js(`qaApi.input("Write-Output ('QA_SHELL_' + 'STILL_ALIVE')\\r")`)
    await until(()=>/\nQA_SHELL_STILL_ALIVE\r?\n/.test(plain()),'shell accepts another command after interrupt')
    assert.equal(await js('!!window.qaClosed'),false,'interrupt keeps the terminal open')
  }
  await start()
  await interrupt('no selection')
  await start()
  await js('qaTerm.selectAll()')
  assert.equal(await js('qaTerm.hasSelection()'),true)
  const count = writes.length
  await key(true)
  await until(()=>js('qaCopies.length === 1'),'Ctrl+Shift+C copies selected output')
  assert.equal(writes.length,count,'copy never sends an interrupt')
  await interrupt('with selected output')
  console.log('Terminal interruption passed: real TerminalPane + IPC + PowerShell + Node SIGINT, with/without selection; Ctrl+Shift+C copies; same shell remains usable.')
}).then(async()=>{
  await js('qaApi.input("exit\\r")')
  await until(()=>js('!!window.qaClosed'),'isolated PowerShell exits')
  await js('qaUnmount()'); await pause(100); win.destroy();app.quit()
},async err=>{
  console.error(err)
  for(const proc of processes) if(!exited.has(proc)) {try{proc.write('\x03')}catch{}}
  await pause(150)
  for(const proc of processes) if(!exited.has(proc)) {try{proc.write('exit\r')}catch{}}
  await pause(500)
  for(const proc of processes) if(!exited.has(proc)) {try{proc.kill()}catch{}}
  win?.destroy();app.exit(1)
})
