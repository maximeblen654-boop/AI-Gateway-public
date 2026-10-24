export interface StudioImageDimensions { width: number; height: number }

// This convenience action is deliberately bounded to small reference images.
// Limits apply before decoding and again to the output, including long thin images.
const MAX_PIXELS = 4_000_000
const MAX_SIDE = 16_384
const MAX_BYTES = 15_000_000
const MAX_SCALE = 4

export function studioImageAdaptedSize(size: StudioImageDimensions, minSide: number): StudioImageDimensions {
  const { width, height } = size
  if (![width, height, minSide].every(value => Number.isSafeInteger(value) && value > 0) ||
      width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS || minSide > 4096) throw new Error('image_adaptation_limit')
  const scale = Math.max(1, minSide / Math.min(width, height))
  const target = { width: Math.ceil(width * scale), height: Math.ceil(height * scale) }
  if (scale > MAX_SCALE || target.width > MAX_SIDE || target.height > MAX_SIDE || target.width * target.height > MAX_PIXELS) throw new Error('image_adaptation_limit')
  return target
}

export async function adaptStudioImage(file: File, size: StudioImageDimensions, minSide: number, signal: AbortSignal): Promise<File> {
  studioImageAdaptedSize(size, minSide)
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size >= MAX_BYTES) throw new Error('image_adaptation_limit')
  if (typeof createImageBitmap !== 'function') throw new Error('image_adaptation_unsupported')
  signal.throwIfAborted()
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  try {
    signal.throwIfAborted()
    // EXIF orientation may exchange the axes, but cannot change the pixel count.
    if (bitmap.width * bitmap.height !== size.width * size.height ||
        Math.min(bitmap.width, bitmap.height) !== Math.min(size.width, size.height)) throw new Error('image_adaptation_changed')
    const target = studioImageAdaptedSize(bitmap, minSide)
    canvas.width = target.width
    canvas.height = target.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('image_adaptation_unsupported')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, target.width, target.height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value =>
      value ? resolve(value) : reject(new Error('image_adaptation_failed')), 'image/png'))
    signal.throwIfAborted()
    if (blob.type !== 'image/png' || blob.size < 8 || blob.size >= MAX_BYTES) throw new Error('image_adaptation_limit')
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-适配.png`, { type: 'image/png' })
  } finally {
    bitmap.close()
    canvas.width = canvas.height = 0
  }
}
