import { test, expect } from '@playwright/test'
import type { SupplierDetail } from '../../src/api/admin/mediaWorkbench'

test.use({ reducedMotion: 'reduce' })

for (const kind of ['IMAGE', 'VIDEO']) for (const width of [1440, 390]) {
  test(`missing ${kind} model focuses visible model identity ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/tests/media-workbench/index.html?scenario=MODEL_DIAGNOSTIC_${kind}&mode=light`)
    await page.getByTestId('account-search').fill('#77')
    await page.getByTestId('supplier-77').click()
    await page.locator('.mw-diagnostic').click()
    await page.getByTestId('wizard-step-5').click()
    const before = await page.evaluate(() => (window as unknown as { mediaFixture: { snapshot(): SupplierDetail } }).mediaFixture.snapshot())
    await page.locator('.mw-diagnostic').click()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.screenshot({ path: info.outputPath(`model-error-${kind.toLowerCase()}-${width}.png`), animations: 'disabled' })
    const summary = page.getByTestId('selected-model-summary')
    await expect(summary).toBeFocused()
    await expect(summary).toBeInViewport()
    await expect(summary).toHaveClass(/mw-field-located/)
    await expect(page.getByTestId('wizard-page-5')).toBeVisible()
    await expect(page.locator('.mw-diagnostic')).toContainText('上游模型列表')
    await expect(page.locator('.mw-diagnostic')).not.toContainText('对应规格或售价')
    await expect(page.getByTestId('native-output-png')).not.toBeVisible()
    const after = await page.evaluate(() => (window as unknown as { mediaFixture: { snapshot(): SupplierDetail } }).mediaFixture.snapshot())
    expect(after).toEqual(before)
    const writes = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string }[] } }).mediaFixture.calls.filter(call => call.method !== 'get'))
    expect(writes).toEqual([])
    expect(errors).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await info.attach('model-diagnostic-read-only-state', { body: JSON.stringify({ before, after, writes }, null, 2), contentType: 'application/json' })
  })
}
