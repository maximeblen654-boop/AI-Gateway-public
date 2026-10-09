import { test, expect, type Page } from '@playwright/test'
const themes = ['yellow', 'blue', 'pink', 'green', 'lavender']
const viewports = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }]
for (const width of [1440, 390]) {
  test(`account navigation ${width}: grouping, search, filters and add selection`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.goto('/tests/media-workbench/index.html?scenario=NAVIGATION&mode=dark&theme=blue')
    await expect(page.getByTestId('account-count')).toHaveText('46')
    await expect(page.getByTestId('source-count')).toHaveText('4')
    await expect(page.getByTestId('source-unknown')).toContainText('未识别来源')
    const group = page.getByTestId('source-source-1.example.invalid')
    await expect(group.locator('.mw-supplier').first()).toHaveAttribute('data-test', 'supplier-1')
    await group.locator('summary').click()
    for (const query of ['5', '#5', 'Account #5']) {
      await page.getByTestId('account-search').fill(query)
      await expect(page.locator('.mw-supplier')).toHaveCount(1)
      await expect(page.getByTestId('supplier-5')).toBeVisible()
    }
    for (const [query, count] of [['账号 15', 1], ['source-2.example.invalid', 15], ['gemini', 23]] as const) {
      await page.getByTestId('account-search').fill(query)
      await expect(page.locator('.mw-supplier')).toHaveCount(count)
    }
    await page.getByTestId('clear-account-search').click()
    await page.getByTestId('account-filter').selectOption('SALES_PAUSED')
    await expect(page.getByTestId('supplier-2')).toBeVisible()
    await expect(page.getByTestId('supplier-1')).toHaveCount(0)
    await page.getByTestId('platform-filter').selectOption('openai')
    await expect(page.locator('.mw-supplier')).toHaveCount(0)
    await page.getByTestId('clear-account-search').click()
    await expect(page.locator('.mw-supplier')).toHaveCount(46)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({ path: testInfo.outputPath('account-navigation.png'), fullPage: true })
    await page.getByTestId('add-supplier').click()
    await page.getByTestId('add-account-search').fill('#15')
    await page.getByTestId('add-account-select').selectOption('15')
    await expect(page.getByTestId('initialize')).toBeEnabled()
    await page.getByTestId('add-account-search').fill('账号 25')
    await expect(page.getByTestId('initialize')).toBeDisabled()
    await page.getByTestId('add-account-select').selectOption('25')
    await expect(page.getByTestId('initialize')).toBeEnabled()
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click()
    if (width === 1440) {
      await page.getByTestId('source-source-1.example.invalid').locator('summary').click()
      await page.getByTestId('supplier-5').click()
      await page.getByTestId('display-name').fill('保留账号草稿')
      await page.getByTestId('account-search').fill('#6')
      await page.getByTestId('supplier-6').click()
      await expect(page.getByRole('dialog', { name: '有未保存修改' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('display-name')).toHaveValue('保留账号草稿')
    }
  })
}
async function openEditor(page: Page, query: string) {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto(`/tests/media-workbench/index.html?${query}`)
  await page.getByTestId('supplier-77').click()
  if (page.viewportSize()!.width < 768) await page.getByTestId('model-image-native-1').click()
  await expect(page.getByTestId('display-name')).toBeVisible()
}
for (const theme of themes) for (const mode of ['light', 'dark']) for (const viewport of viewports) {
  test(`${theme} ${mode} ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize(viewport); await openEditor(page, `theme=${theme}&mode=${mode}`)
    await expect(page.getByTestId('publish')).toBeEnabled()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    expect(overflow).toBe(false)
    if (viewport.width < 768) {
      const save = await page.getByTestId('save').boundingBox()
      expect(save!.y + save!.height).toBeLessThanOrEqual(viewport.height)
      await expect(page.getByTestId('supplier-77')).toBeHidden()
      await expect(page.getByTestId('model-image-native-1')).toBeHidden()
    }
    const colors = await page.evaluate(() => ({ token: getComputedStyle(document.documentElement).getPropertyValue('--site-primary-700'), surface: getComputedStyle(document.querySelector('.media-workbench')!).getPropertyValue('--mw-surface') }))
    expect(colors.token.trim()).not.toBe(''); expect(colors.surface.trim()).not.toBe('')
    await page.getByTestId('display-name').fill('主题切换保留草稿')
    await expect(page.getByTestId('publish')).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath('editor.png'), fullPage: true })
    expect(errors).toEqual([])
  })
}
for (const artwork of ['botanical', 'whale', 'whale_girl', 'osmanthus', 'lion', 'scholar', 'robot']) {
  test(`sidebar artwork ${artwork}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const blue = ['botanical', 'whale', 'whale_girl'].includes(artwork)
    await openEditor(page, `theme=${blue ? 'blue' : 'yellow'}&${blue ? 'blueArtwork' : 'yellowArtwork'}=${artwork}`)
    const link = page.locator('.sidebar').getByRole('link', { name: '媒体工作台', exact: true })
    await link.scrollIntoViewIfNeeded(); await expect(link).toBeVisible()
    const clickable = await link.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) })
    expect(clickable).toBe(true)
    const artworkLayer = page.locator('.sidebar-plant-art,.sidebar-character-art,.sidebar-whale-girl-art,.sidebar-yellow-character-art')
    await expect(artworkLayer).toHaveCSS('pointer-events', 'none')
    await page.screenshot({ path: testInfo.outputPath('sidebar.png'), fullPage: true })
  })
}
for (const scenario of ['UI_FIXABLE', 'NEEDS_DEVELOPMENT', 'UNKNOWN', 'PAUSED', 'UPSTREAM_MISSING', 'DELETED', 'STALE']) {
  test(`state ${scenario}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 }); await openEditor(page, `theme=blue&scenario=${scenario}`)
    if (scenario === 'DELETED' || scenario === 'STALE') {
      await page.getByTestId('save').click(); await expect(page.getByTestId('save')).toBeDisabled()
      await expect(page.getByTestId('banner')).toBeVisible()
    } else if (scenario !== 'PAUSED') await expect(page.getByTestId('publish')).toBeDisabled()
    if (scenario === 'NEEDS_DEVELOPMENT') await expect(page.getByTestId('copy-codex')).toBeVisible()
    else await expect(page.getByTestId('copy-codex')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('state.png'), fullPage: true })
  })
}
test('native Publish dialog traps focus; Escape cancels without publishing', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await openEditor(page, 'theme=lavender&mode=dark')
  await page.getByTestId('publish').click(); const dialog = page.getByRole('dialog', { name: '发布这次修改？' }); await expect(dialog).toBeVisible()
  for (let index = 0; index < 8; index++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true) }
  await page.screenshot({ path: testInfo.outputPath('publish-dialog.png'), fullPage: true })
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(page.getByTestId('publish')).toBeFocused()
})
for (const [state, label] of [
  ['SELLING', '媒体销售中'], ['PUBLISHED_NOT_READY', '已发布配置暂未满足销售条件'],
  ['ACCOUNT_RUNTIME_BLOCKED', '账户暂时无法提供服务，请打开账户详情处理']
]) {
  test(`Phase-2A effective state ${state}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 }); await openEditor(page, `theme=green&scenario=${state}`)
    await expect(page.locator('.mw-models')).toContainText(label!)
    await expect(page.locator('.media-workbench')).not.toContainText(state!)
  })
}
test('mobile size mapping diagnostic locates an editable mapping and save preserves it', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 }); await openEditor(page, 'theme=lavender&mode=dark&scenario=VALUE_MAPPING')
  await page.locator('.mw-diagnostic').click()
  await expect(page.getByTestId('size-mappings')).toHaveAttribute('open', '')
  await expect(page.getByTestId('mapping-resolution-0')).toBeFocused()
  await expect(page.getByTestId('mapping-size-0')).toHaveValue('2048x2048')
  await page.getByTestId('mapping-size-0').fill('1536x1536')
  await page.getByTestId('save').click()
  await expect(page.getByTestId('mapping-size-0')).toHaveValue('1536x1536')
  await expect(page.getByTestId('unsaved')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('size-mapping.png'), fullPage: true })
})
