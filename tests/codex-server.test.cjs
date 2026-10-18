const {test}=require('node:test'),assert=require('node:assert/strict')
const {EventEmitter}=require('node:events')
const load=require('./helpers/load-typescript.cjs')
function fixture(){
 const writes=[],spawns=[]
 const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter()
 child.stdin.write=text=>writes.push(JSON.parse(text));child.kill=()=>{};child.pid=undefined
 const {CodexServer}=load('src/main/codexServer.ts',{
  child_process:{spawn:(bin,args,options)=>{spawns.push({bin,args,options});return child}},string_decoder:require('node:string_decoder'),
  './providers':{providerCommand:()=>({bin:'native-codex',args:[]}),profileEnvironment:(_p,id)=>({PROFILE:id})}
 },{platform:'linux'})
 const server=new CodexServer('managed','/qa'),feed=(object)=>{for(const byte of Buffer.from(JSON.stringify(object)+'\n'))child.stdout.emit('data',Buffer.from([byte]))}
 return{server,child,writes,spawns,feed}
}
test('App Server initialize handshake, literal JSONRPC and split UTF8 preserve data',async()=>{
 const f=fixture();assert.equal(f.writes[0].method,'initialize');f.feed({id:f.writes[0].id,result:{}});await f.server.ready
 assert.equal(f.writes[1].method,'initialized');assert.ok(f.spawns[0].args.includes('stdio://'))
 assert.ok(f.spawns[0].args.includes('cli_auth_credentials_store="file"'))
 assert.ok(f.spawns[0].args.includes('features.default_mode_request_user_input=true'))
 assert.ok(f.spawns[0].args.includes('tools.experimental_request_user_input.enabled=true'))
 const reply=f.server.request('model/list',{literal:'$(no-shell)'}),request=f.writes.at(-1)
 f.feed({id:request.id,result:{text:'ação🙂'}});assert.equal((await reply).text,'ação🙂')
 let received;f.server.onMessage=msg=>received=msg;f.feed({method:'item/agentMessage/delta',params:{delta:'ç🙂'}})
 assert.equal(received.params.delta,'ç🙂');f.child.emit('close',0)
})
test('closing rejects pending requests but reports native closure only after the process exits',async()=>{
 const f=fixture();f.feed({id:f.writes[0].id,result:{}});await f.server.ready
 let closed=0;f.server.onClose=()=>closed++
 const pending=f.server.request('turn/start',{});f.server.close();await assert.rejects(pending,/encerrado/)
 assert.equal(closed,0);f.child.emit('close',0);assert.equal(closed,1)
})
