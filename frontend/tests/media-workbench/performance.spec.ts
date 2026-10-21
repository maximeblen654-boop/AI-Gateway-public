import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupplierDetail } from '../../src/api/admin/mediaWorkbench'

type Metric = { name: string; samples_ms: number[]; completed_samples: number; status: 'running' | 'complete' | 'failed'; median_ms: number | null; p95_ms: number | null; max_ms: number | null }
const outputRoot = process.env.MEDIA_PERF_OUTPUT
const stage = process.env.MEDIA_PERF_STAGE ?? 'current'
const count = Number(process.env.MEDIA_PERF_SAMPLES ?? 20)
const quantile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]!
async function paintedClick(page: Page, selector: string) {
  return page.evaluate(async selector => {
    const button = document.querySelector<HTMLElement>(selector)
    if (!button) throw new Error(`Missing click target: ${selector}`)
    const start = performance.now()
    button.click()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    return performance.now() - start
  }, selector)
}

for (const fixture of [
  { name: 'video-small', scenario: 'DRAFT_MANAGEMENT_VIDEO', model: 'video-model' },
  { name: 'video-complex', scenario: 'VIDEO_POLISH', model: 'video-model' }
]) {
  test(`performance actual Vue ${fixture.name}`, async ({ page }, info) => {
    test.setTimeout(180000)
    const out = outputRoot ? join(outputRoot, stage, fixture.name) : info.outputPath(stage, fixture.name)
    mkdirSync(out, { recursive: true })
    const metrics: Metric[] = []
    const dialogs: string[] = []
    const result = { stage, fixture: fixture.name, status: 'running', browser: 'Playwright Chromium, headless, actual MediaWorkbenchView + Vue + Pinia + router + i18n, local Axios adapter', viewport: { width: 1440, height: 900 }, samples_per_action: count, open_editor_ms: 0, geometry: {}, metrics, dialogs, viewport_checks: [] as { width: number; height: number; scroll_width: number }[] }
    const persist = () => writeFileSync(join(out, 'timings.json'), JSON.stringify(result, null, 2))
    async function metric(name: string, action: () => Promise<number>) {
      const value: Metric = { name, samples_ms: [], completed_samples: 0, status: 'running', median_ms: null, p95_ms: null, max_ms: null }
      metrics.push(value); persist()
      try {
        for (let index = 0; index < count; index++) {
          value.samples_ms.push(await action())
          value.completed_samples = value.samples_ms.length
          persist() // Preserve every returned sample if a later action times out.
        }
        value.status = 'complete'
        value.median_ms = quantile(value.samples_ms, .5)
        value.p95_ms = quantile(value.samples_ms, .95)
        value.max_ms = Math.max(...value.samples_ms)
      } catch (failure) { value.status = 'failed'; throw failure }
      finally { persist() }
    }
    page.on('dialog', async dialog => {
      expect(dialog.type()).toBe('confirm')
      expect(dialog.message()).toContain('价格')
      dialogs.push(dialog.message()); persist()
      await dialog.accept() // Follow the existing price-protection confirmation.
    })
    try {
      await page.setViewportSize(result.viewport)
      await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
      await page.goto(`/tests/media-workbench/index.html?scenario=${fixture.scenario}`)
      await page.getByTestId('account-search').fill('#77')
      await page.getByTestId('supplier-77').click()
      await expect(page.getByTestId(`model-${fixture.model}`)).toBeVisible()
      result.open_editor_ms = await paintedClick(page, `[data-test="model-${fixture.model}"]`)
      await expect(page.getByTestId('wizard-page-1')).toBeVisible()
      const dto = await page.evaluate(() => (window as unknown as { mediaFixture: { snapshot: () => SupplierDetail } }).mediaFixture.snapshot())
      const product = dto.media_workbench_v1!.draft.products[0]!
      const c = product.capabilities, refs = c.references
      result.geometry = { resolutions: c.resolutions.length, aspect_ratios: c.aspect_ratios.length, qualities: Math.max(1, c.qualities.length), durations: Math.max(1, c.durations_seconds.length), counts: c.count.max - c.count.min + 1, reference_images: refs.image.max - refs.image.min + 1, reference_videos: refs.video.max - refs.video.min + 1, reference_audios: refs.audio.max - refs.audio.min + 1, combination_rules: c.combination_rules.length, source_rules: product.pricing_rules.length }
      persist()
      await page.screenshot({ path: join(out, 'step-1.png'), animations: 'disabled' })
      await metric('step-1-to-3', async () => {
        await paintedClick(page, '[data-test="wizard-step-1"]')
        return paintedClick(page, '[data-test="wizard-step-3"]')
      })
      await expect(page.getByTestId('wizard-page-3')).toBeVisible()
      await metric('aspect-ratio-price-toggle', async () => {
        const checkbox = page.getByTestId('pricing-dimension-aspect_ratio')
        const checked = !await checkbox.isChecked()
        const elapsed = await paintedClick(page, '[data-test="pricing-dimension-aspect_ratio"]')
        await expect(checkbox).toBeChecked({ checked })
        // Confirm the bound Product actually changed; a cancelled protection
        // dialog or a native checkbox-only change must not count as a sample.
        await expect.poll(() => page.evaluate(() => {
          const fixture = (window as unknown as { mediaFixture: { snapshot: () => SupplierDetail } }).mediaFixture
          return fixture.snapshot().media_workbench_v1!.draft.products[0]!.pricing_rules.some(rule => !!rule.match.aspect_ratio?.length)
        }), { timeout: 10000 }).toBe(checked)
        return elapsed
      })
      await page.screenshot({ path: join(out, 'step-3.png'), animations: 'disabled' })
      await metric('step-3-to-4', async () => {
        await paintedClick(page, '[data-test="wizard-step-3"]')
        return paintedClick(page, '[data-test="wizard-step-4"]')
      })
      await expect(page.getByTestId('wizard-page-4')).toBeVisible()
      await page.screenshot({ path: join(out, 'step-4.png'), animations: 'disabled' })
      for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 650 }]) {
        await page.setViewportSize(viewport)
        await page.screenshot({ path: join(out, viewport.width < 500 ? 'step-4-mobile.png' : 'step-4-short.png'), animations: 'disabled' })
        const scroll_width = await page.evaluate(() => document.documentElement.scrollWidth)
        result.viewport_checks.push({ ...viewport, scroll_width }); persist()
        expect(scroll_width).toBeLessThanOrEqual(viewport.width)
      }
      const calls = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string; url: string }[] } }).mediaFixture.calls)
      expect(calls.filter(call => call.method !== 'get').every(call => call.method === 'put' && call.url.endsWith('/draft'))).toBe(true)
      result.status = 'complete'
    } catch (failure) { result.status = 'failed'; throw failure }
    finally {
      persist()
      console.log(`MEDIA_PERF ${JSON.stringify(result)}`)
      await info.attach(`${fixture.name}-${stage}`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
    }
  })
}

test('paid feedback distinguishes check, apply, confirmed effective and timeout', async ({ page }, info) => {
  const out = outputRoot ? join(outputRoot, stage, 'paid-feedback') : info.outputPath('paid-feedback')
  mkdirSync(out, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto('/tests/media-workbench/index.html?holdPaidCheck=1&holdPaidApply=1')
  const panel = page.getByTestId('paid-video')
  await panel.getByRole('button', { name: '开启前检查', exact: true }).click()
  await expect(panel).toHaveAttribute('data-phase', 'checking')
  await page.screenshot({ path: join(out, 'checking.png'), animations: 'disabled' })
  await page.evaluate(() => (window as unknown as { mediaFixture: { releasePaidCheck: () => void } }).mediaFixture.releasePaidCheck())
  await expect(panel).toHaveAttribute('data-phase', 'check-passed')
  await panel.getByRole('button', { name: '开启视频', exact: true }).click()
  await page.getByRole('button', { name: '确认开启', exact: true }).click()
  await expect(panel).toHaveAttribute('data-phase', 'applying')
  await expect(panel.getByTestId('paid-applying')).toBeVisible()
  await page.screenshot({ path: join(out, 'applying.png'), animations: 'disabled' })
  await page.evaluate(() => (window as unknown as { mediaFixture: { releasePaidApply: () => void } }).mediaFixture.releasePaidApply())
  await expect(panel).toHaveAttribute('data-phase', 'confirmed-effective')
  await page.screenshot({ path: join(out, 'confirmed-effective.png'), animations: 'disabled' })
  await page.goto('/tests/media-workbench/index.html?paidApply=timeout')
  await panel.getByRole('button', { name: '开启前检查', exact: true }).click()
  await expect(panel).toHaveAttribute('data-phase', 'check-passed')
  await panel.getByRole('button', { name: '开启视频', exact: true }).click()
  await page.getByRole('button', { name: '确认开启', exact: true }).click()
  await expect(panel).toHaveAttribute('data-phase', 'unconfirmed')
  await expect(page.locator('.mw-paid-error')).toContainText('开启结果未确认（PUT）')
  await expect(panel).toContainText('实际未开放')
  await page.screenshot({ path: join(out, 'unconfirmed-timeout.png'), animations: 'disabled' })
  const calls = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string; url: string }[] } }).mediaFixture.calls)
  expect(calls.filter(call => call.method === 'put' && call.url.endsWith('/video'))).toHaveLength(1)
  expect(calls.every(call => !/generations|tasks|publish|\/sales/.test(call.url))).toBe(true)
})

test('image calculator raw parameters survive step changes when browser memory fails', async ({ page }, info) => {
  const out = outputRoot ? join(outputRoot, stage, 'image-memory') : info.outputPath('image-memory')
  mkdirSync(out, { recursive: true })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto('/tests/media-workbench/index.html?scenario=DRAFT_MANAGEMENT')
  await page.evaluate(() => {
    const read = Storage.prototype.getItem, write = Storage.prototype.setItem
    Storage.prototype.getItem = function (key) { if (key.startsWith('ai-gateway:independent-calculator:')) throw new Error('fixture unavailable'); return read.call(this, key) }
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('ai-gateway:independent-calculator:')) throw new Error('fixture unavailable'); write.call(this, key, value) }
  })
  await page.getByTestId('account-search').fill('#77')
  await page.getByTestId('supplier-77').click()
  await page.getByTestId('model-gpt-image-2').click()
  await page.getByTestId('wizard-step-4').click()
  await page.getByTestId('independent-calculator-open').click()
  const panel = page.getByRole('dialog', { name: '成本与利润计算器', exact: true })
  await panel.getByTestId('independent-purchase').fill('100.')
  await panel.getByTestId('independent-credits').fill('2000.')
  await panel.getByTestId('independent-consumption').fill('90.')
  await expect(panel).toContainText('本机输入记忆不可用')
  await page.keyboard.press('Escape')
  await page.getByTestId('wizard-step-3').click()
  await page.getByTestId('wizard-step-4').click()
  await page.getByTestId('independent-calculator-open').click()
  await expect(panel.getByTestId('independent-purchase')).toHaveValue('100.')
  await expect(panel.getByTestId('independent-credits')).toHaveValue('2000.')
  await expect(panel.getByTestId('independent-consumption')).toHaveValue('90.')
  await panel.getByTestId('independent-purchase').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, 'desktop.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.getByTestId('independent-consumption').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(out, 'mobile.png'), animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  const writes = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string }[] } }).mediaFixture.calls.filter(call => call.method !== 'get'))
  expect(writes).toHaveLength(0)
})
