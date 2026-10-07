export interface StudioAssetReceipt {
  asset_ref: string
  kind: 'image' | 'video' | 'audio'
  mime_type: string
  size: number
  duration_seconds: number | null
}

const MAX_ASSET_BYTES = 100_000_000
const ASSET_REF = /^asset_[a-f0-9-]{36}$/

function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest('SHA-256', bytes).then(value =>
    Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join(''),
  )
}

export async function uploadStudioAsset(file: File, kind: StudioAssetReceipt['kind'], signal?: AbortSignal): Promise<StudioAssetReceipt> {
  if (!['image', 'video', 'audio'].includes(kind) || file.size < 8 || file.size > MAX_ASSET_BYTES ||
      !file.type.startsWith(`${kind}/`)) throw new Error('invalid_local_asset')
  const bytes = await file.arrayBuffer()
  if (bytes.byteLength !== file.size) throw new Error('file_changed')
  const sha256 = await sha256Hex(bytes)
  const response = await fetch('/studio/api/assets/uploads', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', signal,
    headers: { 'Content-Type': file.type, 'X-Studio-Request': 'asset-intake-v1', 'X-Studio-Asset-Kind': kind, 'X-Content-SHA256': sha256 },
    body: bytes,
  })
  if (response.status === 401) throw new Error('login_required')
  if (!response.ok) throw new Error('asset_upload_failed')
  const receipt = await response.json() as Partial<StudioAssetReceipt>
  if (!ASSET_REF.test(receipt.asset_ref || '') || receipt.kind !== kind || receipt.mime_type !== file.type || receipt.size !== file.size ||
      (receipt.duration_seconds !== null && (!Number.isFinite(receipt.duration_seconds) || (receipt.duration_seconds || 0) <= 0))) {
    throw new Error('invalid_asset_receipt')
  }
  return receipt as StudioAssetReceipt
}
