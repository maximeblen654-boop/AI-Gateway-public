const { test, expect } = require('../../frontend/node_modules/@playwright/test')
const selectPublishedProduct = require('./product-picker.cjs')

for (const width of [1440, 390]) for (const kind of ['image', 'video']) {
  test(`candidate picker preserves product and price ${kind} ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.goto('/tests/studio-workspace/index.html?scenario=product-offers')
    // Extend only the existing browser fixture: same names, distinct publication
    // scopes and prices, with the unrelated product deliberately listed first.
    await page.evaluate(() => {
      const original = window.fetch
      let imageOffer = ''
      window.fetch = async (input, init) => {
        const response = await original(input, init)
        const path = new URL(typeof input === 'string' ? input : input.url, location.origin).pathname
        if (path.endsWith('/catalog')) {
          const body = await response.json()
          const target = body.offers.at(-1)
          const other = { ...target, offer_id: target.offer_id + '-other', product_scope: target.product_scope + '-other' }
          return new Response(JSON.stringify({ offers: [other, ...body.offers] }), { headers: { 'Content-Type': 'application/json' } })
        }
        if (path.endsWith('/image/quotes')) imageOffer = JSON.parse(init.body).offer_id
        if (path.endsWith('/image/prepare') || path.endsWith('/video/quotes')) {
          const body = await response.json()
          const other = (body.offer_id || imageOffer).endsWith('-other')
          const unit = path.includes('/image/') ? (other ? 1.30 : 0.70) : (other ? 25 : 15)
          body.unit_price = { amount: unit.toFixed(2), currency: 'CNY', billing_mode: 'per_request' }
          body.sale_price = { ...body.unit_price, amount: (unit * body.spec.count).toFixed(2) }
          return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
        }
        return response
      }
    })
    await page.getByTestId(kind === 'image' ? 'studio-mode-text' : 'studio-mode-video').click()
    await page.getByTestId('studio-refresh-models').click()
    const catalog = await page.evaluate(async kind => (await fetch(`/studio-v2/api/${kind}/catalog`)).json(), kind)
    const target = catalog.offers.find(offer => offer.offer_id === (kind === 'image' ? 'image-4K' : 'video-15'))
    for (const other of [false, true]) {
      const offer = other ? catalog.offers.find(item => item.offer_id === target.offer_id + '-other') : target
      await page.getByTestId('studio-model-toggle').click()
      await expect(page.locator('#studio-model-menu .picker-choice')).toHaveCount(2)
      await selectPublishedProduct(page, catalog.offers, offer)
      if (kind === 'image') {
        await page.getByTestId('studio-resolution').click()
        await page.locator('#studio-resolution-menu [data-value="4K"]').click()
        await page.getByTestId('studio-count').click()
        await page.locator('#studio-count-menu [data-value="2"]').click()
      } else {
        await page.getByTestId('studio-duration').click()
        await page.locator('#studio-duration-menu [data-value="15"]').click()
      }
      await page.getByTestId('studio-ratio-toggle').click()
      await page.locator('[data-ratio="16:9"]').click()
      await page.getByTestId('studio-prompt').fill('Synthetic product selection; no generation')
      await page.getByTestId('studio-quote').click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).toContainText(kind === 'image' ? (other ? '2.60 CNY' : '1.40 CNY') : (other ? '25.00 CNY' : '15.00 CNY'))
      const calls = await page.evaluate(() => window.studioFixture.calls)
      const quote = calls.filter(call => call.path.endsWith(`/${kind}/quotes`)).at(-1)
      expect(quote.body.offer_id).toBe(offer.offer_id)
      if (kind === 'image') expect(quote.body.spec).toMatchObject({ resolution: '4K', aspect_ratio: '16:9', count: 2 })
      else expect(quote.body).toMatchObject({ duration: 15, ratio: '16:9', resolution: '720p' })
      expect(calls.filter(call => call.method === 'POST' && call.path.endsWith('/tasks'))).toHaveLength(0)
      await page.getByRole('button', { name: '返回修改' }).click()
    }
  })
}
