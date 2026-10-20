import { test, expect, type Page } from '@playwright/test'
import type { SupplierDetail } from '../../src/api/admin/mediaWorkbench'
import type { DraftRecovery } from '../../src/composables/draftRecovery'

type Fixture = {
  calls: { method: string; url: string }[]
  snapshot: () => SupplierDetail
  setDetailOutcome: (id: number, outcome: 'reject' | 'hold') => void
  releaseDetail: (id: number) => void
}
async function controlDetail(page: Page, id: number, outcome: 'reject' | 'hold') {
  await page.evaluate(({ id, outcome }) => (window as unknown as { mediaFixture: Fixture }).mediaFixture.setDetailOutcome(id, outcome), { id, outcome })
}
async function openAccount(page: Page, id: number) {
  await page.getByTestId('account-search').fill(`#${id}`)
  await page.getByTestId(`supplier-${id}`).click()
}
async function returnToAccounts(page: Page) {
  await page.getByRole('button', { name: '← 返回来源与账号', exact: true }).click()
  await expect(page.getByTestId('account-page')).toBeVisible()
}
async function expectNoWrites(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { mediaFixture: Fixture }).mediaFixture.calls.filter(call => call.method !== 'get'))).toEqual([])
}
async function seedRecoveries(page: Page) {
  return page.evaluate(async () => {
    // Use the real recovery encoder and key contract; these are synthetic local
    // copies of the browser fixture, never a real administrator's data.
    const path = '/src/composables/draftRecovery.ts'
    const { recoveryCopyKey, encodeDraftRecovery } = await import(path)
    const fixture = (window as unknown as { mediaFixture: Fixture }).mediaFixture
    const source = fixture.snapshot().media_workbench_v1!.draft.products[0]!
    return [77, 44].map(id => {
      const product = JSON.parse(JSON.stringify(source)) as typeof source
      product.display_name = `Account ${id} 的本地恢复`
      const editorId = crypto.randomUUID()
      const value: DraftRecovery = { version: 1, identity: { admin_id: 1, account_id: id, product_id: product.product_id, site_model: product.site_model, upstream_model: product.upstream_model }, base_record_version: 3, base_draft_revision: 'mwd_a', updated_at: Date.now(), copy_id: crypto.randomUUID(), editor_id: editorId, product }
      const key = recoveryCopyKey(value.identity, editorId) as string, raw = encodeDraftRecovery(value) as string
      localStorage.setItem(key, raw)
      return { key, raw }
    })
  })
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
})
for (const width of [1440, 390]) {
  test(`Account loading feedback and locked actions ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto('/tests/media-workbench/index.html')
    await controlDetail(page, 77, 'hold')
    await openAccount(page, 77)
    await expect(page.getByTestId('account-loading')).toContainText('Account #77')
    await expect(page.getByTestId('account-page')).toBeVisible()
    await expect(page.getByTestId('supplier-77')).toBeDisabled()
    await expect(page.getByTestId('supplier-77')).toHaveAttribute('aria-pressed', 'false')
    for (const id of ['model-page', 'selected-account-summary', 'display-name', 'save', 'sales', 'publish']) await expect(page.getByTestId(id)).toHaveCount(0)
    await expectNoWrites(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({ path: info.outputPath(`account-loading-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.evaluate(() => (window as unknown as { mediaFixture: Fixture }).mediaFixture.releaseDetail(77))
    await expect(page.getByTestId('selected-account-summary')).toContainText('#77')
    await expect(page.getByTestId('account-loading')).toHaveCount(0)
    await page.getByTestId('model-image-native-1').click()
    await expect(page.getByTestId('display-name')).toBeEnabled()
    await expectNoWrites(page)
  })
  test(`Account initial and repeated detail failures keep the source list ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto('/tests/media-workbench/index.html')
    await controlDetail(page, 77, 'reject')
    await openAccount(page, 77)
    await expect(page.getByTestId('banner')).toContainText('后台服务暂不可用')
    await expect(page.getByTestId('account-page')).toBeVisible()
    await expect(page.getByTestId('selected-account-summary')).toHaveCount(0)
    await openAccount(page, 77)
    await expect(page.getByTestId('selected-account-summary')).toContainText('#77')
    await returnToAccounts(page)
    await controlDetail(page, 77, 'reject')
    await openAccount(page, 77)
    await expect(page.getByTestId('banner')).toContainText('后台服务暂不可用')
    await expect(page.getByTestId('account-page')).toBeVisible()
    for (const id of ['model-page', 'editor-page', 'selected-account-summary', 'sales']) await expect(page.getByTestId(id)).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`same-account-failure-${width}.png`), fullPage: true, animations: 'disabled' })
    await expectNoWrites(page)
  })
  test(`Account switch preserves exact recovery ownership ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    await page.goto('/tests/media-workbench/index.html')
    const copies = await seedRecoveries(page)
    await openAccount(page, 77)
    await expect(page.getByTestId('selected-account-summary')).toContainText('#77')
    await returnToAccounts(page)
    await controlDetail(page, 44, 'reject')
    await openAccount(page, 44)
    await expect(page.getByTestId('banner')).toContainText('后台服务暂不可用')
    await expect(page.getByTestId('selected-account-summary')).toHaveCount(0)
    await controlDetail(page, 44, 'hold')
    await openAccount(page, 44)
    await expect(page.getByTestId('account-loading')).toContainText('Account #44')
    await expect(page.getByTestId('supplier-44')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('model-page')).toHaveCount(0)
    await expect(page.getByTestId('sales')).toHaveCount(0)
    await expect(page.getByTestId('display-name')).toHaveCount(0)
    await page.evaluate(() => (window as unknown as { mediaFixture: Fixture }).mediaFixture.releaseDetail(44))
    await expect(page.getByTestId('selected-account-summary')).toContainText('#44')
    await expect(page.getByTestId('selected-account-summary')).not.toContainText('#77')
    await page.getByTestId('model-image-native-1').click()
    await expect(page.getByTestId('draft-recovery')).toContainText('Account 44 的本地恢复')
    await expect(page.getByTestId('draft-recovery')).not.toContainText('Account 77 的本地恢复')
    await expect(page.getByTestId('display-name')).toHaveValue('画布图片')
    for (const copy of copies) expect(await page.evaluate(key => localStorage.getItem(key), copy.key)).toBe(copy.raw)
    await page.evaluate(() => window.dispatchEvent(new Event('offline')))
    await page.getByTestId('restore-recovery').click()
    await expect(page.getByTestId('display-name')).toHaveValue('Account 44 的本地恢复')
    expect(await page.evaluate(key => localStorage.getItem(key), copies[0]!.key)).toBe(copies[0]!.raw)
    await page.getByTestId('wizard-step-5').click()
    await page.screenshot({ path: info.outputPath(`account-recovery-${width}.png`), fullPage: true, animations: 'disabled' })
    await expectNoWrites(page)
  })
}
