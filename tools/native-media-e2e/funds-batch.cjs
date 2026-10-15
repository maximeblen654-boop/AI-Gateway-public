// Bounded audit of the existing real three-component stack; only upstream is simulated.
const fs=require('node:fs'),assert=require('node:assert/strict'),{createHash,randomUUID}=require('node:crypto'),{execFileSync}=require('node:child_process')
const root=process.argv[2],base='http://127.0.0.1:28100'
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO,'paid-controls');assert(root.endsWith('/native-media-20261012'))
const fixture=JSON.parse(fs.readFileSync(root+'/evidence/fixture.json')),compose=JSON.parse(fs.readFileSync(root+'/compose.json'))
assert.equal(compose.services.postgres.environment.POSTGRES_DB,'sub2api');assert.equal(compose.services.core.container_name,'ai-gateway-native-core-20261012')
const dc=(...args)=>execFileSync('docker',['compose','-p','ai-gateway-native-20261012','-f',root+'/compose.json',...args],{encoding:'utf8',stdio:'pipe'})
const sql=q=>dc('exec','-T','postgres','psql','-U','native','-d','sub2api','-At','-v','ON_ERROR_STOP=1','-c',q).trim()
const stats=()=>JSON.parse(fs.readFileSync(root+'/evidence/native-supplier-state.json'))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const money=v=>Math.round(Number(v)*1e8)
const snapshot=uid=>{assert(Number.isSafeInteger(uid));return JSON.parse(sql(`SELECT json_build_object('balance',balance::text,'frozen_balance',frozen_balance::text,'usage',(SELECT count(*) FROM usage_logs WHERE user_id=${uid})) FROM users WHERE id=${uid}`))}
const ledger=id=>{assert(/^img_[a-f0-9]{32}$/.test(id));const k=createHash('sha256').update('studio-image:'+id).digest('hex');return JSON.parse(sql(`SELECT json_build_object('request_id','${k}','usage',(SELECT count(*) FROM usage_logs WHERE request_id='${k}'),'dedup',(SELECT count(*) FROM usage_billing_dedup WHERE request_id='${k}'),'cost',(SELECT COALESCE(sum(actual_cost),0)::text FROM usage_logs WHERE request_id='${k}'),'user_id',(SELECT user_id FROM usage_logs WHERE request_id='${k}' LIMIT 1),'image_count',(SELECT image_count FROM usage_logs WHERE request_id='${k}' LIMIT 1))`))}
const report={production:false,api_mocking:false,scope:'104 original tasks; real BFF/Bridge/Core and native PostgreSQL transactions',tasks:[],checks:[],source_sha:process.env.NATIVE_CANDIDATE_SOURCE_SHA}
const save=()=>fs.writeFileSync(root+'/evidence/native-funds-batch.json',JSON.stringify(report,null,2))
async function core(token,path,method='GET',body){const r=await fetch(base+'/api/v1'+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'X-Admin-UI-Request':'1'},...(body?{body:JSON.stringify(body)}:{})});const b=await r.json();assert.equal(r.status,200,`${path}: ${r.status} ${JSON.stringify(b)}`);assert.equal(b.code,0);return b.data}
async function login(email,password){return (await core('','/auth/login','POST',{email,password})).access_token}
async function session(user){const issued=await core(user.token,'/auth/studio-media-ticket','POST',{});const r=await fetch(base+'/studio-v2/api/session/exchange',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Studio-Request':'session-exchange-v1'},body:JSON.stringify({ticket:issued.ticket})});assert.equal(r.status,200);user.cookie=r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');assert.equal((await r.json()).owner_id,user.id)}
async function media(user,op,body,signal){const r=await fetch(base+'/studio-v2/api/image/'+op,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:base,Cookie:user.cookie,'X-Studio-Request':'image-binding-v1'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal});return {status:r.status,body:await r.json()}}
async function quoteAfterNativeCooldown(user,offer_id,spec){
 const start=Date.now();let waits=0
 for(;;){const r=await media(user,'quotes',{offer_id,spec});if(r.status===200){if(waits)(report.admission_waits??=[]).push({user_id:user.id,attempts:waits,elapsed_ms:Date.now()-start});return r.body}
 assert(r.status===409&&r.body.diagnostic_stage==='account_admission',JSON.stringify(r));assert(Date.now()-start<70000,'Native Account did not recover within its 45 second cooldown plus margin');waits++;await sleep(5000)
 }
}
const ok=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.body}
;(async()=>{
 const env=compose.services.core.environment,admin=await login(env.ADMIN_EMAIL,env.ADMIN_PASSWORD),users=[]
 for(let i=0;i<4;i++){const email=`funds-batch-${i}@example.invalid`,password='Isolated-Funds-Batch-Only-20261015';const u=await core(admin,'/admin/users','POST',{email,password,balance:100,concurrency:5,allowed_groups:[fixture.groups.openai]});u.token=await login(email,password);await core(u.token,'/keys','POST',{name:'Synthetic funds audit',group_id:fixture.groups.openai});await session(u);users.push(u)}
 const product=JSON.parse(fs.readFileSync(root+'/evidence/native-geometry-browser.json')).products.find(p=>p.display_name==='Synthetic geometry image')
 const offer=ok(await media(users[0],'catalog')).offers.find(o=>o.product_id===product.product_id&&o.spec.resolution.includes('4K'));assert(offer)
 report.before=users.map(u=>({user_id:u.id,...snapshot(u.id)}));report.posts_before=stats().image_posts
 // Four independent customer balances; only one original task per customer in each concurrent cohort.
 // Count includes 12 real upstream response-header timeouts, not a fabricated HTTP 504.
 for(const [scenario,n] of [['OK',24],['PARTIAL',12],['REJECT',12],['502',16],['DISCONNECT',12],['TIMEOUT',12],['LATE',8],['DUPLICATE',8]]){
  for(let offset=0;offset<n;offset+=4){
   const cohort=[]
   for(let slot=0;slot<4;slot++){
    const user=users[slot],count=scenario==='PARTIAL'?3:1,prompt=`BATCH_FUNDS_${scenario}:${report.tasks.length}`,spec={resolution:'4K',aspect_ratio:'16:9',duration_seconds:0,quality:'',count,images:0,videos:0,audio:0}
    const quote=await quoteAfterNativeCooldown(user,offer.offer_id,spec);const prepared=ok(await media(user,'prepare',{quote_token:quote.quote_token,client_key:randomUUID(),prompt,asset_refs:[]}))
    const record={id:prepared.task_id,user_id:user.id,scenario,prompt,quantity:count,frozen_price:prepared.total_price||prepared.sale_price,before:snapshot(user.id),balance_samples:[],released:'0',hold_contract:'Studio image delivery settlement; no reserve/capture/release hold'}
    assert.equal(money(record.before.frozen_balance),0);assert.equal(ledger(record.id).dedup,0);report.tasks.push(record);cohort.push({user,record})
   }
   const sampler=setInterval(()=>{for(const {user,record} of cohort)record.balance_samples.push(snapshot(user.id))},500)
   try{await Promise.all(cohort.map(async({user,record})=>{
    const body={task_id:record.id},start=Date.now()
    try{const r=await media(user,'tasks',body,scenario==='LATE'?AbortSignal.timeout(1000):AbortSignal.timeout(55000));record.submit={status:r.status,task_status:r.body.status,error:r.body.error};assert([200,202,409,502,504].includes(r.status),JSON.stringify(r))}
    catch(e){if(scenario!=='LATE')throw e;assert(['TimeoutError','AbortError'].includes(e.name));record.submit={client_timeout:true}}
    if(scenario==='LATE')await sleep(4500)
    // Explicit duplicate of the original identity must recover only, never replay supplier POST.
    if(scenario==='DUPLICATE'){const r=await media(user,'tasks',body);record.duplicate_submit={status:r.status};assert([200,202,409].includes(r.status))}
    let latest
    for(let i=0;i<3;i++){const r=await media(user,'tasks/'+record.id);assert([200,409].includes(r.status),JSON.stringify(r));latest=r;await sleep(100)}
    record.latest=latest;record.elapsed_ms=Date.now()-start;record.after=snapshot(user.id);record.ledger=ledger(record.id)
    const delivered=['OK','PARTIAL','LATE','DUPLICATE'].includes(scenario),expected=delivered?110000000:0
    assert.equal(latest.body.status,scenario==='PARTIAL'?'partial':scenario==='REJECT'?'failed':delivered?'completed':'unknown')
    assert.equal(money(record.frozen_price.amount),(scenario==='PARTIAL'?3:1)*110000000)
    assert.equal(money(record.ledger.cost),expected,JSON.stringify(record));assert.equal(record.ledger.usage,delivered?1:0);assert.equal(record.ledger.dedup,delivered?1:0)
    if(delivered){assert.equal(record.ledger.user_id,user.id);assert.equal(record.ledger.image_count,1)}
    assert.equal(money(record.before.balance)-money(record.after.balance),expected)
    for(const snap of [...record.balance_samples,record.after])assert.equal(money(snap.frozen_balance),0)
    const calls=stats().requests.filter(r=>r.method==='POST'&&r.body.prompt===record.prompt);record.upstream_requests=calls.map(r=>({method:r.method,path:r.path,model:r.body.model,n:r.body.n,size:r.body.size}))
    assert.equal(calls.length,scenario==='PARTIAL'?2:1,JSON.stringify(record));assert(calls.every(c=>c.body.model==='gpt-image-2'))
    const wrongOwner=users[(users.indexOf(user)+1)%users.length]
    const denied=await media(wrongOwner,'tasks/'+record.id);record.cross_owner_status=denied.status
    assert([403,404,409].includes(denied.status));assert.notEqual(denied.body.task_id,record.id)
    if(delivered){const r=await fetch(base+'/studio-v2/api/image/tasks/'+record.id+'/results/0',{headers:{Cookie:user.cookie}});assert.equal(r.status,200);record.original_sha256=createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');assert.equal(record.original_sha256,createHash('sha256').update(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')).digest('hex'))}

    record.pass=true
   }))}finally{clearInterval(sampler);save()}
  }
 }
 assert.equal(report.tasks.length,104);assert(report.tasks.every(t=>t.pass))
 // Persisted original identities survive a real Core restart and namespace reattachment.
 const beforeRestart=stats().image_posts
 dc('restart','core');dc('up','-d','--wait','--wait-timeout','90','core')
 const pid=execFileSync('docker',['inspect','--format','{{.State.Pid}}','ai-gateway-native-core-20261012'],{encoding:'utf8'}).trim();assert(/^[1-9][0-9]*$/.test(pid))
 execFileSync('sudo',['nsenter','-t',pid,'-n','ip','addr','replace','203.0.113.10/32','dev','lo'])
 dc('up','-d','--no-deps','--force-recreate','--wait','--wait-timeout','90','bridge','bff','simulator')
 for(const u of users)await session(u)
 for(const t of report.tasks){const user=users.find(u=>u.id===t.user_id);t.restarted_query=await media(user,'tasks/'+t.id);assert([200,409].includes(t.restarted_query.status));assert.deepEqual(ledger(t.id),t.ledger);assert.equal(t.restarted_query.body.status,t.latest.body.status)}
 assert.equal(stats().image_posts,beforeRestart);report.after=users.map(u=>({user_id:u.id,...snapshot(u.id)}));
 for(const u of users){const charged=report.tasks.filter(t=>t.user_id===u.id).reduce((s,t)=>s+money(t.ledger.cost),0);assert.equal(10000000000-money(snapshot(u.id).balance),charged);assert.equal(money(snapshot(u.id).frozen_balance),0)}
 report.counts=Object.fromEntries([...new Set(report.tasks.map(t=>t.scenario))].map(k=>[k,report.tasks.filter(t=>t.scenario===k).length]))
 report.checks.push('Per-customer balance conservation and zero frozen balance before/during/after; one native dedup+usage per delivered task; no debit for rejected/unknown tasks','Original task queries and explicit duplicate submissions do not replay supplier POST; real Core restart preserves ledger and original identity','Client timeout with late result settles delivered original task once; unknown supplier result remains unknown and uncharged, not declared refunded','No supplier per-request query exists for this synchronous contract; restart and queries never manufacture an endpoint')
 const columns=['id','user_id','scenario','status','before_balance','quoted','charged','after_balance','hold','released','usage','dedup','supplier_posts']
 const rows=report.tasks.map(t=>[t.id,t.user_id,t.scenario,t.latest.body.status,t.before.balance,t.frozen_price.amount,t.ledger.cost,t.after.balance,t.after.frozen_balance,t.released,t.ledger.usage,t.ledger.dedup,t.upstream_requests.length])
 fs.writeFileSync(root+'/evidence/native-funds-batch.csv',[columns,...rows].map(row=>row.join(',')).join('\n')+'\n')
 report.pass=true;save();console.log(JSON.stringify({pass:true,tasks:report.tasks.length,counts:report.counts}))
})().catch(e=>{report.error=e.stack;save();console.error(e);process.exitCode=1})
