// Final Core UI only; existing Ops API and real synthetic traffic, no API mock.
const fs=require('node:fs'),assert=require('node:assert/strict')
const {chromium,expect}=require('../../frontend/node_modules/@playwright/test')
const root=process.argv[2],base='http://127.0.0.1:28100'
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert(root.endsWith('/native-media-20261012'))
const env=JSON.parse(fs.readFileSync(root+'/compose.json')).services.core.environment
const report={production:false,api_mocking:false,screenshots:[],snapshots:[]}
;(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(30000)
 const proof=require('./artifact-assets.cjs')(page)
 await page.addInitScript(()=>{localStorage.setItem('sub2api_locale','zh');localStorage.setItem('admin_guide_1_admin_v4_interactive','true')})
 page.on('response',async r=>{if(r.url().includes('/admin/ops/dashboard/snapshot-v2')&&r.status()===200){try{const o=(await r.json()).data.overview;report.snapshots.push({request_count_sla:o.request_count_sla,success_count:o.success_count,error_count_sla:o.error_count_sla,upstream_error_count_excl_429_529:o.upstream_error_count_excl_429_529,sla:o.sla,error_rate:o.error_rate})}catch{}}})
 try{
  await page.goto(base+'/login');await page.getByLabel('邮箱').fill(env.ADMIN_EMAIL);await page.getByLabel('密码').fill(env.ADMIN_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard')
  await page.goto(base+'/admin/media');await expect(page.locator('[data-test="source-localhost"]')).toBeVisible()
  await page.goto(base+'/admin/ops');await expect(page.getByTestId('ops-sla-samples')).toBeVisible();await expect.poll(()=>report.snapshots.length).toBeGreaterThan(0)
  for(const width of [1440,390])for(const dark of [false,true]){
   await page.setViewportSize({width,height:960});await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark)
   await expect(page.getByTestId('ops-sla-samples')).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true)
   const name=`native-ops-${width}-${dark?'dark':'light'}.png`;await page.screenshot({path:root+'/evidence/'+name,fullPage:true,animations:'disabled'});report.screenshots.push(name)
  }
  for(const o of report.snapshots){assert.equal(o.request_count_sla,o.success_count+o.error_count_sla);if(o.request_count_sla>0)assert(Math.abs(o.error_rate-o.error_count_sla/o.request_count_sla)<1e-6)}
  report.assets=await proof();report.pass=true
 }catch(e){report.error=e.stack;await page.screenshot({path:root+'/evidence/native-ops-failure.png'}).catch(()=>{});throw e}
 finally{fs.writeFileSync(root+'/evidence/native-ops.json',JSON.stringify(report,null,2));await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
