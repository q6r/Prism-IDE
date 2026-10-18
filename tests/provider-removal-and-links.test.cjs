const {test}=require('node:test')
const assert=require('node:assert/strict')
const load=require('./helpers/load-typescript.cjs')
const m=load('src/main/ipc/providerProfiles.ts')

const BROKEN='Conta vinculada ao Traycer indisponível: reative-a no Traycer ou desvincule.'
const LINKED='Esta conta usa o login do Traycer. Entre pelo Traycer ou desvincule para entrar no Prism.'
const STOP='Pare as tarefas desta conta antes de fazer login novamente.'

test('unprobedStatus',()=>{
 assert.equal(m.BROKEN_LINK_STATUS,BROKEN);assert.equal(m.LINKED_LOGIN_REFUSAL,LINKED)
 assert.deepEqual(m.unprobedStatus(false,'none',true),{installed:true,loggedIn:false,detail:'Desativada'})
 assert.deepEqual(m.unprobedStatus(false,'broken',false),{installed:false,loggedIn:false,detail:'Desativada'})
 assert.deepEqual(m.unprobedStatus(true,'broken',false),{installed:false,loggedIn:false,detail:BROKEN})
 assert.equal(m.unprobedStatus(true,'linked',true),null)
 assert.equal(m.unprobedStatus(true,'none',true),null)
})

const chat=(profileId,pending)=>({selection:{profileId,provider:'codex'},pendingTurnId:pending})
test('loginRefusal priority order',()=>{
 const f=m.loginRefusal
 const prof={id:'p1',ambient:true,credentialLink:{},}
 assert.equal(f(prof,[chat('p1','t1')],true),STOP)
 assert.match(f({id:'p1',ambient:true,credentialLink:{}},[],true),/conta do terminal/)
 assert.equal(f({id:'p1',credentialLink:{}},[],true),LINKED)
 assert.equal(f({id:'p1',credentialLink:{broken:true}},[],false),LINKED)
 assert.equal(f({id:'p1'},[],true),'O login desta conta já está aberto.')
 assert.equal(f({id:'p1'},[],false),null)
 assert.equal(f({id:'p1'},[chat('p2','t1'),chat('p1',undefined)],false),null)
})

test('runProfileRemoval keeps the exact order and awaits endLogin',async()=>{
 const log=[]
 const result=await m.runProfileRemoval({
  retire:()=>log.push('retire'),announce:()=>log.push('announce'),
  endLogin:()=>new Promise(r=>{log.push('endLogin:start');setTimeout(()=>{log.push('endLogin:done');r()},20)}),
  removeFolder:async()=>{log.push('removeFolder');return 'trashed'}})
 assert.equal(result,'trashed')
 assert.deepEqual(log,['retire','announce','endLogin:start','endLogin:done','removeFolder'])
})
test('runProfileRemoval does not remove the folder when endLogin rejects',async()=>{
 const log=[]
 await assert.rejects(m.runProfileRemoval({retire:()=>log.push('retire'),announce:()=>log.push('announce'),
  endLogin:async()=>{throw new Error('stuck')},removeFolder:async()=>{log.push('removeFolder')}}),/stuck/)
 assert.deepEqual(log,['retire','announce'])
})

test('trash folder names',()=>{
 assert.equal(m.trashFolderName('abc_1',123.9),'.trash-abc_1-123')
 assert.equal(m.isTrashFolderName('.trash-abc_1-123'),true)
 for(const bad of ['abc','.trash-','.trash-../x-1','.trash-a b-1','.trash-abc-','.trash-abc-1x','trash-abc-1'])assert.equal(m.isTrashFolderName(bad),false,bad)
 for(const id of ['abc','a-b','A_1','profile-9'])assert.equal(m.isTrashFolderName(m.trashFolderName(id,1790000000000.5)),true,id)
})

function ops({rmFail=false,renameFail=false}={}){
 const calls={rm:[],rename:[]}
 return{calls,join:(...p)=>p.join('/'),
  rm:async(p)=>{calls.rm.push(p);if(rmFail)throw Object.assign(new Error('busy'),{code:'EBUSY'})},
  rename:async(a,b)=>{calls.rename.push([a,b]);if(renameFail)throw new Error('no')}}
}
test('removeProfileFolder: removed, trashed, kept',async()=>{
 let o=ops()
 assert.equal(await m.removeProfileFolder('base','id',o,5),'removed')
 assert.deepEqual(o.calls.rm,['base/id']);assert.equal(o.calls.rename.length,0)
 o=ops({rmFail:true})
 assert.equal(await m.removeProfileFolder('base','id',o,5.7),'trashed')
 assert.deepEqual(o.calls.rename,[['base/id','base/.trash-id-5']])
 o=ops({rmFail:true,renameFail:true})
 assert.equal(await m.removeProfileFolder('base','id',o,5),'kept')
})
test('removeProfileFolder refuses unsafe ids',async()=>{
 for(const id of ['../x','a/b','.','..','',' a'])
 {const o=ops();assert.equal(await m.removeProfileFolder('base',id,o,1),'kept',id);assert.equal(o.calls.rm.length,0);assert.equal(o.calls.rename.length,0)}
})

test('purgeProfileTrash only deletes trash and removed ids',async()=>{
 const o=ops()
 const n=await m.purgeProfileTrash('base',['.trash-a-1','live','gone','../evil','a/b','.trash-bad name-1','.trash-b_2-99'],o,new Set(['gone','../evil','a/b']))
 assert.equal(n,3)
 assert.deepEqual(o.calls.rm,['base/.trash-a-1','base/gone','base/.trash-b_2-99'])
 const o2=ops();assert.equal(await m.purgeProfileTrash('base',['live','other'],o2),0);assert.equal(o2.calls.rm.length,0)
})
test('purgeProfileTrash continues after a failing rm',async()=>{
 const calls=[]
 const n=await m.purgeProfileTrash('base',['.trash-a-1','.trash-b-2','.trash-c-3'],{join:(...p)=>p.join('/'),
  rm:async(p)=>{calls.push(p);if(p.endsWith('-2'))throw new Error('locked')}})
 assert.equal(n,2);assert.equal(calls.length,3)
})
