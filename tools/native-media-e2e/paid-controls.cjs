// Actual isolated Core/Bridge/BFF and Vue UI. Only the supplier is simulated.
const fs=require('node:fs'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const {chromium,expect}=require('../../frontend/node_modules/@playwright/test')
const root=process.argv[2],phase=process.argv[3],base='http://127.0.0.1:28100'
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO,'paid-controls')
assert(root.endsWith('/native-media-20261012'))
const fixture=JSON.parse(fs.readFileSync(root+'/evidence/fixture.json')),compose=JSON.parse(fs.readFileSync(root+'/compose.json'))
assert.equal(compose.services.postgres.environment.POSTGRES_DB,'sub2api');assert.equal(compose.services.core.environment.STUDIO_PAID_CONTROL_MODE,'managed-v1')
const report={phase,checks:[],screenshots:[],http_errors:[],production:false,supplier:'local simulator only'}
const stats=()=>JSON.parse(fs.readFileSync(root+'/evidence/native-supplier-state.json'))
const dc=(...args)=>execFileSync('docker',['compose','-p','ai-gateway-native-20261012','-f',root+'/compose.json',...args],{stdio:'pipe'})
// Isolated dependency-fault injection only. Native Account update automatically
// launches an unrelated Responses capability probe; do not mistake that for a
// preflight request or weaken the zero-network assertion. Positive product flows
// continue through the real Vue/API paths.
const setMapping=(id,mapping)=>{
 assert.equal(id,fixture.accounts.openai);assert(Number.isSafeInteger(id));assert.equal(compose.services.postgres.environment.POSTGRES_DB,'sub2api')
 const value=JSON.stringify(mapping).replace(/'/g,"''")
 const changed=dc('exec','-T','postgres','psql','-U','native','-d','sub2api','-At','-v','ON_ERROR_STOP=1','-c',`UPDATE accounts SET credentials=jsonb_set(credentials,'{model_mapping}','${value}'::jsonb) WHERE id=${id} AND name LIKE 'Synthetic %' RETURNING id`).toString()
 assert(changed.split(/\r?\n/).includes(String(id)))
}
const p='/admin/media-workbench/paid-controls/'
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true})
 const context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}})
 const page=await context.newPage();page.setDefaultTimeout(30000)
 page.on('response',async r=>{if(r.url().startsWith(base+'/studio-v2/api/')&&r.status()>=400){const b=await r.json().catch(()=>({}));report.http_errors.push({path:new URL(r.url()).pathname,status:r.status(),error:b.error,stage:b.diagnostic_stage})}})
 await page.addInitScript(()=>{localStorage.setItem('sub2api_locale','zh');localStorage.setItem('admin_guide_1_admin_v4_interactive','true')})
 const raw=async(path,method='GET',body)=>page.evaluate(async({path,method,body})=>{const r=await fetch('/api/v1'+path,{method,headers:{'Content-Type':'application/json','X-Admin-UI-Request':'1',Authorization:'Bearer '+localStorage.getItem('auth_token')},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()}},{path,method,body})
 const api=async(...args)=>{const r=await raw(...args);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.code,0,JSON.stringify(r));return r.body.data}
 const media=async(kind,op,method='GET',body)=>page.evaluate(async({kind,op,method,body})=>{const r=await fetch(`/studio-v2/api/${kind}/${op}`,{method,headers:{'Content-Type':'application/json','X-Studio-Request':kind+'-binding-v1'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()}},{kind,op,method,body})
 const current=kind=>api(p+kind)
 const change=async(kind,enabled,check)=>{const s=await current(kind);return raw(p+kind,'PUT',{enabled,expected_revision:s.revision,fingerprint:check?.fingerprint||''})}
 const check=async kind=>{const r=await api(p+kind+'/check','POST',{});assert.equal(r.pass,true,JSON.stringify(r));return r}
 try{
  await page.goto(base+'/login');await page.getByLabel('邮箱').fill(compose.services.core.environment.ADMIN_EMAIL);await page.getByLabel('密码').fill(compose.services.core.environment.ADMIN_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard')
  if(phase==='seed'){
   // Synthetic only. Reproduce #77's shape: catalog model plus unrelated aliases.
   const a=await api('/admin/accounts/'+fixture.accounts.openai)
   setMapping(a.id,{'legacy-image':'other-image'})
   const user=await api('/auth/me');assert.equal(user.email,'native-admin@example.invalid')
   await api('/admin/users/'+user.id,'PUT',{allowed_groups:Object.values(fixture.groups)})
   const funded=await api('/admin/users/'+user.id+'/balance','POST',{balance:100,operation:'set',notes:'Isolated preflight fixture only'});assert.equal(Number(funded.balance),100)
   for(const gid of [fixture.groups.openai,fixture.groups.grok])await api('/keys','POST',{name:'Synthetic preflight '+gid,group_id:gid})
   report.checks.push('Existing synthetic Account catalog with unrelated mapping, admin native keys and test credit; no product binding prefilled')
  }else if(phase==='scale'){
   const proof=require('./artifact-assets.cjs')(page)
   for(const kind of ['image','video']){assert.equal((await current(kind)).effective_enabled,false)}
   const before=stats()
   const accountPath='/admin/media-workbench/accounts/'+fixture.accounts.openai
   let detail=await api(accountPath),config=detail.media_workbench_v1
   const products=structuredClone(config.draft.products)
   // The existing geometry browser fixture deliberately creates two independent
   // image products. Preserve both records; make only the target sellable for
   // this exact 1,870-domain performance case (isolated database only).
   const imageProducts=products.filter(p=>p.media_type==='image')
   assert.equal(imageProducts.length,2)
   const product=imageProducts[0]
   const siblingBefore=structuredClone(imageProducts[1])
   imageProducts[1].enabled=false
   report.scale_fixture={target_product_id:product.product_id,preserved_sibling_id:siblingBefore.product_id,sibling_disabled_only_in_isolation:true}
   assert.equal(product.upstream_model,'gpt-image-2')
   Object.assign(product.capabilities,{resolutions:['4K'],aspect_ratios:['1:1','16:9','4:5','5:4','21:9','3:4','4:3','2:3','3:2','9:16','9:21'],qualities:[],durations_seconds:[],count:{min:1,max:10},references:{image:{min:0,max:16},video:{min:0,max:0},audio:{min:0,max:0},total_max:16},combination_rules:[]})
   // Keep the established 1,870 legacy auto-format domain; explicit formats
   // are independently verified by aspect-options with real simulated delivery.
   delete product.capabilities.output_formats
   product.adapter_config.size_mappings=[]
   product.pricing_rules=[{match:{},sale_price:{amount:'0.025',currency:'CNY',billing_mode:'per_request'}}]
   detail=await api(accountPath+'/draft','PUT',{expected_record_version:config.record_version,draft:{products}})
   config=detail.media_workbench_v1
   assert.equal(config.draft.products.length,products.length)
   assert.deepEqual(config.draft.products.find(p=>p.product_id===siblingBefore.product_id),{...siblingBefore,enabled:false})
   assert.equal(config.validation.publish_ready,true,JSON.stringify(config.validation.diagnostics))
   assert.equal(config.validation.case_count,1870)
   await api(accountPath+'/publish','POST',{expected_record_version:config.record_version,expected_draft_revision:config.draft.revision})
   detail=await api(accountPath);assert.deepEqual(detail.media_workbench_v1.published.products[0].capabilities,product.capabilities)
   await page.goto(base+'/admin/media')
   await page.locator('[data-test="paid-toggle"]').click()
   const card=page.locator('[data-test="paid-image"]')
   report.scale={specs:1870,client_timeout_ms:30000,budget_ms:15000,runs:[]}
   // Actual Vue/Axios clicks against final Core, no Vite or browser API mock.
   for(let i=0;i<3;i++){
    const start=Date.now()
    const response=page.waitForResponse(r=>r.url().endsWith(p+'image/check')&&r.request().method()==='POST')
    await card.getByRole('button',{name:'开启前检查',exact:true}).click()
    const r=await response;assert.equal(r.status(),200)
    const result=(await r.json()).data
    await expect(card).toContainText('检查通过')
    const elapsed=Date.now()-start
    assert.equal(result.pass,true,JSON.stringify(result));assert.equal(result.metrics.specs_checked,1870);assert.equal(result.metrics.accounts_validated,1)
    for(const path of ['text','edit'])assert(result.checks.some(c=>c.code==='native_quote'&&c.path===path&&c.pass))
    assert(elapsed<15000,`full UI preflight took ${elapsed}ms`)
    report.scale.runs.push({wall_ms:elapsed,report:result})
   }
   for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});await card.scrollIntoViewIfNeeded()
    const name=`native-preflight-1870-${width}.png`;await page.screenshot({path:root+'/evidence/'+name,animations:'disabled'});report.screenshots.push(name)
   }
   await page.setViewportSize({width:1440,height:1000})
   await card.getByRole('button',{name:'开启图片',exact:true}).click()
   const start=Date.now(),applied=page.waitForResponse(r=>r.url().endsWith(p+'image')&&r.request().method()==='PUT')
   await page.getByRole('button',{name:'确认开启',exact:true}).click()
   const response=await applied;assert.equal(response.status(),200)
   const result=(await response.json()).data
   await expect(card).toContainText('实际已开放')
   const elapsed=Date.now()-start
   assert(result.state.effective_enabled);assert(result.report.pass);assert.equal(result.report.metrics.specs_checked,1870);assert.equal(result.report.metrics.accounts_validated,1)
   assert(elapsed<15000,`server enable recheck took ${elapsed}ms`)
   report.scale.apply={wall_ms:elapsed,report:result.report}
   assert.equal((await current('video')).effective_enabled,false)
   assert.deepEqual(stats(),before,'all 1870 checks and enable recheck must make zero supplier calls')
   if(process.env.NATIVE_CATALOG_RECOVERY==='true') report.catalog_dependencies=await require('./catalog-dependencies.cjs')({fixture,dc,api,current,check,change,media,page,base,accountPath,p,stats,before})
   if(process.env.NATIVE_MODEL_LIFECYCLE==='true') report.model_lifecycle=await require('./model-lifecycle.cjs')({root,fixture,dc,api,raw,current,check,change,media,page,base,accountPath,stats})
   assert.equal((await change('image',false)).status,200)
   assert.equal((await current('image')).effective_enabled,false)
   report.assets=await proof()
   report.checks.push('All 1870 specs checked; three real admin UI preflights and enable recheck under 15s with zero supplier requests; optional lifecycle delivery reported separately; video stayed closed; final both closed')
  }else if(phase==='close'){
   for(const kind of ['image','video']){assert.equal((await change(kind,false)).status,200);assert.equal((await current(kind)).effective_enabled,false)}
   report.checks.push('Both synthetic paid gates closed after simulated task acceptance')
  }else{
   const proof=require('./artifact-assets.cjs')(page)
   await page.goto(base+'/video-studio');await expect.poll(async()=> (await media('image','catalog')).status,{message:'Real UI session exchange and catalog must finish before direct contract checks'}).toBe(200)
   for(const kind of ['image','video']){
    assert.equal((await current(kind)).effective_enabled,false)
    assert.equal((await media(kind,'readiness')).body.paid_enabled,false)
    assert.equal((await media(kind,'tasks','POST',{})).status,503)
   }
   const before=stats();report.supplier_before_checks=before
   const catalogResponse=await media('image','catalog');assert.equal(catalogResponse.status,200,JSON.stringify(catalogResponse))
   const catalog=catalogResponse.body;assert(Array.isArray(catalog.offers),JSON.stringify(catalog))
   const offer=catalog.offers.find(o=>o.upstream_model==='gpt-image-2'&&o.spec.resolution.includes('1K'));assert(offer)
   for(const images of [0,1]){
    const r=await media('image','quotes','POST',{offer_id:offer.offer_id,spec:{resolution:'1K',aspect_ratio:'1:1',count:1,images,videos:0,audio:0,duration_seconds:0,quality:''}})
    assert.equal(r.status,200,JSON.stringify(r));report.checks.push((images?'edit':'text')+' real BFF → Bridge → Core quote succeeds while paid closed with unrelated legacy mapping')
   }
   assert.deepEqual(stats(),before,'closed quote must not reach supplier')
   // Native permission/balance failure must stay closed and retain a safe category.
   const admin=await api('/auth/me');assert.equal(admin.email,'native-admin@example.invalid')
   await api('/admin/users/'+admin.id+'/balance','POST',{balance:100,operation:'subtract',notes:'Isolated refusal test'})
   try{
    for(const images of [0,1]){
     const denied=await media('image','quotes','POST',{offer_id:offer.offer_id,spec:{resolution:'1K',aspect_ratio:'1:1',count:1,images,videos:0,audio:0,duration_seconds:0,quality:''}})
     assert.equal(denied.status,409);assert.equal(denied.body.diagnostic_stage,'billing_eligibility')
    }
    assert.equal((await api(p+'image/check','POST',{})).pass,false);assert.equal((await current('image')).effective_enabled,false)
   }finally{await api('/admin/users/'+admin.id+'/balance','POST',{balance:100,operation:'add',notes:'Restore isolated preflight fixture'})}
   report.checks.push('Native insufficient balance rejects both quotes and preflight without opening; safe billing diagnostic preserved')
   const imageCheck=await check('image'),videoCheck=await check('video')
   assert(imageCheck.checks.some(c=>c.code==='native_quote'&&c.path==='edit'&&c.pass));assert(imageCheck.checks.some(c=>c.code==='native_quote'&&c.path==='text'&&c.pass))
   assert.deepEqual(stats(),before,'preflight must not contact supplier')
   assert.equal((await change('image',true,{fingerprint:'stale'})).status,409)
   assert.equal((await current('image')).effective_enabled,false)
   await page.goto(base+'/admin/media')
   await page.locator('[data-test="paid-toggle"]').click()
   const imageCard=page.locator('[data-test="paid-image"]')
   await imageCard.getByRole('button',{name:'开启前检查',exact:true}).click();await expect(imageCard).toContainText('检查通过')
   await imageCard.getByRole('button',{name:'开启图片',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible()
   assert.equal((await current('image')).effective_enabled,false,'confirmation must precede change')
   await page.getByRole('button',{name:'确认开启',exact:true}).click();await expect(imageCard).toContainText('实际已开放')
   assert.equal((await current('video')).effective_enabled,false)
   for(const width of [1440,390])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme)
    await imageCard.scrollIntoViewIfNeeded();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),{timeout:10000,message:'Responsive layout must settle without horizontal overflow'}).toBe(true)
    const name=`native-paid-controls-${width}-${theme}.png`;await page.screenshot({path:root+'/evidence/'+name,animations:'disabled'});report.screenshots.push(name)
   }
   // An unprivileged customer cannot check or apply the administrator gate.
   const customer=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'native-customer@example.invalid',password:'Native-Customer-Only-20261012'})}).then(r=>r.json());assert.equal(customer.code,0)
   for(const [op,method,body] of [['/check','POST',{}],['','PUT',{enabled:true}]]){
    const denied=await fetch(base+'/api/v1'+p+'image'+op,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+customer.data.access_token},body:JSON.stringify(body)});assert.equal(denied.status,403)
   }
   // API alias changes are not a Studio product/model dependency in v1.
   const original=await api('/admin/accounts/'+fixture.accounts.openai)
   setMapping(original.id,{'gpt-image-2':'different-upstream'})
   assert.equal((await current('image')).effective_enabled,true)
   await page.goto(base+'/video-studio');await expect.poll(async()=> (await media('image','catalog')).status,{message:'Real UI session exchange and catalog'}).toBe(200)
   for(const images of [0,1]){
    const r=await media('image','quotes','POST',{offer_id:offer.offer_id,spec:{resolution:'1K',aspect_ratio:'1:1',count:1,images,videos:0,audio:0,duration_seconds:0,quality:''}})
    assert.equal(r.status,200,JSON.stringify(r.body));assert(!JSON.stringify(r.body).includes('synthetic-native-only'))
   }
   const independent=await api(p+'image/check','POST',{});assert.equal(independent.pass,true)
   assert.equal(independent.fingerprint,imageCheck.fingerprint,'Unrelated API mapping must not invalidate Studio grants')
   setMapping(original.id,original.credentials.model_mapping)
   assert.equal((await current('image')).effective_enabled,true)
   // A real sidecar outage fails the server opening action, not merely the UI.
   dc('stop','bff')
   try{assert.equal((await change('image',true,imageCheck)).status,409);assert.equal((await current('image')).effective_enabled,false)}finally{dc('up','-d','--no-deps','--wait','--wait-timeout','60','bff')}
   report.supplier_after_checks=stats();assert.deepEqual(report.supplier_after_checks,before,'all checks, rejects and drift tests remain non-paid')
   const ready=await check('image');assert.equal((await change('image',true,ready)).status,200)
   assert.equal((await current('image')).effective_enabled,true);assert.equal((await current('video')).effective_enabled,false)
   // Open video independently, solely for the following existing simulated E2E.
   assert.equal((await change('video',true,await check('video'))).status,200)
   assert.equal((await current('image')).effective_enabled,true);assert.equal((await current('video')).effective_enabled,true)
   report.checks.push('Server recheck rejects stale PASS; native permission rejects customer; API mapping drift preserves explicit Studio identity; BFF outage blocks opening; independent video enable; no supplier activity during any preflight')
   report.image_preflight=imageCheck;report.video_preflight=videoCheck;report.assets=await proof()
  }
  report.pass=true
 }catch(e){report.error=e.message;
  const gid=Number(compose.services.bridge.environment.STUDIO_IMAGE_GROUP_ID);assert(Number.isSafeInteger(gid))
  const key=dc('exec','-T','postgres','psql','-U','native','-d','sub2api','-At','-c',`SELECT key FROM api_keys WHERE user_id=1 AND group_id=${gid} ORDER BY id LIMIT 1`).toString().trim()
  if(key){const response=await fetch('http://127.0.0.1:28180/v1/studio/images/catalog',{headers:{Authorization:'Bearer '+key,'X-Studio-Binding-Contract':'published_image_binding_v1'}});const b=await response.json().catch(()=>({}));report.core_catalog_diagnostic={status:response.status,error:b.error,code:b.code,message:b.message,stage:b.diagnostic_stage}}
await page.screenshot({path:root+'/evidence/native-paid-failure-'+phase+'.png'});throw e}
 finally{if(!report.pass)console.error(JSON.stringify({http_errors:report.http_errors,core_catalog_diagnostic:report.core_catalog_diagnostic}));fs.writeFileSync(root+'/evidence/native-paid-controls-'+phase+'.json',JSON.stringify(report,null,2));await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
