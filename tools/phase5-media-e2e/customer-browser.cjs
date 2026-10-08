// Real customer Vue + auth + BFF/Bridge/Core. Only the supplier is simulated.
// Credentials are read in memory from the existing, explicitly bound local fixture.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {createHash, randomUUID} = require('node:crypto');
const {chromium, expect} = require(process.env.PHASE5_PLAYWRIGHT_MODULE || '../../frontend/node_modules/@playwright/test');
const base = 'http://127.0.0.1:3000';
const output = process.env.PHASE5_CUSTOMER_EVIDENCE;
const docker = (...args) => execFileSync('docker',['--context','desktop-linux',...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stats = () => JSON.parse(docker('exec','phase5-sim-core','node','-e',"fetch('http://127.0.0.1:19091').then(r=>r.json()).then(s=>console.log(JSON.stringify({init:s.init,image_posts:s.image_posts,video_posts:s.video_posts})))"));
const png = {name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')};

async function main() {
  assert(output && path.isAbsolute(output),'Explicit private evidence output required');
  const {env,emails,fixture} = await require('./local-identities.cjs')({mockSubmission:true});
  const recover = process.argv.includes('--recover');
  const scenario = process.argv.find(a=>a.startsWith('--scenario='))?.slice(11);
  assert(recover || ['image-text','image-reference','image-response-loss','image-unknown','video-inline','video-references','video-unknown','video-failure'].includes(scenario),'Choose one scenario or --recover');
  const report = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output)) : {at:new Date().toISOString(),core:fixture.expected_core_image,cases:[],http:[]};
  assert.equal(report.core,fixture.expected_core_image,'Evidence belongs to a different build');
  if(!recover)assert(!report.cases.some(c=>c.name===scenario),'Use recovery for an existing intent, not another submission');
  const save = () => fs.writeFileSync(output,JSON.stringify(report,null,2));
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const contexts=[];
  async function login(email) {
    const context=await browser.newContext();contexts.push(context);
    const page=await context.newPage();page.setDefaultTimeout(30000);
    page.on('response',r=>{const u=new URL(r.url());if(u.origin===base && (u.pathname.startsWith('/studio/api/') || /\/auth\/(login|studio-ticket)$/.test(u.pathname)))report.http.push({method:r.request().method(),path:u.pathname,status:r.status()})});
    // Optional product tours only. No identity injection or API success mocks.
    await page.addInitScript(()=>{for(const k of ['admin_guide_1_admin_v4_interactive','user_guide_2_user_v4_interactive','user_guide_3_user_v4_interactive'])localStorage.setItem(k,'true')});
    await page.goto(base+'/login');await page.getByLabel('邮箱').fill(email);await page.getByLabel('密码').fill(env.ADMIN_PASSWORD);
    await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard');
    await page.goto(base+'/video-studio');await expect(page.getByTestId('studio-kind')).toBeEnabled();
    return page;
  }
  const api = (page,kind,route,body) => page.evaluate(async({kind,route,body})=>{
    const r=await fetch(`/studio/api/${kind}/${route}`,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Studio-Request':`${kind}-binding-v1`},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json().catch(()=>null)};
  },{kind,route,body});
  const taskPath = c => (c.kind==='image'?'tasks/':'operations/')+c.id;
  async function selectTask(page,c) {
    await page.getByTestId('studio-kind').selectOption(c.kind);
    const button=page.locator(`[data-task-id="${c.id}"]`);await expect(button).toBeVisible();await button.click();
    await expect(page.getByTestId('studio-task-id')).toContainText(c.id);
  }
  async function result(page,c) {
    await expect(page.getByTestId('studio-status')).toContainText('生成完成',{timeout:60000});
    if(c.kind==='image')await expect.poll(()=>page.getByTestId('studio-result-image').evaluate(el=>el.complete&&el.naturalWidth>0)).toBe(true);
    else await expect.poll(()=>page.getByTestId('studio-result-video').evaluate(el=>el.readyState>=1&&el.videoWidth>0)).toBe(true);
    const download=page.waitForEvent('download');await page.getByTestId('studio-download').first().click();const file=await download;
    assert.equal(await file.failure(),null);const bytes=fs.readFileSync(await file.path());assert(bytes.length>0);
    const value=hash(bytes);if(c.result_hash)assert.equal(value,c.result_hash);else c.result_hash=value;
    c.result_bytes=bytes.length;
  }
  try {
    const page=await login(emails[0]);
    if(recover) {
      const before=stats();
      for(const c of report.cases){assert(c.id,'Unprepared scenario requires investigation');await selectTask(page,c);
        if(c.expected==='completed')await result(page,c);else await expect(page.getByTestId('studio-status')).toContainText(c.expected==='unknown'?'结果待确认':'费用已释放');
        const dto=await api(page,c.kind,taskPath(c));assert.equal(dto.status,200);
      }
      assert.deepEqual(stats(),before,'relogin and recovery must not submit or upload');
      report.recovery={at:new Date().toISOString(),counts:before,cases:report.cases.length};save();console.log(JSON.stringify({recovery:'PASS',cases:report.cases.length,counts:before}));return;
    }
    const kind=scenario.startsWith('image')?'image':'video';
    await page.getByTestId('studio-kind').selectOption(kind);await expect(page.getByTestId('studio-kind')).toBeEnabled();
    if(await page.getByTestId('studio-new').count())await page.getByTestId('studio-new').click();
    // Unknown history cannot be replaced automatically. Explicitly select a finished
    // entry first, then choose New; pending tasks remain available in server history.
    if(await page.getByTestId('studio-task').count()) {
      const list=(await api(page,kind,kind==='image'?'tasks':'operations')).body;
      const items=kind==='image'?list.tasks:list;
      const finished=items.find(x=>['completed','captured','released','intent','prepared'].includes(x.status));
      assert(finished,'A prior unresolved task remains; inspect it before creating a new intent');
      await page.locator(`[data-task-id="${finished.task_id||finished.operation_id}"]`).click();await page.getByTestId('studio-new').click();
    }
    const model=kind==='image'?'phase5-native-image-v1':scenario==='video-inline'?'3.0':'phase5-native-video-v1';
    const catalog=await api(page,kind,'catalog');assert.equal(catalog.status,200);const offer=catalog.body.offers.find(o=>o.model===model);assert(offer,'Normally Published test offer is required');
    await page.getByTestId('studio-offer-select').selectOption(offer.offer_id);
    const before=stats(),refs=[];
    const upload=async file=>{const response=page.waitForResponse(r=>r.url().endsWith('/studio/api/assets/uploads')&&r.request().method()==='POST');await page.getByTestId('studio-asset-input').setInputFiles(file);const r=await response;assert.equal(r.status(),201);refs.push(await r.json());await expect(page.getByTestId('studio-kind')).toBeEnabled()};
    if(scenario==='image-reference'||scenario==='video-inline'||scenario==='video-references')await upload(png);
    if(scenario==='video-references'){
      await upload({name:'synthetic.mp4',mimeType:'video/mp4',buffer:docker('exec','phase5-sim-core','cat','/fixture/synthetic-original.mp4')});
      await upload({name:'synthetic.wav',mimeType:'audio/wav',buffer:docker('exec','phase5-sim-core','ffmpeg','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=8000','-t','1','-f','wav','pipe:1')});
    }
    const mode=scenario.endsWith('unknown')?'LOST':scenario==='video-failure'?'REJECT':scenario==='image-response-loss'?'DELAY':'SUCCESS';
    await page.getByTestId('studio-prompt').fill(`READINESS_${mode} browser ${randomUUID()}`);
    const c={name:scenario,kind,model,before,expected:mode==='LOST'?'unknown':mode==='REJECT'?'released':'completed',refs:refs.map(a=>({kind:a.kind,asset_ref:a.asset_ref})),published_revision:offer.published_revision};
    report.cases.push(c);save();
    const prepared=page.waitForResponse(r=>r.url().endsWith(`/studio/api/${kind}/${kind==='image'?'prepare':'quotes'}`)&&r.request().method()==='POST');
    await page.getByTestId('studio-quote').click();const response=await prepared;assert.equal(response.status(),200);const view=await response.json();c.id=view.task_id||view.operation_id;c.price=view.sale_price;c.spec=view.spec;
    if(kind==='video')c.quote_request=response.request().postDataJSON();save();
    if(scenario==='video-references'){
      const negativeBefore=stats(),noPreparation={...c.quote_request,client_key:randomUUID()};delete noPreparation.preparation_id;
      const reordered={...c.quote_request,client_key:randomUUID(),assets:[...c.quote_request.assets].reverse()};
      const changed={...c.quote_request,client_key:randomUUID(),ratio:'invalid'};
      c.negatives=[];
      for(const [name,input]of [['missing-preparation',noPreparation],['reordered-assets',reordered],['changed-spec',changed]]){const r=await api(page,'video','quotes',input);assert([409,422].includes(r.status));c.negatives.push({name,status:r.status})}
      assert.deepEqual(stats(),negativeBefore,'Invalid quotation must never submit or upload');save();
    }
    await expect(page.getByTestId('studio-price')).toContainText(view.sale_price.amount+' '+view.sale_price.currency);
    assert.equal(stats()[kind+'_posts'],before[kind+'_posts'],'quote/prepare must not generate');
    // Reload a quote and confirm the stored server identity, without original inputs.
    await page.reload();await expect(page.getByTestId('studio-task-id')).toContainText(c.id);await expect(page.getByTestId('studio-generate')).toBeEnabled();
    if(scenario==='image-response-loss')await page.route('**/studio/api/image/tasks',async route=>{if(route.request().method()!=='POST')return route.continue();await route.fetch();await route.abort('connectionreset');},{times:1});
    await page.getByTestId('studio-generate').evaluate(button=>{button.click();button.click()});
    if(c.expected==='completed')await result(page,c);
    else {await expect(page.getByTestId('studio-status')).toContainText(c.expected==='unknown'?'结果待确认':'费用已释放',{timeout:60000});await expect(page.getByTestId('studio-generate')).toHaveCount(0)}
    await page.reload();await expect(page.getByTestId('studio-task-id')).toContainText(c.id);
    if(c.expected==='completed')await result(page,c);else await expect(page.getByTestId('studio-status')).toContainText(c.expected==='unknown'?'结果待确认':'费用已释放');
    const other=await login(emails[1]);await other.getByTestId('studio-kind').selectOption(kind);await expect(other.getByTestId('studio-kind')).toBeEnabled();
    assert([403,404,409].includes((await api(other,kind,taskPath(c))).status),'Cross-user task must fail closed');
    const originalRoute=taskPath(c)+(kind==='image'?'/results/0':'/original');assert([403,404,409].includes((await api(other,kind,originalRoute)).status),'Cross-user result must fail closed');
    if(refs.length){
      if(kind==='video')assert([409,422].includes((await api(other,kind,'quotes',{client_key:randomUUID(),offer_id:offer.offer_id,model,prompt:'synthetic isolation',duration:5,resolution:c.spec.resolution,ratio:c.spec.aspect_ratio,assets:c.refs})).status));
      else {const q=await api(other,kind,'quotes',{offer_id:offer.offer_id,spec:c.spec});assert.equal(q.status,200);assert.equal((await api(other,kind,'prepare',{quote_token:q.body.quote_token,client_key:randomUUID(),prompt:'synthetic isolation',asset_refs:refs.map(a=>a.asset_ref)})).status,409)}
    }
    c.after=stats();assert.equal(c.after[kind+'_posts']-before[kind+'_posts'],1,'Exactly one supplier submit for this scenario');
    c.pass=true;save();await page.getByTestId('studio-media-panel').screenshot({path:path.join(path.dirname(output),scenario+'.png')});
    console.log(JSON.stringify({scenario,status:'PASS',id:c.id,result_bytes:c.result_bytes||0,submit_delta:1,upload_init_delta:c.after.init-before.init}));
  } finally {save();for(const c of contexts)await c.close();await browser.close()}
}
main().catch(error=>{console.error('Customer browser acceptance failed: '+String(error.message).replace(/[\r\n]+/g,' ').slice(0,400));process.exitCode=1});
