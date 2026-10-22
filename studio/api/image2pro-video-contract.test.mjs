import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CompilePublishedPlan, Materialize, makeVerifiedAssetReceipt } from './video-request-builder.mjs';

// Independent assertions transcribed from the public 2026-10-19 REST contract.
// Never obtain the allowed request keys from the production builder/profile.
const allowed = new Set(['model', 'prompt', 'duration', 'ratio', 'images', 'audios', 'videos']);
function strictSupplier(body) {
  assert(Object.keys(body).every(key => allowed.has(key)));
  assert.equal(body.model, 'public-video-id');
  assert.equal(typeof body.prompt, 'string');
  assert.equal(body.duration, 5);
  assert.equal(body.ratio, '16:9');
  for (const image of body.images || []) assert.equal(typeof image, 'string');
  for (const field of ['audios', 'videos']) for (const reference of body[field] || []) {
    assert.deepEqual(Object.keys(reference), ['mediaId']);
    assert.equal(typeof reference.mediaId, 'string');
  }
  return { id: 'a'.repeat(24), status: 'processing', url: null };
}
const caps = () => ({ protocol: 'opaque-supplier-protocol', modes: ['text', 'reference'],
  max_images: 5, max_audio_references: 3, max_video_references: 1,
  supports_audio_reference: true, duration_min: 4, duration_max: 12,
  aspect_ratios: ['16:9', '9:16'], size: '720P',
  reference_audio_max_bytes: 1_000_000, reference_video_max_bytes: 5_000_000 });
const profile = () => ({ apiModelId: 'site-video-alias', upstreamModelId: 'public-video-id',
  documentedStatus: 'enabled', inputMode: 'image2pro', durationSeconds: [4, 5, 12],
  resolutions: ['720P'], ratios: ['16:9', '9:16'],
  mediaLimits: { image: 5, audio: 3, video: 1, total: 9 }, image2pro: caps() });
const input = () => ({ ownerId: '1', model: 'site-video-alias', prompt: 'Synthetic non-paid protocol test',
  duration: 5, resolution: '720P', ratio: '16:9', assets: [] });
const image = () => makeVerifiedAssetReceipt({ ownerId: '1', type: 'image', mimeType: 'image/png',
  size: 4, bytes: Buffer.from([137, 80, 78, 71]) });
const attachment = (type, extra = {}) => makeVerifiedAssetReceipt({ ownerId: '1', type,
  mimeType: type === 'audio' ? 'audio/mpeg' : 'video/mp4', size: 8,
  mediaId: 'verified-' + type, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), ...extra });

test('Image2Pro text request uses exact public ID, omits unsupported resolution, and survives serialization', () => {
  const plan = CompilePublishedPlan(input(), profile());
  const wire = Materialize(plan);
  assert.equal(wire.adapterRevision, 'core_image2pro_video_r1');
  assert.equal(wire.path, '/v1/videos');
  const body = JSON.parse(wire.bytes);
  assert.deepEqual(Object.keys(body).sort(), ['duration', 'model', 'prompt', 'ratio']);
  assert.equal(strictSupplier(body).status, 'processing');
  assert.equal(wire.requestHash, createHash('sha256').update(wire.bytes).digest('hex'));
  assert.deepEqual(Materialize(JSON.parse(JSON.stringify(plan))), wire);
});

test('Image2Pro mixed private media compiles image bytes and model-bound attachment IDs without Laoli fields', () => {
  const wire = Materialize(CompilePublishedPlan({ ...input(), assets: [image(), attachment('audio'), attachment('video')] }, profile()));
  const body = JSON.parse(wire.bytes);
  strictSupplier(body);
  assert.deepEqual(body.images, ['data:image/png;base64,iVBORw==']);
  assert.deepEqual(body.audios, [{ mediaId: 'verified-audio' }]);
  assert.deepEqual(body.videos, [{ mediaId: 'verified-video' }]);
  for (const forbidden of ['resolution', 'video_b64s', 'audio_b64s', 'references', 'content', 'size', 'mode', 'seed']) assert.equal(body[forbidden], undefined);
});

test('independent supplier contract rejects the formerly misrouted media protocol', () => {
  assert.throws(() => strictSupplier({ model: 'public-video-id', prompt: 'test', duration: 5,
    ratio: '16:9', video_b64s: ['data:video/mp4;base64,AA=='] }));
  assert.throws(() => strictSupplier({ model: 'public-video-id', prompt: 'test', duration: 5,
    ratio: '16:9', images: [{ image_url: 'data:image/png;base64,AA==' }] }));
});

test('unconfirmed or incompatible supplier capabilities fail before materialization', () => {
  for (const mutate of [p => { delete p.image2pro; }, p => { p.image2pro.protocol = ''; },
    p => { p.image2pro.size = '1080P'; }, p => { p.image2pro.duration_min = 6; },
    p => { p.image2pro.aspect_ratios = ['1:1']; }]) {
    const p = profile(); mutate(p); assert.throws(() => CompilePublishedPlan(input(), p));
  }
  assert.throws(() => CompilePublishedPlan({ ...input(), mode: 'keyframe' }, profile()));
  assert.throws(() => CompilePublishedPlan({ ...input(), resolution: '1080P' }, profile()));
});

test('Image2Pro material caps, ownership, expiration and per-kind byte limits are enforced', () => {
  const p = profile(); p.image2pro.max_images = 0;
  assert.throws(() => CompilePublishedPlan({ ...input(), assets: [image()] }, p));
  const denied = profile(); denied.image2pro.supports_audio_reference = false;
  assert.throws(() => CompilePublishedPlan({ ...input(), assets: [attachment('audio')] }, denied));
  const small = profile(); small.image2pro.reference_audio_max_bytes = 4;
  assert.throws(() => CompilePublishedPlan({ ...input(), assets: [attachment('audio')] }, small));
  assert.throws(() => CompilePublishedPlan({ ...input(), ownerId: 'another-owner', assets: [image()] }, profile()));
  assert.throws(() => attachment('audio', { expiresAt: new Date(Date.now() - 1).toISOString() }));
  const rawVideo = makeVerifiedAssetReceipt({ ownerId: '1', type: 'video', mimeType: 'video/mp4', size: 8, bytes: Buffer.alloc(8) });
  assert.throws(() => CompilePublishedPlan({ ...input(), assets: [rawVideo] }, profile()));
});

test('frozen Image2Pro plan cannot be silently changed to another model or protocol', () => {
  for (const mutate of [p => { p.fields.model = 'another-public-id'; }, p => { p.path = '/v1/videos/content'; },
    p => { p.adapterRevision = 'laoli_video_json_v136_r1'; }]) {
    const plan = CompilePublishedPlan(input(), profile()); mutate(plan);
    assert.throws(() => Materialize(plan));
  }
});

const seedanceObserved = JSON.parse(readFileSync(new URL('../../backend/internal/videoplan/testdata/image2pro_seedance2_video.json', import.meta.url), 'utf8'));
function seedanceProfile() {
  return { ...profile(), upstreamModelId: seedanceObserved.model,
    durationSeconds: [4, 5, 15], resolutions: ['supplier-default'],
    mediaLimits: { image: 9, audio: 3, video: 0, total: 12 },
    image2pro: { ...seedanceObserved.metadata, modes: ['reference', 'text'], max_images: 9,
      duration_min: 4, duration_max: 15, aspect_ratios: ['16:9', '9:16'], size: '',
      max_video_references: 0, reference_video_max_bytes: 0 } };
}
test('Seedance2 observed metadata uses one product label and documented wire fields', () => {
  assert.equal(seedanceObserved.metadata.size, undefined);
  assert.equal(seedanceObserved.metadata.modes, undefined);
  for (const duration of [4, 15]) {
    const plan = CompilePublishedPlan({ ...input(), resolution: 'supplier-default', duration,
      assets: [image(), attachment('audio')] }, seedanceProfile());
    const wire = Materialize(plan), body = JSON.parse(wire.bytes);
    assert.equal(body.model, seedanceObserved.model);
    assert.equal(body.duration, duration);
    assert.deepEqual(Object.keys(body).sort(), ['audios', 'duration', 'images', 'model', 'prompt', 'ratio']);
    assert.deepEqual(body.audios, [{ mediaId: 'verified-audio' }]);
    assert.deepEqual(Materialize(JSON.parse(JSON.stringify(plan))), wire);
  }
});
test('Seedance2 refuses ambiguous pricing labels and unsupported capability expansion', () => {
  const request = { ...input(), resolution: 'supplier-default' };
  for (const mutate of [p => { p.resolutions = ['supplier-default', '480P']; },
    p => { p.resolutions = []; }, p => { p.image2pro.size = '480P'; },
    p => { p.image2pro.duration_min = 3; }, p => { p.image2pro.duration_max = 30; },
    p => { p.image2pro.modes = ['keyframe']; }, p => { p.image2pro.aspect_ratios.push('1:1'); },
    p => { p.image2pro.max_video_references = 1; }, p => { p.image2pro.reference_video_max_bytes = 1; }]) {
    const p = seedanceProfile(); mutate(p);
    assert.throws(() => CompilePublishedPlan(request, p));
  }
  for (const change of [{ resolution: '480P' }, { resolution: 'SUPPLIER-DEFAULT' }, { duration: 3 },
    { duration: 16 }, { ratio: '1:1' }, { assets: [attachment('video')] }]) {
    assert.throws(() => CompilePublishedPlan({ ...request, ...change }, seedanceProfile()));
  }
  assert.throws(() => CompilePublishedPlan({ ...request, assets: [attachment('audio', { ownerId: 'other' })] }, seedanceProfile()));
});
