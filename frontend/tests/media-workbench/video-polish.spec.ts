import { test, expect, type Page } from '@playwright/test'
import type { SupplierDetail } from '../../src/api/admin/mediaWorkbench'

type Call = { method: string; url: string; input: Record<string, unknown> }
const snapshot = (page: Page) => page.evaluate(() => (window as unknown as { mediaFixture: { snapshot: () => SupplierDetail } }).mediaFixture.snapshot())
const calls = (page: Page) => page.evaluate(() => (window as unknown as { mediaFixture: { calls: Call[] } }).mediaFixture.calls)
async function openEditor(page: Page) {
  await page.getByTestId('account-search').fill('#77')
  await page.getByTestId('supplier-77').click()
  await page.getByTestId('model-video-model').click()
  await page.getByTestId('wizard-step-4').click()
}

for (const width of [1440, 1366, 390]) for (const mode of ['light', 'dark']) {
  test(`video polish ${width} ${mode}: buffered decimal, top tools, clear draft only and authoritative time`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1366 ? 650 : width === 390 ? 844 : 900 })
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.goto(`/tests/media-workbench/index.html?scenario=VIDEO_POLISH&mode=${mode}&theme=blue`)
    await openEditor(page)
    const before = (await snapshot(page)).media_workbench_v1!
    const editor = page.getByTestId('video-sale-editor')
    const price = page.getByTestId('video-sale-4')
    await expect(price).toHaveValue('1')
    await price.fill('')
    await price.pressSequentially('12.50', { delay: 20 })
    await expect(price).toHaveValue('12.50')
    // The incomplete edit is protected locally; no Product save per character.
    expect((await calls(page)).filter(call => call.url.endsWith('/draft'))).toHaveLength(0)
    await price.press('Enter')
    await expect(page.getByTestId('autosave-status')).toContainText('已确认保存')
    expect((await snapshot(page)).media_workbench_v1!.draft.products[0]!.pricing_rules.some(rule => rule.sale_price?.amount === '12.50')).toBe(true)
    await expect(page.getByTestId('video-sale-5')).toHaveValue('2')
    const tools = page.getByTestId('video-sale-tools')
    await tools.scrollIntoViewIfNeeded()
    const toolsBox = await tools.boundingBox(), firstBox = await price.boundingBox()
    expect(toolsBox!.y + toolsBox!.height).toBeLessThanOrEqual(firstBox!.y + 2)
    await page.screenshot({ path: info.outputPath(`video-prices-${width}-${mode}.png`), animations: 'disabled' })
    // Only blank cells in the current group are filled; manual prices survive.
    await price.fill('1'); await price.press('Enter')
    await page.getByTestId('arithmetic-preview').click()
    await expect(page.getByRole('dialog', { name: '确认按等差补齐售价' })).toBeVisible()
    await page.getByTestId('arithmetic-confirm').click()
    await expect(page.getByTestId('video-sale-6')).toHaveValue('3')
    await page.getByTestId('arithmetic-undo').click()
    await expect(page.getByTestId('video-sale-6')).toHaveValue('')
    await page.getByTestId('clear-video-sales').click()
    await expect(page.getByTestId('confirm-clear-video-sales')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(price).toHaveValue('1')
    await page.getByTestId('clear-video-sales').click()
    await page.getByTestId('confirm-clear-video-sales').click()
    await expect(price).toHaveValue('')
    await expect(page.getByTestId('autosave-status')).toContainText('已确认保存')
    const after = (await snapshot(page)).media_workbench_v1!
    expect(after.draft.products[0]!.pricing_rules.length).toBeGreaterThan(0)
    expect(after.draft.products[0]!.pricing_rules.every(rule => rule.sale_price == null)).toBe(true)
    expect(after.draft.products[0]!.capabilities).toEqual(before.draft.products[0]!.capabilities)
    expect(after.draft.products.slice(1)).toEqual(before.draft.products.slice(1))
    expect(after.published).toEqual(before.published); expect(after.sales).toEqual(before.sales)
    const writes = (await calls(page)).filter(call => call.method !== 'get')
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every(call => call.method === 'put' && call.url === '/admin/media-workbench/accounts/77/draft')).toBe(true)
    await page.getByRole('button', { name: '← 返回模型列表' }).click()
    await expect(page.getByTestId('draft-save-time')).toContainText('草稿最近保存：2026-10-20')
    await expect(page.getByTestId('publication-layers')).not.toContainText('mwp_')
    await page.getByTestId('draft-save-time').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`saved-time-${width}-${mode}.png`), animations: 'disabled' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await info.attach('draft-only-changes', { body: JSON.stringify({ before, after, writes }), contentType: 'application/json' })
    await expect(editor).toHaveCount(0)
  })
}

test('raw decimal survives reload before a valid Product commit', async ({ page }) => {
  await page.goto('/tests/media-workbench/index.html?scenario=VIDEO_POLISH')
  await openEditor(page)
  await page.getByTestId('video-sale-4').fill('12.')
  await page.reload(); await openEditor(page)
  await expect(page.getByTestId('draft-recovery')).toBeVisible()
  await page.getByTestId('restore-recovery').click()
  await expect(page.getByTestId('video-sale-4')).toHaveValue('12.')
  await page.getByTestId('video-sale-4').fill('12.50')
  await page.getByTestId('video-sale-4').press('Enter')
  await expect(page.getByTestId('autosave-status')).toContainText('已确认保存')
})

for (const outcome of ['business-failure', 'post-error', 'status-error']) {
  test(`paid check ${outcome}: report and transport failures stay distinct, no enable`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`/tests/media-workbench/index.html?paidCheck=${outcome}`)
    await page.getByTestId('paid-toggle').click()
    const panel = page.getByTestId('paid-video')
    await panel.getByRole('button', { name: '开启前检查' }).click()
    await expect(panel.getByRole('button', { name: '开启视频', exact: true })).toBeDisabled()
    if (outcome === 'business-failure') await expect(panel).toContainText('没有可用的已发布商品')
    else await expect(page.locator('.mw-paid-error')).toContainText(outcome === 'post-error' ? 'POST' : 'GET')
    if (outcome === 'status-error') await expect(panel.locator('.mw-paid-checks')).toBeVisible()
    expect((await calls(page)).filter(call => call.method !== 'get').map(call => call.url)).toEqual(['/admin/media-workbench/paid-controls/video/check'])
    await panel.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`${outcome}.png`), animations: 'disabled' })
  })
}
