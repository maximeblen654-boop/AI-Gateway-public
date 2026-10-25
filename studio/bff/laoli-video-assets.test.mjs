import test from 'node:test';
import assert from 'node:assert/strict';
import {createVideoAssetResolver} from './video-assets.mjs';
import {CompilePublishedPlan,makeVerifiedAssetReceipt} from '../api/video-request-builder.mjs';

test('new Laoli uses owner-verified inline materials with no unsupported preparation upload',async()=>{
 const profile={apiModelId:'3.5',upstreamModelId:'3.5',documentedStatus:'enabled',inputMode:'laoli_openai_20261024',
  durationSeconds:[16],resolutions:['720p'],ratios:['16:9'],mediaLimits:{image:30,video:0,audio:0,total:30}};
 let prepares=0;
 const tasks={catalog:async()=>({offers:[{offer_id:'offer',model:'3.5',video_profile:profile}]}),prepareReferences:()=>{prepares++;assert.fail('new documented contract has no preparation endpoint')}};
 const intake={uploadPayload(owner){assert.equal(owner,1);return{kind:'image',mimeType:'image/png',size:8,bytes:Buffer.alloc(8),sha256:'fixture'}},
  inlineReceipt(owner){assert.equal(owner,1);return makeVerifiedAssetReceipt({ownerId:String(owner),type:'image',mimeType:'image/png',size:8,bytes:Buffer.alloc(8)})}};
 const resolve=createVideoAssetResolver({intake,tasks});
 const refs=Array.from({length:30},(_,i)=>({kind:'image',asset_ref:`asset-${i}`}));
 const assets=await resolve({ownerId:1},refs,'offer','3.5',{resolution:'720p',duration_seconds:16,aspect_ratio:'16:9'});
 assert.equal(assets.length,30);assert.equal(prepares,0);
 const plan=CompilePublishedPlan({ownerId:'1',model:'3.5',prompt:'test',duration:16,resolution:'720p',ratio:'16:9',assets},profile);
 assert.equal(plan.fields.reference_images.length,30);
 assert.ok(plan.fields.reference_images.every(v=>v==='data:image/png;base64,AAAAAAAAAAA='));
 await assert.rejects(()=>resolve({ownerId:1},[...refs,{kind:'image',asset_ref:'asset-31'}],'offer','3.5',{}),/media_reference_limit_exceeded/);
});
