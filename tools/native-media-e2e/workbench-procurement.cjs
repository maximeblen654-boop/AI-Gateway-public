// Real isolated Core + Bridge + BFF acceptance. Only the upstream is simulated.
// Invoked after standard candidate customers and before paid-controls close.
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { createHash, randomUUID } = require('node:crypto')

const base = 'http://127.0.0.1:28100'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const money = value => Math.round(Number(value) * 1e8)
const price = amount => ({ amount, currency: 'CNY', billing_mode: 'per_request' })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const privateKeys = /^(?:cost(?:_.*)?|.*_cost|procurement(?:_.*)?|account_accounting|accounting|credentials|api_key|api_key_id|account_id|source_hash|effective_account_quota_cost|account_rate_multiplier|credit_rate|profit|margin)$/i

function assertPublic(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertPublic(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    assert(!privateKeys.test(key), `Private business data leaked at ${path}.${key}`)
    assertPublic(item, `${path}.${key}`)
  }
  assert(!/synthetic-native-only|localhost:19090/.test(JSON.stringify(value)), 'Supplier credential or endpoint leaked')
}

function assertZeroBalanceRejection(before, after, postsBefore, postsAfter, response) {
  assert.equal(money(before.balance), 0, 'Native zero-balance fixture required; a low positive balance is not a projected-sale-price rejection')
  assert.deepEqual(after, before, 'Rejected zero-balance request changed native balance, usage or Account quota')
  assert.equal(postsAfter, postsBefore, 'Rejected zero-balance request reached the supplier')
  // BFF task responses may use HTTP 200 with a failed/unknown task state.
  // Transport success cannot replace the native ledger and supplier evidence.
  assert(!['completed', 'partial', 'captured', 'billed'].includes(response?.body?.status), 'Zero-balance rejection reported successful delivery')
}

function assertVideoFailureRelease(before, after, order, postsBefore, postsAfter) {
  assert.deepEqual(after, before, 'Released video changed balance, frozen funds, usage, dedup or Account quota')
  assert.equal(order.state, 'RELEASED', 'Video failure lacks authoritative released order')
  assert.equal(order.release_reason, 'supplier_failed')
  assert.equal(order.actual_amount, null, 'Failed video must not record a captured customer charge')
  assert.equal(postsAfter - postsBefore, 1, 'One original video generation request is required')
}

function assertVideoHistory(items, expected) {
  assert(Array.isArray(items), 'Video history must be an array')
  return expected.map(task => {
    assert.match(task.operation_id, /^op_[a-f0-9]{64}$/, 'Original video operation identity required')
    assert.match(task.task_id, /^av_[a-f0-9]{64}$/, 'Original video child identity required')
    assert(['captured', 'released'].includes(task.status), 'Expected video terminal state required')
    const matches = items.filter(item => item.operation_id === task.operation_id)
    assert.equal(matches.length, 1, 'Original video operation must appear exactly once in history')
    const item = matches[0]
    assert.equal(item.contract, 'account_video_v1', 'Video history contract changed')
    assert.equal(item.status, task.status, 'Video history must retain the authoritative terminal state')
    assert.equal(item.children?.length, 1, 'Original video child must appear exactly once')
    assert.equal(item.children[0].task_id, task.task_id, 'Video history changed the original child identity')
    assert.equal(item.children[0].status, task.status, 'Video history child must retain the terminal state')
    assert.equal(item.offer_id, task.offer_id, 'Video history changed the frozen Offer')
    assert.equal(item.model, task.model, 'Video history changed the original model')
    assert.deepEqual(item.spec, task.spec, 'Video history changed the frozen specification')
    assert.deepEqual(item.sale_price, task.sale_price, 'Video history changed the frozen sale price')
    return { operation_id: item.operation_id, task_id: item.children[0].task_id, status: item.status, offer_id: item.offer_id }
  })
}

function assertHistoryReadOnly(before, after) {
  assert.deepEqual(after.ledger, before.ledger, 'History changed balance, frozen funds, usage, cost, dedup or Account quota')
  assert.equal(after.supplier.image_posts, before.supplier.image_posts, 'History generated an image')
  assert.equal(after.supplier.video_posts, before.supplier.video_posts, 'History generated a video')
  assert.deepEqual(after.supplier.requests, before.supplier.requests, 'History contacted the supplier, including polling or downloading')
}

async function setAccountSchedulable(core, token, accountID, schedulable) {
  const path = '/admin/accounts/' + accountID
  await core(token, path + '/schedulable', 'POST', { schedulable })
  const readback = await core(token, path)
  assert.equal(readback.id, accountID, 'Schedulability readback returned another Account')
  assert.equal(readback.schedulable, schedulable, 'Account schedulability update was not persisted')
  return readback
}

async function setAccountQuota(core, token, account, quotaLimit) {
  const path = '/admin/accounts/' + account.id
  account = await core(token, path) // Never restore quota_used from an earlier fixture snapshot.
  await core(token, path, 'PUT', { extra: { ...account.extra, quota_limit: quotaLimit } })
  const readback = await core(token, path)
  assert.equal(readback.id, account.id, 'Quota readback returned another Account')
  assert.equal(money(readback.extra?.quota_limit), money(quotaLimit), 'Account quota limit update was not persisted')
  assert.equal(money(readback.extra?.quota_used ?? 0), money(account.extra?.quota_used ?? 0), 'Changing the Account quota limit rewrote native usage')
  return readback
}

async function clearAccountQuota(core, token, account) {
  const path = '/admin/accounts/' + account.id
  account = await core(token, path)
  const extra = { ...account.extra }
  delete extra.quota_limit
  await core(token, path, 'PUT', { extra })
  const readback = await core(token, path)
  assert.equal(readback.id, account.id)
  assert.equal(Number(readback.extra?.quota_limit || 0), 0, 'Video fixture must not have a monetary Account limit')
  assert.equal(money(readback.extra?.quota_used ?? 0), money(account.extra?.quota_used ?? 0), 'Removing the fixture limit rewrote native usage')
  return readback
}

async function setKeyStatus(core, token, keyID, status) {
  const path = '/keys/' + keyID
  await core(token, path, 'PUT', { status })
  const readback = await core(token, path)
  assert.equal(readback.id, keyID, 'Key status readback returned another Key')
  assert.equal(readback.status, status, 'Native Key status update was not persisted')
  return readback
}

async function disableFixtureSales(core, token, accountID) {
  const path = '/admin/media-workbench/accounts/' + accountID
  const before = await core(token, path)
  assert.equal(before.id, accountID, 'Sales cleanup read returned another Account')
  const config = before.media_workbench_v1
  if (config?.sales.enabled === true) {
    assert(Number.isSafeInteger(config.record_version), 'Sales cleanup requires the current record version')
    await core(token, path + '/sales', 'PUT', { expected_record_version: config.record_version, enabled: false })
  }
  const readback = await core(token, path)
  assert.equal(readback.id, accountID, 'Sales cleanup readback returned another Account')
  assert.equal(readback.media_workbench_v1?.sales.enabled ?? false, false, 'Fixture sales cleanup was not persisted')
  assert.deepEqual(readback.media_workbench_v1?.draft, config?.draft, 'Sales cleanup changed the fixture Draft')
  assert.deepEqual(readback.media_workbench_v1?.published, config?.published, 'Sales cleanup changed the fixture Published snapshot')
  return false
}

module.exports = async function run(root, suppliedCompose, suppliedFixture, suppliedReport) {
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO, 'paid-controls')
  assert(root && root.replace(/\\/g, '/').endsWith('/native-media-20261012'))
  const compose = suppliedCompose || JSON.parse(fs.readFileSync(root + '/compose.json'))
  const fixture = suppliedFixture || JSON.parse(fs.readFileSync(root + '/evidence/fixture.json'))
  assert.equal(compose.services.core.container_name, 'ai-gateway-native-core-20261012')
  assert.equal(compose.services.postgres.environment.POSTGRES_DB, 'sub2api')
  assert.equal(compose.services.core.environment.ADMIN_EMAIL, 'native-admin@example.invalid')
  const imageGroup = Number(compose.services.bridge.environment.STUDIO_IMAGE_GROUP_ID)
  const videoGroup = Number(compose.services.bridge.environment.STUDIO_VIDEO_GROUP_ID)
  assert.equal(imageGroup, fixture.groups.openai)
  assert.equal(videoGroup, fixture.groups.grok)
  const report = suppliedReport || { checks: [] }
  Object.assign(report, { source_sha: process.env.NATIVE_CANDIDATE_SOURCE_SHA, production_action: false, api_mocking: false, upstream: 'local simulator only', tasks: [], responses: [], restored: false })
  const saveReport = () => fs.writeFileSync(root + '/evidence/native-workbench-procurement.json', JSON.stringify(report, null, 2))
  const dc = (...args) => execFileSync('docker', ['compose', '-p', 'ai-gateway-native-20261012', '-f', root + '/compose.json', ...args], { encoding: 'utf8', stdio: 'pipe' })
  const sql = query => dc('exec', '-T', 'postgres', 'psql', '-U', 'native', '-d', 'sub2api', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query).trim()
  const stats = () => JSON.parse(fs.readFileSync(root + '/evidence/native-supplier-state.json'))
  let admin, account, apiGroup, apiChannel
  const detached = []
  const videoHistoryExpected = []
  const id = value => { assert(Number.isSafeInteger(value) && value > 0); return value }
  const snapshot = user => JSON.parse(sql(`SELECT json_build_object('balance',balance::text,'frozen',frozen_balance::text,'usage',(SELECT count(*) FROM usage_logs WHERE user_id=${id(user.id)}),'cost',(SELECT COALESCE(sum(actual_cost),0)::text FROM usage_logs WHERE user_id=${id(user.id)}),'dedup',(SELECT count(*) FROM usage_billing_dedup WHERE api_key_id IN (SELECT id FROM api_keys WHERE user_id=${id(user.id)} )),'account_quota',(SELECT COALESCE(extra->>'quota_used','0') FROM accounts WHERE id=${id(account.id)})) FROM users WHERE id=${id(user.id)}`))
  async function raw(token, path, method = 'GET', body) {
    const response = await fetch(base + '/api/v1' + path, { method, headers: { Connection: 'close', 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Admin-UI-Request': '1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  async function core(token, path, method = 'GET', body) {
    const response = await raw(token, path, method, body)
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response)}`)
    assert.equal(response.body.code, 0, `${path}: ${JSON.stringify(response)}`)
    return response.body.data
  }
  async function login(email, password) { return (await core('', '/auth/login', 'POST', { email, password })).access_token }
  async function session(user) {
    const ticket = await core(user.token, '/auth/studio-media-ticket', 'POST', {})
    const response = await fetch(base + '/studio-v2/api/session/exchange', { method: 'POST', headers: { Connection: 'close', 'Content-Type': 'application/json', Origin: base, 'X-Studio-Request': 'session-exchange-v1' }, body: JSON.stringify({ ticket: ticket.ticket }) })
    assert.equal(response.status, 200)
    user.cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert.equal((await response.json()).owner_id, user.id)
  }
  async function media(user, kind, operation, body) {
    const response = await fetch(`${base}/studio-v2/api/${kind}/${operation}`, { method: body === undefined ? 'GET' : 'POST', headers: { Connection: 'close', 'Content-Type': 'application/json', Origin: base, Cookie: user.cookie, 'X-Studio-Request': kind + '-binding-v1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = { status: response.status, body: await response.json() }
    assertPublic(result.body)
    report.responses.push({ kind, operation, status: result.status, private_fields: false })
    return result
  }
  const ok = response => { assert.equal(response.status, 200, JSON.stringify(response)); return response.body }
  async function customer(label, balance, groups) {
    const email = `procurement-${label}@example.invalid`, password = 'Synthetic-Procurement-Only-20261019'
    const user = await core(admin, '/admin/users', 'POST', { email, password, balance, concurrency: 5, allowed_groups: groups })
    user.token = await login(email, password); user.keys = []
    for (const group_id of groups) user.keys.push(await core(user.token, '/keys', 'POST', { name: 'Synthetic procurement ' + group_id, group_id }))
    await session(user)
    return user
  }
  async function upload(user) {
    const response = await fetch(base + '/studio-v2/api/assets/uploads', { method: 'POST', headers: { Connection: 'close', Origin: base, Cookie: user.cookie, 'Content-Type': 'image/png', 'X-Studio-Request': 'asset-intake-v1', 'X-Studio-Asset-Kind': 'image', 'X-Content-Sha256': createHash('sha256').update(png).digest('hex') }, body: png })
    const result = await response.json(); assert.equal(response.status, 201, JSON.stringify(result)); assertPublic(result)
    return result.asset_ref
  }
  const configPath = () => '/admin/media-workbench/accounts/' + id(account.id)
  async function draft(products) {
    const detail = await core(admin, configPath())
    return core(admin, configPath() + '/draft', 'PUT', { expected_record_version: detail.media_workbench_v1?.record_version || 0, draft: { products } })
  }
  async function publish(detail, product_ids) {
    const config = detail.media_workbench_v1
    return core(admin, configPath() + '/publish', 'POST', { expected_record_version: config.record_version, expected_draft_revision: config.draft.revision, product_ids })
  }
  async function refreshPaidGrants(kinds = ['image', 'video']) {
    const before = stats()
    for (const kind of kinds) {
      const path = '/admin/media-workbench/paid-controls/' + kind
      const checked = await core(admin, path + '/check', 'POST', {})
      assert.equal(checked.pass, true, JSON.stringify(checked))
      const current = await core(admin, path)
      await core(admin, path, 'PUT', { enabled: true, expected_revision: current.revision, fingerprint: checked.fingerprint })
      const enabled = await core(admin, path)
      assert.equal(enabled.effective_enabled, true, JSON.stringify(enabled))
    }
    assert.equal(stats().image_posts, before.image_posts, 'Paid preflight generated an image')
    assert.equal(stats().video_posts, before.video_posts, 'Paid preflight generated a video')
    report.checks.push(`Official isolated preflight refreshed ${kinds.join('/')} grants for current published offers and Account limits without generation`)
  }
  async function offer(user, kind, productID) {
    const result = ok(await media(user, kind, 'catalog'))
    const selected = result.offers.find(item => item.product_id === productID)
    assert(selected, `Missing ${kind} offer ${productID}`)
    return selected
  }
  async function prepare(user, kind, selected, refs = 0, prompt = 'SYNTHETIC procurement ' + randomUUID(), count = 1) {
    if (kind === 'image') {
      const spec = { resolution: '1K', aspect_ratio: '1:1', quality: '', duration_seconds: 0, count, images: refs, videos: 0, audio: 0 }
      const quote = ok(await media(user, kind, 'quotes', { offer_id: selected.offer_id, spec }))
      const assets = refs ? [await upload(user)] : []
      return ok(await media(user, kind, 'prepare', { quote_token: quote.quote_token, client_key: randomUUID(), prompt, asset_refs: assets }))
    }
    const assets = refs ? [{ kind: 'image', asset_ref: await upload(user) }] : []
    let preparation_id
    // Published references mode uses Account-bound uploads; inline_multimedia
    // uses the existing private inline receipt and has no external upload.
    if (refs && selected.video_profile?.inputMode === 'references') {
      preparation_id = ok(await media(user, kind, 'prepare', { offer_id: selected.offer_id, model: 'WAN3.0-可参考视频', spec: { resolution: '720p', duration_seconds: 5, aspect_ratio: '16:9' }, assets })).preparation_id
    }
    return ok(await media(user, kind, 'quotes', { client_key: randomUUID(), offer_id: selected.offer_id, model: 'WAN3.0-可参考视频', prompt, duration: 5, resolution: '720p', ratio: '16:9', assets, ...(preparation_id ? { preparation_id } : {}) }))
  }
  async function execute(user, kind, prepared, expectedSale, expectedQuota, prompt) {
    const taskID = kind === 'image' ? prepared.task_id : prepared.operation_id
    const before = snapshot(user), supplierBefore = stats()
    const statsPath = '/admin/usage/stats?user_id=' + id(user.id) + '&billing_mode=studio_' + kind + '_retail&period=month&nocache=1'
    const retailStatsBefore = await core(admin, statsPath)
    const submission = await media(user, kind, 'tasks', kind === 'image' ? { task_id: taskID } : { operation_id: taskID })
    assert([200, 202].includes(submission.status), JSON.stringify(submission))
    let completed
    for (let i = 0; i < 30; i++) {
      completed = ok(await media(user, kind, (kind === 'image' ? 'tasks/' : 'operations/') + taskID))
      if (kind === 'image' ? completed.status === 'completed' : completed.status === 'captured' || completed.children?.[0]?.status === 'captured') break
      await sleep(500)
    }
    assert(kind === 'image' ? completed.status === 'completed' : completed.status === 'captured' || completed.children?.[0]?.status === 'captured', JSON.stringify(completed))
    const download = await fetch(`${base}/studio-v2/api/${kind}/${kind === 'image' ? 'tasks/' + taskID + '/results/0' : 'operations/' + taskID + '/original'}`, { headers: { Connection: 'close', Cookie: user.cookie } })
    assert.equal(download.status, 200)
    const bytes = Buffer.from(await download.arrayBuffer())
    const expectedBytes = kind === 'image' ? png : fs.readFileSync(root + '/evidence/synthetic-original.mp4')
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(expectedBytes).digest('hex'))
    const after = snapshot(user), supplierAfter = stats()
    assert.equal(money(before.balance) - money(after.balance), money(expectedSale))
    assert.equal(money(after.frozen), 0)
    assert.equal(after.usage - before.usage, 1)
    assert.equal(after.dedup - before.dedup, 1, 'Successful settlement must claim exactly one native dedup record')
    const usage = JSON.parse(sql(`SELECT json_build_object('billing_mode',billing_mode,'account_stats_cost',account_stats_cost,'actual_cost',actual_cost,'total_cost',total_cost) FROM usage_logs WHERE user_id=${id(user.id)} ORDER BY id DESC LIMIT 1`))
    assert.equal(usage.billing_mode, 'studio_' + kind + '_retail')
    assert.equal(usage.account_stats_cost, null, 'Unknown media procurement must stay SQL NULL, never zero or retail fallback')
    assert.equal(money(usage.actual_cost), money(expectedSale), 'CNY retail and native ledger retain numeric 1:1')
    assert.equal(money(usage.total_cost), money(expectedSale))
    const retailStatsAfter = await core(admin, statsPath)
    assert.equal(retailStatsAfter.total_requests - retailStatsBefore.total_requests, 1, 'Authoritative filtered usage count must observe this settlement')
    assert.equal(money(retailStatsAfter.total_actual_cost) - money(retailStatsBefore.total_actual_cost), money(expectedSale), 'Authoritative filtered customer charge must match the exact sale')
    assert.equal(retailStatsBefore.total_account_cost, 0, 'Cost-unknown media filter must not contain fabricated recorded procurement')
    assert.equal(retailStatsAfter.total_account_cost, 0, 'Actual repository statistics must not fall back to retail sale for unknown procurement')
    const publicStats = value => ({ total_requests: value.total_requests, total_actual_cost: value.total_actual_cost, total_account_cost: value.total_account_cost })
    report[kind + '_unknown_cost'] = { usage, stats_before: publicStats(retailStatsBefore), stats_after: publicStats(retailStatsAfter), stats_source: 'official admin usage/stats filtered by exact synthetic user and retail mode, nocache=1' }
    assert.equal(money(after.account_quota) - money(before.account_quota), money(expectedQuota), `${kind} Account quota delta differs from its frozen accounting contract`)
    assert.equal(supplierAfter[kind + '_posts'] - supplierBefore[kind + '_posts'], 1)
    const calls = supplierAfter.requests.filter(request => request.method === 'POST' && request.body.prompt === prompt)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].body.model, kind === 'image' ? 'gpt-image-2' : 'WAN3.0-可参考视频')
    // A fresh authenticated BFF session recovers the same durable task and bytes.
    await session(user)
    await media(user, kind, (kind === 'image' ? 'tasks/' : 'operations/') + taskID)
    await media(user, kind, 'tasks', kind === 'image' ? { task_id: taskID } : { operation_id: taskID })
    assert.deepEqual(snapshot(user), after, 'Recovery or duplicate click charged again')
    assert.equal(stats()[kind + '_posts'], supplierAfter[kind + '_posts'], 'Recovery replayed generation')
    report.tasks.push({ kind, id: taskID, before, after, expected_sale: expectedSale, expected_account_quota: expectedQuota, original_sha256: createHash('sha256').update(bytes).digest('hex'), supplier_posts: 1, recovery_reposts: 0 })
    if (kind === 'video') videoHistoryExpected.push({ operation_id: taskID, task_id: prepared.children?.[0]?.task_id, status: 'captured', offer_id: prepared.offer_id, model: prepared.model, spec: structuredClone(prepared.spec), sale_price: structuredClone(prepared.sale_price) })
    saveReport()
    return { taskID, after }
  }
  async function failVideo(user, selected) {
    const prompt = 'SYNTHETIC_VIDEO_TERMINAL_FAILURE:' + randomUUID()
    const prepared = await prepare(user, 'video', selected, 0, prompt)
    const childID = prepared.children?.[0]?.task_id
    assert.match(childID, /^av_[a-f0-9]{64}$/)
    const before = snapshot(user), postsBefore = stats().video_posts
    const submitted = await media(user, 'video', 'tasks', { operation_id: prepared.operation_id })
    assert([200, 202].includes(submitted.status), JSON.stringify(submitted))
    let terminal
    for (let attempt = 0; attempt < 30; attempt++) {
      terminal = ok(await media(user, 'video', 'operations/' + prepared.operation_id))
      if (terminal.status === 'released') break
      await sleep(500)
    }
    assert.equal(terminal.status, 'released', JSON.stringify(terminal))
    const order = JSON.parse(sql(`SELECT json_build_object('state',state,'release_reason',release_reason,'actual_amount',actual_amount) FROM studio_video_orders WHERE child_id='${childID}' AND user_id=${id(user.id)}`))
    assertVideoFailureRelease(before, snapshot(user), order, postsBefore, stats().video_posts)
    await session(user)
    await media(user, 'video', 'tasks', { operation_id: prepared.operation_id })
    await media(user, 'video', 'operations/' + prepared.operation_id)
    assertVideoFailureRelease(before, snapshot(user), order, postsBefore, stats().video_posts)
    const original = await fetch(base + '/studio-v2/api/video/operations/' + prepared.operation_id + '/original', { headers: { Cookie: user.cookie } })
    assert(original.status >= 400, 'Failed video exposed an original')
    report.video_failure_release = { operation_id: prepared.operation_id, order, balance_and_frozen_unchanged: true, usage_and_dedup_unchanged: true, supplier_posts: 1, recovery_reposts: 0 }
    videoHistoryExpected.push({ operation_id: prepared.operation_id, task_id: childID, status: 'released', offer_id: prepared.offer_id, model: prepared.model, spec: structuredClone(prepared.spec), sale_price: structuredClone(prepared.sale_price) })
    saveReport()
  }
  try {
    admin = await login(compose.services.core.environment.ADMIN_EMAIL, compose.services.core.environment.ADMIN_PASSWORD)
    const channels = (await core(admin, '/admin/channels?page=1&page_size=100')).items
    assert(channels.every(channel => channel.name.startsWith('Synthetic ')), 'Unexpected Channel in isolated fixture')
    for (const channel of channels.filter(channel => channel.group_ids.some(group => [imageGroup, videoGroup].includes(group)))) {
      detached.push({ id: channel.id, group_ids: channel.group_ids })
      await core(admin, '/admin/channels/' + channel.id, 'PUT', { group_ids: channel.group_ids.filter(group => ![imageGroup, videoGroup].includes(group)) })
    }
    assert.equal(Number(sql(`SELECT count(*) FROM channel_groups WHERE group_id IN (${id(imageGroup)},${id(videoGroup)})`)), 0)
    apiGroup = await core(admin, '/admin/groups', 'POST', { name: 'Synthetic procurement API only', platform: 'openai', rate_multiplier: 1, subscription_type: 'standard', is_exclusive: true })
    apiChannel = await core(admin, '/admin/channels', 'POST', { name: 'Synthetic procurement API channel', group_ids: [apiGroup.id], model_pricing: [{ platform: 'openai', models: ['procurement-chat-alias'], billing_mode: 'per_request', per_request_price: 0.125 }] })
    account = await core(admin, '/admin/accounts', 'POST', { name: 'Synthetic procurement shared Account', platform: 'openai', type: 'apikey', credentials: { api_key: 'synthetic-native-only', base_url: 'https://localhost:19090', model_mapping: { 'procurement-chat-alias': 'synthetic-chat-upstream' } }, extra: {}, rate_multiplier: 1.25, concurrency: 5, priority: 1, group_ids: [imageGroup, videoGroup, apiGroup.id], upstream_billing_probe_enabled: false })
    await core(admin, '/admin/accounts/' + account.id + '/models/sync-upstream', 'POST', {})
    const image = { product_id: 'procurement-isolated-image', media_type: 'image', site_model: 'gpt-image-2', display_name: 'Synthetic procurement image', upstream_model: 'gpt-image-2', enabled: true, capabilities: { resolutions: ['1K'], aspect_ratios: ['1:1'], qualities: [], durations_seconds: [], count: { min: 1, max: 2 }, references: { image: { min: 0, max: 1 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 1 }, combination_rules: [] }, pricing_rules: [{ match: {}, sale_price: price('0.9') }], adapter_config: { version: 1, model_family: 'openai_json', size_mappings: [], execution: { mode: 'native_multi', max_output_images: 2 }, edit_execution: { mode: 'single', max_output_images: 1 } } }
    const wan = { product_id: 'procurement-isolated-wan', media_type: 'video', site_model: 'WAN3.0-可参考视频', display_name: 'Synthetic procurement WAN', upstream_model: 'WAN3.0-可参考视频', enabled: true, capabilities: { resolutions: ['720p'], aspect_ratios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'], qualities: [], durations_seconds: [5, 10, 15], count: { min: 1, max: 1 }, references: { image: { min: 0, max: 10 }, video: { min: 0, max: 5 }, audio: { min: 0, max: 5 }, total_max: 14 }, combination_rules: [] }, pricing_rules: [{ match: {}, sale_price: price('2') }], adapter_config: { version: 1, wire_profile: 'inline_multimedia', size_mappings: [] } }
    const incomplete = { ...structuredClone(image), product_id: 'procurement-isolated-incomplete', display_name: 'Synthetic incomplete draft', pricing_rules: [{ match: {}, sale_price: null }] }
    const legacyVideoDraft = { ...structuredClone(wan), cost_version: 1, cost_rules: [{ match: {}, cost: price('0.3'), source: 'manual' }] }
    const legacyImageDraft = { ...structuredClone(image), cost_version: 1, cost_rules: [{ match: {}, cost: price('0.12'), source: 'manual' }] }
    let detail = await draft([legacyImageDraft, legacyVideoDraft, incomplete])
    const normalizedImage = detail.media_workbench_v1.draft.products.find(product => product.product_id === image.product_id)
    assert.equal(normalizedImage.cost_version, 2)
    assert.equal(normalizedImage.cost_rules?.length || 0, 0)
    assert.deepEqual(normalizedImage.pricing_rules, image.pricing_rules)
    const normalizedVideo = detail.media_workbench_v1.draft.products.find(product => product.product_id === wan.product_id)
    assert.equal(normalizedVideo.cost_version, 2)
    assert.equal(normalizedVideo.cost_rules?.length || 0, 0)
    assert.deepEqual(normalizedVideo.pricing_rules, wan.pricing_rules, 'Video cost normalization must preserve retail rules')
    report.checks.push('Saving legacy image/video drafts retires procurement while preserving exact retail rules and identity')
    assert.equal(detail.media_workbench_v1.validation.publish_ready, false)
    assert(detail.media_workbench_v1.validation.diagnostics.some(issue => /pricing_rules/i.test(issue.path)))
    const stale = await raw(admin, configPath() + '/draft', 'PUT', { expected_record_version: 0, draft: { products: [image] } })
    assert.equal(stale.status, 409)
    const rejected = await raw(admin, configPath() + '/publish', 'POST', { expected_record_version: detail.media_workbench_v1.record_version, expected_draft_revision: detail.media_workbench_v1.draft.revision, product_ids: [incomplete.product_id] })
    assert.equal(rejected.status, 422)
    detail = await publish(await core(admin, configPath()), [image.product_id, wan.product_id])
    assert.equal(detail.media_workbench_v1.published.products.find(product => product.product_id === image.product_id).cost_version, 2)
    assert.equal(detail.media_workbench_v1.published.products.find(product => product.product_id === image.product_id).cost_rules?.length || 0, 0)
    const publishedVideo = detail.media_workbench_v1.published.products.find(product => product.product_id === wan.product_id)
    assert.equal(publishedVideo.cost_version, 2, 'video retail contract must not fall back to Channel costing')
    assert.equal(publishedVideo.cost_rules?.length || 0, 0, 'video publication must not synthesize cost rules')
    assert.equal(detail.media_workbench_v1.draft.products.find(product => product.product_id === wan.product_id).cost_rules?.length || 0, 0)
    assert.equal(detail.media_workbench_v1.sales.enabled, false)
    await core(admin, configPath() + '/sales', 'PUT', { expected_record_version: detail.media_workbench_v1.record_version, enabled: true })
    await refreshPaidGrants()
    report.checks.push('Incomplete retail price saves but cannot publish; both media publish sale-only without Channel procurement; Account sales stays separate')
    const user = await customer('funded', 100, [imageGroup, videoGroup, apiGroup.id])
    // Native admission rejects exhausted balances; a positive balance below the
    // sale price is not a promise of projected-price pre-reservation.
    const poor = await customer('zero-balance', 0, [imageGroup, videoGroup])
    const unbound = await customer('no-studio-key', 100, [])
    const noGroup = await raw(unbound.token, '/keys', 'POST', { name: 'Denied synthetic key', group_id: apiGroup.id })
    assert([400, 403].includes(noGroup.status), JSON.stringify(noGroup))
    // Public Studio Groups remain bindable under native policy. This customer
    // has not created its own Studio Key; ticket exchange never creates one.
    const unboundKeys = await core(unbound.token, '/keys?page=1&page_size=100')
    assert(!unboundKeys.items.some(key => key.group_id === imageGroup))
    const deniedCatalog = await media(unbound, 'image', 'catalog')
    assert(deniedCatalog.status >= 400 || !deniedCatalog.body.offers?.some(item => item.product_id === image.product_id))
    report.checks.push('Customer cannot bind the unauthorized exclusive API Group; a separate customer without its own Studio Key cannot obtain the Studio offer (public Group binding policy unchanged)')
    const imgOffer = await offer(user, 'image', image.product_id), wanOffer = await offer(user, 'video', wan.product_id)
    // New media require no monetary Account limit; the native API below still
    // uses and consumes its original Account monetary quota.
    const beforeAlias = await prepare(user, 'image', imgOffer, 0, 'SYNTHETIC procurement pre-alias', 2)
    const native = await core(admin, '/admin/accounts/' + account.id)
    const mapped = { ...native.credentials, model_mapping: { ...native.credentials.model_mapping, 'gpt-image-2': 'wrong-api-image-only', 'WAN3.0-可参考视频': 'wrong-api-video-only' } }
    await core(admin, '/admin/accounts/' + account.id, 'PUT', { credentials: mapped })
    await setAccountQuota(core, admin, account, 100)
    const apiBefore = snapshot(user)
    const apiKey = user.keys.find(key => key.group_id === apiGroup.id)
    assert(apiKey && typeof apiKey.key === 'string', 'Native customer key must come from its own create response')
    const apiResponse = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Connection: 'close', 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey.key }, body: JSON.stringify({ model: 'procurement-chat-alias', messages: [{ role: 'user', content: 'SYNTHETIC procurement API isolation' }], stream: false }) })
    assert.equal(apiResponse.status, 200, await apiResponse.text())
    assert(stats().requests.some(request => request.method === 'POST' && request.path === '/v1/chat/completions' && request.body.model === 'synthetic-chat-upstream'))
    for (let i = 0; i < 20 && snapshot(user).usage === apiBefore.usage; i++) await sleep(250)
    const apiAfter = snapshot(user)
    assert.equal(money(apiBefore.balance) - money(apiAfter.balance), money('0.125'))
    assert.equal(apiAfter.usage - apiBefore.usage, 1)
    assert.equal(apiAfter.dedup - apiBefore.dedup, 1)
    const apiUsage = JSON.parse(sql(`SELECT json_build_object('group_id',group_id,'channel_id',channel_id,'account_id',account_id,'requested_model',requested_model,'upstream_model',upstream_model,'input_tokens',input_tokens,'output_tokens',output_tokens,'actual_cost',actual_cost) FROM usage_logs WHERE user_id=${id(user.id)} ORDER BY id DESC LIMIT 1`))
    assert.equal(apiUsage.group_id, apiGroup.id)
    assert.equal(apiUsage.channel_id, apiChannel.id)
    assert.equal(apiUsage.account_id, account.id)
    assert.equal(apiUsage.requested_model, 'procurement-chat-alias')
    assert.equal(apiUsage.upstream_model, 'synthetic-chat-upstream')
    assert.equal(apiUsage.input_tokens, 7)
    assert.equal(apiUsage.output_tokens, 9)
    assert.equal(money(apiUsage.actual_cost), money('0.125'))
    report.native_api = { pass: true, usage: apiUsage, requests: 1, customer_charge: '0.125', original_channel_billing: true }
    await core(admin, '/admin/channels/' + apiChannel.id, 'PUT', { model_pricing: [{ platform: 'openai', models: ['procurement-chat-alias'], billing_mode: 'per_request', per_request_price: 0.25 }], account_stats_pricing_rules: [{ name: 'Synthetic irrelevant API cost', group_ids: [], account_ids: [account.id], pricing: [{ platform: 'openai', models: ['*'], billing_mode: 'per_request', per_request_price: 99 }] }] })
    assert.equal((await offer(user, 'image', image.product_id)).offer_id, imgOffer.offer_id)
    assert.equal((await offer(user, 'video', wan.product_id)).offer_id, wanOffer.offer_id)
    assert(money(apiAfter.account_quota) > money(apiBefore.account_quota), 'Native API must still accrue Account procurement quota')
    await clearAccountQuota(core, admin, account)
    await refreshPaidGrants()
    await execute(user, 'image', beforeAlias, '1.8', '0', 'SYNTHETIC procurement pre-alias')
    for (const refs of [0, 1]) {
      const prompt = 'SYNTHETIC procurement WAN refs=' + refs
      const prepared = await prepare(user, 'video', wanOffer, refs, prompt)
      assert.equal(money(prepared.sale_price.amount), money('2'))
      await execute(user, 'video', prepared, '2', '0', prompt) // Unknown procurement: no inferred Account monetary consumption.
    }
    report.checks.push('One shared Account routes native API alias and charges API Channel price; Channel cost 99 and Account aliases leave Studio exact model/price unchanged; both media retain SQL NULL procurement and do not infer Account monetary usage; WAN refs0/1 execute, deliver, settle and recover once')
    await failVideo(user, wanOffer)
    // Use only the list endpoint here. Selecting or recovering an active task
    // would mask a broken native snapshot route with the old receipt path.
    assert.equal(videoHistoryExpected.length, 3)
    assert.equal(videoHistoryExpected.filter(task => task.status === 'captured').length, 2)
    assert.equal(videoHistoryExpected.filter(task => task.status === 'released').length, 1)
    const historyBefore = { ledger: snapshot(user), supplier: stats() }, historyReads = []
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await session(user)
      historyReads.push(assertVideoHistory(ok(await media(user, 'video', 'operations')), videoHistoryExpected))
      assertHistoryReadOnly(historyBefore, { ledger: snapshot(user), supplier: stats() })
    }
    report.video_history = { tasks: historyReads[0], authenticated_sessions: historyReads.length, pure_history: true, ledger_unchanged: true, supplier_requests_added: 0 }
    report.checks.push('Two completed videos and one released original retain exact operation/child/Offer/spec/price through real BFF/Bridge/Core history in original and fresh sessions; no receipt recovery, supplier request or ledger change')
    saveReport()
    const prior = structuredClone(report.tasks)
    const saved = await draft([{ ...image, pricing_rules: [{ match: {}, sale_price: price('1.1') }] }, { ...wan, pricing_rules: [{ match: {}, sale_price: price('2.5') }] }, incomplete])
    await publish(saved, [image.product_id, wan.product_id])
    await refreshPaidGrants()
    const zeroOffer = await offer(user, 'image', image.product_id)
    const zeroPrompt = 'SYNTHETIC sale-only updated price'
    await execute(user, 'image', await prepare(user, 'image', zeroOffer, 0, zeroPrompt), '1.1', '0', zeroPrompt)
    const currentBalance = snapshot(user)
    for (const original of prior) {
      const recovered = ok(await media(user, original.kind, (original.kind === 'image' ? 'tasks/' : 'operations/') + original.id))
      assert.equal(money((recovered.total_price || recovered.sale_price).amount), money(original.expected_sale))
    }
    assert.deepEqual(snapshot(user), currentBalance)
    report.checks.push('Unknown procurement remains SQL NULL after repricing; later publication does not rewrite or recharge completed original tasks')
    const poorBefore = snapshot(poor), postsBefore = stats().image_posts
    // The zero-balance native gate may also reject catalog reads. Use the
    // already-verified public offer identity and retain this customer's own Key.
    await media(poor, 'image', 'catalog')
    const poorQuote = await media(poor, 'image', 'quotes', { offer_id: zeroOffer.offer_id, spec: { resolution: '1K', aspect_ratio: '1:1', quality: '', duration_seconds: 0, count: 1, images: 0, videos: 0, audio: 0 } })
    let poorResult = poorQuote
    if (poorQuote.status === 200) {
      const prepared = await media(poor, 'image', 'prepare', { quote_token: poorQuote.body.quote_token, client_key: randomUUID(), prompt: 'SYNTHETIC poor rejected', asset_refs: [] })
      poorResult = prepared
      if (prepared.status === 200) poorResult = await media(poor, 'image', 'tasks', { task_id: prepared.body.task_id })
    }
    const poorAfter = snapshot(poor)
    assertZeroBalanceRejection(poorBefore, poorAfter, postsBefore, stats().image_posts, poorResult)
    report.balance_gate = { fixture_balance: poorBefore.balance, native_policy: 'nonpositive balance rejected; no projected-sale-price assumption', http_status: poorResult.status, task_status: poorResult.body.status, diagnostic_stage: poorResult.body.diagnostic_stage, supplier_posts: 0, usage_delta: poorAfter.usage - poorBefore.usage, balance_unchanged: true }
    await media(user, 'image', 'tasks'); await media(user, 'video', 'operations')
    await clearAccountQuota(core, admin, account)
    await refreshPaidGrants()
    const beforeBlocked = stats().video_posts
    report.native_controls = { schedulable_disabled: (await setAccountSchedulable(core, admin, account.id, false)).schedulable }
    const blocked = await media(user, 'video', 'quotes', { client_key: randomUUID(), offer_id: (await offer(user, 'video', wan.product_id).catch(() => wanOffer)).offer_id, model: wan.site_model, prompt: 'SYNTHETIC blocked', duration: 5, resolution: '720p', ratio: '16:9', assets: [] })
    assert(blocked.status >= 400); assert.equal(stats().video_posts, beforeBlocked)
    report.native_controls.schedulable_restored = (await setAccountSchedulable(core, admin, account.id, true)).schedulable
    const quotaAccount = await core(admin, '/admin/accounts/' + account.id)
    assert(money(snapshot(user).account_quota) > 0, 'Only the native API fixture must have consumed shared Account monetary quota')
    // Preserve the native current-usage gate; this acceptance does not invent
    // a second pre-reservation or a projected-quota accounting contract.
    report.native_controls.quota_limited = (await setAccountQuota(core, admin, quotaAccount, 0.00000001)).extra.quota_limit
    const limitedOffer = await offer(user, 'video', wan.product_id).catch(() => wanOffer)
    const quotaDenied = await media(user, 'video', 'quotes', { client_key: randomUUID(), offer_id: limitedOffer.offer_id, model: wan.site_model, prompt: 'SYNTHETIC quota denied', duration: 5, resolution: '720p', ratio: '16:9', assets: [] })
    assert(quotaDenied.status >= 400); assert.equal(stats().video_posts, beforeBlocked)
    // Even an unexhausted positive monetary limit rejects cost-unknown video.
    await setAccountQuota(core, admin, quotaAccount, 100)
    const unknownCostQuota = await media(user, 'video', 'quotes', { client_key: randomUUID(), offer_id: limitedOffer.offer_id, model: wan.site_model, prompt: 'SYNTHETIC monetary quota requires known cost', duration: 5, resolution: '720p', ratio: '16:9', assets: [] })
    assert(unknownCostQuota.status >= 400); assert.equal(stats().video_posts, beforeBlocked)
    // Customer errors remain deliberately redacted; the administrator gets the safe reason.
    const quotaPreflight = await core(admin, '/admin/media-workbench/paid-controls/video/check', 'POST', {})
    assert(quotaPreflight.checks.some(check => check.account_id === account.id && check.code === 'quote_account_quota_requires_cost' && check.pass === false), JSON.stringify(quotaPreflight))
    report.native_controls.video_monetary_quota_diagnostic = 'quote_account_quota_requires_cost'
    // The same unexhausted monetary limit rejects unknown-cost image retail.
    await setAccountQuota(core, admin, quotaAccount, 100)
    const beforeImageQuota = stats().image_posts
    const imageQuotaDenied = await media(user, 'image', 'quotes', { offer_id: zeroOffer.offer_id, spec: { resolution: '1K', aspect_ratio: '1:1', quality: '', duration_seconds: 0, count: 1, images: 0, videos: 0, audio: 0 } })
    assert(imageQuotaDenied.status >= 400)
    const imageQuotaPreflight = await core(admin, '/admin/media-workbench/paid-controls/image/check', 'POST', {})
    assert(imageQuotaPreflight.checks.some(check => check.account_id === account.id && check.code === 'quote_account_quota_requires_cost' && check.pass === false), JSON.stringify(imageQuotaPreflight))
    assert.equal(stats().image_posts, beforeImageQuota, 'Quota-denied image quote or preflight reached supplier generation')
    report.native_controls.image_monetary_quota_diagnostic = 'quote_account_quota_requires_cost'
    report.native_controls.quota_restored = (await clearAccountQuota(core, admin, quotaAccount)).extra?.quota_limit ?? null
    const videoKey = user.keys.find(key => key.group_id === videoGroup)
    report.native_controls.key_disabled = (await setKeyStatus(core, user.token, id(videoKey.id), 'inactive')).status
    await session(user)
    const inactiveKey = await media(user, 'video', 'catalog')
    assert(inactiveKey.status >= 400 || !inactiveKey.body.offers?.some(item => item.product_id === wan.product_id))
    report.native_controls.key_restored = (await setKeyStatus(core, user.token, videoKey.id, 'active')).status
    const apiAfterStudio = await core(admin, '/admin/channels/' + apiChannel.id)
    assert.equal(apiAfterStudio.model_pricing[0].per_request_price, 0.25)
    assert.equal(apiAfterStudio.account_stats_pricing_rules[0].pricing[0].per_request_price, 99)
    assert.deepEqual((await core(admin, '/admin/accounts/' + account.id)).credentials.model_mapping, mapped.model_mapping)
    report.checks.push('Exhausted native balance, shared Account quota, real Account schedulability and inactive native Group key block generation; Studio writes preserve API prices, mappings and permissions; catalog/quote/task/history/errors expose no private costs or credentials')
    report.pass = true
  } finally {
    const errors = []
    for (const channel of detached) {
      try { await core(admin, '/admin/channels/' + channel.id, 'PUT', { group_ids: channel.group_ids }) } catch (error) { errors.push(error.message) }
    }
    if (account) {
      try { report.cleanup_sales_enabled = await disableFixtureSales(core, admin, account.id) } catch (error) { errors.push(error.message) }
      try { report.cleanup_account_schedulable = (await setAccountSchedulable(core, admin, account.id, false)).schedulable } catch (error) { errors.push(error.message) }
    }
    report.restored = errors.length === 0
    if (errors.length) report.pass = false
    report.restore_errors = errors
    saveReport()
    assert.equal(errors.length, 0, 'Failed to restore isolated Channel associations or disable the fixture Account')
  }
  return report
}

module.exports.assertVideoFailureRelease = assertVideoFailureRelease
module.exports.assertVideoHistory = assertVideoHistory
module.exports.assertHistoryReadOnly = assertHistoryReadOnly
module.exports.assertPublic = assertPublic
module.exports.assertZeroBalanceRejection = assertZeroBalanceRejection
module.exports.setAccountSchedulable = setAccountSchedulable
module.exports.setAccountQuota = setAccountQuota
module.exports.clearAccountQuota = clearAccountQuota
module.exports.setKeyStatus = setKeyStatus
module.exports.disableFixtureSales = disableFixtureSales
if (require.main === module) module.exports(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1 })
