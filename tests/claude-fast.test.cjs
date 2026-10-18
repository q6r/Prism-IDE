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
    close(){finished=true;waiting?.({done:true});waiting=null},async return(){this.close();return{done:true}},
    async interrupt(){this.emit({type:'result',session_id:'native',subtype:'error_during_execution',is_error:false})}}
  options.abortController.signal.addEventListener('abort',()=>q.close())
  calls.push({prompt,options,q});return q
 }
 const repo={beginRun:(chat,id)=>journal.push({kind:'begin',chat:chat.id,id}),appendEvent:(chat,id,event)=>journal.push({chat,id,...event})}
 const usage=load('src/shared/providerUsage.ts')
 const module=load('src/main/ipc/claudeAgent.ts',{
  './claudeSubagents':load('src/main/ipc/claudeSubagents.ts'),
  '../../shared/providerUsage':usage,
  electron:{ipcMain:{on:(key,fn)=>handlers[key]=fn,handle:()=>{}},app:{on:(name,fn)=>appEvents[name]=fn}},
  child_process:{spawn:()=>{throw Error('No CLI allowed')},execSync:()=>Buffer.from('C:\\fake\\claude.exe')},
  fs:{existsSync:()=>true},'fs/promises':{readFile:()=>Promise.reject(),readdir:()=>Promise.resolve([])},os:{homedir:()=> 'C:\\fake'},path:require('node:path'),
  '../providers':{profileEnvironment:(_provider,id)=>({PROFILE:id}),providerCommand:()=>null,agentStore:repo},'./ssh':{matchesSshTarget:()=>false,getSshClient:()=>null},
  '@anthropic-ai/claude-agent-sdk':{query}
 })
 module.registerClaudeAgentHandlers()
 const send=async(id,serviceTier)=>{await handlers['agent:send']({sender:owner},{id,permissionScope:'chat',chat:{id:'chat'},prompt:'hello',cwd:'C:\QA',model:'sonnet',effort:'high',profileId:'ambient-claude',serviceTier});await tick()}
 return{handlers,calls,events,journal,owner,send,appEvents}
}
test('options.settings is always { fastMode: bool }, true only for the fast tier',async()=>{
 for(const [tier,expected] of [['fast',true],['',false],[undefined,false],['flex',false],['FAST',false]]){
  const f=fixture();await f.send('t',tier)
  assert.deepEqual({...f.calls[0].options.settings},{fastMode:expected},String(tier))
  f.calls[0].q.close();await tick();f.appEvents['before-quit']?.()
 }
})
test('agent:system and agent:result carry fastMode when the SDK reports it',async()=>{
 const f=fixture();await f.send('t','fast');const q=f.calls[0].q
 q.emit({type:'system',subtype:'init',session_id:'native',fast_mode_state:'cooldown',fast_mode_disabled_reason:'rate_limit'});await tick()
 q.emit({type:'result',subtype:'success',session_id:'native',is_error:false,fast_mode_state:'on'});await tick()
 const sys=f.events.find(e=>e.channel==='agent:system').payload,res=f.events.find(e=>e.channel==='agent:result').payload
 assert.deepEqual({...sys.fastMode},{state:'cooldown',reason:'rate_limit'})
 assert.deepEqual({...res.fastMode},{state:'on',reason:undefined})
 q.close();await tick()
})
test('fastMode is undefined when the SDK does not send it (or sends a non-string state)',async()=>{
 const f=fixture();await f.send('t');const q=f.calls[0].q
 q.emit({type:'system',subtype:'init',session_id:'native',fast_mode_disabled_reason:'orphan'});await tick()
 q.emit({type:'result',subtype:'success',session_id:'native',is_error:false,fast_mode_state:42});await tick()
 assert.equal(f.events.find(e=>e.channel==='agent:system').payload.fastMode,undefined)
 assert.equal(f.events.find(e=>e.channel==='agent:result').payload.fastMode,undefined)
 q.close();await tick()
})
