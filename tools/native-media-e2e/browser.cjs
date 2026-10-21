const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test')
const root = process.argv[2]
assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')))
const compose = JSON.parse(fs.readFileSync(`${root}/compose.json`, 'utf8').replace(/^\uFEFF/, ''))
assert(['ai-gateway-native-core-20261012', 'ai-gateway-native-prerun-core-20261022'].includes(compose.services.core.container_name), 'explicit isolated Core name required')
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
    await expect(w('adapter-status').locator('summary')).toHaveText('已识别账号连接方式')
    await expect(w('adapter-status')).toContainText('识别成功不代表已完成真实生成')
    assert.equal(await w('model-family').count(), 0)
    assert.equal(await w('wire-profile').count(), 0)
    for (const value of video ? ['720p', '16:9'] : ['1K', '2K', '4K', '1:1', ...(geometry ? ['3:2'] : []), '16:9']) {
      const button = w('wizard-page-1').locator('button.mw-token-chip').filter({ hasText: new RegExp(`^${value}$`) })
      if (!(await button.getAttribute('class')).includes('mw-token-chip-selected')) await button.click()
    }
    if (video) {
      const duration = w('wizard-page-1').getByLabel('时长（秒）', { exact: true })
      await duration.fill('5')
      await duration.press('Tab') // MediaTokensField commits the list on change.
      await expect(duration).toHaveValue('5')
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
    if (video) {
      await expect(w('video-sale-editor')).toBeVisible()
      await w('sale-resolution-720p').click()
      await w('video-sale-5').fill('2.00')
      await expect(w('procurement-cost-0')).toHaveCount(0)
    } else {
      for (let i = 0; i < 3; i++) await w(`price-${i}`).fill(geometry ? ['0.70','0.90','1.10'][i] : '0.70')
      await expect(w('procurement-cost-0')).toHaveCount(0)
    }
    await page.waitForTimeout(500)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.screenshot({ path: `${root}/evidence/${prefix}-prices-desktop.png`, fullPage: true })
    await w('wizard-next').click()
    // Capture every concurrent save, then bind the final server receipt to its
    // exact request. A URL-only first-response waiter can select an older autosave.
    const saveResponses = []
    const collectSave = r => { if (r.request().method() === 'PUT' && r.url().endsWith(`/accounts/${accountId}/draft`)) saveResponses.push(r) }
    page.on('response', collectSave)
    let response, detail, readback
    try {
      await w('display-name').fill(name)
      await w('save').click()
      await expect(w('autosave-status').locator(':scope > p').first()).toHaveText('已确认保存')
      readback = await page.evaluate(async accountId => {
        const reply = await fetch(`/api/v1/admin/media-workbench/accounts/${accountId}`, { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } })
        if (!reply.ok) throw Error('Final draft readback rejected')
        return reply.json()
      }, accountId)
      assert.equal(readback.code, 0, 'Final draft readback must return official success')
      const receipt = readback.data.media_workbench_v1.draft.save_receipt
      assert(receipt?.submission_id, 'Final readback has no save receipt')
      response = saveResponses.find(r => r.request().postDataJSON().submission_id === receipt.submission_id)
      assert(response, 'No observed PUT matches final server receipt; refusing stale-save evidence')
      assert.equal(response.status(), 200, 'Final acknowledged PUT failed')
      detail = (await response.json()).data
      const request = response.request().postDataJSON()
      assert(request.draft.products.some(p => p.site_model === model && p.display_name === name), 'Acknowledged submission omitted final model/name edit')
      assert.equal(readback.data.media_workbench_v1.record_version, detail.media_workbench_v1.record_version, 'Final GET and receipt-associated PUT versions differ')
      assert.deepEqual(readback.data.media_workbench_v1.draft, detail.media_workbench_v1.draft, 'Final GET and receipt-associated PUT drafts differ')
    } finally { page.off('response', collectSave) }
    report.validation = detail.media_workbench_v1.validation
    assert.equal(report.validation.publish_ready, true, JSON.stringify(report.validation.diagnostics))
    report.cases.push('Five-step UI to actual Core save/validation without protocol input')
    report.product = detail.media_workbench_v1.draft.products[0]
    assert.equal(report.product.cost_version, 2, 'Both media must use the server-owned sale-only contract')
    assert.equal(report.product.cost_rules?.length || 0, 0, 'New draft must not create procurement rules')
    assert(response.request().postDataJSON().draft.products.every(product => !('cost_rules' in product) && !('cost_version' in product)), 'Browser submitted retired procurement metadata')
    if (video) {
      assert.deepEqual(report.product.capabilities.durations_seconds, [5], 'saved video duration must be 5 seconds')
      assert.equal(report.product.cost_rules?.length || 0, 0, 'video save must not manufacture procurement rules')
      assert.equal(Number(report.product.pricing_rules[0].sale_price.amount), 2, 'whole-video sale must remain 2, not duration multiplied')
      await expect(w('autosave-status').locator(':scope > p').first()).toHaveText('已确认保存')
      const submitted = response.request().postDataJSON()
      const savedConfig = detail.media_workbench_v1
      // Core SaveDraft commits the draft (+1), then validateSaved commits its
      // successful validation snapshot (+1). This isolated ready path has no other writer.
      assert.equal(savedConfig.record_version, submitted.expected_record_version + 2, 'Core must confirm draft and successful validation CAS commits')
      assert.deepEqual(savedConfig.draft.save_receipt, { submission_id: submitted.submission_id, base_record_version: submitted.expected_record_version, draft_revision: savedConfig.draft.revision }, 'Save receipt must confirm this exact submission')
      const calculatorRequests = []
      const recordCalculatorWrite = request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/v1/admin/media-workbench/')) calculatorRequests.push({ method: request.method(), path: new URL(request.url()).pathname }) }
      page.on('request', recordCalculatorWrite)
      for (const width of [1440, 1366, 390]) {
        await page.setViewportSize({ width, height: width === 1366 ? 650 : 844 })
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
        const trigger = w('independent-calculator-open')
        await expect(trigger).toBeVisible()
        const tab = await trigger.boundingBox()
        assert(tab && Math.abs(tab.x + tab.width - width) <= 2, 'Calculator tab must stay on the right edge after scrolling')
        await trigger.click()
        const drawer = page.getByRole('dialog', { name: '成本与利润计算器', exact: true })
        await expect(drawer).toBeVisible()
        const bounds = await drawer.boundingBox()
        assert(bounds && Math.abs(bounds.x + bounds.width - width) <= 2 && bounds.y <= 2, 'Calculator must enter from the right, including mobile')
        await w('independent-purchase').fill('100'); await w('independent-credits').fill('1000'); await w('independent-consumption').fill('15')
        await expect(w('independent-result')).toHaveText('1.5 元')
        await page.screenshot({ path: `${root}/evidence/${prefix}-calculator-${width}.png`, fullPage: false })
        await page.keyboard.press('Escape')
        await expect(drawer).not.toBeVisible()
        await expect(trigger).toBeFocused()
        await expect(w('autosave-status').locator(':scope > p').first()).toHaveText('已确认保存')
      }
      page.off('request', recordCalculatorWrite)
      assert.deepEqual(calculatorRequests, [], 'Independent calculation must not save or mutate a product')
      await page.setViewportSize({ width: 1440, height: 1000 })
      report.cases.push('Final candidate right-side calculator at 1440/1366/390; exact 1.5 reference cost, Escape focus and zero product writes')
    }

    if (geometry) {
      const assertNoMappings = products => { for (const p of products) assert.equal(p.adapter_config.size_mappings?.length || 0, 0, 'UI must not prefill technical size mappings') }
      assertNoMappings([report.product])
      report.first_save_request_products = response.request().postDataJSON().draft.products
      assertNoMappings(report.first_save_request_products)
      const first = structuredClone(report.product)
      // Configure the second independent product through the same UI.
      await w('product-options').locator('summary').click()
      await w('new-independent-product').click()
      await w('confirm-add-product').click()
      for (const value of ['2K', '3:2']) {
        const button = w('wizard-page-1').locator('button.mw-token-chip').filter({ hasText: new RegExp('^'+value+'$') })
        if (!(await button.getAttribute('class')).includes('mw-token-chip-selected')) await button.click()
      }
      await w('wizard-next').click()
      await w('reference-image-mode').selectOption('optional'); await w('reference-image-max').fill('2')
      await w('wizard-next').click(); await w('wizard-next').click()
      await expect(w('price-0')).toHaveValue('')
      await w('price-0').fill('1.30')
      await expect(w('procurement-cost-0')).toHaveCount(0)
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
    if (video) await expect(w('wizard-page-1').getByLabel('时长（秒）', { exact: true })).toHaveValue('5')
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
    for (const checkbox of await w("publish-products").locator("input[type=checkbox]").all()) await checkbox.check()
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
