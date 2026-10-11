import fs from 'node:fs'
import assert from 'node:assert/strict'
const root = process.argv[2]
assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')))
const fixture = JSON.parse(fs.readFileSync(`${root}/evidence/fixture.json`, 'utf8'))
const origin = 'http://127.0.0.1:28180/api/v1'
const login = await fetch(origin+'/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'native-customer@example.invalid', password: 'Native-Customer-Only-20261012' }) }).then(r => r.json())
assert.equal(login.code, 0)
const headers = { Authorization: `Bearer ${login.data.access_token}`, 'Content-Type': 'application/json' }
const keys = await fetch(origin+'/keys', { headers }).then(r => r.json())
assert.equal(keys.code, 0)
for (const [platform, group] of Object.entries(fixture.groups)) {
  if (keys.data.items.some(k => k.group_id === group)) continue
  const response = await fetch(origin+'/keys', { method: 'POST', headers, body: JSON.stringify({ name: `Synthetic ${platform} customer`, group_id: group }) })
  const value = await response.json(); assert.equal(response.status, 200); assert.equal(value.code, 0)
  console.log(JSON.stringify({ platform, key_id: value.data.id, group_id: group }))
}
