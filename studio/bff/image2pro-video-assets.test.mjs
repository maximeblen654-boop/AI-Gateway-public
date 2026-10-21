import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createVideoAssetResolver } from './video-assets.mjs';
import { CompilePublishedPlan, Materialize } from '../api/video-request-builder.mjs';

const owner = { ownerId: 7 };
const spec = { resolution: '720P', aspect_ratio: '16:9', duration_seconds: 5 };
function fixture() {
  const profile = { apiModelId: 'site-alias', upstreamModelId: 'public-model', documentedStatus: 'enabled',
    inputMode: 'image2pro', durationSeconds: [5], resolutions: ['720P'], ratios: ['16:9'],
    mediaLimits: { Image: 5, Video: 1, Audio: 3, Total: 9 },
    image2pro: { protocol: 'opaque-provider-tag', modes: ['text', 'reference'], max_images: 5,
      max_audio_references: 3, max_video_references: 1, supports_audio_reference: true,
      duration_min: 4, duration_max: 12, aspect_ratios: ['16:9'], size: '720P',
      reference_audio_max_bytes: 1_000_000, reference_video_max_bytes: 2_000_000 } };
  const blobs = Object.fromEntries(['image', 'audio', 'video'].map(kind => {
    const bytes = Buffer.from('private-' + kind);
    return [kind + '_asset', { kind, bytes, size: bytes.length, durationSeconds: kind === 'image' ? undefined : 3,
      mimeType: { image: 'image/png', audio: 'audio/mpeg', video: 'video/mp4' }[kind],
      sha256: createHash('sha256').update(bytes).digest('hex') }];
  }));
  let calls = 0, current;
  const intake = { uploadPayload(id, assetRef) { assert.equal(id, 7); assert(blobs[assetRef]); return blobs[assetRef]; } };
  const tasks = {
    catalog: async () => ({ offers: [{ offer_id: 'offer', model: 'site-alias', video_profile: profile }] }),
    prepareReferences: async (session, input) => {
      assert.equal(session.ownerId, 7); calls++;
      const metadata = input.assets.map(({ bytes_base64, ...rest }) => rest);
      current = { owner_id: session.ownerId, offer_id: input.offer_id, model: input.model,
        spec: input.spec, assets: metadata, result: { preparation_id: 'prepared-id',
          receipts: metadata.map(a => ({ ...a, source_kind: a.kind === 'image' ? 'inline' : 'media_id',
            ...(a.kind === 'image' ? {} : { media_id: 'bound-' + a.kind, expires_at: new Date(Date.now() + 3_600_000).toISOString() }) })) } };
      return current.result;
    },
    getPreparation(_session, id) { assert.equal(id, 'prepared-id'); return current; },
  };
  const resolve = createVideoAssetResolver({ intake, tasks });
  const refs = kinds => kinds.map(kind => ({ kind, asset_ref: kind + '_asset' }));
  const wire = assets => JSON.parse(Materialize(CompilePublishedPlan({ ownerId: '7', model: 'site-alias',
    prompt: 'synthetic', duration: 5, resolution: '720P', ratio: '16:9', assets }, profile)).bytes);
  return { profile, refs, resolve, wire, current: () => current, calls: () => calls };
}

test('Image2Pro BFF keeps private images inline while using prepared IDs for audio/video', async () => {
  const f = fixture(), requested = f.refs(['image', 'audio', 'video']);
  const prepared = await f.resolve(owner, requested, 'offer', 'site-alias', spec, { prepare: true });
  assert.equal(prepared.preparationId, 'prepared-id');
  const body = f.wire(prepared.assets);
  assert.deepEqual(body.images, ['data:image/png;base64,' + Buffer.from('private-image').toString('base64')]);
  assert.deepEqual(body.audios, [{ mediaId: 'bound-audio' }]);
  assert.deepEqual(body.videos, [{ mediaId: 'bound-video' }]);
  const reused = await f.resolve(owner, requested, 'offer', 'site-alias', spec, { preparationId: 'prepared-id' });
  assert.deepEqual(f.wire(reused.assets), body); assert.equal(f.calls(), 1);
});

test('Image2Pro no-reference path creates no preparation, while images-only preparation needs no mediaId', async () => {
  const f = fixture();
  assert.deepEqual(await f.resolve(owner, [], 'offer', 'site-alias', spec), []);
  assert.equal(f.calls(), 0);
  const prepared = await f.resolve(owner, f.refs(['image']), 'offer', 'site-alias', spec, { prepare: true });
  assert.equal(f.wire(prepared.assets).images.length, 1);
  assert.equal(f.current().result.receipts[0].media_id, undefined);
});

test('Image2Pro rejects missing, foreign, mismatched or expired preparations without quoting', async () => {
  const f = fixture(), requested = f.refs(['audio']);
  await assert.rejects(() => f.resolve(owner, requested, 'offer', 'site-alias', spec), /preparation_missing/);
  await f.resolve(owner, requested, 'offer', 'site-alias', spec, { prepare: true });
  await assert.rejects(() => f.resolve(owner, requested, 'other-offer', 'site-alias', spec, { preparationId: 'prepared-id' }), /unsupported_model/);
  await assert.rejects(() => f.resolve(owner, requested, 'offer', 'site-alias', { ...spec, duration_seconds: 6 }, { preparationId: 'prepared-id' }), /preparation_mismatch/);
  const saved = f.current().owner_id; f.current().owner_id = 8;
  await assert.rejects(() => f.resolve(owner, requested, 'offer', 'site-alias', spec, { preparationId: 'prepared-id' }), /preparation_mismatch/);
  f.current().owner_id = saved;
  f.current().result.receipts[0].expires_at = new Date(Date.now() - 1000).toISOString();
  await assert.rejects(() => f.resolve(owner, requested, 'offer', 'site-alias', spec, { preparationId: 'prepared-id' }), /expired/);
});

test('Image2Pro rejects forged source shapes and enforces capitalized Go limits before preparation', async () => {
  const f = fixture(), requested = f.refs(['video']);
  await f.resolve(owner, requested, 'offer', 'site-alias', spec, { prepare: true });
  f.current().result.receipts[0].source = 'https://unexpected.invalid/asset';
  await assert.rejects(() => f.resolve(owner, requested, 'offer', 'site-alias', spec, { preparationId: 'prepared-id' }), /preparation_mismatch/);
  const denied = fixture(); denied.profile.mediaLimits.Video = 0;
  await assert.rejects(() => denied.resolve(owner, denied.refs(['video']), 'offer', 'site-alias', spec, { prepare: true }), /limit/);
  assert.equal(denied.calls(), 0);
});
