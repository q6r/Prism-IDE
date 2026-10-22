const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const load=require('./helpers/load-typescript.cjs')
const tick=()=>new Promise(resolve=>setImmediate(resolve))

const dir='src/renderer/src/lib/usageAnalytics/'
const labels=load('src/shared/modelLabels.ts')
const models=load(dir+'models.ts',{'../../../../shared/modelLabels':labels})
const time=load(dir+'time.ts')
const agg=load(dir+'aggregate.ts',{'./time':time})
const exp=load(dir+'exportData.ts',{'./aggregate':agg,'./time':time})
const pu=load('src/shared/providerUsage.ts')

let n=0
function fact(o={}){n++;const {tokens,...rest}=o
 return{id:`f${n}`,source:'prism',chatId:'c',turnId:`t${n}`,chatTitle:'Chat',taskId:null,taskTitle:null,project:null,provider:'claude',model:'opus',profileId:'p',profileName:'Conta',
  occurredAt:Date.UTC(2026,9,9,12)+n*1000,startedAt:Date.UTC(2026,9,9,12),durationMs:500,outcome:'completed',prismChatId:null,costUsd:null,measured:true,tokenBasis:'turn',
  tokens:{input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0,...tokens},...rest}}

/* ---------------- modelLabels ---------------- */
test('claudeIdLabel reads resolved ids',()=>{
 const l=labels.claudeIdLabel
 assert.equal(l('claude-opus-5-5'),'Opus 5.5')
 assert.equal(l('claude-sonnet-5'),'Sonnet 5')
 assert.equal(l('claude-haiku-4-5-20251001'),'Haiku 4.5')
 assert.equal(l('claude-3-5-sonnet-20241022'),'Sonnet 3.5')
 assert.equal(l('claude-fable-5-1[1m]'),'Fable 5.1 (1M context)')
 assert.equal(l('opus'),'Opus')
 assert.equal(l('default'),'default')
 assert.equal(l('some-weird_id'),'some-weird_id')
 assert.equal(l('gpt-6.1-sol'),'gpt-6.1-sol')
})
test('claudeModelLabel / codexModelLabel keep their labels',()=>{
 const c=labels.claudeModelLabel
 assert.equal(c({value:'default',displayName:'Default (recommended)',description:'Opus 5.5 - best'}),'Default (Opus 5.5)')
 assert.equal(c({value:'opus',displayName:'Opus',description:'Opus 5.5 · most capable'}),'Opus 5.5')
 assert.equal(c({value:'opus[1m]',displayName:'Opus (1M context)',description:'Opus 5.5 with 1M'}),'Opus 5.5 (1M context)')
 assert.equal(c({value:'x',displayName:'Custom'}),'Custom')
 assert.equal(labels.codexModelLabel('gpt-6.1-sol'),'GPT-6.1-Sol')
 assert.equal(labels.codexModelLabel('gpt-6-luna','Whatever'),'GPT-6-Luna')
 assert.equal(labels.codexModelLabel('other','Nice'),'Nice')
 assert.equal(labels.codexModelLabel('other'),'other')
})

/* ---------------- usageAnalytics/models ---------------- */
const catalog=[
 {provider:'claude',id:'default',label:'Default (Opus 5.5)',default:true},
 {provider:'claude',id:'opus',label:'Opus 5.5'},
 {provider:'codex',id:'gpt-6-luna',label:'GPT-6-Luna',default:true}]
test('buildModelNames keys, default row and first-wins',()=>{
 const names=models.buildModelNames(catalog)
 assert.equal(names.get('claude:default'),'Default (Opus 5.5)')
 assert.equal(names.get('claude:'),'Default (Opus 5.5)')
 assert.equal(names.get('claude:opus'),'Opus 5.5')
 assert.equal(names.get('codex:gpt-6-luna'),'GPT-6-Luna')
 assert.equal(names.get('codex:'),'GPT-6-Luna')
 const clash=models.buildModelNames([
  {provider:'claude',id:'opus',label:'First'},{provider:'claude',id:'opus',label:'Second'},
  {provider:'claude',id:'a',label:'A1',default:true},{provider:'claude',id:'b',label:'B1',default:true}])
 assert.equal(clash.get('claude:opus'),'First')
 assert.equal(clash.get('claude:'),'A1')
})
test('canonicalModelLabel',()=>{
 assert.equal(models.canonicalModelLabel('Default (Opus 5.5)'),'Opus 5.5')
 assert.equal(models.canonicalModelLabel('  default (opus 5.5) '),'opus 5.5')
 assert.equal(models.canonicalModelLabel('  Opus 5.5 '),'Opus 5.5')
 assert.equal(models.canonicalModelLabel('Default'),'Default')
})
test('modelLabel with a catalog',()=>{
 const names=models.buildModelNames(catalog),l=(p,i)=>models.modelLabel(p,i,names)
 for(const id of ['opus','default','','claude-opus-5-5'])assert.equal(l('claude',id),id==='claude-opus-5-5'?'Opus 5.5':'Opus 5.5',id)
 assert.equal(l('claude','opus[1m]'),'Opus 5.5 (1M context)')
 assert.equal(l('claude','claude-opus-5-5[1m]'),'Opus 5.5 (1M context)')
 assert.equal(l('codex',''),'GPT-6-Luna')
 assert.equal(l('codex','gpt-6.1-sol'),'GPT-6.1-Sol')
})
test('modelLabel without a catalog',()=>{
 const none=new Map(),l=(p,i)=>models.modelLabel(p,i,none)
 assert.equal(l('claude','default'),'Padrão');assert.equal(l('claude',''),'Padrão');assert.equal(l('claude','opus'),'Opus')
 assert.equal(l('claude','claude-opus-5-5'),'Opus 5.5')
 assert.equal(l('opencode','some/model'),'some/model');assert.equal(l('opencode',''),'Padrão')
})
test('labelModels adds modelLabel and keeps the rest',()=>{
 const names=models.buildModelNames(catalog)
 const facts=[fact({model:'opus'}),fact({model:'claude-opus-5-5'}),fact({provider:'codex',model:''})]
 const out=models.labelModels(facts,names)
 assert.deepEqual(out.map(f=>f.modelLabel),['Opus 5.5','Opus 5.5','GPT-6-Luna'])
 out.forEach((f,i)=>{const {modelLabel,...rest}=f;assert.deepEqual(rest,facts[i])})
 assert.equal('modelLabel' in facts[0],false)
})

/* ---------------- aggregate ---------------- */
test('model dimension groups by label',()=>{
 const a=fact({model:'opus',modelLabel:'Opus 5.5',tokens:{input:10}}),b=fact({model:'claude-opus-5-5',modelLabel:'Opus 5.5',tokens:{input:5}})
 const v=agg.dimensionValue(a,'model')
 assert.deepEqual(v,{key:'claude/opus 5.5',label:'Opus 5.5',detail:'Claude'})
 assert.equal(agg.dimensionValue(b,'model').key,v.key)
 const rows=agg.buildBreakdown([a,b],'model','tokens','UTC')
 assert.equal(rows.length,1);assert.equal(rows[0].turns,2);assert.equal(rows[0].value,15);assert.equal(rows[0].label,'Opus 5.5')
 const raw=agg.buildBreakdown([fact({model:'opus'}),fact({model:'claude-opus-5-5'})],'model','turns','UTC')
 assert.equal(raw.length,2)
 assert.equal(agg.dimensionValue(fact({model:'opus'}),'model').label,'opus')
 assert.equal(agg.dimensionValue(fact({model:''}),'model').label,'Padrão')
 assert.notEqual(agg.dimensionValue(fact({provider:'codex',modelLabel:'Opus 5.5'}),'model').key,v.key)
})

/* ---------------- exportData ---------------- */
test('CSV and JSON export carry label and raw id',()=>{
 const f=fact({model:'opus',modelLabel:'Opus 5.5'})
 const lines=exp.factsToCsv([f],'UTC').slice(1).split('\r\n'),head=lines[0].split(','),row=lines[1].split(',')
 const i=head.indexOf('modelo')
 assert.ok(i>=0);assert.equal(head[i+1],'modelo_id');assert.equal(head[i-1],'provedor')
 assert.equal(row[i],'Opus 5.5');assert.equal(row[i+1],'opus')
 const bare=exp.factsToCsv([fact({model:'raw'})],'UTC').slice(1).split('\r\n')[1].split(',')
 assert.equal(bare[i],'raw');assert.equal(bare[i+1],'raw')
 const window={from:'2026-10-09',to:'2026-10-09',days:1,granularity:'hour'}
 const json=JSON.parse(exp.buildUsageJson({facts:[f],window,timeZone:'UTC',filters:{},metric:'tokens',totals:agg.summarize([f],'UTC'),generatedAt:Date.UTC(2026,9,9,12)}))
 assert.equal(json.turns[0].model,'opus');assert.equal(json.turns[0].modelLabel,'Opus 5.5')
})

/* ---------------- providerUsage ---------------- */
test('claudeMetrics records the model only when it is a non-empty string',()=>{
 assert.equal(pu.claudeMetrics({model:'claude-opus-5-5'}).model,'claude-opus-5-5')
 for(const v of ['',undefined,null,5,{},['x']])assert.equal('model' in pu.claudeMetrics({model:v}),false,String(v))
 assert.equal('model' in pu.claudeMetrics({}),false)
})

/* ---------------- claudeAgent ---------------- */
function fixture(){
 const handlers={},calls=[],events=[],journal=[],appEvents={}
 const owner={id:1,isDestroyed:()=>false,once:()=>{},send:(channel,payload)=>events.push({channel,payload})}
 const query=({prompt,options})=>{
  let waiting,finished=false;const queue=[]
  const q={emit:(v)=>{if(waiting){const r=waiting;waiting=null;r({value:v,done:false})}else queue.push(v)},
    [Symbol.asyncIterator](){return this},next(){if(queue.length)return Promise.resolve({value:queue.shift(),done:false});if(finished)return Promise.resolve({done:true});return new Promise(r=>waiting=r)},
    close(){finished=true;waiting?.({done:true});waiting=null},async return(){this.close();return{done:true}},
    async interrupt(){this.emit({type:'result',session_id:'native',subtype:'error_during_execution',is_error:false})}}
  options.abortController.signal.addEventListener('abort',()=>q.close())
  calls.push({prompt,options,q});return q
 }
 const repo={beginRun:(chat,id)=>journal.push({kind:'begin',chat:chat.id,id}),appendEvent:(chat,id,event)=>journal.push({chat,id,...event})}
 const module=load('src/main/ipc/claudeAgent.ts',{
  './claudeSubagents':load('src/main/ipc/claudeSubagents.ts'),
  './claudeTurnLifecycle':load('src/main/ipc/claudeTurnLifecycle.ts'),
  '../../shared/providerUsage':pu,
  electron:{ipcMain:{on:(key,fn)=>handlers[key]=fn,handle:()=>{}},app:{on:(name,fn)=>appEvents[name]=fn}},
  child_process:{spawn:()=>{throw Error('No CLI allowed')},execSync:()=>Buffer.from('C:\\fake\\claude.exe')},
  fs:{existsSync:()=>true},'fs/promises':{readFile:()=>Promise.reject(),readdir:()=>Promise.resolve([])},os:{homedir:()=> 'C:\\fake'},path:require('node:path'),
  '../providers':{profileEnvironment:(_provider,id)=>({PROFILE:id}),providerCommand:()=>null,agentStore:repo},'./ssh':{matchesSshTarget:()=>false,getSshClient:()=>null},
  '@anthropic-ai/claude-agent-sdk':{query}
 })
 module.registerClaudeAgentHandlers()
 const send=async(id)=>{await handlers['agent:send']({sender:owner},{id,permissionScope:'chat',chat:{id:'chat'},prompt:'hello',cwd:'C:\\QA',model:'sonnet',effort:'high',profileId:'ambient-claude'});await tick()}
 return{calls,events,journal,send}
}
test('Claude: result and journal metrics carry the model system/init resolved, not the alias asked for',async()=>{
 const f=fixture();await f.send('first')
 assert.equal(f.calls[0].options.model,'sonnet')
 const q=f.calls[0].q
 q.emit({type:'system',subtype:'init',session_id:'native',model:'claude-opus-5-5'})
 q.emit({type:'result',subtype:'success',session_id:'native',is_error:false,modelUsage:{m:{inputTokens:1,outputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:0,costUSD:0.1}},total_cost_usd:0.1});await tick()
 const r=f.events.find(e=>e.channel==='agent:result'&&e.payload.id==='first')?.payload
 assert.equal(r.model,'claude-opus-5-5')
 const m=f.journal.find(e=>e.kind==='metrics'&&e.id==='first')?.metrics
 assert.equal(m.model,'claude-opus-5-5')
 q.close();await tick()
})

/* ---------------- usage.ts ---------------- */
const usage=load('src/main/ipc/usage.ts',{
 electron:{app:{getPath:()=>os.tmpdir(),getAppPath:()=>process.cwd(),on(){}},BrowserWindow:{},ipcMain:{},shell:{},clipboard:{},nativeImage:{},dialog:{}},
 fs,path,'node:sqlite':{DatabaseSync:class{}},'../providers':{agentStore:{get:()=>[]},profiles:()=>[]},'./traycerImport':{},'../hostChats':{},'../host/supervisor':{}
})
test('prismObservations prefers metrics.model over the chosen turn.model',()=>{
 const turn=(id,extra)=>({id,role:'assistant',provider:'claude',startedAt:1000,completedAt:2000,...extra})
 const chat={id:'c',title:'T',cwd:'C:\\p\\Prism',updatedAt:5,selection:{provider:'claude',profileId:'p1'},pendingTurnId:null,
  turns:[turn('a',{model:'sonnet',metrics:{scope:'session',model:'claude-opus-5-5'}}),turn('b',{model:'sonnet',metrics:{scope:'session'}}),turn('c',{model:'sonnet'}),turn('d',{metrics:{scope:'session'}})]}
 const obs=usage.prismObservations([chat],[],new Map(),new Map())
 assert.deepEqual(obs.map(o=>o.model),['claude-opus-5-5','sonnet','sonnet',''])
})
