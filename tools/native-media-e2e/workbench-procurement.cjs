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
  const id = value => { assert(Number.isSafeInteger(value) && value > 0); return value }
  const snapshot = user => JSON.parse(sql(`SELECT json_build_object('balance',balance::text,'frozen',frozen_balance::text,'usage',(SELECT count(*) FROM usage_logs WHERE user_id=${id(user.id)}),'cost',(SELECT COALESCE(sum(actual_cost),0)::text FROM usage_logs WHERE user_id=${id(user.id)}),'account_quota',(SELECT COALESCE(extra->>'quota_used','0') FROM accounts WHERE id=${id(account.id)})) FROM users WHERE id=${id(user.id)}`))
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
    // The real WAN inline_multimedia profile still requires Account-bound
    // reference preparation. Its inputMode is the wire mode, not "references".
    if (refs) {
      preparation_id = ok(await media(user, kind, 'prepare', { offer_id: selected.offer_id, model: 'WAN3.0-可参考视频', spec: { resolution: '720p', duration_seconds: 5, aspect_ratio: '16:9' }, assets })).preparation_id
    }
    return ok(await media(user, kind, 'quotes', { client_key: randomUUID(), offer_id: selected.offer_id, model: 'WAN3.0-可参考视频', prompt, duration: 5, resolution: '720p', ratio: '16:9', assets, ...(preparation_id ? { preparation_id } : {}) }))
  }
  async function execute(user, kind, prepared, expectedSale, expectedQuota, prompt) {
    const taskID = kind === 'image' ? prepared.task_id : prepared.operation_id
    const before = snapshot(user), supplierBefore = stats()
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
    assert.equal(money(after.account_quota) - money(before.account_quota), money(expectedQuota))
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
    saveReport()
    return { taskID, after }
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
    account = await core(admin, '/admin/accounts', 'POST', { name: 'Synthetic procurement shared Account', platform: 'openai', type: 'apikey', credentials: { api_key: 'synthetic-native-only', base_url: 'https://localhost:19090', model_mapping: { 'procurement-chat-alias': 'synthetic-chat-upstream' } }, extra: { quota_limit: 100 }, rate_multiplier: 1.25, concurrency: 5, priority: 1, group_ids: [imageGroup, videoGroup, apiGroup.id], upstream_billing_probe_enabled: false })
    await core(admin, '/admin/accounts/' + account.id + '/models/sync-upstream', 'POST', {})
    const image = { product_id: 'procurement-isolated-image', media_type: 'image', site_model: 'gpt-image-2', display_name: 'Synthetic procurement image', upstream_model: 'gpt-image-2', enabled: true, capabilities: { resolutions: ['1K'], aspect_ratios: ['1:1'], qualities: [], durations_seconds: [], count: { min: 1, max: 2 }, references: { image: { min: 0, max: 1 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 1 }, combination_rules: [] }, pricing_rules: [{ match: {}, sale_price: price('0.9') }], cost_rules: [{ match: {}, cost: price('0.12'), source: 'manual' }], adapter_config: { version: 1, model_family: 'openai_json', size_mappings: [], execution: { mode: 'native_multi', max_output_images: 2 }, edit_execution: { mode: 'single', max_output_images: 1 } } }
    const wan = { product_id: 'procurement-isolated-wan', media_type: 'video', site_model: 'WAN3.0-可参考视频', display_name: 'Synthetic procurement WAN', upstream_model: 'WAN3.0-可参考视频', enabled: true, capabilities: { resolutions: ['720p'], aspect_ratios: ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'], qualities: [], durations_seconds: [5, 10, 15], count: { min: 1, max: 1 }, references: { image: { min: 0, max: 10 }, video: { min: 0, max: 5 }, audio: { min: 0, max: 5 }, total_max: 14 }, combination_rules: [] }, pricing_rules: [{ match: {}, sale_price: price('2') }], cost_rules: [5, 10, 15].map((seconds, index) => ({ match: { duration_seconds: [seconds] }, cost: price(['0.3', '0.6', '0.9'][index]), source: 'manual' })), adapter_config: { version: 1, wire_profile: 'inline_multimedia', size_mappings: [] } }
    const incomplete = { ...structuredClone(image), product_id: 'procurement-isolated-incomplete', display_name: 'Synthetic incomplete draft', cost_rules: [{ match: {}, cost: null, source: 'manual' }] }
    let detail = await draft([image, wan, incomplete])
    assert.equal(detail.media_workbench_v1.validation.publish_ready, false)
    assert(detail.media_workbench_v1.validation.diagnostics.some(issue => /cost/i.test(issue.path)))
    const stale = await raw(admin, configPath() + '/draft', 'PUT', { expected_record_version: 0, draft: { products: [image] } })
    assert.equal(stale.status, 409)
    const rejected = await raw(admin, configPath() + '/publish', 'POST', { expected_record_version: detail.media_workbench_v1.record_version, expected_draft_revision: detail.media_workbench_v1.draft.revision, product_ids: [incomplete.product_id] })
    assert.equal(rejected.status, 422)
    detail = await publish(await core(admin, configPath()), [image.product_id, wan.product_id])
    assert(detail.media_workbench_v1.published.products.every(product => product.cost_version === 1))
    assert.equal(detail.media_workbench_v1.sales.enabled, false)
    await core(admin, configPath() + '/sales', 'PUT', { expected_record_version: detail.media_workbench_v1.record_version, enabled: true })
    report.checks.push('Incomplete cost saves; server rejects incomplete selected publication; selected complete products publish atomically with server cost_version=1; sales stays separate; both Studio Groups have no Channel')
    const user = await customer('funded', 100, [imageGroup, videoGroup, apiGroup.id])
    const poor = await customer('poor', 0.01, [imageGroup, videoGroup])
    const unauthorized = await customer('no-group', 100, [])
    const noGroup = await raw(unauthorized.token, '/keys', 'POST', { name: 'Denied synthetic key', group_id: apiGroup.id })
    assert([400, 403].includes(noGroup.status), JSON.stringify(noGroup))
    const deniedCatalog = await media(unauthorized, 'image', 'catalog')
    assert(deniedCatalog.status >= 400 || !deniedCatalog.body.offers?.some(item => item.product_id === image.product_id))
    report.checks.push('Unprivileged customer cannot create a Group key or obtain the Studio offer')
    const imgOffer = await offer(user, 'image', image.product_id), wanOffer = await offer(user, 'video', wan.product_id)
    const beforeAlias = await prepare(user, 'image', imgOffer, 0, 'SYNTHETIC procurement pre-alias', 2)
    const native = await core(admin, '/admin/accounts/' + account.id)
    const mapped = { ...native.credentials, model_mapping: { ...native.credentials.model_mapping, 'gpt-image-2': 'wrong-api-image-only', 'WAN3.0-可参考视频': 'wrong-api-video-only' } }
    await core(admin, '/admin/accounts/' + account.id, 'PUT', { credentials: mapped })
    const apiBefore = snapshot(user)
    const apiKey = user.keys.find(key => key.group_id === apiGroup.id)
    assert(apiKey && typeof apiKey.key === 'string', 'Native customer key must come from its own create response')
    const apiResponse = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { Connection: 'close', 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey.key }, body: JSON.stringify({ model: 'procurement-chat-alias', messages: [{ role: 'user', content: 'SYNTHETIC procurement API isolation' }], stream: false }) })
    assert.equal(apiResponse.status, 200, await apiResponse.text())
    assert(stats().requests.some(request => request.method === 'POST' && request.path === '/v1/chat/completions' && request.body.model === 'synthetic-chat-upstream'))
    for (let i = 0; i < 20 && snapshot(user).usage === apiBefore.usage; i++) await sleep(250)
    assert.equal(money(apiBefore.balance) - money(snapshot(user).balance), money('0.125'))
    await core(admin, '/admin/channels/' + apiChannel.id, 'PUT', { model_pricing: [{ platform: 'openai', models: ['procurement-chat-alias'], billing_mode: 'per_request', per_request_price: 0.25 }], account_stats_pricing_rules: [{ name: 'Synthetic irrelevant API cost', group_ids: [], account_ids: [account.id], pricing: [{ platform: 'openai', models: ['*'], billing_mode: 'per_request', per_request_price: 99 }] }] })
    assert.equal((await offer(user, 'image', image.product_id)).offer_id, imgOffer.offer_id)
    assert.equal((await offer(user, 'video', wan.product_id)).offer_id, wanOffer.offer_id)
    await execute(user, 'image', beforeAlias, '1.8', '0.3', 'SYNTHETIC procurement pre-alias')
    for (const refs of [0, 1]) {
      const prompt = 'SYNTHETIC procurement WAN refs=' + refs
      const prepared = await prepare(user, 'video', wanOffer, refs, prompt)
      assert.equal(money(prepared.sale_price.amount), money('2'))
      await execute(user, 'video', prepared, '2', '0.375', prompt)
    }
    report.checks.push('One shared Account routes native API alias and charges API Channel price; Channel cost 99 and Account aliases leave Studio exact model/price/cost unchanged; WAN refs0/1 execute, deliver, settle and recover once')
    const prior = structuredClone(report.tasks)
    const saved = await draft([{ ...image, pricing_rules: [{ match: {}, sale_price: price('1.1') }], cost_rules: [{ match: {}, cost: price('0'), source: 'manual' }] }, { ...wan, pricing_rules: [{ match: {}, sale_price: price('2.5') }], cost_rules: [{ match: {}, cost: price('0.44'), source: 'manual' }] }, incomplete])
    await publish(saved, [image.product_id, wan.product_id])
    const zeroOffer = await offer(user, 'image', image.product_id)
    const zeroPrompt = 'SYNTHETIC procurement explicit zero'
    await execute(user, 'image', await prepare(user, 'image', zeroOffer, 0, zeroPrompt), '1.1', '0', zeroPrompt)
    const currentBalance = snapshot(user)
    for (const original of prior) {
      const recovered = ok(await media(user, original.kind, (original.kind === 'image' ? 'tasks/' : 'operations/') + original.id))
      assert.equal(money((recovered.total_price || recovered.sale_price).amount), money(original.expected_sale))
    }
    assert.deepEqual(snapshot(user), currentBalance)
    report.checks.push('Explicit zero cost is preserved; later published costs and sale prices do not rewrite or recharge completed original tasks')
    const poorBefore = snapshot(poor), postsBefore = stats().image_posts
    const poorCatalog = await offer(poor, 'image', image.product_id)
    const poorQuote = await media(poor, 'image', 'quotes', { offer_id: poorCatalog.offer_id, spec: { resolution: '1K', aspect_ratio: '1:1', quality: '', duration_seconds: 0, count: 1, images: 0, videos: 0, audio: 0 } })
    if (poorQuote.status === 200) {
      const prepared = await media(poor, 'image', 'prepare', { quote_token: poorQuote.body.quote_token, client_key: randomUUID(), prompt: 'SYNTHETIC poor rejected', asset_refs: [] })
      if (prepared.status === 200) assert((await media(poor, 'image', 'tasks', { task_id: prepared.body.task_id })).status >= 400)
    }
    assert.deepEqual(snapshot(poor), poorBefore); assert.equal(stats().image_posts, postsBefore)
    await media(user, 'image', 'tasks'); await media(user, 'video', 'operations')
    const beforeBlocked = stats().video_posts
    await core(admin, '/admin/accounts/' + account.id, 'PUT', { schedulable: false })
    const blocked = await media(user, 'video', 'quotes', { client_key: randomUUID(), offer_id: (await offer(user, 'video', wan.product_id).catch(() => wanOffer)).offer_id, model: wan.site_model, prompt: 'SYNTHETIC blocked', duration: 5, resolution: '720p', ratio: '16:9', assets: [] })
    assert(blocked.status >= 400); assert.equal(stats().video_posts, beforeBlocked)
    await core(admin, '/admin/accounts/' + account.id, 'PUT', { schedulable: true })
    const quotaAccount = await core(admin, '/admin/accounts/' + account.id)
    const quotaSnapshot = snapshot(user)
    await core(admin, '/admin/accounts/' + account.id, 'PUT', { extra: { ...quotaAccount.extra, quota_limit: Number(quotaSnapshot.account_quota) + 0.1 } })
    const limitedOffer = await offer(user, 'video', wan.product_id).catch(() => wanOffer)
    const quotaDenied = await media(user, 'video', 'quotes', { client_key: randomUUID(), offer_id: limitedOffer.offer_id, model: wan.site_model, prompt: 'SYNTHETIC quota denied', duration: 5, resolution: '720p', ratio: '16:9', assets: [] })
    assert(quotaDenied.status >= 400); assert.equal(stats().video_posts, beforeBlocked)
    await core(admin, '/admin/accounts/' + account.id, 'PUT', { extra: { ...quotaAccount.extra, quota_limit: 100 } })
    const videoKey = user.keys.find(key => key.group_id === videoGroup)
    await core(user.token, '/keys/' + id(videoKey.id), 'PUT', { status: 'inactive' })
    await session(user)
    const inactiveKey = await media(user, 'video', 'catalog')
    assert(inactiveKey.status >= 400 || !inactiveKey.body.offers?.some(item => item.product_id === wan.product_id))
    await core(user.token, '/keys/' + videoKey.id, 'PUT', { status: 'active' })
    const apiAfterStudio = await core(admin, '/admin/channels/' + apiChannel.id)
    assert.equal(apiAfterStudio.model_pricing[0].per_request_price, 0.25)
    assert.equal(apiAfterStudio.account_stats_pricing_rules[0].pricing[0].per_request_price, 99)
    assert.deepEqual((await core(admin, '/admin/accounts/' + account.id)).credentials.model_mapping, mapped.model_mapping)
    report.checks.push('Insufficient balance, shared Account quota, real Account schedulability and inactive native Group key block generation; Studio writes preserve API prices, mappings and permissions; catalog/quote/task/history/errors expose no private costs or credentials')
    report.pass = true
  } finally {
    const errors = []
    for (const channel of detached) {
      try { await core(admin, '/admin/channels/' + channel.id, 'PUT', { group_ids: channel.group_ids }) } catch (error) { errors.push(error.message) }
    }
    if (account) {
      try { await core(admin, '/admin/accounts/' + account.id, 'PUT', { schedulable: false }) } catch (error) { errors.push(error.message) }
    }
    report.restored = errors.length === 0
    report.restore_errors = errors
    saveReport()
    assert.equal(errors.length, 0, 'Failed to restore isolated Channel associations')
  }
  return report
}

module.exports.assertPublic = assertPublic
if (require.main === module) module.exports(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1 })
