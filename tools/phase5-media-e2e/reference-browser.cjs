const {chromium}=require('../../frontend/node_modules/@playwright/test');
const {execFileSync}=require('node:child_process');const fs=require('node:fs');
process.chdir(require('node:path').resolve(__dirname,'../..'));
const events=[];const base='http://127.0.0.1:3000';
(async()=>{const {env,emails}=await require('./local-identities.cjs')();const browser=await chromium.launch({channel:'chrome',headless:true});const ctx=await browser.newContext();const page=await ctx.newPage();
page.on('response',r=>{const url=new URL(r.url());if(url.pathname.startsWith('/studio/api/')||url.pathname==='/api/v1/auth/login'||url.pathname==='/api/v1/auth/studio-ticket')events.push({method:r.request().method(),path:url.pathname,status:r.status()})});
try{
await page.goto(base+'/login');await page.getByLabel('邮箱').fill(emails[0]);await page.getByLabel('密码').fill(env.ADMIN_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard');
await page.goto(base+'/video-studio');await page.getByTestId('studio-media-open').click();await page.getByTestId('studio-offer-select').locator('option').first().waitFor({state:'attached',timeout:15000});
await page.getByTestId('studio-offer-select').selectOption({label:'LOCAL TEST ONLY - reference protocol'});
const before=await (await fetch('http://127.0.0.1:19091')).json();let quoteBody;page.on('request',r=>{if(new URL(r.url()).pathname==='/studio/api/video/quotes')quoteBody=r.postDataJSON()});
await page.getByTestId('studio-prompt').fill('Synthetic local media test');
await page.getByTestId('studio-asset-input').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')});
await page.getByTestId('studio-status').filter({hasText:'素材已保存'}).waitFor();
for(const file of ['.evidence/synthetic.mp4','.evidence/synthetic.wav']){await page.getByTestId('studio-asset-input').setInputFiles(file);await page.waitForTimeout(800)}
if((await (await fetch('http://127.0.0.1:19091')).json()).init!==before.init)throw Error('preview uploaded');await page.getByTestId('studio-quote').click();await page.waitForTimeout(3500);
console.log('status',await page.getByTestId('studio-status').innerText());console.log('alerts',await page.getByRole('alert').allTextContents());
await page.getByTestId('studio-media-panel').screenshot({path:'.evidence/reference-initial.png'});

const alerts=await page.getByRole('alert').allTextContents();if(alerts.length)throw Error(alerts.join(';'));
const firstStatus=await page.getByTestId('studio-status').innerText();if(!firstStatus.includes('op_')||!quoteBody?.preparation_id)throw Error('no reference operation');
const originalQuote=structuredClone(quoteBody);const after=await (await fetch('http://127.0.0.1:19091')).json();if(after.init-before.init!==3)throw Error('expected 3 uploads');
await page.reload();await page.getByTestId('studio-media-open').click();await page.getByTestId('studio-quote').click();await page.waitForTimeout(800);if(await page.getByTestId('studio-status').innerText()!==firstStatus)throw Error('refresh identity');
require('./fixture-config.cjs').stopOwnedBff();
execFileSync(process.execPath,['tools/phase5-media-e2e/start-local.mjs','--synthetic-contract'],{cwd:process.cwd(),windowsHide:true,stdio:'pipe'});
await page.waitForTimeout(1500);
await page.getByTestId('studio-quote').click();await page.waitForTimeout(900);if(await page.getByTestId('studio-status').innerText()!==firstStatus)throw Error('restart identity');
const post=async(p,body)=>p.evaluate(async body=>{const r=await fetch('/studio/api/video/quotes',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Request':'video-binding-v1'},body:JSON.stringify(body)});return {status:r.status,value:await r.json()}},body);
execFileSync('docker',['--context','desktop-linux','restart','sub2api-dev'],{windowsHide:true,stdio:'pipe'});
for(let i=0;i<30;i++){try{if((await fetch('http://127.0.0.1:18080/health')).ok)break}catch{}await new Promise(r=>setTimeout(r,500))}
const restored=await post(page,{...originalQuote,client_key:'restart-'+require('crypto').randomUUID()});if(restored.status!==200||!restored.value.operation_id)throw Error('durable preparation quote '+restored.status);
const absent=await post(page,{...originalQuote,preparation_id:undefined,client_key:'missing-preparation'});if(absent.status!==422)throw Error('missing preparation accepted');
const reordered=await post(page,{...originalQuote,client_key:'reordered',assets:[...originalQuote.assets].reverse()});if(reordered.status!==422)throw Error('order accepted');
const other=await browser.newContext(),p2=await other.newPage();await p2.goto(base+'/login');await p2.getByLabel('邮箱').fill(emails[1]);await p2.getByLabel('密码').fill(env.ADMIN_PASSWORD);await p2.getByRole('button',{name:'登录',exact:true}).click();await p2.waitForURL('**/dashboard');await p2.goto(base+'/video-studio');await p2.getByTestId('studio-media-open').click();await p2.getByTestId('studio-offer-select').locator('option').first().waitFor({state:'attached'});
const forbidden=await post(p2,{...originalQuote,client_key:'other-user'});if(forbidden.status!==422)throw Error('owner isolation failed');await other.close();
const final=await (await fetch('http://127.0.0.1:19091')).json();if(final.init!==after.init)throw Error('extra supplier init');
await page.getByTestId('studio-media-panel').screenshot({path:'.evidence/reference-real.png'});
fs.writeFileSync('.evidence/reference-browser-summary.json',JSON.stringify({preparation_id:originalQuote.preparation_id,operation:firstStatus,restored_operation:restored.value.operation_id,core_process_restarted:true,ordered_kinds:originalQuote.assets.map(a=>a.kind),supplier_init_before:before.init,supplier_init_after_prepare:after.init,supplier_init_after_restart:final.init,missing_preparation_status:absent.status,other_user_status:forbidden.status,reordered_status:reordered.status,requests:events},null,2));console.log('REFERENCE REAL E2E PASS',JSON.stringify({init_delta:final.init-before.init,restart_extra_init:final.init-after.init,other_user_status:forbidden.status}));
}finally{console.log(JSON.stringify(events));await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1});
