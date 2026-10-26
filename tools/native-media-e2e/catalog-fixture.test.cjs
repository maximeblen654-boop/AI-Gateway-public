'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const {createCatalogFixture}=require('./catalog-fixture.cjs')
const oldCatalog={source:'upstream',account_identity_sha256:'a'.repeat(64),synced_at:'2026-10-25T00:00:00Z',models:['gpt-image-2','gpt-image-1']}
const currentCatalog={...oldCatalog,account_identity_sha256:'b'.repeat(64),synced_at:'2026-10-26T00:00:00Z'}
const clock='2026-10-26T01:00:00.000000Z'
function fixture({mismatch=false,invalidClock=false,missingRow=false}={}){
 const calls=[],state={catalog:structuredClone(oldCatalog),synced:false,next:null}
 const query=sql=>{
  calls.push(sql)
  assert(sql.includes("name LIKE 'Synthetic %'")||sql.startsWith('SELECT to_char('),'fixture SQL must remain synthetic-only')
  if(sql.startsWith('SELECT to_char('))return invalidClock?'not-a-clock':clock
  if(sql.startsWith('UPDATE accounts '))return missingRow?'UPDATE 0':'44\nUPDATE 1'
  assert(sql.startsWith("SELECT extra->'upstream_model_catalog_snapshot'"))
  if(state.next)return JSON.stringify(mismatch?{...state.next,models:currentCatalog.models}:state.next)
  assert(state.synced,'baseline read happened before normal post-URL sync')
  return JSON.stringify(state.catalog)
 }
 const adapter=createCatalogFixture({query,accountId:44})
 const sync=async()=>{calls.push('NORMAL_SYNC_AFTER_URL_CHANGE');state.synced=true;state.catalog=structuredClone(currentCatalog)}
 return {adapter,sync,calls,state}
}
test('baseline is read only after normal sync has produced the new URL identity',async()=>{
 const {adapter,sync,calls}=fixture()
 const baseline=await adapter.captureAfterSync(sync)
 assert.equal(calls[0],'NORMAL_SYNC_AFTER_URL_CHANGE')
 assert.equal(baseline.account_identity_sha256,currentCatalog.account_identity_sha256)
 assert.notEqual(baseline.account_identity_sha256,oldCatalog.account_identity_sha256)
})
test('model removal and restoration use DB-clock freshness and exact readback without mutating the baseline',async()=>{
 const {adapter,sync,calls,state}=fixture(),baseline=await adapter.captureAfterSync(sync),original=structuredClone(baseline)
 const removed={...baseline,models:['gpt-image-1']};state.next={...removed,synced_at:clock}
 const injected=adapter.setCatalog(removed)
 assert.equal(injected.synced_at,clock);assert.deepEqual(injected.models,['gpt-image-1'])
 assert(calls.at(-3).includes("clock_timestamp() - interval '1 second'"))
 assert(calls.at(-2).includes('RETURNING id'));assert(calls.at(-1).startsWith("SELECT extra->'upstream_model_catalog_snapshot'"))
 state.next={...baseline,synced_at:clock};adapter.setCatalog(baseline)
 assert.deepEqual(baseline,original,'restoration must not rewrite the captured baseline object')
})
test('a concurrent or wrong catalog readback rejects the injection',async()=>{
 const {adapter,sync,state}=fixture({mismatch:true}),baseline=await adapter.captureAfterSync(sync)
 state.next={...baseline,models:['gpt-image-1'],synced_at:clock}
 assert.throws(()=>adapter.setCatalog({...baseline,models:['gpt-image-1']}),/read back exactly/)
})
test('an old identity, invalid DB clock or non-synthetic missing row fails before acceptance',async()=>{
 const valid=fixture(),baseline=await valid.adapter.captureAfterSync(valid.sync)
 assert.throws(()=>valid.adapter.setCatalog(oldCatalog),/captured current identity/)
 for(const options of [{invalidClock:true},{missingRow:true}]){
  const f=fixture(options),base=await f.adapter.captureAfterSync(f.sync);f.state.next={...base,synced_at:clock}
  assert.throws(()=>f.adapter.setCatalog(base))
  if(options.invalidClock)assert(!f.calls.some(sql=>sql.startsWith('UPDATE accounts ')))
 }
})
test('failed normal sync cannot expose an earlier catalog as the current baseline',async()=>{
 const f=fixture()
 await assert.rejects(f.adapter.captureAfterSync(async()=>{throw Error('normal sync failed')}),/normal sync failed/)
 assert.equal(f.calls.length,0)
 assert.throws(()=>f.adapter.setCatalog(currentCatalog),/capture the current post-URL sync baseline/)
})
