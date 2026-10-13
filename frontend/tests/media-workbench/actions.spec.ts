import { test, expect } from '@playwright/test'

for (const width of [1440, 390]) for (const mode of ['light', 'dark']) {
  test(`publication and return actions ${width} ${mode}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.goto(`/tests/media-workbench/index.html?scenario=PUBLICATION_LONG_LIST&theme=blue&mode=${mode}`)
    await page.getByTestId('account-search').fill('#77')
    await page.getByTestId('supplier-77').click()
    const publication = page.getByTestId('account-publication')
    await expect(page.locator('.mw-model-row')).toHaveCount(33)
    await expect(publication).toContainText('所有草稿商品，不限于当前搜索结果')
    await expect(publication).toContainText('发布配置不会自动开启销售')
    await expect(page.getByTestId('publish')).toBeInViewport()
    const card = (await publication.boundingBox())!
    const list = (await page.locator('.mw-model-list').boundingBox())!
    expect(card.y + card.height).toBeLessThan(list.y)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({ path: info.outputPath('publication.png') })
    await page.getByTestId('publish').click()
    const dialog = page.getByRole('dialog', { name: '发布这次修改？' })
    await expect(dialog).toContainText('当前 Account')
    await expect(page.getByTestId('confirm-publish')).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByTestId('model-image-native-1').click()
    await page.getByTestId('wizard-step-5').click()
    const back = page.getByTestId('return-models')
    await expect(back).toHaveText('← 返回模型列表')
    await back.scrollIntoViewIfNeeded()
    const bounds = (await back.boundingBox())!
    expect(bounds.width).toBeGreaterThanOrEqual(160)
    expect(bounds.height).toBeGreaterThanOrEqual(44)
    const save = (await page.getByTestId('save').boundingBox())!
    expect(bounds.x >= save.x + save.width + 8 || bounds.y >= save.y + save.height + 8).toBe(true)
    await page.screenshot({ path: info.outputPath('return-action.png') })
    await page.getByTestId('display-name').fill('未保存的商品名称')
    await expect(back).toHaveCount(0)
    await page.getByRole('button', { name: '← 返回模型列表', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '有未保存修改' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('display-name')).toHaveValue('未保存的商品名称')
    const writes = await page.evaluate(() => (window as unknown as { mediaFixture: { calls: { method: string }[] } }).mediaFixture.calls.filter(c => c.method !== 'get'))
    expect(writes).toEqual([])
  })
}

test('failed validation still prevents publishing from the relocated action', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto('/tests/media-workbench/index.html?scenario=UI_FIXABLE')
  await page.getByTestId('account-search').fill('#77')
  await page.getByTestId('supplier-77').click()
  await expect(page.getByTestId('publish')).toBeDisabled()
  await expect(page.getByTestId('confirm-publish')).toHaveCount(0)
})
