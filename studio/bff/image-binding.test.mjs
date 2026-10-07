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
function fixture(t,{lost=false,count=1}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bound-image-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let posts=0,gets=0;
  const call=async(session,method,operation,payload,key=0)=>{
    assert.equal(session.ownerId,1);
    if(operation==='quotes')return {contract:IMAGE_BINDING_CONTRACT,key_ref:42,payload:{contract:IMAGE_BINDING_CONTRACT,quote_token:'a'.repeat(64),spec:{count,images:0},sale_price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},expires_at:new Date(Date.now()+120000).toISOString()}};
    assert.equal(key,42);
    if(method==='POST') {posts++;assert.ok(fs.readdirSync(path.join(root,'journal')).some(x=>x.endsWith('.sync-dispatch')));if(lost)throw new Error('lost response');return {payload:{}};}
    gets++;
    if(operation.endsWith('/result'))return {payload:{data:Array.from({length:count},()=>({b64_json:png}))}};
    return {payload:{contract:IMAGE_BINDING_CONTRACT,task_id:operation.slice('tasks/'.length),status:'completed',billing_state:'billed',result_available:true}};
  };
  const results=createImageResultStore({rootDir:path.join(root,'results')});
  const tasks=createImageTaskRuntime({rootDir:path.join(root,'journal'),call,results});
  const input={quote_token:'a'.repeat(64),client_key:'client-key-01',prompt:'synthetic',references:[]};
  return {root,tasks,input,results,call,stats:()=>({posts,gets})};
}
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
test('claim/response loss uses frozen original key and GET only after restart',async t=>{
  const f=fixture(t,{lost:true});await f.tasks.quote(owner,{offer_id:'published-offer',spec:{count:1,images:0}});
  await assert.rejects(f.tasks.dispatch(owner,f.input),/lost response/);
  const task=f.tasks.prepare(owner,f.input).task;await f.tasks.recover(owner,task.task_id);await f.tasks.dispatch(owner,f.input);
  assert.equal(f.stats().posts,1);assert.ok(f.stats().gets>=2);
});
test('late pending recovery cannot overwrite completed originals',async t=>{
  const f=fixture(t);await f.tasks.quote(owner,{offer_id:'p',spec:{count:1,images:0}});
  const prepared=f.tasks.prepare(owner,f.input).task;
  let finish,started;const arrived=new Promise(r=>{started=r});
  const stale=createImageTaskRuntime({rootDir:path.join(f.root,'journal'),results:f.results,call:async()=>{started();await new Promise(r=>{finish=r});return {payload:{contract:IMAGE_BINDING_CONTRACT,task_id:prepared.task_id,status:'unknown',billing_state:'pending',result_available:false}};}});
  const pending=stale.recover(owner,prepared.task_id);await arrived;
  await f.tasks.recover(owner,prepared.task_id);finish();assert.equal((await pending).status,'completed');
  assert.deepEqual(f.tasks.result(owner,prepared.task_id,0).data,Buffer.from(png,'base64'));
});
test('expected count follows immutable quote rather than historical 1/4 assumptions',async t=>{
  const f=fixture(t,{count:2});await f.tasks.quote(owner,{offer_id:'two',spec:{count:2,images:0}});assert.equal((await f.tasks.dispatch(owner,f.input)).results.length,2);
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
  const reply=await fetch(base+'/studio/api/image/tasks',{method:'POST',headers:{'X-Studio-Request':'image-binding-v1'},body:JSON.stringify(f.input)});
  assert.equal(reply.status,503);assert.equal(f.stats().posts,0);assert.equal(IMAGE_PAID_ENABLED,false);
  assert.equal((await fetch(base+'/studio/api/image/quotes',{method:'POST',body:'{}'})).status,403);
});
test('explicit server permission dispatches an owner-resolved prepared request once',async t=>{
  const f=fixture(t);await f.tasks.quote(owner,{offer_id:'published-offer',spec:{count:1,images:0}});
  const sessions={authenticate:async()=>owner,sameOrigin:()=>true};
  const server=http.createServer(createImageHandler({sessions,tasks:f.tasks,paidEnabled:true}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const input={...f.input,asset_refs:[]};delete input.references;
  const post=body=>fetch(base+'/studio/api/image/tasks',{method:'POST',headers:{'X-Studio-Request':'image-binding-v1'},body:JSON.stringify(body)});
  // An empty ordered private-asset list requires no resolver; browser URLs are forbidden.
  const first=await post(input);assert.equal(first.status,200);assert.equal((await first.json()).status,'completed');
  assert.equal((await post(input)).status,200);assert.equal(f.stats().posts,1);
  assert.equal((await post({...input,references:[]})).status,409);assert.equal(f.stats().posts,1);
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
