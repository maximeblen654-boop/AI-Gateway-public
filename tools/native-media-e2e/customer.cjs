const fs = require('node:fs')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test')
const root = process.argv[2]
assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')))
const base = 'http://127.0.0.1:28100'
const artifact = process.env.NATIVE_WORKSPACE_ARTIFACT === 'true'
const workspace=process.env.NATIVE_WORKSPACE_UI==='true'
const scenario = process.argv[3] || 'image'
const geometryCases = {
  'image-geometry-free': { resolution:'1K', ratio:'1:1', cents:0, count:1 },
  'image-geometry-1k': { resolution:'1K', ratio:'1:1', cents:70, count:3 },
  'image-geometry-2k': { resolution:'2K', ratio:'3:2', cents:90, count:1 },
  'image-geometry-4k': { resolution:'4K', ratio:'16:9', cents:110, count:1 },
  'edit-geometry-1k': { resolution:'1K', ratio:'1:1', cents:70, count:1, edit:true },
  'edit-geometry-2k': { resolution:'2K', ratio:'3:2', cents:90, count:2, edit:true },
  'edit-geometry-4k': { resolution:'4K', ratio:'16:9', cents:110, count:1, edit:true },
  'image-geometry-independent': { resolution:'2K', ratio:'3:2', cents:130, count:1, independent:true }
}
const geometry = geometryCases[scenario] ? { ...geometryCases[scenario], ...(process.env.NATIVE_QUOTE_DRIFT === 'draft' ? { count: 3 } : {}) } : undefined
assert(geometry || ['image', 'edit', 'video', 'video-compatible', 'video-seedance'].includes(scenario))
const videoMode = scenario === 'video-seedance' ? 'seedance' : scenario === 'video-compatible' ? 'compatible' : scenario === 'video' ? 'grok' : null
const video = Boolean(videoMode); const kind = video ? 'video' : 'image'; const count = geometry ? geometry.count : video ? 1 : scenario === 'edit' ? 2 : 3
const videoModel = ({ grok: 'grok-imagine-video', compatible: 'synthetic-compatible-video', seedance: 'synthetic-seedance-video' })[videoMode]
const docker = (...args) => execFileSync('docker', [...(process.platform === 'win32' ? ['--context', 'desktop-linux'] : []), ...args], { windowsHide: true, encoding: 'utf8' })
const stats = () => JSON.parse(fs.readFileSync(`${root}/evidence/native-supplier-state.json`, 'utf8'))
let testCustomer = { id: 2, email: 'native-customer@example.invalid' }
const ledger = () => {
  assert(Number.isSafeInteger(testCustomer.id) && testCustomer.id > 0)
  return JSON.parse(docker('exec', 'ai-gateway-native-postgres-20261012', 'psql', '-U', 'native', '-d', 'sub2api', '-At', '-c', `select json_build_object('balance',balance,'frozen_balance',frozen_balance,'usage',(select count(*) from usage_logs where user_id=${testCustomer.id}),'video_captured',(select count(*) from studio_video_orders where user_id=${testCustomer.id} and state='CAPTURED')) from users where id=${testCustomer.id}`))
}
const drift = process.env.NATIVE_QUOTE_DRIFT
assert(!drift || process.env.NATIVE_ACCEPTANCE_SCENARIO === 'admin-ui-review')
const reportPath = `${root}/evidence/native-customer-${scenario}${drift ? '-'+drift : ''}.json`
const recover = process.argv.includes('--recover')
const prior = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : null
assert(recover || !prior?.id || prior.pass, 'Previous task exists: use --recover, do not submit again')
const report = recover ? prior : { scenario, http: [] }
assert(report && (!recover || report.id), 'Original task evidence is required for recovery')
;(async () => {
  if (drift) {
    // Rejected tasks remain recoverable and locked. Independent cases use independent owners.
    testCustomer = recover ? prior.customer : await require('./quote-drift.cjs').createCustomer(root, drift)
    assert(testCustomer && Number.isSafeInteger(testCustomer.id))
    report.customer = testCustomer
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: artifact && scenario === 'edit' ? { width: 390, height: 844 } : { width: 1440, height: 1000 } })
  const page = await context.newPage(); page.setDefaultTimeout(20000)
  const artifactProof = artifact ? require('./artifact-assets.cjs')(page) : null
  page.on('response', async r => { if (r.url().startsWith(base+'/studio-v2/api/')) report.http.push({ method: r.request().method(), path: new URL(r.url()).pathname, status: r.status(), ...(r.status() >= 400 ? { error: await r.json().catch(() => null) } : {}) }) })
  await page.addInitScript(() => { localStorage.setItem('sub2api_locale', 'zh'); localStorage.setItem('user_guide_2_user_v4_interactive', 'true') })
  let restoreDrift
  try {
    await page.goto(base+'/login'); await page.getByLabel('邮箱').fill(testCustomer.email); await page.getByLabel('密码').fill('Native-Customer-Only-20261012')
    await page.getByRole('button', { name: '登录', exact: true }).click(); await page.waitForURL('**/dashboard')
    const loadedHistory = video && !workspace ? page.waitForResponse(r => r.url().endsWith('/studio-v2/api/video/operations') && r.request().method() === 'GET') : null
    await page.goto(base+'/video-studio')
    const existingTasks = loadedHistory ? await (await loadedHistory).json() : []
    await expect.poll(() => page.getByTestId('studio-offer-select').locator('option').count()).toBeGreaterThan(0)
    if(workspace){
      await page.getByTestId(video?'studio-mode-video':scenario==='edit'||geometry?.edit?'studio-mode-edit':'studio-mode-text').click()
      await expect(page.getByTestId('studio-model-toggle')).toBeEnabled()
    }else{
    await expect(page.getByTestId('studio-kind')).toBeEnabled()
    if ((await page.getByTestId('studio-kind').inputValue()) !== kind) await page.getByTestId('studio-kind').selectOption(kind)
    await expect(page.getByTestId('studio-kind')).toBeEnabled()
    }
    if (recover) {
      await page.locator(`[data-task-id="${report.id}"]`).click()
      report.recovered = true
    } else {
    if (video && existingTasks.length) {
      // The page restores the last server task before enabling a new one.
      // Wait for that recovery to finish, then use the visible New Task action.
      await expect(page.getByTestId('studio-status')).toContainText('生成完成')
      await expect(page.getByTestId('studio-refresh')).toBeEnabled()
      await page.getByTestId('studio-new').click()
    } else if (await page.getByTestId('studio-new').isVisible()) await page.getByTestId('studio-new').click()
    if(workspace)await page.getByTestId('studio-model-toggle').click()
    await expect(page.getByTestId('studio-offer-select')).toBeEnabled()
    const catalog = await page.evaluate(async kind => (await fetch(`/studio-v2/api/${kind}/catalog`, { headers: { 'X-Studio-Request': `${kind}-binding-v1` } })).json(), kind)
    report.catalog = catalog
    const offerModel = video ? videoModel : geometry ? 'gpt-image-2' : 'gemini-3.1-flash-image'
    const geometryProduct = geometry ? JSON.parse(fs.readFileSync(root+'/evidence/native-geometry-browser.json','utf8')).products.find(p=>p.display_name === (geometry.independent ? 'Synthetic geometry independent price' : 'Synthetic geometry image')) : null
    assert(!geometry || geometryProduct, 'saved UI product identity is required')
    const offer = catalog.offers?.find(o => (o.upstream_model === offerModel || o.model === offerModel) && (!geometry || (o.product_id === geometryProduct.product_id && o.spec.resolution.includes(geometry.resolution))))
    assert(offer, JSON.stringify(catalog))
    await page.getByTestId('studio-offer-select').selectOption(offer.offer_id)
    if (!video) {if(workspace){await page.getByTestId('studio-count').click();await page.locator(`#studio-count-menu [data-value="${count}"]`).click()}else await page.getByTestId('studio-count').fill(String(count))}
    if (geometry) {
      if(workspace){await page.getByTestId('studio-resolution').click();await page.locator('#studio-resolution-menu [data-value]').filter({hasText:geometry.resolution}).click()}else await page.getByTestId('studio-resolution').selectOption(geometry.resolution)
      if(workspace){await page.getByTestId('studio-ratio-toggle').click();await page.locator(`[data-ratio="${geometry.ratio}"]`).click()}else await page.getByTestId('studio-ratio').selectOption(geometry.ratio)
    }
    if (scenario === 'edit' || geometry?.edit) {
      await page.getByTestId('studio-asset-input').setInputFiles({ name: 'reference.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') })
      await expect(page.getByTestId(workspace?'studio-model-toggle':'studio-kind')).toBeEnabled()
    }
    await page.getByTestId('studio-prompt').fill(`SYNTHETIC native ${scenario} ${randomUUID()}`)
    report.before = { supplier: stats(), ledger: ledger() }
    const quote = page.waitForResponse(r => r.url().endsWith(`/studio-v2/api/${kind}/${video ? 'quotes' : 'prepare'}`) && r.request().method() === 'POST')
    await page.getByTestId('studio-quote').click(); const response = await quote
    report.quote = await response.json(); assert.equal(response.status(), 200, JSON.stringify(report.quote))
    report.id = report.quote.task_id || report.quote.operation_id
    assert.equal(Math.round(Number(report.quote.sale_price.amount) * 100), video ? 200 : count * (geometry?.cents ?? 70))
    if (artifact) {
      assert.equal(stats()[`${kind}_posts`], report.before.supplier[`${kind}_posts`], 'quote must not generate')
      assert.equal(ledger().usage, report.before.ledger.usage, 'quote must not settle')
      report.quote_before_submit = { generated: 0, settled: 0, viewport: page.viewportSize() }
      await expect(page.getByTestId('studio-confirm-generate')).toBeVisible()
      await page.screenshot({ path: `${root}/evidence/native-artifact-${scenario}-confirmation.png`, fullPage: true })
    }
    if (drift) restoreDrift = await require('./quote-drift.cjs')(root, drift, report)
    const submitted = page.waitForResponse(r => r.url().endsWith(`/studio-v2/api/${kind}/tasks`) && r.request().method() === 'POST')
    await page.getByTestId(workspace?'studio-confirm-generate':'studio-generate').click(); const submit = await submitted
    report.submit = { status: submit.status(), body: await submit.json() }
    if (drift && drift !== 'draft') {
      assert(submit.status() >= 400 || ['failed','unknown'].includes(report.submit.body?.status), JSON.stringify(report.submit))
      assert.equal(stats().image_posts, report.before.supplier.image_posts, 'stale quote must never reach upstream')
      assert.deepEqual(ledger(), report.before.ledger, 'stale quote must not charge')
      report.after = { supplier: stats(), ledger: ledger() }; report.pass = true; report.rejected_before_generation = true
      return
    }
    }
    await expect(page.getByTestId('studio-status')).toContainText('生成完成', { timeout: 60000 })
    await expect(page.getByTestId(video ? 'studio-result-video' : 'studio-result-image')).toHaveCount(count)
    report.downloads = []
    if (video) report.original_sha256 = createHash('sha256').update(fs.readFileSync(`${root}/evidence/synthetic-original.mp4`)).digest('hex')
    if (workspace && !video) report.original_sha256 = createHash('sha256').update(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')).digest('hex')
    for (let i = 0; i < count; i++) {
      const pending = page.waitForEvent('download'); await page.getByTestId('studio-download').nth(i).click(); const download = await pending
      assert.equal(await download.failure(), null); const bytes = fs.readFileSync(await download.path())
      report.downloads.push({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      assert(bytes.length > 0)
      if (video || workspace) assert.equal(report.downloads[i].sha256, report.original_sha256, 'download must match the simulator original')
    }
    report.after = { supplier: stats(), ledger: ledger() }
    assert.equal(report.after.supplier[`${kind}_posts`] - report.before.supplier[`${kind}_posts`], count)
    assert.equal(Math.round((report.before.ledger.balance - report.after.ledger.balance) * 100), video ? 200 : count * (geometry?.cents ?? 70))
    assert.equal(report.after.ledger.usage - report.before.ledger.usage, 1)
    if (geometry) {
      const posts = report.after.supplier.requests.slice(report.before.supplier.requests.length).filter(r=>r.method==='POST')
      assert.equal(posts.length,count)
      for (const r of posts) {
        assert.equal(r.path, geometry.edit ? '/v1/images/edits' : '/v1/images/generations')
        assert.equal(r.auth,'bearer'); assert.equal(r.body.model,'gpt-image-2')
        assert.equal(r.body.resolution,geometry.resolution); assert.equal(r.body.aspect_ratio,geometry.ratio)
        assert.equal(r.body.size,undefined); assert.equal(r.body.n,1)
        assert.equal(r.body.images?.length || 0,geometry.edit ? 1 : 0)
      }
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
      report.original_sha256 = createHash('sha256').update(png).digest('hex')
      for (const d of report.downloads) assert.equal(d.sha256,report.original_sha256)
      report.actual_submits = posts
      report.expected_spec = geometry
    }
    if (artifact && !video && !geometry) {
      const requests = report.after.supplier.requests.slice(report.before.supplier.requests.length).filter(r => r.method === 'POST')
      assert.equal(requests.length, count)
      for (const request of requests) {
        assert.equal(request.path, '/v1beta/models/gemini-3.1-flash-image:generateContent')
        assert.equal(request.body.generationConfig.imageConfig.imageSize, '1K')
        assert.equal(request.body.generationConfig.imageConfig.aspectRatio, '1:1')
        const parts = request.body.contents.flatMap(c => c.parts)
        assert.equal(parts.filter(p => p.inlineData || p.fileData).length, scenario === 'edit' ? 1 : 0)
      }
      report.actual_submits = requests
    }
    if (video) {
      assert.equal(report.after.ledger.video_captured - report.before.ledger.video_captured, 1)
      assert.equal(report.after.ledger.frozen_balance, 0)
      const creates = report.after.supplier.requests.slice(report.before.supplier.requests.length).filter(r => r.method === 'POST' && r.body.model === videoModel)
      assert.equal(creates.length, 1)
      assert.equal(creates[0].auth, 'bearer')
      assert.equal(creates[0].body.duration, 5)
      assert.equal(creates[0].body.resolution, '720p')
      // The wire profile is the source of truth: Grok and Seedance use
      // aspect_ratio, while generic compatible video uses ratio.
      const ratioField = videoMode === 'compatible' ? 'ratio' : 'aspect_ratio'
      assert.equal(creates[0].body[ratioField], '16:9')
      report.actual_submit = creates[0]
    }
    await page.reload(); await expect(page.getByTestId('studio-task-id')).toContainText(report.id)
    await expect(page.getByTestId('studio-status')).toContainText('生成完成')
    if (video || geometry || workspace) {
      const queried = page.waitForResponse(r => r.url().endsWith(`/studio-v2/api/${kind}/${video ? 'operations' : 'tasks'}/${report.id}`) && r.request().method() === 'GET')
      await page.getByTestId('studio-refresh').click()
      assert.equal((await queried).status(), 200)
      await expect(page.getByTestId('studio-refresh')).toBeEnabled()
      // Reload restores and queries the original task. Download that persisted
      // result again; neither operation may generate or settle another task.
      const pending = page.waitForEvent('download'); await page.getByTestId('studio-download').first().click(); const download = await pending
      assert.equal(await download.failure(), null)
      report.repeat_download_sha256 = createHash('sha256').update(fs.readFileSync(await download.path())).digest('hex')
      assert.equal(report.repeat_download_sha256, report.original_sha256)
    }
    if (workspace && video) {
      const player=page.getByTestId('studio-result-video')
      await player.evaluate(v=>v.play())
      await expect.poll(()=>player.evaluate(v=>v.currentTime)).toBeGreaterThan(0)
      await player.evaluate(v=>v.pause())
      report.playback_verified=true
    }
    assert.equal(stats()[`${kind}_posts`], report.after.supplier[`${kind}_posts`])
    assert.deepEqual(ledger(), report.after.ledger)
    report.after_refresh_download = { supplier: stats(), ledger: ledger() }
    await page.getByTestId('studio-media-panel').screenshot({ path: `${root}/evidence/native-customer-${scenario}.png` })
    if (artifact) {
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow')
      await page.screenshot({ path: `${root}/evidence/native-artifact-${scenario}-result.png`, fullPage: true })
      if (scenario !== 'edit') {
        await page.setViewportSize({ width: 390, height: 844 })
        await expect(page.getByTestId('studio-refresh')).toBeEnabled()
        await page.getByTestId('studio-refresh').click()
        await expect(page.getByTestId('studio-refresh')).toBeEnabled()
        await expect(page.getByTestId('studio-status')).toContainText('生成完成')
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile horizontal overflow')
        await page.screenshot({ path: `${root}/evidence/native-artifact-${scenario}-mobile.png`, fullPage: true })
        assert.equal(stats()[`${kind}_posts`], report.after.supplier[`${kind}_posts`])
        assert.deepEqual(ledger(), report.after.ledger)
      }
      report.artifact = await artifactProof()
    }
    report.pass = true
    delete report.error
  } catch (error) { report.error = error.message; report.failure_state = { supplier: stats(), ledger: ledger() }; await page.screenshot({ path: `${root}/evidence/native-customer-${scenario}-failure.png`, fullPage: true }); throw error }
  finally { if (restoreDrift) await restoreDrift(); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); await browser.close() }
  console.log(JSON.stringify({ scenario, pass: true, id: report.id, delivered: count }))
})().catch(error => { console.error(error.message); process.exitCode = 1 })
