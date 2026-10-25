import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CompilePlan, CompilePublishedPlan, Materialize, buildVideoRequestBytes, makeVerifiedAssetReceipt } from './video-request-builder.mjs';

const profile = () => ({apiModelId:'generic-video',upstreamModelId:'generic-upstream',documentedStatus:'enabled',inputMode:'images',durationSeconds:[5],resolutions:['720p'],ratios:['16:9'],mediaLimits:{image:9,video:0,audio:0,total:9}});
const input = () => ({ ownerId:'1',model:'generic-video',prompt:'fixture',duration:5,resolution:'720p',ratio:'16:9',assets:[] });

test('every controlled Published wire profile preserves selected request parameters and resolution labels',()=>{
 for(const inputMode of ['images','inline_multimedia','references']) for(const resolution of ['1280x720','720p','1080p','4k']) {
  const p={...profile(),inputMode,durationSeconds:[8],resolutions:[resolution],mediaLimits:{image:0,video:0,audio:0,total:0}};
  const fields=JSON.parse(Materialize(CompilePublishedPlan({...input(),duration:8,resolution},p)).bytes);
  assert.equal(fields.model,'generic-upstream');assert.equal(fields.resolution,resolution);
  assert.equal(fields[inputMode==='references'?'seconds':'duration'],8);
  assert.equal(fields[inputMode==='references'?'aspect_ratio':'ratio'],'16:9');
  assert.equal(fields[inputMode==='references'?'duration':'seconds'],undefined);
 }
});

test('explicit generic profile preserves deterministic bytes without a global supplier model table',()=>{
 const x=input(),p=profile(),plan=CompilePlan(x,p);
 const expected=Buffer.from(JSON.stringify({model:'generic-upstream',prompt:'fixture',duration:5,resolution:'720p',ratio:'16:9',face_direct:false}));
 assert.deepEqual(Materialize(plan).bytes,expected);assert.deepEqual(buildVideoRequestBytes(x,p),expected);
 assert.deepEqual(CompilePlan(x,p),plan);assert.equal(Materialize(plan).requestHash,createHash('sha256').update(expected).digest('hex'));
 assert.throws(()=>CompilePlan(x),/Published video profile required/);
});

test('serialized frozen plan materializes independently of current Published profile',()=>{
 const p=profile(),plan=JSON.parse(JSON.stringify(CompilePlan(input(),p))),before=Materialize(plan);
 p.upstreamModelId='changed-current-model';p.documentedStatus='paused';
 assert.deepEqual(Materialize(plan),before);assert.throws(()=>CompilePlan(input(),p));
});

test('request changes invalidate frozen plans and revisions fail closed',()=>{
 for(const change of [p=>{p.fields.prompt='different'},p=>{p.path='/other'},p=>{p.adapterRevision='new'},p=>{p.fields.model='other-account-model'}]) {
  const p=CompilePlan(input(),profile());change(p);assert.throws(()=>Materialize(p));
 }
});

test('asset ownership, field rules and immutable bytes use explicit generic profiles',()=>{
 const bytes=Uint8Array.from([1,2,3]);const asset=makeVerifiedAssetReceipt({ownerId:'1',type:'image',mimeType:'image/png',size:3,bytes});
 const x={...input(),assets:[asset]},plan=CompilePlan(x,profile());bytes[0]=9;
 assert.deepEqual(Materialize(plan).bytes,buildVideoRequestBytes(x,profile()));
 assert.throws(()=>CompilePlan({...x,ownerId:'2'},profile()));assert.throws(()=>CompilePlan({...input(),duration:6},profile()));
 assert.throws(()=>CompilePlan({...input(),apiKey:'not-permitted'},profile()));
});

test('Grok and Seedance keep their native paths and wire fields',()=>{
 const grok=CompilePublishedPlan(input(),{...profile(),inputMode:'grok'});
 assert.equal(grok.adapterRevision,'core_grok_video_r1');assert.equal(grok.path,'/v1/videos/generations');
 assert.deepEqual(grok.fields,{model:'generic-upstream',prompt:'fixture',duration:5,resolution:'720p',aspect_ratio:'16:9'});
 const seedance=CompilePublishedPlan(input(),{...profile(),inputMode:'seedance'});
 assert.equal(seedance.adapterRevision,'core_seedance_video_r1');assert.equal(seedance.path,'/v1/contents/generations/tasks');
 assert.deepEqual(seedance.fields,{model:'generic-upstream',content:[{type:'text',text:'fixture'}],duration:5,resolution:'720p',aspect_ratio:'16:9'});
 for(const p of [grok,seedance]){assert.equal(p.fields.seconds,undefined);assert.equal(p.fields.reference_images,undefined);assert.deepEqual(Materialize(JSON.parse(JSON.stringify(p))),Materialize(p))}
});

test('Published video capabilities stay independent of former supplier aliases',()=>{
 for(const inputMode of ['images','inline_multimedia','references','grok','seedance']) {
  const p={...profile(),inputMode};
  const expected=CompilePublishedPlan(input(),p);
  for(const alias of ['happyhorse-store-video','minimax-h3-1080p','sd-official-store-video','sd-2.5-native-seconds']) {
   assert.deepEqual(CompilePublishedPlan({...input(),model:alias},{...p,apiModelId:alias}),expected);
  }
 }
});

test('reference wire fields and limits do not depend on former supplier aliases',()=>{
 const p={...profile(),inputMode:'references',mediaLimits:{image:2,video:1,audio:1,total:4}};
 const assets=[
  makeVerifiedAssetReceipt({ownerId:'1',type:'image',mimeType:'image/png',size:26_000_000,source:'https://assets.example/image'}),
  makeVerifiedAssetReceipt({ownerId:'1',type:'video',mimeType:'video/mp4',size:3,source:'https://assets.example/video',durationSeconds:40}),
  makeVerifiedAssetReceipt({ownerId:'1',type:'audio',mimeType:'audio/mpeg',size:3,source:'https://assets.example/audio'}),
 ];
 const x={...input(),assets},expected=CompilePublishedPlan(x,p);
 for(const alias of ['minimax-h3-1080p','sd-official-store-video','sd-2.5-native-seconds']) {
  assert.deepEqual(CompilePublishedPlan({...x,model:alias},{...p,apiModelId:alias}),expected);
 }
 assert.throws(()=>CompilePublishedPlan({...x,ownerId:'2'},p),/ownership/);
 assert.throws(()=>CompilePublishedPlan(x,{...p,mediaLimits:{image:2,video:0,audio:1,total:4}}),/Too many/);
});

test('Published media requirements still reject missing assets for every alias',()=>{
 for(const alias of ['generic-video','happyhorse-store-video']) {
  const p={...profile(),apiModelId:alias,requiredAnyMedia:['image']};
  assert.throws(()=>CompilePublishedPlan({...input(),model:alias},p),/Required image or video missing/);
 }
});
