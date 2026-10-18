import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { database, rootPath } from './traycerImport'
import { traycerTurn, type TraycerActivity, type TraycerAgentRecord, type TraycerTaskRecord } from '../../shared/traycerImport'
import type { SharedTurn } from '../../shared/agents'

type Row = Record<string, any>
const safeId = /^[a-zA-Z0-9_-]+$/
const json = (s: unknown): Row => typeof s === 'string' ? JSON.parse(s) : {}
function records(epicId: string): TraycerAgentRecord[] {
  const db = database(rootPath(), epicId)
  try {
    return (db.prepare("SELECT * FROM chat_projection_head WHERE lifecycle_state != 'deleted' ORDER BY created_at").all() as Row[]).map(h => {
      const settings = json(h.settings_json), tui = json(h.tui_agent_json)
      return { id: h.chat_id, parentChatId: h.parent_chat_id || undefined, title: h.title || 'Agente Traycer',
        harness: settings.harnessId || tui.harnessId || 'traycer', surface: h.tenant_kind === 'tui-agent' ? 'tui' : 'gui',
        archived: h.lifecycle_state === 'archived' || h.archived_at != null,
        // A persisted session flag is not evidence of a process running now.
        active: null, sessionState: null, hostId: h.origin_host_id, model: settings.model || tui.model }
    })
  } finally { db.close() }
}
let tasksCache: {at:number; tasks:TraycerTaskRecord[]} | undefined
export function traycerTasks(): TraycerTaskRecord[] {
  if (tasksCache && Date.now()-tasksCache.at < 30000) return tasksCache.tasks
  const root = rootPath(), state = join(root, 'host', 'epic-state'), tasks: TraycerTaskRecord[] = []
  for (const e of readdirSync(state, {withFileTypes:true})) {
    if (!e.isDirectory() || !safeId.test(e.name) || !existsSync(join(state,e.name,'chat','chat.db'))) continue
    try {
      const rows = records(e.name)
      if (rows.length) tasks.push({id:e.name,title:rows.find(r=>!r.parentChatId)?.title || `Tarefa ${e.name}`,count:rows.length})
    } catch { /* An incompatible task does not hide the remaining tasks. */ }
  }
  tasksCache={at:Date.now(),tasks}; return tasks
}
export function parseTraycerListing(stdout: string, taskId: string, saved: TraycerAgentRecord[]): TraycerActivity {
  const result = stdout.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).find(r=>r.type==='result')
  if (result?.status !== 'ok' || !Array.isArray(result.data?.agents)) throw new Error('O host do Traycer não retornou uma lista de agentes válida.')
  const agents = result.data.agents.map((r:Row) => {
    const persisted = saved.find(s=>s.id===r.id)
    return { id:r.id, parentChatId:r.parentId || undefined, title:r.title || persisted?.title || 'Agente Traycer',
      harness:r.harnessId || persisted?.harness || 'traycer', surface:r.surface,
      archived:r.archived ?? persisted?.archived ?? false,
      active:r.isLocal === true && typeof r.active==='boolean' ? r.active : null,
      sessionState:r.sessionState || null, hostId:r.hostId,
      model:r.runConfig?.model?.kind==='concrete' ? r.runConfig.model.slug : persisted?.model }
  })
  return {taskId,checkedAt:Date.now(),agents}
}
const cache = new Map<string,TraycerActivity>(), pending = new Map<string,Promise<TraycerActivity>>()
export function traycerActivity(epicId: string): Promise<TraycerActivity> {
  if (typeof epicId !== 'string' || !safeId.test(epicId)) return Promise.reject(new Error('Tarefa inválida.'))
  const old=cache.get(epicId)
  if(old && Date.now()-old.checkedAt<4000) return Promise.resolve(old)
  if(pending.has(epicId))return pending.get(epicId)!
  const work=(async()=>{
    const saved=records(epicId), sender=saved.find(r=>!r.parentChatId) || saved[0]
    if(!sender)throw new Error('Nenhum agente nesta tarefa.')
    const binary=join(homedir(),'.traycer','cli','bin',process.platform==='win32'?'traycer.exe':'traycer')
    try {
      // Official read-only command: the CLI owns credential refresh, host
      // discovery and protocol negotiation. Prism never copies its bearer.
      const stdout=await new Promise<string>((resolve,reject)=>execFile(existsSync(binary)?binary:'traycer',['agent','list','--json','--quiet'],{
        windowsHide:true,timeout:12000,maxBuffer:4*1024*1024,encoding:'utf8',
        env:{...process.env,TRAYCER_EPIC_ID:epicId,TRAYCER_AGENT_ID:sender.id}
      },(err,out)=>err?reject(new Error('Não foi possível consultar o host. Abra o Traycer e confira o login da CLI.')):resolve(out)))
      const result=parseTraycerListing(stdout,epicId,saved);cache.set(epicId,result);return result
    }catch(err){const result={taskId:epicId,checkedAt:Date.now(),agents:saved,error:(err as Error).message};cache.set(epicId,result);return result}
  })().finally(()=>pending.delete(epicId))
  pending.set(epicId,work);return work
}
export function traycerTranscript(epicId:string,chatId:string): SharedTurn[] {
  if(typeof chatId!=='string' || !safeId.test(chatId))throw new Error('Chat inválido.')
  const db=database(rootPath(),epicId)
  try {
    const h=db.prepare("SELECT settings_json,tui_agent_json FROM chat_projection_head WHERE chat_id=? AND lifecycle_state != 'deleted'").get(chatId) as Row | undefined
    if(!h)throw new Error('Conversa não disponível neste computador.')
    const harness=json(h.settings_json).harnessId || json(h.tui_agent_json).harnessId
    return (db.prepare('SELECT body FROM chat_message WHERE chat_id=? AND removed_seq IS NULL ORDER BY insert_seq DESC LIMIT 80').all(chatId) as Row[])
      .reverse().map(row=>traycerTurn(JSON.parse(row.body),harness==='codex'?'codex':'claude')).filter((t):t is SharedTurn=>!!t)
  }finally{db.close()}
}
export function registerTraycerLiveHandlers():void {
  ipcMain.handle('traycer:tasks',()=>traycerTasks())
  ipcMain.handle('traycer:activity',(_e,id:string)=>traycerActivity(id))
  ipcMain.handle('traycer:transcript',(_e,epic:string,chat:string)=>traycerTranscript(epic,chat))
}
