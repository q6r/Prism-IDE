const test=require('node:test'),assert=require('node:assert/strict'),load=require('./helpers/load-typescript.cjs')
const shared=load('src/shared/traycerImport.ts')
function fixture({fail=false}={}){
 const calls=[], heads=[{chat_id:'parent',title:'Parent',settings_json:'{"harnessId":"codex"}',created_at:1,lifecycle_state:'active'},{chat_id:'child',parent_chat_id:'parent',title:'Child',settings_json:'{"harnessId":"claude"}',created_at:2,lifecycle_state:'active',session_state:'running'}]
 const api=load('src/main/ipc/traycerLive.ts',{
  electron:{ipcMain:{}},child_process:{execFile:(binary,args,options,cb)=>{calls.push({binary,args,options});setTimeout(()=>cb(fail?new Error('offline'):null,JSON.stringify({type:'result',status:'ok',data:{agents:[{id:'parent',title:'Parent',harnessId:'codex',surface:'gui',parentId:null,isLocal:true,active:true},{id:'child',title:'Child',harnessId:'claude',surface:'gui',parentId:'parent',isLocal:true,active:false},{id:'remote',title:'Remote',harnessId:'codex',surface:'tui',isLocal:false,active:false}]}})),5)}},
  fs:{existsSync:()=>true,readdirSync:()=>[{name:'task',isDirectory:()=>true}]},path:require('path'),os:require('os'),
  './traycerImport':{rootPath:()=>'/fake',database:(_root,id)=>{assert.match(id,/^[a-zA-Z0-9_-]+$/);return {close(){},prepare(sql){return {all:()=>heads}}}}},'../../shared/traycerImport':shared
 })
 return {api,calls}
}
test('live listing coalesces requests, queries the official CLI without shell, keeps hierarchy and remote unknown',async()=>{
 const {api,calls}=fixture()
 const [a,b]=await Promise.all([api.traycerActivity('task'),api.traycerActivity('task')])
 assert.equal(calls.length,1);assert.deepEqual(calls[0].args,['agent','list','--json','--quiet']);assert.equal(calls[0].options.shell,undefined)
 assert.equal(calls[0].options.windowsHide,true);assert.equal(calls[0].options.env.TRAYCER_EPIC_ID,'task');assert.equal(calls[0].options.env.TRAYCER_AGENT_ID,'parent')
 assert.equal(a.agents[0].active,true);assert.equal(a.agents[1].parentChatId,'parent');assert.equal(a.agents[1].active,false);assert.equal(a.agents[2].active,null);assert.equal(a,b)
 await api.traycerActivity('task');assert.equal(calls.length,1)
 await assert.rejects(api.traycerActivity('../escape'),/inválida/);assert.equal(calls.length,1)
})
test('offline host returns unknown activity rather than trusting persisted running flags',async()=>{
 const {api}=fixture({fail:true}),result=await api.traycerActivity('task')
 assert.ok(result.error);assert.equal(result.agents.length,2);assert.equal(result.agents[1].active,null);assert.equal(result.agents[1].sessionState,null)
})
test('listing rejects failed protocol responses and distinguishes archived from sleeping',()=>{
 const {api}=fixture()
 assert.throws(()=>api.parseTraycerListing('{"type":"result","status":"error"}','task',[]),/válida/)
 const r=api.parseTraycerListing(JSON.stringify({type:'result',status:'ok',data:{agents:[{id:'a',isLocal:true,active:false,sessionState:'sleeping',archived:false},{id:'b',isLocal:true,active:false,sessionState:'stopped',archived:true}]}}),'task',[])
 assert.equal(r.agents[0].sessionState,'sleeping');assert.equal(r.agents[0].archived,false);assert.equal(r.agents[1].archived,true)
})
