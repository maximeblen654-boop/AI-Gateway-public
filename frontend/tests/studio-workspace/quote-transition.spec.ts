import { test, expect } from '@playwright/test'

for (const width of [1440, 390]) for (const kind of ['image', 'video']) {
  test(`${kind} shows quote progress before a delayed response at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.goto('/tests/studio-workspace/index.html?scenario=empty')
    await expect(page.getByTestId('studio-mode-text')).toBeEnabled()
    if (kind === 'video') await page.getByTestId('studio-mode-video').click()
    await page.getByTestId('studio-prompt').fill('本地报价等待验收，不提交生成')
    await expect(page.getByTestId('studio-quote')).toBeEnabled()
    await page.evaluate(media => {
      const original = window.fetch
      window.fetch = async (input, init) => {
        const finalOperation = media === 'image' ? '/image/prepare' : '/video/quotes'
        if (String(input).endsWith(finalOperation)) await new Promise<void>(resolve => Object.assign(window, { releaseQuote: resolve }))
        return original(input, init)
      }
    }, kind)
    await page.getByTestId('studio-quote').click()
    const progress = page.getByRole('dialog', { name: '正在获取报价' })
    await expect(progress).toBeVisible()
    expect((await progress.locator('.modal-content').boundingBox())!.width).toBeLessThanOrEqual(Math.min(448, width - 32))
    await expect(page.getByTestId('studio-quote-progress')).toBeFocused()
    await expect(progress).toContainText('无需重复点击')
    await expect(progress.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '正在核对本次规格和价格')
    expect(await progress.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
    await expect(progress.locator('.studio-quote-progress-bar')).toHaveCSS('animation-name', 'studio-quote-flow')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(progress.locator('.studio-quote-progress-bar')).toHaveCSS('animation-name', 'none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await expect(page.getByTestId('studio-confirm-generate')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(progress).toBeVisible()
    await page.screenshot({ path: info.outputPath(`quote-progress-${kind}-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.waitForFunction(() => typeof (window as any).releaseQuote === 'function')
    await page.evaluate(() => (window as any).releaseQuote())
    const confirmation = page.getByRole('dialog', { name: '确认本次生成' })
    await expect(confirmation).toBeVisible()
    await expect(page.getByTestId('studio-quote-progress')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '返回修改' })).toBeFocused()
    await expect(page.getByTestId('studio-confirm-generate')).toBeEnabled()
    await expect(confirmation).toContainText('尚未冻结余额')
    await page.screenshot({ path: info.outputPath(`quote-ready-${kind}-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.getByRole('button', { name: '返回修改' }).click()
    await page.evaluate(media => {
      const original = window.fetch
      window.fetch = async (input, init) => {
        const path = String(input)
        if (path.endsWith(`/${media}/quotes`)) return new Response(JSON.stringify({ error: 'synthetic_quote_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        if (path.endsWith(media === 'image' ? '/image/tasks' : '/video/operations')) await new Promise<void>(resolve => Object.assign(window, { releaseHistory: resolve }))
        return original(input, init)
      }
    }, kind)
    await page.getByTestId('studio-quote').click()
    // A failed quote must stop its animation even when history recovery is slow.
    await page.waitForFunction(() => typeof (window as any).releaseHistory === 'function')
    await expect(page.getByTestId('studio-quote-progress')).toHaveCount(0)
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByTestId('studio-prompt')).toHaveValue('本地报价等待验收，不提交生成')
    await page.evaluate(() => (window as any).releaseHistory())
    await expect(page.getByTestId('studio-quote')).toBeEnabled()
    expect(await page.evaluate(() => (window as any).studioFixture.calls.filter((call: any) => call.method === 'POST' && call.path.endsWith('/tasks')))).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  })
}
