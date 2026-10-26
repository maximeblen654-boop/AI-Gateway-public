// Reuse the existing isolated paid-controls browser/session and PostgreSQL.
const assert=require('node:assert/strict')
const {assertPreflightSupplierStats}=require('./preflight-supplier-stats.cjs')
module.exports=async({fixture,dc,api,current,check,change,media,page,base,accountPath,p,stats,before})=>{
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted')
 assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO,'paid-controls')
 const id=fixture.accounts.openai;assert(Number.isSafeInteger(id))
 const query=q=>dc('exec','-T','postgres','psql','-X','-U','native','-d','sub2api','-At','-v','ON_ERROR_STOP=1','-c',q).toString().trim()
 const sqlJSON=v=>"'"+JSON.stringify(v).replace(/'/g,"''")+"'::jsonb"
 const catalog=JSON.parse(query(`SELECT extra->'upstream_model_catalog_snapshot' FROM accounts WHERE id=${id} AND name LIKE 'Synthetic %'`))
 const config=structuredClone((await api(accountPath)).media_workbench_v1)
 assert(config.published.dependencies.catalog_sha256.startsWith('published-models-v1:'))
 // A changed observation time is harmless only while it remains trustworthy
 // and fresh. The earlier Image2Pro fixture activates the runtime freshness gate.
 // Timestamp every isolated injection, including model deletion and restoration,
 // with the database clock so Ensure cannot refresh away an expired test case.
 const setCatalog=v=>{
  const syncedAt=query(`SELECT to_char((clock_timestamp() - interval '1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`)
  assert(Number.isFinite(Date.parse(syncedAt)),'isolated catalog clock must be valid')
  const next={...v,synced_at:syncedAt}
  assert(query(`UPDATE accounts SET extra=jsonb_set(extra,'{upstream_model_catalog_snapshot}',${sqlJSON(next)}) WHERE id=${id} AND name LIKE 'Synthetic %' RETURNING id`).split(/\r?\n/).includes(String(id)))
  assert.deepEqual(JSON.parse(query(`SELECT extra->'upstream_model_catalog_snapshot' FROM accounts WHERE id=${id} AND name LIKE 'Synthetic %'`)),next,'isolated catalog injection must be read back exactly')
 }
 await page.goto(base+'/video-studio')
 const {expect}=require('../../frontend/node_modules/@playwright/test')
 await expect.poll(async()=>(await media('image','catalog')).status).toBe(200)
 const offer=config.published.offers[0]
 const quote=images=>media('image','quotes','POST',{offer_id:offer.offer_id,spec:{resolution:'4K',aspect_ratio:'16:9',count:3,images,videos:0,audio:0,duration_seconds:0,quality:''}})
 const stable=await check('image'),quotes=[]
 for(const images of [0,1,16]){const q=await quote(images);assert.equal(q.status,200,JSON.stringify(q));quotes.push(q.body)}
 for(const [label,next] of [
  ['timestamp',{...catalog}],
  ['unrelated model',{...catalog,models:[...catalog.models,'Nano-banana-2.1-unpublished']}],
  ['ordering',{...catalog,models:[...catalog.models].reverse()}]
 ]){
  setCatalog(next);assert.equal((await current('image')).effective_enabled,true,label)
  const c=await check('image');assert.equal(c.fingerprint,stable.fingerprint,label);assert.equal(c.metrics.specs_checked,1870)
  for(const images of [0,1,16])assert.equal((await quote(images)).status,200,label)
  assert.deepEqual((await api(accountPath)).media_workbench_v1,config,label+' changed product config')
 }
 setCatalog({...catalog,models:catalog.models.filter(m=>m!=='gpt-image-2')})
 assert.equal((await current('image')).effective_enabled,false)
 assert.equal((await api(p+'image/check','POST',{})).pass,false)
 for(const images of [0,1])assert.equal((await quote(images)).status,409,'deleted model quote')
 setCatalog(catalog)
 assert.equal((await current('image')).effective_enabled,false,'restored dependency auto-reopened grant')
 const recheck=await check('image');assert.equal((await change('image',true,recheck)).status,200)
 assert.equal((await current('image')).effective_enabled,true);assert.equal((await current('video')).effective_enabled,false)
 assert.deepEqual((await api(accountPath)).media_workbench_v1,config)
 const supplier_observation=assertPreflightSupplierStats(stats(),before)
 return{pass:true,specs:1870,quotes,irrelevant_changes_preserved_grant:true,model_deletion_closed_and_rejected:true,restore_required_explicit_recheck:true,all_product_config_unchanged:true,supplier_observation}
}
