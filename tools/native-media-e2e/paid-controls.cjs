// Actual isolated Core/Bridge/BFF and Vue UI. Only the supplier is simulated.
const fs=require('node:fs'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const {chromium,expect}=require('../../frontend/node_modules/@playwright/test')
const root=process.argv[2],phase=process.argv[3],base='http://127.0.0.1:28100'
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO,'paid-controls')
assert(root.endsWith('/native-media-20261012'))
const fixture=JSON.parse(fs.readFileSync(root+'/evidence/fixture.json')),compose=JSON.parse(fs.readFileSync(root+'/compose.json'))
assert.equal(compose.services.postgres.environment.POSTGRES_DB,'sub2api');assert.equal(compose.services.core.environment.STUDIO_PAID_CONTROL_MODE,'managed-v1')
const report={phase,checks:[],screenshots:[],production:false,supplier:'local simulator only'}
const stats=()=>JSON.parse(fs.readFileSync(root+'/evidence/native-supplier-state.json'))
const dc=(...args)=>execFileSync('docker',['compose','-p','ai-gateway-native-20261012','-f',root+'/compose.json',...args],{stdio:'pipe'})
const p='/admin/media-workbench/paid-controls/'
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true})
 const page=await browser.newPage({locale:'zh-CN',viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000)
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
   await api('/admin/accounts/'+a.id,'PUT',{credentials:{...a.credentials,model_mapping:{'legacy-image':'other-image'}}})
   const user=await api('/auth/me');assert.equal(user.email,'native-admin@example.invalid')
   await api('/admin/users/'+user.id,'PUT',{balance:100,allowed_groups:Object.values(fixture.groups)})
   for(const gid of [fixture.groups.openai,fixture.groups.grok])await api('/keys','POST',{name:'Synthetic preflight '+gid,group_id:gid})
   report.checks.push('Existing synthetic Account catalog with unrelated mapping, admin native keys and test credit; no product binding prefilled')
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
   const before=stats()
   const catalogResponse=await media('image','catalog');assert.equal(catalogResponse.status,200,JSON.stringify(catalogResponse))
   const catalog=catalogResponse.body;assert(Array.isArray(catalog.offers),JSON.stringify(catalog))
   const offer=catalog.offers.find(o=>o.upstream_model==='gpt-image-2'&&o.spec.resolution.includes('1K'));assert(offer)
   for(const images of [0,1]){
    const r=await media('image','quotes','POST',{offer_id:offer.offer_id,spec:{resolution:'1K',aspect_ratio:'1:1',count:1,images,videos:0,audio:0,duration_seconds:0,quality:''}})
    assert.equal(r.status,200,JSON.stringify(r));report.checks.push((images?'edit':'text')+' real BFF → Bridge → Core quote succeeds while paid closed with unrelated legacy mapping')
   }
   assert.deepEqual(stats(),before,'closed quote must not reach supplier')
   const imageCheck=await check('image'),videoCheck=await check('video')
   assert(imageCheck.checks.some(c=>c.code==='native_quote'&&c.path==='edit'&&c.pass));assert(imageCheck.checks.some(c=>c.code==='native_quote'&&c.path==='text'&&c.pass))
   assert.deepEqual(stats(),before,'preflight must not contact supplier')
   assert.equal((await change('image',true,{fingerprint:'stale'})).status,409)
   assert.equal((await current('image')).effective_enabled,false)
   await page.goto(base+'/admin/media')
   const imageCard=page.locator('[data-test="paid-image"]')
   await imageCard.getByRole('button',{name:'开启前检查',exact:true}).click();await expect(imageCard).toContainText('检查通过')
   await imageCard.getByRole('button',{name:'开启图片',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible()
   assert.equal((await current('image')).effective_enabled,false,'confirmation must precede change')
   await page.getByRole('button',{name:'确认开启',exact:true}).click();await expect(imageCard).toContainText('实际已开放')
   assert.equal((await current('video')).effective_enabled,false)
   for(const width of [1440,390])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.classList.toggle('dark',t==='dark'),theme)
    await imageCard.scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
    const name=`native-paid-controls-${width}-${theme}.png`;await page.screenshot({path:root+'/evidence/'+name,animations:'disabled'});report.screenshots.push(name)
   }
   // An unprivileged customer cannot check or apply the administrator gate.
   const customer=await fetch(base+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'native-customer@example.invalid',password:'Native-Customer-Only-20261012'})}).then(r=>r.json());assert.equal(customer.code,0)
   for(const [op,method,body] of [['/check','POST',{}],['','PUT',{enabled:true}]]){
    const denied=await fetch(base+'/api/v1'+p+'image'+op,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+customer.data.access_token},body:JSON.stringify(body)});assert.equal(denied.status,403)
   }
   // Drift the synthetic mapping only; quote errors must carry a safe stage.
   const original=await api('/admin/accounts/'+fixture.accounts.openai)
   await api('/admin/accounts/'+original.id,'PUT',{credentials:{...original.credentials,model_mapping:{'gpt-image-2':'different-upstream'}}})
   assert.equal((await current('image')).effective_enabled,false)
   await page.goto(base+'/video-studio');await expect.poll(async()=> (await media('image','catalog')).status,{message:'Real UI session exchange and catalog must finish before direct contract checks'}).toBe(200)
   for(const images of [0,1]){
    const r=await media('image','quotes','POST',{offer_id:offer.offer_id,spec:{resolution:'1K',aspect_ratio:'1:1',count:1,images,videos:0,audio:0,duration_seconds:0,quality:''}})
    assert.equal(r.status,409);assert.equal(r.body.diagnostic_stage,'published_offer');assert(!JSON.stringify(r.body).includes('synthetic-native-only'))
   }
   const failed=await api(p+'image/check','POST',{});assert.equal(failed.pass,false)
   assert.equal((await change('image',true,imageCheck)).status,409)
   await api('/admin/accounts/'+original.id,'PUT',{credentials:original.credentials})
   assert.equal((await current('image')).effective_enabled,false,'restoring a dependency does not restore old PASS')
   // A real sidecar outage fails the server opening action, not merely the UI.
   dc('stop','bff')
   try{assert.equal((await change('image',true,imageCheck)).status,409);assert.equal((await current('image')).effective_enabled,false)}finally{dc('up','-d','--no-deps','--wait','--wait-timeout','60','bff')}
   assert.deepEqual(stats(),before,'all checks, rejects and drift tests remain non-paid')
   const ready=await check('image');assert.equal((await change('image',true,ready)).status,200)
   assert.equal((await current('image')).effective_enabled,true);assert.equal((await current('video')).effective_enabled,false)
   // Open video independently, solely for the following existing simulated E2E.
   assert.equal((await change('video',true,await check('video'))).status,200)
   assert.equal((await current('image')).effective_enabled,true);assert.equal((await current('video')).effective_enabled,true)
   report.checks.push('Server recheck rejects stale PASS; native permission rejects customer; mapping drift invalidates text/edit; BFF outage blocks opening; independent video enable; no supplier activity during any preflight')
   report.image_preflight=imageCheck;report.video_preflight=videoCheck;report.assets=await proof()
  }
  report.pass=true
 }catch(e){report.error=e.message;await page.screenshot({path:root+'/evidence/native-paid-failure-'+phase+'.png'});throw e}
 finally{fs.writeFileSync(root+'/evidence/native-paid-controls-'+phase+'.json',JSON.stringify(report,null,2));await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
