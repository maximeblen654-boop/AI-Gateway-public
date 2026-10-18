export type ImageExportFormat = 'png' | 'jpeg' | 'webp'
export const EXPORT_MAX_BYTES = 32 * 1024 * 1024
export const EXPORT_MAX_PIXELS = 32 * 1024 * 1024
const mimeTypes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const
let exporting = false

export async function exportOriginal(url: string, format: ImageExportFormat, signal: AbortSignal): Promise<Blob> {
  if (exporting) throw new Error('另一张图片正在转换，请完成后再试。')
  exporting = true
  try { return await convertImageBlob(await readExportOriginal(url, signal), format, signal) }
  finally { exporting = false }
}

// Only read the existing protected original endpoint. No recovery or generation calls.
export async function readExportOriginal(url: string, signal: AbortSignal): Promise<Blob> {
  let response: Response
  try { response = await fetch(url, { credentials: 'same-origin', cache: 'no-cache', redirect: 'error', signal }) }
  catch { throw new Error('原片读取失败，请检查网络后重试或下载原片。') }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(response.status === 401 || response.status === 403 ? '登录已失效或没有下载权限，请重新登录后再试。' : '原片无法读取，可能已过期，请检查原片下载。')
  }
  const mime = response.headers.get('content-type')?.split(';')[0] || ''
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
    await response.body?.cancel().catch(() => {})
    throw new Error('此原片格式暂不支持本地转换，请下载原片。')
  }
  if (Number(response.headers.get('content-length')) > EXPORT_MAX_BYTES || !response.body) {
    await response.body?.cancel()
    throw new Error('图片过大或浏览器不支持安全读取，请下载原片。')
  }
  const reader = response.body.getReader(), chunks: BlobPart[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > EXPORT_MAX_BYTES) throw new Error('图片超过32 MiB，本地转换已停止，请下载原片。')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  return new Blob(chunks, { type: mime })
}

export async function convertImageBlob(original: Blob, format: ImageExportFormat, signal?: AbortSignal): Promise<Blob> {
  if (original.size > EXPORT_MAX_BYTES) throw new Error('图片过大，请下载原片。')
  const image = new Image(), url = URL.createObjectURL(original)
  const canvas = document.createElement('canvas')
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { image.src = ''; reject(new Error('图片导出已取消。')) }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      image.onload = () => { cleanup(); resolve() }
      image.onerror = () => { cleanup(); reject(new Error('图片解码失败，请下载原片。')) }
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      image.src = url
    })
    const width = image.naturalWidth, height = image.naturalHeight
    if (!width || !height || width * height > EXPORT_MAX_PIXELS || width > 16384 || height > 16384) throw new Error('图片像素尺寸过大，本地转换已停止，请下载原片。')
    canvas.width = width; canvas.height = height
    const context = canvas.getContext('2d')
    if (!context || typeof canvas.toBlob !== 'function') throw new Error('浏览器不支持本地图片转换，请下载原片。')
    if (format === 'jpeg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height) }
    context.drawImage(image, 0, 0)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mimeTypes[format], 0.95))
    if (signal?.aborted) throw new Error('图片导出已取消。')
    if (!blob || blob.type !== mimeTypes[format]) throw new Error('浏览器不支持此导出格式，请选择其他格式或下载原片。')
    return blob
  } finally { URL.revokeObjectURL(url); image.src = ''; canvas.width = 0; canvas.height = 0 }
}

export function saveExport(blob: Blob, filename: string, format: ImageExportFormat): void {
  const url = URL.createObjectURL(blob), link = document.createElement('a')
  link.href = url; link.download = `${filename}.${format === 'jpeg' ? 'jpg' : format}`
  document.body.appendChild(link); link.click(); link.remove()
  // Let the browser consume the download before releasing the local object URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
