import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createImageResultStore } from './image-result-store.mjs';
import { createImageTaskRuntime, createPublishedImageClient, IMAGE_BINDING_CONTRACT } from './image-binding.mjs';
import { createImageHandler, startResultCleanup } from './image-server.mjs';
import { createVideoResultStore } from './video-result-store.mjs';
import { createVideoDelivery } from './video-delivery.mjs';

const BASE=Date.parse('2026-10-19T00:00:00Z'), IMAGE_TTL=72*3600000, VIDEO_TTL=48*3600000;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const taskId='img_'+'b'.repeat(32), session={ownerId:1,sessionProof:'synthetic'};
function root(t){const dir=fs.mkdtempSync(path.join(process.env.MEDIA_RETENTION_TEST_ROOT||os.tmpdir(),'media-retention-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
function image(t,options={}){const dir=root(t);let clock=BASE;return {dir,set:value=>{clock=value;},store:()=>createImageResultStore({rootDir:path.join(dir,'results'),now:()=>clock,...options}),now:()=>clock};}

test('Core image expiry remains a known expiry instead of a generic retryable bridge failure',async()=>{
  const call=createPublishedImageClient({baseUrl:'http://127.0.0.1',serviceToken:'synthetic'.repeat(5),fetchImpl:async()=>new Response(JSON.stringify({error:'result_expired'}),{status:410})});
  await assert.rejects(call(session,'GET',`tasks/${taskId}/result`,undefined,2),error=>error.code==='image_result_expired'&&error.message==='Image result expired');
});

test('image exact boundary, repeated cleanup and restart retain a non-renewable expiry proof',t=>{
  const f=image(t),store=f.store();store.saveBase64(1,taskId,0,png);f.set(BASE+IMAGE_TTL-1);assert.equal(f.store().read(1,taskId,0).length,Buffer.from(png,'base64').length);
  f.set(BASE+IMAGE_TTL);const restarted=f.store();assert.throws(()=>restarted.read(1,taskId,0),/expired/);
  const stats=restarted.cleanup();assert.equal(stats.deleted,1);t.diagnostic(JSON.stringify({kind:'image',deleted:stats.deleted,released_bytes:stats.deletedBytes}));assert.equal(restarted.cleanup().deleted,0);
  assert.equal(restarted.metadata(1,taskId,0).expired,true);assert.equal(restarted.hasTaskData(1,taskId),false);
  assert.throws(()=>restarted.saveBase64(1,taskId,0,png),/expired/);
});

test('image copies from another store keep the original trusted deadline',t=>{
  const f=image(t);f.set(BASE+24*3600000);const saved=f.store().saveBase64(1,taskId,0,png,{expiresAt:new Date(BASE+IMAGE_TTL).toISOString()});
  assert.equal(saved.expires_at,new Date(BASE+IMAGE_TTL).toISOString());f.set(BASE+IMAGE_TTL);
  assert.throws(()=>f.store().read(1,taskId,0),/expired/);
});

test('image legacy seven-day deadline survives import and is never silently extended',t=>{
  const f=image(t),file=path.join(f.dir,'results','1',`${taskId}-0.png`);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(png,'base64'));fs.utimesSync(file,new Date(BASE),new Date(BASE));
  f.set(BASE+4*86400000);const store=f.store();assert.equal(store.cleanup().deleted,0);assert.equal(store.metadata(1,taskId,0).expires_at,new Date(BASE+7*86400000).toISOString());
  store.saveBase64(1,taskId,0,png);assert.equal(store.metadata(1,taskId,0).expires_at,new Date(BASE+7*86400000).toISOString());
  f.set(BASE+7*86400000);assert.equal(store.cleanup().deleted,1);
});

test('image cleanup failure is recorded and retry reports actual released bytes',t=>{
  let fail=true;const f=image(t,{removeFile:file=>{if(fail)throw Error('synthetic denial');fs.unlinkSync(file);}}),store=f.store();store.saveBase64(1,taskId,0,png);f.set(BASE+IMAGE_TTL);
  const failed=store.cleanup();assert.equal(failed.failed,1);assert.equal(failed.deletedBytes,0);assert.throws(()=>store.read(1,taskId,0),/expired/);
  const metaFile=path.join(f.dir,'results.metadata','1',`${taskId}-0.png.meta.json`);assert.equal(JSON.parse(fs.readFileSync(metaFile)).cleanup_attempts,1);
  fail=false;const success=store.cleanup();assert.equal(success.deleted,1);assert.equal(success.retried,1);assert.equal(success.deletedBytes,Buffer.from(png,'base64').length);
});

test('two image store instances cannot renew the first successfully persisted deadline',async t=>{
  const f=image(t),first=f.store(),second=f.store();const initial=first.saveBase64(1,taskId,0,png);f.set(BASE+3600000);
  const saved=await Promise.all([Promise.resolve().then(()=>first.saveBase64(1,taskId,0,png)),Promise.resolve().then(()=>second.saveBase64(1,taskId,0,png))]);
  assert(saved.every(result=>result.expires_at===initial.expires_at));
});

function runtime(t,{persistedDelayMs=0}={}){
  const f=image(t);let posts=0,receiptGets=0,resultGets=0;
  const persistedAt=BASE+persistedDelayMs;
  const promise=()=>({persisted_at:new Date(persistedAt).toISOString(),expires_at:new Date(persistedAt+IMAGE_TTL).toISOString(),expired:f.now()>=persistedAt+IMAGE_TTL,policy:'image_original_72h'});
  const call=async(_session,method,operation)=>{
    if(operation==='quotes')return {key_ref:2,payload:{contract:IMAGE_BINDING_CONTRACT,quote_token:'a'.repeat(64),spec:{count:1,images:0},sale_price:{amount:'0.01',currency:'CNY',billing_mode:'per_request'},expires_at:new Date(BASE+120000).toISOString()}};
    if(method==='POST'){posts++;f.set(persistedAt);return {payload:{}};}
    if(operation.endsWith('/result')){resultGets++;return {payload:{data:[{b64_json:png}]}};}
    receiptGets++;return {payload:{contract:IMAGE_BINDING_CONTRACT,task_id:operation.slice(6),status:'completed',billing_state:'billed',result_available:!promise().expired,result_retention:promise()}};
  };
  const make=()=>createImageTaskRuntime({rootDir:path.join(f.dir,'journal'),call,results:f.store(),now:f.now});
  return {...f,make,counts:()=>({posts,receiptGets,resultGets})};
}

function updateJournal(f,taskID,change){
  const journal=path.join(f.dir,'journal');
  const file=fs.readdirSync(journal).filter(name=>/^task-.*\.json$/.test(name)).map(name=>path.join(journal,name)).find(file=>JSON.parse(fs.readFileSync(file)).task_id===taskID);
  const task=JSON.parse(fs.readFileSync(file));change(task);fs.writeFileSync(file,JSON.stringify(task));
}

test('image history uses the original deadline when persistence follows creation by one hour',async t=>{
  const hour=3600000,f=runtime(t,{persistedDelayMs:hour}),r=f.make();
  await r.quote(session,{offer_id:'synthetic',spec:{count:1,images:0}});
  const initial=await r.dispatch(session,{quote_token:'a'.repeat(64),client_key:'late-persistence',prompt:'synthetic',references:[]});
  assert.equal(initial.created_at,new Date(BASE).toISOString());
  assert.equal(initial.result_retention.expires_at,new Date(BASE+hour+IMAGE_TTL).toISOString());
  const counts=f.counts();
  for(const clock of [BASE+IMAGE_TTL-1,BASE+IMAGE_TTL,BASE+hour+IMAGE_TTL-1]){
    f.set(clock);const restarted=f.make(),items=restarted.history(session).tasks;
    assert.equal(items.length,1);assert.equal(items[0].result_retention.expired,false);
    assert.equal(restarted.result(session,initial.task_id,0).data.length,Buffer.from(png,'base64').length);
    assert.equal((await restarted.cleanupExpired(session)).deleted,0);
  }
  assert.deepEqual(f.counts(),counts);
  f.set(BASE+hour+IMAGE_TTL);assert.equal(f.make().history(session).tasks.length,0);
  assert.throws(()=>f.make().result(session,initial.task_id,0),/expired/);
  assert.equal((await f.make().recover(session,initial.task_id)).result_retention.expired,true);
  assert.deepEqual(f.counts(),counts);
  assert.equal(f.store().cleanup().deleted,1);
  assert.equal((await f.make().cleanupExpired(session)).deleted,1);
  const names=fs.readdirSync(path.join(f.dir,'journal'));
  assert(names.some(name=>name.endsWith('.sync-dispatch')));assert(names.some(name=>name.startsWith('quote-')));
  assert.equal(f.store().metadata(session.ownerId,initial.task_id,0).expired,true);
});

test('future Core retention preserves missing local image history and its recovery identity',async t=>{
  const f=runtime(t,{persistedDelayMs:3600000}),r=f.make();
  await r.quote(session,{offer_id:'synthetic',spec:{count:1,images:0}});
  const initial=await r.dispatch(session,{quote_token:'a'.repeat(64),client_key:'missing-live-history',prompt:'synthetic',references:[]});
  fs.unlinkSync(path.join(f.dir,'results','1',`${initial.task_id}-0.png`));
  fs.unlinkSync(path.join(f.dir,'results.metadata','1',`${initial.task_id}-0.png.meta.json`));
  updateJournal(f,initial.task_id,task=>{task.results=[];});
  f.set(BASE+IMAGE_TTL);assert.equal(f.store().hasTaskData(1,initial.task_id),false);
  assert.equal((await f.make().cleanupExpired(session)).deleted,0);
  assert.equal(f.make().history(session).tasks[0]?.task_id,initial.task_id);
  const restored=await f.make().recover(session,initial.task_id);
  assert.equal(restored.result_retention.expires_at,initial.result_retention.expires_at);
  assert.equal(f.make().result(session,initial.task_id,0).data.length,Buffer.from(png,'base64').length);
  assert.equal(f.counts().posts,1);assert.equal(f.counts().resultGets,2);
});

test('legacy PNG history remains available through the real seven-day promise',async t=>{
  const f=runtime(t),r=f.make();await r.quote(session,{offer_id:'synthetic',spec:{count:1,images:0}});
  const initial=await r.dispatch(session,{quote_token:'a'.repeat(64),client_key:'legacy-live-history',prompt:'synthetic',references:[]});
  fs.unlinkSync(path.join(f.dir,'results.metadata','1',`${initial.task_id}-0.png.meta.json`));
  fs.utimesSync(path.join(f.dir,'results','1',`${initial.task_id}-0.png`),new Date(BASE),new Date(BASE));
  updateJournal(f,initial.task_id,task=>{delete task.result_retention;for(const result of task.results){delete result.expires_at;delete result.persisted_at;}});
  for(const clock of [BASE+IMAGE_TTL,BASE+7*86400000-1]){
    f.set(clock);const items=f.make().history(session).tasks;assert.equal(items.length,1);
    assert.equal(items[0].result_retention.expires_at,new Date(BASE+7*86400000).toISOString());
    assert.equal((await f.make().cleanupExpired(session)).deleted,0);
    assert.equal(f.make().result(session,initial.task_id,0).data.length,Buffer.from(png,'base64').length);
  }
  f.set(BASE+7*86400000);assert.equal(f.make().history(session).tasks.length,0);
  assert.throws(()=>f.make().result(session,initial.task_id,0),/expired/);
});

test('completed image recovery after expiry and physical cleanup performs no Core result GET or generation POST',async t=>{
  const f=runtime(t),r=f.make();await r.quote(session,{offer_id:'synthetic',spec:{count:1,images:0}});
  const initial=await r.dispatch(session,{quote_token:'a'.repeat(64),client_key:'retention-identity',prompt:'synthetic',references:[]});
  assert.equal(initial.result_retention.expires_at,new Date(BASE+IMAGE_TTL).toISOString());
  const counts=f.counts();f.set(BASE+IMAGE_TTL);f.store().cleanup();
  const after=await f.make().recover(session,initial.task_id);assert.equal(after.status,'completed');assert.equal(after.billing_state,'billed');assert.equal(after.result_retention.expired,true);assert.deepEqual(f.counts(),counts);
  assert.throws(()=>f.make().result(session,initial.task_id,0),/expired/);
  assert(fs.readdirSync(path.join(f.dir,'journal')).some(name=>name.endsWith('.sync-dispatch')));
});

test('repairing a missing image before expiry uses Core absolute time, never a fresh local 72 hours',async t=>{
  const f=runtime(t),r=f.make();await r.quote(session,{offer_id:'synthetic',spec:{count:1,images:0}});
  const initial=await r.dispatch(session,{quote_token:'a'.repeat(64),client_key:'repair-identity',prompt:'synthetic',references:[]});
  fs.unlinkSync(path.join(f.dir,'results','1',`${initial.task_id}-0.png`));f.set(BASE+24*3600000);
  const repaired=await f.make().recover(session,initial.task_id);assert.equal(repaired.result_retention.expires_at,new Date(BASE+IMAGE_TTL).toISOString());assert.equal(f.counts().posts,1);assert.equal(f.counts().resultGets,2);
});

test('losing one BFF image metadata copy cannot reinterpret a new image as a seven-day legacy result',async t=>{
  const f=runtime(t),r=f.make();await r.quote(session,{offer_id:'synthetic',spec:{count:1,images:0}});
  const initial=await r.dispatch(session,{quote_token:'a'.repeat(64),client_key:'missing-metadata',prompt:'synthetic',references:[]});
  fs.unlinkSync(path.join(f.dir,'results.metadata','1',`${initial.task_id}-0.png.meta.json`));f.set(BASE+IMAGE_TTL);
  assert.throws(()=>f.make().result(session,initial.task_id,0),/expired/);
  const counts=f.counts();const expired=await f.make().recover(session,initial.task_id);assert.equal(expired.result_retention.expired,true);assert.equal(expired.result_retention.expires_at,new Date(BASE+IMAGE_TTL).toISOString());assert.deepEqual(f.counts(),counts);
});

test('startup and scheduled original maintenance record failures and retry without user credentials',()=>{
  let scheduled,closed=false,attempts=0;const reports=[];
  const maintenance=startResultCleanup([['image',{cleanup:()=>({deleted:1,deletedBytes:68,failed:0})}],['video',{cleanup:()=>{if(attempts++===0)throw Error('not exposed');return {deleted:1,deletedBytes:100,failed:0};}}]],{
    schedule:(fn,delay)=>{assert.equal(delay,6*3600000);scheduled=fn;return {unref(){}};},cancel:()=>{closed=true;},report:(kind,stats)=>reports.push({kind,...stats})});
  assert.equal(reports[1].error,'result_cleanup_failed');scheduled();assert.equal(reports[3].deleted,1);assert.equal(reports[3].retry_after_failure,true);assert(!JSON.stringify(reports).includes('not exposed'));maintenance.close();assert(closed);
});

test('expired image HTTP request rejects before ETag evaluation and still enforces owner authentication',async t=>{
  const f=image(t),store=f.store();store.saveBase64(1,taskId,0,png);f.set(BASE+IMAGE_TTL);let authenticated=true;
  const handler=createImageHandler({sessions:{authenticate:async()=>authenticated?session:null},tasks:{result:()=>({data:store.read(1,taskId,0),info:store.metadata(1,taskId,0)})}});
  const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/studio-v2/api/image/tasks/${taskId}/results/0`;
  let response=await fetch(url,{headers:{'If-None-Match':store.metadata(1,taskId,0).etag}});assert.equal(response.status,410);assert.equal((await response.json()).error,'image_result_expired');
  authenticated=false;response=await fetch(url);assert.equal(response.status,401);
});

let video;
function videoBytes(){return video ||=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=160x90:r=5','-t','1','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{windowsHide:true,maxBuffer:1<<20});}
function videoDelivery(t,{captureFails=false,legacy=false,unmarked=false}={}){
  const dir=root(t);let clock=BASE,downloads=0,captures=0,status='held',supplierStatus='completed',taskGets=0;
  const identity={mode:'account_video_v1',ownerId:1,childId:'video-retention',taskId:'upstream-original',accountId:7,bindingHash:'a'.repeat(64),requestHash:'b'.repeat(64)};
  const store=()=>createVideoResultStore({rootDir:path.join(dir,'originals'),now:()=>clock});
  const child={status:'accepted',childId:identity.childId,taskId:identity.taskId,bodySha256:identity.requestHash,account:{binding_hash:identity.bindingHash,binding:{offer:{account_id:7}}}};
  const make=()=>createVideoDelivery({journal:{getForOwner:(owner,id)=>owner===1&&id==='operation'?{children:[child]}:null},coordinator:{},resultStore:store(),
    ledger:{getSettlement:async()=>({ownerId:1,childId:identity.childId,status}),capture:async({evidence})=>{assert.equal(evidence.resultHash,store().metadata(identity).sha256);assert.equal(evidence.resultRetention.expires_at,legacy?null:new Date(BASE+VIDEO_TTL).toISOString());if(captureFails)throw Error('synthetic unavailable');captures++;status='captured';return {status};}},
    supplier:{getTask:async()=>{taskGets++;return {task_id:identity.taskId,status:supplierStatus};},downloadOriginal:async()=>{downloads++;return {status:200,...(!unmarked?{result_retention:{policy:legacy?'legacy_unknown':'video_original_48h',persisted_at:null,expires_at:null,expired:false}}:{}),response:new Response(videoBytes(),{headers:{'Content-Type':'video/mp4','Content-Length':String(videoBytes().length),'X-Video-Quality':'original'}})};}}});
  return {dir,identity,store,make,set:value=>{clock=value;},allowCapture:()=>{captureFails=false;},failSupplier:()=>{supplierStatus='failed';},taskGets:()=>taskGets,counts:()=>({downloads,captures})};
}

test('video expiry prevents original recovery after cleanup/restart and never repeats capture',async t=>{
  const f=videoDelivery(t);await f.make().operation.reconcileChild(1,'operation',0);assert.deepEqual(f.counts(),{downloads:1,captures:1});
  f.set(BASE+VIDEO_TTL);const stats=f.store().cleanup();assert.equal(stats.deleted,1);t.diagnostic(JSON.stringify({kind:'video',deleted:stats.deleted,released_bytes:stats.deletedBytes}));
  await assert.rejects(f.make().openOriginal(1,'operation',0),/video_result_expired/);
  await f.make().operation.reconcileChild(1,'operation',0);assert.deepEqual(f.counts(),{downloads:1,captures:1});
});

test('pending video capture recovers from immutable decoded hash proof after bytes expire, without refetch or generation',async t=>{
  const f=videoDelivery(t,{captureFails:true});await assert.rejects(f.make().operation.reconcileChild(1,'operation',0),/synthetic unavailable/);
  f.set(BASE+VIDEO_TTL);f.store().cleanup();f.allowCapture();await f.make().operation.reconcileChild(1,'operation',0);
  assert.deepEqual(f.counts(),{downloads:1,captures:1});assert.equal(f.store().metadata(f.identity).expired,true);
});

test('legacy video import remains explicitly without a new destructive deadline',async t=>{
  const f=videoDelivery(t,{legacy:true});await f.make().operation.reconcileChild(1,'operation',0);f.set(BASE+30*86400000);
  assert.equal(f.store().cleanup().deleted,0);assert.equal(f.store().metadata(f.identity).policy,'legacy_unknown');
  const opened=await f.make().openOriginal(1,'operation',0);assert.equal(opened.status,200);assert.deepEqual(f.counts(),{downloads:1,captures:1});
});

test('missing but live video is repaired from the same original, retaining its exact metadata and one capture',async t=>{
  const f=videoDelivery(t);await f.make().operation.reconcileChild(1,'operation',0);
  const directory=path.join(f.dir,'originals',fs.readdirSync(path.join(f.dir,'originals')).find(name=>/^[a-f0-9]{64}$/.test(name)));
  const before=fs.readFileSync(path.join(directory,'meta.json'));fs.unlinkSync(path.join(directory,'original.bin'));f.set(BASE+24*3600000);
  assert.equal(f.store().metadata(f.identity).missing,true);
  const result=await f.make().openOriginal(1,'operation',0);assert.equal(result.status,200);assert.deepEqual(fs.readFileSync(path.join(directory,'meta.json')),before);
  assert.deepEqual(f.counts(),{downloads:2,captures:1});assert.equal(f.store().metadata(f.identity).expiresAt,new Date(BASE+VIDEO_TTL).toISOString());
  fs.unlinkSync(path.join(directory,'original.bin'));
  assert.throws(()=>f.store().put(f.identity,{bytes:Buffer.concat([videoBytes(),Buffer.from('different')]),mimeType:'video/mp4'}),/video_result_conflict/);
  f.set(BASE+VIDEO_TTL);await assert.rejects(f.make().openOriginal(1,'operation',0),/video_result_expired/);assert.deepEqual(f.counts(),{downloads:2,captures:1});
});

test('an old video response with no retention marker is legacy, never silently subjected to 48 hours',async t=>{
  const f=videoDelivery(t,{legacy:true,unmarked:true});await f.make().operation.reconcileChild(1,'operation',0);
  f.set(BASE+90*86400000);assert.equal(f.store().cleanup().deleted,0);assert.equal(f.store().metadata(f.identity).policy,'legacy_unknown');assert.equal((await f.make().openOriginal(1,'operation',0)).status,200);
});

test('a durable video proof never changes to release because its live file is missing and supplier status later changes',async t=>{
  const f=videoDelivery(t,{captureFails:true});await assert.rejects(f.make().operation.reconcileChild(1,'operation',0),/synthetic unavailable/);
  const directory=path.join(f.dir,'originals',fs.readdirSync(path.join(f.dir,'originals')).find(name=>/^[a-f0-9]{64}$/.test(name)));
  fs.unlinkSync(path.join(directory,'original.bin'));f.set(BASE+3600000);f.failSupplier();f.allowCapture();
  await f.make().operation.reconcileChild(1,'operation',0);assert.deepEqual(f.counts(),{downloads:1,captures:1});assert.equal(f.taskGets(),1);
});
