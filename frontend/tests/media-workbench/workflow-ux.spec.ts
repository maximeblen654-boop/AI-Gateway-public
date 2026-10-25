import { test, expect, type Page } from '@playwright/test'

async function openAccount(page: Page) {
  await page.getByTestId('account-search').fill('#77')
  await page.getByTestId('supplier-77').click()
  await expect(page.getByTestId('model-page')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
})

for (const width of [1272, 390]) {
  for (const destination of ['model', 'route']) for (const decision of ['cancel', 'discard', 'save']) {
    test(`${destination === 'route' ? 'route ' : ''}leave confirmation preserves the decision ${decision} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 548 })
      await page.goto('/tests/media-workbench/index.html?theme=lavender')
      await openAccount(page)
      await page.getByTestId('model-image-native-1').click()
      await page.getByTestId('wizard-step-5').click()
      await page.clock.install()
      await page.getByTestId('display-name').fill('等待明确选择的修改')
      if (destination === 'route') {
        if (width === 390) {
          await page.getByRole('button', { name: '切换菜单', exact: true }).click()
          await page.clock.runFor(350)
        }
        await page.getByRole('link', { name: '账号管理', exact: true }).click()
      }
      else await page.getByRole('button', { name: '选择模型', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '有未保存修改' })).toBeVisible()
      await page.clock.runFor(2000)
      const writes = () => page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string; url: string }[] } }).mediaFixture.calls.filter(call => call.method !== 'get'))
      expect(await writes()).toEqual([])
      if (decision === 'cancel') {
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('display-name')).toHaveValue('等待明确选择的修改')
        await page.clock.runFor(1501)
        await expect(page.getByTestId('autosave-status')).toContainText('已确认保存')
        expect(await writes()).toHaveLength(1)
      } else if (decision === 'discard') {
        await page.getByTestId('discard-navigate').click()
        if (destination === 'route') await expect(page.getByText('Fixture destination', { exact: true })).toBeVisible()
        else await expect(page.getByTestId('model-page')).toBeVisible()
        await page.clock.runFor(2000)
        expect(await writes()).toEqual([])
      } else {
        await page.getByTestId('save-navigate').click()
        if (destination === 'route') await expect(page.getByText('Fixture destination', { exact: true })).toBeVisible()
        else await expect(page.getByTestId('model-page')).toBeVisible()
        expect(await writes()).toHaveLength(1)
        expect((await writes())[0]!.url).toContain('/draft')
      }
    })
  }

  test(`normal autosave keeps the price field in place ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 548 })
    await page.goto('/tests/media-workbench/index.html?theme=lavender')
    await openAccount(page)
    await page.getByTestId('edit-price-image-native-1').click()
    const input = page.getByTestId('price-0')
    await expect(input).toBeInViewport()
    const before = (await input.boundingBox())!.y
    await input.fill('0.27')
    await expect(page.getByTestId('autosave-status')).toContainText('未保存')
    await expect(page.getByTestId('draft-recovery')).toHaveCount(0)
    await expect(page.locator('.mw-save-details')).not.toHaveAttribute('open')
    expect(Math.abs((await input.boundingBox())!.y - before)).toBeLessThan(24)
    await expect(page.getByTestId('autosave-status')).toContainText('已确认保存')
    await expect(input).toHaveValue('0.27')
    await expect(input).toBeInViewport()
    await page.screenshot({ path: info.outputPath(`stable-save-${width}.png`), animations: 'disabled' })
  })

  test(`find account, edit price directly and return with context ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 548 })
    await page.goto('/tests/media-workbench/index.html?theme=lavender')
    await expect(page.getByTestId('account-search')).toBeVisible()
    if (width > 1000) expect((await page.getByTestId('account-search').boundingBox())!.y).toBeLessThan(548)
    await page.screenshot({ path: info.outputPath(`accounts-${width}.png`), fullPage: false })
    await openAccount(page)
    await page.getByTestId('model-search').fill('image-native')
    await page.screenshot({ path: info.outputPath(`models-${width}.png`), fullPage: false })
    await page.getByTestId('edit-price-image-native-1').click()
    await expect(page.getByTestId('wizard-page-4')).toBeVisible()
    await expect(page.getByTestId('wizard-step-4')).toHaveAttribute('aria-current', 'step')
    await expect(page.getByTestId('model-lifecycle')).not.toHaveAttribute('open')
    await expect(page.getByTestId('product-management')).not.toHaveAttribute('open')
    await page.screenshot({ path: info.outputPath(`pricing-${width}.png`), fullPage: false })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.getByRole('button', { name: '选择模型', exact: true }).click()
    await expect(page.getByTestId('model-search')).toHaveValue('image-native')
    await page.getByRole('button', { name: '← 返回来源与账号', exact: true }).click()
    await expect(page.getByTestId('account-search')).toHaveValue('#77')
    const writes = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string }[] } }).mediaFixture.calls.filter(call => call.method !== 'get'))
    expect(writes).toEqual([])
  })
}

test('current published product is distinguished from account pending changes', async ({ page }, info) => {
  await page.goto('/tests/media-workbench/index.html?scenario=MEDIA_TYPES_MIXED_ADAPTERS&theme=blue')
  await openAccount(page)
  await page.getByTestId('model-scope-configured').click()
  await page.getByTestId('model-gpt-image-2.0').click()
  await expect(page.getByTestId('selected-product-publication')).toContainText('当前商品与已发布配置一致')
  await expect(page.getByTestId('other-pending-products')).toContainText('另有 1 份商品草稿待发布')
  await page.screenshot({ path: info.outputPath('product-account-state.png'), fullPage: false })
})

for (const theme of ['yellow', 'blue', 'pink', 'green', 'lavender']) {
  test(`shared workflow remains readable in ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width: 1272, height: 548 })
    await page.goto(`/tests/media-workbench/index.html?theme=${theme}`)
    await openAccount(page)
    await page.getByTestId('edit-price-image-native-1').click()
    await expect(page.getByTestId('wizard-page-4')).toBeVisible()
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.media-workbench')!).getPropertyValue('--mw-accent').trim())).toContain('rgb(')
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({ path: info.outputPath(`theme-${theme}.png`), fullPage: false })
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await page.screenshot({ path: info.outputPath(`theme-${theme}-dark.png`), fullPage: false })
  })
}
