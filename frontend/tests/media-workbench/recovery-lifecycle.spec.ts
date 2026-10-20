import { test, expect, type Page } from '@playwright/test'
import { draftManagementSupplier, copy } from '../../src/components/admin/media/__tests__/fixtures'
import type { SupplierDetail } from '../../src/api/admin/mediaWorkbench'

type Fixture = { snapshot: () => SupplierDetail; calls: { method: string; url: string; input?: { submission_id?: string; expected_record_version?: number; products?: { display_name: string }[] } }[] }
const snapshot = (page: Page) => page.evaluate(() => {
  const f = (window as unknown as { mediaFixture: Fixture }).mediaFixture
  return { dto: f.snapshot(), calls: f.calls, copies: Object.keys(localStorage).filter(k => k.startsWith('ai-gateway:media-draft:v1:')) }
})
async function editor(page: Page) {
  await page.getByTestId('account-search').fill('#77')
  await page.getByTestId('supplier-77').click()
  await page.getByTestId('model-gpt-image-2').click()
}
test.beforeEach(async ({ page }) => {
  // Actual Vue page, synthetic isolated Axios fixture: all external traffic blocked.
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
})
for (const width of [1440, 390]) for (const mode of ['auto', 'manual']) {
  test(`resolved recovery stays resolved after ${mode} save and reload at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
    const initial = draftManagementSupplier(), product = copy(initial.media_workbench_v1!.draft.products[0]!)
    product.display_name = '本地尚未同步的商品名称'
    const identity = { admin_id: 1, account_id: initial.id, product_id: product.product_id, site_model: product.site_model, upstream_model: product.upstream_model }
    await page.addInitScript(({ product, identity, version, revision }) => {
      if (sessionStorage.getItem('recovery-lifecycle-seeded')) return
      const editor = crypto.randomUUID()
      const key = `ai-gateway:media-draft:v1:${JSON.stringify([identity.admin_id, identity.account_id, identity.product_id, identity.site_model, identity.upstream_model])}:editor:${editor}`
      localStorage.setItem(key, JSON.stringify({ version: 1, identity, editor_id: editor, copy_id: crypto.randomUUID(), updated_at: Date.now(), base_record_version: version, base_draft_revision: revision, product }))
      sessionStorage.setItem('recovery-lifecycle-seeded', '1')
    }, { product, identity, version: initial.media_workbench_v1!.record_version, revision: initial.media_workbench_v1!.draft.revision })
    await page.goto('/tests/media-workbench/index.html?scenario=DRAFT_MANAGEMENT_IMAGE_SINGLE')
    await editor(page)
    const banner = page.getByTestId('draft-recovery')
    await expect(banner).toContainText('本地修改尚未同步')
    await expect(page.getByTestId('autosave-status')).not.toContainText('已确认保存')
    await page.getByTestId('recovery-differences').locator('summary').click()
    await expect(banner).toContainText('商品名称')
    await expect(banner).not.toContainText('display_name')
    await expect(banner).not.toContainText('基准服务器版本')
    await banner.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`recovery-before-${mode}-${width}.png`), animations: 'disabled' })
    const before = await snapshot(page)
    await page.getByTestId('restore-recovery').click()
    await page.getByTestId('wizard-step-5').click()
    await page.getByTestId('display-name').fill('恢复后继续修改并确认保存')
    if (mode === 'manual') {
      await page.getByTestId('wizard-step-5').click()
      await page.getByTestId('save').click()
    }
    await expect(page.getByTestId('autosave-status')).toContainText('已确认保存')
    await expect(banner).toHaveCount(0)
    const after = await snapshot(page), c = after.dto.media_workbench_v1!
    expect(c.draft.products[0]!.display_name).toBe('恢复后继续修改并确认保存')
    expect(c.record_version).toBeGreaterThan(before.dto.media_workbench_v1!.record_version)
    expect(c.draft.save_receipt?.draft_revision).toBe(c.draft.revision)
    const writes = after.calls.filter(call => call.method !== 'get')
    expect(writes.length).toBeGreaterThan(0)
    for (const call of writes) {
      expect(call.method).toBe('put'); expect(call.url).toBe('/admin/media-workbench/accounts/77/draft')
      expect(call.input?.submission_id).toMatch(/^[a-f0-9-]{36}$/i)
    }
    expect(c.published).toEqual(before.dto.media_workbench_v1!.published)
    expect(c.sales).toEqual(before.dto.media_workbench_v1!.sales)
    expect(after.copies).toEqual([])
    await page.reload(); await editor(page); await page.getByTestId('wizard-step-5').click()
    await expect(page.getByTestId('draft-recovery')).toHaveCount(0)
    await expect(page.getByTestId('display-name')).toHaveValue('恢复后继续修改并确认保存')
    expect((await snapshot(page)).copies).toEqual([])
    await page.getByTestId('display-name').scrollIntoViewIfNeeded()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: info.outputPath(`recovery-confirmed-${mode}-${width}.png`), animations: 'disabled' })
  })
}
