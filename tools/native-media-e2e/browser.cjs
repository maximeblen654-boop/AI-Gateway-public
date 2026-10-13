const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test')
const root = process.argv[2]
assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')))
const compose = JSON.parse(fs.readFileSync(`${root}/compose.json`, 'utf8').replace(/^\uFEFF/, ''))
assert.equal(compose.services.core.container_name, 'ai-gateway-native-core-20261012')
const fixture = JSON.parse(fs.readFileSync(`${root}/evidence/fixture.json`, 'utf8'))
const base = 'http://127.0.0.1:28100'
const videoMode = process.argv.includes('--video-seedance') ? 'seedance' : process.argv.includes('--video-compatible') ? 'compatible' : process.argv.includes('--video') ? 'grok' : null
const video = Boolean(videoMode)
const geometry = process.argv.includes('--image-geometry')
const platform = video ? videoMode : geometry ? 'openai' : 'gemini'
const accountId = fixture.accounts[platform]
const model = video ? ({ grok: 'grok-imagine-video', compatible: 'synthetic-compatible-video', seedance: 'synthetic-seedance-video' })[videoMode] : geometry ? 'gpt-image-2' : 'gemini-3.1-flash-image'
const name = video ? ({ grok: 'Synthetic native Grok video', compatible: 'Synthetic native compatible video', seedance: 'Synthetic native Seedance video' })[videoMode] : geometry ? 'Synthetic geometry image' : 'Synthetic native Gemini image'
const prefix = video ? `native-video-${videoMode}` : geometry ? 'native-geometry' : 'native'
const report = { cases: [], http: [] }
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const w = id => page.locator(`[data-test="${id}"]`)
  page.on('response', r => { if (r.url().startsWith(base+'/api/') || r.url().startsWith(base+'/studio-v2/api/')) report.http.push({ method: r.request().method(), path: new URL(r.url()).pathname, status: r.status() }) })
  page.on('dialog', d => d.accept())
  await page.addInitScript(() => { localStorage.setItem('sub2api_locale', 'zh'); localStorage.setItem('admin_guide_1_admin_v4_interactive', 'true') })
  try {
    await page.goto(base+'/login')
    await page.getByLabel('邮箱').fill(compose.services.core.environment.ADMIN_EMAIL)
    await page.getByLabel('密码').fill(compose.services.core.environment.ADMIN_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/dashboard')
    await page.goto(base+'/admin/media')
    await w('source-localhost').locator('summary').click()
    await w(`supplier-${accountId}`).click()
    await w(`model-${model}`).click()
    if (await w(`add-product-${video ? 'video' : 'image'}`).isVisible()) await w(`add-product-${video ? 'video' : 'image'}`).click()
    await expect(w('adapter-status')).toContainText('已接入')
    assert.equal(await w('model-family').count(), 0)
    assert.equal(await w('wire-profile').count(), 0)
    for (const value of video ? ['720p', '5', '16:9'] : ['1K', '2K', '4K', '1:1', ...(geometry ? ['3:2'] : []), '16:9']) {
      const button = w('wizard-page-1').locator('button.mw-token-chip').filter({ hasText: new RegExp(`^${value}$`) })
      if (!(await button.getAttribute('class')).includes('mw-token-chip-selected')) await button.click()
    }
    await w('wizard-next').click()
    await w('reference-image-mode').selectOption('optional')
    await w('reference-image-max').fill(video ? '1' : '2')
    await w('wizard-next').click()
    await w('pricing-dimension-resolution').check()
    await expect(w('expected-prices')).toContainText(video ? '1 个价格' : '3 个价格')
    await page.waitForTimeout(500)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.screenshot({ path: `${root}/evidence/${prefix}-dimensions-desktop.png`, fullPage: true, animations: 'disabled' })
    await w('wizard-next').click()
    for (let i = 0; i < (video ? 1 : 3); i++) await w(`price-${i}`).fill(video ? '2.00' : geometry ? ['0.70','0.90','1.10'][i] : '0.70')
    await page.waitForTimeout(500)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.screenshot({ path: `${root}/evidence/${prefix}-prices-desktop.png`, fullPage: true })
    await w('wizard-next').click()
    await w('display-name').fill(name)
    const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/accounts/${accountId}/draft`))
    await w('save').click()
    const response = await saved; const detail = (await response.json()).data
    assert.equal(response.status(), 200)
    report.validation = detail.media_workbench_v1.validation
    assert.equal(report.validation.publish_ready, true, JSON.stringify(report.validation.diagnostics))
    report.cases.push('Five-step UI to actual Core save/validation without protocol input')
    report.product = detail.media_workbench_v1.draft.products[0]

    if (geometry) {
      const assertNoMappings = products => { for (const p of products) assert.equal(p.adapter_config.size_mappings?.length || 0, 0, 'UI must not prefill technical size mappings') }
      assertNoMappings([report.product])
      report.first_save_request_products = response.request().postDataJSON().draft.products
      assertNoMappings(report.first_save_request_products)
      const first = structuredClone(report.product)
      // Configure the second independent product through the same UI.
      await page.getByTestId('product-options').locator('summary').click()
      await page.getByTestId('new-independent-product').click()
      await page.getByTestId('confirm-add-product').click()
      for (const value of ['2K', '3:2']) {
        const button = w('wizard-page-1').locator('button.mw-token-chip').filter({ hasText: new RegExp('^'+value+'$') })
        if (!(await button.getAttribute('class')).includes('mw-token-chip-selected')) await button.click()
      }
      await w('wizard-next').click()
      await w('reference-image-mode').selectOption('optional'); await w('reference-image-max').fill('2')
      await w('wizard-next').click(); await w('wizard-next').click()
      await expect(w('price-0')).toHaveValue('')
      await w('price-0').fill('1.30')
      await w('wizard-next').click(); await w('display-name').fill('Synthetic geometry independent price')
      const saveSecond = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/accounts/'+accountId+'/draft'))
      await w('save').click(); const result = await saveSecond
      report.save_request_products = result.request().postDataJSON().draft.products
      const resultBody = (await result.json()).data.media_workbench_v1
      assert.equal(result.status(),200); assert.equal(resultBody.validation.publish_ready,true,JSON.stringify(resultBody.validation.diagnostics))
      assert.equal(resultBody.draft.products.length,2); assertNoMappings(resultBody.draft.products)
      assertNoMappings(report.save_request_products)
      assert.deepEqual(resultBody.draft.products.find(p=>p.product_id===first.product_id),first,'second product must not overwrite first')
      report.products = resultBody.draft.products
      report.cases.push('Two independently priced products configured by five-step UI without technical size mappings')
    } else {
    // Exercise the product selector with two business-equivalent offers that
    // share one canonical upstream model. The duplicate is created through
    // the real admin draft endpoint in the isolated database; no browser
    // fixture intercepts the save or validation response.
    const duplicate = JSON.parse(JSON.stringify(report.product))
    duplicate.product_id = `${report.product.product_id}-same-model`
    const duplicateDraft = [...detail.media_workbench_v1.draft.products, duplicate]
    const duplicateResponse = await page.evaluate(async ({ accountId, version, products }) => {
      const token = localStorage.getItem('auth_token')
      const response = await fetch(`/api/v1/admin/media-workbench/accounts/${accountId}/draft`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-UI-Request': '1',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ expected_record_version: version, draft: { products } })
      })
      return { status: response.status, data: await response.json() }
    }, { accountId, version: detail.media_workbench_v1.record_version, products: duplicateDraft })
    assert.equal(duplicateResponse.status, 200, JSON.stringify(duplicateResponse.data))
    const duplicateDetail = duplicateResponse.data.data
    assert.equal(duplicateDetail.media_workbench_v1.validation.publish_ready, true, JSON.stringify(duplicateDetail.media_workbench_v1.validation.diagnostics))
    report.duplicate_product = duplicate
    report.cases.push('Two same-model products saved through the real draft endpoint')
    }

    await page.reload()
    await w('source-localhost').locator('summary').click()
    await w(`supplier-${accountId}`).click()
    await w(`model-${model}`).click()
    await expect(w('product-select')).toHaveCount(1)
    const productOptions = await w('product-select').locator('option').allTextContents()
    assert.equal(productOptions.length, 2, JSON.stringify(productOptions))
    assert(productOptions.every(option => !option.includes('media-')), JSON.stringify(productOptions))
    if (!geometry) assert(productOptions.some(option => option.includes('商品 1')) && productOptions.some(option => option.includes('商品 2')), JSON.stringify(productOptions))
    if (geometry) {
      for (const p of report.products) {
        await w('product-select').selectOption(p.product_id)
        await w('wizard-step-4').click()
        await expect.poll(async () => Number(await w('price-0').inputValue())).toBe(Number(p.pricing_rules[0].sale_price.amount))
      }
      await w('product-select').selectOption(report.product.product_id)
    }
    report.product_options = productOptions
    await page.screenshot({ path: `${root}/evidence/${prefix}-same-product-selector.png`, fullPage: true })
    report.cases.push('Same-name same-type product selector shows stable business distinction without internal IDs')
    await w('wizard-step-5').click()
    await expect(w('display-name')).toHaveValue(name)
    await page.screenshot({ path: `${root}/evidence/${prefix}-review-desktop.png`, fullPage: true })
    report.cases.push('Saved native product reload preserves specifications and prices')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.reload()
    await w('source-localhost').locator('summary').click()
    await w(`supplier-${accountId}`).click()
    await w(`model-${model}`).click()
    await w('wizard-step-3').click()
    await page.waitForTimeout(500)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile overflow')
    await page.screenshot({ path: `${root}/evidence/${prefix}-dimensions-mobile.png`, fullPage: true, animations: 'disabled' })
    await w('wizard-step-5').click()
    await w('return-models').click()
    await w('publish').click()
    await w('confirm-publish').click()
    await expect(w('sales')).toBeEnabled()
    if ((await w('sales').innerText()).includes('开启')) { await w('sales').click(); await w('confirm-sales').click() }
    await expect(w('sales')).toContainText('暂停')
    report.cases.push('Isolated account publish and sales enabled through normal UI')
  } catch (error) {
    report.error = error.message
    await page.screenshot({ path: `${root}/evidence/native-browser-failure.png`, fullPage: true })
    throw error
  } finally {
    fs.writeFileSync(`${root}/evidence/${prefix}-browser.json`, JSON.stringify(report, null, 2))
    await browser.close()
  }
  console.log(JSON.stringify({ cases: report.cases, publish_ready: report.validation.publish_ready }))
})().catch(error => { console.error(error.message); process.exitCode = 1 })
