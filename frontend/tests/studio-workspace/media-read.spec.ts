import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const video = fileURLToPath(new URL('./retention-video.mp4', import.meta.url))
const cover = fileURLToPath(new URL('./retention-cover.jpg', import.meta.url))
const id = 'op_' + '6'.repeat(64)
const price = { amount: '1', currency: 'CNY', billing_mode: 'per_request' }
async function open(page: Page) {
  const state = { session: true, playbackFailure: false, expired: false, exchanges: 0, originals: [] as string[], covers: 0, businessPosts: [] as string[] }
  await page.addInitScript(({ id, price }) => {
    sessionStorage.setItem('studio-media-view-9001', JSON.stringify({ kind: 'video', view: 'compose' }))
    sessionStorage.setItem('studio-visual-fixture-media-read', JSON.stringify({ image: [], video: [{ contract: 'account_video_v1', operation_id: id, status: 'completed', created_at: '2026-10-24T00:00:00Z', expires_at: '2026-10-24T01:00:00Z', offer_id: 'video-standard', model: '合成视频', spec: { resolution: '720p', aspect_ratio: '16:9', duration_seconds: 5, count: 1 }, quantity: 1, sale_price: price, unit_price: price, billing_state: 'billed', result_retention: { policy: 'video_original_48h', persisted_at: '2026-10-24T00:00:00Z', expires_at: '2099-01-01T00:00:00Z', expired: false } }] }))
  }, { id, price })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  page.on('request', request => { if (request.method() === 'POST' && !request.url().endsWith('/session/exchange')) state.businessPosts.push(request.url()) })
  await page.route('**/studio-v2/api/session', route => route.fulfill({ status: state.session ? 200 : 401, contentType: 'application/json', body: JSON.stringify(state.session ? { owner_id: 9001 } : { error: 'session_required' }) }))
  await page.route('**/studio-v2/api/session/exchange', route => { state.session = true; state.exchanges++; return route.fulfill({ contentType: 'application/json', body: '{"owner_id":9001}' }) })
  await page.route('**/studio-v2/api/video/operations/*/cover', route => { state.covers++; return route.fulfill({ path: cover, contentType: 'image/jpeg' }) })
  await page.route('**/studio-v2/api/video/operations/*/original', route => {
    const method = route.request().method(); state.originals.push(method)
    if (!state.session) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"video_session_required"}' })
    if (state.expired) return route.fulfill({ status: 410, contentType: 'application/json', body: '{"error":"video_result_expired"}' })
    if (state.playbackFailure && method !== 'HEAD') return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary"}' })
    return method === 'HEAD' ? route.fulfill({ contentType: 'video/mp4', body: '' }) : route.fulfill({ path: video, contentType: 'video/mp4' })
  })
  await page.goto('/tests/studio-workspace/index.html?scenario=media-read')
  const card = page.locator(`[data-task-id="${id}"]`)
  await card.scrollIntoViewIfNeeded()
  await expect(card.getByTestId('studio-video-cover-image')).toBeVisible()
  expect(state.originals).toEqual([])
  return { state, card }
}

for (const width of [1440, 390]) test(`small covers and expired-session playback recovery ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
  const { state, card } = await open(page)
  expect(state.covers).toBeGreaterThan(0)
  state.session = false
  await card.click()
  await expect(page.getByTestId('studio-result-video')).toHaveJSProperty('readyState', 4)
  expect(state.exchanges).toBe(1)
  expect(state.originals).toContain('HEAD')
  await expect(page.getByTestId('studio-download')).toHaveCount(1)
  await expect(page.locator('.studio-results')).not.toContainText('过期')
  expect(state.businessPosts).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.getByTestId('studio-result-video').scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath(`session-recovered-${width}.png`), fullPage: true })
})

test('a second playback failure offers bounded manual retry and keeps download available', async ({ page }, info) => {
  const { state, card } = await open(page)
  state.playbackFailure = true
  await card.click()
  await expect(page.getByTestId('studio-result-retry-1')).toBeVisible()
  const attempts = state.originals.filter(method => method === 'GET').length
  expect(attempts).toBe(2)
  await expect(page.getByTestId('studio-download')).toHaveCount(1)
  await expect(page.locator('.studio-results')).toContainText('原片加载失败，请重试')
  await expect(page.locator('.studio-results')).not.toContainText('过期')
  await page.screenshot({ path: info.outputPath('retry-with-download-1440.png'), fullPage: true })
  state.playbackFailure = false
  await page.getByTestId('studio-result-retry-1').click()
  await expect(page.getByTestId('studio-result-video')).toHaveJSProperty('readyState', 4)
  await expect(page.getByTestId('studio-result-retry-1')).toHaveCount(0)
  expect(state.businessPosts).toEqual([])
})

test('server-confirmed expiry removes the video and download while keeping completed task status', async ({ page }) => {
  const { state, card } = await open(page)
  state.expired = true
  await card.click()
  await expect(page.locator('.studio-results')).toContainText('原片已到期')
  await expect(page.getByTestId('studio-result-video')).toHaveCount(0)
  await expect(page.getByTestId('studio-download')).toHaveCount(0)
  await expect(page.getByTestId('studio-status')).toContainText('生成完成')
  expect(state.businessPosts).toEqual([])
})
