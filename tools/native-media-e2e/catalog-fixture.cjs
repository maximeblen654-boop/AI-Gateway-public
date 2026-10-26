'use strict'
// Isolated fixture writes use the reviewed catalog-dependencies DB-clock/readback contract.
const assert=require('node:assert/strict')
function createCatalogFixture({query,accountId}){
 assert.equal(typeof query,'function');assert(Number.isSafeInteger(accountId)&&accountId>0)
 const where=`id=${accountId} AND name LIKE 'Synthetic %'`
 const read=()=>JSON.parse(query(`SELECT extra->'upstream_model_catalog_snapshot' FROM accounts WHERE ${where}`))
 const sqlJSON=value=>"'"+JSON.stringify(value).replace(/'/g,"''")+"'::jsonb"
 let capturedIdentity
 async function captureAfterSync(syncUpstream){
  assert.equal(typeof syncUpstream,'function')
  await syncUpstream() // Caller first installs the simulator URL and current credentials.
  const catalog=read()
  assert(catalog&&catalog.source==='upstream','isolated baseline must come from normal upstream sync')
  assert.match(catalog.account_identity_sha256||'',/^[a-f0-9]{64}$/,'isolated baseline identity must be current')
  assert(Number.isFinite(Date.parse(catalog.synced_at)),'isolated baseline sync time must be valid')
  assert(Array.isArray(catalog.models)&&catalog.models.length>0&&catalog.models.every(value=>typeof value==='string'&&value),'isolated baseline model IDs must be complete')
  assert.equal(new Set(catalog.models).size,catalog.models.length,'isolated baseline model IDs must be unique')
  capturedIdentity=catalog.account_identity_sha256
  return catalog
 }
 function setCatalog(value){
  assert(capturedIdentity,'capture the current post-URL sync baseline before injection')
  assert.equal(value.account_identity_sha256,capturedIdentity,'isolated injection must retain the captured current identity')
  const syncedAt=query(`SELECT to_char((clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`)
  assert(Number.isFinite(Date.parse(syncedAt)),'isolated catalog clock must be valid')
  const next={...value,synced_at:syncedAt}
  assert(query(`UPDATE accounts SET extra=jsonb_set(extra,'{upstream_model_catalog_snapshot}',${sqlJSON(next)}) WHERE ${where} RETURNING id`).split(/\r?\n/).includes(String(accountId)))
  assert.deepEqual(read(),next,'isolated catalog injection must be read back exactly')
  return next
 }
 return {captureAfterSync,setCatalog}
}
module.exports={createCatalogFixture}
