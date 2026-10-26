'use strict'
// Shared by the real candidate and the production entry point below. No UI/API mocks.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const sha256 = value => createHash('sha256').update(value).digest('hex')
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }]
const SCRIPT_FILES = ['admin-readonly.cjs', 'admin-readonly-candidate.cjs', 'artifact-assets.cjs', 'candidate.mjs']
const scriptHashes = (dir = __dirname) => Object.fromEntries(SCRIPT_FILES.map(name => [name, sha256(fs.readFileSync(path.join(dir, name)))]))
const digest = dto => sha256(JSON.stringify(dto.media_workbench_v1))

function validSupplierQuery(url) {
  const pairs = [...url.searchParams]
  if (!pairs.length) return true
  if (pairs.length !== 1 || pairs[0][0] !== 'timezone' || !pairs[0][1]) return false
  try { new Intl.DateTimeFormat('en', { timeZone: pairs[0][1] }); return true } catch { return false }
}
function matchesPaidRead(request, origin, media) {
  try {
    const u = new URL(request.url())
    return request.method() === 'GET' && u.origin === origin && u.pathname === `/api/v1/admin/media-workbench/paid-controls/${media}` && !u.hash && validSupplierQuery(u)
  } catch { return false }
}
function armSupplierPaidReads(page, origin, timeoutMs = 20000) {
  let timer
  const reads = Promise.all(['image', 'video'].map(async media => {
    const request = await page.waitForRequest(q => matchesPaidRead(q, origin, media), { timeout: timeoutMs })
    const response = await request.response()
    if (!response || response.status() !== 200) throw Error('PAID_READ_HTTP_REJECTED')
    let failure
    try { failure = await response.finished() } catch { throw Error('PAID_READ_BODY_FAILED') }
    if (failure) throw Error('PAID_READ_BODY_FAILED')
    const body = await response.json()
    if (body.code !== 0 || body.data?.media !== media) throw Error('PAID_READ_ENVELOPE_REJECTED')
    return { media, status: 200, body_finished: true, query_keys: [...new URL(request.url()).searchParams.keys()] }
  }))
  // Handle rejection before the click; one deadline covers headers AND bodies.
  const outcome = Promise.race([reads, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('PAID_READ_DEADLINE')), timeoutMs) })])
    .then(value => ({ value }), error => ({ error })).finally(() => clearTimeout(timer))
  return async () => { const result = await outcome; if (result.error) throw result.error; return result.value }
}
function requestDecision(method, raw, origin, accountIDs) {
  let u, pathname
  try { u = new URL(raw); pathname = decodeURIComponent(u.pathname) } catch { return 'blocked' }
  if (u.origin !== origin) return ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'external_read_blocked' : 'blocked'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'blocked'
  if (!pathname.startsWith('/api/') && !pathname.startsWith('/studio-v2/api/')) return ['/admin/media', '/health', '/setup/status', '/logo.svg', '/favicon.ico', '/favicon.svg'].includes(pathname) || pathname.startsWith('/assets/') ? 'read' : 'blocked'
  const reads = ['/api/v1/auth/me', '/api/v1/admin/compliance', '/api/v1/subscriptions/active', '/api/v1/admin/system/check-updates', '/api/v1/announcements', '/api/v1/admin/payment/config', '/api/v1/admin/settings', '/api/v1/settings/public', '/api/v1/keys', '/api/v1/admin/media-workbench/suppliers', ...['image', 'video'].map(k => '/api/v1/admin/media-workbench/paid-controls/' + k), ...accountIDs.map(id => '/api/v1/admin/media-workbench/accounts/' + id)]
  return reads.includes(pathname) ? 'read' : 'blocked'
}
function targetFor(dto, productID) {
  const config = dto.media_workbench_v1
  const diagnostics = config?.validation?.diagnostics || []
  const index = diagnostics.findIndex(x => x.code === 'MODEL_NOT_DISCOVERED' && x.path === 'upstream_model' && x.scope === productID)
  const products = config?.draft?.products.filter(p => p.product_id === productID) || []
  if (index < 0 || products.length !== 1 || !['image', 'video'].includes(products[0].media_type)) throw Error('MODEL_DIAGNOSTIC_IDENTITY_MISSING')
  return { index, count: diagnostics.length, product: products[0] }
}
async function verifyDiagnosticViewport(page, target, size) {
  const diagnostic = page.locator('.mw-diagnostic').nth(target.index)
  assert.equal(await page.locator('.mw-diagnostic').count(), target.count)
  const text = await diagnostic.innerText()
  assert(text.includes('上游模型列表') && text.includes('没有这个商品绑定的型号') && text.includes('模型选择') && !text.includes('对应规格或售价'))
  await diagnostic.click()
  await page.locator('[data-test="editor-page"]').waitFor({ state: 'visible' })
  const select = page.locator('[data-test="product-select"]')
  if (await select.count()) assert.equal(await select.inputValue(), target.product.product_id)
  assert.equal((await page.locator('[data-test="upstream-model-name"]').innerText()).trim(), target.product.upstream_model)
  const binding = page.locator('[data-test="model-binding"]')
  await binding.waitFor({ state: 'visible' })
  assert((await binding.innerText()).includes('原型号不可用，请更换绑定'))
  assert.equal(await page.locator('[data-test="binding-old"]').inputValue(), target.product.upstream_model)
  const product = page.locator('[data-test="binding-products"] input').filter({ visible: true })
  const selectedProducts = await product.evaluateAll(nodes => nodes.filter(node => node.checked).map(node => node.value))
  assert.deepEqual(selectedProducts, [target.product.product_id])
  assert.equal(await page.locator('[data-test="binding-new"]').inputValue(), '')
  assert(await page.locator('[data-test="binding-confirm"]').isDisabled())
  for (const id of ['wizard-step-1', 'wizard-step-5', 'wizard-next', 'wizard-page-1', 'wizard-page-5', 'save']) assert.equal(await page.locator(`[data-test="${id}"]`).count(), 0)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const observed = await page.locator('[data-test="selected-model-summary"]').evaluate(el => {
    const r = el.getBoundingClientRect()
    return { focus: document.activeElement === el, visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth, highlight: el.classList.contains('mw-field-located'), field: el.getAttribute('data-field'), tabindex: el.getAttribute('tabindex'), role: el.getAttribute('role'), label: el.getAttribute('aria-label') }
  })
  assert.deepEqual(observed, { focus: true, visible: true, highlight: true, field: 'upstream_model', tabindex: '-1', role: 'group', label: '当前上游模型' })
  assert(!await page.locator('[data-test="native-output-png"]').isVisible())
  assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
  return { ...size, media: target.product.media_type, product_sha256: sha256(target.product.product_id), model_sha256: sha256(target.product.upstream_model), identity: true, focus: true, visible: true, highlight: true, binding_required: true, original_model_identity: true, selected_product_identity: true, wizard_hidden: true, png_not_visible: true, no_overflow: true }
}
function screenshotsMasks(page) {
  return [page.locator('header.glass'), page.locator('.mw-product-context > div:first-child,[data-test="account-search"],[data-test^="supplier-"],[data-test="product-select"],[data-test="diagnostic-product"]'), page.locator('[data-test^="price-"],input[data-test^="video-sale-"],[data-test="pricing-preview"]'), page.getByText(/(?:CNY|USD|人民币|￥|¥)\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:CNY|USD)(?:\b|\s|\/)/i), page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)]
}
function reportPassed(report) {
  return report.context_closed === true && report.source_sha?.match(/^[a-f0-9]{40}$/) && !report.errors.length && !report.blocked.length && !report.api.some(x => x.status >= 400)
    && report.admin_before === true && report.admin_after === true && report.paid_unchanged === true
    && report.targets.length > 0 && report.targets.every(t => t.before === t.after && /^[a-f0-9]{64}$/.test(t.before))
    && report.viewports.length === report.targets.length * VIEWPORTS.length && report.targets.every(t => VIEWPORTS.every(s => report.viewports.some(v => v.account === t.account && v.product_sha256 === t.product_sha256 && v.width === s.width && v.height === s.height && ['identity', 'focus', 'visible', 'highlight', 'binding_required', 'original_model_identity', 'selected_product_identity', 'wizard_hidden', 'png_not_visible', 'no_overflow'].every(k => v[k] === true) && v.paid_reads?.length === 2 && v.paid_reads.every(r => r.body_finished === true && r.status === 200))))
    && report.screenshots.length === report.viewports.length && report.screenshots.every(s => /^[a-f0-9]{64}$/.test(s.sha256))
}
async function collect({ origin, token, sourceSha, targets, out, launch, onPage = () => null }) {
  assert.equal(new URL(origin).origin, origin)
  assert.match(sourceSha, /^[a-f0-9]{40}$/)
  assert(targets.length && targets.every(t => Number.isSafeInteger(t.account) && t.account > 0 && typeof t.product === 'string' && t.product))
  fs.mkdirSync(out, { recursive: true })
  const result = path.join(out, 'result.json')
  assert(!fs.existsSync(result), 'EXISTING_ACCEPTANCE_EVIDENCE')
  const report = { schema: 1, source_sha: sourceSha, scope: 'ADMIN_MODEL_DIAGNOSTIC_READ_ONLY', status: 'STARTING', started: new Date().toISOString(), errors: [], blocked: [], external_read_blocks: [], api: [], targets: [], viewports: [], screenshots: [], context_closed: false }
  const save = () => fs.writeFileSync(result, JSON.stringify(report, null, 2))
  const mark = substage => { report.substage = substage; report.progress ??= []; report.progress.push({ stage: report.stage, substage, at: new Date().toISOString() }); save() }
  save()
  let browser, context, page, timer
  try {
    browser = await launch()
    context = await browser.newContext({ reducedMotion: 'reduce', locale: 'zh-CN' })
    context.setDefaultTimeout(15000)
    timer = setTimeout(() => { report.errors.push({ stage: report.stage, code: 'ACCEPTANCE_DEADLINE' }); save(); void context.close().catch(() => {}) }, 180000)
    const ids = [...new Set(targets.map(t => t.account))]
    const get = async route => {
      assert(['/health', '/api/v1/auth/me', ...ids.map(id => '/api/v1/admin/media-workbench/accounts/' + id), ...['image', 'video'].map(k => '/api/v1/admin/media-workbench/paid-controls/' + k)].includes(route))
      const response = await context.request.get(origin + route, { headers: { Authorization: 'Bearer ' + token }, timeout: 20000, maxRedirects: 0 })
      report.api.push({ method: 'GET', path: route, status: response.status() })
      assert.equal(response.status(), 200)
      if (route === '/health') return
      const body = await response.json(); assert.equal(body.code, 0); return body.data
    }
    report.stage = 'baseline'
    const user = await get('/api/v1/auth/me')
    assert(user.role === 'admin' && Number.isSafeInteger(user.id) && user.id > 0); report.admin_before = true
    await get('/health')
    const paid = async () => { const states = {}; for (const kind of ['image', 'video']) { const s = await get('/api/v1/admin/media-workbench/paid-controls/' + kind); states[kind] = { media: s.media, mode: s.mode, requested_enabled: s.requested_enabled, effective_enabled: s.effective_enabled, revision: s.revision, reason: s.reason }; assert.equal(s.media, kind); assert.equal(s.mode, 'managed-v1') } return states }
    const paidBefore = await paid()
    const selected = []
    for (const target of targets) { const dto = await get('/api/v1/admin/media-workbench/accounts/' + target.account); assert.equal(dto.id, target.account); const identity = targetFor(dto, target.product); const row = { account: target.account, product_sha256: sha256(target.product), before: digest(dto), after: null }; report.targets.push(row); selected.push({ target, identity, row }) }
    await context.addInitScript(({ origin, token, user }) => { if (location.origin === origin) { localStorage.setItem('auth_token', token); localStorage.setItem('auth_user', JSON.stringify(user)); localStorage.setItem('sub2api_locale', 'zh'); localStorage.setItem('admin_guide_1_admin_v4_interactive', 'true') } }, { origin, token, user })
    await context.route('**/*', async route => {
      const request = route.request(), decision = requestDecision(request.method(), request.url(), origin, ids)
      const event = { method: request.method(), path: new URL(request.url()).origin === origin ? new URL(request.url()).pathname : '[external-origin]' }
      if (decision === 'external_read_blocked') { report.external_read_blocks.push(event); return route.abort() }
      if (decision === 'blocked') { report.blocked.push(event); return route.abort() }
      return route.continue()
    })
    page = await context.newPage()
    page.on('pageerror', () => report.errors.push({ stage: report.stage, code: 'PAGE_ERROR' }))
    page.on('requestfailed', q => { if (new URL(q.url()).origin === origin) report.errors.push({ stage: report.stage, code: 'SAME_ORIGIN_REQUEST_FAILED', path: new URL(q.url()).pathname }) })
    page.on('response', r => { const u = new URL(r.url()); if (u.origin === origin && u.pathname.startsWith('/api/')) report.api.push({ method: r.request().method(), path: u.pathname, status: r.status() }) })
    const finishAssets = onPage(page)
    for (const { target, identity } of selected) for (const size of VIEWPORTS) {
      report.stage = 'diagnostic-' + identity.product.media_type + '-' + size.width; save()
      await page.setViewportSize(size)
      mark('admin-media.goto')
      await page.goto(origin + '/admin/media', { waitUntil: 'domcontentloaded', timeout: 30000 })
      mark('account-search.fill')
      await page.locator('[data-test="account-search"]').fill('#' + target.account)
      const row = page.locator(`[data-test="supplier-${target.account}"]`)
      await row.evaluate(el => { const d = el.closest('details'); if (d) d.open = true })
      const paidReads = armSupplierPaidReads(page, origin)
      mark('supplier.click')
      await row.click()
      mark('supplier.paid-bodies-complete')
      const completed = await paidReads()
      await page.locator('[data-test="model-page"]').waitFor({ state: 'visible' })
      mark('diagnostic.navigate-and-focus')
      const proof = await verifyDiagnosticViewport(page, identity, size)
      proof.account = target.account; proof.paid_reads = completed; report.viewports.push(proof)
      await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
      const name = `native-admin-readonly-${identity.product.media_type}-${target.account}-${size.width}.png`
      await page.screenshot({ path: path.join(out, name), fullPage: false, animations: 'disabled', mask: screenshotsMasks(page) })
      report.screenshots.push({ file: name, sha256: sha256(fs.readFileSync(path.join(out, name))) }); save()
    }
    if (finishAssets) report.assets = await finishAssets()
    report.stage = 'final-readback'
    for (const { target, row } of selected) row.after = digest(await get('/api/v1/admin/media-workbench/accounts/' + target.account))
    const after = await paid(); assert.deepEqual(after, paidBefore); report.paid_unchanged = true
    const me = await get('/api/v1/auth/me'); assert.equal(me.id, user.id); assert.equal(me.role, 'admin'); report.admin_after = true
  } catch (error) {
    report.errors.push({ stage: report.stage, code: /^[A-Z][A-Z_]{2,80}$/.test(error.message || '') ? error.message : 'ACCEPTANCE_CHECK_FAILED', error_class: error.name })
    if (page && !page.isClosed()) {
      try {
        const file = `native-admin-readonly-${report.stage}-failure.png`
        await page.screenshot({ path: path.join(out, file), animations: 'disabled', timeout: 5000, mask: screenshotsMasks(page) })
        report.failure_screenshot = { file, sha256: sha256(fs.readFileSync(path.join(out, file))) }
      } catch { report.failure_screenshot = { status: 'UNAVAILABLE' } }
    }
  } finally {
    clearTimeout(timer)
    try { await context?.close(); await browser?.close(); report.context_closed = !!context } catch { report.errors.push({ code: 'CONTEXT_CLOSE_FAILED' }) }
    report.finished = new Date().toISOString(); report.status = reportPassed(report) ? 'PASS' : 'FAIL'; save()
  }
  return report
}

// No trust in caller-supplied PASS flags: bind the real candidate report and
// runtime images to an externally verified manifest digest before any browser/login.
function verifyCandidateProof(dir, expectedManifestSHA, sourceSha, scriptsDir = __dirname) {
  assert.match(expectedManifestSHA, /^[a-f0-9]{64}$/)
  const raw = fs.readFileSync(path.join(dir, 'manifest.json'))
  assert.equal(sha256(raw), expectedManifestSHA, 'CANDIDATE_MANIFEST_CHANGED')
  const manifest = JSON.parse(raw)
  assert.equal(manifest.source_sha, sourceSha); assert.equal(manifest.acceptance, 'PASS'); assert.equal(manifest.production_action, false)
  const binding = manifest.admin_readonly
  assert.equal(binding?.file, 'native-admin-readonly-proof.json', 'CANDIDATE_PRE_RUN_MISSING')
  const bytes = fs.readFileSync(path.join(dir, binding.file)); assert.equal(sha256(bytes), binding.sha256)
  const proof = JSON.parse(bytes)
  assert.equal(proof.scope, 'REAL_CORE_BRIDGE_BFF'); assert.equal(proof.status, 'PASS'); assert.equal(proof.source_sha, sourceSha)
  assert.deepEqual(proof.scripts, scriptHashes(scriptsDir), 'ACCEPTANCE_SCRIPT_CHANGED')
  assert.equal(proof.reports.length, 2)
  assert.deepEqual(proof.reports.map(r => r.media).sort(), ['image', 'video'])
  for (const item of proof.reports) {
    assert.equal(path.basename(item.file), item.file)
    const bytes = fs.readFileSync(path.join(dir, item.file)); assert.equal(sha256(bytes), item.sha256)
    const report = JSON.parse(bytes); assert.equal(report.source_sha, sourceSha); assert.equal(report.status, 'PASS'); assert(reportPassed(report))
    assert.equal(report.targets.length, 1); assert(report.viewports.every(v => v.media === item.media))
    assert.equal(report.assets?.frontend_origin, 'final Core image'); assert.equal(report.assets?.vite, false); assert.equal(report.assets?.browser_api_mocking, false)
    for (const shot of report.screenshots) { assert.equal(path.basename(shot.file), shot.file); assert.equal(sha256(fs.readFileSync(path.join(dir, shot.file))), shot.sha256) }
  }
  assert.deepEqual(proof.runtime.map(x => x.component).sort(), ['bff', 'bridge', 'core'])
  for (const component of proof.runtime) { const image = manifest.images.find(i => i.component === component.component); assert.equal(component.source_sha, sourceSha); assert.equal(image?.source_sha, sourceSha); assert(verifiedImageIDs(image).has(component.image_id)); assert.equal(component.healthy, true) }
  return manifest
}
function verifiedImageIDs(image) {
  assert.match(image?.config_digest || '', /^sha256:[a-f0-9]{64}$/)
  const ids = new Set([image.config_digest]), archive = image.archive_identity
  if (archive) {
    assert.equal(archive.config_digest, image.config_digest)
    for (const manifest of archive.oci_manifests || []) { assert.equal(manifest.config_digest, image.config_digest); assert.match(manifest.manifest_digest, /^sha256:[a-f0-9]{64}$/); ids.add(manifest.manifest_digest) }
  }
  assert(ids.has(image.image_id), 'UNVERIFIED_ARCHIVE_IDENTITY')
  return ids
}
function verifyProductionRuntime(raw, expectedSHA, sourceSha, manifest) {
  assert.equal(sha256(raw), expectedSHA, 'SEALED_RUNTIME_PROOF_CHANGED')
  const proof = JSON.parse(raw)
  assert.equal(proof.source_sha, sourceSha); assert.equal(proof.proof_source, 'SSH_READBACK_OF_SEALED_RELEASE'); assert.equal(proof.public_routes_verified, true)
  assert.match(proof.run_id, /^[a-f0-9]{32}$/)
  for (const name of ['core', 'bridge', 'bff']) { const c = proof.components?.[name], image = manifest.images.find(x => x.component === name); assert.equal(c?.source_sha, sourceSha); assert(verifiedImageIDs(image).has(c?.expected_image_id)); assert.equal(c?.running_image_id, c?.expected_image_id); assert.equal(c?.healthy, true); assert.equal(c?.program_sha256_matches, true) }
  return proof
}
if (require.main === module) {
  // Release controller supplies the official in-memory token on stdin. Never
  // save auth state or print raw errors, bodies, URLs or credentials.
  let text = ''
  process.stdin.on('data', b => { text += b; if (text.length > 65536) { text = ''; process.stdin.destroy(); process.exitCode = 1 } })
  process.stdin.on('end', async () => {
    try {
      const input = JSON.parse(text); text = ''
      const manifest = verifyCandidateProof(input.candidate_dir, input.manifest_sha256, input.source_sha)
      if (process.argv[2] === '--verify-candidate') {
        process.stdout.write('CANDIDATE_PRE_RUN_VERIFIED: exact scripts and real isolated UI proof. No browser or production request.\n')
        return
      }
      verifyProductionRuntime(fs.readFileSync(input.runtime_proof), input.runtime_sha256, input.source_sha, manifest)
      const u = new URL(input.origin); assert.equal(u.protocol, 'https:'); assert.equal(u.origin, input.origin); assert(!u.username && !u.password)
      const { chromium } = require('../../frontend/node_modules/@playwright/test')
      const report = await collect({ origin: input.origin, sourceSha: input.source_sha, token: input.token, targets: input.targets, out: input.out, launch: () => chromium.launch({ channel: 'chrome', headless: true }) })
      input.token = ''; process.stdout.write(JSON.stringify({ status: report.status, source_sha: report.source_sha }) + '\n'); process.exitCode = report.status === 'PASS' ? 0 : 1
    } catch { process.stdout.write('ACCEPTANCE_ENTRY_REJECTED: proof, identity or browser verification failed.\n'); process.exitCode = 1 }
  })
}
module.exports = { VIEWPORTS, SCRIPT_FILES, sha256, scriptHashes, validSupplierQuery, matchesPaidRead, armSupplierPaidReads, requestDecision, targetFor, verifyDiagnosticViewport, reportPassed, collect, verifyCandidateProof, verifiedImageIDs, verifyProductionRuntime }
