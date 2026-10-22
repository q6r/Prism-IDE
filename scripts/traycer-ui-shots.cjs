// Visual QA for the Traycer-parity UI. Run after `npm run build`:
//   node scripts/traycer-ui-shots.cjs [scene ...]
// Loads the built renderer + real preload against a mock main process (no
// network, no CLIs, no credentials) and writes PNGs to out/qa/traycer/.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-traycer-shots-'))
  const env = { ...process.env, PRISM_QA_USER_DATA: temporary }; delete env.ELECTRON_RUN_AS_NODE
  let code = 1
  try {
    const run = spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true, timeout: 180000 })
    if (run.error) throw run.error
    code = run.status ?? 1
  } finally {
    const resolved = path.resolve(temporary)
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('prism-traycer-shots-')) fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  process.exit(code)
}

const { app, BrowserWindow, ipcMain, session } = require('electron')
const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'out', 'qa', 'traycer')
fs.mkdirSync(outDir, { recursive: true })
app.setPath('userData', process.env.PRISM_QA_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'prism-traycer-shots-')))
app.commandLine.appendSwitch('force-device-scale-factor', '1')
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.cjs'))

/* ---------------- Synthetic accounts for visual QA ---------------- */
const now = Date.now()
const profiles = [
  { id: 'ambient-claude', provider: 'claude', name: "Conta Claude", ambient: true },
  { id: 'ambient-codex', provider: 'codex', name: 'Terminal account', ambient: true },
  { id: 'claude-2', provider: 'claude', name: "Conta Claude 2", color: '#ef4444' },
  { id: 'claude-3', provider: 'claude', name: "Conta Claude 3", color: '#f97316' },
  { id: 'claude-4', provider: 'claude', name: "Conta Claude 4", color: '#f59e0b' },
  { id: 'codex-2', provider: 'codex', name: "Conta Codex 2", color: '#a16207' }
]
const sec = (ms) => Math.floor(ms / 1000)
const usage = {
  'ambient-claude': [{ id: 'five_hour', name: null, usedPercent: 0, windowMinutes: 300 }, { id: 'seven_day', name: null, usedPercent: 0, windowMinutes: 10080, resetsAt: sec(now + 3 * 86400e3) }],
  'claude-2': [{ id: 'five_hour', name: null, usedPercent: 100, windowMinutes: 300, resetsAt: sec(now + 2 * 3600e3) }, { id: 'seven_day', name: null, usedPercent: 64, windowMinutes: 10080, resetsAt: sec(now + 4 * 86400e3) }],
  'claude-3': [{ id: 'five_hour', name: null, usedPercent: 12, windowMinutes: 300, resetsAt: sec(now + 3 * 3600e3) }, { id: 'seven_day', name: null, usedPercent: 97, windowMinutes: 10080, resetsAt: sec(now + 2 * 86400e3) }],
  'claude-4': [{ id: 'five_hour', name: null, usedPercent: 2, windowMinutes: 300 }, { id: 'seven_day', name: null, usedPercent: 8, windowMinutes: 10080, resetsAt: sec(now + 5 * 86400e3) }],
  'ambient-codex': [{ id: 'codex:primary', name: null, usedPercent: 73, windowMinutes: 10080, resetsAt: sec(now + 4 * 86400e3) }],
  'codex-2': [{ id: 'codex:primary', name: null, usedPercent: 21, windowMinutes: 10080, resetsAt: sec(now + 6 * 86400e3) }]
}
const efforts5 = ['low', 'medium', 'high', 'xhigh', 'max']
const claudeModels = [
  { id: 'default', label: 'Default (Opus 5.5)', description: 'Usa o modelo padrão da conta', efforts: efforts5, default: true, fast: { id: 'fast', label: 'Fast' } },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', description: 'Mais capaz', efforts: efforts5, fast: { id: 'fast', label: 'Fast' } },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', description: 'Criativo', efforts: efforts5 },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', description: 'Equilíbrio', efforts: efforts5 },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Rápido', efforts: [] },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Anterior', efforts: efforts5 },
  { id: 'claude-opus-5', label: 'Opus 5', description: 'Anterior', efforts: efforts5 }
].map((m) => ({ provider: 'claude', defaultEffort: 'high', ...m }))
const codexModels = ['GPT-6-Luna', 'GPT-5.6-Sol', 'GPT-5.6-Terra', 'GPT-5.6-Luna', 'GPT-6-Sol'].map((label, i) => ({ provider: 'codex', id: label.toLowerCase(), label,
  description: 'Modelo Codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium', default: i === 0, fast: { id: 'priority', label: 'Fast' } }))
/* The demo project. With PRISM_QA_HOST=1 the Prism host serves fs/git from a
   real folder (materialized below, git included); otherwise IPC mocks fake it. */
const ROOT = process.env.PRISM_QA_HOST ? path.join(app.getPath('userData'), 'prism-demo') : 'C:\\QA\\prism-demo'
const chat = {
  id: 'qa-chat', title: 'Integrar modelos no Traycer', taskId: 'qa-task', cwd: ROOT, updatedAt: now,
  // PRISM_QA_LIVE (with PRISM_QA_HOST): one real, minimal Haiku turn through the host.
  selection: process.env.PRISM_QA_LIVE
    ? { provider: 'claude', profileId: 'ambient-claude', model: 'haiku', effort: 'low', permissionMode: 'default' }
    : { provider: 'claude', profileId: 'ambient-claude', model: 'claude-opus-5-5', effort: 'max', permissionMode: 'default' },
  turns: [
    { id: 'u1', role: 'user', text: 'isso aqui tá feio, deixa igual do Traycer' },
    { id: 'a1', role: 'assistant', provider: 'claude', profileName: "Conta Claude", model: 'claude-opus-5-5', startedAt: now - 64000, completedAt: now - 2000, durationMs: 62000,
      text: '', segments: [
        { kind: 'thinking', text: 'Vou comparar o seletor atual com o do Traycer.' },
        { kind: 'text', text: 'Vou revisar o **seletor de modelo** e o modal de configurações.\n\n- Trilho de provedores\n- Dropdown de perfis com uso\n\n```ts\nconst x = 1\n```' },
        { kind: 'tool', toolId: 't1', name: 'Bash', input: { command: 'npm run typecheck' }, result: 'ok', status: 'done' },
        { kind: 'tool', toolId: 't2', name: 'Edit', input: { file_path: 'src/App.tsx', old_string: 'a', new_string: 'b' }, result: 'ok', status: 'done' },
        { kind: 'text', text: 'Pronto. Build e testes passaram.' }
      ] }
  ]
}
// Opt-in local diagnosis: render a private exported chat against mock IPC.
// Only the fixture's host-independent identity is changed; no live store writes.
if (process.env.PRISM_QA_CHAT_FIXTURE) Object.assign(chat, JSON.parse(fs.readFileSync(process.env.PRISM_QA_CHAT_FIXTURE, 'utf8')), { id: 'qa-chat', taskId: 'qa-task', cwd: ROOT })
const referenceImages = [
  { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwC9rA5tayBQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXTVKEGS+bDW0AAAAASUVORK5CYII=', name: 'antes.png', number: 1 },
  { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwA9oJmtY1xQijIMLMNisswmb7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXfGkzi1VTx7wAAAAASUVORK5CYII=', name: 'depois.png', number: 2 }
]
const historyPaths = {
  output: path.join(app.getPath('userData'), 'history-fixtures', 'complete-output.log'),
  input: path.join(app.getPath('userData'), 'history-fixtures', 'complete-input.json'),
  image: path.join(app.getPath('userData'), 'history-fixtures', 'cached-tool-image.png')
}
const historyReads = []
const historyOutput = 'FULL_OUTPUT_RESTORED\n' + 'Preserved output from the original tool execution.\n'.repeat(200) + 'OUTPUT_END\n'
const historyInput = JSON.stringify({ marker: 'FULL_INPUT_RESTORED', content: 'Preserved tool input. '.repeat(200), end: 'INPUT_END' }, null, 2)
if (wanted.includes('history-previews')) {
  chat.turns = [
    { id: 'preview-u', role: 'user', text: 'Abra a saída e a entrada originais e a imagem preservada.' },
    { id: 'preview-a', role: 'assistant', text: '', provider: 'claude', startedAt: now - 5000, completedAt: now - 1000, segments: [
      { kind: 'tool', toolId: 'preview-tool', name: 'Bash', status: 'done',
        input: { command: 'echo preview-input' }, inputPath: historyPaths.input,
        result: 'PREVIEW_ONLY: a saída completa foi preservada.', outputPath: historyPaths.output,
        images: [{ mime: 'image/png', data: '', cachedPath: historyPaths.image, cacheKey: 'isolated-qa-cached-image', name: 'Cached QA image' }] },
      { kind: 'text', text: 'O histórico mantém prévias leves e acesso aos arquivos completos.' }
    ] }
  ]
}
if (wanted.includes('image-references')) chat.turns[0].images = referenceImages
if (wanted.includes('async-questions')) chat.turns[1].segments.push({ kind: 'text', toolId: 'async-question-item', text: 'Escolha como devo continuar.', questions: [
  { title: 'Sobre a numeração: quer referências automáticas como `#image 1` e `#image 2`?', options: ['Automaticamente', 'Só pelo menu'] },
  { title: 'Qual uso do Codex está sem cálculo?', options: ['Tokens/contexto', 'Limites da conta', 'Os dois'] }
] })
const qaChats = [chat]
if (wanted.includes('working-directory')) {
  chat.resume = { route: 'claude:ambient-claude', sessionId: 'qa-original-session' }
  qaChats.push({ ...structuredClone(chat), id: 'qa-directory-codex', title: 'Projeto Codex',
    selection: { provider: 'codex', profileId: 'ambient-codex', model: 'gpt-6-luna', effort: 'medium', permissionMode: 'default' },
    resume: { route: 'codex:ambient-codex', sessionId: 'qa-codex-session' } })
}
if (wanted.includes('subagents')) {
  const native = (id, name, status, activity, spawnToolCallId) => ({ id, chatId: `subagent:qa-chat:${id}`, name, status, activity, description: `Tarefa de ${name.toLowerCase()}.`, startedAt: now - 32000, updatedAt: now - 1000, spawnToolCallId })
  const active = native('audit', 'Auditar API', 'running', 'Lendo src/api e validando respostas.', 'spawn-native-audit')
  const done = { ...native('tests', 'Revisar testes', 'completed', 'Verificação concluída.', 'spawn-native-tests'), summary: 'Encontrei dois casos de erro sem cobertura.' }
  chat.turns = [{ id: 'qa-subagents-user', role: 'user', text: 'Delegue a auditoria e mostre o que cada agente está fazendo.' },
    { id: 'qa-subagents-parent', role: 'assistant', text: 'A auditoria continua com os agentes vinculados abaixo.', provider: 'codex', startedAt: now - 40000, completedAt: now - 500, durationMs: 39500, segments: [
      { kind: 'tool', toolId: active.spawnToolCallId, name: 'spawn_agent', input: { message: active.description }, status: 'done' },
      ...[active, done].map(subagent => ({ kind: 'tool', toolId: `subagent:${subagent.id}`, name: 'Agent', status: subagent.status === 'completed' ? 'done' : 'running', subagent }))
    ] }]
  for (const agent of [active, done]) qaChats.push({ id: agent.chatId, parentChatId: chat.id, title: agent.name, taskId: chat.taskId, cwd: ROOT, updatedAt: now - 1000, readOnly: true, selection: { ...chat.selection, provider: 'codex' },
    nativeAgent: { id: agent.id, rootChatId: chat.id, rootTurnId: 'qa-subagents-parent', status: agent.status, description: agent.description, updatedAt: agent.updatedAt },
    turns: [{ id: `subagent:qa-subagents-parent:${agent.id}`, role: 'assistant', text: agent.summary || '', provider: 'codex', startedAt: agent.startedAt, ...(agent.status === 'completed' ? { completedAt: agent.updatedAt, durationMs: agent.updatedAt - agent.startedAt } : {}) }] })
}
if (wanted.includes('codex-usage')) {
  chat.turns[1].provider = 'codex'
  chat.turns[1].metrics = { scope: 'session', inputTokens: 10000, cachedTokens: 2000, outputTokens: 3000, reasoningTokens: 500, totalTokens: 13000, contextTokens: 1400, contextWindow: 10000,
    turn: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 30, reasoningTokens: 10 } }
}
const fixtures = {
  'app:logo': '', 'app:info': { platform: 'win32', version: 'QA' }, 'app:getRecents': [], 'app:getRecentRemotes': [], 'window:is-maximized': false,
  'settings:getAll': { animations: true, notifyOnAsk: false, notifyOnDone: false, recentFolders: [ROOT], recentWorkspaces: [], theme: process.env.PRISM_QA_THEME || 'prism-dark' },
  'ext:list': [], 'claude:configured': false, 'claude:cli-available': { available: true, version: 'mock' }, 'agent:available': { available: true, version: 'mock' },
  'auth:status': { loggedIn: true, email: 'qa@example.invalid' }, 'rc:status': { enabled: false }, 'ssh:hosts:list': [], 'sessions:list': [], 'commands:list': [],
  'fs:readDir': [], 'fs:listFiles': [], 'fs:readFile': '// mock file\n', 'dialog:openFolder': null, 'dialog:openFile': null,
  'workspace:open': null, 'workspace:read': null, 'workspace:save': null, 'terminal:init': ROOT, 'terminal:setCwd': ROOT,
  'app:addRecent': [], 'app:addRecentWorkspace': [], 'app:openExternal': null, 'settings:set': true,
  'traycer:tasks': [], 'traycer:preview': { root: '', profiles: [], chats: [], warnings: [] }
}
/* A small project for the explorer, git panel, diff and terminal scenes. */
const tree = {
  [ROOT]: ['src/', 'tests/', 'scripts/', '.gitignore', 'package.json', 'README.md', 'tsconfig.json', 'vite.config.ts'],
  [`${ROOT}\\src`]: ['components/', 'lib/', 'App.tsx', 'main.tsx', 'store.ts', 'index.css'],
  [`${ROOT}\\src\\components`]: ['ModelPicker.tsx', 'Settings.tsx', 'Terminal.tsx', 'icons.svg'],
  [`${ROOT}\\src\\lib`]: ['usage.ts', 'catalog.ts'],
  [`${ROOT}\\tests`]: ['usage.test.ts'], [`${ROOT}\\scripts`]: ['build.mjs']
}
fixtures['fs:readDir'] = null
fixtures['fs:listFiles'] = null
fixtures['fs:readFile'] = null
fixtures['dialog:openFolder'] = ROOT
const original = 'import { useState } from "react"\n\nexport function counter(start: number) {\n  let value = start\n  return () => value++\n}\n\nexport const label = "Contador"\n'
const modified = 'import { useMemo, useState } from "react"\n\nexport function counter(start: number, step = 1) {\n  let value = start\n  return () => (value += step)\n}\n\nexport const label = "Contador do Prism"\nexport const max = 10\n'
const gitStatus = { isRepo: true, root: ROOT, branch: 'main', ahead: 1, behind: 0, files: [
  { path: 'src/App.tsx', x: 'M', y: ' ', staged: true, untracked: false, stagedStats: { insertions: 12, deletions: 3, binary: false } },
  { path: 'src/store.ts', x: ' ', y: 'M', staged: false, untracked: false, workingStats: { insertions: 40, deletions: 8, binary: false } },
  { path: 'src/lib/usage.ts', x: ' ', y: 'M', staged: false, untracked: false, workingStats: { insertions: 5, deletions: 1, binary: false } },
  { path: 'src/components/ModelPicker.tsx', x: '?', y: '?', staged: false, untracked: true },
  { path: 'README.md', x: ' ', y: 'D', staged: false, untracked: false, workingStats: { insertions: 0, deletions: 22, binary: false } }
] }
/* Host mode: the same project on disk, as a real repository with the same changes. */
if (process.env.PRISM_QA_HOST) {
  const { spawnSync } = require('node:child_process')
  const files = {
    '.gitignore': 'node_modules/\n', 'package.json': '{ "name": "prism-demo" }\n', 'README.md': '# Prism demo\n' + 'linha\n'.repeat(21),
    'tsconfig.json': '{}\n', 'vite.config.ts': 'export default {}\n', 'src/App.tsx': original, 'src/main.tsx': 'import "./App"\n',
    'src/store.ts': 'export const store = 1\n', 'src/index.css': 'body {}\n', 'src/lib/usage.ts': 'export const usage = 1\n',
    'src/lib/catalog.ts': 'export const catalog = []\n', 'src/components/Settings.tsx': 'export {}\n', 'src/components/Terminal.tsx': 'export {}\n',
    'src/components/icons.svg': '<svg/>\n', 'tests/usage.test.ts': 'test("usage")\n', 'scripts/build.mjs': 'console.log("build")\n'
  }
  const write = (rel, body) => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body) }
  const git = (...args) => spawnSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', ...args], { cwd: ROOT, stdio: 'ignore' })
  for (const [rel, body] of Object.entries(files)) write(rel, body)
  git('init', '-b', 'main'); git('add', '-A'); git('commit', '-m', 'Projeto inicial')
  write('src/App.tsx', modified); git('add', 'src/App.tsx')
  write('src/store.ts', 'export const store = 1\n' + 'export const extra = 2\n'.repeat(40))
  write('src/lib/usage.ts', 'export const usage = 2\n')
  write('src/components/ModelPicker.tsx', 'export function ModelPicker() {}\n')
  fs.rmSync(path.join(ROOT, 'README.md'))
}
/* Settings ▸ Uso: two weeks of turns, two providers and a Traycer import (shared/usage.ts shapes). */
function usageRecords() {
  let seed = 7
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
  const day = 86400e3
  const lanes = [
    { chatId: 'qa-chat', chatTitle: 'Integrar modelos no Traycer', taskTitle: 'Integrar Modelos no Traycer', project: 'prism-demo', provider: 'claude', model: 'claude-opus-5-5', profileId: 'ambient-claude', profileName: "Conta Claude", weight: 3 },
    { chatId: 'qa-usage', chatTitle: 'Painel de uso nas configurações', taskTitle: 'Integrar Modelos no Traycer', project: 'prism-demo', provider: 'claude', model: 'claude-sonnet-5-5', profileId: 'claude-3', profileName: "Conta Claude 3", weight: 2 },
    { chatId: 'qa-codex', chatTitle: 'Revisão do diff do terminal', taskTitle: "Projeto de demonstra??o", project: "demo-backend", provider: 'codex', model: 'gpt-6-luna', profileId: 'ambient-codex', profileName: 'Conta do terminal', weight: 2 }
  ]
  const observations = []
  for (let d = 13; d >= 0; d--) {
    for (const lane of lanes) {
      const turns = Math.round(rand() * lane.weight * (d % 7 === 5 || d % 7 === 6 ? 0.6 : 1.6))
      for (let t = 0; t < turns; t++) {
        const started = now - d * day - (9 + rand() * 9) * 3600e3, duration = (40 + rand() * 600) * 1000
        const input = Math.round(800 + rand() * 9000), cacheRead = Math.round(40000 + rand() * 180000), output = Math.round(300 + rand() * 4000)
        const claude = lane.provider === 'claude'
        observations.push({ id: `prism:${lane.chatId}:${d}-${t}`, source: 'prism', chatId: lane.chatId, turnId: `${d}-${t}`, chatTitle: lane.chatTitle, taskId: 'qa-task', taskTitle: lane.taskTitle,
          project: lane.project, provider: lane.provider, model: lane.model, profileId: lane.profileId, profileName: lane.profileName, sessionKey: `${lane.chatId}-s`,
          startedAt: started, completedAt: started + duration, durationMs: duration, outcome: rand() < 0.05 ? 'interrupted' : 'completed', prismChatId: lane.chatId,
          tokenBasis: 'turn', costBasis: claude ? 'turn' : 'none', inputTokens: input, cacheReadTokens: cacheRead, cacheWriteTokens: claude ? Math.round(rand() * 6000) : null,
          outputTokens: output, reasoningTokens: Math.round(output * 0.4), costUsd: claude ? Math.round((0.2 + rand() * (lane.model.includes('opus') ? 4 : 1.2)) * 100) / 100 : null })
      }
    }
  }
  let total = 0
  for (let d = 12; d >= 4; d--) {
    for (let t = 0; t < 3; t++) {
      total += 0.4 + rand() * 3
      // Later turns finish later, so the session's running cost only grows.
      const started = now - d * day - (14 - t * 2) * 3600e3
      observations.push({ id: `traycer:epic-qa/chat-qa:${d}-${t}`, source: 'traycer', chatId: 'epic-qa/chat-qa', turnId: `${d}-${t}`, chatTitle: "Arquitetura do servi?o", taskId: 'epic-qa', taskTitle: "Projeto de demonstra??o",
        project: "demo-backend", provider: 'claude', model: 'default', profileId: null, profileName: "Conta Claude", sessionKey: 'traycer-session', startedAt: started, completedAt: started + 300e3, durationMs: 300e3,
        outcome: 'completed', prismChatId: null, tokenBasis: 'last-call', costBasis: 'cumulative', inputTokens: 2, cacheReadTokens: Math.round(120000 + rand() * 60000), cacheWriteTokens: 2400,
        outputTokens: Math.round(200 + rand() * 900), reasoningTokens: null, costUsd: Math.round(total * 100) / 100 })
    }
  }
  const importState = { status: 'ok', at: now - 2 * 3600e3, root: 'C:\\Users\\qa\\.traycer', tasks: 1, chats: 1, turns: 27, added: 27, updated: 0, unchanged: 0, warnings: [], error: null }
  return { observations, importState, generatedAt: now }
}

const handled = new Set()
const handle = (channel, fn) => { handled.add(channel); ipcMain.handle(channel, (_e, ...args) => fn(...args)) }
const usageFixture = usageRecords()
if (wanted.includes('codex-usage')) usageFixture.observations = usageFixture.observations.filter(record => record.provider === 'codex')
handle('usage:records', () => usageFixture)
handle('usage:import-traycer', () => usageFixture.importState)
handle('usage:font-css', () => '')
for (const [channel, value] of Object.entries(fixtures)) if (value !== null) handle(channel, () => value)
handle('fs:readDir', (p) => {
  if (wanted.includes('working-directory') && p === 'C:\\QA\\missing-project') throw new Error('ENOENT: no such directory')
  return (tree[String(p).replace(/[\\/]+$/, '')] || []).map((n) => ({ name: n.replace(/\/$/, ''), path: `${String(p).replace(/[\\/]+$/, '')}\\${n.replace(/\/$/, '')}`, isDir: n.endsWith('/') }))
})
handle('fs:listFiles', () => Object.entries(tree).flatMap(([dir, names]) => names.filter((n) => !n.endsWith('/')).map((n) => ({ path: `${dir}\\${n}`, rel: `${dir.slice(ROOT.length + 1)}\\${n}`.replace(/^\\/, '') }))))
handle('fs:readFile', target => {
  if (wanted.includes('history-previews')) {
    historyReads.push({ kind: 'text', path: target })
    if (target === historyPaths.output) return historyOutput
    if (target === historyPaths.input) return historyInput
  }
  return modified
})
handle('fs:readFileBytes', target => {
  if (!wanted.includes('history-previews') || path.resolve(target) !== path.resolve(historyPaths.image)) throw new Error('Unexpected synthetic image path')
  historyReads.push({ kind: 'image', path: path.resolve(target) })
  return referenceImages[0].data
})
handle('git:status', () => gitStatus)
handle('git:statusAll', () => [gitStatus])
handle('git:branches', () => ({ current: 'main', local: ['main', 'feat/traycer-parity'], remote: ['origin/main'] }))
handle('git:diff', () => ({ original, modified }))
handle('browser:local-servers', () => [{ port: 5173, pid: 4242, processName: 'node' }])
ipcMain.on('terminal:create', (e, opts) => {
  setTimeout(() => { if (!e.sender.isDestroyed()) e.sender.send('terminal:data', { id: opts.id, data: 'Windows PowerShell\r\n\r\n\x1b[32mPS\x1b[0m C:\\QA\\prism-demo> npm run typecheck\r\n\r\n> prism-ide@0.1.0 typecheck\r\n\x1b[36m✓\x1b[0m sem erros\r\n\r\n\x1b[32mPS\x1b[0m C:\\QA\\prism-demo> ' }) }, 300)
})
let tasks = { tasks: [{ id: 'qa-task', title: 'Integrar Modelos no Traycer', cwd: ROOT, updatedAt: now, activeChatId: 'qa-chat' }], openIds: ['qa-task'], activeId: 'qa-task' }
handle('tasks:load', () => tasks)
handle('tasks:save', (t, openIds, activeId) => { tasks = { tasks: t, openIds, activeId } })
ipcMain.on('tasks:flush', (e) => { e.returnValue = { ok: true } })
handle('providers:list', () => profiles)
handle('providers:models', (provider) => provider === 'codex' ? codexModels : claudeModels)
handle('providers:details', (_provider, id) => ({ updatedAt: Date.now() - (id === 'ambient-codex' ? 19 * 60e3 : 0), stale: id === 'ambient-codex', limits: usage[id] || [], email: 'qa@example.invalid', tier: 'max' }))
handle('providers:status', (_provider, id) => id === 'claude-2' || id === 'codex-2' ? { installed: true, loggedIn: false, detail: 'Faça login nesta conta.' } : { installed: true, loggedIn: true, detail: 'Conectada', email: 'qa@example.invalid' })
handle('providers:update', (id, patch) => { Object.assign(profiles.find((p) => p.id === id), patch); return profiles })
handle('chats:list', () => qaChats)
const qaSavedChats = []
handle('chats:save', (saved) => {
  if (wanted.includes('working-directory') && saved.cwd === 'C:\\QA\\unsaved-project') throw new Error('Não foi possível salvar a pasta de teste.')
  if (wanted.includes('working-directory')) qaSavedChats.push(structuredClone(saved))
  return true
})
ipcMain.on('chats:flush', (e) => { e.returnValue = { ok: true } })
handle('chats:delete', () => true)
const qaSubagentMessages = []
handle('codex:subagent-message', payload => {
  qaSubagentMessages.push(payload)
  if (payload.text === 'refusar') throw new Error('fixture: subagent unavailable')
  return { delivery: 'direct', nativeTurnId: 'qa-native-child-turn', steered: true }
})
// Queue/interrupt QA uses the real renderer and preload without launching a provider.
let qaActiveTurn = null
const qaSteers = []
const qaQuestionReplies = []
ipcMain.on('agent:send', (_event, payload) => { qaActiveTurn = payload })
ipcMain.on('agent:question-response', (event, payload) => {
  qaQuestionReplies.push({ owner: event.sender.id, ...payload })
})
handle('agent:steer', payload => {
  if (!qaActiveTurn || qaActiveTurn.id !== payload.turnId) throw new Error('Stale QA turn')
  qaSteers.push(payload)
  return null
})
ipcMain.on('agent:abort', (event, id) => {
  if (qaActiveTurn?.id !== id) return
  qaActiveTurn = null
  event.sender.send('agent:done', { id, aborted: true })
})

// PRISM_QA_HOST=1 runs a real Prism host (release build) in this QA profile,
// proving preload → CSP → WebSocket → status bar end to end. Without it the
// connection answers null and the UI must work on IPC alone.
let qaHost = null
if (process.env.PRISM_QA_HOST) {
  const exe = path.join(root, 'host', 'target', 'release', process.platform === 'win32' ? 'prism-host.exe' : 'prism-host')
  const hostDir = path.join(app.getPath('userData'), 'host')
  seedUsageStore()
  // T08: like the app's supervisor, the host keeps the logins and reads the
  // Usage store in this profile's own data folder.
  const env = { ...process.env, PRISM_APP_DATA_DIR: app.getPath('userData') }
  qaHost = require('node:child_process').spawn(exe, ['--data-dir', hostDir, '--idle-timeout', '120'], { stdio: 'ignore', env })
  handle('host:connection', async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const instance = JSON.parse(fs.readFileSync(path.join(hostDir, 'host-instance.json'), 'utf8'))
        return { port: instance.port, token: instance.token, clientVersion: 'qa' }
      } catch { await new Promise((r) => setTimeout(r, 100)) }
    }
    return null
  })
  // T07: the host owns the chats; the demo chat is created in it over RPC.
  handle('host:owns-chats', () => true)
}

/** A short RPC session with the QA host: `work(call)` runs after the hello. */
async function withQaHost(work) {
  const hostDir = path.join(app.getPath('userData'), 'host')
  let instance
  for (let i = 0; i < 100 && !instance; i++) {
    try { instance = JSON.parse(fs.readFileSync(path.join(hostDir, 'host-instance.json'), 'utf8')) } catch { await new Promise((r) => setTimeout(r, 100)) }
  }
  if (!instance) throw new Error('QA host did not start')
  const ws = new WebSocket(`ws://127.0.0.1:${instance.port}/rpc`)
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m) }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0
  const call = (method, params) => new Promise((resolve, reject) => {
    const n = ++id
    pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }))
  })
  try {
    await call('host.hello', { protocol: { major: 1, minor: 0 }, client: { kind: 'desktop', version: 'qa' }, token: instance.token })
    return await work(call)
  } finally {
    ws.close()
  }
}

/** Creates the demo chat in the QA host (T07: the chats live there, not in IPC mocks). */
async function seedHost() {
  await withQaHost(async (call) => {
    const { chats } = await call('chats.list', {})
    if (!chats.some((c) => c.id === chat.id)) await call('chats.create', { chat })
    // T08: the accounts live in the host too (their logins stay empty: the CLI reports them logged out).
    await call('providers.importProfiles', { profiles: profiles.filter((p) => !p.ambient) })
  })
}

/** T08: the Traycer half of the Usage fixture, where the desktop's import keeps it (the host only reads it). */
function seedUsageStore() {
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'prism-usage.db'))
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS traycer_turns (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, chat_id TEXT NOT NULL, body TEXT NOT NULL, imported_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, body TEXT NOT NULL);`)
    const turn = db.prepare('INSERT OR REPLACE INTO traycer_turns VALUES (?, ?, ?, ?, ?, ?)')
    for (const o of usageFixture.observations.filter((o) => o.source === 'traycer')) turn.run(o.id, o.chatId.split('/')[0], o.chatId, JSON.stringify(o), now, now)
    db.prepare('INSERT OR REPLACE INTO state VALUES (?, ?)').run('traycer-import', JSON.stringify(usageFixture.importState))
  } finally {
    db.close()
  }
}
// Any other invoke channel the preload exposes answers null instead of throwing.
const preloadSource = fs.readFileSync(path.join(root, 'out/preload/index.js'), 'utf8')
for (const m of preloadSource.matchAll(/invoke\(\s*["'`]([^"'`]+)["'`]/g)) if (!handled.has(m[1])) handle(m[1], () => null)

/* ---------------- Driver ---------------- */
let win
let setScene = () => {}
const errors = []
const pause = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const js = (source) => win.webContents.executeJavaScript(source, true)
async function untilOn(evaluate, source, label, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) { if (await evaluate(source).catch(() => false)) return; await pause(100) }
  throw new Error(`Timed out: ${label}`)
}
const until = (source, label, timeout) => untilOn(js, source, label, timeout)
/** Types into the composer the way React expects. */
const type = (text) => js(`(() => {
  const box = document.querySelector('#subagent-message') ?? document.querySelector('[data-composer-shell] textarea')
  if (!box) throw new Error('No active composer textarea')
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  set.call(box, ${JSON.stringify(text)})
  box.dispatchEvent(new Event('input', { bubbles: true }))
})()`).then(() => pause(300))
const click = (selector) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('Missing ' + ${JSON.stringify(selector)}); el.click() })()`).then(() => pause(250))
const hover = async (selector) => {
  const rect = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return r && { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
  if (!rect) throw new Error(`Missing ${selector}`)
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(rect.x), y: Math.round(rect.y) })
  await pause(900)
}
const key = async (keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); await pause(250) }
async function shot(name) {
  await js('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))')
  await pause(250)
  // Hidden Electron surfaces can retain a previous composited layer until capture requests a frame.
  await win.webContents.capturePage(undefined, { stayHidden: true })
  await pause(100)
  const image = await win.webContents.capturePage(undefined, { stayHidden: true })
  const file = path.join(outDir, `${name}.png`)
  fs.writeFileSync(file, image.toPNG())
  console.log('shot', path.relative(root, file))
}
async function crop(name, selector, pad = 24) {
  const r = await js(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; if (!els.length) return null; const rs = els.map(e => e.getBoundingClientRect()); return { x: Math.min(...rs.map(r => r.left)), y: Math.min(...rs.map(r => r.top)), r: Math.max(...rs.map(r => r.right)), b: Math.max(...rs.map(r => r.bottom)) } })()`)
  if (!r) throw new Error(`Missing ${selector}`)
  await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
  const [w, h] = win.getContentSize()
  const x = Math.max(0, Math.floor(r.x - pad)), y = Math.max(0, Math.floor(r.y - pad))
  const rect = { x, y, width: Math.min(w - x, Math.ceil(r.r - r.x + pad * 2)), height: Math.min(h - y, Math.ceil(r.b - r.y + pad * 2)) }
  await win.webContents.capturePage(undefined, { stayHidden: true })
  await pause(100)
  const image = await win.webContents.capturePage(rect, { stayHidden: true })
  const file = path.join(outDir, `${name}.png`)
  fs.writeFileSync(file, image.toPNG())
  console.log('crop', path.relative(root, file))
}
// sendInputEvent keys do not reach a hidden window's focused element; dispatch DOM events instead.
const escape = () => js(`(() => { const t = document.activeElement || document.body; t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })) })()`).then(() => pause(200))
const closeEverything = async () => { await escape(); await escape(); await pause(150) }
const clickText = (selector, text) => js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].reverse().find(e => e.textContent.trim().includes(${JSON.stringify(text)})); if (!el) throw new Error('Missing text ' + ${JSON.stringify(text)}); el.click() })()`).then(() => pause(350))
const chord = (key, mods = {}) => js(`window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, ...mods, bubbles: true })}))`).then(() => pause(600))

const scenes = {
  async 'working-directory'() {
    const assert = require('node:assert/strict')
    assert.equal(qaHost, null, 'folder scene uses isolated IPC and never invokes a provider')
    const dialog = '.ch-directory-dialog'
    const input = '[aria-label="Caminho absoluto da pasta"]'
    const latest = id => qaSavedChats.filter(saved => saved.id === id).at(-1)
    const open = async () => {
      await click('[aria-label="Mais ações do chat"]')
      await clickText('[role="menuitem"]', 'Trocar pasta de trabalho')
      await until(`!!document.querySelector(${JSON.stringify(dialog)})`, 'folder dialog')
    }
    const fill = value => js(`(() => {
      const el = document.querySelector(${JSON.stringify(input)})
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })()`).then(() => pause(100))
    const submit = () => clickText(`${dialog} button`, 'Trocar pasta')
    const close = () => clickText(`${dialog} button`, 'Cancelar')
    await open()
    assert.equal(await js(`document.querySelector(${JSON.stringify(input)}).value`), ROOT)
    await shot('working-directory-open')
    const focusState = await js(`({ active: document.activeElement?.outerHTML, inert: !!document.querySelector(${JSON.stringify(input)}).closest('[inert]'), focused: document.hasFocus() })`)
    if (!(await js(`document.activeElement === document.querySelector(${JSON.stringify(input)})`))) console.log('folder focus', focusState)
    assert.equal(await js(`document.activeElement === document.querySelector(${JSON.stringify(input)})`), true, 'path gets keyboard focus')
    await escape()
    assert.equal(await js(`!!document.querySelector(${JSON.stringify(dialog)})`), false, 'Escape cancels')
    assert.equal(qaSavedChats.length, 0, 'opening and cancelling do not save')
    await open()
    await fill('C:\\QA\\missing-project')
    await submit()
    assert.equal(await js(`document.querySelector(${JSON.stringify(dialog)}).textContent.includes('não existe')`), true)
    assert.equal(qaSavedChats.some(saved => saved.cwd === 'C:\\QA\\missing-project'), false, 'invalid folder is never persisted')
    await fill('C:\\QA\\unsaved-project')
    await submit()
    assert.equal(await js(`document.querySelector(${JSON.stringify(dialog)}).textContent.includes('salvar')`), true, 'save failure stays in the dialog')
    await close()
    await open()
    assert.equal(await js(`document.querySelector(${JSON.stringify(input)}).value`), ROOT, 'save failure leaves original cwd')
    await clickText(`${dialog} button`, 'Escolher pasta')
    assert.equal(await js(`document.querySelector(${JSON.stringify(input)}).value`), ROOT, 'native picker fills the absolute path')
    const destination = 'C:\\QA\\projeto com espaços\\backend'
    await fill(destination)
    await win.setContentSize(900, 600)
    await shot('working-directory-900')
    const fits = await js(`(() => { const r = document.querySelector(${JSON.stringify(dialog)}).getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight })()`)
    assert.equal(fits, true, 'dialog fits the smallest supported window')
    await submit()
    await until(`!document.querySelector(${JSON.stringify(dialog)})`, 'new folder saved')
    assert.equal(latest(chat.id).cwd, destination)
    assert.equal(latest(chat.id).cwdPinned, true)
    assert.equal(latest(chat.id).resume, undefined, 'native session resets after cwd changes')
    assert.deepEqual(JSON.parse(JSON.stringify(latest(chat.id).turns)), chat.turns, 'conversation history is unchanged')
    assert.equal(await js('document.querySelector(".ch-header-name").textContent'), chat.title, 'same conversation remains selected')
    await win.setContentSize(1380, 880)
    await click('.al-row[data-node-id="qa-directory-codex"]')
    await open()
    assert.equal(await js(`document.querySelector(${JSON.stringify(input)}).value`), ROOT, 'other chat keeps its original cwd')
    await fill('C:\\QA\\outro-projeto-codex')
    await shot('working-directory-codex')
    await submit()
    await until(`!document.querySelector(${JSON.stringify(dialog)})`, 'Codex folder saved')
    const codex = latest('qa-directory-codex')
    assert.equal(codex.cwd, 'C:\\QA\\outro-projeto-codex')
    assert.equal(codex.selection.provider, 'codex')
    assert.equal(codex.resume, undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(codex.turns)), chat.turns)
    assert.equal(latest(chat.id).cwd, destination, 'changing Codex folder does not overwrite Claude chat')
    assert.deepEqual(errors, [])
    console.log('working-directory: Claude/Codex folders, preserved histories, cancellation, native picker, validation/save failures and 900x600 layout passed.')
  },
  async 'history-previews'() {
    const assert = require('node:assert/strict')
    assert.equal(qaHost, null, 'history preview scene only runs against isolated mock IPC')
    await until('!!document.querySelector(".ch-group-trigger")', 'preserved tool activity')
    assert.equal(historyReads.length, 0, 'folded activity does not eagerly read complete payloads or image bytes')
    await click('.ch-group-trigger')
    await until('document.querySelectorAll(".ch-tool-complete button").length === 2', 'both complete payload actions')
    await pause(300)
    assert.equal(historyReads.length, 0, 'an image outside the viewport stays deferred and complete text is not read eagerly')
    await win.webContents.removeInsertedCSS(historyImageHiddenCss)
    await until('document.querySelector(".ch-tool-images img")?.naturalWidth === 160', 'cached local tool image pixels')
    assert.deepEqual(historyReads, [{ kind: 'image', path: historyPaths.image }], 'the cached image is read once when it becomes visible')
    await click('.ch-tool-images .ch-markdown-image-button')
    await until('!!document.querySelector("dialog.ch-image-preview[open] img")', 'cached image lightbox')
    await click('[aria-label="Fechar imagem"]')
    await shot('history-previews')
    await clickText('.ch-tool-complete button', 'Abrir saída completa')
    await until('document.querySelector(".monaco-editor .view-lines")?.textContent.includes("FULL_OUTPUT_RESTORED")', 'original full output opens in the editor', 20000)
    assert.ok(historyReads.some(read => read.kind === 'text' && read.path === historyPaths.output))
    await chord('l', { ctrlKey: true })
    await until('!!document.querySelector(".ch-tool-complete")', 'conversation still exposes complete input')
    await clickText('.ch-tool-complete button', 'Abrir entrada completa')
    await until('document.querySelector(".monaco-editor .view-lines")?.textContent.includes("FULL_INPUT_RESTORED")', 'original full input opens in the editor', 20000)
    assert.ok(historyReads.some(read => read.kind === 'text' && read.path === historyPaths.input))
    assert.ok(historyReads.filter(read => read.kind === 'image').every(read => read.path === historyPaths.image), 'remounting the chat after editor navigation keeps the same cached image source')
    assert.deepEqual(errors, [], 'no renderer errors while opening preserved data')
    console.log('history-previews: complete output/input open from their exact preserved paths; cached image waits for visibility, loads pixels and opens its lightbox.')
  },
  async subagents() {
    const assert = require('node:assert/strict')
    await until('document.querySelectorAll(".ch-subagent").length === 2', 'two native subagents remain visible after the parent turn')
    win.webContents.send('agent:subagent', { id: 'qa-subagents-parent', agent: { id: 'audit', name: 'Auditar API', status: 'running', description: 'Tarefa de auditar API.', text: 'Lendo src/api e validando respostas.', spawnToolCallId: 'spawn-native-audit' } })
    await until('!!document.querySelector(".ch-subagent[data-status=running]")', 'native activity arrives through the real preload subscription')
    assert.equal(await js('document.querySelectorAll(".ch-subagent[data-status=running]").length'), 1)
    assert.equal(await js('document.querySelectorAll(".ch-subagent[data-status=completed]").length'), 1)
    assert.equal(await js('!!document.querySelector(\'.al-row[data-node-id="subagent:qa-chat:audit"]\')'), true, 'child linked in parent tree')
    await shot('subagents-parent')
    await click('.ch-subagent[data-agent-id=audit] .ch-card-trigger')
    assert.equal(await js('document.querySelector(".ch-subagent[data-agent-id=audit]").textContent.includes("Lendo src/api")'), true)
    await click('[aria-label="Abrir agente Auditar API"]')
    await until('!!document.querySelector(".ch-subagent-composer")', 'native child conversation opens with a routed composer')
    assert.equal(await js('document.querySelector(".ch-notices").textContent.includes("conversa principal")'), true)
    assert.equal(await js('!!document.querySelector(".tcm-send.stop, .tmp-trigger, .tpm-trigger")'), false, 'native child keeps native session configuration')
    await type('refusar')
    await click('[aria-label="Enviar ao subagente"]')
    assert.equal(await js('document.querySelector("#subagent-message").value'), 'refusar', 'refusal keeps the child draft')
    await type('Confira os testes deste subagente')
    await click('[aria-label="Enviar ao subagente"]')
    await until('document.querySelector("#subagent-message").value === ""', 'confirmed native send clears its draft')
    assert.equal(qaSubagentMessages.at(-1).rootChatId, 'qa-chat')
    assert.equal(qaSubagentMessages.at(-1).rootTurnId, 'qa-subagents-parent')
    assert.equal(qaSubagentMessages.at(-1).agentId, 'audit')
    assert.equal(qaSubagentMessages.at(-1).text, 'Confira os testes deste subagente')
    assert.equal(await js('document.querySelector(".ch-header-name").textContent'), 'Auditar API')
    await shot('subagents-child')
    await clickText('.ch-notice button', 'Voltar à conversa principal')
    await until('document.querySelectorAll(".ch-subagent").length === 2', 'return to parent conversation')
    console.log('subagents: linked native activity, direct child messages, refusals preserve drafts, native identity retained and parent navigation')
  },
  async 'repro-chat'() {
    await pause(1500)
    await click('button[aria-label="Rolar até o fim"]')
    await pause(1000)
    await shot('repro-chat')
    const lastId = chat.turns.at(-1).id
    const state = await js(`({fallback:document.querySelector(".panel-error")?.textContent, messages:document.querySelectorAll(".ch-msg").length, markdownImages:document.querySelectorAll(".ch-md img").length, lastTurnRendered:[...document.querySelectorAll('[data-turn-id]')].some(node=>node.dataset.turnId===${JSON.stringify(lastId)})})`)
    fs.writeFileSync(path.join(outDir, 'repro-chat-state.json'), JSON.stringify({ ...state, errors }, null, 2))
    if (state.fallback) throw new Error('Real chat rendered the error boundary: '+state.fallback)
    if (!state.messages) throw new Error('Real chat did not render any messages')
    if (!state.lastTurnRendered) throw new Error('The last chat turn was not rendered')
  },
  async 'async-questions'() {
    await until('!!document.querySelector(".ch-interview")', 'asynchronous native question metadata renders choices')
    await type('Rascunho preservado')
    await shot('async-question-choices')
    await click('[aria-label="1. Automaticamente"]')
    await until('document.querySelector(".ch-question-text").textContent.includes("Qual uso")', 'second asynchronous question')
    await click('[aria-label="3. Os dois"]')
    await until('!!document.querySelector(".tcm-send.stop") && !document.querySelector(".ch-interview")', 'asynchronous answer delivered as a new message')
    if (!qaActiveTurn.prompt.includes('Resposta: Automaticamente') || !qaActiveTurn.prompt.includes('Resposta: Os dois')) throw new Error('Asynchronous choices did not reach the provider')
    if (await js('document.querySelector(".tcm-editor").value') !== 'Rascunho preservado') throw new Error('Answer replaced existing composer draft')
    await shot('async-question-answer')
    await click('.tcm-send.stop')
    await until('!document.querySelector(".tcm-send.stop")', 'asynchronous reply stopped')
    console.log('async-questions: native metadata choices delivered as a follow-up without replacing the draft or inventing a blocking dialog')
  },

  async 'native-questions'() {
    if (qaHost) throw new Error('native-questions uses isolated IPC fixtures without a host or real provider')
    await js("document.documentElement.classList.add('no-anim')")
    const assert = require('node:assert/strict')
    const answerText = async (selector, text) => {
      await js(`(() => {
        const box=document.querySelector(${JSON.stringify(selector)});
        if(!box)throw new Error('Missing answer textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(box,${JSON.stringify(text)});
        box.dispatchEvent(new Event('input',{bubbles:true}));
      })()`)
      await pause(160)
    }
    await type('Vamos responder as perguntas do agente.')
    await click('.tcm-send:not(.stop)')
    await until('!!document.querySelector(".tcm-send.stop")', 'running question turn')
    const id = qaActiveTurn?.id
    if (!id) throw new Error('Question fixture did not receive agent:send')
    const numbering = 'Como as imagens devem ser numeradas?'
    const usage = 'Qual uso do Codex deve aparecer?'
    win.webContents.send('agent:question', { id, dialogId: 'qa-two-questions', toolUseId: 'ask-user-1', questions: [
      { question: numbering, header: 'Imagens', multiSelect: false, options: [{ label: 'Ordem no texto', description: 'Marcadores automáticos ao escrever.' }, { label: 'Ordem dos anexos', description: 'A sequência dos arquivos.' }] },
      { question: usage, header: 'Uso', multiSelect: false, options: [{ label: 'Tokens', description: 'Uso da conversa.' }, { label: 'Limites', description: 'Uso da conta.' }] }
    ] })
    await until('document.querySelector(".ch-question-text")?.textContent.includes("numeradas")', 'native question card opens')
    await shot('native-question-first')
    await click('.ch-option-hit[aria-label="1. Ordem no texto"]')
    await until('document.querySelector(".ch-question-text")?.textContent.includes("Codex")', 'single choice advances to the second question')
    if (qaQuestionReplies.length) throw new Error('Question was submitted before the second answer')
    await click('.ch-option-hit[aria-label="Outro"]')
    await answerText('.ch-other-field textarea', 'Tokens e limites da conta')
    await shot('native-question-other')
    await clickText('.ch-interview-actions button', 'Enviar')
    await until('!document.querySelector(".ch-interview")', 'question reply accepted and card cleared')
    await pause(100)
    assert.equal(qaQuestionReplies.length, 1)
    assert.deepEqual(qaQuestionReplies[0], { owner: win.webContents.id, id, dialogId: 'qa-two-questions',
      answers: { [numbering]: 'Ordem no texto', [usage]: 'Tokens e limites da conta' }, response: 'Tokens e limites da conta', cancelled: false })
    // An input-only question must enable Enviar after typing, without an option to pick.
    win.webContents.send('agent:question', { id, dialogId: 'qa-free-question', questions: [{ question: 'Qual detalhe falta?', header: '', multiSelect: false, options: [] }] })
    await until('!!document.querySelector(".ch-free-answer")', 'free-answer question opens')
    await answerText('.ch-free-answer', 'Mostrar o contexto restante.')
    await until('[...document.querySelectorAll(".ch-interview-actions button")].some(b => b.textContent.includes("Enviar") && !b.disabled)', 'typed free answer is ready')
    await clickText('.ch-interview-actions button', 'Enviar')
    await until('!document.querySelector(".ch-interview")', 'free answer accepted')
    await pause(100)
    assert.deepEqual(qaQuestionReplies[1], { owner: win.webContents.id, id, dialogId: 'qa-free-question',
      answers: { 'Qual detalhe falta?': 'Mostrar o contexto restante.' }, response: 'Mostrar o contexto restante.', cancelled: false })
    win.webContents.send('agent:question', { id, dialogId: 'qa-skipped-question', questions: [{ question: 'Deseja responder agora?', header: '', multiSelect: false, options: [] }] })
    await until('!!document.querySelector(".ch-interview")', 'skip question opens')
    await clickText('.ch-interview-actions button', 'Pular')
    await until('!document.querySelector(".ch-interview")', 'intentional skip clears card')
    await pause(100)
    assert.deepEqual(qaQuestionReplies[2], { owner: win.webContents.id, id, dialogId: 'qa-skipped-question', answers: undefined, response: undefined, cancelled: true })
    await click('.tcm-send.stop')
    await until('!document.querySelector(".tcm-send.stop")', 'question turn stopped')
    console.log('native-questions: IPC → visible card → two answers/Outro/free text/intentional skip reached the native turn and dialog')
  },

  async 'codex-usage'() {
    await hover('.ch-footer-elapsed')
    await until('document.querySelector(".ch-meta")?.textContent.includes("Uso deste turno")', 'Codex per-turn usage tooltip')
    const metadata = await js('document.querySelector(".ch-meta").textContent')
    if (!metadata.includes('Uso da sessão nativa') || !metadata.includes('Contexto')) throw new Error('Codex session/context usage missing')
    await shot('codex-usage-tooltip')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
    await js(`document.documentElement.classList.add('no-anim')`)
    await chord(',', { ctrlKey: true })
    await click('[data-testid="settings-sidebar-item-usage"]')
    await until('document.querySelector(".usg-figure")?.textContent.includes("tokens")', 'Codex tokens are the initial metric')
    await until('!!document.querySelector(".usg-echarts svg path")', 'Codex token chart')
    const figure = await js('document.querySelector(".usg-figure").textContent')
    if (/^0(?:\D|$)/.test(figure)) throw new Error('Codex measured usage shows zero')
    await shot('codex-usage-dashboard')
    await escape()
    console.log('codex-usage: measured per-turn/session/context tooltip and nonzero Codex tokens dashboard passed')
  },

  async 'automatic-image-references'() {
    const paste = async (image, caret) => {
      await js(`(() => {
        const editor=document.querySelector('.tcm-editor'); editor.focus(); editor.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));
        if (${caret !== undefined}) editor.setSelectionRange(${caret ?? 0},${caret ?? 0});
        const asset=${JSON.stringify(image)};
        const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));
        const transfer=new DataTransfer(); transfer.items.add(new File([bytes],asset.name,{type:asset.mime}));
        editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
      })()`)
    }
    await type('Compare com a outra.')
    await js(`(() => { const read=FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL=function(file){const reader=this;setTimeout(()=>read.call(reader,file),450)}; })()`)
    await paste(referenceImages[0], 'Compare '.length)
    await until('document.querySelector(".tcm-send:not(.stop)").disabled', 'image loading blocks premature send')
    await js(`document.querySelector('.tcm-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`)
    if (qaActiveTurn) throw new Error('Text sent before pasted image finished loading')
    await type('Compare com a outra. Sem perder texto.')
    await until('document.querySelector(".tcm-editor").value.includes("#image 1")', 'first pasted image automatically marked')
    const first = await js('document.querySelector(".tcm-editor").value')
    if (!/^Compare\s+#image 1\s+com a outra\. Sem perder texto\.$/.test(first)) throw new Error('Automatic marker lost caret/text typed during reading: '+first)
    await type('Compare #image 1 com ')
    await paste(referenceImages[1], 'Compare #image 1 com '.length)
    await until('document.querySelector(".tcm-editor").value.includes("#image 2")', 'second pasted image automatically marked')
    if (!/^Compare #image 1 com #image 2\s*$/.test(await js('document.querySelector(".tcm-editor").value'))) throw new Error('Wrong automatic image order')
    await shot('automatic-image-references')
    await escape()
    await click('.tcm-send:not(.stop)')
    await until('!!document.querySelector(".tcm-send.stop")', 'automatic image comparison sent')
    if (qaActiveTurn.images?.length !== 2 || qaActiveTurn.images[0].number !== 1 || qaActiveTurn.images[1].number !== 2) throw new Error('Automatic references did not send actual images')
    await click('.tcm-send.stop')
    await until('!document.querySelector(".tcm-send.stop")', 'automatic image comparison stopped')
    console.log('automatic-image-references: paste inserts numbered markers at caret, keeps surrounding text, and sends native image bytes without choosing a menu')
  },

  async 'image-references'() {
    await until('document.querySelectorAll(".ch-image-number").length === 2', 'numbered historical images')
    await js(`const editor=document.querySelector('.tcm-editor');editor.focus();editor.dispatchEvent(new FocusEvent('focusin',{bubbles:true}))`)
    await type('Compare #')
    await until('document.querySelectorAll(".tcx-image-item").length === 2', 'image suggestions')
    const labels = await js('[...document.querySelectorAll(".tcx-image-item")].map(e=>e.textContent)')
    if (!labels[0].includes('#image 1') || !labels[1].includes('#image 2')) throw new Error('Wrong image numbering: '+labels)
    await shot('image-reference-picker')
    await js(`document.querySelector('.tcm-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))`)
    await pause(80)
    await js(`document.querySelector('.tcm-editor').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`)
    await pause(180)
    if (await js('document.querySelector(".tcm-editor").value') !== 'Compare #image 2 ') throw new Error('Image completion replaced wrong range')
    await type('Compare #image 2 com #image 1')
    await click('.tcm-send:not(.stop)')
    await until('!!document.querySelector(".tcm-send.stop")', 'image comparison sent')
    if (qaActiveTurn.images?.length !== 2 || qaActiveTurn.images[0].number !== 2 || qaActiveTurn.images[1].number !== 1) throw new Error('Wrong native image reference order')
    if (!qaActiveTurn.prompt.includes('Anexo 1 = #image 2')) throw new Error('Missing attachment mapping')
    await type('Reveja #image 1')
    await click('.tcm-send:not(.stop)')
    await until('!!document.querySelector(".tcm-queue-item")', 'image reference queued')
    await shot('image-reference-queue')
    await click('.tcm-queue-item button[aria-label="Enviar mensagem agora"]')
    await until('!document.querySelector(".tcm-queue-item")', 'queued image reference steered')
    if (qaSteers.at(-1)?.images?.[0]?.number !== 1) throw new Error('Queued image bytes did not reach native steering')
    await type('Veja #image 99')
    await click('.tcm-send:not(.stop)')
    if (await js('document.querySelector(".tcm-editor").value') !== 'Veja #image 99') throw new Error('Unknown reference lost the draft')
    await click('.tcm-send.stop')
    await until('!document.querySelector(".tcm-send.stop")', 'comparison stopped')
    console.log('image-references: history labels, # picker, keyboard completion, real native image order, queued steering and invalid draft preservation passed')
  },

  async 'queue-flow'() {
    const enter = ctrlKey => js(`document.querySelector('.tcm-editor').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', ctrlKey:${!!ctrlKey}, bubbles:true, cancelable:true}))`).then(() => pause(250))
    await type('Start a running turn')
    await click('.tcm-send:not(.stop)')
    await until('!!document.querySelector(".tcm-send.stop")', 'running turn')
    if (!qaActiveTurn) throw new Error('Agent send did not reach main process')
    const activeId = qaActiveTurn.id
    if (await js('document.querySelector(".tmp-trigger").disabled || document.querySelector(".tpm-trigger").disabled')) throw new Error('Active turn locked model or permission controls')
    await click('.tpm-trigger'); await clickText('.tpm-item', 'Aceitar edições')
    await until('document.querySelector(".tpm-trigger").textContent.includes("Aceitar edições")', 'permission changed during turn')
    await click('.tmp-trigger'); await until('!!document.querySelector(".tmp-panel")', 'model picker during turn')
    await click('.tmp-trigger')
    if (qaActiveTurn?.id !== activeId) throw new Error('Settings change restarted the active turn')

    await type('First queued message'); await enter(false)
    await type('Second queued message, sent during the active turn'); await enter(false)
    await until('document.querySelectorAll(".tcm-queue-item").length === 2', 'two queued messages')
    const geometry = await js(`(() => {const dock=document.querySelector('.tcm-lower-dock').getBoundingClientRect(); const shell=document.querySelector('.tcm-shell').getBoundingClientRect(); return {dockBottom:dock.bottom,shellTop:shell.top,changesInDock:!!document.querySelector('.tcm-lower-dock .acd-changes')}})()`)
    if (!geometry.changesInDock || Math.abs(geometry.dockBottom - geometry.shellTop - 1) > 2) throw new Error('Wrong lower dock geometry: '+JSON.stringify(geometry))
    await crop('queue-flow', '.tcm-area', 16)
    await shot('queue-flow-full')
    await type('Preserved draft')
    await click('.tcm-queue-item:first-child button[aria-label="Editar mensagem na fila"]')
    await type('Edited first queued message')
    await click('.tcm-send:not(.stop)')
    if (await js('document.querySelector(".tcm-editor").value') !== 'Preserved draft') throw new Error('Queue edit lost existing draft')
    await click('.tcm-queue-item:last-child button[aria-label="Enviar mensagem agora"]')
    await until('document.querySelectorAll(".tcm-queue-item").length === 1', 'steered message removed')
    if (qaSteers.length !== 1 || qaSteers[0].turnId !== qaActiveTurn.id) throw new Error('Steering restarted or interrupted the active turn')
    await type('Ctrl Enter immediate message'); await enter(true)
    if (qaSteers.length !== 2) throw new Error('Ctrl+Enter did not steer')
    await click('.tcm-send.stop')
    await until('!document.querySelector(".tcm-send.stop")', 'stop completed')
    if (await js('document.querySelectorAll(".tcm-queue-item").length') !== 1) throw new Error('Stop consumed queued message')
    if (await js('document.querySelector(".tcm-queue-pause").textContent') !== 'Retomar') throw new Error('Stopped queue does not offer Resume')
    await crop('queue-after-stop', '.tcm-area', 16)
    await click('.tcm-queue-pause')
    await until('!!document.querySelector(".tcm-send.stop") && !document.querySelector(".tcm-queue-item")', 'queue resumed in one click')
    await click('.tcm-send.stop')
    await until('!document.querySelector(".tcm-send.stop")', 'resumed turn stopped')
    console.log('queue-flow: edit preserves draft; Enter queues; row Send and Ctrl+Enter steer; stop completes; queue retained; Resume starts next item in one click')
  },

  async composer() {
    await crop('composer', '.tcm-shell', 16)
  },
  async 'model-tooltip'() {
    await hover('.tmp-trigger')
    await crop('model-tooltip', '.tcm-shell, .tr-tooltip', 16)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 }); await pause(300)
  },
  async 'model-picker'() {
    await click('.tmp-trigger')
    await until('!!document.querySelector(".tmp-panel:not([data-measuring=true])")', 'picker open')
    await pause(500)
    await crop('model-picker', '.tmp-panel', 16)
    await shot('model-picker-full')
  },
  async 'profile-dropdown'() {
    if (!(await js('!!document.querySelector(".tmp-panel")'))) { await click('.tmp-trigger'); await pause(400) }
    await click('.trp-trigger')
    await until('!!document.querySelector(".trp-sidecar")', 'sidecar')
    await pause(500)
    await crop('profile-dropdown', '.tmp-panel, .tr-menu, .trp-sidecar', 16)
    await closeEverything()
  },
  async 'codex-picker'() {
    await click('.tmp-trigger')
    await pause(300)
    await click('.tmp-rail-btn[aria-selected="false"]')
    await pause(500)
    await click('.trp-trigger')
    await until('!!document.querySelector(".trp-sidecar")', 'codex sidecar')
    await pause(400)
    await crop('codex-picker', '.tmp-panel, .tr-menu, .trp-sidecar', 16)
    await closeEverything()
    // back to Claude
    await click('.tmp-trigger'); await pause(300); await click('.tmp-rail-btn[aria-selected="false"]'); await pause(300); await closeEverything()
    // A never-shown window runs no animation frames, so the picker never moves
    // the focus into itself and the Escape lands in the composer: close it from
    // its trigger, or it covers the next scenes.
    if (await js('!!document.querySelector(".tmp-panel")')) await click('.tmp-trigger')
  },
  async 'debug-escape'() {
    await click('.tpm-trigger')
    await pause(400)
    const info = await js(`(() => { const a = document.activeElement; return { open: !!document.querySelector('.tpm-menu'), active: a ? a.className + ' ' + (a.getAttribute('role') || '') : null, inMenu: !!a?.closest?.('.tr-menu') } })()`)
    console.log('before', JSON.stringify(info))
    await escape()
    console.log('after escape', JSON.stringify(await js(`({ open: !!document.querySelector('.tpm-menu'), active: document.activeElement?.className })`)))
    await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`)
    await pause(300)
    console.log('after outside pointerdown', JSON.stringify(await js(`({ open: !!document.querySelector('.tpm-menu') })`)))
  },
  async permissions() {
    await click('.tpm-trigger')
    await pause(400)
    await crop('permissions', '.tcm-shell, .tr-menu', 16)
    await closeEverything()
  },
  async workspace() { await shot('workspace') },
  async settings() {
    await chord(',', { ctrlKey: true })
    await shot('settings-general')
    await click('[data-testid="settings-sidebar-item-providers"]')
    await pause(900)
    await shot('settings-providers')
    await click('[data-testid="settings-sidebar-item-appearance"]')
    await shot('settings-appearance')
    await click('[data-testid="system-tab-modal-close-settings"]')
    await pause(400)
  },
  async usage() {
    // A never-shown window does not advance entrance animations; capture the
    // settled state (the app's own "Animações" off switch).
    await js(`document.documentElement.classList.add('no-anim')`)
    await chord(',', { ctrlKey: true })
    await click('[data-testid="settings-sidebar-item-usage"]')
    await until('!!document.querySelector(".usg-hero")', 'usage dashboard', 15000)
    await until('!!document.querySelector(".usg-echarts svg path")', 'usage chart', 15000)
    // The rail must mark Uso as the open section; a hovered row only tints.
    await until(`document.querySelector('[data-testid="settings-sidebar-item-usage"]')?.getAttribute('aria-current') === 'page'`, 'Uso selected in the rail')
    const rail = await js(`({ current: [...document.querySelectorAll('.stg-rail-item[aria-current="page"]')].map(e => e.dataset.testid), hovered: document.querySelector('.stg-rail-item:hover')?.dataset.testid ?? null, focused: document.activeElement?.dataset?.testid ?? document.activeElement?.className ?? null })`)
    console.log('usage rail', JSON.stringify(rail))
    win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
    await pause(900)
    await shot('settings-usage')
    const reveal = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'start' })`).then(() => pause(500))
    // The export menu, then a filter menu, each cropped with what opened it.
    await clickText('.usg-root button', 'Exportar')
    await until('!!document.querySelector(".tr-menu:not([data-measuring=true])")', 'export menu')
    await pause(300)
    await crop('settings-usage-export', '.usg-toolbar, .tr-menu', 16)
    await escape()
    await clickText('.usg-filter-chip', 'Modelo')
    await until('!!document.querySelector(".tr-menu:not([data-measuring=true])")', 'filter menu')
    await pause(300)
    await crop('settings-usage-filter', '.usg-filters, .tr-menu', 16)
    await escape()
    await reveal('[data-settings-anchor="usage-activity"]')
    await shot('settings-usage-activity')
    await reveal('[data-settings-anchor="usage-breakdown"]')
    await click('.usg-chat-toggle')
    await shot('settings-usage-breakdown')
    await click('[data-testid="system-tab-modal-close-settings"]')
    await pause(400)
  },
  async folder() {
    await chord('o', { ctrlKey: true })
    await pause(800)
  },
  async terminal() {
    await click('[aria-label="Mostrar terminal"]')
    await pause(1500)
    await shot('terminal')
    await click('[aria-label="Mostrar terminal"]').catch(() => {})
  },
  async explorer() {
    await clickText('[role="tab"]', 'Editor')
    await pause(500)
    if (!(await js('!!document.querySelector(\'[aria-label="Explorador (Ctrl+B)"][aria-pressed="true"]\')'))) await click('[aria-label="Explorador (Ctrl+B)"]')
    await pause(900)
    await clickText('[role="treeitem"]', 'src').catch(() => {})
    await pause(600)
    await shot('explorer')
  },
  async editor() {
    // Regression: Monaco stuck on "Loading..." when the CDN loader started first.
    await clickText('[role="treeitem"]', 'App.tsx')
    await until('!!document.querySelector(".monaco-editor .view-lines")', 'monaco rendered', 15000)
    await pause(600)
    await shot('editor')
  },
  async git() {
    await click('[aria-label="Controle de versão (Ctrl+Shift+G)"]')
    // A real host runs git for real: wait for the rows, not a fixed time.
    await until(`!!document.querySelector('.pg-panel')?.textContent.includes('store.ts')`, 'git rows', 15000)
    await pause(400)
    await shot('git-panel')
    await clickText('[role="treeitem"], [role="option"], button, li, [data-path]', 'store.ts')
    await pause(2500)
    await shot('git-diff')
  },
  async browser() {
    await clickText('[role="tab"]', 'Navegador')
    await pause(1500)
    await shot('browser')
    await clickText('[role="tab"]', 'Conversas')
  },
  // Opt-in only (`node scripts/traycer-ui-shots.cjs debug-claude-live` with
  // PRISM_QA_HOST=1 and PRISM_QA_LIVE=1): sends one tiny prompt through the
  // real host and Claude CLI on the terminal account. Costs one Haiku turn.
  async 'debug-claude-live'() {
    if (!qaHost || !process.env.PRISM_QA_LIVE) throw new Error('needs PRISM_QA_HOST=1 and PRISM_QA_LIVE=1')
    await until(`window.prism.host.route('claude') === 'host'`, 'claude routed to the host', 15000)
    await type('Responda exatamente com a palavra: pronto')
    await click('.tcm-send:not(.stop)')
    await until(`[...document.querySelectorAll('.ch-msg.assistant')].at(-1)?.textContent.toLowerCase().includes('pronto')`, 'live Haiku reply', 120000)
    await until(`!document.querySelector('.tcm-send.stop')`, 'turn finished', 60000)
    console.log('live reply', await js(`[...document.querySelectorAll('.ch-msg.assistant')].at(-1).textContent.slice(0, 200)`))
    await shot('claude-live')
  },
  // Opt-in (PRISM_QA_HOST=1 + PRISM_QA_LIVE=1): T07's acceptance check. A real
  // Haiku turn asks to write a file; the window closes while the approval is
  // pending, a new one opens and still shows it, a second window sees it too,
  // and approving in one clears it in the other. Costs one short Haiku turn.
  async 'debug-host-reopen'() {
    if (!qaHost || !process.env.PRISM_QA_LIVE) throw new Error('needs PRISM_QA_HOST=1 and PRISM_QA_LIVE=1')
    await until(`window.prism.host.capabilities().includes('chats@1')`, 'host serves chats', 15000)
    const file = path.join(ROOT, 'prova-t07.txt')
    await type('Use a ferramenta Write para criar o arquivo prova-t07.txt nesta pasta com o conteúdo ok. Depois responda só: pronto.')
    await click('.tcm-send:not(.stop)')
    await until(`!!document.querySelector('.ch-approval')`, 'approval while the window is open', 120000)
    await shot('host-reopen-1-approval')
    // The window goes away mid-turn; the host keeps the turn and its approval.
    win.destroy()
    await pause(3000)
    win = await openWindow()
    await until('!!document.querySelector(".tcm-shell")', 'reopened window ready', 30000)
    await until(`!!document.querySelector('.ch-approval')`, 'approval still pending after reopening', 30000)
    await shot('host-reopen-2-reopened')
    const other = await openWindow()
    const onOther = (source) => other.webContents.executeJavaScript(source, true)
    try {
      await untilOn(onOther, `!!document.querySelector('.ch-approval')`, 'second window sees the approval', 30000)
      await clickText('.ch-approval-actions button', 'Aprovar')
      await untilOn(onOther, `!document.querySelector('.ch-approval')`, 'approval cleared in the second window', 15000)
      await until(`[...document.querySelectorAll('.ch-msg.assistant')].at(-1)?.textContent.toLowerCase().includes('pronto')`, 'turn finished', 120000)
      await until(`!document.querySelector('.tcm-send.stop')`, 'idle', 60000)
      await shot('host-reopen-3-done')
      console.log('file written by the turn:', fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '(missing)')
    } finally {
      other.destroy()
    }
  },
  // T08 (PRISM_QA_HOST=1): a turn that failed because its login is gone
  // offers "Entrar novamente", blocked with a reason on the terminal account.
  // The button is never clicked: a real login would open the browser.
  async 'debug-reauth'() {
    if (!qaHost) throw new Error('needs PRISM_QA_HOST=1')
    const failed = (profileId) => ({ ...chat, selection: { ...chat.selection, profileId }, turns: [...chat.turns,
      { id: 'u-auth', role: 'user', text: 'continua' },
      { id: 'a-auth', role: 'assistant', provider: 'claude', model: 'claude-opus-5-5', startedAt: now - 3000, completedAt: now, durationMs: 3000,
        error: true, errorCode: 'cli_auth', segments: [{ kind: 'text', text: 'Sua sessão do Claude Code expirou. Faça login de novo nesta conta.' }] }] })
    const button = `[...document.querySelectorAll('.ch-error button')].find((b) => b.textContent.includes('Entrar novamente'))`
    try {
      await withQaHost((call) => call('chats.put', { chat: failed('claude-2') }))
      await until(`!!${button} && !${button}.disabled`, '"Entrar novamente" enabled on a Prism account', 15000)
      await js(`${button}.scrollIntoView({ block: 'center' })`)
      await crop('reauth', '.ch-error', 12)
      await withQaHost((call) => call('chats.put', { chat: failed('ambient-claude') }))
      await until(`!!${button} && ${button}.disabled`, '"Entrar novamente" blocked on the terminal account', 15000)
      await hover('.ch-error .stg-inline-guard')
      console.log('reauth blocked', JSON.stringify(await js(`(() => { const b = ${button}; return { disabled: b.disabled, opacity: getComputedStyle(b).opacity, classes: b.className, tooltip: document.querySelector('[role="tooltip"]')?.textContent ?? null } })()`)))
      await crop('reauth-blocked', '.ch-error, [role="tooltip"]', 12)
    } finally {
      await withQaHost((call) => call('chats.put', { chat }))
    }
  },
  async 'debug-host-chats'() {
    const list = await js(`window.prism.chats.host.list().then((s) => s.chats.map((c) => ({ id: c.id, title: c.title, taskId: c.taskId, turns: c.turns.length, selection: c.selection })))`)
    console.log('host chats', JSON.stringify(list, null, 1))
    console.log('picker', await js(`document.querySelector('.tmp-trigger')?.textContent`))
  },
  async host() {
    const expected = qaHost ? 'hs-connected' : 'hs-unavailable'
    await until(`!!document.querySelector('.ps-shell-status-host.${expected}')`, `host status ${expected}`, 15000)
    console.log('host status', await js(`(() => { const el = document.querySelector('.ps-shell-status-host'); return el.className + ' · ' + el.title })()`))
    await crop(qaHost ? 'host-status-connected' : 'host-status-unavailable', '.ps-shell-status-right', 6)
  }
}

let currentScene = 'startup'
let historyImageHiddenCss
async function openWindow() {
  const w = new BrowserWindow({ width: 1380, height: 880, useContentSize: true, frame: false, show: false,
    // Same as the app's main window (src/main/index.ts): the preload is not
    // sandboxed (it reaches the host's /files over Node's http).
    webPreferences: { preload: path.join(root, 'out/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false } })
  w.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(`[${currentScene}] ${e.message}`) })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  await w.loadFile(path.join(root, 'out/renderer/index.html'))
  if (wanted.includes('history-previews')) historyImageHiddenCss = await w.webContents.insertCSS('.ch-tool-images { position: fixed !important; top: 20000px !important; }')
  return w
}

// A scene may close every window (the host keeps running); the run ends by app.exit.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_d, cb) => cb({ cancel: true }))
  setScene = (name) => { currentScene = name }
  if (qaHost) await seedHost()
  win = await openWindow()
  let failed = 0
  try {
    await until('!!document.querySelector(".tcm-shell")', 'composer ready', 15000)
    await pause(800)
    for (const [name, run] of Object.entries(scenes)) {
      if (wanted.length && !wanted.includes(name)) continue
      if (!wanted.includes(name) && name.startsWith('debug')) continue
      setScene(name)
      try { await run() } catch (err) { failed++; console.error(`scene ${name} failed: ${err.message}`); await closeEverything().catch(() => {}) }
    }
  } catch (err) { failed++; console.error(err.message); await shot('startup-failure').catch(() => {}) }
  if (errors.length) console.log('renderer console errors:\n' + [...new Set(errors)].slice(0, 20).join('\n'))
  qaHost?.kill()
  app.exit(failed ? 1 : 0)
})
