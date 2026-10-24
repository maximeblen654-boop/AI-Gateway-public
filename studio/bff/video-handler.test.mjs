import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createVideoHandler} from './video-handler.mjs';
import {createVideoAssetResolver} from './video-assets.mjs';
import {createAccountVideoRuntime,VIDEO_CONTRACT} from './video-account.mjs';
import {CompilePublishedPlan,Materialize,makeVerifiedAssetReceipt} from '../api/video-request-builder.mjs';

test('HTTP task dispatch uses authenticated owner, opaque operation and closed default gate',async t=>{
 let calls=0;
 const sessions={authenticate:async r=>r.headers.cookie==='fixture'?{ownerId:1}:null,sameOrigin:r=>r.headers.origin==='https://studio.example'};
 const tasks={dispatch:async(s,id)=>{assert.equal(s.ownerId,1);calls++;return{operation_id:id,status:'unknown'}}};
 async function server(enabled){const s=http.createServer(createVideoHandler({sessions,tasks,...(enabled?{paidEnabled:true}:{})}));await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>s.close(resolve)));return `http://127.0.0.1:${s.address().port}/studio-v2/api/video/tasks`}
 const url=await server(true),closed=await server(false);
 const options={method:'POST',headers:{Cookie:'fixture',Origin:'https://studio.example','X-Studio-Request':'video-binding-v1','Content-Type':'application/json'},body:JSON.stringify({operation_id:'op_'+'a'.repeat(64)})};
 assert.equal((await fetch(url,{...options,headers:{}})).status,401);
 assert.equal((await fetch(url,{...options,headers:{Cookie:'fixture'}})).status,403);
 assert.equal((await fetch(closed,options)).status,503);
 assert.equal((await fetch(url,options)).status,200);assert.equal(calls,1);
 assert.equal((await fetch(url,{...options,body:JSON.stringify({operation_id:'op_'+'a'.repeat(64),account_id:99})})).status,409);assert.equal(calls,1);
});

test('HTTP quote resolves ordered asset refs server-side and never falls back to an empty list', async t => {
  const sessions={authenticate:async r=>r.headers.cookie==='fixture'?{ownerId:7}:null,sameOrigin:r=>r.headers.origin==='https://studio.example'};
  let seen;
  const tasks={prepare:async(session,input)=>{seen={session,input};return {operation_id:'op_'+'b'.repeat(64)}}};
  const resolveAssets=async(session,assets,offerId,model)=>{
    assert.equal(session.ownerId,7);assert.equal(offerId,'offer-3');assert.equal(model,'3.0');
    return assets.map(asset=>Object.freeze({ownerId:'7',type:asset.kind,mimeType:'image/png',size:8,durationSeconds:undefined}));
  };
  const server=http.createServer(createVideoHandler({sessions,tasks,resolveAssets}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/studio-v2/api/video/quotes`;
  const response=await fetch(url,{method:'POST',headers:{Cookie:'fixture',Origin:'https://studio.example','X-Studio-Request':'video-binding-v1','Content-Type':'application/json'},body:JSON.stringify({client_key:'client-1',offer_id:'offer-3',model:'3.0',prompt:'@图片1',duration:5,resolution:'720p',ratio:'16:9',assets:[{kind:'image',asset_ref:'asset_one'}]})});
  assert.equal(response.status,200);assert.equal(seen.session.ownerId,7);assert.equal(seen.input.request.assets.length,1);assert.equal(seen.input.request.assets[0].type,'image');
  const rejected=await fetch(url,{method:'POST',headers:{Cookie:'fixture',Origin:'https://studio.example','X-Studio-Request':'video-binding-v1','Content-Type':'application/json'},body:JSON.stringify({client_key:'client-2',offer_id:'offer-3',model:'3.0',prompt:'text',duration:5,resolution:'720p',ratio:'16:9',assets:[{kind:'image',asset_ref:'asset_one'}]})});
  assert.equal(rejected.status,200);assert.notEqual(seen.input.request.assets.length,0);
});

test('reference preparation failures are explicit and do not call Core quote with assets=[]', async t => {
  const sessions={authenticate:async()=>({ownerId:7}),sameOrigin:()=>true};
  let prepared=0;
  const tasks={prepare:async()=>{prepared++;return {operation_id:'op_'+'c'.repeat(64)}}};
  const server=http.createServer(createVideoHandler({sessions,tasks,resolveAssets:async()=>{throw new Error('account_bound_reference_upload_unavailable')}}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/studio-v2/api/video/quotes`,{method:'POST',headers:{Origin:'https://studio.example','X-Studio-Request':'video-binding-v1','Content-Type':'application/json'},body:JSON.stringify({client_key:'client-3',offer_id:'offer-ref',model:'minimax-h3-1080p',prompt:'reference',duration:5,resolution:'1080p',ratio:'16:9',assets:[{kind:'image',asset_ref:'asset_ref'}]})});
  assert.equal(response.status,422);assert.equal(prepared,0);assert.equal((await response.json()).error,'account_bound_reference_upload_unavailable');
});

test('omitted assets remains a legal no-material quote', async t => {
 const server=http.createServer(createVideoHandler({sessions:{authenticate:async()=>({ownerId:7}),sameOrigin:()=>true},tasks:{prepare:async(s,input)=>{assert.deepEqual(input.request.assets,[]);return {operation_id:'op_'+'d'.repeat(64)}}}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/studio-v2/api/video/quotes`,{method:'POST',headers:{'X-Studio-Request':'video-binding-v1','Content-Type':'application/json'},body:JSON.stringify({client_key:'no-assets',offer_id:'offer',model:'3.0',prompt:'text',duration:5,resolution:'720p',ratio:'16:9'})});
 assert.equal(response.status,200);
});

test('reference profiles only require preparation for actual reference assets', async t => {
 const profile={apiModelId:'local-reference',upstreamModelId:'local-reference',documentedStatus:'enabled',inputMode:'references',durationSeconds:[5],resolutions:['720p'],ratios:['16:9'],mediaLimits:{image:1,video:1,audio:1,total:3},requiredAnyMedia:[]};
 let quotes=0,uploads=0;
 const tasks={catalog:async()=>({offers:[{offer_id:'offer',model:profile.apiModelId,video_profile:profile}]}),
  prepareReferences:async()=>{uploads++;throw Error('Unexpected upload')},getPreparation:()=>undefined,
  prepare:async(s,input)=>{const wire=Materialize(CompilePublishedPlan({...input.request,ownerId:String(s.ownerId)},profile));assert.equal(JSON.parse(wire.bytes).references,undefined);quotes++;return {operation_id:'op_'+'e'.repeat(64)}}};
 const intake={uploadPayload:()=>({kind:'image',mimeType:'image/png',size:1,sha256:'a'.repeat(64),bytes:Buffer.from([1])})};
 const server=http.createServer(createVideoHandler({sessions:{authenticate:async()=>({ownerId:7}),sameOrigin:()=>true},tasks,resolveAssets:createVideoAssetResolver({intake,tasks})}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const quote=async extra=>fetch(`http://127.0.0.1:${server.address().port}/studio-v2/api/video/quotes`,{method:'POST',headers:{'X-Studio-Request':'video-binding-v1','Content-Type':'application/json'},body:JSON.stringify({client_key:'no-reference',offer_id:'offer',model:profile.apiModelId,prompt:'text',duration:5,resolution:'720p',ratio:'16:9',...extra})});
 assert.equal((await quote({})).status,200);
 assert.equal((await quote({assets:[]})).status,200);
 const missing=await quote({assets:[{kind:'image',asset_ref:'asset_one'}]});assert.equal(missing.status,422);assert.equal((await missing.json()).error,'account_video_preparation_missing');
 const stale=await quote({assets:[],preparation_id:'old-preparation'});assert.equal(stale.status,422);assert.equal((await stale.json()).error,'account_video_preparation_mismatch');
 profile.requiredAnyMedia=['image'];assert.equal((await quote({assets:[]})).status,409);
 assert.equal(quotes,2);assert.equal(uploads,0);
});

test('HTTP quotes share one trusted catalog within each request and retain final Core quote checks',async t=>{
 for(const mode of ['text','inline asset','existing preparation','missing profile','missing preparation','wrong owner'])await t.test(mode,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'video-request-catalog-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile={apiModelId:'3.0',upstreamModelId:'synthetic-video',documentedStatus:'enabled',inputMode:mode.includes('preparation')?'references':'images',durationSeconds:[5],resolutions:['720p'],ratios:['16:9'],mediaLimits:{image:9,video:0,audio:0,total:9}};
  const spec={resolution:'720p',duration_seconds:5,aspect_ratio:'16:9',quality:'',count:1,images:1,videos:0,audio:0};
  const asset={asset_ref:'asset_one',kind:'image',mime_type:'image/png',size:8,sha256:'a'.repeat(64)};
  const preparation={owner_id:7,preparation_id:'existing-preparation',offer_id:'offer',model:'3.0',spec,assets:[asset],result:{preparation_id:'existing-preparation',receipts:[{...asset,source:'https://supplier.invalid/reference'}]}};
  let catalogs=0,quotes=0;
  const tasks=createAccountVideoRuntime({rootDir:root,resultStore:{},call:async(session,method,operation,payload)=>{
   assert.equal(session.ownerId,7);
   if(operation==='catalog'){catalogs++;assert.equal(method,'GET');return {payload:{offers:[{offer_id:'offer',model:'3.0',...(mode==='missing profile'?{}:{video_profile:profile})}]}};}
   assert.equal(operation,'quotes','only final Core quote may run');assert.equal(method,'POST');quotes++;
   const binding={version:VIDEO_CONTRACT,quote_id:'quote-original',owner:{user_id:mode==='wrong owner'?99:7,api_key_id:2,group_id:3},published_revision:'pub-original',offer:{offer_id:'offer',account_id:8,site_model:'3.0',adapter:{revision:'laoli_video_json_v136_r1'},sale_price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'}},spec:payload.spec,request_hash:createHash('sha256').update(JSON.stringify(payload.request)).digest('hex'),expires_at:new Date(Date.now()+120000).toISOString()};
   return {key_ref:2,payload:{contract:VIDEO_CONTRACT,quote_token:'a'.repeat(64),binding_hash:'b'.repeat(64),binding}};
  }});
  // Simulate an already persisted preparation, without another upload.
  tasks.getPreparation=()=>mode==='existing preparation'?preparation:undefined;
  const intake={uploadPayload:()=>({kind:'image',mimeType:'image/png',size:8,sha256:asset.sha256,bytes:Buffer.alloc(8)}),inlineReceipt:()=>makeVerifiedAssetReceipt({ownerId:'7',type:'image',mimeType:'image/png',size:8,bytes:Buffer.alloc(8)})};
  const server=http.createServer(createVideoHandler({sessions:{authenticate:async()=>({ownerId:7}),sameOrigin:()=>true},tasks,resolveAssets:createVideoAssetResolver({intake,tasks})}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const input={client_key:'quote-client',offer_id:'offer',model:'3.0',prompt:'fixture',duration:5,resolution:'720p',ratio:'16:9',assets:mode.includes('preparation')||mode==='inline asset'?[{kind:'image',asset_ref:asset.asset_ref}]:[],...(mode.includes('preparation')?{preparation_id:preparation.preparation_id}:{})};
  const post=extra=>fetch(`http://127.0.0.1:${server.address().port}/studio-v2/api/video/quotes`,{method:'POST',headers:{'X-Studio-Request':'video-binding-v1','Content-Type':'application/json'},body:JSON.stringify({...input,...extra})});
  const failed=mode==='missing preparation'||mode==='wrong owner';
  const first=await post({});assert.equal(first.status,failed?(mode==='missing preparation'?422:409):200);assert.equal(catalogs,1);assert.equal(quotes,mode==='missing preparation'?0:1);
  const second=await post({client_key:'another-client'});assert.equal(second.status,first.status);assert.equal(catalogs,2,'another HTTP request must read its own catalog');assert.equal(quotes,mode==='missing preparation'?0:2);
  if(!failed){
   const repeated=await post({});assert.equal(repeated.status,200);assert.deepEqual(await repeated.json(),await first.json());assert.equal(catalogs,3);assert.equal(quotes,2,'existing client key must not requote');
   assert.equal((await post({prompt:'changed'})).status,409);assert.equal(quotes,2,'changed input cannot reuse an existing intent');
  }
  const before=catalogs;assert.equal((await post({getCatalog:{offers:[]}})).status,409);assert.equal(catalogs,before,'browser cannot supply catalog context');
 });
});


test('HTTP video history awaits authoritative snapshots and reports asynchronous failures',async t=>{
 let fail=false;
 const server=http.createServer(createVideoHandler({sessions:{authenticate:async()=>({ownerId:1})},tasks:{history:async()=>{await Promise.resolve();if(fail)throw Error('offline');return [{status:'captured'}];}}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/studio-v2/api/video/operations`;
 const response=await fetch(url);assert.equal(response.status,200);assert.deepEqual(await response.json(),[{status:'captured'}]);
 fail=true;assert.equal((await fetch(url)).status,409);
});

test('HTTP cover is authenticated JPEG GET/HEAD with private headers, exact operation path and no paid gate',async t=>{
 const operationId='op_'+'f'.repeat(64),jpeg=Buffer.from('ffd8ffe000046a66ffd9','hex');
 const calls=[];let failure;
 const tasks={cover:async(s,id,options)=>{
  calls.push({id,options});assert.equal(s.ownerId,7);assert.equal(id,operationId);
  if(failure)throw Error(failure);
  return {status:200,response:new Response(options.method==='HEAD'?null:jpeg,{headers:{'Content-Type':'image/jpeg','Content-Length':String(jpeg.length),'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}})};
 },recover:()=>assert.fail('cover cannot recover task'),original:()=>assert.fail('cover cannot download original'),readiness:()=>assert.fail('cover does not consult paid generation gate')};
 const sessions={authenticate:async req=>req.headers.cookie==='fixture'?{ownerId:7}:null,sameOrigin:()=>true};
 const server=http.createServer(createVideoHandler({sessions,tasks}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/studio-v2/api/video/operations/${operationId}/cover`,headers={Cookie:'fixture'};
 assert.equal((await fetch(url)).status,401);assert.equal(calls.length,0);
 const get=await fetch(url,{headers});assert.equal(get.status,200);assert.equal(get.headers.get('content-type'),'image/jpeg');
 assert.equal(get.headers.get('cache-control'),'private, no-store');assert.equal(get.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await get.arrayBuffer()),jpeg);
 const head=await fetch(url,{method:'HEAD',headers});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),String(jpeg.length));assert.equal((await head.arrayBuffer()).byteLength,0);
 assert.deepEqual(calls.map(c=>c.options),[{method:'GET'},{method:'HEAD'}]);
 assert.equal((await fetch(url+'?source=other',{headers})).status,400);
 assert.equal((await fetch(url.replace('/cover','/children/0/cover'),{headers})).status,404);
 assert.equal((await fetch(url,{method:'POST',headers:{...headers,'X-Studio-Request':'video-binding-v1'}})).status,404);assert.equal(calls.length,2);
 failure='video_result_expired';assert.equal((await fetch(url,{headers})).status,410);assert.equal((await fetch(url,{method:'HEAD',headers})).status,410);
 failure='video_cover_unavailable';assert.equal((await fetch(url,{headers})).status,404);
});
