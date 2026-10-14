// Price boundary checks against final Core. Only the upstream is simulated.
const fs=require('node:fs'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process')
const root=process.argv[2],origin='http://127.0.0.1:28180',fixture=JSON.parse(fs.readFileSync(`${root}/evidence/fixture.json`)),compose=JSON.parse(fs.readFileSync(`${root}/compose.json`))
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO,'admin-ui-review');assert.equal(compose.services.core.environment.ADMIN_EMAIL,'native-admin@example.invalid')
const report={checks:[]},stats=()=>JSON.parse(fs.readFileSync(`${root}/evidence/native-supplier-state.json`))
const sql=q=>execFileSync('docker',['exec','-i','ai-gateway-native-postgres-20261012','psql','-U','native','-d','sub2api','-At','-v','ON_ERROR_STOP=1'],{input:q,encoding:'utf8'}).trim()
const ledger=()=>sql(`select json_build_object('balance',balance,'frozen',frozen_balance,'usage',(select count(*) from usage_logs where user_id=${fixture.customer}),'orders',(select count(*) from studio_video_orders where user_id=${fixture.customer})) from users where id=${fixture.customer};`)
async function call(path,method='GET',body,headers={}) {const r=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()}}
;(async()=>{
 const env=compose.services.core.environment
 const adminLogin=await call('/api/v1/auth/login','POST',{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD});assert.equal(adminLogin.status,200)
 const ah={Authorization:`Bearer ${adminLogin.body.data.access_token}`}
 const api=async(path,method='GET',body)=>{const r=await call('/api/v1'+path,method,body,ah);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.code,0);return r.body.data}
 const login=await call('/api/v1/auth/login','POST',{email:'native-customer@example.invalid',password:'Native-Customer-Only-20261012'});assert.equal(login.status,200)
 const uh={Authorization:`Bearer ${login.body.data.access_token}`}
 for(const kind of ['image','video']){
  const id=fixture.accounts[kind==='image'?'openai':'compatible'],base=`/admin/media-workbench/accounts/${id}`,account=await api(`/admin/accounts/${id}`)
  assert(account.name.startsWith('Synthetic '));assert(Number.isSafeInteger(id));const original=(await api(base)).media_workbench_v1
  const key=await call('/api/v1/keys','POST',{name:`Synthetic positive retail ${kind}`,group_id:fixture.groups[kind==='image'?'openai':'grok']},uh);assert.equal(key.status,200);assert(key.body.data.key)
  const headers={Authorization:`Bearer ${key.body.data.key}`,'X-Studio-Service-Token':env.STUDIO_BRIDGE_SERVICE_TOKEN,'X-Studio-Binding-Contract':kind==='image'?'published_image_binding_v1':'account_video_v1'}
  const get=async()=> (await api(base)).media_workbench_v1
  const save=async products=> {const c=await get();return (await api(base+'/draft','PUT',{expected_record_version:c.record_version,draft:{products}})).media_workbench_v1}
  const publish=async c=>call('/api/v1'+base+'/publish','POST',{expected_record_version:c.record_version,expected_draft_revision:c.draft.revision},ah)
  const spec=kind==='image'?{resolution:'4K',aspect_ratio:'16:9',count:1,images:0,videos:0,audio:0,duration_seconds:0}:{resolution:'720p',aspect_ratio:'16:9',duration_seconds:5,count:1,images:0,videos:0,audio:0}
  const first=original.draft.products[0],offerFor=c=>c.published.offers.find(o=>o.product_id===first.product_id&&(!o.spec_match.resolution?.length||o.spec_match.resolution.includes(spec.resolution)))
  let request
  if(kind==='video') {const evidence=JSON.parse(fs.readFileSync(`${root}/evidence/native-customer-video-compatible.json`));const submitted=evidence.after.supplier.requests.filter(r=>r.method==='POST'&&r.path==='/v1/videos'&&r.body?.model==='synthetic-compatible-video');assert.equal(submitted.length,1);request=submitted[0].body;assert.equal(request.duration,spec.duration_seconds);assert.equal(request.resolution,spec.resolution);assert.equal(request.ratio,spec.aspect_ratio);report.video_request_source={path:submitted[0].path,model:request.model,duration:request.duration,resolution:request.resolution,ratio:request.ratio}}
  const quote=offer=>call(`/v1/studio/${kind}s/quotes`,'POST',{offer_id:offer.offer_id,spec,...(request?{request}:{})},headers)
  const before={ledger:ledger(),stats:stats()}
  try{
   for(const amount of [null,'0','0.00000000','0.01','1','9.9']){
    const products=structuredClone(original.draft.products);for(const rule of products[0].pricing_rules)rule.sale_price=amount===null?null:{amount,currency:'CNY',billing_mode:'per_request'}
    const c=await save(products),reread=await get(),invalid=amount===null||Number(amount)===0
    assert.deepEqual(reread.draft.products,c.draft.products)
    const persisted=JSON.parse(sql(`select extra->'media_workbench_v1'->'draft'->'products' from accounts where id=${id};`));assert.deepEqual(persisted,c.draft.products)
    assert.equal(c.validation.publish_ready,!invalid)
    const prior=c.published,result=await publish(c)
    if(invalid){
     assert(result.status>=400);const after=await get();assert.deepEqual(after.published,prior)
     assert(after.validation.diagnostics.some(d=>d.scope===first.product_id&&d.code===(amount===null?'MISSING_PRICE':'INVALID_PRICE')))
     assert.deepEqual(after.draft.products[0].pricing_rules[0].sale_price,products[0].pricing_rules[0].sale_price)
     report.checks.push({kind,amount,draft_saved:true,db_equal:true,publish_status:result.status,published_unchanged:true})
    }else{
     assert.equal(result.status,200);const q=await quote(offerFor(await get()));assert.equal(q.status,200,JSON.stringify(q));const price=kind==='image'?q.body.unit_price:q.body.binding.offer.sale_price;assert.equal(price.amount,amount)
     report.checks.push({kind,amount,publish_status:200,quote_status:200,price})
    }
   }
   await publish(await save(original.draft.products))
   const current=await get(),offer=offerFor(current),positive=await quote(offer);assert.equal(positive.status,200,JSON.stringify(positive));assert(positive.body.quote_token)
   // Simulate a legacy zero snapshot in this disposable database, never a real Account.
   // A valid quoted task must not run after the persisted published price becomes zero.
   const historical=structuredClone(current)
   for(const p of historical.published.products)if(p.product_id===first.product_id)for(const rule of p.pricing_rules)rule.sale_price.amount='0'
   for(const o of historical.published.offers)if(o.product_id===first.product_id)o.sale_price.amount='0'
   const pub=historical.published
   pub.revision='mwp_'+createHash('sha256').update(JSON.stringify({Source:pub.source_draft_revision,Products:pub.products,Offers:pub.offers,Dependencies:pub.dependencies})).digest('hex')
   const setConfig=c=>sql(`update accounts set extra=jsonb_set(extra,'{media_workbench_v1}',convert_from(decode('${Buffer.from(JSON.stringify(c)).toString('base64')}','base64'),'UTF8')::jsonb) where id=${id} and name like 'Synthetic %';`)
   try{
    setConfig(historical)
    const catalog=await call(`/v1/studio/${kind}s/catalog`,'GET',null,headers);assert.equal(catalog.status,200);assert(!catalog.body.offers.some(o=>o.product_id===first.product_id))
    const rejected=await quote(offer);assert.equal(rejected.status,409,JSON.stringify(rejected))
    const submit=await call(`/v1/studio/${kind}s/tasks`,'POST',{quote_token:positive.body.quote_token,task_id:kind==='image'?'retail-zero-image':'av_retail_zero_video',...(kind==='image'?{prompt:'Synthetic zero rejection',references:[]}: {})},headers)
    assert.equal(submit.status,409,JSON.stringify(submit))
    report.checks.push({kind,legacy_zero_catalog_excluded:true,quote_status:rejected.status,generate_status:submit.status,no_new_quote:true})
   }finally{setConfig(current)}
   assert.equal(ledger(),before.ledger)
   const after=stats();assert.equal(after.image_posts,before.stats.image_posts);assert.equal(after.video_posts,before.stats.video_posts)
   report.checks.push({kind,generation_requests:0,ledger_changes:0})
  }finally{const restored=await save(original.draft.products);const published=await publish(restored);assert.equal(published.status,200)}
 }
 report.pass=true
})().catch(e=>{report.error=e.message;console.error(e);process.exitCode=1}).finally(()=>fs.writeFileSync(`${root}/evidence/native-positive-retail.json`,JSON.stringify(report,null,2)))
