const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const load=require('./helpers/load-typescript.cjs')

test('context uses the last call, never cumulative session counters', () => {
  const { codexMetrics, claudeContext, claudeMetrics } = load('src/shared/providerUsage.ts')
  assert.equal(codexMetrics({ total: { inputTokens: 900000 }, last: { inputTokens: 1200, outputTokens: 300 }, modelContextWindow: 272000 }).contextTokens, 1500)
  const context = claudeContext({ input_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 30, output_tokens: 10 }, { opus: { contextWindow: 200000 } }, 'opus')
  assert.deepEqual(context, { contextTokens: 160, contextWindow: 200000 })
  assert.equal(claudeMetrics({ usage: { input_tokens: 99999 }, ...context }).contextTokens, 160)
  assert.deepEqual(claudeContext(undefined, undefined), {})
})
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const pu=load('src/shared/providerUsage.ts')
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`)

/* ---------------- providerUsage ---------------- */
test('claudeMetrics keeps cache writes and forwards only clean turn fields',()=>{
 const m=pu.claudeMetrics({usage:{input_tokens:1,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4},
  turn:{inputTokens:10,outputTokens:-1,cacheReadTokens:NaN,cacheWriteTokens:0,reasoningTokens:Infinity,costUsd:0.25,junk:5}})
 assert.equal(m.cacheWriteTokens,4);assert.equal(m.cachedTokens,3)
 assert.deepEqual(m.turn,{inputTokens:10,cacheWriteTokens:0,costUsd:0.25})
 assert.equal('turn' in pu.claudeMetrics({usage:{}}),false)
 assert.equal('turn' in pu.claudeMetrics({turn:{}}),false)
 assert.equal('turn' in pu.claudeMetrics({turn:{inputTokens:-5,outputTokens:NaN}}),false)
})
test('codexMetrics turn is optional and sanitized',()=>{
 const td={total:{inputTokens:5,outputTokens:2,cachedInputTokens:1,reasoningOutputTokens:1,totalTokens:7},modelContextWindow:100}
 assert.equal('turn' in pu.codexMetrics(td),false)
 assert.equal('turn' in pu.codexMetrics(td,{}),false)
 assert.deepEqual(pu.codexMetrics(td,{inputTokens:3,outputTokens:-1,reasoningTokens:2}).turn,{inputTokens:3,reasoningTokens:2})
 assert.equal(pu.codexMetrics(td).totalTokens,7)
})
const result=(models,extra={})=>({modelUsage:models,...extra})
const mu=(i,o,cr,cw,th,cost)=>({inputTokens:i,outputTokens:o,cacheReadInputTokens:cr,cacheCreationInputTokens:cw,...(th===undefined?{}:{thinkingTokens:th}),costUSD:cost})
test('claudeTotals sums models, thinking is null when unreported, total_cost_usd wins',()=>{
 assert.equal(pu.claudeTotals({}),null);assert.equal(pu.claudeTotals({modelUsage:null}),null);assert.equal(pu.claudeTotals({modelUsage:{}}),null)
 const t=pu.claudeTotals(result({a:mu(100,50,1000,200,10,0.5),b:mu(10,5,100,20,4,0.25)}))
 assert.deepEqual({...t,cost:undefined},{input:110,cacheRead:1100,cacheWrite:220,output:55,thinking:14,cost:undefined});near(t.cost,0.75)
 assert.equal(pu.claudeTotals(result({a:mu(1,1,1,1,undefined,0.1)})).thinking,null)
 assert.equal(pu.claudeTotals(result({a:mu(1,1,1,1,undefined,0.1),b:mu(1,1,1,1,3,0.1)})).thinking,3)
 assert.equal(pu.claudeTotals(result({a:mu(1,1,1,1,1,0.1)},{total_cost_usd:2})).cost,2)
 assert.equal(pu.claudeTotals(result({a:mu(1,1,1,1,1,0.1)},{total_cost_usd:NaN})).cost,0.1)
})
test('claudeTurnUsage: fresh session is the whole total, cost included',()=>{
 const r=result({a:mu(100,50,1000,200,10,0.5)},{total_cost_usd:0.5})
 const {turn,next}=pu.claudeTurnUsage(r,pu.NO_CLAUDE_TOTALS)
 assert.deepEqual(turn,{inputTokens:100,cacheReadTokens:1000,cacheWriteTokens:200,outputTokens:50,reasoningTokens:10,costUsd:0.5})
 assert.equal(next.input,100);assert.equal(next.cost,0.5)
})
test('claudeTurnUsage: known base gives the difference, with reasoning',()=>{
 const base=pu.claudeTotals(result({a:mu(100,50,1000,200,10,0.5)}))
 const {turn,next}=pu.claudeTurnUsage(result({a:mu(160,90,1500,250,14,0.8)}),base)
 assert.equal(turn.inputTokens,60);assert.equal(turn.outputTokens,40);assert.equal(turn.cacheReadTokens,500);assert.equal(turn.cacheWriteTokens,50)
 assert.equal(turn.reasoningTokens,4);near(turn.costUsd,0.3);near(next.cost,0.8)
})
test('claudeTurnUsage: unknown base falls back to result.usage without cost',()=>{
 const r=result({a:mu(160,90,1500,250,14,0.8)},{usage:{input_tokens:7,cache_read_input_tokens:8,cache_creation_input_tokens:9,output_tokens:6},total_cost_usd:0.8})
 const {turn,next}=pu.claudeTurnUsage(r,null)
 assert.deepEqual(turn,{inputTokens:7,cacheReadTokens:8,cacheWriteTokens:9,outputTokens:6});assert.equal('costUsd' in turn,false)
 assert.equal(next.input,160)
})
test('claudeTurnUsage: totals below base fall back without cost and replace the base',()=>{
 const base=pu.claudeTotals(result({a:mu(500,500,500,500,5,5)}))
 const r=result({a:mu(10,10,10,10,1,0.1)},{usage:{input_tokens:1,output_tokens:2}})
 const {turn,next}=pu.claudeTurnUsage(r,base)
 assert.deepEqual(turn,{inputTokens:1,outputTokens:2});assert.equal(next.input,10);near(next.cost,0.1)
})
test('claudeTurnUsage: zeroed result after a spent base keeps the base',()=>{
 const base=pu.claudeTotals(result({a:mu(100,50,0,0,0,0.5)}))
 const {turn,next}=pu.claudeTurnUsage(result({a:mu(0,0,0,0,0,0)}),base)
 assert.equal(next,base)
 // totals are not below... they are, so it falls back; with no result.usage there is no turn
 assert.equal(turn,undefined)
})
test('claudeTurnUsage: no modelUsage keeps the base and falls back',()=>{
 const base=pu.claudeTotals(result({a:mu(100,50,0,0,0,0.5)}))
 const {turn,next}=pu.claudeTurnUsage({usage:{input_tokens:3,output_tokens:4}},base)
 assert.equal(next,base);assert.deepEqual(turn,{inputTokens:3,outputTokens:4})
 assert.equal(pu.claudeTurnUsage({},null).turn,undefined)
})
test('codexSubtract and codexTurnUsage',()=>{
 const d=pu.codexSubtract({totalTokens:10,inputTokens:8},{totalTokens:4,outputTokens:1})
 assert.deepEqual(d,{totalTokens:6,inputTokens:8,cachedInputTokens:0,outputTokens:-1,reasoningOutputTokens:0})
 const base={totalTokens:20,inputTokens:12,cachedInputTokens:4,outputTokens:8,reasoningOutputTokens:2}
 const total={totalTokens:50,inputTokens:30,cachedInputTokens:14,outputTokens:20,reasoningOutputTokens:5}
 assert.deepEqual(pu.codexTurnUsage(base,total),{inputTokens:8,cacheReadTokens:10,outputTokens:12,reasoningTokens:3})
 assert.equal(pu.codexTurnUsage(total,base),undefined)
 assert.equal(pu.codexTurnUsage({...base,outputTokens:99},total),undefined)
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
 const usage=load('src/shared/providerUsage.ts')
 const module=load('src/main/ipc/claudeAgent.ts',{
  './claudeSubagents':load('src/main/ipc/claudeSubagents.ts'),
  './claudeTurnLifecycle':load('src/main/ipc/claudeTurnLifecycle.ts'),
  '../../shared/providerUsage':usage,
  electron:{ipcMain:{on:(key,fn)=>handlers[key]=fn,handle:()=>{}},app:{on:(name,fn)=>appEvents[name]=fn}},
  child_process:{spawn:()=>{throw Error('No CLI allowed')},execSync:()=>Buffer.from('C:\\fake\\claude.exe')},
  fs:{existsSync:()=>true},'fs/promises':{readFile:()=>Promise.reject(),readdir:()=>Promise.resolve([])},os:{homedir:()=> 'C:\\fake'},path:require('node:path'),
  '../providers':{profileEnvironment:(_provider,id)=>({PROFILE:id}),providerCommand:()=>null,agentStore:repo},'./ssh':{matchesSshTarget:()=>false,getSshClient:()=>null},
  '@anthropic-ai/claude-agent-sdk':{query}
 })
 module.registerClaudeAgentHandlers()
 const send=async(id,resume,profileId='ambient-claude')=>{await handlers['agent:send']({sender:owner},{id,permissionScope:'chat',chat:{id:'chat'},prompt:'hello',cwd:'C:\\QA',model:'sonnet',effort:'high',profileId,resume});await tick()}
 return{handlers,calls,events,journal,owner,send,appEvents}
}
const claudeResult=(q,models,extra={})=>{q.emit({type:'system',subtype:'init',session_id:'native',model:'sonnet'});q.emit({type:'result',subtype:'success',session_id:'native',is_error:false,modelUsage:models,...extra})}
const resultOf=(f,id)=>f.events.find(e=>e.channel==='agent:result'&&e.payload.id===id)?.payload
const metricsOf=(f,id)=>f.journal.find(e=>e.kind==='metrics'&&e.id===id)?.metrics
test('Claude: new session turn is the whole total; next turn is the difference',async()=>{
 const f=fixture();await f.send('first')
 claudeResult(f.calls[0].q,{'claude-opus':mu(100,50,1000,200,10,0.5)},{total_cost_usd:0.5});await tick()
 const t1=resultOf(f,'first').turn
 assert.deepEqual(t1,{inputTokens:100,cacheReadTokens:1000,cacheWriteTokens:200,outputTokens:50,reasoningTokens:10,costUsd:0.5})
 assert.deepEqual(metricsOf(f,'first').turn,t1)
 await f.send('second','native');assert.equal(f.calls.length,1)
 claudeResult(f.calls[0].q,{'claude-opus':mu(160,90,1500,250,14,0.8)},{total_cost_usd:0.8});await tick()
 const t2=resultOf(f,'second').turn
 assert.equal(t2.inputTokens,60);assert.equal(t2.outputTokens,40);assert.equal(t2.cacheReadTokens,500);assert.equal(t2.cacheWriteTokens,50);assert.equal(t2.reasoningTokens,4);near(t2.costUsd,0.3)
 assert.deepEqual(metricsOf(f,'second').turn,t2)
 f.calls[0].q.close();await tick()
})
test('Claude: resume of an unknown session uses result.usage and has no cost',async()=>{
 const f=fixture();await f.send('x','old');assert.equal(f.calls[0].options.resume,'old')
 claudeResult(f.calls[0].q,{'claude-opus':mu(900,900,900,900,9,9)},{total_cost_usd:9,usage:{input_tokens:5,output_tokens:6,cache_read_input_tokens:7,cache_creation_input_tokens:8}});await tick()
 const t=resultOf(f,'x').turn
 assert.deepEqual(t,{inputTokens:5,cacheReadTokens:7,cacheWriteTokens:8,outputTokens:6});assert.equal('costUsd' in t,false)
 f.calls[0].q.close();await tick()
})
test('Claude: after a profile change the new query resumes from the totals seen for the session',async()=>{
 for(const [models,withCost] of [[mu(150,80,1100,230,12,0.7),true],[mu(10,10,10,10,1,0.1),false]]){
  const f=fixture();await f.send('first')
  claudeResult(f.calls[0].q,{m:mu(100,50,1000,200,10,0.5)},{total_cost_usd:0.5});await tick()
  f.appEvents['prism:profile-changed']('ambient-claude');await tick()
  await f.send('second','native');assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.resume,'native')
  claudeResult(f.calls[1].q,{m:models},{total_cost_usd:models.costUSD,usage:{input_tokens:1,output_tokens:2}});await tick()
  const t=resultOf(f,'second').turn
  if(withCost){assert.equal(t.inputTokens,50);assert.equal(t.outputTokens,30);assert.equal(t.cacheReadTokens,100);assert.equal(t.cacheWriteTokens,30);near(t.costUsd,0.2)}
  else{assert.deepEqual(t,{inputTokens:1,outputTokens:2});assert.equal('costUsd' in t,false)}
  f.calls[1].q.close();await tick()
 }
})

/* ---------------- nativeCodex ---------------- */
const realCommands=load('src/main/ipc/agentCommands.ts',{
 electron:{ipcMain:{handle(){}},app:{on(){}}},fs:{promises:{}},os:{homedir:()=>'/home/x'},path:require('node:path'),
 '../codexServer':{CodexServer:class{}},'../providers':{profileEnvironment(){},providerCommand(){}}
})
function codexFixture(){
 const handlers={},servers=[],events=[],journal=[],appEvents={}
 class Server {
  constructor(profile,cwd){this.profile=profile;this.cwd=cwd;this.ready=Promise.resolve();this.calls=[];this.answers=[];servers.push(this)}
  async request(method,params){this.calls.push({method,params});if(method.startsWith('thread/'))return{thread:{id:params.threadId||`thread-${servers.indexOf(this)}`}};return{turn:{id:`native-${this.calls.length}`}}}
  message(method,params,id){this.onMessage({method,params,...(id!==undefined?{id}: {})})}
  answer(id,result){this.answers.push({id,result})} reject(id){this.answers.push({id,rejected:true})}
  close(){this.closed=true;this.onClose?.(new Error('closed'))}
 }
 const owner={id:1,isDestroyed:()=>false,send:(channel,payload)=>events.push({channel,payload}),once:()=>{}}
 const repo={beginRun:(chat,id)=>journal.push({chat:chat.id,id,kind:'begin'}),appendEvent:(chat,id,event)=>journal.push({chat,id,...event})}
 const module=load('src/main/ipc/nativeCodex.ts',{
  './codexSubagents':load('src/main/ipc/codexSubagents.ts'),
  '../codexTurnLifecycle':load('src/main/codexTurnLifecycle.ts'),
  '../../shared/providerUsage':pu,
  electron:{ipcMain:{on:(name,fn)=>handlers[name]=fn,handle:()=>{}},app:{on:(name,fn)=>appEvents[name]=fn}},
  './agentCommands':{cachedCodexSkills:()=>null,codexSkillInputs:realCommands.codexSkillInputs},
  '../codexServer':{CodexServer:Server},'../providers':{agentStore:repo,getProfile:(provider,id)=>({id})}
 });module.registerNativeCodexHandlers()
 const send=(id='turn',extra={})=>handlers['codex:send']({sender:owner},{id,chatId:'chat',cwd:'C:\\QA',prompt:'hello',selection:{provider:'codex',profileId:'ambient-codex',model:'native-model',effort:'high',permissionMode:'default'},chat:{id:'chat'},...extra})
 return{servers,events,journal,send}
}
const bd=(total,input,cached,output,reasoning)=>({totalTokens:total,inputTokens:input,cachedInputTokens:cached,outputTokens:output,reasoningOutputTokens:reasoning})
const metricEvents=(f)=>f.events.filter(e=>e.payload.kind==='metrics').map(e=>e.payload.metrics)
test('Codex: turn is the total minus the pre-turn base, repeats are idempotent, next turn uses last total',async()=>{
 const f=codexFixture();await f.send();const s=f.servers[0]
 // first update: base = total - last = bd(60,40,10,20,3)
 s.message('thread/tokenUsage/updated',{threadId:'thread-0',tokenUsage:{total:bd(100,70,20,30,5),last:bd(40,30,10,10,2)}})
 s.message('thread/tokenUsage/updated',{threadId:'thread-0',tokenUsage:{total:bd(130,90,30,40,8),last:bd(30,20,10,10,3)}})
 let m=metricEvents(f)
 assert.deepEqual(m[0].turn,{inputTokens:20,cacheReadTokens:10,outputTokens:10,reasoningTokens:2})
 assert.deepEqual(m[1].turn,pu.codexTurnUsage(bd(60,40,10,20,3),bd(130,90,30,40,8)))
 assert.deepEqual(m[1].turn,{inputTokens:30,cacheReadTokens:20,outputTokens:20,reasoningTokens:5})
 s.message('thread/tokenUsage/updated',{threadId:'thread-0',tokenUsage:{total:bd(130,90,30,40,8),last:bd(30,20,10,10,3)}})
 m=metricEvents(f);assert.deepEqual(m[2].turn,m[1].turn)
 assert.deepEqual(f.journal.filter(e=>e.kind==='metrics').at(-1).metrics.turn,m[1].turn)
 s.message('turn/completed',{threadId:'thread-0',turn:{status:'completed'}})
 await f.send('second',{resume:'thread-0'})
 s.message('thread/tokenUsage/updated',{threadId:'thread-0',tokenUsage:{total:bd(160,110,35,50,9)}})
 const t=metricEvents(f).at(-1).turn
 assert.deepEqual(t,pu.codexTurnUsage(bd(130,90,30,40,8),bd(160,110,35,50,9)))
 assert.deepEqual(t,{inputTokens:15,cacheReadTokens:5,outputTokens:10,reasoningTokens:1})
})
test('Codex: first update of the process without last has no turn',async()=>{
 const f=codexFixture();await f.send();const s=f.servers[0]
 s.message('thread/tokenUsage/updated',{threadId:'thread-0',tokenUsage:{total:bd(20,12,4,8,0)}})
 const m=metricEvents(f)[0];assert.equal(m.totalTokens,20);assert.equal('turn' in m,false)
})

/* ---------------- usage.ts ---------------- */
const usage=load('src/main/ipc/usage.ts',{
 electron:{app:{getPath:()=>os.tmpdir(),getAppPath:()=>process.cwd(),on(){}},BrowserWindow:{},ipcMain:{},shell:{},clipboard:{},nativeImage:{},dialog:{}},
 fs,path,'node:sqlite':{DatabaseSync:class{}},'../providers':{agentStore:{get:()=>[]},profiles:()=>[]},'./traycerImport':{},'../hostChats':{},'../host/supervisor':{}
})
test('prismCounters: turn metrics take precedence',()=>{
 const withCost=usage.prismCounters('claude',{scope:'session',inputTokens:999,costUsd:9,turn:{inputTokens:1,cacheReadTokens:2,cacheWriteTokens:3,outputTokens:4,reasoningTokens:5,costUsd:0.5}})
 assert.deepEqual(withCost,{tokenBasis:'turn',costBasis:'turn',inputTokens:1,cacheReadTokens:2,cacheWriteTokens:3,outputTokens:4,reasoningTokens:5,costUsd:0.5})
 const noCost=usage.prismCounters('claude',{scope:'session',costUsd:9,turn:{inputTokens:1}})
 assert.equal(noCost.tokenBasis,'turn');assert.equal(noCost.costBasis,'none');assert.equal(noCost.costUsd,null);assert.equal(noCost.outputTokens,null)
 const codex=usage.prismCounters('codex',{scope:'session',inputTokens:50,cachedTokens:10,turn:{inputTokens:4,cacheReadTokens:1}})
 assert.equal(codex.tokenBasis,'turn');assert.equal(codex.costBasis,'none');assert.equal(codex.inputTokens,4)
 assert.equal(usage.prismCounters('codex',{scope:'session',inputTokens:50,cachedTokens:10}).tokenBasis,'cumulative')
})
test('inlineFontCss inlines Figtree from the repo and is empty without the package',()=>{
 const css=usage.inlineFontCss([process.cwd()])
 assert.equal((css.match(/data:font\/woff2/g)||[]).length,2);assert.equal(css.includes('url(./'),false)
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'prism-font-'))
 try{assert.equal(usage.inlineFontCss([tmp]),'');assert.equal(usage.inlineFontCss([tmp,process.cwd()]).includes('data:font/woff2'),true)}
 finally{fs.rmSync(tmp,{recursive:true,force:true})}
})

/* ---------------- aggregate ---------------- */
const time=load('src/renderer/src/lib/usageAnalytics/time.ts')
const agg=load('src/renderer/src/lib/usageAnalytics/aggregate.ts',{'./time':time})
let n=0
function fact(o={}){n++;const {tokens,...rest}=o
 return{id:`f${n}`,source:'prism',chatId:'c',turnId:`t${n}`,chatTitle:'Chat',taskId:null,taskTitle:null,project:null,provider:'claude',model:'opus',profileId:'p',profileName:'Conta',
  occurredAt:1000*n,startedAt:1000*n-500,durationMs:500,outcome:'completed',prismChatId:null,costUsd:null,measured:true,tokenBasis:'turn',
  tokens:{input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0,...tokens},...rest}}
test('chatKeyOf joins a Traycer chat to its Prism copy',()=>{
 assert.equal(agg.chatKeyOf(fact({source:'traycer',chatId:'tc',prismChatId:'pc'})),'prism:pc')
 assert.equal(agg.chatKeyOf(fact({source:'traycer',chatId:'tc'})),'traycer:tc')
 assert.equal(agg.chatKeyOf(fact({source:'prism',chatId:'pc'})),'prism:pc')
})
test('buildChatRows merges linked Prism and Traycer chats; summarize counts the conversation once',()=>{
 const facts=[
  fact({source:'prism',chatId:'pc',prismChatId:'pc',chatTitle:'Do Prism',tokens:{input:10}}),
  fact({source:'prism',chatId:'pc',prismChatId:'pc',chatTitle:'Do Prism',tokens:{input:5}}),
  fact({source:'traycer',chatId:'tc',prismChatId:'pc',chatTitle:'Do Traycer',tokens:{input:100}}),
  fact({source:'traycer',chatId:'other',tokens:{input:1}})]
 const rows=agg.buildChatRows(facts,'tokens')
 assert.equal(rows.length,2)
 const r=rows.find(x=>x.key==='prism:pc')
 assert.equal(r.turns,3);assert.deepEqual([...r.sources],['prism','traycer']);assert.equal(r.title,'Do Prism');assert.equal(r.prismChatId,'pc');assert.equal(r.chatId,'pc');assert.equal(r.tokens.input,115)
 assert.equal(agg.summarize(facts,'UTC').chats,2)
})
