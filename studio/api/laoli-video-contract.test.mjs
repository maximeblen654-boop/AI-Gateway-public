import test from 'node:test';
import assert from 'node:assert/strict';
import { CompilePlan, CompilePublishedPlan, Materialize, makeVerifiedAssetReceipt } from './video-request-builder.mjs';

const profile = (id = '3.0', overrides = {}) => ({apiModelId:id,upstreamModelId:id,documentedStatus:'enabled',
  inputMode:'laoli_openai_20261024',durationSeconds:[5],resolutions:['720p'],ratios:['16:9'],
  mediaLimits:{image:9,video:0,audio:0,total:9}, ...overrides});
const input = (p, extra = {}) => ({ownerId:'1',model:p.apiModelId,prompt:'fixture',duration:p.durationSeconds[0],resolution:p.resolutions[0],ratio:p.ratios[0],assets:[],...extra});
const receipt = type => makeVerifiedAssetReceipt({ownerId:'1',type,mimeType:({image:'image/png',video:'video/mp4',audio:'audio/mpeg'})[type],size:8,source:`https://assets.example/${type}`});

test('new Laoli text generation is unaffected by former supplier display aliases', () => {
  const p=profile(),expected=CompilePublishedPlan(input(p),p);
  for(const alias of ['happyhorse-store-video','minimax-h3-1080p','sd-official-store-video','sd-2.5-native-seconds']) {
    const renamed={...p,apiModelId:alias};
    assert.deepEqual(CompilePublishedPlan(input(renamed),renamed),expected);
  }
});

test('new Laoli exact IDs use independent generic fields and require a Published profile', () => {
  const p = profile();
  const plan = CompilePublishedPlan(input(p,{assets:[receipt('image')]}),p);
  assert.equal(plan.adapterRevision,'laoli_video_openai_20261024_r1');
  assert.equal(plan.contractRevision,'laoli-media-api-2026-10-24');
  assert.deepEqual(JSON.parse(Materialize(plan).bytes),{model:'3.0',prompt:'fixture',seconds:5,resolution:'720p',aspect_ratio:'16:9',reference_images:['https://assets.example/image']});
  assert.throws(()=>CompilePlan(input(p)),/Published video profile required/);
  assert.deepEqual(Materialize(JSON.parse(JSON.stringify(plan))),Materialize(plan));
});

test('new Laoli validates every documented exact model and preserves ordered grouped HTTPS receipts', () => {
  const cases = [
    ['3.0',5,'720p',9,0,0,9], ['3.5',16,'720p',30,0,0,30],
    ['minimax-h3-1080p',5,'1080p',6,0,2,8], ['sd-native-full-2.0',4,'1080p',9,3,3,12],
    ['sd-native-full-2.5',30,'480p',30,10,10,30], ['wan-3.0-video-ref',15,'720p',10,5,5,20],
    ['wan-3.0-no-video-ref',30,'720p',10,0,5,10],
  ];
  for (const [id,duration,resolution,image,video,audio,total] of cases) {
    const p = profile(id,{durationSeconds:[duration],resolutions:[resolution],mediaLimits:{image,video,audio,total}});
    const assets = [receipt('image'),...(video?[receipt('video')]:[]),...(audio?[receipt('audio')]:[])];
    const fields = CompilePublishedPlan(input(p,{assets}),p).fields;
    assert.equal(fields.model,id); assert.equal(fields.seconds,duration); assert.equal(fields.resolution,resolution);
    assert.equal(fields.duration,undefined); assert.equal(fields.ratio,undefined); assert.equal(fields.references,undefined);
    assert.deepEqual(fields.reference_images,['https://assets.example/image']);
    if(video) assert.deepEqual(fields.reference_videos,['https://assets.example/video']);
    if(audio) assert.deepEqual(fields.reference_audios,['https://assets.example/audio']);
  }
});

test('new Laoli rejects invented model/spec/capability, unsupported material kinds and unverified sources', () => {
  for (const p of [profile('3.0-old'),profile('3.0',{durationSeconds:[4]}),profile('3.5',{durationSeconds:[15]}),
    profile('3.0',{resolutions:['1080p']}),profile('minimax-h3-1080p',{resolutions:['1080p'],ratios:['1:1']}),
    profile('3.0',{mediaLimits:{image:10,video:0,audio:0,total:10}}),
    profile('sd-native-full-2.5',{mediaLimits:{image:30,video:10,audio:10,total:50}})]) {
    assert.throws(()=>CompilePublishedPlan(input(p),p));
  }
  const p = profile();
  assert.throws(()=>CompilePublishedPlan(input(p,{assets:[receipt('video')]}),p));
  assert.throws(()=>CompilePublishedPlan(input(p,{ownerId:'other',assets:[receipt('image')]}),p));
  const bytes = makeVerifiedAssetReceipt({ownerId:'1',type:'image',mimeType:'image/png',size:8,bytes:new Uint8Array(8)});
  assert.deepEqual(CompilePublishedPlan(input(p,{assets:[bytes]}),p).fields.reference_images,['data:image/png;base64,AAAAAAAAAAA=']);
  const changed=CompilePublishedPlan(input(p),p); changed.contractRevision='other';
  assert.throws(()=>Materialize(changed));
});
