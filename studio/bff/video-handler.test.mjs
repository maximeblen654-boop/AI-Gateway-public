import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createVideoHandler} from './video-handler.mjs';
import {createVideoAssetResolver} from './video-assets.mjs';
import {CompilePublishedPlan,Materialize} from '../api/video-request-builder.mjs';

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
