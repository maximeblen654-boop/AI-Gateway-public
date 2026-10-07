import { createLocalAssetStore } from './asset-store.mjs';

const MEDIA_KINDS = new Set(['image', 'video', 'audio']);
const MAX_UPLOAD_BYTES = 100_000_000;
const SHA256 = /^[a-f0-9]{64}$/;
const MIME = /^(image|video|audio)\/[a-z0-9.+-]+$/;

export function createAssetIntake({ rootDir, ffprobePath = 'ffprobe' } = {}) {
  const store = createLocalAssetStore({ rootDir, ffprobePath });
  return Object.freeze({
    maxBytes: MAX_UPLOAD_BYTES,
    async save({ ownerId, kind, mimeType, sha256, bytes }) {
      if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !MEDIA_KINDS.has(kind) ||
          typeof mimeType !== 'string' || !MIME.test(mimeType) || !mimeType.startsWith(`${kind}/`) ||
          typeof sha256 !== 'string' || !SHA256.test(sha256) || !(bytes instanceof Uint8Array) ||
          bytes.byteLength < 8 || bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw new Error('invalid_asset_input');
      }
      return store.put({ ownerId, kind, mimeType, sha256, bytes });
    },
    inlineReceipt(ownerId, assetRef) {
      return store.inlineReceipt(ownerId, assetRef);
    },
    uploadPayload(ownerId, assetRef) {
      return store.uploadPayload(ownerId, assetRef);
    },
  });
}

export const assetIntakeContract = Object.freeze({
  version: 'studio_asset_intake_v1',
  maxBytes: MAX_UPLOAD_BYTES,
  kinds: [...MEDIA_KINDS],
});
