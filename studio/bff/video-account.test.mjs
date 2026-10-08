import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createAccountVideoRuntime, VIDEO_CONTRACT} from './video-account.mjs';
import {createVideoResultStore} from './video-result-store.mjs';
import {createLegacyVideoRecovery} from './video-legacy-recovery.mjs';
import {createOperationJournal} from './operation-journal.js';

const hash=x=>createHash('sha256').update(x).digest('hex');
const session={ownerId:1,sessionProof:'fixture'};
test('browser can read an unsubmitted video quote after restart without asking Core for a nonexistent task',async t=>{
 const f=fixture(t),r=f.make();const op=await r.prepare(session,{clientKey:'browser-quote',offerId:'offer1',request:request()});
 const restored=await f.make().recover(session,op.operation_id);
 assert.equal(restored.status,'intent');assert.equal(restored.sale_price.currency,'CNY');assert.ok(restored.expires_at);
 assert.deepEqual(f.counts(),{posts:0,captures:0,quoteCalls:1});
});
const request=()=>({model:'3.0',prompt:'fixture',duration:5,resolution:'1280x720',ratio:'16:9',assets:[]});
let original;
function video(){return original ||= execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=1280x720:r=5','-t','5','-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{windowsHide:true,maxBuffer:1<<20});}
const profile={apiModelId:'3.0',upstreamModelId:'synthetic-video',documentedStatus:'enabled',inputMode:'images',durationSeconds:[5,8],resolutions:['1280x720','720p','1080p'],ratios:['16:9'],mediaLimits:{image:9,video:0,audio:0,total:9}};

function fixture(t,{lost=false,corrupt=false,currency='CNY',resultBytes,resultTimeout=false,taskStatus='completed',captureUnavailable=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'account-video-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const journalRoot=path.join(root,'journal'),store=createVideoResultStore({rootDir:path.join(root,'original')});
 const tasks=new Map();let posts=0,captures=0,captureRequests=0,quoteCalls=0,downloads=0,releases=0,q,lastRequest;
 const call=async (s,method,operation,payload,keyRef)=>{
  assert.equal(s.ownerId,1);
  if(operation==='catalog')return {payload:{offers:[{offer_id:'offer1',model:'3.0',video_profile:profile},{offer_id:'o',model:'3.0',video_profile:profile}]}};
  if(operation==='quotes'){
   quoteCalls++;lastRequest=structuredClone(payload.request);
   assert.equal(payload.request.resolution,payload.spec.resolution);assert.equal(payload.request.duration,payload.spec.duration_seconds);assert.equal(payload.request.ratio,payload.spec.aspect_ratio);assert.equal(payload.request.model,'synthetic-video');
   const binding={version:VIDEO_CONTRACT,quote_id:'quote-original',owner:{user_id:1,api_key_id:2,group_id:3},published_revision:'pub-original',
    offer:{offer_id:payload.offer_id,account_id:7,site_model:'3.0',adapter:{revision:'laoli_video_json_v136_r1'},sale_price:{amount:'0.80',currency,billing_mode:'per_request'}},
    spec:payload.spec,request_hash:hash(JSON.stringify(payload.request)),expires_at:new Date(Date.now()+120000).toISOString()};
   q={contract:VIDEO_CONTRACT,quote_token:'a'.repeat(64),binding_hash:hash(JSON.stringify(binding)),binding};return {key_ref:2,payload:q};
  }
  assert.equal(keyRef,2,'recovery must retain original customer key');
  if(operation==='tasks'){posts++;tasks.set(payload.task_id,{status:taskStatus,upstream_id:'original-upstream'});if(lost)throw Error('lost submit response');return {key_ref:2,payload:{}};}
  const [,id,action]=operation.split('/');const state=tasks.get(id);assert.ok(state);
  if(action==='release'){if(state.status!=='released')releases++;state.status='released';return {key_ref:2,payload:{contract:VIDEO_CONTRACT,task_id:id,status:'released'}};}
  if(!action){assert.equal(method,'GET');return {key_ref:2,payload:{contract:VIDEO_CONTRACT,task_id:id,...state,binding_hash:q.binding_hash,request_hash:q.binding.request_hash}};}
  if(action==='result'){assert.equal(method,'GET');downloads++;if(resultTimeout)throw Error('local result timeout');return {key_ref:2,payload:{mime_type:'video/mp4',bytes_base64:(corrupt?Buffer.from('not a video'):resultBytes||video()).toString('base64')}};}
  if(action==='capture'){
   captureRequests++;
   assert.equal(method,'POST');
   if(captureUnavailable)throw Error('local capture unavailable');
   const saved=store.load({mode:VIDEO_CONTRACT,ownerId:1,childId:id,taskId:state.upstream_id,accountId:7,bindingHash:q.binding_hash,requestHash:q.binding.request_hash});
   assert.ok(saved,'original must be durable before capture');assert.equal(payload.result_hash,saved.sha256);
   if(state.status!=='captured')captures++;state.status='captured';return {key_ref:2,payload:{contract:VIDEO_CONTRACT,task_id:id,status:'captured'}};
  }
  throw Error('unexpected operation '+operation);
 };
 const make=(legacy,now)=>createAccountVideoRuntime({rootDir:journalRoot,call,resultStore:createVideoResultStore({rootDir:path.join(root,'original')}),legacy,now});
 return {make,root:journalRoot,store,originalRoot:path.join(root,'original'),downloads:()=>downloads,releases:()=>releases,captureRequests:()=>captureRequests,allowCapture:()=>{captureUnavailable=false;},request:()=>lastRequest,counts:()=>({posts,captures,quoteCalls})};
}

test('legal named resolution is sent unchanged without an assumed output pixel grid',async t=>{
 for(const resolution of ['720p','1080p'])await t.test(resolution,async t=>{
  const f=fixture(t),r=f.make(),op=await r.prepare(session,{clientKey:'native-label',offerId:'offer1',request:{...request(),duration:8,resolution}});
  assert.equal((await r.dispatch(session,op.operation_id)).status,'captured');
  assert.equal(f.request().resolution,resolution);assert.equal(f.request().duration,8);assert.equal(f.request().ratio,'16:9');
  assert.equal((await f.make().recover({...session,sessionProof:'fresh-login'},op.operation_id)).status,'captured');
  assert.deepEqual(f.counts(),{posts:1,captures:1,quoteCalls:1});
 });
});

test('valid different video geometry or duration is delivered unchanged and captured once',async t=>{
 for(const [name,size,seconds] of [
  ['pixels','640x360',8],
  ['ratio','1280x1280',8],
  ['duration','1280x720',2],
 ])await t.test(name,async t=>{
 const tiny=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=blue:s=${size}:r=5`,'-t',String(seconds),'-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{windowsHide:true,maxBuffer:1<<20});
 const f=fixture(t,{resultBytes:tiny}),r=f.make(),op=await r.prepare(session,{clientKey:'valid-original',offerId:'offer1',request:{...request(),duration:8}});
 await Promise.all([r.dispatch(session,op.operation_id),r.dispatch(session,op.operation_id)]);
 const restarted=f.make();
 assert.equal((await restarted.recover({...session,sessionProof:'fresh-login'},op.operation_id)).status,'captured');
 await restarted.dispatch(session,op.operation_id);
 const opened=await restarted.original(session,op.operation_id);
 assert.deepEqual(Buffer.from(await opened.response.arrayBuffer()),tiny);
 assert.equal(opened.response.headers.get('Content-Length'),String(tiny.length));
 assert.equal(f.request().resolution,'1280x720');assert.equal(f.request().duration,8);assert.equal(f.request().ratio,'16:9');
 assert.deepEqual(f.counts(),{posts:1,captures:1,quoteCalls:1});assert.equal(f.downloads(),1);
 assert.equal(f.captureRequests(),1);
 assert.equal(f.releases(),0);
 assert.equal(restarted.history(session)[0].children[0].status,'accepted');
 await assert.rejects(restarted.original({ownerId:9},op.operation_id));
 t.diagnostic(JSON.stringify({task:op.children[0].task_id,request:f.request(),actual:{size,seconds},resultHash:hash(tiny),...f.counts(),releaseCalls:f.releases(),resultGets:f.downloads(),status:'captured'}));
 });
});

test('v1/v2 stored originals resume one pending capture without rewriting bytes or metadata',async t=>{
 for(const version of [1,2])await t.test(`v${version}`,async t=>{
  const f=fixture(t,{captureUnavailable:true}),r=f.make();
  const op=await r.prepare(session,{clientKey:'historical',offerId:'offer1',request:{...request(),duration:8}});
  await assert.rejects(r.dispatch(session,op.operation_id),/local capture unavailable/);
  const metaFile=path.join(f.originalRoot,fs.readdirSync(f.originalRoot)[0],'meta.json');
  const meta=JSON.parse(fs.readFileSync(metaFile));meta.version=version;
  if(version===1)delete meta.media;else meta.media=null;
  const old=JSON.stringify(meta);fs.writeFileSync(metaFile,old);
  f.allowCapture();const restarted=f.make();
  assert.equal((await restarted.recover(session,op.operation_id)).status,'captured');
  await restarted.dispatch({...session,sessionProof:'fresh-login'},op.operation_id);
  const opened=await restarted.original(session,op.operation_id);
  assert.deepEqual(Buffer.from(await opened.response.arrayBuffer()),video());
  assert.equal(fs.readFileSync(metaFile,'utf8'),old);
  assert.deepEqual(f.counts(),{posts:1,captures:1,quoteCalls:1});assert.equal(f.downloads(),1);
  assert.equal(f.releases(),0);
 });
});

test('explicit supplier failure releases once; pending or missing result never captures',async t=>{
 for(const mode of ['failed','pending','empty'])await t.test(mode,async t=>{
  const f=fixture(t,{taskStatus:mode==='empty'?'completed':mode,...(mode==='empty'?{resultBytes:Buffer.alloc(0)}:{})}),r=f.make();
  const op=await r.prepare(session,{clientKey:mode,offerId:'offer1',request:request()});
  if(mode==='empty'){
   await assert.rejects(r.dispatch(session,op.operation_id),/original_receipt_mismatch/);
   await assert.rejects(f.make().recover(session,op.operation_id),/original_receipt_mismatch/);
  }else{
   assert.equal((await r.dispatch(session,op.operation_id)).status,mode==='failed'?'released':'pending');
   assert.equal((await f.make().recover(session,op.operation_id)).status,mode==='failed'?'released':'pending');
  }
  assert.deepEqual(f.counts(),{posts:1,captures:0,quoteCalls:1});assert.equal(f.releases(),mode==='failed'?1:0);
 });
});

test('result timeout only retries original GET after restart, never POST or settlement',async t=>{
 const f=fixture(t,{resultTimeout:true}),r=f.make(),op=await r.prepare(session,{clientKey:'result-timeout',offerId:'offer1',request:request()});
 await assert.rejects(r.dispatch(session,op.operation_id),/local result timeout/);
 await assert.rejects(f.make().dispatch(session,op.operation_id),/local result timeout/);
 assert.deepEqual(f.counts(),{posts:1,captures:0,quoteCalls:1});assert.equal(f.downloads(),2);
 assert.equal(f.releases(),0);
});

test('expired video quote cannot first dispatch; expiry never prevents original task recovery',async t=>{
 const f=fixture(t),r=f.make(),op=await r.prepare(session,{clientKey:'expiry-check',offerId:'offer1',request:request()});
 const later=f.make(undefined,()=>Date.now()+3600000);
 await assert.rejects(later.dispatch(session,op.operation_id),/video_quote_expired/);assert.equal(f.counts().posts,0);
 await r.dispatch(session,op.operation_id);assert.equal((await later.dispatch(session,op.operation_id)).status,'captured');assert.equal(f.counts().posts,1);assert.equal(f.counts().captures,1);
});

test('Published quote -> immutable task -> original store -> once-only capture',async t=>{
 const f=fixture(t),r=f.make();
 const op=await r.prepare(session,{clientKey:'click1',offerId:'offer1',request:request()});
 assert.ok(op.children[0].task_id.startsWith('av_'));
 assert.deepEqual(op.children[0].sale_price,{amount:'0.80',currency:'CNY',billing_mode:'per_request'});
 assert.equal(JSON.stringify(op).includes('account_id'),false);
 const completed=await r.dispatch(session,op.operation_id);assert.equal(completed.status,'captured');
 await f.make().recover(session,op.operation_id);
 await f.make().dispatch(session,op.operation_id);
 assert.deepEqual(f.counts(),{posts:1,captures:1,quoteCalls:1});
 const opened=await r.original(session,op.operation_id,{method:'GET'});
 assert.deepEqual(Buffer.from(await opened.response.arrayBuffer()),video());
 const partial=await r.original(session,op.operation_id,{range:'bytes=0-15'});assert.equal(partial.status,206);
 assert.equal((await partial.response.arrayBuffer()).byteLength,16);
 await assert.rejects(r.recover({ownerId:9},op.operation_id));
});

test('new USD quote is rejected before journal or task creation',async t=>{
 const f=fixture(t,{currency:'USD'}),r=f.make();
 await assert.rejects(r.prepare(session,{clientKey:'usd-new',offerId:'offer1',request:request()}),/Quote binding mismatch/);
 assert.deepEqual(f.counts(),{posts:0,captures:0,quoteCalls:1});
 assert.deepEqual(r.history(session),[]);
});

test('lost POST response/restart only recovers original task, never requotes or resubmits',async t=>{
 const f=fixture(t,{lost:true}),r=f.make();
 const op=await r.prepare(session,{clientKey:'lost',offerId:'offer1',request:request()});
 assert.equal((await r.dispatch(session,op.operation_id)).status,'unknown');
 const restarted=f.make();assert.equal((await restarted.recover(session,op.operation_id)).status,'captured');
 await restarted.dispatch(session,op.operation_id);assert.deepEqual(f.counts(),{posts:1,captures:1,quoteCalls:1});
});

test('corrupt original cannot capture',async t=>{
 const f=fixture(t,{corrupt:true}),r=f.make();const op=await r.prepare(session,{clientKey:'bad',offerId:'offer1',request:request()});
 await assert.rejects(r.dispatch(session,op.operation_id),/video_result_type_mismatch/);assert.equal(f.counts().captures,0);
});

test('same client key cannot change request or Published offer',async t=>{
 const f=fixture(t),r=f.make();await r.prepare(session,{clientKey:'same',offerId:'offer1',request:request()});
 await assert.rejects(r.prepare(session,{clientKey:'same',offerId:'offer2',request:request()}));
 await assert.rejects(r.prepare(session,{clientKey:'same',offerId:'offer1',request:{...request(),prompt:'changed'}}));
 assert.equal(f.counts().quoteCalls,1);
});

test('legacy journal preserves slot, bytes and idempotency key; new quote cannot reinterpret it',async t=>{
 const f=fixture(t),j=createOperationJournal({rootDir:f.root}),body=Buffer.from('{"original":true}');
 const op=j.createIntent({ownerId:1,clientKey:'old',quoteId:'old-quote',capabilityRevision:'old-revision',currency:'USD',children:[{keySlotId:'original-slot',holdAmountMinor:80,bodyBytes:body}]});
 let recovered=0;const r=f.make({recover:async(s,id)=>{recovered++;assert.equal(id,op.operationId);return 'original-slot-recovery';}});
 assert.equal(await r.recover(session,op.operationId),'original-slot-recovery');assert.equal(recovered,1);
 const reread=j.getForOwner(1,op.operationId);assert.equal(reread.version,1);assert.equal(reread.children[0].keySlotId,'original-slot');assert.equal(reread.children[0].account,undefined);
 assert.deepEqual(j.readChildBody(1,op.operationId,0),body);assert.equal(reread.children[0].upstreamIdempotencyKey,op.children[0].upstreamIdempotencyKey);
 await assert.rejects(r.prepare(session,{clientKey:'old',offerId:'offer1',request:request()}));
 assert.deepEqual(f.counts(),{posts:0,captures:0,quoteCalls:0});
});


test('legacy recovery uses original receipt GET and original capture, never Account billing',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-video-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const journal=createOperationJournal({rootDir:path.join(root,'journal')});
 const op=journal.createIntent({ownerId:1,clientKey:'old',quoteId:'old-quote',capabilityRevision:'old-revision',currency:'USD',children:[{keySlotId:'historical-slot',holdAmountMinor:80,bodyBytes:Buffer.from('{"original":"bytes"}')}]});
 journal.markHeld(1,op.operationId,0,'original-hold');journal.markDispatching(1,op.operationId,0);
 const child=op.children[0];let captures=0,status='held',gets=0;
 const ledger={reserve:()=>assert.fail('legacy reserve forbidden'),getSettlement:async()=>({ownerId:1,childId:child.childId,status}),capture:async input=>{assert.equal(input.childId,child.childId);assert.equal(input.evidence.supplierTaskId,'old-task');assert.equal(input.evidence.bindingHash,undefined);captures++;status='captured';return{ownerId:1,childId:child.childId,status}},release:()=>assert.fail('unexpected release')};
 const supplier={submitOnce:()=>assert.fail('legacy POST forbidden'),recoverSubmission:async input=>{gets++;assert.equal(input.keySlotId,'historical-slot');assert.equal(input.idempotencyKey,child.upstreamIdempotencyKey);return{status:200,receipt:{receipt:'accepted',idempotency_key_hash:hash(child.upstreamIdempotencyKey),task:{id:'old-task'}}}},getTask:async input=>{assert.equal(input.keySlotId,'historical-slot');assert.equal(input.taskId,'old-task');return{id:'old-task',status:'completed'}},downloadOriginal:async()=>({status:200,response:new Response(video(),{headers:{'Content-Type':'video/mp4','Content-Length':String(video().length),'X-Video-Quality':'original'}})})};
 const legacy=createLegacyVideoRecovery({rootDir:path.join(root,'journal'),ledger,supplier,resultStore:createVideoResultStore({rootDir:path.join(root,'results')})});
 await legacy.recover(session,op.operationId);await legacy.recover(session,op.operationId);
 assert.equal(captures,1);assert.equal(gets,1);assert.deepEqual(journal.readChildBody(1,op.operationId,0),Buffer.from('{"original":"bytes"}'));
 assert.equal(journal.getForOwner(1,op.operationId).children[0].account,undefined);
});
