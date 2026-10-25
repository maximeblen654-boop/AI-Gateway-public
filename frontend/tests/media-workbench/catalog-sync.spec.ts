import { expect, test } from '@playwright/test'

for (const width of [1440, 390]) {
  test(`generic supplier automatic catalog status at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:4190/') && route.request().method() === 'GET' ? route.continue() : route.abort())
    await page.goto('/tests/media-workbench/index.html?scenario=PASS&theme=blue')
    await page.getByTestId('account-search').fill('#77')
    await page.getByTestId('supplier-77').click()
    await expect(page.getByTestId('catalog-updated')).toContainText('自动同步')
    await expect(page.getByTestId('catalog-updated')).not.toContainText('手动同步')
    await expect(page.getByTestId('catalog-notice')).toBeVisible()
    await page.getByTestId('catalog-notice').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`catalog-${width}.png`), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    expect(errors).toEqual([])
  })
}
