const {test}=require('node:test')
const assert=require('node:assert/strict')
const load=require('./helpers/load-typescript.cjs')
const tick=()=>new Promise(r=>setImmediate(r))

test('Codex image-only input sends native image items in the same turn', async () => {
 const f=fixture(), image={mime:'image/png',data:'aGVsbG8='}
 await f.send('image',{prompt:'',images:[image]})
 const input=f.servers[0].calls.find(c=>c.method==='turn/start').params.input
 assert.deepEqual(input,[{type:'text',text:'',text_elements:[]},{type:'image',url:'data:image/png;base64,aGVsbG8='}])
})

test('Codex child threads stream separately, keep nested links and retain their original turn after root completion', async () => {
 const f=fixture();await f.send('first');const s=f.servers[0]
 const spawn={id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',senderThreadId:'thread-0',receiverThreadIds:['child'],agentsStates:{child:{status:'running'}},prompt:'Revisar mudanças',model:'test-model',status:'completed'}
 s.message('item/completed',{threadId:'thread-0',turnId:'native-2',item:spawn})
 s.message('thread/started',{thread:{id:'child',agentNickname:'Ada',source:{subAgent:{thread_spawn:{parent_thread_id:'thread-0',depth:1}}}}})
 s.message('turn/started',{threadId:'child',turn:{id:'child-turn'}})
 s.message('item/started',{threadId:'child',turnId:'child-turn',item:{id:'reply',type:'agentMessage',text:''}})
 s.message('item/agentMessage/delta',{threadId:'child',turnId:'child-turn',itemId:'reply',delta:'Analisando os arquivos…'})
 s.message('thread/started',{thread:{id:'nested',source:{subAgent:{thread_spawn:{parent_thread_id:'child',depth:2,agent_path:'/root/review/tests'}}}}})
 const first=f.events.filter(e=>e.payload.kind==='subagent').map(e=>e.payload)
 assert.ok(first.some(e=>e.id==='first'&&e.agent.id==='child'&&e.agent.description==='Revisar mudanças'&&e.agent.model==='test-model'))
 assert.ok(first.some(e=>e.agent.id==='child'&&e.agent.name==='Ada'))
 assert.ok(first.some(e=>e.agent.id==='nested'&&e.agent.parentId==='child'))
 assert.ok(first.some(e=>e.agent.segment?.text==='Analisando os arquivos…'))
 assert.equal(f.events.filter(e=>e.payload.kind==='segment'&&e.payload.segment?.text?.includes('Analisando')).length,0,'child text never enters the parent reply')
 s.message('turn/completed',{threadId:'thread-0',turn:{id:'native-2',status:'completed'}})
 s.message('item/agentMessage/delta',{threadId:'child',turnId:'child-turn',itemId:'reply',delta:' concluído'})
 await f.send('second',{resume:'thread-0'})
 s.message('turn/completed',{threadId:'child',turn:{id:'child-turn',status:'completed'}})
 const terminal=f.events.filter(e=>e.payload.kind==='subagent'&&e.payload.agent.id==='child').at(-1).payload
 assert.equal(terminal.id,'first');assert.equal(terminal.agent.status,'completed')
 assert.ok(f.journal.some(e=>e.kind==='subagent'&&e.id==='first'&&e.agent.segment?.text==='Analisando os arquivos… concluído'))
 assert.equal(f.events.filter(e=>e.payload.id==='second'&&e.payload.kind==='done').length,0,'child completion does not finish the next root turn')
 s.message('thread/started',{thread:{id:'stranger',source:{subAgent:{thread_spawn:{parent_thread_id:'unrelated',depth:1}}}}})
 s.message('item/agentMessage/delta',{threadId:'stranger',itemId:'x',delta:'Do not leak'})
 assert.equal(f.events.filter(e=>e.payload.kind==='subagent'&&e.payload.agent.id==='stranger').length,0)
})

test('Codex child approval stays on its originating active turn and closing the server stops unfinished children', async () => {
 const f=fixture();await f.send('first');const s=f.servers[0]
 s.message('thread/started',{thread:{id:'child',source:{subAgent:{thread_spawn:{parent_thread_id:'thread-0',depth:1}}}}})
 s.message('item/commandExecution/requestApproval',{threadId:'child',turnId:'child-turn',itemId:'cmd',command:'npm test'},51)
 const approval=f.events.find(e=>e.channel==='agent:permission').payload
 assert.equal(approval.id,'first')
 f.handlers['codex:permission']({sender:f.owner},'chat',approval.permId,'allow');assert.deepEqual(s.answers.at(-1),{id:51,result:{decision:'accept'}})
 s.close()
 assert.equal(f.events.filter(e=>e.payload.kind==='subagent'&&e.payload.agent.id==='child').at(-1).payload.agent.status,'stopped')
})

test('Codex listAgents refreshes known states without registering unrelated threads or reviving stale child turns', async () => {
 const f=fixture();await f.send('first');const s=f.servers[0]
 s.message('thread/started',{thread:{id:'child',source:{subAgent:{thread_spawn:{parent_thread_id:'thread-0',depth:1}}}}})
 s.message('turn/started',{threadId:'child',turn:{id:'old'}})
 s.message('turn/completed',{threadId:'child',turn:{id:'old',status:'completed'}})
 s.message('turn/started',{threadId:'child',turn:{id:'new'}})
 s.message('turn/completed',{threadId:'child',turn:{id:'old',status:'completed'}})
 assert.equal(f.events.filter(e=>e.payload.kind==='subagent'&&e.payload.agent.id==='child').at(-1).payload.agent.status,'running')
 s.message('item/completed',{threadId:'thread-0',turnId:'native-2',item:{id:'list',type:'collabAgentToolCall',tool:'listAgents',senderThreadId:'thread-0',receiverThreadIds:[],agentsStates:{child:{status:'completed',message:'Resultado completo'},stranger:{status:'running'}},status:'completed'}})
 const updates=f.events.filter(e=>e.payload.kind==='subagent').map(e=>e.payload.agent)
 assert.ok(updates.some(e=>e.id==='child'&&e.status==='completed'))
 assert.ok(updates.some(e=>e.id==='child'&&e.summary==='Resultado completo'))
 assert.ok(!updates.some(e=>e.id==='stranger'))
})
const realCommands=load('src/main/ipc/agentCommands.ts',{
 electron:{ipcMain:{handle(){}},app:{on(){}}},fs:{promises:{}},os:{homedir:()=>'/home/x'},path:require('node:path'),
 '../codexServer':{CodexServer:class{}},'../providers':{profileEnvironment(){},providerCommand(){}}
})
function fixture(){
 const skillState={cache:null,calls:[]}
 const handlers={},servers=[],events=[],journal=[],appEvents={},appHandlers={},windows=[]
 class Server {
  constructor(profile,cwd){this.profile=profile;this.cwd=cwd;this.ready=Promise.resolve();this.calls=[];this.answers=[];servers.push(this)}
  async request(method,params){this.calls.push({method,params});if(method.startsWith('thread/'))return{thread:{id:params.threadId||`thread-${servers.indexOf(this)}`}};return{turn:{id:`native-${this.calls.length}`}}}
  message(method,params,id){this.onMessage({method,params,...(id!==undefined?{id}: {})})}
  answer(id,result){this.answers.push({id,result})} reject(id){this.answers.push({id,rejected:true})}
  close(){this.closed=true;this.onClose?.(new Error('closed'))}
 }
 const owner={id:1,isDestroyed:()=>false,send:(channel,payload)=>events.push({channel,payload}),once:()=>{}}
 const repo={beginRun:(chat,id)=>journal.push({chat:chat.id,id,kind:'begin'}),appendEvent:(chat,id,event)=>journal.push({chat,id,...event})}
 const usage=load('src/shared/providerUsage.ts')
 const module=load('src/main/ipc/nativeCodex.ts',{
  '../../shared/providerUsage':usage,
  './codexSubagents':load('src/main/ipc/codexSubagents.ts'),
  electron:{ipcMain:{on:(name,fn)=>handlers[name]=fn,handle:(name,fn)=>handlers[name]=fn},app:{on:(name,fn)=>{appEvents[name]=fn;(appHandlers[name]||=[]).push(fn)}},BrowserWindow:{getAllWindows:()=>windows}},
  './agentCommands':{cachedCodexSkills:(profileId,cwd)=>{skillState.calls.push({profileId,cwd});return skillState.cache},codexSkillInputs:realCommands.codexSkillInputs},
  '../codexServer':{CodexServer:Server},'../providers':{agentStore:repo,getProfile:(provider,id)=>{if(provider!=='codex'||id==='missing')throw Error('Invalid profile');return{id}}}
 });module.registerNativeCodexHandlers()
 const send=(id='turn',extra={})=>handlers['codex:send']({sender:owner},{id,chatId:'chat',cwd:'C:\\QA',prompt:'hello',selection:{provider:'codex',profileId:'ambient-codex',model:'native-model',effort:'high',permissionMode:'default'},chat:{id:'chat'},...extra})
 return{...module,skillState,handlers,servers,events,journal,owner,send,appEvents,appHandlers,windows,repo}
}
test('native Codex starts once, resumes same thread and changes routes with a fresh process',async()=>{
 const f=fixture();await f.send();let s=f.servers[0]
 assert.equal(s.calls[0].method,'thread/start');assert.equal(s.calls[1].method,'turn/start')
 assert.equal(s.calls[1].params.approvalPolicy,'on-request');assert.deepEqual(s.calls[1].params.sandboxPolicy,{type:'readOnly'})
 s.message('turn/completed',{threadId:'thread-0',turn:{status:'completed'}})
 await f.send('second',{resume:'thread-0'})
 assert.equal(f.servers.length,1);assert.equal(s.calls[2].method,'turn/start')
 s.message('turn/completed',{threadId:'thread-0',turn:{status:'completed'}})
 await f.send('third');assert.equal(f.servers.length,2);assert.equal(s.closed,true)
 assert.equal(f.servers[1].calls[0].method,'thread/start')
})
test('native notifications replace items, stream Unicode, journal effects and terminal failures once',async()=>{
 const f=fixture();await f.send();const s=f.servers[0],threadId='thread-0',turnId=s.calls[1]&&'native-2'
 s.message('item/started',{threadId,turnId,item:{id:'m',type:'agentMessage',text:''}})
 s.message('item/agentMessage/delta',{threadId,turnId,itemId:'m',delta:'ação🙂'})
 s.message('item/completed',{threadId,turnId,item:{id:'b',type:'commandExecution',command:'migrate',exitCode:0,aggregatedOutput:'SIDE_EFFECT'}})
 s.message('error',{threadId,turnId,error:{message:'Rate limit'},willRetry:true})
 assert.equal(f.events.filter(e=>e.payload.kind==='error').length,0)
 s.message('turn/completed',{threadId,turn:{status:'failed',error:{message:'Rate limit'}}})
 assert.equal(f.events.filter(e=>e.payload.kind==='error').length,1)
 assert.ok(f.journal.some(e=>e.segment?.text==='ação🙂'));assert.ok(f.journal.some(e=>e.segment?.result==='SIDE_EFFECT'))
})
test('native approvals, question ids, abort and duplicate sends are scoped to owner and active turn',async()=>{
 const f=fixture();await f.send();const s=f.servers[0]
 s.message('item/commandExecution/requestApproval',{threadId:'thread-0',turnId:'native-2',itemId:'b',command:'echo hi'},9)
 const perm=f.events.find(e=>e.channel==='agent:permission').payload
 f.handlers['codex:permission']({sender:{id:99}},'chat',perm.permId,'allow');assert.equal(s.answers.length,0)
 f.handlers['codex:permission']({sender:f.owner},'chat',perm.permId,'allow_always');assert.deepEqual(s.answers[0],{id:9,result:{decision:'acceptForSession'}})
 s.message('item/tool/requestUserInput',{threadId:'thread-0',questions:[{id:'q1',question:'Which?',header:'Mode',options:[{label:'A',description:'A'}]}]},10)
 const q=f.events.find(e=>e.channel==='agent:question').payload
 f.handlers['codex:question']({sender:f.owner},'chat',q.dialogId,{'Which?':'A'});assert.deepEqual(s.answers[1].result,{answers:{q1:{answers:['A']}}})
 s.message('item/permissions/requestApproval',{threadId:'thread-0',itemId:'grant',permissions:{network:{enabled:true}}},11)
 const grant=f.events.filter(e=>e.channel==='agent:permission').at(-1).payload
 f.handlers['codex:permission']({sender:f.owner},'chat',grant.permId,'deny')
 assert.deepEqual(s.answers[2].result,{permissions:{},scope:'turn'})
 await f.send('duplicate');assert.equal(f.servers.length,1);assert.ok(f.events.some(e=>e.payload.id==='duplicate'&&e.payload.kind==='error'))
 f.handlers['codex:abort']({sender:{id:99}},'chat');assert.equal(s.calls.filter(c=>c.method==='turn/interrupt').length,0)
 f.handlers['codex:abort']({sender:f.owner},'chat');await tick();assert.equal(s.calls.at(-1).method,'turn/interrupt')
})

test('Codex exposes structured questions in Default mode and preserves async question metadata without a pending RPC',async()=>{
 const f=fixture();await f.send();const s=f.servers[0]
 assert.equal(s.calls.find(call=>call.method==='thread/start').params.developerInstructions,undefined,'profile developer instructions stay in the native configuration')
 const item={id:'async-q',type:'agentMessage',text:'Qual uso está sem cálculo?',questions:[{title:'Qual uso está sem cálculo?',options:['Tokens/contexto','Limites da conta','Os dois']},{title:'Detalhes',options:null},{title:'',options:['invalid']}]}
 s.message('item/completed',{threadId:'thread-0',turnId:'native-2',item})
 const segment=f.events.filter(event=>event.payload.kind==='segment').at(-1).payload.segment
 assert.deepEqual(segment.questions,[{title:'Qual uso está sem cálculo?',options:['Tokens/contexto','Limites da conta','Os dois']},{title:'Detalhes'}])
 assert.equal(f.events.filter(event=>event.channel==='agent:question').length,0,'async questions are answered with a message rather than a nonexistent request')
 assert.deepEqual(f.journal.find(event=>event.segment?.toolId==='async-q').segment.questions,segment.questions,'questions survive reopen in the run journal')
})

test('native Codex question uses ids, accepts free text and rejects empty malformed requests instead of hanging',async()=>{
 const f=fixture();await f.send();const s=f.servers[0]
 s.message('item/tool/requestUserInput',{threadId:'thread-0',turnId:'native-2',itemId:'question-call',questions:[{questionId:'usage',question:'Qual uso?',options:null},{id:'details',question:'Detalhes',options:[]}]},30)
 const question=f.events.find(event=>event.channel==='agent:question').payload
 assert.equal(question.toolUseId,'question-call');assert.equal(question.questions[0].id,'usage');assert.deepEqual(question.questions[0].options,[])
 f.handlers['codex:question']({sender:f.owner},'chat',question.dialogId,{usage:'Os dois',details:'Texto livre'})
 assert.deepEqual(s.answers.at(-1),{id:30,result:{answers:{usage:{answers:['Os dois']},details:{answers:['Texto livre']}}}})
 s.message('item/tool/requestUserInput',{threadId:'thread-0',questions:null},31)
 assert.deepEqual(s.answers.at(-1),{id:31,rejected:true})
 assert.equal(f.events.filter(event=>event.channel==='agent:question').length,1)
})

test('logging in again invalidates the idle Codex process before the next turn',async()=>{
 const f=fixture();await f.send();const original=f.servers[0]
 original.message('turn/completed',{threadId:'thread-0',turn:{status:'completed'}})
 f.appEvents['prism:profile-changed']('ambient-codex');assert.equal(original.closed,true)
 await f.send('second',{resume:'thread-0'});assert.equal(f.servers.length,2);assert.equal(f.servers[1].calls[0].method,'thread/resume')
})

test('Codex token telemetry stays scoped to the active thread and is journaled',async()=>{
 const f=fixture();await f.send();const s=f.servers[0]
 s.message('thread/tokenUsage/updated',{threadId:'wrong',tokenUsage:{total:{totalTokens:999}}})
 assert.equal(f.events.filter(e=>e.payload.kind==='metrics').length,0)
 s.message('thread/tokenUsage/updated',{threadId:'thread-0',tokenUsage:{total:{totalTokens:20,inputTokens:12,outputTokens:8,cachedInputTokens:4},modelContextWindow:200000}})
 const m=f.events.find(e=>e.payload.kind==='metrics').payload.metrics
 assert.equal(m.totalTokens,20);assert.equal(m.scope,'session');assert.equal(m.contextWindow,200000)
 assert.equal(f.journal.find(e=>e.kind==='metrics').metrics.cachedTokens,4)
 s.message('turn/completed',{threadId:'thread-0',turn:{status:'completed'}})
})

test('turn/start input is only the text item when no skills are cached',async()=>{
 const f=fixture();await f.send('t',{prompt:'use $pdf agora'})
 const input=f.servers[0].calls.find(c=>c.method==='turn/start').params.input
 assert.deepEqual(input,[{type:'text',text:'use $pdf agora',text_elements:[]}])
})
test('turn/start adds structured skill items for cached $skills and keeps the text',async()=>{
 const f=fixture();f.skillState.cache=[{name:'pdf',path:'/s/pdf/SKILL.md'}]
 await f.send('t',{prompt:'use $pdf agora'})
 const input=f.servers[0].calls.find(c=>c.method==='turn/start').params.input
 assert.deepEqual(input,[{type:'text',text:'use $pdf agora',text_elements:[]},{type:'skill',name:'pdf',path:'/s/pdf/SKILL.md'}])
})
test('cachedCodexSkills receives profileId and cwd of the payload',async()=>{
 const f=fixture();await f.send()
 assert.deepEqual(f.skillState.calls,[{profileId:'ambient-codex',cwd:'C:\\QA'}])
})
test('cached skills not mentioned in the prompt add no items',async()=>{
 const f=fixture();f.skillState.cache=[{name:'pdf',path:'/s/pdf/SKILL.md'}]
 await f.send()
 assert.equal(f.servers[0].calls.find(c=>c.method==='turn/start').params.input.length,1)
})

test('host bridge: the journal handlers left with T07 (the host journals its own turns)',()=>{
 const f=fixture()
 assert.equal(f.handlers['codex:journal-begin'],undefined);assert.equal(f.handlers['codex:journal'],undefined)
})
test('host bridge: prism:profile-changed notifies only live windows, besides closing idle processes',async()=>{
 const f=fixture();const sent=[]
 f.windows.push({webContents:{isDestroyed:()=>false,send:(...a)=>sent.push(['a',...a])}},{webContents:{isDestroyed:()=>true,send:(...a)=>sent.push(['b',...a])}})
 assert.equal(f.appHandlers['prism:profile-changed'].length,2)
 f.appHandlers['prism:profile-changed'][0]('p1')
 assert.deepEqual(sent,[['a','codex:profile-changed','p1']])
})

test('native steering uses the existing turn and journals the accepted message', async () => {
 const f=fixture(); await f.send('live'); const s=f.servers[0]
 const payload={messageId:'m-now',chatId:'chat',turnId:'live',text:'new instruction',context:'file context',images:[{mime:'image/png',data:'aGVsbG8='}]}
 await assert.rejects(f.handlers['codex:steer']({sender:{id:99}},payload))
 await f.handlers['codex:steer']({sender:f.owner},payload)
 assert.deepEqual(s.calls.find(c=>c.method==='turn/steer').params,{
   threadId:'thread-0', expectedTurnId:'native-2',
   input:[{type:'text',text:'new instruction\n\nfile context',text_elements:[]},{type:'image',url:'data:image/png;base64,aGVsbG8='}]
 })
 assert.equal(s.calls.filter(c=>c.method==='turn/start').length,1)
 assert.ok(f.journal.some(e=>e.segment?.kind==='user' && e.segment.toolId==='m-now'))
})
test('native stop escalates if the process never completes interruption', async ctx => {
 ctx.mock.timers.enable({apis:['setTimeout']})
 const f=fixture();await f.send('live');const s=f.servers[0]
 f.handlers['codex:abort']({sender:f.owner},'chat');await tick()
 ctx.mock.timers.tick(2001);await tick()
 assert.equal(s.closed,true)
 assert.equal(f.events.filter(e=>e.payload.kind==='done').at(-1).payload.aborted,true)
 assert.equal(f.events.filter(e=>e.payload.kind==='error').length,0)
 await f.send('next');assert.equal(f.servers.length,2)
})
