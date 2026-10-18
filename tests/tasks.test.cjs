const {test}=require('node:test'),assert=require('node:assert/strict')
const load=require('./helpers/load-typescript.cjs'),{create}=require('zustand')
test('task tabs retain independent chats, drafts and unsaved editor contents, including same workspace tasks',async()=>{
 const savedWindow=global.window
 const saves=[]
 global.window={prism:{tasks:{load:async()=>({tasks:[],openIds:[],activeId:null}),save:async(...args)=>saves.push(args),flush:()=>({ok:true})},chats:{save:async()=>true},terminal:{setCwd:async()=>{}}},addEventListener:()=>{}}
 const useStore=create(()=>({folderPath:null,folderName:'',workspaceFolders:[],workspaceFile:null,tabs:[],activePath:null,sidebarView:'explorer',workspaceView:'agents',bumpTree:()=>{},addToast:()=>{}}))
 let useAgentTasks
 const useAgentChats=create((set,get)=>({chats:[],activeId:null,init:async()=>{},select:id=>set({activeId:id}),create:cwd=>{
  const c={id:crypto.randomUUID(),cwd,taskId:useAgentTasks.getState().activeId,updatedAt:Date.now(),draft:''}
  set({chats:[...get().chats,c],activeId:c.id})
 }}))
 try {
  useAgentTasks=load('src/renderer/src/lib/agentTasks.ts',{zustand:{create},'../store':{useStore},'./agentChats':{useAgentChats}}).useAgentTasks
  await useAgentTasks.getState().init();const a=useAgentTasks.getState().activeId
  useAgentTasks.getState().open('/project');const ca=useAgentChats.getState().activeId
  useStore.setState({tabs:[{path:'/project/a.ts',content:'UNSAVED',savedContent:'original'}],activePath:'/project/a.ts'})
  useAgentChats.setState(s=>({chats:s.chats.map(c=>c.id===ca?{...c,draft:'DRAFT_A',running:true}:c)}))
  useAgentTasks.getState().create();const b=useAgentTasks.getState().activeId;assert.notEqual(a,b)
  assert.equal(useStore.getState().tabs.length,0);assert.notEqual(useAgentChats.getState().activeId,ca)
  useAgentTasks.getState().open('/project');assert.equal(useAgentTasks.getState().activeId,b,'new task can use the same project folder')
  useAgentTasks.getState().activate(a)
  assert.equal(useStore.getState().tabs[0].content,'UNSAVED');assert.equal(useAgentChats.getState().activeId,ca)
  assert.equal(useAgentChats.getState().chats.find(c=>c.id===ca).draft,'DRAFT_A')
  assert.equal(useAgentChats.getState().chats.find(c=>c.id===ca).running,true)
  useAgentTasks.getState().close(a);assert.ok(useAgentTasks.getState().tasks.some(t=>t.id===a));assert.ok(!useAgentTasks.getState().openIds.includes(a))
  useAgentTasks.getState().activate(a);assert.equal(useStore.getState().tabs[0].content,'UNSAVED')
 } finally {await new Promise(r=>setTimeout(r,450));global.window=savedWindow}
})
