const {test}=require('node:test')
const assert=require('node:assert/strict')
const path=require('node:path')
const load=require('./helpers/load-typescript.cjs')
const shared=load('src/shared/providerUsage.ts')
const usageUi=load('src/renderer/src/components/settings/usage.ts',{'../../lib/profileAccent':{PROFILE_ACCENT_COLORS:['#000000']}})
const rc=load('src/renderer/src/components/settings/providers/resetCredits.ts',{'../usage':usageUi})

/* ---------- shared/providerUsage ---------- */
test('claudePlanLabel names Max tiers, other plans and unknown tokens',()=>{
 const p=shared.claudePlanLabel
 assert.equal(p('max','default_claude_max_20x'),'Assinatura Claude Max 20x')
 assert.equal(p('max','default_claude_max_5x'),'Assinatura Claude Max 5x')
 assert.equal(p('max'),'Assinatura Claude Max')
 assert.equal(p('Claude Max','default_claude_max_20x'),'Assinatura Claude Max 20x')
 assert.equal(p('pro','default_claude_max_20x'),'Assinatura Claude Pro')
 assert.equal(p('team'),'Assinatura Claude Team')
 assert.equal(p('enterprise'),'Assinatura Claude Enterprise')
 assert.equal(p('free'),'Assinatura Claude Free')
 assert.equal(p('max20'),'Assinatura Claude Max 20x')
 assert.equal(p('some_new_plan'),'Assinatura Claude Some New Plan')
 assert.equal(p(''),undefined);assert.equal(p(undefined),undefined);assert.equal(p('  '),undefined)
})
test('codexPlanLabel maps plan types',()=>{
 const p=shared.codexPlanLabel
 assert.equal(p('plus'),'Assinatura ChatGPT Plus')
 assert.equal(p('pro'),'Assinatura ChatGPT Pro 20x')
 assert.equal(p('prolite'),'Assinatura ChatGPT Pro 5x')
 assert.equal(p('business'),'Assinatura ChatGPT Business')
 assert.equal(p('self_serve_business_usage_based'),'Assinatura ChatGPT Business')
 assert.equal(p('enterprise'),'Assinatura ChatGPT Enterprise')
 assert.equal(p('enterprise_cbp_usage_based'),'Assinatura ChatGPT Enterprise')
 assert.equal(p('unknown'),'Assinatura ChatGPT')
 assert.equal(p('new_tier'),'Assinatura ChatGPT New Tier')
 assert.equal(p(''),undefined);assert.equal(p(undefined),undefined);assert.equal(p(null),undefined)
})
test('planLabel delegates per provider',()=>{
 assert.equal(shared.planLabel('claude','max'),'Assinatura Claude Max')
 assert.equal(shared.planLabel('codex','plus'),'Assinatura ChatGPT Plus')
 assert.equal(shared.planLabel('codex',''),undefined)
})
test('codexResetCredits validates and normalizes',()=>{
 const f=shared.codexResetCredits
 for(const bad of [undefined,null,'x',{},{availableCount:-1},{availableCount:'2'},{availableCount:NaN}])assert.equal(f(bad),undefined)
 assert.deepEqual(f({availableCount:3}),{availableCount:3,credits:null})
 assert.equal(f({availableCount:2.9}).availableCount,2)
 const r=f({availableCount:5,credits:[
  {status:'available',grantedAt:1},{id:'a',status:'available'},{id:'b',status:'available',grantedAt:'1'},
  {id:'c',status:'available',grantedAt:1,expiresAt:'soon'},
  {id:'d',status:'weird',grantedAt:10,expiresAt:null,title:5,description:{}},
  {id:'e',status:'redeeming',grantedAt:11,title:'T',description:'D'},
  {id:'f',status:'redeemed',grantedAt:12,expiresAt:1793295847},null,'x']})
 assert.deepEqual(r.credits.map(c=>c.id),['d','e','f'])
 assert.equal(r.credits[0].status,'unknown');assert.equal(r.credits[0].expiresAt,null)
 assert.equal(r.credits[0].title,null);assert.equal(r.credits[0].description,null)
 assert.equal(r.credits[1].expiresAt,null);assert.equal(r.credits[1].title,'T');assert.equal(r.credits[1].status,'redeeming')
 assert.equal(r.credits[2].expiresAt,1793295847)
 assert.deepEqual(f({availableCount:0,credits:[]}),{availableCount:0,credits:[]})
})
test('codexResetOutcome accepts only the four outcomes',()=>{
 for(const o of ['reset','nothingToReset','noCredit','alreadyRedeemed'])assert.equal(shared.codexResetOutcome({outcome:o}),o)
 for(const bad of [{outcome:'other'},{},null,undefined,'reset',42,{outcome:null}])assert.throws(()=>shared.codexResetOutcome(bad),Error)
})
test('codexDetails exposes plan and resetCredits, not a reset extra',()=>{
 const data={rateLimits:{limitId:'codex',planType:'plus',primary:{usedPercent:100,windowDurationMins:300,resetsAt:1791574662},secondary:{usedPercent:28,windowDurationMins:10080,resetsAt:1792114338}},
  rateLimitResetCredits:{availableCount:2,credits:[
   {id:'RateLimitResetCredit_a',resetType:'codexRateLimits',status:'available',grantedAt:1790703847,expiresAt:1793295847,title:'Full reset (Weekly + 5 hr)',description:'x'},
   {id:'RateLimitResetCredit_b',resetType:'codexRateLimits',status:'available',grantedAt:1791408537,expiresAt:1794000537,title:'Full reset (Weekly + 5 hr)',description:'x'}]}}
 const r=shared.codexDetails({account:{email:'mock@example.invalid',planType:'plus'}},data)
 assert.equal(r.plan,'Assinatura ChatGPT Plus');assert.equal(r.tier,'plus');assert.equal(r.email,'mock@example.invalid')
 assert.equal(r.resetCredits.availableCount,2);assert.equal(r.resetCredits.credits.length,2)
 assert.equal(r.resetCredits.credits[0].expiresAt,1793295847)
 assert.equal(r.resetCredits.credits[0].title,'Full reset (Weekly + 5 hr)')
 assert.equal(r.limits.length,2);assert.equal(r.limits[0].usedPercent,100);assert.equal(r.limits[0].resetsAt,1791574662)
 assert.equal(r.extras.some(e=>/Redefini/.test(e.label)),false)
 assert.equal(r.unavailable,undefined)
})
test('claudeDetails combines SDK account with usage reply',()=>{
 const r=shared.claudeDetails({subscription_type:'max',rate_limits_available:false},{email:'e@x.invalid',subscriptionType:'Claude Max',rateLimitTier:'default_claude_max_20x'})
 assert.equal(r.plan,'Assinatura Claude Max 20x');assert.equal(r.email,'e@x.invalid');assert.equal(r.tier,'max')
 const n=shared.claudeDetails({subscription_type:'max',rate_limits_available:false})
 assert.equal(n.plan,'Assinatura Claude Max');assert.equal(n.email,undefined)
})

/* ---------- resetCredits.ts ---------- */
const NOW=Date.UTC(2026,9,9,12,0,0), H=3600e3
const credit=(id,hoursAway,status='available')=>({id,status,grantedAt:1,expiresAt:hoursAway===null?null:(NOW+hoursAway*H)/1000,title:null,description:null})
test('visibleResetCredits drops redeemed, sorts by expiry with null last, does not mutate',()=>{
 const input=[credit('n',null),credit('late',50),credit('r',1,'redeemed'),credit('soon',2)]
 const copy=[...input]
 assert.deepEqual(rc.visibleResetCredits(input).map(c=>c.id),['soon','late','n'])
 assert.deepEqual(input,copy)
})
test('selectResetCredit picks the earliest available unexpired credit',()=>{
 const credits=[credit('exp',-1),credit('busy',1,'redeeming'),credit('b',30),credit('a',5),credit('red',2,'redeemed')]
 assert.equal(rc.selectResetCredit(credits,NOW).id,'a')
 assert.equal(rc.selectResetCredit([credit('exp',-1),credit('busy',1,'redeeming')],NOW),null)
 assert.equal(rc.selectResetCredit([],NOW),null)
})
test('omittedResetCount',()=>{
 assert.equal(rc.omittedResetCount({availableCount:3,credits:null}),0)
 assert.equal(rc.omittedResetCount({availableCount:3,credits:[]}),0)
 assert.equal(rc.omittedResetCount({availableCount:3,credits:[credit('a',1)]}),2)
 assert.equal(rc.omittedResetCount({availableCount:1,credits:[credit('a',1),credit('b',2)]}),0)
})
test('canUseReset and count texts',()=>{
 const rcs={availableCount:1,credits:null}
 assert.equal(rc.canUseReset('codex',true,rcs),true)
 assert.equal(rc.canUseReset('claude',true,rcs),false)
 assert.equal(rc.canUseReset('codex',false,rcs),false)
 assert.equal(rc.canUseReset('codex',true,undefined),false)
 assert.equal(rc.canUseReset('codex',true,{availableCount:0,credits:null}),false)
 assert.equal(rc.resetCountText(1),'1 disponível');assert.equal(rc.resetCountText(2),'2 disponíveis')
 assert.equal(rc.omittedText(1),'+1 não exibida');assert.equal(rc.omittedText(3),'+3 não exibidas')
})
test('resetCreditDetail',()=>{
 const d=(c)=>rc.resetCreditDetail(c,NOW)
 assert.deepEqual(d(credit('x',5,'redeeming')),{text:'Resgatando',warning:false,redeeming:true})
 assert.equal(d(credit('x',null)).text,'Sem validade')
 assert.equal(d(credit('x',366*24)).text,'Validade indisponível')
 assert.equal(d(credit('x',-366*24)).text,'Validade indisponível')
 assert.equal(d(credit('x',-1)).text,'Expirada')
 const two=d(credit('x',2));assert.equal(two.text,'Expira em 2h');assert.equal(two.warning,true);assert.equal(two.redeeming,false)
 const far=credit('x',72);assert.equal(d(far).text,'Expira '+usageUi.formatResetFullDateTime(NOW+72*H));assert.equal(d(far).warning,false)
 assert.equal(d(credit('x',47)).warning,true)
 assert.equal(d(credit('x',49)).warning,false)
 assert.equal(d(credit('x',null)).warning,false)
})
test('resetConfirmDescription',()=>{
 const generic='Isso usa uma redefinição manual no limite de uso do Codex atingido no momento. A redefinição não pode ser devolvida nem desfeita.'
 assert.equal(rc.resetConfirmDescription(null,2,NOW),generic)
 const a=rc.resetConfirmDescription(credit('x',2),2,NOW)
 assert.ok(a.includes('que expira em 2h'));assert.ok(a.endsWith('Você ficará com 1 redefinição manual.'))
 assert.ok(rc.resetConfirmDescription(credit('x',2),3,NOW).endsWith('Você ficará com 2 redefinições manuais.'))
 assert.ok(rc.resetConfirmDescription(credit('x',null),2,NOW).includes('a redefinição sem validade'))
 assert.ok(rc.resetConfirmDescription(credit('x',72),2,NOW).includes('que expira em '+usageUi.formatResetFullDateTime(NOW+72*H)))
 assert.ok(rc.resetConfirmDescription(credit('x',2),0,NOW).endsWith('Você ficará com 0 redefinições manuais.'))
})
test('resetOutcomeToast and ipcErrorMessage',()=>{
 assert.deepEqual(rc.resetOutcomeToast('reset'),{kind:'success',message:'Limite de uso do Codex redefinido.'})
 for(const o of ['nothingToReset','noCredit','alreadyRedeemed'])assert.equal(rc.resetOutcomeToast(o).kind,'info')
 assert.equal(rc.resetOutcomeToast('nothingToReset').message,'O Codex não tem um limite de uso ativo para redefinir.')
 assert.equal(rc.resetOutcomeToast('noCredit').message,'Nenhuma redefinição manual do Codex disponível.')
 assert.equal(rc.resetOutcomeToast('alreadyRedeemed').message,'Essa redefinição manual do Codex já foi usada.')
 assert.equal(rc.ipcErrorMessage(new Error("Error invoking remote method 'providers:codex-reset': Error: Boom")),'Boom')
 assert.equal(rc.ipcErrorMessage(new Error('plain')),'plain')
 assert.equal(rc.ipcErrorMessage('texto'),'texto')
 assert.equal(rc.ipcErrorMessage(undefined),'')
})

/* ---------- main/providerUsage (CodexServer mocked) ---------- */
function setup({homes={},files={},reply={outcome:'reset'},requestImpl}={}){
 const state={created:0,closed:0,requests:[],reads:0,gate:null}
 class Server{
  constructor(id){state.created++;this.id=id;this.ready=Promise.resolve()}
  async request(method,params){
   state.requests.push({method,params})
   if(method==='account/read')return{account:{planType:'plus'}}
   if(method==='account/rateLimits/read'){state.reads++;return{rateLimits:{primary:{usedPercent:1}}}}
   if(requestImpl)return requestImpl(method,params,state)
   if(state.gate)await state.gate
   return reply
  }
  close(){state.closed++}
 }
 const profileEnvironment=(_p,id)=>{if(id==='disabled'||id==='unknown')throw Error('disabled');return homes[id]||{}}
 const main=load('src/main/providerUsage.ts',{'../shared/providerUsage':shared,'./providers':{profileEnvironment,providerCommand:()=>null},'./codexServer':{CodexServer:Server},os:{homedir:()=>'/mock'},
  'fs/promises':{readFile:async(p)=>{if(!(p in files))throw Object.assign(Error('ENOENT'),{code:'ENOENT'});return files[p]}},path})
 return{main,state}
}
const consumeReqs=(s)=>s.requests.filter(r=>r.method==='account/rateLimitResetCredit/consume')
const KEY='abcdef12-3456'
test('consume sends the request, returns the outcome and always closes',async()=>{
 const {main,state}=setup({reply:{outcome:'noCredit'}})
 assert.equal(await main.consumeCodexResetCredit('p',KEY,'cred-1'),'noCredit')
 assert.deepEqual(consumeReqs(state)[0].params,{idempotencyKey:KEY,creditId:'cred-1'})
 await main.consumeCodexResetCredit('p',KEY,null)
 assert.deepEqual(consumeReqs(state)[1].params,{idempotencyKey:KEY})
 assert.equal(state.closed,2)
 const bad=setup({reply:{outcome:'weird'}})
 await assert.rejects(bad.main.consumeCodexResetCredit('p',KEY,null),/desconhecido/)
 assert.equal(bad.state.closed,1)
 const boom=setup({requestImpl:()=>{throw Error('kaput')}})
 await assert.rejects(boom.main.consumeCodexResetCredit('p',KEY,null),/kaput/)
 assert.equal(boom.state.closed,1)
})
test('consume validates input before creating a server',async()=>{
 const {main,state}=setup()
 for(const args of [[5,KEY,null],['',KEY,null],['p','short',null],['p','has space here',null],['p',5,null],['p',KEY,5],['p',KEY,''],['p',KEY,'x'.repeat(257)]])
  await assert.rejects(main.consumeCodexResetCredit(...args),Error)
 assert.equal(state.created,0)
})
test('consume rejects disabled or unknown profiles without a server',async()=>{
 const {main,state}=setup()
 await assert.rejects(main.consumeCodexResetCredit('disabled',KEY,null),/disabled/)
 await assert.rejects(main.consumeCodexResetCredit('unknown',KEY,null),/disabled/)
 assert.equal(state.created,0)
})
test('consume allows one reset at a time per CODEX_HOME',async()=>{
 const {main,state}=setup({homes:{a:{CODEX_HOME:'/h/one'},b:{CODEX_HOME:'/h/one/'},c:{CODEX_HOME:'/h/two'}}})
 let open;state.gate=new Promise(r=>open=r)
 const first=main.consumeCodexResetCredit('a',KEY,null)
 await new Promise(r=>setImmediate(r))
 await assert.rejects(main.consumeCodexResetCredit('b',KEY,null),/em andamento/)
 const other=main.consumeCodexResetCredit('c',KEY,null)
 await new Promise(r=>setImmediate(r))
 assert.equal(state.created,2)
 open();assert.equal(await first,'reset');assert.equal(await other,'reset')
 state.gate=null
 assert.equal(await main.consumeCodexResetCredit('b',KEY,null),'reset')
})
test('consume turns the server timeout into a friendly message and releases the lock',async()=>{
 let fail=true
 const {main}=setup({requestImpl:()=>{if(fail)throw Error('Tempo esgotado: account/rateLimitResetCredit/consume');return{outcome:'reset'}}})
 await assert.rejects(main.consumeCodexResetCredit('p',KEY,null),(e)=>e.message==='Tempo esgotado ao usar a redefinição manual do Codex.')
 fail=false
 assert.equal(await main.consumeCodexResetCredit('p',KEY,null),'reset')
})
test('consume invalidates the cached usage',async()=>{
 const {main,state}=setup()
 await main.profileUsage('codex','p');assert.equal(state.reads,1)
 await main.profileUsage('codex','p');assert.equal(state.reads,1)
 await main.consumeCodexResetCredit('p',KEY,null)
 await main.profileUsage('codex','p');assert.equal(state.reads,2)
})
test('claudeRateLimitTier reads only the tier from .credentials.json',async()=>{
 const creds=(o)=>JSON.stringify({claudeAiOauth:{accessToken:'SECRET',refreshToken:'SECRET',...o}})
 const cfg=path.join('/cfg','dir','.credentials.json'), def=path.join('/mock','.claude','.credentials.json')
 const {main}=setup({homes:{withdir:{CLAUDE_CONFIG_DIR:path.join('/cfg','dir')},nodir:{},missing:{CLAUDE_CONFIG_DIR:'/nowhere'},bad:{CLAUDE_CONFIG_DIR:'/bad'},weird:{CLAUDE_CONFIG_DIR:'/weird'},notier:{CLAUDE_CONFIG_DIR:'/notier'}},
  files:{[cfg]:creds({rateLimitTier:'default_claude_max_20x'}),[def]:creds({rateLimitTier:'default_claude_max_5x'}),
   [path.join('/bad','.credentials.json')]:'{not json',[path.join('/weird','.credentials.json')]:creds({rateLimitTier:'max 20x; rm -rf'}),
   [path.join('/notier','.credentials.json')]:creds({})}})
 const t=await main.claudeRateLimitTier('withdir')
 assert.equal(t,'default_claude_max_20x');assert.ok(!JSON.stringify(t).includes('SECRET'))
 assert.equal(await main.claudeRateLimitTier('nodir'),'default_claude_max_5x')
 assert.equal(await main.claudeRateLimitTier('missing'),undefined)
 assert.equal(await main.claudeRateLimitTier('bad'),undefined)
 assert.equal(await main.claudeRateLimitTier('weird'),undefined)
 assert.equal(await main.claudeRateLimitTier('notier'),undefined)
})
