// Frozen candidate acceptance: real browser, Core/Bridge/BFF and disposable PostgreSQL.
// No browser API fixtures. Only the upstream supplier is simulated.
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test')
const root = process.argv[2]
const mode = process.argv[3]
assert.equal(process.env.GITHUB_ACTIONS, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
assert(['b2fcdac93afa6ae194ee81801a9b37813f8f39eb','40310e2961a5e8150e0c9df4cc86bb8087406c06'].includes(process.env.NATIVE_CANDIDATE_SOURCE_SHA))
assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')))
assert(['seed', 'verify', 'check-preserved'].includes(mode))
const compose = JSON.parse(fs.readFileSync(`${root}/compose.json`, 'utf8'))
assert.equal(compose.services.core.container_name, 'ai-gateway-native-core-20261012')
assert.equal(compose.services.postgres.container_name, 'ai-gateway-native-postgres-20261012')
assert.equal(compose.services.core.environment.ADMIN_EMAIL, 'native-admin@example.invalid')
const fixture = JSON.parse(fs.readFileSync(`${root}/evidence/fixture.json`, 'utf8'))
const reportPath = `${root}/evidence/native-draft-management.json`
const copy = value => JSON.parse(JSON.stringify(value))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ids = products => products.map(p => p.product_id).sort()
const db = sql => execFileSync('docker', ['exec', '-i', 'ai-gateway-native-postgres-20261012', 'psql', '-U', 'native', '-d', 'sub2api', '-At', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' }).trim()
const definitions = [
  { kind: 'image', account: fixture.accounts.gemini, model: 'gemini-3.1-flash-image', resolution: '1K', ratio: '1:1', amount: '0.70' },
  { kind: 'video', account: fixture.accounts.compatible, model: 'synthetic-compatible-video', resolution: '720p', ratio: '16:9', amount: '2.00' }
]
for (const d of definitions) assert(Number.isSafeInteger(d.account) && d.account > 0)
const blank = (d, i) => ({ product_id: `${d.kind}-blank-${i}`, site_model: d.model, upstream_model: d.model, media_type: d.kind, display_name: `隔离${d.kind === 'image' ? '图片' : '视频'}空白草稿 ${i}`, enabled: false,
  capabilities: { resolutions: [], aspect_ratios: [], qualities: [], durations_seconds: [], count: { min: 1, max: d.kind === 'image' ? 10 : 1 }, references: { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }, combination_rules: [] }, pricing_rules: [], adapter_config: { size_mappings: [] } })
const configured = d => ({ ...blank(d, 0), product_id: `${d.kind}-configured`, display_name: `已配置${d.kind === 'image' ? '图片' : '视频'}商品`, enabled: true,
  capabilities: { ...blank(d, 0).capabilities, resolutions: [d.resolution], aspect_ratios: [d.ratio], durations_seconds: d.kind === 'video' ? [5] : [], references: { ...blank(d, 0).capabilities.references, image: { min: 0, max: 2 }, total_max: 2 } },
  pricing_rules: [{ match: {}, sale_price: { amount: d.amount, currency: 'CNY', billing_mode: 'per_request' } }] })
function protectedState() {
  // Never inspect a production database: container name, credentials and test
  // customer identity are fixed to the existing disposable candidate harness.
  const customer = Number(fixture.customer)
  assert(Number.isSafeInteger(customer) && customer > 0)
  const ledger = JSON.parse(db(`select json_build_object('balance',balance,'frozen_balance',frozen_balance,'usage_count',(select count(*) from usage_logs where user_id=${customer}),'video_count',(select count(*) from studio_video_orders where user_id=${customer}),'usage_hash',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from usage_logs t where user_id=${customer}),'video_hash',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'[]')) from studio_video_orders t where user_id=${customer})) from users where id=${customer};`))
  const supplier = JSON.parse(fs.readFileSync(`${root}/evidence/native-supplier-state.json`, 'utf8'))
  return { ledger, image_posts: supplier.image_posts, video_posts: supplier.video_posts }
}
;(async () => {
  if (mode === 'check-preserved') {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    const browser = await chromium.launch({ channel: 'chrome', headless: true })
    const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
    page.setDefaultTimeout(20000)
    const base = 'http://127.0.0.1:28100'
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    report.recovery = []
    try {
      await page.addInitScript(() => { localStorage.setItem('sub2api_locale', 'zh'); localStorage.setItem('user_guide_2_user_v4_interactive', 'true') })
      await page.goto(base + '/login')
      await page.getByLabel('邮箱').fill('native-customer@example.invalid')
      await page.getByLabel('密码').fill('Native-Customer-Only-20261012')
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.waitForURL('**/dashboard')
      for (const scenario of ['image', 'video-compatible']) {
        const prior = JSON.parse(fs.readFileSync(`${root}/evidence/native-customer-${scenario}.json`, 'utf8'))
        assert(prior.pass && prior.downloads.length > 0)
        const kind = scenario === 'image' ? 'image' : 'video'
        await page.goto(base + '/video-studio')
        // onMounted restores the saved kind after ensureStudioSession; wait
        // for the actual catalog just as the existing customer harness does.
        await expect.poll(() => page.getByTestId('studio-offer-select').locator('option').count()).toBeGreaterThan(0)
        await expect(page.getByTestId('studio-kind')).toBeEnabled()
        if (await page.getByTestId('studio-kind').inputValue() !== kind) await page.getByTestId('studio-kind').selectOption(kind)
        await page.locator(`[data-task-id="${prior.id}"]`).click()
        await expect(page.getByTestId('studio-task-id')).toContainText(prior.id)
        await expect(page.getByTestId('studio-status')).toContainText('生成完成')
        await expect(page.getByTestId('studio-refresh')).toBeEnabled()
        await page.getByTestId('studio-refresh').click()
        await expect(page.getByTestId('studio-refresh')).toBeEnabled()
        const downloads = []
        for (let i = 0; i < prior.downloads.length; i++) {
          const pending = page.waitForEvent('download')
          await page.getByTestId('studio-download').nth(i).click()
          const download = await pending
          assert.equal(await download.failure(), null)
          const bytes = fs.readFileSync(await download.path())
          const proof = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
          assert.deepEqual(proof, prior.downloads[i])
          downloads.push(proof)
        }
        await page.getByTestId('studio-media-panel').screenshot({ path: `${root}/evidence/native-draft-management-${kind}-history.png` })
        report.recovery.push({ scenario, task_id: prior.id, downloads, original_bytes_unchanged: true })
      }
      const afterRecovery = protectedState()
      assert.deepEqual(afterRecovery, report.protected_before, 'history recovery changed requests or native billing')
      report.protected_after_recovery = afterRecovery
      report.status = 'PASS'
    } catch (error) {
      report.status = 'FAIL'; report.error = error.message
      await page.screenshot({ path: `${root}/evidence/native-draft-management-recovery-failure.png`, fullPage: true }).catch(() => {})
      throw error
    } finally {
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
      await browser.close()
    }
    console.log(JSON.stringify({ status: report.status, cases: report.scenarios.length, history_and_billing: 'unchanged' }))
    return
  }
  const report = { status: 'RUNNING', candidate_source_sha: process.env.NATIVE_CANDIDATE_SOURCE_SHA, script_sha: process.env.GITHUB_SHA, browser_api_mocking: false, production_action: false, scenarios: [], trace: [], http: [] }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(20000)
  const base = 'http://127.0.0.1:28100'
  const w = id => page.locator(`[data-test="${id}"]`)
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  page.on('response', r => { if (r.url().startsWith(base + '/api/v1/admin/media-workbench/')) report.http.push({ path: new URL(r.url()).pathname, method: r.request().method(), status: r.status() }) })
  const request = async (account, suffix = '', method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
    const token = localStorage.getItem('auth_token')
    const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Admin-UI-Request': '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    return { status: response.status, value: await response.json() }
  }, { path: `/api/v1/admin/media-workbench/accounts/${account}${suffix}`, method, body })
  const api = async (...args) => { const r = await request(...args); assert.equal(r.status, 200, JSON.stringify(r)); assert.equal(r.value.code, 0); return r.value.data }
  const save = async (d, detail, products) => api(d.account, '/draft', 'PUT', { expected_record_version: detail.media_workbench_v1?.record_version || 0, draft: { products } })
  const open = async d => {
    await page.goto(base + '/admin/media')
    await w('account-search').fill(`#${d.account}`)
    await w(`supplier-${d.account}`).click()
    await w(`model-${d.model}`).click()
    await expect(w('product-management')).toBeVisible()
  }
  const options = async () => { if (await w('product-options').getAttribute('open') === null) await w('product-options').locator('summary').click() }
  const selection = async () => ({ selectedProduct: await w('product-select').inputValue(), ids: await w('product-select').locator('option').evaluateAll(all => all.map(o => o.value).sort()) })
  const shot = async name => {
    await page.evaluate(() => document.fonts.ready)
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
    await w('product-management').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${root}/evidence/native-draft-management-${name}.png`, fullPage: true, animations: 'disabled' })
  }
  const saveUI = async d => {
    await w('wizard-step-5').click()
    const pending = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/accounts/${d.account}/draft`))
    await w('save').click()
    const response = await pending
    assert.equal(response.status(), 200)
    await expect(w('unsaved')).toHaveCount(0)
    return { request: response.request().postDataJSON(), response: (await response.json()).data, reread: await api(d.account) }
  }
  try {
    await page.addInitScript(() => { localStorage.setItem('sub2api_locale', 'zh'); localStorage.setItem('admin_guide_1_admin_v4_interactive', 'true') })
    await page.goto(base + '/login')
    await page.getByLabel('邮箱').fill(compose.services.core.environment.ADMIN_EMAIL)
    await page.getByLabel('密码').fill(compose.services.core.environment.ADMIN_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/dashboard')
    if (mode === 'seed') {
      for (const d of definitions) {
        const first = configured(d)
        // A previously published offer may now have an empty current draft.
        // Publish both synthetic snapshots through the normal service before
        // constructing the seven-draft management fixture.
        const priorPublished = { ...copy(first), product_id: `${d.kind}-blank-4`, display_name: '隔离旧发布商品' }
        let detail = await save(d, await api(d.account), [first, priorPublished])
        assert.equal(detail.media_workbench_v1.validation.publish_ready, true, JSON.stringify(detail.media_workbench_v1.validation))
        await api(d.account, '/publish', 'POST', { expected_record_version: detail.media_workbench_v1.record_version, expected_draft_revision: detail.media_workbench_v1.draft.revision })
        detail = await api(d.account)
        await api(d.account, '/sales', 'PUT', { expected_record_version: detail.media_workbench_v1.record_version, enabled: true })
      }
      return
    }
    report.protected_before = protectedState()
    assert(report.protected_before.ledger.usage_count >= 2 && report.protected_before.ledger.video_count === 1, 'real synthetic history and billing rows required')
    for (const d of definitions) {
      await page.setViewportSize({ width: 1440, height: 1000 })
      let detail = await api(d.account)
      const first = copy(detail.media_workbench_v1.draft.products.find(p => p.product_id === `${d.kind}-configured`))
      const published = copy(detail.media_workbench_v1.published)
      detail = await save(d, detail, [first, ...Array.from({ length: 6 }, (_, i) => blank(d, i + 1))])
      // Procurement has no public authoring endpoint. Seed only this synthetic
      // Account's existing JSON field before taking the acceptance baseline.
      const procurement = { revision: 1, entries: [{ product_id: `${d.kind}-blank-5`, cost: { amount: '0.25', currency: 'CNY', billing_mode: 'per_request' }, source: 'isolated retained procurement fixture', observed_at: '2026-10-14T00:00:00Z' }] }
      const changed = db(`update accounts set extra=jsonb_set(extra,'{media_workbench_v1,procurement}','${JSON.stringify(procurement)}'::jsonb,true) where id=${d.account} and name like 'Synthetic %' returning id;`)
      assert(changed.includes(String(d.account)))
      detail = await api(d.account)
      const baseline = copy(detail.media_workbench_v1)
      assert.deepEqual(baseline.published, published)
      const expectedIds = ids(baseline.draft.products)
      assert.equal(expectedIds.length, 7)
      assert.deepEqual(baseline.draft.products[0], first)
      await open(d)
      await expect(w('product-enabled')).toBeVisible()
      await expect(page.getByRole('button', { name: /添加.*产品/ })).toHaveCount(0)
      report.trace.push({ kind: d.kind, stage: 'initial-seven', ...await selection(), config: baseline })
      // Normal UI save and refresh must preserve all product identities and prices.
      const ordinary = await saveUI(d)
      assert.deepEqual(ordinary.reread.media_workbench_v1.draft.products, baseline.draft.products)
      assert.deepEqual(ordinary.reread.media_workbench_v1.published, baseline.published)
      report.trace.push({ kind: d.kind, stage: 'normal-save', ids: ids(ordinary.request.draft.products), selectedProduct: (await selection()).selectedProduct })
      detail = ordinary.reread
      // Reuse the accepted execution-limit regressions. This candidate test
      // edits a business field available on both media types, not a quantity
      // mode deliberately absent from a fixed-by-model native adapter.
      for (const name of [first.display_name + ' · 隔离编辑', first.display_name]) {
        await w('wizard-step-5').click()
        await w('display-name').fill(name)
        const edited = await saveUI(d)
        const current = edited.reread.media_workbench_v1.draft.products
        assert.deepEqual(ids(current), expectedIds)
        assert.deepEqual(current[0], { ...first, display_name: name })
        assert.deepEqual(current.slice(1), baseline.draft.products.slice(1))
        report.trace.push({ kind: d.kind, stage: 'business-name-edit-save', ids: expectedIds, selectedProduct: (await selection()).selectedProduct })
      }
      await open(d)
      for (const id of [`${d.kind}-blank-1`, `${d.kind}-blank-6`, first.product_id]) await w('product-select').selectOption(id)
      await options()
      await expect(w('remove-blank-product')).toHaveCount(0)
      await expect(w('removal-protection')).toContainText('已发布')
      await shot(`${d.kind}-desktop`)
      const beforeLocal = (await api(d.account)).media_workbench_v1
      await w('new-independent-product').click()
      await expect(page.getByRole('dialog', { name: '另建独立销售商品？' })).toBeVisible()
      await page.keyboard.press('Escape')
      assert.deepEqual((await selection()).ids, expectedIds)
      await w('new-independent-product').click()
      await w('confirm-add-product').evaluate(button => { button.click(); button.click() })
      await expect(w('product-select').locator('option')).toHaveCount(8)
      const newId = (await selection()).selectedProduct
      await options(); await w('new-independent-product').click(); await w('confirm-add-product').click()
      await expect(w('product-select').locator('option')).toHaveCount(8)
      assert.equal((await selection()).selectedProduct, newId)
      await w('undo-add-product').click()
      assert.deepEqual((await selection()).ids, expectedIds)
      assert.deepEqual((await api(d.account)).media_workbench_v1, beforeLocal, 'unsaved creation changed persisted state')
      report.scenarios.push(`${d.kind}: confirmation, repeated trigger and undo without persistence`)
      for (const [reason, target, explicit] of [['implicit-omission', `${d.kind}-blank-2`, false], ['nonblank', first.product_id, true], ['published-empty-draft', `${d.kind}-blank-4`, true], ['procurement-linked', `${d.kind}-blank-5`, true]]) {
        const c = (await api(d.account)).media_workbench_v1
        const response = await request(d.account, '/draft', 'PUT', { expected_record_version: c.record_version, draft: { products: c.draft.products.filter(p => p.product_id !== target), ...(explicit ? { remove_product_ids: [target] } : {}) } })
        assert.equal(response.status, 422, JSON.stringify(response))
        assert.equal(response.value.reason, 'MEDIA_DRAFT_REMOVAL_BLOCKED')
        assert.deepEqual((await api(d.account)).media_workbench_v1, c, 'rejected removal wrote state')
        report.scenarios.push(`${d.kind}: ${reason} rejected without database changes`)
      }
      const target = `${d.kind}-blank-3`
      await w('product-select').selectOption(target)
      await expect(w('product-status')).toContainText('已停用')
      await page.setViewportSize({ width: 390, height: 844 })
      await options(); await shot(`${d.kind}-mobile`)
      await w('remove-blank-product').click()
      await page.screenshot({ path: `${root}/evidence/native-draft-management-${d.kind}-confirm.png`, fullPage: true })
      await w('confirm-remove-product').click()
      await expect(w('product-select').locator('option')).toHaveCount(6)
      await w(`undo-removal-${target}`).click()
      await expect(w('product-select').locator('option')).toHaveCount(7)
      await options(); await w('remove-blank-product').click(); await w('confirm-remove-product').click()
      const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/accounts/${d.account}/draft`))
      await w('save-removals').click()
      const response = await saved
      assert.equal(response.status(), 200)
      assert.deepEqual(response.request().postDataJSON().draft.remove_product_ids, [target])
      await expect(w('pending-removals')).toHaveCount(0)
      const after = (await api(d.account)).media_workbench_v1
      assert.deepEqual(after.draft.products, baseline.draft.products.filter(p => p.product_id !== target))
      assert.deepEqual(after.removed_draft_products, [baseline.draft.products.find(p => p.product_id === target)])
      for (const field of ['published', 'sales', 'procurement']) assert.deepEqual(after[field], baseline[field], field)
      await open(d)
      await expect(w('product-select').locator('option')).toHaveCount(6)
      await w('product-select').selectOption(first.product_id)
      await shot(`${d.kind}-saved-six`)
      report.trace.push({ kind: d.kind, stage: 'saved-reread-six', ...await selection(), request: response.request().postDataJSON(), config: after, first_before_sha256: digest(first), first_after_sha256: digest(after.draft.products[0]) })
      report.scenarios.push(`${d.kind}: explicit 7-to-6 removal, first product and all other state unchanged`)
    }
    report.protected_after = protectedState()
    assert.deepEqual(report.protected_after, report.protected_before)
    report.status = 'DRAFT_OPERATIONS_PASS_RECOVERY_PENDING'
  } catch (error) {
    report.status = 'FAIL'; report.error = error.message
    await page.screenshot({ path: `${root}/evidence/native-draft-management-failure.png`, fullPage: true }).catch(() => {})
    throw error
  } finally {
    if (mode !== 'seed') fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
    await browser.close()
  }
})().catch(error => { console.error(error.message); process.exitCode = 1 })
