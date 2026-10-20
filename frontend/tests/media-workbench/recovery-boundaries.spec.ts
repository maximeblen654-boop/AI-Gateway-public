import { test, expect, type Page } from '@playwright/test'
import type { SupplierDetail } from '../../src/api/admin/mediaWorkbench'

type Call = { method: string; url: string; input: unknown }
type Fixture = {
  snapshot: () => SupplierDetail; calls: Call[]; releaseSuppliers: () => void; releasePaidCheck: () => void
}
const fixture = (page: Page) => page.evaluate(() => {
  const value = (window as unknown as { mediaFixture: Fixture }).mediaFixture
  return { snapshot: value.snapshot(), calls: value.calls }
})
async function openEditor(page: Page) {
  await page.getByTestId('account-search').fill('#77')
  await page.getByTestId('supplier-77').click()
  await page.getByTestId('model-video-model').click()
  await page.getByTestId('wizard-step-4').click()
}
async function restoreConflict(page: Page) {
  await page.goto('/tests/media-workbench/index.html?scenario=VIDEO_POLISH&seedVideoConflict=1')
  await openEditor(page)
  await expect(page.getByTestId('draft-recovery')).toBeVisible()
  await page.getByTestId('restore-recovery').click()
  await expect(page.getByTestId('video-sale-4')).toHaveValue('12.')
  await page.getByTestId('video-sale-4').fill('12.50')
  await page.getByTestId('video-sale-4').press('Enter')
  await expect(page.getByTestId('video-sale-conflict').filter({ has: page.getByText('720p', { exact: false }) }).first()).toBeVisible()
}
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
})
for (const width of [1440, 390]) {
  test(`single sale conflict ${width}: explicit re-adopt or discard preserves other raw values and saved prices`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await restoreConflict(page)
    const before = await fixture(page)
    const row = page.getByTestId('video-sale-conflict').filter({ has: page.getByTestId('readopt-sale-input') }).first()
    await row.getByTestId('readopt-sale-input').click()
    const dialog = page.getByRole('dialog', { name: '确认按当前规格重新采用' })
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('confirm-readopt-sale-input')).toBeInViewport()
    await expect(page.getByTestId('sale-original-price')).toContainText('1 CNY')
    await expect(page.getByTestId('sale-current-price')).toContainText('3 CNY')
    await expect(page.getByTestId('sale-adopted-price')).toContainText('12.50 CNY')
    await page.screenshot({ path: info.outputPath(`sale-conflict-${width}.png`), animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('video-sale-4')).toHaveValue('12.50')
    expect((await fixture(page)).snapshot).toEqual(before.snapshot)
    await row.getByTestId('readopt-sale-input').click()
    await page.getByTestId('confirm-readopt-sale-input').click()
    await expect(page.getByTestId('video-sale-4')).toHaveValue('12.50')
    await expect(page.getByTestId('video-sale-5')).toHaveValue('23.')
    const remaining = page.getByTestId('video-sale-conflict')
    // Its source price still matches, so there is no conflict action: finish it
    // with a valid number, preserving the per-entry re-adopted result.
    await expect(remaining).toHaveCount(0)
    await page.getByTestId('video-sale-5').fill('23.50')
    await page.getByTestId('video-sale-5').press('Enter')
    await expect(page.getByTestId('autosave-status')).toContainText('已确认保存')
    const after = await fixture(page)
    expect(after.snapshot.media_workbench_v1!.draft.products[0]!.pricing_rules.some(rule => rule.match.duration_seconds?.includes(4) && rule.sale_price?.amount === '12.50')).toBe(true)
    expect(after.snapshot.media_workbench_v1!.published).toEqual(before.snapshot.media_workbench_v1!.published)
    expect(after.snapshot.media_workbench_v1!.sales).toEqual(before.snapshot.media_workbench_v1!.sales)
    expect(after.calls.filter(call => call.method !== 'get').every(call => call.method === 'put' && call.url === '/admin/media-workbench/accounts/77/draft')).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.getByTestId('video-sale-tools').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`sale-resolved-${width}.png`), animations: 'disabled' })
  })
  test(`paid preflight ${width}: waits for loaded suppliers, then preserves stable passing report`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto('/tests/media-workbench/index.html?holdSuppliers=1&holdPaidCheck=1')
    const panel = page.getByTestId('paid-video')
    await expect(panel).toContainText('供应商列表仍在读取')
    await expect(panel.getByRole('button', { name: '开启前检查', exact: true })).toBeDisabled()
    expect((await fixture(page)).calls.filter(call => call.method !== 'get')).toHaveLength(0)
    await page.evaluate(() => (window as unknown as { mediaFixture: Fixture }).mediaFixture.releaseSuppliers())
    await expect(panel.getByRole('button', { name: '开启前检查', exact: true })).toBeEnabled()
    await panel.getByRole('button', { name: '开启前检查', exact: true }).click()
    await expect(panel).toContainText('正在执行完整检查')
    await page.evaluate(() => (window as unknown as { mediaFixture: Fixture }).mediaFixture.releasePaidCheck())
    await expect(panel).toContainText('检查通过，开启时服务端将再次核对')
    await expect(panel.getByRole('button', { name: '开启视频', exact: true })).toBeEnabled()
    await expect(panel).not.toContainText('检查结果已失效')
    expect((await fixture(page)).calls.filter(call => call.method !== 'get').map(call => call.url)).toEqual(['/admin/media-workbench/paid-controls/video/check'])
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`preflight-stable-${width}.png`), animations: 'disabled' })
  })
}

test('discard one conflicting raw input without changing any saved sale or another raw input', async ({ page }) => {
  await restoreConflict(page)
  const before = await fixture(page)
  const conflict = page.getByTestId('video-sale-conflict')
  await conflict.getByTestId('discard-sale-input').click()
  await expect(page.getByTestId('video-sale-4')).toHaveValue('3')
  await expect(page.getByTestId('video-sale-5')).toHaveValue('23.')
  expect((await fixture(page)).snapshot).toEqual(before.snapshot)
  expect((await fixture(page)).calls.filter(call => call.method !== 'get')).toHaveLength(0)
})
