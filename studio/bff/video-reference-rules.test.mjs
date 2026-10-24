import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceImageMinSide, withVideoReferenceRules } from './video-reference-rules.mjs';
import { createVideoAssetResolver } from './video-assets.mjs';

const seedance = { offer_id: 'frozen-offer', model: 'customer-alias', video_profile: {
  inputMode: 'image2pro', image2pro: { protocol: 'seedance2-video' },
  documentedStatus: 'enabled', mediaLimits: { Image: 9, Video: 0, Audio: 0, Total: 9 },
} };

test('catalog binds the requirement to the resolved protocol and preserves offer identity', () => {
  const other = { ...seedance, model: 'Seedance2.0', video_profile: { ...seedance.video_profile, image2pro: { protocol: 'agnes-video' } } };
  assert.equal(referenceImageMinSide(seedance), 300);
  assert.equal(referenceImageMinSide(other), 0);
  const result = withVideoReferenceRules({ offers: [seedance, other], revision: 'published' });
  assert.equal(result.offers[0].reference_image_min_side, 300);
  assert.equal(result.offers[0].offer_id, seedance.offer_id);
  assert.equal(result.offers[1], other);
  assert.equal(seedance.reference_image_min_side, undefined);
});

for (const size of [{ width: 278, height: 270 }, { width: 900, height: 299 }, { width: undefined, height: 500 }]) {
  test(`stored image ${size.width}x${size.height} is rejected before reference preparation`, async () => {
    let preparations = 0;
    const resolve = createVideoAssetResolver({
      intake: { uploadPayload: () => ({ ...size, kind: 'image', size: 8, bytes: Buffer.alloc(8) }) },
      tasks: { catalog: async () => ({ offers: [seedance] }), prepareReferences: () => { preparations++; } },
    });
    await assert.rejects(() => resolve({ ownerId: 7 }, [{ kind: 'image', asset_ref: 'private' }],
      seedance.offer_id, seedance.model, {}, { prepare: true }), /reference_image_(too_small|dimensions_unavailable)/);
    assert.equal(preparations, 0);
  });
}

test('a client cannot remove the bound size rule by omitting the projected hint', () => {
  assert.equal(referenceImageMinSide({ ...seedance, reference_image_min_side: 0 }), 300);
});
