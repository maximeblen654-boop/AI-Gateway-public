import { test, expect, type Page } from '@playwright/test'

const writes = (page: Page) => page.evaluate(() => window.procurementFixture.calls.filter(call => call.method !== 'get'))
const state = (page: Page) => page.evaluate(() => window.procurementFixture.snapshot().media_workbench_v1!)
async function open(page: Page, scenario = 'reference-input') {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(`/tests/workbench-procurement/index.html?scenario=${scenario}`)
  await page.getByTestId('account-search').fill('#44')
  await page.getByTestId('supplier-44').click()
  await page.getByTestId('model-image-native-1').click()
  await page.getByTestId('wizard-step-2').click()
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`reference input buffers keystrokes, commits once and autosaves ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await open(page)
    let dialogs = 0; page.on('dialog', async dialog => { dialogs++; await dialog.dismiss() })
    const before = await state(page)
    const input = page.getByTestId('reference-image-max')
    await input.fill(''); await expect(input).toHaveValue('')
    await input.pressSequentially('1'); await expect(input).toHaveValue('1')
    await input.pressSequentially('2'); await expect(input).toHaveValue('12')
    await page.waitForTimeout(1800) // exceeds the unchanged production autosave debounce
    expect(await writes(page)).toEqual([])
    expect(await state(page)).toEqual(before)
    expect(dialogs).toBe(0)
    await input.scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath('editing-12-no-product-change.png'), animations: 'disabled' })
    await input.press('Enter'); await input.press('Tab')
    await expect(page.getByTestId('reference-total-summary')).toContainText('12 张')
    await expect.poll(async () => (await state(page)).draft.products[0]!.capabilities.references.image.max).toBe(12)
    expect(await writes(page)).toHaveLength(1)
    expect((await state(page)).draft.products[0]!.pricing_rules).toEqual(before.draft.products[0]!.pricing_rules)
    expect(dialogs).toBe(0)
    await page.screenshot({ path: info.outputPath('committed-12-autosaved.png'), animations: 'disabled' })
    await page.getByTestId('wizard-next').click()
    await page.getByTestId('wizard-step-2').click()
    await expect(input).toHaveValue('12')
    expect(errors).toEqual([])
    await info.attach('isolated-save-evidence', { body: JSON.stringify({ dialogs, writes: await writes(page), beforeVersion: before.record_version, afterVersion: (await state(page)).record_version }), contentType: 'application/json' })
  })
}

test('real price loss prompts once; cancelling restores configuration, prices and saved state', async ({ page }, info) => {
  await open(page, 'reference-input-loss')
  const before = await state(page)
  let dialogs = 0; page.on('dialog', async dialog => { dialogs++; await dialog.dismiss() })
  const input = page.getByTestId('reference-image-max')
  await input.fill('1'); expect(dialogs).toBe(0)
  await input.press('Enter'); await input.press('Tab')
  await expect(input).toHaveValue('12')
  await page.waitForTimeout(1800)
  expect(dialogs).toBe(1)
  expect(await state(page)).toEqual(before)
  expect(await writes(page)).toEqual([])
  await page.screenshot({ path: info.outputPath('cancel-preserves-configuration-prices.png'), animations: 'disabled' })
})

test('Next applies the last valid value; invalid input stays on the reference step', async ({ page }, info) => {
  await open(page)
  const input = page.getByTestId('reference-image-max')
  for (const raw of ['', '17', '1.5', '-1']) {
    await input.fill(raw); await page.getByTestId('wizard-next').click()
    await expect(page.getByTestId('wizard-step-2')).toHaveAttribute('aria-current', 'step')
    await expect(page.getByTestId('reference-error')).toContainText('0～16')
    expect(await writes(page)).toEqual([])
  }
  await input.fill('12'); await page.getByTestId('wizard-next').click()
  await info.attach('next-event-state', { body: JSON.stringify(await page.evaluate(() => ({
    current: [...document.querySelectorAll('[aria-current="step"]')].map(e => e.getAttribute('data-test')),
    input: (document.querySelector('[data-test="reference-image-max"]') as HTMLInputElement).value,
    error: document.querySelector('[data-test="reference-error"]')?.textContent,
    save: document.querySelector('[data-test="autosave-status"]')?.textContent,
    calls: window.procurementFixture.calls, server: window.procurementFixture.snapshot().media_workbench_v1
  }))), contentType: 'application/json' })
  await expect(page.getByTestId('wizard-step-3')).toHaveAttribute('aria-current', 'step')
  await expect.poll(async () => (await state(page)).draft.products[0]!.capabilities.references.image.max).toBe(12)
})

test('accepted price loss applies once, and saved video duration values are data rather than preset buttons', async ({ page }, info) => {
  await open(page, 'reference-input-loss')
  let dialogs = 0; page.on('dialog', async dialog => { dialogs++; await dialog.accept() })
  const before = await state(page)
  const input = page.getByTestId('reference-image-max')
  await input.fill('1'); expect(dialogs).toBe(0)
  await input.press('Enter'); await input.press('Tab')
  await expect.poll(async () => (await state(page)).draft.products[0]!.capabilities.references.image.max).toBe(1)
  expect(dialogs).toBe(1); expect(await writes(page)).toHaveLength(1)
  expect((await state(page)).draft.products[0]!.pricing_rules).toEqual(before.draft.products[0]!.pricing_rules)
  await page.getByRole('button', { name: '← 返回模型列表', exact: true }).click()
  await page.getByTestId('model-WAN3.0-可参考视频').click()
  const duration = page.locator('.mw-field').filter({ has: page.getByTestId('duration-range') })
  await expect(duration.getByTestId('tokens-input')).toHaveValue('5, 10, 15')
  await expect(duration.locator('.mw-token-presets[aria-label$="常用值"]')).toHaveCount(0)
  await expect(duration.getByRole('button', { name: '移除时长 5 秒', exact: true })).toBeVisible()
  await expect(page.getByTestId('duration-start')).toBeVisible()
  await expect(page.getByTestId('duration-end')).toBeVisible()
  await expect(page.getByTestId('duration-step')).toBeVisible()
  await page.screenshot({ path: info.outputPath('video-duration-saved-values-not-presets.png'), animations: 'disabled' })
})
