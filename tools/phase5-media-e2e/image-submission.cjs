// Optional real local Core/Bridge/BFF acceptance. Only the supplier is simulated.
// Reuses the explicitly provisioned phase5 fixture; never provisions production.
// The private output includes opaque quote state for restart recovery: do not commit it.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {createHash, randomUUID} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const base = 'http://127.0.0.1:18083';
const bridge = 'http://127.0.0.1:18082';
const core = 'http://127.0.0.1:18080';
const output = process.env.PHASE5_READINESS_EVIDENCE;
const docker = (...args) => execFileSync('docker', ['--context', 'desktop-linux', ...args], {encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','pipe']});
const stats = () => JSON.parse(docker('exec','phase5-sim-core','node','-e', "fetch('http://127.0.0.1:19091').then(r=>r.json()).then(x=>console.log(JSON.stringify({init:x.init,posts:x.image_posts,requests:x.image_requests})))"));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const hash = b => createHash('sha256').update(b).digest('hex');

async function main() {
  assert(output && path.isAbsolute(output), 'Explicit private evidence file required');
  const {env,emails} = await require('./local-identities.cjs')();
  const http=[];
  async function session(email) {
    const login=await fetch(core+'/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:env.ADMIN_PASSWORD})});
    assert.equal(login.status,200,'real login');const auth=(await login.json()).data.access_token;
    const ticket=await fetch(bridge+'/api/v1/auth/studio-ticket',{method:'POST',headers:{Authorization:'Bearer '+auth}});
    assert.equal(ticket.status,200,'real ticket');const issued=(await ticket.json()).data;
    const exchange=await fetch(base+'/studio/api/session/exchange',{method:'POST',headers:{Origin:base,'Content-Type':'application/json','X-Studio-Request':'session-exchange-v1'},body:JSON.stringify({ticket:issued.ticket})});
    assert.equal(exchange.status,200,'real session');const cookie=exchange.headers.get('set-cookie').split(';')[0];
    const request=async (route,body,options={})=>{
      const {headers,...rest}=options;
      const response=await fetch(base+'/studio/api/'+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-Studio-Request':'image-binding-v1',...headers},...(body===undefined?{}:{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}),...rest});
      http.push({path:route,status:response.status});return response;
    };
    return {request,auth};
  }
  let owner=await session(emails[0]),other=await session(emails[1]);
  const json=async(r,status=200)=>{assert.equal(r.status,status,'HTTP '+http.at(-1)?.path);return r.json()};
  const readiness=await json(await owner.request('image/readiness'));assert.equal(readiness.paid_enabled,true);
  if(process.argv.includes('--recover')) {
    const old=JSON.parse(fs.readFileSync(output,'utf8')),before=stats();
    assert(old.final,'Incomplete submission evidence cannot pass restart acceptance');
    assert.deepEqual(old.tasks.map(t=>t.mode),['success','reference','reject','lost','delay']);
    assert.deepEqual(old.tasks.map(t=>t.status),['completed','completed','unknown','unknown','completed']);
    for(const task of old.tasks) {
      const restored=await json(await owner.request('image/tasks/'+task.id));assert.equal(restored.status,task.status);
      assert.equal((await other.request('image/tasks/'+task.id)).status,409);
      if(task.status==='completed') {const r=await owner.request('image/tasks/'+task.id+'/results/0');assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(png));}
      const retry=await json(await owner.request('image/tasks',task.input));assert.equal(retry.task_id,task.id);
    }
    assert.deepEqual(stats(),before,'restart/retry must not call supplier');
    old.restart={at:new Date().toISOString(),supplier_posts:before.posts,upload_init:before.init,http};
    fs.writeFileSync(output,JSON.stringify(old,null,2));console.log(JSON.stringify({restart:'PASS',tasks:old.tasks.length,supplier_posts:before.posts,upload_init:before.init}));return;
  }
  assert(!fs.existsSync(output),'Do not overwrite original acceptance');
  const start=stats(),catalog=await json(await owner.request('image/catalog'));
  const offer=catalog.offers.find(o=>o.model==='phase5-native-image-v1');assert(offer,'Normal Published test image offer required');
  const spec={resolution:offer.spec.resolution[0],aspect_ratio:offer.spec.aspect_ratio?.[0]||'',quality:offer.spec.quality?.[0]||'',duration_seconds:0,count:1,images:0,videos:0,audio:0};
  const tasks=[];
  const report={at:new Date().toISOString(),model:offer.model,revision:offer.published_revision,start,tasks,http};
  fs.writeFileSync(output,JSON.stringify(report,null,2),{flag:'wx'});
  const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
  for(const mode of ['success','reference','reject','lost','delay']) {
    const refs=[];
    if(mode==='reference'){
      const upload=await json(await owner.request('assets/uploads',png,{headers:{'Content-Type':'image/png','X-Studio-Request':'asset-intake-v1','X-Studio-Asset-Kind':'image','X-Content-Sha256':hash(png)}}),201);
      refs.push(upload.asset_ref);
    }
    const q=await json(await owner.request('image/quotes',{offer_id:offer.offer_id,spec:{...spec,images:refs.length}}));
    const input={quote_token:q.quote_token,client_key:'readiness-'+randomUUID(),prompt:`READINESS_${mode.toUpperCase()} synthetic`,asset_refs:refs};
    const prepared=await json(await owner.request('image/prepare',input));const before=stats();
    if(refs.length)assert.equal((await other.request('image/prepare',input)).status,409);
    assert.equal(before.posts,start.posts+tasks.length,'quote/prepare must not submit');
    const record={mode,id:prepared.task_id,status:'prepared',input,price:q.sale_price,spec:q.spec};
    tasks.push(record);save();
    if(mode==='delay'){
      await assert.rejects(owner.request('image/tasks',input,{signal:AbortSignal.timeout(150)}));
      await new Promise(resolve=>setTimeout(resolve,2500));
    }else{
      const replies=await Promise.all([owner.request('image/tasks',input),owner.request('image/tasks',input)]);
      // An overlapping GET may race the first Core claim and return conflict;
      // it must not cause the browser or BFF to create another intent/POST.
      for(const reply of replies)assert([200,409].includes(reply.status));
    }
    const result=await json(await owner.request('image/tasks/'+prepared.task_id));
    const expected=['reject','lost'].includes(mode)?'unknown':'completed';assert.equal(result.status,expected);
    if(expected==='completed'){const r=await owner.request('image/tasks/'+prepared.task_id+'/results/0');assert.equal(r.status,200);assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(png));}
    assert.equal((await other.request('image/tasks/'+prepared.task_id)).status,409);
    await json(await owner.request('image/tasks',input));
    assert.equal(stats().posts,before.posts+1,'one supplier POST per intent');
    record.status=expected;save();
  }
  const final=stats();assert.equal(final.init,start.init,'images must not start supplier reference uploads');
  report.final=final;save();
  console.log(JSON.stringify({submission:'PASS',modes:tasks.map(t=>({mode:t.mode,status:t.status})),supplier_posts:final.posts-start.posts,upload_init_delta:final.init-start.init}));
}
main().catch(error=>{console.error(error.message.replace(/[\r\n]+/g,' ').slice(0,250));process.exitCode=1});
