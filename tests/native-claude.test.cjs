const {test}=require('node:test')
const assert=require('node:assert/strict')
const load=require('./helpers/load-typescript.cjs')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function fixture(){
 const handlers={},calls=[],events=[],journal=[],appEvents={}
 const owner={id:1,isDestroyed:()=>false,once:()=>{},send:(channel,payload)=>events.push({channel,payload})}
 const query=({prompt,options})=>{
  let waiting,finished=false;const queue=[]
  const q={emit:(v)=>{if(waiting){const r=waiting;waiting=null;r({value:v,done:false})}else queue.push(v)},
    [Symbol.asyncIterator](){return this},next(){if(queue.length)return Promise.resolve({value:queue.shift(),done:false});if(finished)return Promise.resolve({done:true});return new Promise(r=>waiting=r)},
    close(){finished=true;waiting?.({done:true});waiting=null},isClosed(){return finished},async return(){this.close();return{done:true}},
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
  electron:{ipcMain:{on:(key,fn)=>handlers[key]=fn,handle:(key,fn)=>handlers[key]=fn},app:{on:(name,fn)=>appEvents[name]=fn}},
  child_process:{spawn:()=>{throw Error('No CLI allowed')},execSync:()=>Buffer.from('C:\\fake\\claude.exe')},
  fs:{existsSync:()=>true},'fs/promises':{readFile:()=>Promise.reject(),readdir:()=>Promise.resolve([])},os:{homedir:()=> 'C:\\fake'},path:require('node:path'),
  '../providers':{profileEnvironment:(_provider,id)=>({PROFILE:id}),providerCommand:()=>null,agentStore:repo},'./ssh':{matchesSshTarget:()=>false,getSshClient:()=>null},
  '@anthropic-ai/claude-agent-sdk':{query}
 })
 module.registerClaudeAgentHandlers()
 const send=async(id,resume,profileId='ambient-claude')=>{await handlers['agent:send']({sender:owner},{id,permissionScope:'chat',chat:{id:'chat'},prompt:'hello',cwd:'C:\\QA',model:'sonnet',effort:'high',profileId,resume});await tick()}
 return{handlers,calls,events,journal,owner,send,appEvents}
}
test('Claude sends image blocks together with the user text',async()=>{
 const f=fixture(), image={mime:'image/png',data:'aGVsbG8='}
 await f.handlers['agent:send']({sender:f.owner},{id:'image',chat:{id:'chat'},prompt:'describe',cwd:'C:\\QA',model:'opus',profileId:'ambient-claude',images:[image]})
 await tick()
 const item=await f.calls[0].prompt.next()
 assert.deepEqual(item.value.message.content,[{type:'text',text:'describe'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}])
 f.calls[0].q.close();await tick()
})

test('Claude SDK forwards live subagents and background completion without leaking their output to the parent',async()=>{
 const f=fixture();await f.send('parent-turn');const first=f.calls[0]
 assert.equal(first.options.forwardSubagentText,true)
 first.q.emit({type:'system',subtype:'init',session_id:'native',model:'sonnet'})
 first.q.emit({type:'assistant',message:{content:[{type:'tool_use',id:'spawn',name:'Agent',input:{description:'Inspecionar testes',subagent_type:'Explore'}}]}})
 first.q.emit({type:'system',subtype:'task_started',task_id:'native-child',tool_use_id:'spawn',task_type:'local_agent',description:'Inspecionar testes'})
 first.q.emit({type:'stream_event',parent_tool_use_id:'spawn',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Resposta do filho'}}})
 first.q.emit({type:'assistant',parent_tool_use_id:'spawn',message:{content:[{type:'tool_use',id:'child-read',name:'Read',input:{file_path:'test.ts'}}]}})
 first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 await f.send('next-turn','native')
 first.q.emit({type:'system',subtype:'task_notification',task_id:'native-child',status:'completed',summary:'Relatório final'})
 await tick()
 const children=f.events.filter(e=>e.channel==='agent:subagent')
 assert.ok(children.some(e=>e.payload.id==='parent-turn'&&e.payload.agent.id==='spawn'&&e.payload.agent.text==='Resposta do filho'))
 assert.ok(children.some(e=>e.payload.id==='parent-turn'&&e.payload.agent.status==='completed'&&e.payload.agent.summary==='Relatório final'))
 assert.ok(f.journal.some(e=>e.kind==='subagent'&&e.id==='parent-turn'&&e.agent.status==='completed'&&e.agent.summary==='Relatório final'))
 assert.equal(f.journal.some(e=>e.kind==='subagent'&&e.id==='next-turn'&&e.agent.id==='spawn'),false)
 assert.equal(f.events.some(e=>e.channel==='agent:text'&&e.payload.text==='Resposta do filho'),false)
 assert.equal(f.events.some(e=>e.channel==='agent:tool'&&e.payload.toolId==='child-read'),false)
 first.q.close();await tick()
})

test('Claude child messages are explicitly forwarded to the live parent using the verified native target',async()=>{
 const f=fixture();await f.send('origin-turn');const first=f.calls[0]
 await first.prompt.next() // initial parent input
 first.q.emit({type:'system',subtype:'init',session_id:'native',tools:['Task','SendMessage']})
 first.q.emit({type:'assistant',message:{content:[{type:'tool_use',id:'spawn',name:'Agent',input:{name:'reviewer',description:'Review'}}]}})
 await tick()
 const payload={rootChatId:'chat',rootTurnId:'origin-turn',agentId:'spawn',text:'Compare "a"\ncom b'}
 assert.throws(()=>f.handlers['agent:subagent-message']({sender:f.owner},payload),/destinatário nativo/)
 first.q.emit({type:'system',subtype:'task_started',task_id:'real-native-target',tool_use_id:'spawn',task_type:'local_agent'})
 await tick()
 assert.throws(()=>f.handlers['agent:subagent-message']({sender:{id:2}},payload),/não está conectada/)
 assert.throws(()=>f.handlers['agent:subagent-message']({sender:f.owner},{...payload,rootTurnId:'wrong-origin'}),/destinatário nativo/)
 const accepted=f.handlers['agent:subagent-message']({sender:f.owner},payload)
 assert.deepEqual(accepted,{delivery:'parent',rootTurnId:'origin-turn',messageTarget:'real-native-target'})
 const input=(await first.prompt.next()).value
 assert.equal(input.parent_tool_use_id,null);assert.equal(input.priority,'now')
 assert.deepEqual(JSON.parse(input.message.content.split('\n\n').at(-1)),{to:'real-native-target',message:payload.text})
 assert.ok(f.journal.some(event=>event.id==='origin-turn'&&event.segment?.kind==='user'&&event.segment.text.includes('SendMessage')))
 assert.equal(f.events.some(event=>event.channel==='agent:subagent'&&event.payload.agent.segment?.kind==='user'),false,'a parent ack is not a native child receipt')
 first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 first.q.emit({type:'system',subtype:'task_notification',task_id:'real-native-target',status:'completed'})
 first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 assert.throws(()=>f.handlers['agent:subagent-message']({sender:f.owner},payload),/principal está parado/)
 await f.send('current-parent-turn','native');await first.prompt.next()
 const later=f.handlers['agent:subagent-message']({sender:f.owner},payload)
 assert.equal(later.delivery,'parent');assert.equal(later.rootTurnId,'current-parent-turn')
 await first.prompt.next()
 first.q.emit({type:'system',subtype:'task_started',task_id:'real-native-target',tool_use_id:'new-send-message-tool',task_type:'local_agent',run_id:'002'});await tick()
 const resumed=f.events.filter(event=>event.channel==='agent:subagent').at(-1).payload
 assert.equal(resumed.id,'origin-turn');assert.equal(resumed.agent.id,'spawn')
 first.q.close();await tick()
})

test('Claude child forwarding requires SendMessage capability and respects a pending parent approval',async()=>{
 const f=fixture();await f.send('origin');const first=f.calls[0]
 first.q.emit({type:'system',subtype:'init',session_id:'native',tools:['Task']})
 first.q.emit({type:'assistant',message:{content:[{type:'tool_use',id:'spawn',name:'Agent',input:{description:'Review'}}]}})
 first.q.emit({type:'system',subtype:'task_started',task_id:'native-child',tool_use_id:'spawn',task_type:'local_agent'});await tick()
 const payload={rootChatId:'chat',rootTurnId:'origin',agentId:'spawn',text:'Continue'}
 assert.throws(()=>f.handlers['agent:subagent-message']({sender:f.owner},payload),/SendMessage/)
 first.q.emit({type:'system',subtype:'init',session_id:'native',tools:['Task','SendMessage']});await tick()
 const answer=first.options.canUseTool('Bash',{command:'echo test'},{signal:new AbortController().signal,toolUseID:'root-bash'})
 assert.throws(()=>f.handlers['agent:subagent-message']({sender:f.owner},payload),/aprovação ou pergunta/)
 const permission=f.events.filter(event=>event.channel==='agent:permission').at(-1).payload
 f.handlers['agent:permission-response']({sender:f.owner},{id:'origin',permId:permission.permId,decision:'deny'})
 await answer;first.q.close();await tick()
})

test('Claude image-only messages contain no empty text blocks',async()=>{
 const f=fixture()
 await f.handlers['agent:send']({sender:f.owner},{id:'image',chat:{id:'chat'},prompt:'',cwd:'C:\\QA',model:'opus',profileId:'ambient-claude',images:[{mime:'image/png',data:'aGVsbG8='}]})
 await tick()
 const item=await f.calls[0].prompt.next()
 assert.deepEqual(item.value.message.content,[{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}])
 f.calls[0].q.close();await tick()
})

test('Claude keeps one native input session, preserves supplied turn IDs and transfers when route changes',async()=>{
 const f=fixture();await f.send('first');assert.equal(f.calls.length,1)
 const first=f.calls[0];assert.equal(first.options.env.PROFILE,'ambient-claude')
 first.q.emit({type:'system',subtype:'init',session_id:'native',model:'sonnet'});first.q.emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'ação'}}})
 first.q.emit({type:'result',subtype:'success',session_id:'native',is_error:false});await tick()
 assert.ok(f.events.some(e=>e.channel==='agent:text'&&e.payload.id==='first'))
 await f.send('second','native');assert.equal(f.calls.length,1)
 first.q.emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'continuation'}}});first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 assert.ok(f.journal.some(e=>e.id==='second'&&e.text==='continuation'))
 await f.send('third',undefined,'claude-work');assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.env.PROFILE,'claude-work')
 f.calls[1].q.close();await tick()
})
test('Claude native permissions and stop reject a different renderer owner',async()=>{
 const f=fixture();await f.send('first');const first=f.calls[0]
 first.q.emit({type:'system',subtype:'init',session_id:'native'});await tick()
 const signal=new AbortController().signal
 const result=first.options.canUseTool('Bash',{command:'echo hi'},{signal,toolUseID:'tool'})
 const perm=f.events.find(e=>e.channel==='agent:permission').payload
 let answered=false;void result.then(()=>answered=true)
 f.handlers['agent:permission-response']({sender:{id:2}},{id:'first',permId:perm.permId,decision:'allow'});await tick();assert.equal(answered,false)
 f.handlers['agent:permission-response']({sender:f.owner},{id:'first',permId:perm.permId,decision:'allow'});assert.equal((await result).behavior,'allow')
 f.handlers['agent:abort']({sender:{id:2}},'first');await tick();assert.equal(f.events.some(e=>e.channel==='agent:done'),false)
 f.handlers['agent:abort']({sender:f.owner},'first');await tick();assert.equal(f.events.find(e=>e.channel==='agent:done').payload.aborted,true)
 first.q.close();await tick()
})

test('Claude interactive questions can be answered in first and resumed turns',async()=>{
 const f=fixture();await f.send('first');const first=f.calls[0]
 first.q.emit({type:'system',subtype:'init',session_id:'native'});await tick()
 const input={questions:[{question:'Qual modo?',header:'Modo',multiSelect:false,options:[{label:'A',description:'Primeiro'},{label:'B',description:'Segundo'}]}],metadata:'keep'}
 const answer=first.options.canUseTool('AskUserQuestion',input,{signal:new AbortController().signal,toolUseID:'ask-1'})
 const question=f.events.find(e=>e.channel==='agent:question').payload
 assert.equal(question.id,'first');assert.deepEqual(question.questions,input.questions)
 assert.equal(f.events.some(e=>e.channel==='agent:permission'),false)
 let settled=false;void answer.then(()=>settled=true)
 f.handlers['agent:question-response']({sender:{id:2}},{id:'first',dialogId:question.dialogId,answers:{'Qual modo?':'A'}})
 f.handlers['agent:question-response']({sender:f.owner},{id:'stale',dialogId:question.dialogId,answers:{'Qual modo?':'A'}})
 await tick();assert.equal(settled,false)
 f.handlers['agent:question-response']({sender:f.owner},{id:'first',dialogId:question.dialogId,answers:{'Qual modo?':'B'}})
 assert.deepEqual(await answer,{behavior:'allow',updatedInput:{...input,answers:{'Qual modo?':'B'}}})
 first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 await f.send('second','native');assert.equal(f.calls.length,1)
 const secondAnswer=first.options.canUseTool('AskUserQuestion',input,{signal:new AbortController().signal,toolUseID:'ask-2'})
 const second=f.events.filter(e=>e.channel==='agent:question').at(-1).payload
 assert.equal(second.id,'second');assert.notEqual(second.dialogId,question.dialogId)
 f.handlers['agent:question-response']({sender:f.owner},{id:'second',dialogId:second.dialogId,cancelled:true})
 assert.deepEqual(await secondAnswer,{behavior:'allow',updatedInput:input})
 first.q.close();await tick()
})

test('Claude registers question callbacks before rendering and ignores already cancelled asks',async()=>{
 const f=fixture();await f.send('live');const first=f.calls[0]
 const input={questions:[{question:'Continuar?',options:[]}]}
 const original=f.owner.send
 f.owner.send=(channel,payload)=>{
  original(channel,payload)
  if(channel==='agent:question')f.handlers['agent:question-response']({sender:f.owner},{id:'live',dialogId:payload.dialogId,answers:{'Continuar?':'Sim'}})
 }
 assert.deepEqual(await first.options.canUseTool('AskUserQuestion',input,{signal:new AbortController().signal,toolUseID:'ask'}),{behavior:'allow',updatedInput:{...input,answers:{'Continuar?':'Sim'}}})
 const aborted=new AbortController();aborted.abort()
 assert.deepEqual(await first.options.canUseTool('AskUserQuestion',input,{signal:aborted.signal,toolUseID:'cancelled'}),{behavior:'allow',updatedInput:input})
 assert.equal(f.events.filter(e=>e.channel==='agent:question').length,1)
 assert.deepEqual(await first.options.onUserDialog({dialogKind:'future_dialog',payload:{}},{signal:new AbortController().signal,requestId:'future'}),{behavior:'cancelled'})
 first.q.close();await tick()
})

test('logging in again releases the idle Claude process and old permission cache',async()=>{
 const f=fixture();await f.send('first');const original=f.calls[0]
 original.q.emit({type:'system',subtype:'init',session_id:'native'});original.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 f.appEvents['prism:profile-changed']('ambient-claude');await tick()
 await f.send('second','native');assert.equal(f.calls.length,2);assert.equal(f.calls[1].options.resume,'native')
 f.calls[1].q.close();await tick()
})

test('an immediate send after profile invalidation replaces the aborted query before publishing the next turn',async()=>{
 const f=fixture();await f.send('first');const first=f.calls[0]
 first.q.emit({type:'system',subtype:'init',session_id:'native'});first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 f.appEvents['prism:profile-changed']('ambient-claude')
 await f.send('second','native')
 assert.equal(f.calls.length,2,'a follow-up never enters the input pump of the aborted query')
 assert.equal(f.calls[1].options.resume,'native')
 assert.equal(f.calls[1].options.abortController.signal.aborted,false)
 assert.equal(f.events.some(event=>event.channel==='agent:done'&&event.payload.id==='second'),false)
 f.calls[1].q.close();await tick()
})

test('a query closed between the result and iterator cleanup is never reused',async()=>{
 const f=fixture();await f.send('first');const first=f.calls[0]
 first.q.emit({type:'system',subtype:'init',session_id:'native'});first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 first.q.close()
 await f.send('second','native')
 assert.equal(f.calls.length,2)
 assert.equal(f.calls[1].options.resume,'native')
 assert.equal(f.events.some(event=>event.channel==='agent:done'&&event.payload.id==='second'),false)
 f.calls[1].q.close();await tick()
})

test('terminal events free the native slot before an immediate next send and stay in the completed turn journal',async()=>{
 const f=fixture();await f.send('first');const first=f.calls[0]
 first.q.emit({type:'system',subtype:'init',session_id:'native'});await tick()
 const original=f.owner.send;let next
 f.owner.send=(channel,payload)=>{
  original(channel,payload)
  if(channel==='agent:result'&&payload.id==='first')next=f.send('second','native')
 }
 first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick();await next
 assert.equal(f.calls.length,1)
 assert.equal(f.events.some(event=>event.channel==='agent:error'&&event.payload.id==='second'),false)
 assert.equal(f.journal.some(event=>event.id==='second'&&event.kind==='done'),false,'the old done event cannot finish the new journal')
 first.q.emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Segunda resposta'}}});await tick()
 assert.ok(f.journal.some(event=>event.id==='second'&&event.text==='Segunda resposta'),'the next turn remains active after the previous done')
 first.q.close();await tick()
})

test('a closed SDK transport with stuck iterator cleanup releases its slot and resumes without restarting the app',async ctx=>{
 ctx.mock.timers.enable({apis:['setTimeout']})
 const f=fixture();await f.send('first');const first=f.calls[0]
 first.q.emit({type:'system',subtype:'init',session_id:'native'});first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 first.q.return=async()=>new Promise(()=>{})
 f.appEvents['prism:profile-changed']('ambient-claude')
 const next=f.send('second','native');await tick()
 ctx.mock.timers.tick(5001);await next
 assert.equal(f.calls.length,2,'only the confirmed-closed query is abandoned')
 assert.equal(f.calls[1].options.resume,'native')
 assert.equal(f.events.some(event=>event.channel==='agent:error'&&event.payload.id==='second'),false)
 f.calls[1].q.emit({type:'system',subtype:'init',session_id:'native'})
 f.calls[1].q.emit({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Recovered'}}});await tick()
 assert.ok(f.journal.some(event=>event.id==='second'&&event.text==='Recovered'))
 f.calls[1].q.close();await tick()
})

test('an SDK cleanup that never confirms closure returns an error without launching a duplicate process',async ctx=>{
 ctx.mock.timers.enable({apis:['setTimeout']})
 const f=fixture();await f.send('first');const first=f.calls[0]
 first.q.emit({type:'system',subtype:'init',session_id:'native'});first.q.emit({type:'result',subtype:'success',session_id:'native'});await tick()
 first.q.return=async()=>new Promise(()=>{})
 first.q.isClosed=()=>false
 f.appEvents['prism:profile-changed']('ambient-claude')
 const next=f.send('second','native');await tick()
 ctx.mock.timers.tick(6001);await next
 assert.ok(f.events.some(event=>event.channel==='agent:error'&&event.payload.id==='second'&&event.payload.message.includes('não encerrou a sessão anterior')))
 assert.equal(f.calls.length,1,'do not launch a duplicate native process while old cleanup is unresolved')
})

test('Claude records native cost and token metrics before terminal error events',async()=>{
 const f=fixture();await f.send('metrics');f.calls[0].q.emit({type:'result',session_id:'native',subtype:'error_during_execution',is_error:true,total_cost_usd:0.05,usage:{input_tokens:22,output_tokens:4,cache_read_input_tokens:10}});await tick()
 const metric=f.journal.find(e=>e.kind==='metrics');assert.equal(metric.metrics.costUsd,0.05);assert.equal(metric.metrics.inputTokens,22)
 assert.ok(f.journal.findIndex(e=>e.kind==='metrics')<f.journal.findIndex(e=>e.kind==='error'))
 f.appEvents['before-quit']?.()
})

test('Claude SDK steer uses now priority in the same native stream with images', async () => {
 const f=fixture(); await f.send('live'); const first=f.calls[0]
 await first.prompt.next()
 const payload={chatId:'chat',turnId:'live',messageId:'now',text:'next instruction',context:'context',images:[{mime:'image/png',data:'aGVsbG8='}]}
 assert.throws(()=>f.handlers['agent:steer']({sender:{id:99}},payload))
 f.handlers['agent:steer']({sender:f.owner},payload)
 const injected=await first.prompt.next()
 assert.equal(injected.value.priority,'now')
 assert.equal(injected.value.message.content[0].text,'next instruction\n\ncontext')
 assert.equal(injected.value.message.content[1].source.data,'aGVsbG8=')
 assert.equal(f.calls.length,1)
 assert.ok(f.journal.some(e=>e.segment?.kind==='user' && e.segment.toolId==='now'))
 first.q.close();await tick()
})
test('Claude SDK stop closes an unresponsive query and permits the next turn', async ctx => {
 ctx.mock.timers.enable({apis:['setTimeout']})
 const f=fixture();await f.send('live')
 f.calls[0].q.interrupt=async()=>{}
 f.handlers['agent:abort']({sender:f.owner},'live');await tick()
 ctx.mock.timers.tick(2001);await tick()
 assert.ok(f.events.some(e=>e.channel==='agent:done' && e.payload.id==='live' && e.payload.aborted))
 await f.send('next');assert.equal(f.calls.length,2)
 f.calls[1].q.close();await tick()
})
