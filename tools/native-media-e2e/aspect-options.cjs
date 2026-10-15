// Final Core UI and real isolated APIs; only the upstream supplier is simulated.
const fs=require('node:fs'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process'),{createHash,randomUUID}=require('node:crypto')
const {chromium,expect}=require('../../frontend/node_modules/@playwright/test')
const root=process.argv[2],phase=process.argv[3],base='http://127.0.0.1:28100'
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.NATIVE_WORKSPACE_ARTIFACT,'true');assert.notEqual(process.env.NATIVE_WORKSPACE_DEV_SERVER,'true')
assert(root&&root.endsWith('/native-media-20261012'));assert(['configure','execute'].includes(phase))
const fixture=JSON.parse(fs.readFileSync(root+'/evidence/fixture.json')),compose=JSON.parse(fs.readFileSync(root+'/compose.json'))
assert.equal(compose.services.core.container_name,'ai-gateway-native-core-20261012');assert.equal(compose.services.postgres.container_name,'ai-gateway-native-postgres-20261012');assert.equal(compose.services.core.environment.ADMIN_EMAIL,'native-admin@example.invalid')
const account=fixture.accounts.openai,videoAccount=fixture.accounts.compatible
assert(Number.isSafeInteger(account));assert(Number.isSafeInteger(videoAccount));assert(Number.isSafeInteger(fixture.customer))
const reportPath=root+'/evidence/native-aspect-options.json',previous=fs.existsSync(reportPath)?JSON.parse(fs.readFileSync(reportPath)):null
assert(!previous?.execution,'Execution was already attempted; do not generate duplicate test tasks')
const report=previous||{checks:[],screenshots:[],production:false,supplier:'local simulator only'}
if(phase==='execute')assert.equal(report.configuration_pass,true)
const stats=()=>JSON.parse(fs.readFileSync(root+'/evidence/native-supplier-state.json'))
const sql=query=>execFileSync('docker',['exec',compose.services.postgres.container_name,'psql','-U','native','-d','sub2api','-At','-v','ON_ERROR_STOP=1','-c','BEGIN READ ONLY; '+query+'; COMMIT;'],{encoding:'utf8'}).split(/\r?\n/).find(line=>line.startsWith('{'))
const ledger=()=>JSON.parse(sql(`SELECT json_build_object('balance',balance,'frozen_balance',frozen_balance,'usage',(SELECT count(*) FROM usage_logs WHERE user_id=${fixture.customer}),'dedup',(SELECT count(*) FROM usage_billing_dedup WHERE api_key_id IN (SELECT id FROM api_keys WHERE user_id=${fixture.customer}))) FROM users WHERE id=${fixture.customer}`))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true})
 const admin=await browser.newPage({locale:'zh-CN',viewport:{width:1440,height:1000}}),customer=await browser.newPage({locale:'zh-CN',viewport:{width:1440,height:1000}})
 const proof=require('./artifact-assets.cjs')(admin),customerProof=require('./artifact-assets.cjs')(customer)
 for(const page of [admin,customer]){page.setDefaultTimeout(30000);await page.addInitScript(()=>{localStorage.setItem('sub2api_locale','zh');localStorage.setItem('admin_guide_1_admin_v4_interactive','true')})}
 admin.on('dialog',dialog=>dialog.accept())
 const login=async(page,email,password)=>{await page.goto(base+'/login');await page.getByLabel('邮箱').fill(email);await page.getByLabel('密码').fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard')}
 const api=async path=>{const r=await admin.evaluate(async path=>{const r=await fetch('/api/v1'+path,{headers:{Authorization:'Bearer '+localStorage.getItem('auth_token')}});return{status:r.status,body:await r.json()}},path);assert.equal(r.status,200);assert.equal(r.body.code,0);return r.body.data}
 const media=async(path,method='GET',body)=>customer.evaluate(async({path,method,body})=>{const r=await fetch('/studio-v2/api/image/'+path,{method,headers:{'Content-Type':'application/json','X-Studio-Request':'image-binding-v1'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()}},{path,method,body})
 const accountPath='/admin/media-workbench/accounts/'+account,w=id=>admin.locator(`[data-test="${id}"]`)
 const openEditor=async id=>{await admin.goto(base+'/admin/media');await w('source-localhost').locator('summary').click();await w(`supplier-${account}`).click();await w('model-gpt-image-2').click();if(await w('product-select').count())await w('product-select').selectOption(id);await w('wizard-step-1').click()}
 const customerPage=async()=>{await customer.goto(base+'/video-studio');await expect.poll(async()=>(await media('catalog')).status).toBe(200)}
 const shot=async(page,name)=>{await page.screenshot({path:root+'/evidence/'+name,fullPage:true,animations:'disabled'});report.screenshots.push(name)}
 try{
  await login(admin,compose.services.core.environment.ADMIN_EMAIL,compose.services.core.environment.ADMIN_PASSWORD)
  await login(customer,'native-customer@example.invalid','Native-Customer-Only-20261012')
  const source=await api('/admin/accounts/'+account);assert.match(source.name,/^Synthetic /);assert.equal(source.credentials.base_url,'https://localhost:19090','Only the established local simulator is allowed')
  await customerPage()
  if(phase==='configure'){
   const before=await api(accountPath),videoBefore=await api('/admin/media-workbench/accounts/'+videoAccount),config=before.media_workbench_v1,products=config.draft.products
   const product=products.find(p=>p.display_name==='Synthetic geometry image')
   assert(product);assert.equal(product.upstream_model,'gpt-image-2');assert.equal(products.length,2);assert.equal(product.adapter_config.size_mappings?.length||0,0);assert(!product.capabilities.aspect_ratios.includes('3:5'))
   report.before={product_ids:products.map(p=>p.product_id),product,sibling:products.find(p=>p.product_id!==product.product_id),video:videoBefore.media_workbench_v1}
   const supplierBefore=stats(),ledgerBefore=ledger(),catalogBefore=await media('catalog');assert.equal(catalogBefore.status,200)
   const oldOffer=catalogBefore.body.offers.find(o=>o.product_id===product.product_id&&o.spec.resolution.includes('1K'))
   assert(oldOffer);assert(!oldOffer.spec.aspect_ratio.includes('3:5'))
   await openEditor(product.product_id)
   for(const ratio of ['1:4','4:1','1:8','8:1']){const chip=w('wizard-page-1').getByRole('button',{name:ratio,exact:true});await expect(chip).toHaveAttribute('aria-pressed','false');await chip.click();await expect(chip).toHaveAttribute('aria-pressed','true');await chip.click();await expect(chip).toHaveAttribute('aria-pressed','false')}
   await w('wizard-page-1').getByRole('button',{name:'1:4',exact:true}).click();await w('custom-ratio-toggle').click()
   await w('custom-ratio-input').fill('0:1');await w('custom-ratio-add').click();await expect(admin.getByRole('alert').filter({hasText:'正整数比例'})).toBeVisible()
   await w('custom-ratio-input').fill(' 3 : 5 ');await w('custom-ratio-add').click();await w('custom-ratio-input').fill('3:5');await w('custom-ratio-add').click();await expect(admin.getByRole('status').filter({hasText:'无需重复添加'})).toBeVisible()
   await w('custom-ratio-input').fill('5:7');await w('custom-ratio-add').click();await admin.getByRole('button',{name:'移除比例 5:7',exact:true}).click()
   await expect(admin.getByRole('button',{name:'移除比例 5:7',exact:true})).toHaveCount(0);await expect(admin.getByRole('button',{name:'移除比例 3:5',exact:true})).toHaveCount(1)
   await shot(admin,'native-aspect-options-desktop.png');await admin.setViewportSize({width:390,height:844});assert(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Mobile horizontal overflow');await shot(admin,'native-aspect-options-mobile.png')
   await w('wizard-step-5').click()
   const saving=admin.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith(`/accounts/${account}/draft`))
   await w('save').click();const saved=await saving;assert.equal(saved.status(),200);report.save_request=saved.request().postDataJSON()
   const reread=(await api(accountPath)).media_workbench_v1
   assert.equal(reread.validation.publish_ready,true,JSON.stringify(reread.validation.diagnostics));assert.deepEqual(reread.draft.products.map(p=>p.product_id),report.before.product_ids)
   const changed=reread.draft.products.find(p=>p.product_id===product.product_id),expected=structuredClone(product);expected.capabilities.aspect_ratios.push('1:4','3:5')
   assert.deepEqual(changed,expected,'Only the selected product ratio list may change');assert.deepEqual(reread.draft.products.find(p=>p.product_id!==product.product_id),report.before.sibling);assert.deepEqual(reread.published,config.published,'Draft save must not publish');assert.equal(changed.adapter_config.size_mappings?.length||0,0)
   const persisted=JSON.parse(sql(`SELECT extra->'media_workbench_v1' FROM accounts WHERE id=${account} AND name='Synthetic openai'`))
   assert.deepEqual(persisted.draft.products,reread.draft.products,'Database draft must equal server re-read')
   report.database_product_ids=persisted.draft.products.map(p=>p.product_id)
   report.saved_product=changed
   await openEditor(product.product_id);await expect(admin.getByRole('button',{name:'移除比例 3:5',exact:true})).toBeVisible()
   const draftCatalog=await media('catalog');assert.equal(draftCatalog.status,200);assert.deepEqual(draftCatalog.body.offers,catalogBefore.body.offers,'Unpublished ratios must not enter customer catalog')
   const spec={resolution:'1K',aspect_ratio:'3:5',count:1,images:0,videos:0,audio:0,duration_seconds:0,quality:''}
   const refused=await media('quotes','POST',{offer_id:oldOffer.offer_id,spec});assert(refused.status>=400&&refused.status<500,JSON.stringify(refused));report.unpublished_quote=refused
   await w('return-models').click();await w('publish').click();await expect(w('confirm-publish')).toBeVisible();await w('confirm-publish').click();await expect(w('sales')).toBeEnabled()
   const published=(await api(accountPath)).media_workbench_v1;assert.deepEqual(published.published.products.find(p=>p.product_id===product.product_id),expected)
   await customerPage();const catalog=await media('catalog');assert.equal(catalog.status,200)
   const offer=catalog.body.offers.find(o=>o.product_id===product.product_id&&o.spec.resolution.includes('1K'));assert(offer&&offer.spec.aspect_ratio.includes('3:5')&&offer.spec.aspect_ratio.includes('1:4'))
   report.quote_checks=[]
   for(const images of [0,1]){const quote=await media('quotes','POST',{offer_id:offer.offer_id,spec:{...spec,images}});assert.equal(quote.status,200,JSON.stringify(quote));report.quote_checks.push({images,status:quote.status,body:quote.body})}
   assert.deepEqual((await api('/admin/media-workbench/accounts/'+videoAccount)).media_workbench_v1,report.before.video)
   assert.deepEqual(stats(),supplierBefore,'UI save/publish/quote must not generate');assert.deepEqual(ledger(),ledgerBefore,'UI save/publish/quote must not settle')
   report.configuration_pass=true
   report.checks.push('Real UI save and API re-read preserve product IDs/prices/sibling/video; unpublished ratio excluded from catalog and rejected by quote; isolated publish admits text/edit quotes without size mappings')
  }else{
   report.execution=[]
   for(const edit of [false,true]){
    const result={mode:edit?'edit':'text',before:{supplier:stats(),ledger:ledger()}};report.execution.push(result);fs.writeFileSync(reportPath,JSON.stringify(report,null,2))
    await customerPage();await customer.getByTestId(edit?'studio-mode-edit':'studio-mode-text').click();await customer.getByTestId('studio-model-toggle').click()
    const catalog=await media('catalog');assert.equal(catalog.status,200)
    const offer=catalog.body.offers.find(o=>o.product_id===report.saved_product.product_id&&o.spec.resolution.includes('1K'));assert(offer)
    await customer.getByTestId('studio-offer-select').selectOption(offer.offer_id)
    await customer.getByTestId('studio-resolution').click();await customer.locator('#studio-resolution-menu [data-value]').filter({hasText:/^1K$/}).click()
    await customer.getByTestId('studio-ratio-toggle').click();await customer.locator('[data-ratio="3:5"]').click();await customer.getByTestId('studio-count').click();await customer.locator('#studio-count-menu [data-value="1"]').click()
    if(edit)await customer.getByTestId('studio-asset-input').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png})
    await customer.getByTestId('studio-prompt').fill('SYNTHETIC custom ratio '+result.mode+' '+randomUUID())
    const quoting=customer.waitForResponse(r=>r.url().endsWith('/studio-v2/api/image/prepare')&&r.request().method()==='POST')
    await customer.getByTestId('studio-quote').click();const quoted=await quoting;result.quote=await quoted.json();assert.equal(quoted.status(),200,JSON.stringify(result.quote));assert.equal(Number(result.quote.sale_price.amount),0.7);result.task_id=result.quote.task_id
    fs.writeFileSync(reportPath,JSON.stringify(report,null,2));assert.deepEqual(ledger(),result.before.ledger);assert.equal(stats().image_posts,result.before.supplier.image_posts)
    await customer.getByTestId('studio-confirm-generate').click();await expect(customer.getByTestId('studio-status')).toContainText('生成完成',{timeout:60000});await expect(customer.getByTestId('studio-result-image')).toHaveCount(1)
    const downloadEvent=customer.waitForEvent('download');await customer.getByTestId('studio-download').click();const download=await downloadEvent
    assert.equal(await download.failure(),null);result.download_sha256=hash(fs.readFileSync(await download.path()));assert.equal(result.download_sha256,hash(png))
    result.after={supplier:stats(),ledger:ledger()}
    const requests=result.after.supplier.requests.slice(result.before.supplier.requests.length).filter(r=>r.method==='POST');assert.equal(requests.length,1);const request=requests[0]
    assert.equal(request.path,edit?'/v1/images/edits':'/v1/images/generations');assert.equal(request.body.model,'gpt-image-2');assert.equal(request.body.resolution,'1K');assert.equal(request.body.aspect_ratio,'3:5');assert.equal(request.body.size,undefined);assert.equal(request.body.n,1);assert.equal(request.body.images?.length||0,edit?1:0)
    assert.equal(result.after.ledger.usage-result.before.ledger.usage,1);assert.equal(result.after.ledger.dedup-result.before.ledger.dedup,1);assert.equal(Math.round((result.before.ledger.balance-result.after.ledger.balance)*100),70);assert.equal(result.after.ledger.frozen_balance,result.before.ledger.frozen_balance)
    await customer.reload();await expect(customer.getByTestId('studio-task-id')).toContainText(result.task_id);await customer.getByTestId('studio-refresh').click();await expect(customer.getByTestId('studio-refresh')).toBeEnabled()
    assert.equal(stats().image_posts,result.after.supplier.image_posts);assert.deepEqual(ledger(),result.after.ledger);await shot(customer,`native-aspect-options-${result.mode}-result.png`)
   }
   report.execution_pass=true
   report.checks.push('Custom ratio reaches real simulated text/edit POST unchanged; original digest matches; native usage/dedup/balance settle once; refresh/query do not regenerate or settle')
  }
  report.assets??={};report.assets[phase]={admin:phase==='configure'?await proof():undefined,customer:await customerProof()}
 }catch(error){report.error=error.message;await shot(phase==='configure'?admin:customer,'native-aspect-options-failure.png');throw error}
 finally{fs.writeFileSync(reportPath,JSON.stringify(report,null,2));await browser.close()}
 console.log(JSON.stringify({phase,configuration_pass:report.configuration_pass,execution_pass:report.execution_pass}))
})().catch(error=>{console.error(error.message);process.exitCode=1})
