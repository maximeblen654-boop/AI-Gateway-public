import { test, expect } from '@playwright/test'
import type { SupplierDetail } from '../../src/api/admin/mediaWorkbench'

test.use({ reducedMotion: 'reduce' })

for (const kind of ['IMAGE', 'VIDEO']) for (const width of [1440, 390]) {
  test(`missing ${kind} model focuses visible model identity ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const blockedWrites: string[] = []
    await page.route('**/*', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) { blockedWrites.push(route.request().method()); return route.abort() }
      return new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()
    })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`/tests/media-workbench/index.html?scenario=MODEL_DIAGNOSTIC_${kind}&mode=light`)
    await page.getByTestId('account-search').fill('#77')
    await page.getByTestId('supplier-77').click()
    const before = await page.evaluate(() => (window as unknown as { mediaFixture: { snapshot(): SupplierDetail } }).mediaFixture.snapshot())
    const product = before.media_workbench_v1!.draft.products[0]!
    await expect(page.locator('.mw-diagnostic')).toContainText('上游模型列表')
    await expect(page.locator('.mw-diagnostic')).not.toContainText('对应规格或售价')
    await page.locator('.mw-diagnostic').click()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await page.screenshot({ path: info.outputPath(`model-error-${kind.toLowerCase()}-${width}.png`), animations: 'disabled' })
    const summary = page.getByTestId('selected-model-summary')
    await expect(summary).toBeFocused()
    await expect(summary).toBeInViewport()
    await expect(summary).toHaveClass(/mw-field-located/)
    await expect(page.getByTestId('upstream-model-name')).toHaveText(product.upstream_model)
    await expect(page.getByTestId('model-binding')).toBeVisible()
    await expect(page.getByTestId('model-binding')).toContainText('原型号不可用，请更换绑定')
    await expect(page.getByTestId('binding-old')).toHaveValue(product.upstream_model)
    await expect(page.getByTestId(`binding-product-${product.product_id}`)).toBeChecked()
    await expect(page.getByTestId('binding-new')).toHaveValue('')
    await expect(page.getByTestId('binding-confirm')).toBeDisabled()
    for (const id of ['wizard-step-1', 'wizard-step-5', 'wizard-next', 'wizard-page-1', 'wizard-page-5', 'save']) await expect(page.getByTestId(id)).toHaveCount(0)
    await expect(page.getByTestId('native-output-png')).not.toBeVisible()
    const after = await page.evaluate(() => (window as unknown as { mediaFixture: { snapshot(): SupplierDetail } }).mediaFixture.snapshot())
    expect(after).toEqual(before)
    const writes = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string }[] } }).mediaFixture.calls.filter(call => call.method !== 'get'))
    expect(writes).toEqual([])
    expect(blockedWrites).toEqual([])
    expect(errors).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await info.attach('model-diagnostic-read-only-state', { body: JSON.stringify({ before, after, writes }, null, 2), contentType: 'application/json' })
  })
}
