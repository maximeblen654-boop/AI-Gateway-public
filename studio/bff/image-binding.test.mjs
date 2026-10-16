import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createImageTaskRuntime, createPublishedImageClient, IMAGE_BINDING_CONTRACT, IMAGE_PAID_ENABLED } from './image-binding.mjs';
import { createImageHandler } from './image-server.mjs';
import { createImageResultStore } from './image-result-store.mjs';
const { createStudioSessionBridge } = createRequire(import.meta.url)('./studio-session.js');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const owner={ownerId:1,sessionProof:'proof'};
test('browser restores a prepared image and confirms its stored identity without replaying inputs',async t=>{
  const f=fixture(t);await f.tasks.quote(owner,{offer_id:'published-offer',spec:{count:1,images:0}});
  const prepared=f.tasks.prepare(owner,f.input).task;
  const runtime=createImageTaskRuntime({rootDir:path.join(f.root,'journal'),call:f.call,results:f.results});
  const restored=await runtime.recover(owner,prepared.task_id);
  assert.equal(restored.status,'prepared');assert.equal(restored.sale_price.currency,'CNY');assert.equal(f.stats().gets,0);
  assert.equal((await runtime.dispatch(owner,{task_id:prepared.task_id})).status,'completed');
  await runtime.dispatch(owner,{task_id:prepared.task_id});assert.equal(f.stats().posts,1);
  await assert.rejects(runtime.dispatch({ownerId:2},{task_id:prepared.task_id}));
  assert.equal(JSON.stringify(runtime.history(owner)).includes('quote_token'),false);
});
function fixture(t,{lost=false,count=1,frozen=false,totalOverride,partial=false,legacyV2=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bound-image-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let posts=0,gets=0;
  const call=async(session,method,operation,payload,key=0)=>{
    assert.equal(session.ownerId,1);
    if(operation==='quotes') {
      const quote={contract:IMAGE_BINDING_CONTRACT,quote_token:'a'.repeat(64),spec:{count,images:0},sale_price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},expires_at:new Date(Date.now()+120000).toISOString()};
      if(frozen) Object.assign(quote,{unit_price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},total_price:{amount:totalOverride??(count===1?'0.80':(count*0.8).toFixed(2)),currency:'CNY',billing_mode:'per_request'},quantity:count});
      return {contract:IMAGE_BINDING_CONTRACT,key_ref:42,payload:quote};
    }
    assert.equal(key,42);
    if(method==='POST') {posts++;assert.ok(fs.readdirSync(path.join(root,'journal')).some(x=>x.endsWith('.sync-dispatch')));if(lost)throw new Error('lost response');return {payload:{}};}
    gets++;
    if(operation.endsWith('/result'))return {payload:{data:Array.from({length:partial?2:count},()=>({b64_json:png}))}};
    return {payload:{contract:IMAGE_BINDING_CONTRACT,task_id:operation.slice('tasks/'.length),status:partial?'partial':'completed',billing_state:'billed',receipt_version:legacyV2?'published_image_receipt_v2':'published_image_receipt_v3',result_available:true,settled_price:{amount:(partial?'1.60':(count*0.8).toFixed(2)),currency:'CNY',billing_mode:'per_request'},...(legacyV2?{}:{expected_count:count,delivered_count:partial?2:count,failed_count:partial?count-2:0,pending_count:0})}};
  };
  const results=createImageResultStore({rootDir:path.join(root,'results')});
  const tasks=createImageTaskRuntime({rootDir:path.join(root,'journal'),call,results});
  const input={quote_token:'a'.repeat(64),client_key:'client-key-01',prompt:'synthetic',references:[]};
  return {root,tasks,input,results,call,stats:()=>({posts,gets})};
}

test('partial upstream execution delivers and indexes only the frozen successful outputs',async t=>{
  const f=fixture(t,{count:5,frozen:true,partial:true});
  await f.tasks.quote(owner,{offer_id:'multi',spec:{count:5,images:0}});
  const task=await f.tasks.dispatch(owner,f.input);
  assert.equal(task.status,'partial');assert.equal(task.delivered_count,2);assert.equal(task.failed_count,3);assert.equal(task.results.length,2);
  assert.deepEqual(f.tasks.result(owner,task.task_id,1).data,Buffer.from(png,'base64'));
  assert.throws(()=>f.tasks.result(owner,task.task_id,2),/Image result unavailable/);
  assert.equal(f.stats().posts,1);
});
test('legacy v2 completed receipts use frozen-total semantics without invented counters',async t=>{
  const f=fixture(t,{legacyV2:true});await f.tasks.quote(owner,{offer_id:'legacy',spec:{count:1,images:0}});
  const task=await f.tasks.dispatch(owner,f.input);
  assert.equal(task.status,'completed');assert.equal(task.delivered_count,1);assert.equal(task.failed_count,0);assert.equal(task.pending_count,0);assert.equal(task.settled_price.amount,'0.80');
});
test('versioned receipt counters distinguish zero delivery from missing legacy fields',async t=>{
  const f=fixture(t,{count:5,frozen:true,lost:true});await f.tasks.quote(owner,{offer_id:'multi',spec:{count:5,images:0}});
  const id=f.tasks.prepare(owner,f.input).task.task_id;await assert.rejects(f.tasks.dispatch(owner,{task_id:id}));
  const receipt={contract:IMAGE_BINDING_CONTRACT,receipt_version:'published_image_receipt_v3',task_id:id,status:'failed',billing_state:'not_charged',failure_code:'upstream_http_502_no_delivery',http_failure:{message:'private supplier detail'},result_available:false,expected_count:5,delivered_count:0,failed_count:5,pending_count:0};
  const runtime=createImageTaskRuntime({rootDir:path.join(f.root,'journal'),results:f.results,call:async(_s,method)=>{assert.equal(method,'GET');return {payload:receipt}}});
  const zero=await runtime.recover(owner,id);assert.equal(zero.delivered_count,0);assert.equal(zero.results.length,0);assert.equal(zero.billing_state,'not_charged');assert.equal(zero.failure_code,'upstream_http_502_no_delivery');assert(!JSON.stringify(zero).includes('private supplier detail'));
  for(const change of [{status:'completed'},{status:'partial'},{delivered_count:undefined},{receipt_version:'published_image_receipt_v2'},{receipt_version:'invalid'}]) {
    const invalid=createImageTaskRuntime({rootDir:path.join(f.root,'journal'),results:f.results,call:async()=>({payload:{...receipt,...change}})});
    await assert.rejects(invalid.recover(owner,id),/Receipt/);
  }
  assert.equal(f.stats().posts,1);
});

test('expired prepared image refuses its first POST but an already claimed image remains recoverable',async t=>{
 const f=fixture(t);await f.tasks.quote(owner,{offer_id:'p',spec:{count:1,images:0}});const id=f.tasks.prepare(owner,f.input).task.task_id;
 const later=createImageTaskRuntime({rootDir:path.join(f.root,'journal'),call:f.call,results:f.results,now:()=>Date.now()+3600000});
 await assert.rejects(later.dispatch(owner,{task_id:id}),/image_quote_expired/);assert.equal(f.stats().posts,0);
 await f.tasks.dispatch(owner,{task_id:id});assert.equal((await later.dispatch(owner,{task_id:id})).status,'completed');assert.equal(f.stats().posts,1);
});
test('Published quote, durable journal/claim, full original result delivery',async t=>{
  const f=fixture(t);await f.tasks.quote(owner,{offer_id:'published-offer',spec:{count:1,images:0}});
  const task=await f.tasks.dispatch(owner,f.input);assert.equal(task.status,'completed');assert.equal(task.results.length,1);
  assert.deepEqual(f.tasks.result(owner,task.task_id,0).data,Buffer.from(png,'base64'));
  await f.tasks.dispatch(owner,f.input);assert.equal(f.stats().posts,1);
  await assert.rejects(f.tasks.dispatch(owner,{...f.input,prompt:'different'}),/binding conflict/);
  assert.throws(()=>f.tasks.result({ownerId:2},task.task_id,0));
  const history=f.tasks.history(owner);assert.equal(history.tasks.length,1);assert.equal(history.tasks[0].task_id,task.task_id);
  assert.equal(f.tasks.history({ownerId:2}).tasks.length,0);assert.ok(!JSON.stringify(history).includes('quote_token'));assert.ok(!JSON.stringify(history).includes('keyRef'));
});
test('saved completed results recover locally without another Core receipt or result read',async t=>{
  const f=fixture(t);await f.tasks.quote(owner,{offer_id:'published-offer',spec:{count:1,images:0}});
  const task=await f.tasks.dispatch(owner,f.input);const gets=f.stats().gets;
  const reopened=await f.tasks.recover(owner,task.task_id);
  assert.equal(reopened.status,'completed');assert.equal(reopened.resultCount ?? reopened.results?.length,1);assert.equal(f.stats().gets,gets);
});
test('claim/response loss uses frozen original key and GET only after restart',async t=>{
  const f=fixture(t,{lost:true});await f.tasks.quote(owner,{offer_id:'published-offer',spec:{count:1,images:0}});
  await assert.rejects(f.tasks.dispatch(owner,f.input),/lost response/);
  const task=f.tasks.prepare(owner,f.input).task;await f.tasks.recover(owner,task.task_id);await f.tasks.dispatch(owner,f.input);
  assert.equal(f.stats().posts,1);assert.ok(f.stats().gets>=2);
});
test('late pending recovery cannot overwrite completed originals',async t=>{
  const f=fixture(t,{lost:true});await f.tasks.quote(owner,{offer_id:'p',spec:{count:1,images:0}});
  const prepared=f.tasks.prepare(owner,f.input).task;
  await assert.rejects(f.tasks.dispatch(owner,f.input),/lost response/);
  let finish,started;const arrived=new Promise(r=>{started=r});
  const stale=createImageTaskRuntime({rootDir:path.join(f.root,'journal'),results:f.results,call:async()=>{started();await new Promise(r=>{finish=r});return {payload:{contract:IMAGE_BINDING_CONTRACT,task_id:prepared.task_id,status:'unknown',billing_state:'pending',result_available:false}};}});
  const pending=stale.recover(owner,prepared.task_id);await arrived;
  await f.tasks.recover(owner,prepared.task_id);finish();assert.equal((await pending).status,'completed');
  assert.deepEqual(f.tasks.result(owner,prepared.task_id,0).data,Buffer.from(png,'base64'));
});
test('expected count follows immutable quote rather than historical 1/4 assumptions',async t=>{
  const f=fixture(t,{count:2,frozen:true});await f.tasks.quote(owner,{offer_id:'two',spec:{count:2,images:0}});const task=await f.tasks.dispatch(owner,f.input);assert.equal(task.results.length,2);assert.equal(task.unit_price.amount,'0.80');assert.equal(task.total_price.amount,'1.60');assert.equal(task.quantity,2);
});
test('native multi output settles the frozen total once for one upstream POST',async t=>{
  const f=fixture(t,{count:2,frozen:true});await f.tasks.quote(owner,{offer_id:'native-multi',spec:{count:2,images:0}});
  const task=await f.tasks.dispatch(owner,f.input);
  assert.equal(task.status,'completed');assert.equal(task.results.length,2);assert.equal(task.delivered_count,2);
  assert.equal(task.settled_price.amount,'1.60');assert.equal(task.settled_price.currency,'CNY');assert.equal(f.stats().posts,1);
  await f.tasks.dispatch(owner,{task_id:task.task_id});assert.equal(f.stats().posts,1);
});
test('rejects an inconsistent frozen total while retaining legacy sale_price quotes',async t=>{
  const f=fixture(t,{count:2,frozen:true,totalOverride:'1.61'});
  await assert.rejects(f.tasks.quote(owner,{offer_id:'two',spec:{count:2,images:0}}),/Invalid Published quote response/);
  const legacy=fixture(t,{count:2});
  await legacy.tasks.quote(owner,{offer_id:'two',spec:{count:2,images:0}});
});
test('browser Account/key/price authority and reference mismatch rejected',async t=>{
  const f=fixture(t);await assert.rejects(f.tasks.quote(owner,{offer_id:'p',spec:{count:1},account_id:7}));
  await f.tasks.quote(owner,{offer_id:'p',spec:{count:1}});
  for(const input of [{...f.input,account_id:7},{...f.input,key_ref:42},{...f.input,sale_price:'0'},{...f.input,references:['https://reference.example/img.png']}])assert.throws(()=>f.tasks.prepare(owner,input));
});
test('result-store rejects damaged bytes and immutable content conflicts',t=>{
  const f=fixture(t),id='img_'+'a'.repeat(32);
  assert.throws(()=>f.results.saveBase64(1,id,0,Buffer.from('not image').toString('base64')));
  assert.throws(()=>f.results.saveBase64(1,id,0,Buffer.concat([Buffer.from(png,'base64'),Buffer.from([0])]).toString('base64')));
});
test('native JPEG/WebP results retain original bytes and format metadata',t=>{
  const f=fixture(t);
  for(const [format,codec,index] of [['jpeg','mjpeg',0],['webp','libwebp',1]]) {
    const bytes=execFileSync('ffmpeg',['-v','error','-f','image2pipe','-i','pipe:0','-frames:v','1','-c:v',codec,'-f','image2pipe','pipe:1'],{input:Buffer.from(png,'base64'),timeout:5000,maxBuffer:1024*1024,windowsHide:true});
    const id='img_'+'b'.repeat(32);
    f.results.saveBase64(1,id,index,bytes.toString('base64'),{mime_type:`image/${format}`,output_format:format});
    assert.deepEqual(f.results.read(1,id,index),bytes);
    assert.equal(f.results.metadata(1,id,index).mime_type,`image/${format}`);
    assert.throws(()=>f.results.saveBase64(1,id,index,Buffer.concat([bytes,Buffer.from([0])]).toString('base64')));
  }
});
test('complete JPEG container with invalid Huffman selectors cannot be stored',t=>{
  const f=fixture(t);
  const bytes=execFileSync('ffmpeg',['-v','error','-f','image2pipe','-i','pipe:0','-frames:v','1','-c:v','mjpeg','-f','image2pipe','pipe:1'],{input:Buffer.from(png,'base64'),timeout:5000,maxBuffer:1024*1024,windowsHide:true});
  const scan=bytes.indexOf(Buffer.from([0xff,0xda]));assert.ok(scan>=2);
  const invalid=Buffer.from(bytes);invalid[scan+6]=0xff;
  assert.deepEqual(invalid.subarray(-2),Buffer.from([0xff,0xd9]));
  assert.throws(()=>f.results.saveBase64(1,'img_'+'c'.repeat(32),0,invalid.toString('base64')));
  assert.throws(()=>f.results.saveBase64(1,'img_'+'d'.repeat(32),0,bytes.subarray(0,-2).toString('base64')));
});
test('session/CSRF and HTTP paid gate remain hard off with environment flags',async t=>{
  const f=fixture(t);const sessions={authenticate:async()=>owner,sameOrigin:()=>true,clear:()=>''};
  const server=http.createServer(createImageHandler({sessions,tasks:f.tasks}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  process.env.STUDIO_IMAGE_PUBLISHED_SUBMISSION='true';t.after(()=>delete process.env.STUDIO_IMAGE_PUBLISHED_SUBMISSION);
  const base=`http://127.0.0.1:${server.address().port}`;
  const reply=await fetch(base+'/studio-v2/api/image/tasks',{method:'POST',headers:{'X-Studio-Request':'image-binding-v1'},body:JSON.stringify(f.input)});
  assert.equal(reply.status,503);assert.equal(f.stats().posts,0);assert.equal(IMAGE_PAID_ENABLED,false);
  assert.equal((await fetch(base+'/studio-v2/api/image/quotes',{method:'POST',body:'{}'})).status,403);
});
test('explicit server permission dispatches an owner-resolved prepared request once',async t=>{
  const f=fixture(t);await f.tasks.quote(owner,{offer_id:'published-offer',spec:{count:1,images:0}});
  let currentOwner=owner;
  const sessions={authenticate:async()=>currentOwner,sameOrigin:()=>true};
  const server=http.createServer(createImageHandler({sessions,tasks:f.tasks,paidEnabled:true}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const input={...f.input,asset_refs:[]};delete input.references;
  const post=body=>fetch(base+'/studio-v2/api/image/tasks',{method:'POST',headers:{'X-Studio-Request':'image-binding-v1'},body:JSON.stringify(body)});
  // An empty ordered private-asset list requires no resolver; browser URLs are forbidden.
  const first=await post(input);assert.equal(first.status,200);const task=await first.json();assert.equal(task.status,'completed');
  assert.equal((await post(input)).status,200);assert.equal(f.stats().posts,1);
  assert.equal((await post({...input,references:[]})).status,409);assert.equal(f.stats().posts,1);
  const resultPath=`/studio-v2/api/image/tasks/${task.task_id}/results/0`;
  assert.equal(task.results[0].url,resultPath);
  const stored=f.results.metadata(1,task.task_id,0);
  const download=await fetch(base+resultPath);assert.equal(download.status,200);assert.equal(download.headers.get('cache-control'),'private, max-age=60, must-revalidate');assert.equal(download.headers.get('etag'),stored.etag);
  const cached=await fetch(base+resultPath,{headers:{'If-None-Match':stored.etag}});assert.equal(cached.status,304);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from(png,'base64'));
  assert.equal((await fetch(base+resultPath.replace('/studio-v2/','/studio/'))).status,404);
  currentOwner={ownerId:2};assert.equal((await fetch(base+resultPath)).status,409);
  const restarted=createImageTaskRuntime({rootDir:path.join(f.root,'journal'),call:f.call,results:f.results});
  assert.equal((await restarted.recover(owner,task.task_id)).results[0].url,resultPath);
  assert.deepEqual(f.results.metadata(1,task.task_id,0),stored,'new URL projection does not rewrite old metadata/hash');
  assert.equal(f.stats().posts,1);
});
test('session exchange keeps proof server-side and rejects cross-origin/revoked identity',async()=>{
  const proof='p'.repeat(43);let revoked=false;
  const sessions=createStudioSessionBridge({core:{consume:async()=>({user_id:1,session_proof:proof}),verify:async()=>revoked?null:{user_id:1}},publicOrigin:'http://localhost'});
  const req={headers:{origin:'http://localhost',host:'localhost','x-studio-request':'session-exchange-v1'}};
  const exchanged=await sessions.exchange(req,'t'.repeat(43));assert.equal(exchanged.ownerId,1);assert.ok(!JSON.stringify(exchanged).includes(proof));
  const cookie=exchanged.cookie.split(';')[0];assert.equal((await sessions.authenticate({headers:{cookie}})).sessionProof,proof);
  revoked=true;assert.equal(await sessions.authenticate({headers:{cookie}}),null);
  assert.equal(await sessions.exchange({...req,headers:{...req.headers,origin:'http://evil.example'}},'t'.repeat(43)),null);
});
test('BFF/Bridge contract transport pins key/version and rejects version drift',async()=>{
  let observed;
  const call=createPublishedImageClient({baseUrl:'http://127.0.0.1',serviceToken:'s'.repeat(32),fetchImpl:async(url,opts)=>{observed={url,opts};return new Response(JSON.stringify({code:0,data:{contract:IMAGE_BINDING_CONTRACT,key_ref:42,payload:{}}}));}});
  await call(owner,'GET','tasks/original',undefined,42);
  assert.equal(observed.opts.method,'GET');assert.equal(observed.opts.headers['X-Studio-Key-Ref'],'42');assert.equal(observed.opts.body,undefined);assert.equal(observed.opts.redirect,'error');
  const bad=createPublishedImageClient({baseUrl:'http://127.0.0.1',serviceToken:'s'.repeat(32),fetchImpl:async()=>new Response(JSON.stringify({code:0,data:{contract:'old',key_ref:42}}))});
  await assert.rejects(bad(owner,'GET','catalog'),/contract mismatch/);
});

for(const stage of ['account_admission','https://secret.invalid/token']) test('quote diagnostics remain bounded and safe: '+stage, async()=>{
 const call=createPublishedImageClient({baseUrl:'http://127.0.0.1:1',serviceToken:'x'.repeat(32),fetchImpl:async()=>new Response(JSON.stringify({diagnostic_stage:stage,message:'secret-key-and-internal-route'}),{status:409})});
 await assert.rejects(call(owner,'POST','quotes',{}),e=>{assert.equal(e.stage,stage==='account_admission'?stage:undefined);assert(!JSON.stringify(e).includes('secret'));assert(!e.message.includes('internal-route'));return true;});
});


test('authorized historical finality keeps BFF identity and dispatch claim, no POST on query/retry',async t=>{
 const f=fixture(t,{lost:true});await f.tasks.quote(owner,{offer_id:'published-offer',spec:{count:1,images:0}});
 const task=f.tasks.prepare(owner,f.input).task;
 await assert.rejects(f.tasks.dispatch(owner,{task_id:task.task_id}));
 const dir=path.join(f.root,'journal');
 const filename=fs.readdirSync(dir).find(n=>/^task-.*\.json$/.test(n));
 const file=path.join(dir,filename),before=JSON.parse(fs.readFileSync(file,'utf8'));
 const claim=fs.readFileSync(file+'.sync-dispatch');
 const receipt={version:'published_image_receipt_v3',task_id:task.task_id,status:'unknown',billing_state:'pending',expected_count:1,pending_count:1,
  quote:{owner:{user_id:1,api_key_id:42},binding:{spec:before.quote.spec}},
  units:[{id:'fixture-unit',payload_hash:'fixture-hash',index:0,output_offset:0,output_count:1,status:'pending'}]};
 const outcome={id:'fixture-unit',payload_hash:'fixture-hash',state:'unknown',upstream_id:''};
 const py=process.platform==='win32'?'python':'python3';
 const changed=JSON.parse(execFileSync(py,['-B','tools/maintenance/historical_image_502.py'],{input:JSON.stringify({receipt,outcome,journal:before}),cwd:path.resolve(import.meta.dirname,'../..'),encoding:'utf8'}));
 fs.writeFileSync(file,JSON.stringify(changed.journal));
 let gets=0;
 const runtime=createImageTaskRuntime({rootDir:dir,results:f.results,call:async(_s,method)=>{
  assert.equal(method,'GET');gets++;
  return {payload:{...changed.receipt,contract:IMAGE_BINDING_CONTRACT,receipt_version:'published_image_receipt_v3',failure_code:'upstream_http_502_no_delivery',result_available:false}};
 }});
 for(let i=0;i<3;i++) {const v=await runtime.recover(owner,task.task_id);assert.equal(v.status,'failed');assert.equal(v.billing_state,'not_charged');assert.equal(v.failed_count,1);}
 const v=await runtime.dispatch(owner,{task_id:task.task_id});assert.equal(v.billing_state,'not_charged');assert.equal(gets,4);
 assert.equal(runtime.history(owner).tasks[0].failure_code,'upstream_http_502_no_delivery');
 assert.deepEqual(fs.readFileSync(file+'.sync-dispatch'),claim);
 const after=JSON.parse(fs.readFileSync(file));for(const k of ['owner','keyRef','task_id','request','requestHash','quote'])assert.deepEqual(after[k],before[k]);
 await assert.rejects(runtime.recover({ownerId:2},task.task_id));assert.equal(f.stats().posts,1);
});

test('expired finalized history is removed only after authoritative receipt confirmation',async t=>{
 const f=fixture(t);await f.tasks.quote(owner,{offer_id:'old',spec:{count:1,images:0}});
 const prepared=f.tasks.prepare(owner,f.input).task;
 const journal=path.join(f.root,'journal');
 const taskFile=fs.readdirSync(journal).find(name=>/^task-.*\.json$/.test(name));
 const file=path.join(journal,taskFile);const task=JSON.parse(fs.readFileSync(file,'utf8'));
 task.created_at=new Date(Date.now()-73*3600000).toISOString();task.status='failed';task.billing_state='not_charged';task.failure_code='upstream_http_502_no_delivery';
 fs.writeFileSync(file,JSON.stringify(task));
 const runtime=createImageTaskRuntime({rootDir:journal,results:f.results,call:async(_s,method,operation)=>{
  if(method==='GET'&&operation.startsWith('tasks/'))return {payload:{contract:IMAGE_BINDING_CONTRACT,task_id:prepared.task_id,status:'failed',billing_state:'not_charged'}};
  return f.call(_s,method,operation);
 }});
 const summary=await runtime.cleanupExpired(owner,{before:Date.now()-72*3600000});
 assert.deepEqual(summary,{scanned:1,deleted:1,skipped:0,failed:0,bytes:0});
 assert.equal(f.tasks.history(owner).tasks.length,0);
 assert.equal(fs.readdirSync(journal).some(name=>name.endsWith('.sync-dispatch')),false);
 assert.equal(fs.readdirSync(journal).some(name=>/^quote-.*\.json$/.test(name)),true);
});

test('old unresolved history remains visible and is never cleaned',async t=>{
 const f=fixture(t);await f.tasks.quote(owner,{offer_id:'old',spec:{count:1,images:0}});
 const task=f.tasks.prepare(owner,f.input).task,journal=path.join(f.root,'journal');
 const file=path.join(journal,fs.readdirSync(journal).find(name=>/^task-.*\.json$/.test(name)));
 const value=JSON.parse(fs.readFileSync(file,'utf8'));value.created_at=new Date(Date.now()-73*3600000).toISOString();value.status='unknown';value.billing_state='billing_unknown';fs.writeFileSync(file,JSON.stringify(value));
 const summary=await f.tasks.cleanupExpired(owner,{before:Date.now()-72*3600000});
 assert.deepEqual(summary,{scanned:1,deleted:0,skipped:1,failed:0,bytes:0});
 assert.equal(f.tasks.history(owner).tasks[0].task_id,task.task_id);
});

test('history request automatically starts one bounded owner cleanup loop',async t=>{
 let cleanups=0,authentications=0;const sessions={authenticate:async()=>{authentications++;return {...owner,sessionProof:`proof-${authentications}`}},sameOrigin:()=>true};
 const tasks={history:()=>({contract:IMAGE_BINDING_CONTRACT,tasks:[]}),cleanupExpired:async()=>{cleanups++;return {deleted:0,failed:0,bytes:0}}};
 const server=http.createServer(createImageHandler({sessions,tasks}));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const base=`http://127.0.0.1:${server.address().port}`;
 const get=()=>fetch(base+'/studio-v2/api/image/tasks');
 assert.equal((await get()).status,200);assert.equal((await get()).status,200);assert.equal(cleanups,2);assert.equal(authentications,2);
});

test('mixed owners and ages are covered fairly across bounded cleanup rounds',async t=>{
 const f=fixture(t);await f.tasks.quote(owner,{offer_id:'batch',spec:{count:1,images:0}});
 const journal=path.join(f.root,'journal'),prepared=[];
 for(let i=0;i<100;i++)prepared.push(f.tasks.prepare(owner,{...f.input,client_key:`client-${i.toString().padStart(3,'0')}`,prompt:`prompt-${i}`}).task);
 const receipts=new Map();
 for(let i=0;i<100;i++){
  // Resolve by task identity rather than relying on random journal filenames.
  const task=prepared[i];
  const taskPath=path.join(journal,fs.readdirSync(journal).find(name=>/^task-.*\.json$/.test(name)&&JSON.parse(fs.readFileSync(path.join(journal,name),'utf8')).task_id===task.task_id));
  const value=JSON.parse(fs.readFileSync(taskPath,'utf8'));const old=i<80;
  value.created_at=new Date(Date.now()-(old?73:1)*3600000).toISOString();
  if(i<40){value.status='failed';value.billing_state='not_charged';receipts.set(task.task_id,{status:'failed',billing_state:'not_charged'});}
  else if(i<60){value.status='unknown';value.billing_state='billing_unknown';receipts.set(task.task_id,{status:'unknown',billing_state:'billing_unknown'});}
  else if(i<80){value.status='completed';value.billing_state='billed';receipts.set(task.task_id,{status:'completed',billing_state:'billed'});}
  else {value.status='failed';value.billing_state='not_charged';receipts.set(task.task_id,{status:'failed',billing_state:'not_charged'});}
  fs.writeFileSync(taskPath,JSON.stringify(value));
 }
 const runtime=createImageTaskRuntime({
  rootDir:journal,
  results:f.results,
  call:async(_s,method,operation)=>({payload:{contract:IMAGE_BINDING_CONTRACT,task_id:operation.slice('tasks/'.length),...(receipts.get(operation.slice('tasks/'.length))||{status:'unknown',billing_state:'billing_unknown'})}})
 });
 let deleted=0,rounds=0;
 while(rounds++<30&&deleted<60){const stats=await runtime.cleanupExpired(owner,{before:Date.now()-72*3600000,batchSize:10});assert(stats.scanned<=10);deleted+=stats.deleted;if(!stats.deleted&&stats.skipped===0)break;}
 assert.equal(deleted,60);assert(rounds>1);
 assert.equal(runtime.history(owner).tasks.length,40);
});
