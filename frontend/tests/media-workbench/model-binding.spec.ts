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


for (const width of [1440, 390]) {
  test(`a rejected new model explains its own adaptation failure without saving at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', route => /^http:\/\/127\.0\.0\.1:\d+\//.test(route.request().url()) && route.request().method() === 'GET' ? route.continue() : route.abort())
    await page.goto('/tests/media-workbench/index.html?scenario=MODEL_BINDING_REJECT&theme=blue')
    await page.getByTestId('account-search').fill('#77')
    await page.getByTestId('supplier-77').click()
    await page.getByTestId('model-new-model').click()
    await page.getByTestId('binding-new').selectOption('new-model')
    await page.getByTestId('binding-confirm').click()
    await expect(page.getByTestId('binding-feedback')).toContainText('换绑尚未生效')
    await expect(page.locator('.mw-validation h3')).toBeVisible()
    await expect(page.getByTestId('binding-diagnostic-context')).toContainText('image-native-1')
    await expect(page.getByTestId('binding-diagnostic-context')).toContainText('new-model')
    await expect(page.getByTestId('copy-codex')).toBeVisible()
    await expect(page.getByTestId('binding-old')).toHaveValue('image-native-1')
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({ path: info.outputPath(`binding-rejected-${width}.png`), fullPage: true })
    const calls = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { url: string }[] } }).mediaFixture.calls)
    expect(calls.filter(call => call.url.endsWith('/model-binding'))).toHaveLength(1)
    expect(calls.some(call => ['/draft', '/publish', '/sales'].some(suffix => call.url.endsWith(suffix)))).toBe(false)
    expect(errors).toEqual([])
  })
}


for (const width of [1440, 390]) {
  test(`issue shortcut opens the explanation and copy action near the top at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.route('**/*', route => /^http:\/\/127\.0\.0\.1:\d+\//.test(route.request().url()) && route.request().method() === 'GET' ? route.continue() : route.abort())
    await page.goto('/tests/media-workbench/index.html?scenario=MODEL_ISSUES_TOP&theme=blue')
    await page.getByTestId('account-search').fill('#77')
    await page.getByTestId('supplier-77').click()
    await expect(page.getByTestId('model-issues-image-native-1')).toBeVisible()
    await page.screenshot({ path: info.outputPath(`model-issue-entry-${width}.png`), fullPage: true })
    await page.getByTestId('model-issues-image-native-1').click()
    const problems = page.getByTestId('product-problems')
    await expect(problems).toBeVisible()
    await expect(page.getByTestId('copy-codex')).toBeInViewport()
    const issueBox = await problems.boundingBox(), wizardBox = await page.getByTestId('wizard-step-1').boundingBox()
    expect(issueBox!.y).toBeLessThan(wizardBox!.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({ path: info.outputPath(`model-issue-top-${width}.png`), fullPage: true })
    const calls = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string }[] } }).mediaFixture.calls)
    expect(calls.filter(call => call.method !== 'get')).toHaveLength(0)
    await page.getByTestId('copy-codex').click()
    await expect(page.getByTestId('copy-feedback')).toContainText('说明已复制')
    await expect(page.getByTestId('banner')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`model-issue-copied-${width}.png`), fullPage: true })
  })
}
