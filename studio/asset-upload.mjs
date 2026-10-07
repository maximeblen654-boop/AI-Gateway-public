export const MAX_ASSET_BYTES = 100_000_000;

export async function uploadLocalAsset(file, kind, { send = fetch, digest = bytes => crypto.subtle.digest('SHA-256', bytes), signal } = {}) {
  if (!['image', 'video', 'audio'].includes(kind) ||
      !Number.isSafeInteger(file?.size) || file.size < 8 || file.size > MAX_ASSET_BYTES ||
      typeof file.type !== 'string' || !/^(image|video|audio)\/[a-z0-9.+-]+$/.test(file.type) ||
      !file.type.startsWith(`${kind}/`) || typeof file.arrayBuffer !== 'function') {
    throw new Error('invalid_local_asset');
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength !== file.size) throw new Error('file_changed');
  const hash = Array.from(new Uint8Array(await digest(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('hash_unavailable');
  const response = await send('/studio/api/assets/uploads', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': file.type, 'X-Studio-Request': 'asset-intake-v1',
      'X-Studio-Asset-Kind': kind, 'X-Content-SHA256': hash },
    body: bytes,
  });
  if (response.status === 401) throw new Error('login_required');
  if (!response.ok) throw new Error('asset_upload_failed');
  const receipt = await response.json();
  if (!/^asset_[a-f0-9-]{36}$/.test(receipt?.asset_ref || '') ||
      receipt.kind !== kind || receipt.mime_type !== file.type || receipt.size !== file.size ||
      (receipt.duration_seconds !== null &&
        (!Number.isFinite(receipt.duration_seconds) || receipt.duration_seconds <= 0))) {
    throw new Error('invalid_asset_receipt');
  }
  return receipt;
}
