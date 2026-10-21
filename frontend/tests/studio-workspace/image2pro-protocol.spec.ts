import { test, expect } from '@playwright/test'

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`Image2Pro text quotation has no attachment upload or generation ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.goto('/tests/studio-workspace/index.html?scenario=image2pro-protocol')
    await page.getByTestId('studio-mode-video').click()
    await expect(page.getByTestId('studio-model-toggle')).toContainText('Image2Pro')
    await page.getByTestId('studio-prompt').fill('Synthetic non-paid text-only video quotation')
    await page.getByTestId('studio-quote').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const calls = await page.evaluate(() => (window as any).studioFixture.calls)
    const video = calls.filter((call: any) => call.path.includes('/video/'))
    expect(video.filter((call: any) => call.path.endsWith('/prepare'))).toHaveLength(0)
    const quote = video.find((call: any) => call.path.endsWith('/quotes'))
    expect(quote.body).toMatchObject({ offer_id: 'image2pro-video', model: 'image2pro-public-fixture', duration: 5, resolution: '720P', ratio: '16:9', assets: [] })
    expect(quote.body.preparation_id).toBeUndefined()
    expect(calls.filter((call: any) => call.method === 'POST' && call.path.endsWith('/tasks'))).toHaveLength(0)
    await page.screenshot({ path: info.outputPath(`image2pro-text-${viewport.width}.png`), animations: 'disabled' })
  })

  test(`Image2Pro mixed private references prepare before exact quotation ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport)
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.goto('/tests/studio-workspace/index.html?scenario=image2pro-protocol')
    await page.getByTestId('studio-mode-video').click()
    await page.getByTestId('studio-prompt').fill('Synthetic image, audio and video references; no generation')
    await page.getByTestId('studio-asset-input').setInputFiles([
      { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=', 'base64') },
      { name: 'audio.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('synthetic audio fixture') },
      { name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.from('synthetic video fixture') },
    ])
    await expect(page.getByTestId('studio-asset-success')).toHaveCount(3)
    const before = await page.evaluate(() => (window as any).studioFixture.calls)
    expect(before.filter((call: any) => call.path.endsWith('/video/prepare') || call.path.endsWith('/video/quotes'))).toHaveLength(0)
    await page.screenshot({ path: info.outputPath(`image2pro-references-${viewport.width}.png`), animations: 'disabled' })
    await page.getByTestId('studio-quote').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const calls = await page.evaluate(() => (window as any).studioFixture.calls)
    const relevant = calls.filter((call: any) => call.path.endsWith('/video/prepare') || call.path.endsWith('/video/quotes'))
    expect(relevant.map((call: any) => call.path.split('/').pop())).toEqual(['prepare', 'quotes'])
    expect(relevant[0].body).toMatchObject({ offer_id: 'image2pro-video', model: 'image2pro-public-fixture', spec: { resolution: '720P', aspect_ratio: '16:9', duration_seconds: 5, images: 1, audio: 1, videos: 1 } })
    expect(relevant[1].body.preparation_id).toBe('isolated-image2pro-preparation')
    expect(relevant[1].body.assets).toEqual(relevant[0].body.assets)
    expect(calls.filter((call: any) => call.method === 'POST' && call.path.endsWith('/tasks'))).toHaveLength(0)
    await page.screenshot({ path: info.outputPath(`image2pro-quote-${viewport.width}.png`), animations: 'disabled' })
  })
}
