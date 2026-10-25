import { test, expect, type Locator, type Page } from '@playwright/test'
import type { Product, SupplierDetail } from '../../src/api/admin/mediaWorkbench'

type Call = {
  method: string
  url: string
  input: { expected_record_version?: number; submission_id?: string; draft?: { products: Product[] } } | undefined
}
type Fixture = { snapshot: () => SupplierDetail; calls: Call[] }
const snapshot = (page: Page) => page.evaluate(() => (window as unknown as { mediaFixture: Fixture }).mediaFixture.snapshot())
const calls = (page: Page) => page.evaluate(() => (window as unknown as { mediaFixture: Fixture }).mediaFixture.calls)
const mediaType = (page: Page) => page.locator('select[data-field="media_type"]')
const seedanceProduct = (account: SupplierDetail) => account.media_workbench_v1!.draft.products.find(product => product.product_id === 'seedance-misclassified')!

async function openAccount(page: Page, id = 77) {
  await page.getByTestId('account-search').fill(`#${id}`)
  await page.getByTestId(`supplier-${id}`).click()
  await expect(page.getByTestId('selected-account-summary')).toContainText(`#${id}`)
}
async function openEditor(page: Page, id = 77) {
  await openAccount(page, id)
  await page.getByTestId('model-Seedance2.0').click()
  await expect(page.getByTestId('upstream-model-name')).toHaveText('Seedance2.0')
}
async function openMediaType(page: Page) {
  const technical = page.getByTestId('advanced-technical')
  if (await technical.getAttribute('open') === null) await technical.locator('summary').first().click()
  const identity = technical.locator('summary').filter({ hasText: '产品标识与用途' })
  if (await identity.locator('..').getAttribute('open') === null) await identity.click()
  await expect(mediaType(page)).toBeVisible()
}
async function openIndependentProduct(page: Page) {
  const management = page.getByTestId('product-management')
  if (await management.getAttribute('open') === null) await management.locator(':scope > summary').click()
  const options = page.getByTestId('product-options')
  if (await options.getAttribute('open') === null) await options.locator('summary').click()
  await page.getByTestId('new-independent-product').click()
  await expect(page.getByRole('dialog', { name: '另建独立销售商品？' })).toBeVisible()
}
async function expectOptions(select: Locator, types: string[]) {
  await expect(select.locator('option')).toHaveText(types.map(type => type === 'video' ? '视频' : '图片'))
  expect(await select.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(types)
}
async function returnToAccounts(page: Page) {
  await page.getByRole('button', { name: '← 返回模型列表', exact: true }).first().click()
  await page.getByRole('button', { name: '← 返回来源与账号', exact: true }).click()
  await expect(page.getByTestId('account-page')).toBeVisible()
}

test.use({ reducedMotion: 'reduce' })
test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
})

for (const width of [1440, 390]) {
  test(`cancelling a media type change restores the selected type and saved product ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await page.goto('/tests/media-workbench/index.html?scenario=MEDIA_TYPES_MIXED_ADAPTERS&theme=blue')
    const retained = await snapshot(page)
    seedanceProduct(retained).capabilities.count = { min: 1, max: 10 }
    await page.evaluate(value => sessionStorage.setItem('MEDIA_TYPES_MIXED_ADAPTERS', JSON.stringify(value)), retained)
    await page.reload()
    await openEditor(page)
    await openMediaType(page)
    const status = await page.getByTestId('autosave-status').textContent()
    const dialogs: string[] = []
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss() })
    await mediaType(page).selectOption('video')
    await expect(mediaType(page)).toHaveValue('image')
    await page.waitForTimeout(1800)
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toContain('已有价格覆盖的规格')
    expect(await snapshot(page)).toEqual(retained)
    expect((await calls(page)).filter(call => call.method !== 'get')).toEqual([])
    await expect(page.getByTestId('autosave-status')).toHaveText(status!)
    await expect(page.getByTestId('unsaved')).toHaveCount(0)
    await expect(page.getByLabel('时长（秒）', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`media-type-cancel-${width}.png`), fullPage: true, animations: 'disabled' })
    await info.attach('media-type-cancel-no-save', { body: JSON.stringify({ retained, dialogs }, null, 2), contentType: 'application/json' })
  })

  test(`opening and reselecting media type never saves and correction preserves prices ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await page.goto('/tests/media-workbench/index.html?scenario=MEDIA_TYPES_MIXED_ADAPTERS&theme=blue')
    const retained = await snapshot(page)
    const product = seedanceProduct(retained)
    product.capabilities.durations_seconds = [4, 8]
    product.pricing_rules = [4, 8].map((duration, index) => ({ match: { duration_seconds: [duration] }, sale_price: { amount: String(index + 3), currency: 'CNY', billing_mode: 'per_request' } }))
    await page.evaluate(value => sessionStorage.setItem('MEDIA_TYPES_MIXED_ADAPTERS', JSON.stringify(value)), retained)
    await page.reload()
    await openEditor(page)
    await openMediaType(page)
    const before = await snapshot(page)
    const status = await page.getByTestId('autosave-status').textContent()
    const dialogs: string[] = []
    page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss() })
    await mediaType(page).click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1800) // Exceed the real 1500 ms autosave debounce.
    expect(await snapshot(page)).toEqual(before)
    expect((await calls(page)).filter(call => call.method !== 'get')).toEqual([])
    await mediaType(page).selectOption('image')
    await page.waitForTimeout(1800)
    expect(await snapshot(page)).toEqual(before)
    expect((await calls(page)).filter(call => call.method !== 'get')).toEqual([])
    await expect(page.getByTestId('autosave-status')).toHaveText(status!)
    expect(dialogs).toEqual([])

    await mediaType(page).selectOption('video')
    await expect(mediaType(page)).toHaveValue('video')
    await expect(page.getByLabel('时长（秒）', { exact: true })).toHaveValue('4, 8')
    await expect(page.getByTestId('autosave-status')).toContainText('已确认保存')
    const corrected = await snapshot(page)
    expect(seedanceProduct(corrected).pricing_rules).toEqual(product.pricing_rules)
    expect(seedanceProduct(corrected).capabilities.durations_seconds).toEqual([4, 8])
    expect(corrected.media_workbench_v1!.published).toEqual(before.media_workbench_v1!.published)
    expect(corrected.media_workbench_v1!.sales).toEqual(before.media_workbench_v1!.sales)
    expect(dialogs).toEqual([])
    const writes = (await calls(page)).filter(call => call.method !== 'get')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.url).toBe('/admin/media-workbench/accounts/77/draft')

    // A real price merge asks once; cancellation restores DOM and saved state.
    await page.getByTestId('wizard-step-3').click()
    const dimension = page.getByTestId('pricing-dimension-duration_seconds')
    await expect(dimension).toBeChecked()
    const savedStatus = await page.getByTestId('autosave-status').textContent()
    await dimension.click()
    await expect(dimension).toBeChecked()
    await page.waitForTimeout(1800)
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0]).toContain('已有价格覆盖的规格')
    expect(await snapshot(page)).toEqual(corrected)
    expect((await calls(page)).filter(call => call.method !== 'get')).toEqual(writes)
    await expect(page.getByTestId('autosave-status')).toHaveText(savedStatus!)
    await expect(page.getByTestId('unsaved')).toHaveCount(0)
    await expect(mediaType(page)).toHaveValue('video')
    await page.screenshot({ path: info.outputPath(`retained-prices-cancel-${width}.png`), fullPage: true, animations: 'disabled' })
    await info.attach('opening-same-value-retained-prices-cancel', { body: JSON.stringify({ before, corrected, writes, dialogs }, null, 2), contentType: 'application/json' })
  })

  test(`legacy image-only config converts Seedance draft to native video and isolates accounts ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/tests/media-workbench/index.html?scenario=MEDIA_TYPES_MIXED_ADAPTERS&theme=blue')
    const before = await snapshot(page)
    expect(before.media_workbench_v1!.media_types).toEqual(['image'])
    expect(before.native_adapters!.video!.kind).toBe('image2pro_video')
    expect(seedanceProduct(before).media_type).toBe('image')
    await openEditor(page)
    await expect(page.getByLabel('时长（秒）', { exact: true })).toHaveCount(0)
    await openMediaType(page)
    await expectOptions(mediaType(page), ['image', 'video'])
    expect(await snapshot(page)).toEqual(before)

    // Only this synthetic product's explicitly entered duration may change.
    // Explicitly accept and record any existing price-coverage confirmation
    // during the type or duration change; the original image stays untouched.
    const warnings: string[] = []
    page.on('dialog', async dialog => { warnings.push(dialog.message()); await dialog.accept() })
    await mediaType(page).selectOption('video')
    await expect(mediaType(page)).toHaveValue('video')
    const duration = page.getByLabel('时长（秒）', { exact: true })
    await expect(duration).toBeVisible()
    await duration.fill('4, 8')
    await duration.press('Tab')
    await expect(duration).toHaveValue('4, 8')
    await page.screenshot({ path: info.outputPath(`seedance-video-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.getByTestId('wizard-step-5').click()
    await page.getByTestId('save').click()
    await expect(page.getByTestId('autosave-status')).toContainText('已确认保存')
    await expect(page.getByTestId('unsaved')).toHaveCount(0)

    const after = await snapshot(page)
    const current = after.media_workbench_v1!
    expect(current.media_types).toEqual(['image', 'video'])
    expect(seedanceProduct(after)).toMatchObject({ product_id: 'seedance-misclassified', upstream_model: 'Seedance2.0', media_type: 'video', capabilities: { durations_seconds: [4, 8], count: { min: 1, max: 1 } } })
    expect(current.draft.products.filter(product => product.product_id !== 'seedance-misclassified')).toEqual(before.media_workbench_v1!.draft.products.filter(product => product.product_id !== 'seedance-misclassified'))
    expect(current.draft.products[0]!.pricing_rules).toEqual(before.media_workbench_v1!.draft.products[0]!.pricing_rules)
    expect(current.published).toEqual(before.media_workbench_v1!.published)
    expect(current.sales).toEqual(before.media_workbench_v1!.sales)
    expect(after.effective_sales).toBe(before.effective_sales)
    const writes = (await calls(page)).filter(call => call.method !== 'get')
    expect(writes.length).toBeGreaterThan(0)
    expect(writes.every(call => call.method === 'put' && call.url === '/admin/media-workbench/accounts/77/draft')).toBe(true)
    for (const [index, write] of writes.entries()) {
      expect(write.input!.expected_record_version).toBe(before.media_workbench_v1!.record_version + index)
      expect(write.input!.submission_id).toEqual(expect.any(String))
    }
    const last = writes[writes.length - 1]!.input!
    expect(current.draft.save_receipt).toEqual({ submission_id: last.submission_id, base_record_version: last.expected_record_version, draft_revision: current.draft.revision })
    expect(current.record_version).toBe(before.media_workbench_v1!.record_version + writes.length)
    expect(warnings.every(message => message.includes('已有价格覆盖的规格'))).toBe(true)

    await page.reload()
    await openEditor(page)
    await openMediaType(page)
    await expect(mediaType(page)).toHaveValue('video')
    await expect(duration).toHaveValue('4, 8')
    expect(await snapshot(page)).toEqual(after)
    await page.screenshot({ path: info.outputPath(`seedance-saved-reread-${width}.png`), fullPage: true, animations: 'disabled' })

    // Same catalog/model/product IDs on another Account cannot inherit the
    // saved type or native video option from Account 77.
    await returnToAccounts(page)
    await openEditor(page, 44)
    await expect(page.getByTestId('display-name')).toHaveValue('Account 44 Seedance 误分类草稿')
    await openMediaType(page)
    await expectOptions(mediaType(page), ['image'])
    await expect(mediaType(page)).toHaveValue('image')
    await expect(page.getByLabel('时长（秒）', { exact: true })).toHaveCount(0)
    await openIndependentProduct(page)
    await expectOptions(page.getByTestId('new-product-type'), ['image'])
    await page.keyboard.press('Escape')
    await returnToAccounts(page)
    await openEditor(page)
    await openMediaType(page)
    await expectOptions(mediaType(page), ['image', 'video'])
    await expect(mediaType(page)).toHaveValue('video')
    expect(await snapshot(page)).toEqual(after)
    expect((await calls(page)).filter(call => call.method !== 'get')).toEqual([])
    expect(errors).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await info.attach('explicit-video-save-and-account-isolation', { body: JSON.stringify({ before, after, writes, warnings }, null, 2), contentType: 'application/json' })
  })

  test(`new independent product offers native video with legacy image-only config ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await page.goto('/tests/media-workbench/index.html?scenario=MEDIA_TYPES_MIXED_ADAPTERS&theme=blue')
    await openEditor(page)
    const before = await snapshot(page)
    expect(before.media_workbench_v1!.media_types).toEqual(['image'])
    await openIndependentProduct(page)
    const select = page.getByTestId('new-product-type')
    await expectOptions(select, ['image', 'video'])
    await select.selectOption('video')
    await expect(select).toHaveValue('video')
    await page.screenshot({ path: info.outputPath(`independent-video-option-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: '另建独立销售商品？' })).toHaveCount(0)
    expect(await snapshot(page)).toEqual(before)
    expect((await calls(page)).filter(call => call.method !== 'get')).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  })

  test(`Seedance name alone cannot add video without a native video adapter ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await page.goto('/tests/media-workbench/index.html?scenario=MEDIA_TYPES_IMAGE_ONLY&theme=blue')
    const before = await snapshot(page)
    expect(before.media_workbench_v1!.media_types).toEqual(['image'])
    expect(before.native_adapters!.video).toBeUndefined()
    expect(before.model_catalog!.models).toContain('Seedance2.0')
    await openEditor(page)
    await openMediaType(page)
    await expectOptions(mediaType(page), ['image'])
    await expect(page.getByLabel('时长（秒）', { exact: true })).toHaveCount(0)
    await openIndependentProduct(page)
    await expectOptions(page.getByTestId('new-product-type'), ['image'])
    await page.screenshot({ path: info.outputPath(`image-only-seedance-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.keyboard.press('Escape')
    expect(await snapshot(page)).toEqual(before)
    expect((await calls(page)).filter(call => call.method !== 'get')).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  })
}
