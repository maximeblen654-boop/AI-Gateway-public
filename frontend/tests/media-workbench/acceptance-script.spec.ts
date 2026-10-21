import { test, expect } from '@playwright/test'
import { createRequire } from 'node:module'
import type { SupplierDetail } from '../../src/api/admin/mediaWorkbench'
const require = createRequire(import.meta.url)
const { armSupplierPaidReads, matchesPaidRead, targetFor, verifyDiagnosticViewport } = require('../../../tools/native-media-e2e/admin-readonly.cjs')

test.use({ reducedMotion: 'reduce', timezoneId: 'Asia/Shanghai' })
// UI and Axios are real. Only the two GET responses use local HTTP fixtures.
// This is browser regression evidence, NOT real Core/Bridge/BFF acceptance.
for (const media of ['IMAGE', 'VIDEO']) for (const width of [1440, 390]) {
  test(`shared collector reads actual Axios timezone and navigates ${media} ${width}`, async ({ page }, info) => {
    const size = { width, height: width === 390 ? 844 : 900 }
    await page.setViewportSize(size)
    await page.route('**/api/v1/admin/media-workbench/paid-controls/*', async route => {
      expect(route.request().method()).toBe('GET')
      const u = new URL(route.request().url()), kind = u.pathname.split('/').pop()
      expect(u.searchParams.get('timezone')).toBe('Asia/Shanghai')
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { media: kind, mode: 'managed-v1', requested_enabled: false, effective_enabled: false, revision: 'fixture', reason: 'closed' } }) })
    })
    await page.goto(`/tests/media-workbench/index.html?scenario=MODEL_DIAGNOSTIC_${media}&networkPaidReads=1&mode=light`)
    await page.getByTestId('account-search').fill('#77')
    const snapshot = () => page.evaluate(() => (window as unknown as { mediaFixture: { snapshot(): SupplierDetail } }).mediaFixture.snapshot())
    const before = await snapshot(), target = targetFor(before, before.media_workbench_v1!.draft.products[0]!.product_id)
    // Prove the original no-query predicate rejects the same browser request.
    const actual = page.waitForRequest(q => matchesPaidRead(q, 'http://127.0.0.1:4190', 'image'))
    const finished = armSupplierPaidReads(page, 'http://127.0.0.1:4190')
    await page.getByTestId('supplier-77').click()
    const completed = await finished()
    expect(new URL((await actual).url()).search).not.toBe('')
    expect(completed).toEqual(expect.arrayContaining([expect.objectContaining({ media: 'image', body_finished: true, query_keys: ['timezone'] }), expect.objectContaining({ media: 'video', body_finished: true, query_keys: ['timezone'] })]))
    await page.getByTestId('model-page').waitFor({ state: 'visible' })
    const result = await verifyDiagnosticViewport(page, target, size)
    expect(result.identity).toBe(true)
    await page.screenshot({ path: info.outputPath(`shared-${media.toLowerCase()}-${width}.png`), animations: 'disabled' })
    expect(await snapshot()).toEqual(before)
    expect(await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string }[] } }).mediaFixture.calls.filter(c => c.method !== 'get'))).toEqual([])
    await info.attach('shared-collector-browser-proof', { body: JSON.stringify({ scope: 'REAL_UI_LOCAL_HTTP_FIXTURE', result, reads: completed }, null, 2), contentType: 'application/json' })
  })
}
