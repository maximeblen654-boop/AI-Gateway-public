import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CompilePlan, CompilePublishedPlan, Materialize, buildVideoRequestBytes, makeVerifiedAssetReceipt } from './video-request-builder.mjs';
import catalog from '../../backend/internal/videoplan/contract.json' with { type: 'json' };

const input = () => ({ ownerId: '1', model: '3.0', prompt: 'fixture', duration: 5, resolution: '720p', ratio: '16:9', assets: [] });

test('every controlled Published wire profile preserves the selected output parameters',()=>{
 for(const inputMode of ['images','inline_multimedia','references']){
  const profile={apiModelId:'synthetic-profile',upstreamModelId:'synthetic-upstream',documentedStatus:'enabled',inputMode,durationSeconds:[5],resolutions:['1280x720'],ratios:['16:9'],mediaLimits:{image:0,video:0,audio:0,total:0}};
  const plan=CompilePublishedPlan({...input(),model:profile.apiModelId,resolution:'1280x720'},profile);
  const fields=JSON.parse(Materialize(plan).bytes);
  assert.equal(fields.model,'synthetic-upstream');assert.equal(fields.resolution,'1280x720');
  assert.equal(fields[inputMode==='references'?'seconds':'duration'],5);
  assert.equal(fields[inputMode==='references'?'aspect_ratio':'ratio'],'16:9');
  assert.equal(fields[inputMode==='references'?'duration':'seconds'],undefined);
 }
});

test('legacy exact bytes and shared deterministic plan', () => {
  const x = input();
  const p = CompilePlan(x);
  const expected = Buffer.from(JSON.stringify({ model: '特价2.0-需要过人脸技术-可参考过人脸素材库', prompt: 'fixture', duration: 5, resolution: '720p', ratio: '16:9', face_direct: false }));
  assert.deepEqual(Materialize(p).bytes, expected);
  assert.deepEqual(buildVideoRequestBytes(x), expected);
  assert.deepEqual(CompilePlan(x), p);
  assert.equal(Materialize(p).requestHash, createHash('sha256').update(expected).digest('hex'));
});

test('serialized historical plan materializes after catalog changes', () => {
  const p = JSON.parse(JSON.stringify(CompilePlan(input())));
  const before = Materialize(p);
  const model = catalog.models.find(m => m.apiModelId === '3.0');
  const saved = model.upstreamModelId;
  try {
    model.upstreamModelId = 'changed-current-model';
    assert.deepEqual(Materialize(p), before);
    assert.notDeepEqual(Materialize(CompilePlan(input())).bytes, before.bytes);
  } finally { model.upstreamModelId = saved; }
});

test('request changes invalidate the frozen plan and revisions fail closed', () => {
  for (const change of [p => { p.fields.prompt = 'different'; }, p => { p.path = '/other'; }, p => { p.adapterRevision = 'new'; }, p => { p.fields.model = 'other-account-model'; }]) {
    const p = CompilePlan(input()); change(p);
    assert.throws(() => Materialize(p));
  }
});

test('asset ownership, field rules and immutable bytes still use the existing builder', () => {
  const bytes = Uint8Array.from([1,2,3]);
  const asset = makeVerifiedAssetReceipt({ownerId:'1',type:'image',mimeType:'image/png',size:3,bytes});
  const p = CompilePlan({...input(),assets:[asset]});
  bytes[0] = 9;
  assert.deepEqual(Materialize(p).bytes, buildVideoRequestBytes({...input(),assets:[asset]}));
  assert.throws(() => CompilePlan({...input(),ownerId:'2',assets:[asset]}));
  assert.throws(() => CompilePlan({...input(),duration:6}));
  assert.throws(() => CompilePlan({...input(),apiKey:'not-permitted'}));
});
