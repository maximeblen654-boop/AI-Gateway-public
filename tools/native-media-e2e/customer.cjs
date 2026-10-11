const fs = require('node:fs')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test')
const root = process.argv[2]
assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')))
const base = 'http://127.0.0.1:28100'
const scenario = process.argv[3] || 'image'
assert(['image', 'edit', 'video'].includes(scenario))
const video = scenario === 'video'; const kind = video ? 'video' : 'image'; const count = video ? 1 : scenario === 'edit' ? 2 : 3
const docker = (...args) => execFileSync('docker', [...(process.platform === 'win32' ? ['--context', 'desktop-linux'] : []), ...args], { windowsHide: true, encoding: 'utf8' })
const stats = () => JSON.parse(fs.readFileSync(`${root}/evidence/native-supplier-state.json`, 'utf8'))
const ledger = () => JSON.parse(docker('exec', 'ai-gateway-native-postgres-20261012', 'psql', '-U', 'native', '-d', 'sub2api', '-At', '-c', "select json_build_object('balance',balance,'frozen_balance',frozen_balance,'usage',(select count(*) from usage_logs where user_id=2),'video_captured',(select count(*) from studio_video_orders where user_id=2 and state='CAPTURED')) from users where id=2"))
const reportPath = `${root}/evidence/native-customer-${scenario}.json`
const recover = process.argv.includes('--recover')
const prior = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null
assert(recover || !prior?.id || prior.pass, 'Previous task exists: use --recover, do not submit again')
const report = recover ? prior : { scenario, http: [] }
assert(report && (!recover || report.id), 'Original task evidence is required for recovery')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage(); page.setDefaultTimeout(20000)
  page.on('response', async r => { if (r.url().startsWith(base+'/studio-v2/api/')) report.http.push({ method: r.request().method(), path: new URL(r.url()).pathname, status: r.status(), ...(r.status() >= 400 ? { error: await r.json().catch(() => null) } : {}) }) })
  await page.addInitScript(() => { localStorage.setItem('sub2api_locale', 'zh'); localStorage.setItem('user_guide_2_user_v4_interactive', 'true') })
  try {
    await page.goto(base+'/login'); await page.getByLabel('邮箱').fill('native-customer@example.invalid'); await page.getByLabel('密码').fill('Native-Customer-Only-20261012')
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/dashboard')
    await page.goto(base+'/video-studio')
    await expect.poll(() => page.getByTestId('studio-offer-select').locator('option').count()).toBeGreaterThan(0)
    await expect(page.getByTestId('studio-kind')).toBeEnabled()
    if ((await page.getByTestId('studio-kind').inputValue()) !== kind) await page.getByTestId('studio-kind').selectOption(kind)
    await expect(page.getByTestId('studio-kind')).toBeEnabled()
    if (recover) {
      await page.locator(`[data-task-id="${report.id}"]`).click()
      report.recovered = true
    } else {
    if (await page.getByTestId('studio-new').isVisible()) await page.getByTestId('studio-new').click()
    const catalog = await page.evaluate(async kind => (await fetch(`/studio-v2/api/${kind}/catalog`, { headers: { 'X-Studio-Request': `${kind}-binding-v1` } })).json(), kind)
    report.catalog = catalog
    const offer = catalog.offers?.find(o => o.upstream_model === (video ? 'grok-imagine-video' : 'gemini-3.1-flash-image') || o.model === (video ? 'grok-imagine-video' : 'gemini-3.1-flash-image'))
    assert(offer, JSON.stringify(catalog))
    await page.getByTestId('studio-offer-select').selectOption(offer.offer_id)
    if (!video) await page.getByTestId('studio-count').fill(String(count))
    if (scenario === 'edit') {
      await page.getByTestId('studio-asset-input').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') })
      await expect(page.getByTestId('studio-kind')).toBeEnabled()
    }
    await page.getByTestId('studio-prompt').fill(`SYNTHETIC native ${scenario} ${randomUUID()}`)
    report.before = { supplier: stats(), ledger: ledger() }
    const quote = page.waitForResponse(r => r.url().endsWith(`/studio-v2/api/${kind}/${video ? 'quotes' : 'prepare'}`) && r.request().method() === 'POST')
    await page.getByTestId('studio-quote').click(); const response = await quote
    report.quote = await response.json(); assert.equal(response.status(), 200, JSON.stringify(report.quote))
    report.id = report.quote.task_id || report.quote.operation_id
    assert.equal(Math.round(Number(report.quote.sale_price.amount) * 100), video ? 200 : count * 70)
    const submitted = page.waitForResponse(r => r.url().endsWith(`/studio-v2/api/${kind}/tasks`) && r.request().method() === 'POST')
    await page.getByTestId('studio-generate').click(); const submit = await submitted
    report.submit = { status: submit.status(), body: await submit.json() }
    }
    await expect(page.getByTestId('studio-status')).toContainText('生成完成', { timeout: 60000 })
    await expect(page.getByTestId(video ? 'studio-result-video' : 'studio-result-image')).toHaveCount(count)
    report.downloads = []
    for (let i = 0; i < count; i++) {
      const pending = page.waitForEvent('download'); await page.getByTestId('studio-download').nth(i).click(); const download = await pending
      assert.equal(await download.failure(), null); const bytes = fs.readFileSync(await download.path())
      report.downloads.push({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      assert(bytes.length > 0)
    }
    report.after = { supplier: stats(), ledger: ledger() }
    assert.equal(report.after.supplier[`${kind}_posts`] - report.before.supplier[`${kind}_posts`], count)
    assert.equal(Math.round((report.before.ledger.balance - report.after.ledger.balance) * 100), video ? 200 : count * 70)
    assert.equal(report.after.ledger.usage - report.before.ledger.usage, 1)
    await page.reload(); await expect(page.getByTestId('studio-task-id')).toContainText(report.id)
    await expect(page.getByTestId('studio-status')).toContainText('生成完成')
    assert.equal(stats()[`${kind}_posts`], report.after.supplier[`${kind}_posts`])
    assert.deepEqual(ledger(), report.after.ledger)
    await page.getByTestId('studio-media-panel').screenshot({ path: `${root}/evidence/native-customer-${scenario}.png` })
    report.pass = true
    delete report.error
  } catch (error) { report.error = error.message; await page.screenshot({ path: `${root}/evidence/native-customer-${scenario}-failure.png`, fullPage: true }); throw error }
  finally { fs.writeFileSync(`${root}/evidence/native-customer-${scenario}.json`, JSON.stringify(report, null, 2)); await browser.close() }
  console.log(JSON.stringify({ scenario, pass: true, id: report.id, delivered: count }))
})().catch(error => { console.error(error.message); process.exitCode = 1 })
