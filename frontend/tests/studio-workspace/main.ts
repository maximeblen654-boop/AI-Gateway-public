// Isolated visual fixture: all media API traffic terminates here. Never imported by the app.
import { createApp } from 'vue'
import VideoStudioView from '@/views/user/VideoStudioView.vue'
import { apiClient } from '@/api/client'
import '@/style.css'
import '@/styles/site-theme.css'
const q = new URLSearchParams(location.search)
const scenario = q.get('scenario') || 'gallery'
document.documentElement.classList.toggle('dark', q.get('theme') === 'dark')
const price = (amount: string) => ({ amount, currency: 'CNY', billing_mode: 'per_request' })
const references = { image: { min: 0, max: 3 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 3 }
const imageOffers = [
  { offer_id: 'image-standard', model: 'studio-image', display_name: 'GPT Image 2', upstream_model: 'configured-image', spec: { resolution: ['1K', '2K', '4K'], aspect_ratio: ['1:1', '3:4', '4:3', '16:9', '9:16'], count: { min: 1, max: 10 }, references } },
  { offer_id: 'image-limited', model: 'studio-image-other', display_name: '轻绘 · 标准', upstream_model: 'configured-image-other', spec: { resolution: ['1K'], aspect_ratio: ['1:1', '3:4'], count: { min: 1, max: 3 }, references: { ...references, image: { min: 0, max: 0 }, total_max: 0 } } },
]
const videoOffers = [{ offer_id: 'video-standard', model: 'studio-video', display_name: '映像 · 视频', upstream_model: 'configured-video', spec: { resolution: ['720p', '1080p'], aspect_ratio: ['16:9', '9:16'], duration_seconds: [5, 10], count: { min: 1, max: 1 }, references } }]
// Stress only the layout; synthetic option labels are not supplier capability claims.
if (scenario === 'many-options') {
 Object.assign(imageOffers[0]!.spec, {resolution:Array.from({length:20},(_,i)=>`规格 ${i+1}`),quality:Array.from({length:20},(_,i)=>`画质 ${i+1}`)})
 videoOffers[0]!.spec.duration_seconds=Array.from({length:20},(_,i)=>i+1)
}
type Raw = Record<string, any> // Fixture deliberately emits the HTTP contract, not StudioTask.
function task(kind: string, index: number, status = 'completed'): Raw { return { contract: kind === 'image' ? 'published_image_binding_v1' : 'account_video_v1', [kind === 'image' ? 'task_id' : 'operation_id']: (kind === 'image' ? 'img_' : 'op_') + index.toString(16).padStart(kind === 'image' ? 32 : 64, '0'), status, created_at: `2026-10-${14-index%3}T04:00:00Z`, expires_at: '2099-01-01T00:00:00Z', offer_id: kind === 'image' ? 'image-standard' : 'video-standard', model: kind === 'image' ? 'GPT Image 2' : '映像 · 视频', spec: { resolution: kind === 'image' ? '2K' : '720p', aspect_ratio: kind === 'image' ? '3:4' : '16:9', count: kind === 'image' ? 4 : 1, ...(kind === 'video' ? { duration_seconds: 5 } : {}) }, quantity: kind === 'image' ? 4 : 1, sale_price: price(kind === 'image' ? '2.80' : '2.00'), unit_price: price(kind === 'image' ? '0.70' : '2.00'), delivered_count: status === 'completed' ? (kind === 'image' ? 4 : 1) : 0, billing_state: status === 'completed' ? 'billed' : 'pending', ...(status === 'completed' ? { settled_price: price(kind === 'image' ? '2.80' : '2.00') } : {}) } }
const initial: Record<string, Raw[]> = { image: scenario === 'empty' ? [] : [task('image', 1), task('image', 2), task('image', 3)], video: [] }
if (scenario === 'partial') { initial.image = [{ ...task('image', 1, 'partial'), spec: { resolution: '2K', aspect_ratio: '3:4', count: 5 }, quantity: 5, sale_price: price('3.50'), expected_count: 5, delivered_count: 2, failed_count: 3, pending_count: 0, billing_state: 'billed', settled_price: price('1.40') }] }
if (scenario === 'unknown') initial.image = [task('image', 1, 'unknown')]
const cacheKey = `studio-visual-fixture-${scenario}`
const db: Record<string, Raw[]> = JSON.parse(sessionStorage.getItem(cacheKey) || 'null') || initial
const persist = () => sessionStorage.setItem(cacheKey, JSON.stringify(db))
const calls: { method: string; path: string; body?: unknown }[] = []
Object.assign(window, { studioFixture: { calls, snapshot: () => structuredClone(db) } })
apiClient.defaults.adapter = async config => {
  if (config.url !== '/auth/me') throw new Error(`Unexpected auth request ${config.url}`)
  return { config, status: 200, statusText: 'OK', headers: {}, data: { code: 0, data: { id: 9001 } } }
}
function original(index: number) { const palette = [['#f3e9d5', '#704431'], ['#cad0bc', '#303c2b'], ['#d4a789', '#633b2c']][index%3]!; return `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="900" viewBox="0 0 780 900"><rect width="780" height="900" fill="${palette[0]}"/><circle cx="530" cy="230" r="160" fill="${palette[1]}" opacity=".09"/><text x="60" y="122" fill="${palette[1]}" font-family="Georgia,serif" font-size="26" letter-spacing="8">DAYLIGHT COFFEE</text><text x="57" y="280" fill="${palette[1]}" font-family="Georgia,serif" font-size="100">Slow down.</text><path d="M185 420h360v125q0 120-180 120T185 545Z" fill="${palette[1]}"/><path d="M535 445h48a60 60 0 0 1 0 120h-60" fill="none" stroke="${palette[1]}" stroke-width="25"/><ellipse cx="364" cy="421" rx="180" ry="32" fill="${palette[1]}"/><ellipse cx="364" cy="419" rx="155" ry="22" fill="${palette[0]}" opacity=".65"/><path d="M210 711h320" stroke="${palette[1]}" stroke-width="5"/><text x="60" y="810" fill="${palette[1]}" font-family="sans-serif" font-size="20" letter-spacing="4">A LITTLE ROOM TO BREATHE.</text></svg>` }
let quoteSpec: Raw = {}
window.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.origin !== location.origin) throw new Error('Fixture prohibits external network')
  const path = url.pathname, method = init?.method || 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  calls.push({ method, path, body })
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  if (path.endsWith('/api/session')) return json({ owner_id: 9001 })
  if (path.endsWith('/assets/uploads')) return json({ asset_ref: 'asset_aaaaaaaa-0000-0000-0000-000000000000', kind: 'image', mime_type: new Headers(init?.headers).get('Content-Type'), size: (init?.body as ArrayBuffer).byteLength, duration_seconds: null })
  const match = /\/api\/(image|video)\/(.*)/.exec(path)
  if (!match) return json({ error: 'fixture_unexpected_path' }, 404)
  const [, kind, op] = match as [string, string, string]
  const items = db[kind]!
  if (op === 'catalog') return json({ offers: kind === 'image' ? imageOffers : videoOffers })
  if (op === 'readiness') return json({ paid_enabled: scenario !== 'closed' })
  if (op === 'tasks' && method === 'GET') return json({ tasks: items })
  if (op === 'operations') return json(items)
  if (op === 'quotes' && kind === 'image') { quoteSpec = body.spec; return json({ quote_token: 'isolated-fixed-quote' }) }
  if (op === 'prepare' || op === 'quotes') {
    const t = task(kind, 10, 'prepared')
    if (kind === 'image') { t.spec = quoteSpec; t.quantity = quoteSpec.count; t.sale_price = price((quoteSpec.count * .70).toFixed(2)); t.offer_id = body.offer_id || imageOffers[0]!.offer_id }
    else { t.spec = { resolution: body.resolution, aspect_ratio: body.ratio, duration_seconds: body.duration, count: 1 }; t.offer_id = body.offer_id }
    items.unshift(t); persist(); return json(t)
  }
  if (op === 'tasks' && method === 'POST') { const t = items.find(t => (t.task_id || t.operation_id) === (body.task_id || body.operation_id))!; t.status = scenario === 'unknown' ? 'unknown' : 'completed'; t.delivered_count = t.quantity; t.billing_state = 'billed'; t.settled_price = t.sale_price; persist(); return json(t) }
  const id = op.split('/')[1], t = items.find(t => (t.task_id || t.operation_id) === id)
  if (op.includes('/results/')) return new Response(original(parseInt(id!.slice(-2), 16)), { headers: { 'Content-Type': 'image/svg+xml' } })
  if (t) return json(t)
  return json({ error: 'fixture_not_found' }, 404)
}
// Element media loads don't use window.fetch. A service worker serves synthetic originals locally.
if ('serviceWorker' in navigator) {
  await navigator.serviceWorker.register('/tests/studio-workspace/sw.js', { scope: '/tests/studio-workspace/' })
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) await new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }))
  navigator.serviceWorker.controller!.postMessage({ originals: [original(0), original(1), original(2)] })
}
createApp(VideoStudioView).mount('#app')
