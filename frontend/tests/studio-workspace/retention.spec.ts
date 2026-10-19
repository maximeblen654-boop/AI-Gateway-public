import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const id = (kind: 'image' | 'video', n: number) => (kind === 'image' ? 'img_' : 'op_') + n.toString(16).padStart(kind === 'image' ? 32 : 64, '0')
const videoFixture = fileURLToPath(new URL('./retention-video.mp4', import.meta.url))
async function open(page: Page, scenario = 'retention') {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.route('**/studio-v2/api/video/operations/*/original', route => route.fulfill({ path: videoFixture, contentType: 'video/mp4' }))
  await page.clock.setFixedTime(new Date('2026-10-19T00:00:00Z'))
  await page.goto(`/tests/studio-workspace/index.html?scenario=${scenario}`)
  await expect(page.getByTestId('studio-history')).toBeVisible()
  await page.getByTestId('studio-mode-history').click()
}
async function select(page: Page, kind: 'image' | 'video', n: number) {
  await page.locator(`[data-task-id="${id(kind, n)}"]`).click()
  await expect(page.getByTestId('studio-task-id')).toContainText(id(kind, n))
  await page.getByTestId('studio-result-retention').scrollIntoViewIfNeeded()
}
async function noOriginalControls(page: Page) {
  await expect(page.locator('.studio-results img,.studio-results video,[data-testid="studio-download"],.image-export')).toHaveCount(0)
  await expect(page.getByTestId('studio-status')).toContainText('生成完成')
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) test(`real original retention, legacy promises and expiry ${viewport.width}`, async ({ page }, info) => {
  await page.setViewportSize(viewport)
  const originalRequests: string[] = []
  page.on('request', request => { if (/\/studio-v2\/api\/(image|video)\/(tasks|operations)\/.*\/(results\/\d+|original)/.test(request.url())) originalRequests.push(request.url()) })
  await open(page)
  await expect(page.getByText('新图片原片保留72小时，新视频原片保留48小时，请及时下载；历史作品以服务端提供的到期时间为准。')).toBeVisible()
  await select(page, 'image', 1)
  await expect(page.getByTestId('studio-result-retention')).toContainText('2026/10/22')
  await expect(page.getByTestId('studio-result-image')).toHaveCount(4)
  await expect(page.getByTestId('studio-result-image').first()).toHaveJSProperty('complete', true)
  await page.screenshot({ path: info.outputPath(`image-72h-${viewport.width}.png`), fullPage: true })
  await select(page, 'image', 2)
  await expect(page.getByTestId('studio-result-retention')).toContainText('历史7天保留')
  await expect(page.getByTestId('studio-result-retention')).toContainText('2026/10/21')
  await expect(page.getByTestId('studio-download')).toHaveCount(4)
  await page.screenshot({ path: info.outputPath(`image-legacy-7d-${viewport.width}.png`), fullPage: true })
  await select(page, 'image', 3)
  await expect(page.getByTestId('studio-result-retention')).toContainText('原片已到期')
  await noOriginalControls(page)
  await expect(page.locator('.studio-results figure')).toHaveCount(4)
  await expect(page.getByTestId('studio-settlement')).toContainText('2.80 CNY')
  await page.screenshot({ path: info.outputPath(`image-expired-${viewport.width}.png`), fullPage: true })
  expect(originalRequests.some(url => url.includes(id('image', 3)))).toBe(false)

  await select(page, 'video', 4)
  await expect(page.getByTestId('studio-result-retention')).toContainText('2026/10/21')
  await expect(page.getByTestId('studio-result-video')).toHaveJSProperty('readyState', 4)
  await expect(page.locator('.studio-result-loading')).toHaveCount(0)
  await expect(page.getByTestId('studio-download')).toHaveCount(1)
  await page.screenshot({ path: info.outputPath(`video-48h-${viewport.width}.png`), fullPage: true })
  await select(page, 'video', 5)
  await expect(page.getByTestId('studio-result-retention')).toHaveText('原片保留期限：服务端未提供具体到期时间。')
  await expect(page.getByTestId('studio-result-video')).toHaveCount(1)
  await page.screenshot({ path: info.outputPath(`video-legacy-unknown-${viewport.width}.png`), fullPage: true })
  await select(page, 'video', 6)
  await expect(page.getByTestId('studio-result-retention')).toContainText('原片已到期')
  await noOriginalControls(page)
  await expect(page.locator('.studio-results figure')).toHaveCount(1)
  await page.screenshot({ path: info.outputPath(`video-expired-${viewport.width}.png`), fullPage: true })
  expect(originalRequests.some(url => url.includes(id('video', 6)))).toBe(false)
  expect(await page.evaluate(() => (window as any).studioFixture.calls.filter((call: any) => call.method === 'POST'))).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
})

test('the existing clock removes originals at their deadline without a new media request', async ({ page }, info) => {
  await open(page, 'retention-boundary')
  await select(page, 'image', 1)
  await expect(page.getByTestId('studio-download')).toHaveCount(4)
  const requestsAfterExpiry: string[] = []
  page.on('request', request => { if (request.url().includes(id('image', 1)) && request.url().includes('/results/')) requestsAfterExpiry.push(request.url()) })
  await page.clock.setFixedTime(new Date('2026-10-19T00:00:10Z'))
  await expect(page.getByTestId('studio-result-retention')).toContainText('原片已到期')
  await noOriginalControls(page)
  await page.getByTestId('studio-refresh').click()
  await noOriginalControls(page)
  expect(requestsAfterExpiry).toHaveLength(0)
  await page.screenshot({ path: info.outputPath('image-expiry-boundary.png'), fullPage: true })
})
