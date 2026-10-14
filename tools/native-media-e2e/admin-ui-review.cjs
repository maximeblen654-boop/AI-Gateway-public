// Formal Vue admin pages from Core, real APIs/DB; only upstream is simulated.
const fs=require('node:fs'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const {chromium,expect}=require('../../frontend/node_modules/@playwright/test')
const root=process.argv[2],base='http://127.0.0.1:28100'
assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO,'admin-ui-review')
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted')
const fixture=JSON.parse(fs.readFileSync(`${root}/evidence/fixture.json`)),compose=JSON.parse(fs.readFileSync(`${root}/compose.json`))
assert.equal(compose.services.core.environment.ADMIN_EMAIL,'native-admin@example.invalid')
const db = sql => JSON.parse(execFileSync('docker',['exec','ai-gateway-native-postgres-20261012','psql','-U','native','-d','sub2api','-At','-c',sql],{encoding:'utf8'}))
const report={checks:[],screenshots:[]}
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true})
 const page=await browser.newPage({locale:'zh-CN',viewport:{width:1440,height:1000}});page.setDefaultTimeout(20000)
 const proof=require('./artifact-assets.cjs')(page),w=id=>page.locator(`[data-test="${id}"]`)
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept())
 await page.addInitScript(()=>{localStorage.setItem('sub2api_locale','zh');localStorage.setItem('admin_guide_1_admin_v4_interactive','true')})
 const api=async(path,method='GET',body)=>{
  const r=await page.evaluate(async({path,method,body})=>{const r=await fetch('/api/v1'+path,{method,headers:{'Content-Type':'application/json','X-Admin-UI-Request':'1',Authorization:'Bearer '+localStorage.getItem('auth_token')},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()}},{path,method,body})
  assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.code,0);return r.data.data
 }
 const imagePath=`/admin/media-workbench/accounts/${fixture.accounts.openai}`
 const config=async()=> (await api(imagePath)).media_workbench_v1
 const save=async products=>{const c=await config();return (await api(imagePath+'/draft','PUT',{expected_record_version:c.record_version,draft:{products}})).media_workbench_v1}
 const publish=async c=>api(imagePath+'/publish','POST',{expected_record_version:c.record_version,expected_draft_revision:c.draft.revision})
 async function openImage(){await page.goto(base+'/admin/media');await w('account-search').fill('#'+fixture.accounts.openai);await w('supplier-'+fixture.accounts.openai).click();await w('model-gpt-image-2').click()}
 try{
  await page.goto(base+'/login');await page.getByLabel('邮箱').fill(compose.services.core.environment.ADMIN_EMAIL);await page.getByLabel('密码').fill(compose.services.core.environment.ADMIN_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard')
  const original=await config();assert.equal(original.validation.previews.length,64)
  const first=original.draft.products.find(p=>p.display_name==='Synthetic geometry image')
  assert(first);assert.equal(original.draft.products.length,2)
  const persisted=db(`select extra->'media_workbench_v1'->'draft'->'products' from accounts where id=${fixture.accounts.openai} and name like 'Synthetic %'`)
  assert.deepEqual(persisted,original.draft.products)
  report.persisted_products=original.draft.products;report.preview_count=64;report.published_offers=original.published.offers.map(o=>({id:o.offer_id,spec:o.spec_match}))
  report.checks.push('Real UI saves reread identically from PostgreSQL; two independent products; 64 sampled previews do not truncate products/offers')
  await openImage();await w('product-select').selectOption(first.product_id);await w('wizard-step-4').click()
  for(const width of [1440,390])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:1000});await page.evaluate(t=>{document.documentElement.classList.toggle('dark',t==='dark')},theme)
   await w('open-cost-1').click();await w('cost-purchase').fill('100');await w('cost-credits').fill('1000');await w('cost-consumption-1').fill('8')
   await expect(w('cost-row-1')).toContainText('0.1 CNY')
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
   const shot=`native-admin-formal-${width}-${theme}.png`;await page.screenshot({path:`${root}/evidence/${shot}`,fullPage:false,animations:'disabled'});report.screenshots.push(shot)
   await page.keyboard.press('Escape');await expect(w('open-cost-1')).toBeFocused()
  }
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.classList.remove('dark'))
  // All three price shapes use the real matrix, with equal old prices to make collapse lossless.
  for(let i=0;i<3;i++)await w('price-'+i).fill('0.70')
  await w('wizard-step-1').click();await w('wizard-page-1').getByRole('button',{name:'3:2',exact:true}).click()
  await w('wizard-step-3').click();await expect(w('expected-prices')).toContainText('3 个价格')
  await w('pricing-dimension-aspect_ratio').check();await expect(w('expected-prices')).toContainText('6 个价格')
  await w('pricing-dimension-aspect_ratio').uncheck();await w('pricing-dimension-resolution').uncheck();await expect(w('expected-prices')).toContainText('1 个价格')
  await w('pricing-dimension-resolution').check();await w('wizard-step-4').click();await expect(w('price-2')).toHaveValue('0.70')
  await w('wizard-step-5').click()
  const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith(imagePath+'/draft'))
  await w('save').click();const response=await saved;assert.equal(response.status(),200)
  const request=response.request().postDataJSON();assert(Number.isSafeInteger(request.expected_record_version));assert(!/cost|consumption|purchase|credits/i.test(JSON.stringify(request.draft)))
  const afterSave=(await response.json()).data.media_workbench_v1
  assert.deepEqual(afterSave.published,original.published,'draft edit must not publish')
  assert.deepEqual(afterSave.draft.products.find(p=>p.product_id!==first.product_id),original.draft.products.find(p=>p.product_id!==first.product_id))
  assert.deepEqual(db(`select extra->'media_workbench_v1'->'draft'->'products' from accounts where id=${fixture.accounts.openai}`),afterSave.draft.products)
  report.checks.push('Actual Vue 3/6/1/3 matrix, equal-price preservation, expected_record_version, second product and published snapshot unchanged; no cost fields in save')
  await save(original.draft.products)
  await openImage();await w('product-select').selectOption(first.product_id);await w('wizard-step-4').click();await w('open-cost-1').click();await expect(w('cost-purchase')).toHaveValue('100')
  await page.keyboard.press('Escape');await expect(w('price-1')).toHaveValue('0.90')
  await w('wizard-step-5').click();await w('return-models').click();await w('publish').click();await expect(page.locator('dialog[open]')).toContainText('Account')
  assert.deepEqual((await config()).published,original.published)
  await page.locator('dialog[open]').getByRole('button',{name:'取消',exact:true}).click()
  report.checks.push('Cost parameters persisted locally across reload without price mutation; Account publication requires separate confirmation')
  // Historical mappings and invalid pixel/ratio combinations still use server compilation.
  const mapped=structuredClone(original.draft.products)
  mapped[0].adapter_config.size_mappings=[{resolution:'1K',aspect_ratio:'1:1',wire_size:'1024x1024'}]
  let c=await save(mapped);assert.equal(c.validation.publish_ready,true)
  assert(c.validation.previews.some(p=>p.spec.resolution==='1K'&&p.spec.aspect_ratio==='1:1'&&p.fields?.size==='1024x1024'))
  mapped[0].adapter_config.size_mappings[0].wire_size='1536x1024'
  c=await save(mapped);assert.equal(c.validation.publish_ready,false)
  report.mapping_rejection=c.validation.diagnostics
  await save(original.draft.products)
  report.checks.push('Valid historical size mapping retained in shared preview; pixel/aspect conflict rejected by real server')
  // Existing zero video contract is not broadened; inspect actual catalog exclusion.
  const vp=`/admin/media-workbench/accounts/${fixture.accounts.compatible}`
  let vc=(await api(vp)).media_workbench_v1;const videoOriginal=structuredClone(vc.draft.products)
  const zero=structuredClone(videoOriginal);zero[0].pricing_rules.forEach(r=>r.sale_price.amount='0')
  vc=(await api(vp+'/draft','PUT',{expected_record_version:vc.record_version,draft:{products:zero}})).media_workbench_v1
  vc=(await api(vp+'/publish','POST',{expected_record_version:vc.record_version,expected_draft_revision:vc.draft.revision})).media_workbench_v1
  const freeVideoIDs=vc.published.offers.filter(o=>o.product_id===zero[0].product_id).map(o=>o.offer_id);assert(freeVideoIDs.length>0,'published zero offer must actually exist for exclusion test')
  const user=await browser.newPage({locale:'zh-CN'});await user.addInitScript(()=>{localStorage.setItem('sub2api_locale','zh');localStorage.setItem('user_guide_2_user_v4_interactive','true')});await user.goto(base+'/login');await user.getByLabel('邮箱').fill('native-customer@example.invalid');await user.getByLabel('密码').fill('Native-Customer-Only-20261012');await user.getByRole('button',{name:'登录',exact:true}).click();await user.waitForURL('**/dashboard');await user.goto(base+'/video-studio')
  await expect.poll(()=>user.getByTestId('studio-offer-select').locator('option').count()).toBeGreaterThan(0);await user.getByTestId('studio-mode-video').click();await expect(user.getByTestId('studio-model-toggle')).toBeEnabled()
  const catalog=await user.evaluate(async()=>{const r=await fetch('/studio-v2/api/video/catalog',{headers:{'X-Studio-Request':'video-binding-v1'}});return {status:r.status,body:await r.json()}})
  assert.equal(catalog.status,200);assert(Array.isArray(catalog.body.offers));assert(catalog.body.offers.length>0,'positive companion offer must remain visible');assert(!catalog.body.offers.some(o=>o.product_id===zero[0].product_id));assert(catalog.body.offers.some(o=>o.product_id===zero[1].product_id&&o.published_revision===vc.published.revision&&Number(o.sale_price.amount)>0))
  report.video_zero={filtered_offer_ids:freeVideoIDs,catalog_offer_ids:catalog.body.offers.map(o=>o.offer_id)};await user.close()
  vc=(await api(vp)).media_workbench_v1;vc=(await api(vp+'/draft','PUT',{expected_record_version:vc.record_version,draft:{products:videoOriginal}})).media_workbench_v1
  await api(vp+'/publish','POST',{expected_record_version:vc.record_version,expected_draft_revision:vc.draft.revision})
  report.checks.push('Zero video published historical contract is excluded from actual customer catalog; positive video restored')
  const free=structuredClone(original.draft.products);free.find(p=>p.product_id===first.product_id).pricing_rules.find(r=>r.match.resolution.includes('1K')).sale_price.amount='0'
  await publish(await save(free))
  report.checks.push('Explicit free image set only in synthetic Account for customer quote/generation verification')
  assert.deepEqual(errors,[]);report.assets=await proof();report.pass=true
 }catch(e){report.error=e.message;await page.screenshot({path:`${root}/evidence/native-admin-review-failure.png`,fullPage:true});throw e}
 finally{fs.writeFileSync(`${root}/evidence/native-admin-ui-review.json`,JSON.stringify(report,null,2));await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
