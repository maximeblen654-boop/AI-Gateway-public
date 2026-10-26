import { expect, test } from '@playwright/test'

for (const width of [1440, 390]) {
  test(`missing published binding can be repaired inside the product at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', route => /^http:\/\/127\.0\.0\.1:\d+\//.test(route.request().url()) && route.request().method() === 'GET' ? route.continue() : route.abort())
    await page.goto('/tests/media-workbench/index.html?scenario=MODEL_BINDING&theme=blue')
    await page.getByTestId('account-search').fill('#77')
    await page.getByTestId('supplier-77').click()
    await page.getByTestId('model-new-model').click()
    await expect(page.getByTestId('model-binding')).toBeVisible()
    await expect(page.getByTestId('binding-old')).toHaveValue('image-native-1')
    await expect(page.getByTestId('binding-confirm')).toBeDisabled()
    await expect(page.getByTestId('binding-old').locator('option')).toHaveCount(3)
    await expect(page.getByTestId('wizard-next')).toHaveCount(0)
    await page.getByTestId('binding-new').selectOption('__delete_product__')
    await expect(page.getByTestId('binding-confirm')).toHaveText('确认删除 1 份商品')
    await page.getByTestId('binding-new').selectOption('new-model')
    await page.screenshot({ path: info.outputPath(`binding-${width}.png`), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.getByTestId('binding-confirm').click()
    await expect(page.getByTestId('model-binding')).toHaveCount(0)
    await expect(page.getByTestId('product-relist')).toHaveCount(1)
    const calls = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { url: string; input: unknown }[] } }).mediaFixture.calls)
    expect(calls.filter(call => call.url.endsWith('/model-binding'))).toHaveLength(1)
    expect(calls.some(call => call.url.endsWith('/publish') || call.url.endsWith('/sales'))).toBe(false)
    expect(errors).toEqual([])
  })
}
