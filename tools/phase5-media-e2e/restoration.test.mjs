import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {createAssetIntake} from '../../studio/bff/asset-intake.mjs';import {createVideoAssetResolver} from '../../studio/bff/video-assets.mjs';import {createAccountVideoRuntime} from '../../studio/bff/video-account.mjs';import {CompilePlan,Materialize} from '../../studio/api/video-request-builder.mjs';import {model} from './contract-fixture.mjs';
test('durable preparation rebuilds trusted receipts, preserving order and owner after runtime restart',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'phase5-restore-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 const intake=createAssetIntake({rootDir:path.join(root,'assets')});const refs=[];
 for(let i=0;i<2;i++){const a=await intake.save({ownerId:7,kind:'image',mimeType:'image/png',sha256:createHash('sha256').update(bytes).digest('hex'),bytes});refs.push({kind:'image',asset_ref:a.assetRef})}
 let uploads=0;const call=async(s,method,op,p)=>{if(op==='catalog')return {payload:{offers:[{offer_id:'offer',model:model.apiModelId}]}};assert.equal(op,'prepare');uploads++;return {contract:'account_video_reference_prepare_v1',preparation_id:'prep-local',receipts:p.assets.map((a,i)=>{const {bytes_base64,...meta}=a;return {...meta,source:'https://supplier.invalid/'+i,upload_id:'upload-'+i}})}};
 const runtime=()=>createAccountVideoRuntime({rootDir:path.join(root,'journal'),call});const spec={resolution:'720p',duration_seconds:5,aspect_ratio:'16:9'};const owner={ownerId:7};
 const first=await createVideoAssetResolver({intake,tasks:runtime()})(owner,refs,'offer',model.apiModelId,spec,{prepare:true});assert.equal(uploads,1);
 const restarted=createVideoAssetResolver({intake:createAssetIntake({rootDir:path.join(root,'assets')}),tasks:runtime()});
 const recovered=await restarted(owner,refs,'offer',model.apiModelId,spec,{preparationId:first.preparationId});
 const wire=Materialize(CompilePlan({ownerId:'7',model:model.apiModelId,prompt:'@图片1 @图片2',duration:5,resolution:'720p',ratio:'16:9',assets:recovered.assets}));assert.deepEqual(JSON.parse(wire.bytes).references.map(a=>a.source),['https://supplier.invalid/0','https://supplier.invalid/1']);assert.equal(uploads,1);
 await assert.rejects(()=>restarted({ownerId:8},refs,'offer',model.apiModelId,spec,{preparationId:first.preparationId}),/asset_not_found/);
 await assert.rejects(()=>restarted(owner,[...refs].reverse(),'offer',model.apiModelId,spec,{preparationId:first.preparationId}),/preparation_mismatch/);
 await assert.rejects(()=>restarted(owner,refs,'changed',model.apiModelId,spec,{preparationId:first.preparationId}),/unsupported_model/);
 await assert.rejects(()=>restarted(owner,refs,'offer',model.apiModelId,spec),/preparation_missing/);assert.equal(uploads,1);
});
