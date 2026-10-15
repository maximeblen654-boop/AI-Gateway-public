// Final-image task UX acceptance. Real Core/Bridge/BFF and native accounting;
// only the existing synthetic supplier injects delay and an ambiguous HTTP 502.
const fs=require('node:fs'),assert=require('node:assert/strict')
const {createHash}=require('node:crypto'),{execFileSync}=require('node:child_process')
const {chromium,expect}=require('../../frontend/node_modules/@playwright/test')
const root=process.argv[2],base='http://127.0.0.1:28100'
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO,'paid-controls');assert(root.endsWith('/native-media-20261012'))
const stats=()=>JSON.parse(fs.readFileSync(root+'/evidence/native-supplier-state.json'))
const sql=q=>execFileSync('docker',['exec','ai-gateway-native-postgres-20261012','psql','-U','native','-d','sub2api','-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}).trim()
const ledger=id=>{assert(/^img_[a-f0-9]{32}$/.test(id));const key=createHash('sha256').update('studio-image:'+id).digest('hex');return JSON.parse(sql(`SELECT json_build_object('usage',(SELECT count(*) FROM usage_logs WHERE request_id='${key}'),'dedup',(SELECT count(*) FROM usage_billing_dedup WHERE request_id='${key}'),'cost',(SELECT COALESCE(sum(actual_cost),0) FROM usage_logs WHERE request_id='${key}'))`))}
const balance=()=>Number(sql("SELECT balance FROM users WHERE email='native-customer@example.invalid'"))
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
const original=createHash('sha256').update(png).digest('hex')
const report={production:false,api_mocking:false,checks:[],screenshots:[],tasks:[],http:[]}
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(30000)
 const proof=require('./artifact-assets.cjs')(page)
 page.on('response',r=>{if(r.url().startsWith(base+'/studio-v2/api/'))report.http.push({path:new URL(r.url()).pathname,method:r.request().method(),status:r.status()})})
 await page.addInitScript(()=>{localStorage.setItem('sub2api_locale','zh');localStorage.setItem('user_guide_2_user_v4_interactive','true')})
 const media=(op)=>page.evaluate(async op=>{const r=await fetch('/studio-v2/api/image/'+op,{headers:{'X-Studio-Request':'image-binding-v1'}});return{status:r.status,body:await r.json()}},op)
 const screenshot=async name=>{await expect(page.getByRole('dialog')).toBeHidden();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:root+'/evidence/'+name,animations:'disabled',fullPage:true});report.screenshots.push(name)}
 const login=async()=>{await page.goto(base+'/login');await page.getByLabel('邮箱').fill('native-customer@example.invalid');await page.getByLabel('密码').fill('Native-Customer-Only-20261012');await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard');const catalogReady=page.waitForResponse(r=>r.url().endsWith('/studio-v2/api/image/catalog')&&r.request().method()==='GET'&&r.status()===200);await page.goto(base+'/video-studio');await catalogReady;await expect(page.getByTestId('studio-model-toggle')).toBeEnabled();await expect(page.getByTestId('studio-mode-text')).toBeEnabled()}
 let offer
 async function prepare(prompt,count=1,edit=false){
  await page.getByTestId(edit?'studio-mode-edit':'studio-mode-text').click();await expect(page.getByTestId('studio-prompt')).toBeVisible()
  await page.getByTestId('studio-model-toggle').click();await page.locator(`[data-offer-id="${offer.offer_id}"]`).click()
  await page.getByTestId('studio-resolution').click();await page.locator('#studio-resolution-menu [data-value="4K"]').click()
  await page.getByTestId('studio-ratio-toggle').click();await page.locator('[data-ratio="16:9"]').click()
  await page.getByTestId('studio-count').click();await page.locator(`#studio-count-menu [data-value="${count}"]`).click()
  if(edit){await page.getByTestId('studio-asset-input').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:png});await expect(page.getByTestId('studio-asset-success')).toHaveCount(1)}
  await page.getByTestId('studio-prompt').fill(prompt)
  const ready=page.waitForResponse(r=>r.url().endsWith('/studio-v2/api/image/prepare')&&r.request().method()==='POST')
  await page.getByTestId('studio-quote').click();const response=await ready;assert.equal(response.status(),200);const q=await response.json();assert.equal(q.spec.resolution,'4K');assert.equal(q.spec.aspect_ratio,'16:9');assert.equal(q.spec.count,count);assert.equal(q.spec.images,edit?1:0)
  await expect(page.getByTestId('studio-confirm-generate')).toBeVisible();report.tasks.push({id:q.task_id,prompt,spec:q.spec,price:q.total_price||q.sale_price});return q
 }
 const pick=async id=>{await page.getByTestId('studio-mode-history').click();await page.locator(`[data-task-id="${id}"]`).click();await expect(page.getByTestId('studio-refresh')).toBeEnabled()}
 try{
  await login();const catalog=await media('catalog');assert.equal(catalog.status,200);const product=JSON.parse(fs.readFileSync(root+'/evidence/native-geometry-browser.json')).products.find(p=>p.display_name==='Synthetic geometry image');offer=catalog.body.offers.find(o=>o.product_id===product.product_id&&o.spec.resolution.includes('4K'));assert(offer)
  report.before={image_posts:stats().image_posts,video_posts:stats().video_posts,balance:balance()}
  const unknown=await prepare('SYNTHETIC_UNKNOWN_502 original three outputs',3)
  const submitted=page.waitForResponse(r=>r.url().endsWith('/studio-v2/api/image/tasks')&&r.request().method()==='POST');await page.getByTestId('studio-confirm-generate').click();await submitted
  await expect(page.getByTestId('studio-status')).toHaveText('结果待确认');await expect(page.getByTestId('studio-waiting')).toContainText('不等于仍在正常生成')
  const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:250,downloadThroughput:-1,uploadThroughput:-1})
  await page.getByTestId('studio-refresh').click();await expect(page.getByTestId('studio-refresh')).toHaveAttribute('aria-busy','true');await screenshot('native-task-query-loading-desktop.png');await expect(page.getByTestId('studio-query-feedback')).toContainText('原任务已更新：结果待确认');await expect(page.getByTestId('studio-refresh')).toBeEnabled();await page.getByTestId('studio-refresh').click();await expect(page.getByTestId('studio-query-feedback')).toContainText('暂无新结果');await expect(page.getByTestId('studio-refresh')).toBeEnabled()
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1})
  await context.setOffline(true);await page.getByTestId('studio-refresh').click();await expect(page.getByTestId('studio-query-error')).toContainText('查询未完成');await screenshot('native-task-query-error-desktop.png');await context.setOffline(false)
  assert.deepEqual(ledger(unknown.task_id),{usage:0,dedup:0,cost:0});assert.equal(stats().image_posts,report.before.image_posts+1);assert.equal(balance(),report.before.balance)
  await page.getByTestId('studio-new').click();await expect(page.getByTestId('studio-prompt')).toBeVisible();await page.getByTestId('studio-mode-edit').click();await expect(page.getByTestId('studio-attachment')).toBeVisible();await page.getByTestId('studio-mode-video').click();await expect(page.getByTestId('studio-duration')).toBeVisible();await page.getByTestId('studio-mode-text').click();await expect(page.getByTestId('studio-model-toggle')).toBeEnabled();await expect(page.getByTestId('studio-prompt')).toBeVisible()
  await page.reload();await expect(page.getByTestId('studio-model-toggle')).toBeEnabled();await expect(page.getByTestId('studio-prompt')).toBeVisible();await expect(page.locator(`[data-task-id="${unknown.task_id}"]`)).toBeVisible();report.checks.push('502 retains unknown receipt, zero charge; text/edit/video navigation and refresh stay usable; query has loading, timestamp and persistent offline failure')
  // Respect the native Account/model transient cooldown after the synthetic 502.
  await new Promise(resolve=>setTimeout(resolve,11000))
  const first=await prepare('SYNTHETIC_WAIT first independent task',1)
  await page.getByTestId('studio-confirm-generate').click();await expect(page.getByTestId('studio-waiting')).toContainText('提交处理中');await expect(page.getByTestId('studio-elapsed')).toContainText('秒');await screenshot('native-task-waiting-desktop.png')
  await page.getByTestId('studio-new').click();await page.getByTestId('studio-prompt').fill('editing while first task waits');await screenshot('native-task-continue-desktop.png')
  const second=await prepare('SYNTHETIC second independent edit',2,true);assert.notEqual(first.task_id,second.task_id)
  await page.getByTestId('studio-confirm-generate').click();await expect(page.getByTestId('studio-status')).toContainText('生成完成',{timeout:60000});await expect(page.getByTestId('studio-download')).toHaveCount(2)
  await expect.poll(()=>ledger(first.task_id).usage,{timeout:60000}).toBe(1);await expect(page.getByTestId('studio-task-id')).toContainText(second.task_id)
  for(const q of [first,second]){const l=ledger(q.task_id);assert.equal(l.usage,1);assert.equal(l.dedup,1);assert.equal(Number(l.cost),Number((q.total_price||q.sale_price).amount));report.tasks.find(t=>t.id===q.task_id).ledger=l}
  report.after_balance=balance();assert.equal(Math.round((report.before.balance-report.after_balance)*1e8),Math.round([first,second].reduce((sum,q)=>sum+Number((q.total_price||q.sale_price).amount),0)*1e8));const beforeRecovery=stats().image_posts
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:960});await pick(second.task_id);await screenshot(`native-task-results-${width}.png`)
   const download=page.waitForEvent('download');await page.getByTestId('studio-download').first().click();const d=await download;assert.equal(await d.failure(),null);const sha=createHash('sha256').update(fs.readFileSync(await d.path())).digest('hex');assert.equal(sha,original);report.original_sha256=sha
   await pick(unknown.task_id);await expect(page.getByTestId('studio-status')).toHaveText('结果待确认');await screenshot(`native-task-unknown-${width}.png`)
   await page.getByTestId('studio-new').click();await page.getByTestId('studio-mode-edit').click();await expect(page.getByTestId('studio-prompt')).toBeVisible();await screenshot(`native-task-continue-${width}.png`)
  }
  // A new authenticated browser session restores server history, not local fake tasks.
  await context.clearCookies();await page.evaluate(()=>{localStorage.removeItem('auth_token');sessionStorage.clear()});await login();await page.getByTestId('studio-mode-history').click();for(const q of [unknown,first,second])await expect(page.locator(`[data-task-id="${q.task_id}"]`)).toBeVisible()
  assert.equal(balance(),report.after_balance);assert.equal(stats().image_posts,beforeRecovery);assert.equal(stats().video_posts,report.before.video_posts)
  for(const q of [first,second])assert.equal(ledger(q.task_id).usage,1);assert.equal(ledger(unknown.task_id).usage,0)
  report.requests=stats().requests.filter(r=>r.method==='POST'&&report.tasks.some(t=>t.prompt===r.body.prompt)).map(r=>({path:r.path,model:r.body.model,n:r.body.n,size:r.body.size,prompt:r.body.prompt}))
  assert.equal(report.requests.filter(r=>r.prompt===report.tasks[0].prompt).length,1)
  assert.equal(report.requests.filter(r=>r.prompt===report.tasks[1].prompt).length,1)
  assert.equal(report.requests.filter(r=>r.prompt===report.tasks[2].prompt).reduce((n,r)=>n+r.n,0),2)
  report.checks.push('Two explicit independent image tasks and frozen prices; edit outputs delivered and original hash verified; exactly one native settlement per completed task; no replay on query/download/relogin; video submissions unchanged')
  report.assets=await proof();report.pass=true
 }catch(e){report.error=e.message;await page.screenshot({path:root+'/evidence/native-task-experience-failure.png'}).catch(()=>{});throw e}
 finally{fs.writeFileSync(root+'/evidence/native-task-experience.json',JSON.stringify(report,null,2));await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
