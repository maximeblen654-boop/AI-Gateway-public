import { test, expect, type Page } from '@playwright/test'
import type { SupplierDetail } from '../../src/api/admin/mediaWorkbench'

type Fault = 'fail' | 'invalid' | 'timeout-committed' | 'timeout-rejected' | 'conflict' | 'delay'
type Call = { method: string; url: string; input: { draft?: { products: unknown[] }; product_ids?: string[]; enabled?: boolean } | null }
declare global {
  interface Window {
    procurementFixture: {
      calls: Call[]; snapshot: () => SupplierDetail
      failNext: (operation: string, fault: Fault) => void; release: () => void
    }
  }
}
const widths = [{ width: 1440, height: 900 }, { width: 1366, height: 650 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 360, height: 800 }]
const writes = (page: Page) => page.evaluate(() => window.procurementFixture.calls.filter(call => call.method !== 'get'))
const snapshot = (page: Page) => page.evaluate(() => window.procurementFixture.snapshot())
const fault = (page: Page, operation: string, mode: Fault) => page.evaluate(({ operation, mode }) => window.procurementFixture.failNext(operation, mode), { operation, mode })
async function open(page: Page, scenario = 'complete', mode = 'light') {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(`/tests/workbench-procurement/index.html?scenario=${scenario}&mode=${mode}`)
  await page.getByTestId('account-search').fill('#44')
  await page.getByTestId('supplier-44').click()
  await expect(page.getByTestId('model-page')).toBeVisible()
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo({ top: 0, behavior: 'instant' }) })
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0)
}
async function editor(page: Page, model = 'image-native-1') {
  await page.getByTestId(`model-${model}`).click()
  await page.getByTestId('wizard-step-4').click()
  await expect(page.getByTestId('pricing-editor')).toBeVisible()
}
async function openSalesManagement(page: Page) {
  const management = page.locator('details.mw-management-menu')
  if (await management.getAttribute('open') === null) await management.locator('summary').click()
}
async function save(page: Page) {
  await page.getByTestId('wizard-step-5').click()
  // Leaving an input/step flushes the autosave queue. Do not add a second
  // explicit request after a rejected first flush: that is a deliberate retry.
  await expect.poll(async () => (await writes(page)).filter(call => call.url.endsWith('/draft')).length).toBeGreaterThan(0)
}
async function publishImage(page: Page) {
  await page.getByTestId('publish').click()
  await page.getByTestId('publish-product-procurement-image').check()
  await page.getByTestId('confirm-publish').click()
}

for (const viewport of widths) for (const mode of ['light', 'dark']) {
  test(`actual shell retail editor and top account operations ${viewport.width} ${mode}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await open(page, 'complete', mode)
    await expect(page.locator('aside.sidebar')).toHaveCount(1)
    await openSalesManagement(page)
    await page.screenshot({ path: info.outputPath('account-operations.png'), animations: 'disabled' })
    await info.attach('account-operation-bounds', { body: JSON.stringify(await page.evaluate(() => ({ scrollY, sales: document.querySelector('[data-test=sales]')?.getBoundingClientRect().toJSON(), publication: document.querySelector('[data-test=account-publication]')?.getBoundingClientRect().toJSON(), context: document.querySelector('.mw-account-context')?.getBoundingClientRect().toJSON() }))), contentType: 'application/json' })
    await expect(page.getByTestId('sales')).toBeInViewport()
    await expect(page.getByTestId('publish')).toBeInViewport()
    await page.getByTestId('model-scope-all').click()
    expect(await page.locator('.mw-model-row').count()).toBeGreaterThan(30)
    await editor(page)
    const panel = page.getByTestId('editor-page')
    const box = (await panel.boundingBox())!
    expect(box.width).toBeLessThanOrEqual(980)
    expect(box.width).toBeGreaterThan(viewport.width < 1024 ? viewport.width - 100 : 650)
    await expect(page.getByTestId('price-1')).toHaveValue('0.90')
    await expect(page.getByTestId('price-0')).toHaveValue('0.90')
    await expect(page.getByTestId('price-2')).toHaveValue('1.90')
    await page.evaluate(()=>{Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false});window.dispatchEvent(new Event('offline'))})
    await page.getByTestId('price-0').fill('0.123456')
    await expect(page.getByTestId('price-1')).toHaveValue('0.90')
    await expect(page.getByTestId('autosave-status')).not.toContainText('已确认保存')
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('ai-gateway:media-draft:v1:')).map(key => JSON.parse(localStorage.getItem(key)!)).find(copy => copy.product.product_id === 'procurement-image')?.product.pricing_rules[0]?.sale_price?.amount)).toBe('0.123456')
    expect(await writes(page)).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    if (viewport.width < 1024) {
      const sidebar = page.locator('aside.sidebar')
      await expect.poll(async () => { const r = (await sidebar.boundingBox())!; return r.x + r.width }).toBeLessThanOrEqual(1)
      await page.locator('header button.lg\\:hidden').first().click()
      await expect.poll(async () => (await sidebar.boundingBox())!.x).toBe(0)
      await page.locator('.fixed.inset-0.bg-black\\/50').click({ position: { x: viewport.width - 10, y: 100 } })
      await expect.poll(async () => { const r = (await sidebar.boundingBox())!; return r.x + r.width }).toBeLessThanOrEqual(1)
    }
    await page.getByTestId('pricing-editor').scrollIntoViewIfNeeded()
    if (viewport.width <= 390) {
      const label = (await page.getByTestId('pricing-editor').locator('.mw-field').first().boundingBox())!
      expect(label.width).toBeGreaterThanOrEqual(200)
      expect((await page.getByTestId('price-0').boundingBox())!.width).toBeGreaterThanOrEqual(200)
    }
    await page.screenshot({ path: info.outputPath('retail-editor.png'), animations: 'disabled' })
    await page.getByTestId('wizard-step-5').click()
    await page.getByRole('button', { name: '← 返回模型列表', exact: true }).click()
    const dirty = page.getByRole('dialog', { name: '有未保存修改' })
    await expect(dirty).toBeVisible()
    expect((await dirty.boundingBox())!.width).toBeLessThanOrEqual(viewport.width)
    await page.keyboard.press('Escape')
    await page.getByTestId('wizard-step-4').click()
    await expect(page.getByTestId('price-0')).toHaveValue('0.123456')
  })
}

test('independent profit calculation never mutates product; explicit retail edits recover from server', async ({ page }) => {
  await open(page)
  const before = await snapshot(page)
  await editor(page)
  await page.getByTestId('independent-calculator-open').click()
  await page.getByTestId('independent-purchase').fill('100')
  await page.getByTestId('independent-credits').fill('10000')
  await page.getByTestId('independent-consumption').fill('35')
  await page.getByTestId('independent-sale').fill('0.90')
  await expect(page.getByTestId('independent-result')).toHaveText('0.35 元')
  await expect(page.getByTestId('independent-profit')).toHaveText('0.55 元')
  await page.keyboard.press('Escape')
  expect(await snapshot(page)).toEqual(before)
  expect(await writes(page)).toEqual([])
  await expect(page.getByTestId('price-0')).toHaveValue('0.90')
  await expect(page.getByTestId('price-2')).toHaveValue('1.90')
  await page.getByTestId('price-0').fill('0.95')
  await save(page)
  await expect(page.getByTestId('save-feedback')).toContainText('草稿已确认保存')
  const saved = (await snapshot(page)).media_workbench_v1!
  expect(saved.draft.products[0]!.pricing_rules[0]!.sale_price!.amount).toBe('0.95')
  expect(saved.draft.products[0]).not.toHaveProperty('cost_rules')
  expect(saved.published).toEqual(before.media_workbench_v1!.published)
  expect(saved.sales.enabled).toBe(false)
  expect((await writes(page)).every(call => call.url.endsWith('/draft'))).toBe(true)
  await page.reload()
  await page.getByTestId('account-search').fill('#44'); await page.getByTestId('supplier-44').click()
  await editor(page)
  await expect(page.getByTestId('price-0')).toHaveValue('0.95')
  await expect(page.getByTestId('price-2')).toHaveValue('1.90')
})

test('incomplete draft saves and missing-price diagnostic locates step 4 without losing input', async ({ page }) => {
  await open(page, 'missing')
  await editor(page)
  await page.getByTestId('price-1').fill('0.92')
  await save(page)
  await expect(page.getByTestId('save-feedback')).toContainText('草稿已确认保存')
  const issue = page.locator('.mw-diagnostic').filter({ hasText: '隔离图片商品 的客户售价尚未填写' })
  await expect(issue).toBeVisible()
  await issue.click()
  await expect(page.getByTestId('wizard-page-4')).toBeVisible()
  await expect(page.getByTestId('price-2')).toBeFocused()
  await expect(page.getByTestId('price-1')).toHaveValue('0.92')
  expect((await writes(page)).filter(call => call.url.endsWith('/publish'))).toEqual([])
})

test('selected publish leaves incomplete unselected product and sales state unchanged', async ({ page }) => {
  await open(page)
  const before = (await snapshot(page)).media_workbench_v1!
  await publishImage(page)
  await expect(page.getByTestId('publication-feedback')).toContainText('发布')
  const after = (await snapshot(page)).media_workbench_v1!
  expect(after.published?.revision).not.toBe(before.published?.revision)
  expect(after.published?.products?.find(p => p.product_id === 'procurement-wan')).toEqual(before.published?.products?.find(p => p.product_id === 'procurement-wan'))
  expect(after.published?.products?.some(p => p.product_id === 'procurement-unselected')).toBe(false)
  expect(after.sales.enabled).toBe(false)
  expect((await writes(page)).find(call => call.url.endsWith('/publish'))?.input?.product_ids).toEqual(['procurement-image'])
})

for (const mode of ['fail', 'timeout-committed', 'timeout-rejected', 'conflict'] as const) {
  test(`save ${mode} preserves evidence and avoids a second mutation`, async ({ page }) => {
    await open(page)
    await editor(page)
    await page.getByTestId('price-0').fill('0.456')
    await fault(page, 'draft', mode)
    await save(page)
    await expect.poll(async () => (await writes(page)).filter(call => call.url.endsWith('/draft')).length).toBe(1)
    if (mode === 'timeout-committed') await expect(page.getByTestId('save-feedback')).toContainText('草稿已确认保存')
    else {
      await expect(page.getByTestId('banner')).toContainText(mode === 'conflict' ? /其他页面|冲突/ : /未保存|未确认|未完成|不可用|核对/)
      if (mode !== 'conflict') await page.getByTestId('wizard-step-4').click()
      await expect(page.getByTestId('price-0')).toHaveValue('0.456')
    }
    expect((await writes(page)).filter(call => call.url.endsWith('/draft'))).toHaveLength(1)
    expect((await snapshot(page)).media_workbench_v1!.published?.revision).toBe('fixture-published-2')
  })
}

test('pending save disables a duplicate click and never reports early success', async ({ page }) => {
  await open(page); await editor(page)
  await page.getByTestId('price-0').fill('0.333')
  await fault(page, 'draft', 'delay')
  await save(page)
  await expect(page.getByTestId('save')).toBeDisabled()
  await expect(page.getByTestId('save-feedback')).not.toContainText('草稿已确认保存')
  expect((await writes(page)).filter(call => call.url.endsWith('/draft'))).toHaveLength(1)
  await page.evaluate(() => window.procurementFixture.release())
  await expect(page.getByTestId('save-feedback')).toContainText('草稿已确认保存')
})

test('definite input rejection retains the draft for correction and an explicit save', async ({ page }) => {
  await open(page); await editor(page)
  await page.getByTestId('price-0').fill('0.333')
  await fault(page, 'draft', 'invalid')
  await save(page)
  await expect(page.getByTestId('banner')).toContainText(/输入不合法|不合法|未保存/)
  await page.getByTestId('wizard-step-4').click()
  await expect(page.getByTestId('price-0')).toHaveValue('0.333')
  await page.getByTestId('price-0').fill('0.334')
  await page.getByTestId('wizard-step-5').click()
  await expect.poll(async () => (await writes(page)).filter(call => call.url.endsWith('/draft')).length).toBe(2)
  await expect(page.getByTestId('save-feedback')).toContainText('草稿已确认保存')
  expect((await snapshot(page)).media_workbench_v1!.draft.products[0]!.pricing_rules[0]?.sale_price?.amount).toBe('0.334')
})

test('sales failure leaves confirmation open; server-confirmed retry changes only Account sales', async ({ page }) => {
  await open(page)
  const before = (await snapshot(page)).media_workbench_v1!
  await openSalesManagement(page)
  await page.getByTestId('sales').click()
  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('confirm-sales') })
  await expect(dialog).toContainText('Account #44')
  await expect(dialog).toContainText('Account 级销售开关')
  await fault(page, 'sales', 'fail')
  await page.getByTestId('confirm-sales').click()
  await expect(dialog).toBeVisible()
  expect((await snapshot(page)).media_workbench_v1!.sales.enabled).toBe(false)
  await expect(page.getByTestId('account-sales-feedback')).not.toContainText('已开启')
  await page.getByTestId('confirm-sales').click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByTestId('account-sales-feedback')).toContainText('已开启')
  const after = (await snapshot(page)).media_workbench_v1!
  expect(after.sales.enabled).toBe(true)
  expect(after.published).toEqual(before.published)
  expect((await writes(page)).every(call => call.url.endsWith('/sales'))).toBe(true)
})

for (const operation of ['sales', 'publish'] as const) for (const mode of ['timeout-committed', 'timeout-rejected'] as const) {
  test(`${operation} ${mode} reads authoritative state before showing a result`, async ({ page }) => {
    await open(page)
    await fault(page, operation, mode)
    if (operation === 'publish') {
      await page.getByTestId('publish').click()
      await page.getByTestId('publish-product-procurement-image').check()
    } else {
      await openSalesManagement(page)
      await page.getByTestId('sales').click()
    }
    await page.getByTestId(`confirm-${operation}`).click()
    const dialog = page.getByRole('dialog').filter({ has: page.getByTestId(`confirm-${operation}`) })
    if (mode === 'timeout-committed') {
      await expect(dialog).not.toBeVisible()
      await expect(page.getByTestId(operation === 'sales' ? 'account-sales-feedback' : 'publication-feedback')).toContainText(operation === 'sales' ? '已开启' : '已发布')
    } else {
      await expect(dialog).toBeVisible()
      await expect(page.getByTestId(`confirm-${operation}`)).toBeDisabled()
      if (operation === 'sales') await expect(page.getByTestId('sales-reload')).toBeVisible()
      expect((await snapshot(page)).media_workbench_v1!.sales.enabled).toBe(false)
      expect((await snapshot(page)).media_workbench_v1!.published?.revision).toBe('fixture-published-2')
    }
    expect((await writes(page)).filter(call => call.url.endsWith('/' + operation))).toHaveLength(1)
    const calls = await page.evaluate(() => window.procurementFixture.calls)
    const index = calls.findIndex(call => call.url.endsWith('/' + operation) && call.method !== 'get')
    expect(calls.slice(index + 1).some(call => call.method === 'get' && call.url.endsWith('/accounts/44'))).toBe(true)
  })
}
