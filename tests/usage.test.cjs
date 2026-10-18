const {test}=require('node:test')
const assert=require('node:assert/strict')
const load=require('./helpers/load-typescript.cjs')
const usage=load('src/shared/providerUsage.ts')
test('Claude keeps the windows Traycer reads, scoped models and zero utilization; codename buckets are not windows',()=>{
 const result=usage.claudeDetails({subscription_type:'max',rate_limits_available:true,rate_limits:{
  five_hour:{utilization:0,resets_at:'2026-10-08T12:00:00Z'},seven_day:{utilization:99,resets_at:'invalid'},seven_day_opus:null,
  seven_day_sonnet:{utilization:null},seven_day_future:{utilization:20},model_scoped:[{display_name:'Fable',utilization:51,resets_at:null}],
  extra_usage:{is_enabled:true,monthly_limit:1000,used_credits:45,utilization:4.5,currency:'USD'}}})
 assert.equal(result.limits.length,3);assert.equal(result.limits[0].usedPercent,0)
 assert.equal(result.limits[0].resetsAt,Date.parse('2026-10-08T12:00:00Z')/1000)
 assert.equal(result.limits[1].resetsAt,undefined);assert.equal(result.limits[2].label,'Fable · 7 dias')
 assert.equal(result.limits.some(l=>l.id==='seven_day_future'),false)
 assert.equal(result.extras.find(e=>e.label==='Créditos utilizados').value,'45')
 assert.equal(result.unavailable,undefined)
})
test('missing Claude plan scope never becomes invented zero usage',()=>{
 const r=usage.claudeDetails({rate_limits_available:false,rate_limits:null})
 assert.equal(r.limits.length,0);assert.ok(r.unavailable)
})
test('Codex includes all buckets without repeating the compatibility bucket and includes spend controls',()=>{
 const bucket={limitId:'codex',limitName:'Codex',primary:{usedPercent:30,windowDurationMins:300,resetsAt:999},secondary:{usedPercent:5,windowDurationMins:10080},credits:{balance:'42',hasCredits:true,unlimited:false},individualLimit:{used:'3',limit:'20',remainingPercent:85},rateLimitReachedType:'workspace_member_usage_limit_reached'}
 const r=usage.codexDetails({account:{email:'mock@example.invalid',planType:'pro'}},{rateLimits:bucket,rateLimitsByLimitId:{codex:bucket,reviews:{primary:{usedPercent:0}}},rateLimitResetCredits:{availableCount:2}})
 assert.equal(r.limits.length,3);assert.equal(r.limits[2].usedPercent,0);assert.equal(r.tier,'pro')
 assert.equal(r.extras.find(e=>e.label==='Codex · créditos').value,'42');assert.deepEqual(r.resetCredits,{availableCount:2,credits:null});assert.equal(r.extras.some(e=>/Redefini/.test(e.label)),false)
})
test('metadata probes coalesce per profile, retain stale snapshots on failure, invalidate on account change, and close native processes',async()=>{
 let calls=0,fail=false,resolve,closed=0
 class Server{constructor(id){this.id=id;this.ready=Promise.resolve()}async request(method){calls++;if(method==='account/read')return{account:{planType:this.id}};if(fail)throw Error('SECRET error must not leak');await new Promise(r=>resolve=r);return{rateLimits:{primary:{usedPercent:17}}}}close(){closed++}}
 const main=load('src/main/providerUsage.ts',{'../shared/providerUsage':usage,'./providers':{profileEnvironment:(_p,id)=>{if(id==='disabled')throw Error('disabled');return{}},providerCommand:()=>null},'./codexServer':{CodexServer:Server},os:{homedir:()=>'/mock'}})
 const first=main.profileUsage('codex','one');const joined=main.profileUsage('codex','one',true);assert.equal(first,joined)
 await new Promise(r=>setImmediate(r));resolve();const initial=await first;assert.equal(closed,1)
 assert.equal(await main.profileUsage('codex','one'),initial);assert.equal(calls,2)
 fail=true;const stale=await main.profileUsage('codex','one',true);assert.equal(stale.stale,true);assert.equal(stale.limits[0].usedPercent,17);assert.ok(!stale.error.includes('SECRET'));assert.equal(closed,2)
 main.invalidateUsage('one');const fresh=await main.profileUsage('codex','one');assert.equal(fresh.stale,false);assert.equal(fresh.limits.length,0)
 assert.throws(()=>main.profileUsage('codex','disabled'),/disabled/)
})
