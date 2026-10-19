import fs from 'node:fs'
import assert from 'node:assert/strict'
const root = process.argv[2]
assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')), 'explicit isolated workspace required')
const compose = JSON.parse(fs.readFileSync(`${root}/compose.json`, 'utf8'))
assert.equal(compose.services.core.container_name, 'ai-gateway-native-core-20261012')
assert.equal(compose.services.postgres.environment.POSTGRES_DB, 'sub2api')
const origin = 'http://127.0.0.1:28180/api/v1'
let token = ''
async function api(path, method = 'GET', body) {
  const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json()
  assert(response.ok && value.code === 0, `${path}: ${response.status} ${JSON.stringify(value)}`)
  return value.data
}
const env = compose.services.core.environment
const login = await api('/auth/login', 'POST', { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD })
token = login.access_token
assert(token)
const compliance = await api('/admin/compliance')
if (compliance.required) await api('/admin/compliance/accept', 'POST', { phrase: compliance.ack_phrase_zh, language: 'zh' })
const existing = await api('/admin/accounts?page=1&page_size=100')
assert(existing.items.every(a => a.name.startsWith('Synthetic ')), 'unexpected Account in isolated fixture')
const fixture = { groups: {}, accounts: {} }
const groups = await api('/admin/groups/all')
const channels = await api('/admin/channels?page=1&page_size=100')
let videoBridgeGroupID = 0
let videoCostChannel = null
const videoCostAccounts = []
const definitions = [
  { key: 'gemini', name: 'Synthetic gemini', platform: 'gemini', model: 'gemini-3.1-flash-image' },
  { key: 'grok', name: 'Synthetic grok', platform: 'grok', model: 'grok-imagine-video' },
  { key: 'openai', name: 'Synthetic openai', platform: 'openai', model: 'native-openai-image' },
  // The wizard selects a model from the synced upstream catalog. Keep the
  // account mapping explicit but identity-preserving so the validator sees
  // the same model the administrator selected; the simulator still records
  // the exact wire model sent by the native executor.
  { key: 'compatible', name: 'Synthetic compatible', platform: 'openai', model: 'synthetic-compatible-video', mapping: { 'synthetic-compatible-video': 'synthetic-compatible-video' } },
  { key: 'seedance', name: 'Synthetic seedance', platform: 'openai', model: 'synthetic-seedance-video', mapping: { 'synthetic-seedance-video': 'synthetic-seedance-video' }, capabilities: ['seedance'] },
]
for (const definition of definitions) {
  const { key, name, platform, mapping, capabilities } = definition
  const group = groups.find(g => g.name === name) || await api('/admin/groups', 'POST', { name, platform, rate_multiplier: 1, subscription_type: 'standard', allow_image_generation: true })
  const credentials = { api_key: 'synthetic-native-only', base_url: 'https://localhost:19090', ...(mapping ? { model_mapping: mapping } : {}), ...(capabilities ? { openai_capabilities: capabilities } : {}) }
  if (key === 'grok') videoBridgeGroupID = group.id
  const accountGroupIDs = videoBridgeGroupID && (key === 'compatible' || key === 'seedance') ? [videoBridgeGroupID, group.id] : [group.id]
  const account = existing.items.find(a => a.name === name) || await api('/admin/accounts', 'POST', { name, platform, type: 'apikey', credentials, extra: ['grok', 'compatible', 'seedance'].includes(key) ? {} : { quota_limit: 100 }, concurrency: 5, priority: 1, group_ids: accountGroupIDs, upstream_billing_probe_enabled: false })
  fixture.groups[key] = group.id; fixture.accounts[key] = account.id
  const sync = await api(`/admin/accounts/${account.id}/models/sync-upstream`, 'POST', {})
  if (key === 'grok') {
    videoCostAccounts.push({ key, accountID: account.id, platform })
    if (!channels.items.some(c => c.name === `${name} cost`)) videoCostChannel = await api('/admin/channels', 'POST', { name: `${name} cost`, group_ids: accountGroupIDs, account_stats_pricing_rules: [{ name: `Synthetic exact ${key} Account cost`, group_ids: [], account_ids: [account.id], pricing: [{ platform, models: ['*'], billing_mode: 'per_request', per_request_price: 0.35 }] }] })
    else videoCostChannel = channels.items.find(c => c.name === `${name} cost`)
  } else if (key === 'compatible' || key === 'seedance') {
    videoCostAccounts.push({ key, accountID: account.id, platform })
  } else if (!channels.items.some(c => c.name === `${name} cost`)) {
    await api('/admin/channels', 'POST', { name: `${name} cost`, group_ids: accountGroupIDs, account_stats_pricing_rules: [{ name: `Synthetic exact ${key} Account cost`, group_ids: [], account_ids: [account.id], pricing: [{ platform, models: ['*'], billing_mode: 'per_request', per_request_price: 0.35 }] }] })
  }
  console.log(JSON.stringify({ key, platform, group: group.id, account: account.id, sync }))
}
if (videoCostChannel && videoCostAccounts.length > 1) {
  const rules = videoCostAccounts.map(({ key, accountID, platform }) => ({ name: `Synthetic exact ${key} Account cost`, group_ids: [], account_ids: [accountID], pricing: [{ platform, models: ['*'], billing_mode: 'per_request', per_request_price: 0.35 }] }))
  await api(`/admin/channels/${videoCostChannel.id}`, 'PUT', { account_stats_pricing_rules: rules })
}
const customer = await api('/admin/users', 'POST', { email: 'native-customer@example.invalid', password: 'Native-Customer-Only-20261012', balance: 100, concurrency: 5, allowed_groups: Object.values(fixture.groups) })
fixture.customer = customer.id
fs.writeFileSync(`${root}/evidence/fixture.json`, JSON.stringify(fixture, null, 2))
console.log(JSON.stringify(fixture))
