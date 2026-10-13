// Real browser -> candidate Core -> isolated PostgreSQL. Only upstream is simulated.
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test')
const root = process.argv[2]
assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')))
const compose = JSON.parse(fs.readFileSync(`${root}/compose.json`, 'utf8'))
assert.equal(compose.services.core.container_name, 'ai-gateway-native-core-20261012')
const fixture = JSON.parse(fs.readFileSync(`${root}/evidence/fixture.json`, 'utf8'))
const base = 'http://127.0.0.1:28100'
const accountId = fixture.accounts.openai
const model = 'gpt-image-2'
const report = { status: 'RUNNING', source_case: 'Account #77 shape; synthetic Account only', account_id: accountId, model, scenarios: [], trace: [] }
const copy = value => JSON.parse(JSON.stringify(value))
const product = {
  product_id: 'synthetic-draft-configured', site_model: model, upstream_model: model, media_type: 'image', display_name: '已配置图片商品', enabled: true,
  capabilities: { resolutions: ['1K'], aspect_ratios: ['1:1'], qualities: [], durations_seconds: [], count: { min: 1, max: 10 }, references: { image: { min: 0, max: 2 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 2 }, combination_rules: [] },
  pricing_rules: [{ match: {}, sale_price: { amount: '0.70', currency: 'CNY', billing_mode: 'per_request' } }],
  // An existing valid mapping isolates count edits from the separate size issue.
  // This test makes no claim that symbolic K labels determine a universal wire grid.
  adapter_config: { size_mappings: [{ resolution: '1K', aspect_ratio: '1:1', wire_size: '1024x1024' }], execution: { mode: 'single', max_output_images: 1 }, edit_execution: { mode: 'single', max_output_images: 1 } }
}
const ids = products => products.map(p => p.product_id).sort()
const commercial = products => products.map(p => ({ id: p.product_id, model: p.upstream_model, name: p.display_name, enabled: p.enabled, capabilities: p.capabilities, prices: p.pricing_rules }))
const execution = config => ({ mode: config?.mode ?? 'single', max: config?.max_output_images ?? 1 })
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(20000)
  const w = id => page.locator(`[data-test="${id}"]`)
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  const api = async (suffix = '', method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const token = localStorage.getItem('auth_token')
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-UI-Request': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const result = await response.json()
    if (!response.ok || result.code !== 0) throw Error(`${response.status}: ${JSON.stringify(result)}`)
    return result.data
  }, { path: `/api/v1/admin/media-workbench/accounts/${accountId}${suffix}`, method, body })
  async function open() {
    await page.goto(base + '/admin/media')
    await w('account-search').fill(`#${accountId}`)
    await w(`supplier-${accountId}`).click()
    await w(`model-${model}`).click()
  }
  async function openTechnical() {
    for (const id of ['advanced-technical', 'image-execution-advanced']) {
      if (await w(id).getAttribute('open') === null) await w(id).locator(':scope > summary').click()
    }
  }
  async function selection(expected) {
    const selected = await w('product-select').count() ? await w('product-select').inputValue() : expected[0]
    const actualIds = await w('product-select').count() ? await w('product-select').locator('option').evaluateAll(options => options.map(option => option.value).sort()) : expected
    assert.deepEqual(actualIds, expected)
    return { selectedProduct: selected, count: actualIds.length, ids: actualIds }
  }
  async function shot(name, target) {
    await page.evaluate(() => document.fonts.ready)
    // The shared AppLayout animates its desktop sidebar margin for 300ms.
    // Wait for actual responsive layout; persistent overflow still fails.
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), { message: 'horizontal overflow after responsive layout settles', timeout: 3000 }).toBe(true)
    await target.scrollIntoViewIfNeeded()
    await target.screenshot({ path: `${root}/evidence/native-draft-${name}.png`, animations: 'disabled' })
  }
  try {
    await page.addInitScript(() => { localStorage.setItem('sub2api_locale', 'zh'); localStorage.setItem('admin_guide_1_admin_v4_interactive', 'true') })
    await page.goto(base + '/login')
    await page.getByLabel('邮箱').fill(compose.services.core.environment.ADMIN_EMAIL)
    await page.getByLabel('密码').fill(compose.services.core.environment.ADMIN_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/dashboard')
    for (const withBlank of [false, true]) {
      const scenario = withBlank ? 'B-configured-and-blank' : 'A-one-product'
      const products = [copy(product)]
      if (withBlank) products.push({ ...copy(product), product_id: 'synthetic-draft-blank', display_name: '未配置单价商品', pricing_rules: [] })
      const previous = await api()
      let detail = await api('/draft', 'PUT', { expected_record_version: previous.media_workbench_v1?.record_version ?? 0, draft: { products } })
      const expectedIds = ids(detail.media_workbench_v1.draft.products)
      const baseline = commercial(detail.media_workbench_v1.draft.products)
      assert.equal(detail.media_workbench_v1.validation.diagnostics.some(d => d.code === 'MODEL_MAPPING_MISMATCH'), false)
      await open()
      report.trace.push({ scenario, stage: 'initial', ...await selection(expectedIds), products: detail.media_workbench_v1.draft.products })
      const steps = [
        ['execution', 'native_multi', 10], ['execution', 'native_multi', 1], ['execution', 'native_multi', 2], ['execution', 'single', 1],
        ['execution', 'native_multi', 10], ['edit_execution', 'native_multi', 10], ['edit_execution', 'native_multi', 1], ['edit_execution', 'native_multi', 2], ['edit_execution', 'single', 1]
      ]
      for (const [field, mode, max] of steps) {
        await openTechnical()
        const prefix = field === 'execution' ? 'image-execution' : 'image-edit-execution'
        const other = field === 'execution' ? 'edit_execution' : 'execution'
        const oldOther = execution(detail.media_workbench_v1.draft.products[0].adapter_config[other])
        await w(`${prefix}-mode`).selectOption(mode)
        if (mode === 'native_multi') {
          await w(`${prefix}-max`).fill('')
          await expect(w(`${prefix}-error`)).toBeVisible()
          assert(['', '0'].includes(await w(`${prefix}-max`).inputValue()), 'must not silently raise empty limit')
          await w(`${prefix}-max`).fill(String(max))
        }
        if (mode === 'native_multi' && max === 1) await expect(w(`${prefix}-error`)).toContainText('2～10')
        else await expect(w(`${prefix}-error`)).toHaveCount(0)
        const inputState = await selection(expectedIds)
        assert.equal(inputState.selectedProduct, product.product_id)
        await w('wizard-step-5').click()
        const pending = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/accounts/${accountId}/draft`))
        await w('save').click()
        const response = await pending
        assert.equal(response.status(), 200)
        const requestProducts = response.request().postDataJSON().draft.products
        detail = (await response.json()).data
        await expect(w('unsaved')).toHaveCount(0)
        const read = await api()
        for (const set of [requestProducts, detail.media_workbench_v1.draft.products, read.media_workbench_v1.draft.products]) assert.deepEqual(ids(set), expectedIds)
        assert.deepEqual(commercial(read.media_workbench_v1.draft.products), baseline, 'count edits must not change specifications or prices')
        assert.deepEqual(execution(read.media_workbench_v1.draft.products[0].adapter_config[other]), oldOther, 'independent execution changed')
        assert.deepEqual(execution(read.media_workbench_v1.draft.products[0].adapter_config[field]), { mode, max })
        assert.equal(read.media_workbench_v1.sales.enabled, false)
        assert(!read.media_workbench_v1.published)
        const diagnostics = read.media_workbench_v1.validation.diagnostics
        const code = field === 'execution' ? 'IMAGE_EXECUTION_CAPABILITY_INVALID' : 'IMAGE_EDIT_EXECUTION_CAPABILITY_INVALID'
        const d = diagnostics.find(d => d.code === code && d.scope === product.product_id)
        if (mode === 'native_multi' && max === 1) {
          assert(d && d.class === 'UI_FIXABLE' && d.path === `adapter_config.${field}.max_output_images`, JSON.stringify(diagnostics))
          await expect(w('adapter-status')).not.toContainText('尚未接通')
          await page.locator('.mw-diagnostic').filter({ hasText: code }).click()
          await expect(w(`${prefix}-max`)).toBeFocused()
          if (field === 'edit_execution') {
            await shot(`${scenario}-edit-error-desktop`, w('image-execution-advanced'))
            await page.setViewportSize({ width: 390, height: 844 })
            await shot(`${scenario}-edit-error-mobile`, w('image-execution-advanced'))
            await page.setViewportSize({ width: 1440, height: 1000 })
          }
        } else assert.equal(d, undefined)
        const missing = diagnostics.filter(d => d.code === 'MISSING_PRICE')
        if (withBlank) {
          assert(missing.length > 0 && missing.every(d => d.scope === 'synthetic-draft-blank'))
          assert(missing.some(d => d.spec_count > 0 && d.specs.length > 0))
        } else assert.equal(missing.length, 0)
        await page.reload()
        await open()
        const reloadedState = await selection(expectedIds)
        assert.equal(reloadedState.selectedProduct, product.product_id)
        report.trace.push({ scenario, field, mode, max, inputState, requestProducts, responseProducts: detail.media_workbench_v1.draft.products, reloadedProducts: read.media_workbench_v1.draft.products, reloadedState, diagnostics })
      }
      if (withBlank) {
        await w('wizard-step-5').click()
        await shot('missing-price-owner', page.locator('.mw-validation'))
        await page.locator('.mw-diagnostic').filter({ hasText: 'MISSING_PRICE' }).first().click()
        await expect(w('product-select')).toHaveValue('synthetic-draft-blank')
        await expect(w('wizard-page-4')).toBeVisible()
        await expect(w('price-0')).toHaveValue('')
        await w('product-select').selectOption(product.product_id)
        await w('wizard-step-4').click()
        await expect(w('price-0')).toHaveValue('0.70')
        report.scenarios.push({ scenario, count: 2, ids: expectedIds, result: 'PASS', price_owner: 'synthetic-draft-blank', configured_unit_price: '0.70', automatic_additions: 0 })
      } else report.scenarios.push({ scenario, count: 1, ids: expectedIds, result: 'PASS', automatic_additions: 0 })
    }
    const state = JSON.parse(fs.readFileSync(`${root}/evidence/native-supplier-state.json`, 'utf8'))
    assert.equal(state.image_posts, 0); assert.equal(state.video_posts, 0)
    report.generation_requests = 0
    report.status = 'PASS'
  } catch (error) {
    report.status = 'FAIL'; report.error = error.stack
    await page.screenshot({ path: `${root}/evidence/native-draft-failure.png`, fullPage: true })
    throw error
  } finally {
    fs.writeFileSync(`${root}/evidence/native-draft-diagnostics.json`, JSON.stringify(report, null, 2))
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
