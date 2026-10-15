// Incremental acceptance against final Core/Bridge/BFF and isolated PostgreSQL.
// Only the existing local supplier is simulated. No browser routes are mocked.
const fs=require('node:fs'),assert=require('node:assert/strict')
const {createHash,randomUUID}=require('node:crypto')
const {expect}=require('../../frontend/node_modules/@playwright/test')
module.exports=async({root,fixture,dc,api,raw,current,check,change,media,page,base,accountPath,stats})=>{
 assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted')
 assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO,'paid-controls')
 assert.equal(process.env.NATIVE_WORKSPACE_ARTIFACT,'true')
 assert.notEqual(process.env.NATIVE_WORKSPACE_DEV_SERVER,'true')
 assert.equal(base,'http://127.0.0.1:28100');assert(root.endsWith('/native-media-20261012'))
 const compose=JSON.parse(fs.readFileSync(root+'/compose.json'))
 assert.equal(compose.services.core.container_name,'ai-gateway-native-core-20261012')
 assert.equal(compose.services.postgres.environment.POSTGRES_DB,'sub2api')
 assert.equal(compose.services.core.environment.ADMIN_EMAIL,'native-admin@example.invalid')
 const reportPath=root+'/evidence/native-model-lifecycle.json'
 assert(!fs.existsSync(reportPath),'Use a fresh isolated run; never duplicate a prior lifecycle task')
 const report={production:false,api_mocking:false,supplier:'local simulator only',source_sha:process.env.NATIVE_CANDIDATE_SOURCE_SHA,checks:[],screenshots:[],actions:[]}
 const save=()=>fs.writeFileSync(reportPath,JSON.stringify(report,null,2))
 const query=q=>dc('exec','-T','postgres','psql','-X','-U','native','-d','sub2api','-At','-v','ON_ERROR_STOP=1','-c',q).toString().trim()
 const sqlJSON=v=>"'"+JSON.stringify(v).replace(/'/g,"''")+"'::jsonb"
 const id=fixture.accounts.openai,gid=fixture.groups.openai
 assert(Number.isSafeInteger(id)&&Number.isSafeInteger(gid))
 const nativeCatalog=JSON.parse(query(`SELECT extra->'upstream_model_catalog_snapshot' FROM accounts WHERE id=${id} AND name LIKE 'Synthetic %'`))
 const setCatalog=value=>assert(query(`UPDATE accounts SET extra=jsonb_set(extra,'{upstream_model_catalog_snapshot}',${sqlJSON(value)}) WHERE id=${id} AND name LIKE 'Synthetic %' RETURNING id`).split(/\r?\n/).includes(String(id)))
 const ok=r=>{assert.equal(r.status,200,JSON.stringify(r));return r.body}
 const config=async(path=accountPath)=>(await api(path)).media_workbench_v1
 const saveDraft=async(path,products)=>{const c=await config(path);return (await api(path+'/draft','PUT',{expected_record_version:c?.record_version||0,draft:{products}})).media_workbench_v1}
 const publish=async(path,c)=>api(path+'/publish','POST',{expected_record_version:c.record_version,expected_draft_revision:c.draft.revision})
 const salesOn=async path=>{const c=await config(path);if(!c.sales.enabled)await api(path+'/sales','PUT',{expected_record_version:c.record_version,enabled:true})}
 const spec={resolution:'1024x1024',aspect_ratio:'1:1',duration_seconds:0,quality:'',count:1,images:0,videos:0,audio:0}
 const quote=offer=>media('image','quotes','POST',{offer_id:offer.offer_id,spec})
 const snapshot=uid=>JSON.parse(query(`SELECT json_build_object('balance',balance::text,'frozen_balance',frozen_balance::text,'usage',(SELECT count(*) FROM usage_logs WHERE user_id=${uid})) FROM users WHERE id=${uid}`))
 const ledger=taskID=>{assert(/^img_[a-f0-9]{32}$/.test(taskID));const rid=createHash('sha256').update('studio-image:'+taskID).digest('hex');return JSON.parse(query(`SELECT json_build_object('request_id','${rid}','usage',(SELECT count(*) FROM usage_logs WHERE request_id='${rid}'),'dedup',(SELECT count(*) FROM usage_billing_dedup WHERE request_id='${rid}'),'cost',(SELECT COALESCE(sum(actual_cost),0)::text FROM usage_logs WHERE request_id='${rid}'),'account_id',(SELECT account_id FROM usage_logs WHERE request_id='${rid}' LIMIT 1),'user_id',(SELECT user_id FROM usage_logs WHERE request_id='${rid}' LIMIT 1),'image_count',(SELECT image_count FROM usage_logs WHERE request_id='${rid}' LIMIT 1))`))}
 const money=v=>Math.round(Number(v)*1e8)
 const customer=await page.context().newPage();customer.setDefaultTimeout(30000)
 const proof=require('./artifact-assets.cjs')(customer)
 const shot=async(tab,name)=>{await tab.screenshot({path:root+'/evidence/'+name,fullPage:true,animations:'disabled'});report.screenshots.push(name)}
 const observedWrites=[]
 const recordWrites=request=>{if(request.method()!=='GET'&&new URL(request.url()).pathname.startsWith('/api/v1/admin/media-workbench/accounts/'))observedWrites.push({path:new URL(request.url()).pathname,method:request.method(),body:request.postDataJSON()})}
 let baseline,postsBefore,catalogChanged=false
 try{
  const source=await api('/admin/accounts/'+id),owner=await api('/auth/me')
  assert(source.name.startsWith('Synthetic '));assert.equal(source.credentials.base_url,'https://localhost:19090');assert.equal(owner.email,'native-admin@example.invalid');assert(Number.isSafeInteger(owner.id))
  const original=await config(),products=structuredClone(original.draft.products)
  assert.equal(products.length,2);assert(products.every(p=>p.media_type==='image'))
  const [a,b]=products
  const configure=(product,model,name)=>Object.assign(product,{enabled:true,upstream_model:model,site_model:model,display_name:name,
   capabilities:{resolutions:['1024x1024'],aspect_ratios:['1:1'],qualities:[],durations_seconds:[],count:{min:1,max:1},references:{image:{min:0,max:0},video:{min:0,max:0},audio:{min:0,max:0},total_max:0},combination_rules:[]},
   pricing_rules:[{match:{},sale_price:{amount:'0.025',currency:'CNY',billing_mode:'per_request'}}],adapter_config:{version:1,model_family:'openai_json',size_mappings:[],execution:{mode:'single',max_output_images:1}}})
  configure(a,'gpt-image-2','Synthetic lifecycle target')
  configure(b,'native-openai-image','Synthetic lifecycle healthy sibling')
  let c=await saveDraft(accountPath,products);assert.equal(c.validation.publish_ready,true,JSON.stringify(c.validation));await publish(accountPath,c);await salesOn(accountPath)
  // A separate Account in the same real Group proves isolation is not merely
  // a different customer or a different Group. Credentials target only localhost.
  const peer=await api('/admin/accounts','POST',{name:'Synthetic lifecycle peer',platform:'openai',type:'apikey',credentials:{api_key:'synthetic-native-only',base_url:'https://localhost:19090'},extra:{quota_limit:100},concurrency:5,priority:1,group_ids:[gid],upstream_billing_probe_enabled:false})
  assert(Number.isSafeInteger(peer.id));const peerPath='/admin/media-workbench/accounts/'+peer.id
  // Group channel costs are Account-specific. Preserve the original wildcard
  // rule (covers both models on Account A), append a peer rule to that same
  // channel, and never replace the Group's channel with a new one.
  const channels=await api('/admin/channels?page=1&page_size=100')
  const costChannel=channels.items.find(channel=>channel.name==='Synthetic openai cost'&&channel.group_ids.includes(gid))
  assert(costChannel,'existing synthetic Group cost channel is required')
  const sourceCosts=costChannel.account_stats_pricing_rules.find(rule=>rule.account_ids.includes(id)&&rule.pricing.some(price=>price.platform==='openai'&&price.models.includes('*')&&price.billing_mode==='per_request'&&Number(price.per_request_price)>0))
  assert(sourceCosts,'native-openai-image must be covered by original Account wildcard cost')
  const costRules=structuredClone(costChannel.account_stats_pricing_rules)
  costRules.push({name:'Synthetic exact lifecycle peer Account cost',group_ids:[],account_ids:[peer.id],pricing:[{platform:'openai',models:['*'],billing_mode:'per_request',per_request_price:0.35}]})
  await api('/admin/channels/'+costChannel.id,'PUT',{account_stats_pricing_rules:costRules})
  const savedCosts=await api('/admin/channels/'+costChannel.id)
  assert(savedCosts.group_ids.includes(gid));assert(savedCosts.account_stats_pricing_rules.some(rule=>rule.account_ids.includes(id)))
  assert(savedCosts.account_stats_pricing_rules.some(rule=>rule.account_ids.includes(peer.id)&&rule.pricing.some(price=>price.models.includes('*')&&Number(price.per_request_price)===0.35)))
  report.native_cost={channel_id:costChannel.id,original_account_wildcard_preserved:true,peer_account_rule_added:true}
  await api('/admin/accounts/'+peer.id+'/models/sync-upstream','POST',{})
  const peerProduct=structuredClone(a);peerProduct.product_id='synthetic-lifecycle-peer';peerProduct.display_name='Synthetic lifecycle same Group peer'
  c=await saveDraft(peerPath,[peerProduct]);assert.equal(c.validation.publish_ready,true,JSON.stringify(c.validation));await publish(peerPath,c);await salesOn(peerPath)
  // New fixture publication is intentionally followed by an explicit shared
  // preflight. All subsequent product actions must keep that shared grant intact.
  assert.equal((await change('image',false)).status,200)
  assert.equal((await change('image',true,await check('image'))).status,200)
  assert.equal((await current('image')).effective_enabled,true)
  assert.equal((await current('video')).effective_enabled,false)
  // Saved but unpublished changes must never leak through lifecycle actions.
  const draft=structuredClone((await config()).draft.products)
  const dirtySibling=draft.find(p=>p.product_id===b.product_id);dirtySibling.display_name='UNPUBLISHED lifecycle sentinel';dirtySibling.pricing_rules[0].sale_price.amount='9.99'
  baseline=await saveDraft(accountPath,draft)
  report.fixture={account:id,group:gid,peer_account:peer.id,target:a.product_id,healthy_sibling:b.product_id,peer_product:peerProduct.product_id,published_revision:baseline.published.revision,draft_revision:baseline.draft.revision,saved_unpublished_sentinel:true}
  const unchanged=async()=>{const now=await config();assert.deepEqual(now.draft,baseline.draft,'lifecycle changed saved Draft');assert.deepEqual(now.published,baseline.published,'lifecycle republished the whole Account');assert.equal(now.sales.enabled,baseline.sales.enabled);assert.equal((await current('image')).effective_enabled,true,'single product changed the shared image gate');assert.equal((await current('video')).effective_enabled,false);return now}
  const lifecycle=async(action,productID=a.product_id)=>{const before=await config();const next=await api(accountPath+'/lifecycle','POST',{expected_version:before.record_version,action,product_id:productID});report.actions.push({action,product_id:productID,record_version:next.media_workbench_v1.record_version,state:next.media_workbench_v1.product_lifecycle[productID].state});await unchanged();save();return next.media_workbench_v1}
  await page.goto(base+'/video-studio');await expect.poll(async()=>(await media('image','catalog')).status).toBe(200)
  const catalog=()=>media('image','catalog')
  const initial=ok(await catalog()).offers
  const offerA=initial.find(o=>o.product_id===a.product_id),offerB=initial.find(o=>o.product_id===b.product_id),offerC=initial.find(o=>o.product_id===peerProduct.product_id)
  assert(offerA&&offerB&&offerC,'three Published fixture offers must be in real BFF catalog')
  const beforeQuote=ok(await quote(offerA));assert(beforeQuote.quote_token)
  const oldPrepared=ok(await media('image','prepare','POST',{quote_token:beforeQuote.quote_token,client_key:randomUUID(),prompt:'SYNTHETIC_LIFECYCLE_OLD_QUOTE',asset_refs:[]}))
  assert(/^img_[a-f0-9]{32}$/.test(oldPrepared.task_id));report.old_task_id=oldPrepared.task_id;save()
  // This independent old binding remains entirely unattempted until after the
  // full unlist/archive/restore/relist cycle; a prior rejected task is not proof.
  const beforeRelistQuote=ok(await quote(offerA)),latePrompt='SYNTHETIC_LIFECYCLE_OLD_QUOTE_AFTER_RELIST'
  const afterRelistPrepared=ok(await media('image','prepare','POST',{quote_token:beforeRelistQuote.quote_token,client_key:randomUUID(),prompt:latePrompt,asset_refs:[]}))
  assert(/^img_[a-f0-9]{32}$/.test(afterRelistPrepared.task_id));assert.notEqual(afterRelistPrepared.task_id,oldPrepared.task_id)
  assert.equal(ledger(afterRelistPrepared.task_id).usage,0);assert.equal(ledger(afterRelistPrepared.task_id).dedup,0)
  report.old_unattempted_task_id=afterRelistPrepared.task_id;save()
  postsBefore=stats().image_posts;report.supplier_posts_before=postsBefore
  await customer.goto(base+'/video-studio')
  await expect(customer.getByTestId('studio-mode-text')).toBeEnabled()
  if(await customer.getByTestId('studio-new').isVisible())await customer.getByTestId('studio-new').click()
  await customer.getByTestId('studio-mode-text').click()
  await customer.getByTestId('studio-model-toggle').click();await customer.locator(`[data-offer-id="${offerA.offer_id}"]`).click()
  await customer.getByTestId('studio-prompt').fill('保留生命周期验收输入，不自动切换模型')
  page.on('request',recordWrites)
  // Exercise the actual admin confirmation in the final embedded frontend.
  await page.goto(base+'/admin/media');await page.locator('[data-test="account-search"]').fill(String(id));await page.locator(`[data-test="supplier-${id}"]`).click();await page.locator('[data-test="model-gpt-image-2"]').click()
  await expect(page.locator('[data-test="product-archive"]')).toBeDisabled()
  await page.locator('[data-test="product-unlist"]').click()
  await expect(page.locator('dialog[open]')).toContainText('Synthetic lifecycle target')
  await expect(page.locator('[data-test="lifecycle-products"]')).not.toContainText('UNPUBLISHED lifecycle sentinel')
  await shot(page,'native-model-lifecycle-admin-confirm.png')
  const mutation=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(accountPath+'/lifecycle'))
  await page.locator('[data-test="confirm-lifecycle"]').click();assert.equal((await mutation).status(),200)
  let state=await unchanged();assert.equal(state.product_lifecycle[a.product_id].state,'unlisted')
  const uiWrite=observedWrites.find(w=>w.path.endsWith('/lifecycle'));assert.equal(uiWrite.body.action,'unlist');assert.equal(uiWrite.body.product_id,a.product_id);assert.equal(uiWrite.body.model_id,undefined)
  report.actions.push({action:'unlist',via:'final admin UI',product_id:a.product_id,state:'unlisted'})
  await customer.getByTestId('studio-refresh-models').click()
  await expect(customer.getByTestId('studio-model-unavailable')).toHaveText('此模型暂不可用，请选择其他模型')
  await expect(customer.getByTestId('studio-prompt')).toHaveValue('保留生命周期验收输入，不自动切换模型')
  await expect(customer.getByTestId('studio-mode-text')).toHaveAttribute('aria-pressed','true')
  await expect(customer.getByTestId('studio-quote')).toBeDisabled()
  await expect(customer.getByTestId('studio-model-toggle')).not.toContainText('healthy sibling')
  await shot(customer,'native-model-lifecycle-customer-unavailable.png')
  await customer.setViewportSize({width:390,height:844})
  await expect(customer.getByTestId('studio-model-unavailable')).toHaveText('此模型暂不可用，请选择其他模型')
  await shot(customer,'native-model-lifecycle-customer-unavailable-390.png')
  await customer.setViewportSize({width:1440,height:1000})
  let offers=ok(await catalog()).offers
  assert(!offers.some(o=>o.product_id===a.product_id));assert(offers.some(o=>o.product_id===b.product_id));assert(offers.some(o=>o.product_id===peerProduct.product_id))
  const unavailableQuote=await quote(offerA);assert.equal(unavailableQuote.status,409,JSON.stringify(unavailableQuote))
  const oldSubmit=await media('image','tasks','POST',{task_id:oldPrepared.task_id});assert.equal(oldSubmit.status,409,JSON.stringify(oldSubmit))
  assert.equal(stats().image_posts,postsBefore);assert.equal(ledger(oldPrepared.task_id).usage,0);assert.equal(ledger(oldPrepared.task_id).dedup,0)
  report.old_quote_rejected={quote_status:unavailableQuote.status,submit_status:oldSubmit.status,no_supplier_call:true,ledger:ledger(oldPrepared.task_id)}
  const stale=await raw(accountPath+'/lifecycle','POST',{expected_version:baseline.record_version,action:'archive',product_id:a.product_id});assert.equal(stale.status,409)
  state=await lifecycle('archive');assert.equal(state.product_lifecycle[a.product_id].state,'archived')
  await page.goto(base+'/admin/media');await page.locator('[data-test="account-search"]').fill(String(id));await page.locator(`[data-test="supplier-${id}"]`).click()
  await expect(page.locator('[data-test="model-gpt-image-2"]')).toHaveCount(0)
  await page.locator('[data-test="show-archived-models"]').check()
  await expect(page.locator('[data-test="model-gpt-image-2"]')).toContainText('已归档')
  await expect(page.locator('[data-test="model-native-openai-image"]')).toBeVisible()
  await shot(page,'native-model-lifecycle-admin-archived-list.png')
  await page.setViewportSize({width:390,height:844})
  await shot(page,'native-model-lifecycle-admin-archived-list-390.png')
  await page.setViewportSize({width:1440,height:1000})
  offers=ok(await catalog()).offers;assert(!offers.some(o=>o.product_id===a.product_id))
  // One real healthy sibling task while the target is archived. This is the
  // only new supplier generation; no 104-task funds batch is repeated here.
  const peerQuote=ok(await quote(offerC));assert(peerQuote.quote_token)
  const healthyQuote=ok(await quote(offerB));assert.equal(money(healthyQuote.total_price?.amount||healthyQuote.sale_price?.amount||healthyQuote.unit_price?.amount),2500000)
  const beforeBalance=snapshot(owner.id),prompt='SYNTHETIC_LIFECYCLE_HEALTHY_'+randomUUID()
  const prepared=ok(await media('image','prepare','POST',{quote_token:healthyQuote.quote_token,client_key:randomUUID(),prompt,asset_refs:[]}))
  report.task_id=prepared.task_id;save()
  const submit=await media('image','tasks','POST',{task_id:prepared.task_id});assert([200,202].includes(submit.status),JSON.stringify(submit))
  await expect.poll(async()=>{const r=await media('image','tasks/'+prepared.task_id);assert.equal(r.status,200,JSON.stringify(r));return r.body.status},{timeout:30000}).toBe('completed')
  const settled=ledger(prepared.task_id),afterBalance=snapshot(owner.id)
  assert.equal(settled.usage,1);assert.equal(settled.dedup,1);assert.equal(settled.account_id,id);assert.equal(settled.user_id,owner.id);assert.equal(settled.image_count,1);assert.equal(money(settled.cost),2500000)
  assert.equal(money(beforeBalance.balance)-money(afterBalance.balance),2500000);assert.equal(money(beforeBalance.frozen_balance),money(afterBalance.frozen_balance))
  const result=await page.evaluate(async taskID=>{const response=await fetch('/studio-v2/api/image/tasks/'+taskID+'/results/0');return{status:response.status,bytes:Array.from(new Uint8Array(await response.arrayBuffer()))}},prepared.task_id)
  assert.equal(result.status,200);const digest=bytes=>createHash('sha256').update(bytes).digest('hex'),expectedPNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')
  assert.equal(digest(Buffer.from(result.bytes)),digest(expectedPNG))
  await media('image','tasks/'+prepared.task_id);await media('image','tasks/'+prepared.task_id)
  const duplicate=await media('image','tasks','POST',{task_id:prepared.task_id});assert([200,202,409].includes(duplicate.status),JSON.stringify(duplicate))
  assert.deepEqual(ledger(prepared.task_id),settled);assert.deepEqual(snapshot(owner.id),afterBalance)
  const supplierCalls=stats().requests.filter(r=>r.method==='POST'&&r.body?.prompt===prompt)
  assert.equal(supplierCalls.length,1);assert.equal(supplierCalls[0].body.model,'native-openai-image');assert.equal(supplierCalls[0].body.n,1);assert.equal(stats().image_posts,postsBefore+1)
  report.healthy_delivery={task_id:prepared.task_id,quote:healthyQuote,balance_before:beforeBalance,balance_after:afterBalance,ledger:settled,original_sha256:digest(Buffer.from(result.bytes)),supplier_requests:supplierCalls,duplicate_status:duplicate.status}
  await customer.getByTestId('studio-model-toggle').click();await customer.locator(`[data-offer-id="${offerB.offer_id}"]`).click()
  await expect(customer.getByTestId('studio-model-unavailable')).toHaveCount(0)
  await expect(customer.getByTestId('studio-prompt')).toHaveValue('保留生命周期验收输入，不自动切换模型')
  await expect(customer.getByTestId('studio-quote')).toBeEnabled()
  assert.equal(stats().image_posts,postsBefore+1,'selecting another model must not automatically generate')
  state=await lifecycle('restore');assert.equal(state.product_lifecycle[a.product_id].state,'unlisted');assert.equal((await quote(offerA)).status,409)
  assert(!ok(await catalog()).offers.some(o=>o.product_id===a.product_id),'restore must not automatically relist')
  state=await lifecycle('relist');assert.equal(state.product_lifecycle[a.product_id].state,'active');assert.equal((await quote(offerA)).status,200)
  const beforeLateSubmit={posts:stats().image_posts,balance:snapshot(owner.id),ledger:ledger(afterRelistPrepared.task_id)}
  assert.equal(beforeLateSubmit.ledger.usage,0);assert.equal(beforeLateSubmit.ledger.dedup,0)
  assert.equal(stats().requests.filter(r=>r.method==='POST'&&r.body?.prompt===latePrompt).length,0)
  const oldExpiry=Date.parse(afterRelistPrepared.expires_at)
  assert(Number.isFinite(oldExpiry)&&Date.now()<oldExpiry,'old quote expired before lifecycle rejection could be distinguished from expiry')
  report.old_unattempted_quote_expiry={expires_at:afterRelistPrepared.expires_at,remaining_ms_at_first_submit:oldExpiry-Date.now()}
  const afterRelistOldSubmit=await media('image','tasks','POST',{task_id:afterRelistPrepared.task_id})
  assert.equal(afterRelistOldSubmit.status,409,JSON.stringify(afterRelistOldSubmit))
  assert.equal(stats().image_posts,beforeLateSubmit.posts,'relisting revived an old quote and called the supplier')
  assert.equal(stats().requests.filter(r=>r.method==='POST'&&r.body?.prompt===latePrompt).length,0)
  assert.deepEqual(ledger(afterRelistPrepared.task_id),beforeLateSubmit.ledger)
  assert.deepEqual(snapshot(owner.id),beforeLateSubmit.balance)
  report.old_quote_after_relist={task_id:afterRelistPrepared.task_id,first_submit_after_full_lifecycle:true,status:afterRelistOldSubmit.status,supplier_posts:0,ledger:ledger(afterRelistPrepared.task_id),balance_unchanged:true};save()
  // The already delivered B result remains customer-readable after B is
  // unlisted, independently of its now-blocked new quotes. Never generate again.
  state=await lifecycle('unlist',b.product_id);assert.equal(state.product_lifecycle[b.product_id].state,'unlisted')
  assert.equal((await quote(offerB)).status,409)
  const historicalTask=ok(await media('image','tasks/'+prepared.task_id));assert.equal(historicalTask.status,'completed')
  const historicalResult=await page.evaluate(async taskID=>{const response=await fetch('/studio-v2/api/image/tasks/'+taskID+'/results/0');return{status:response.status,bytes:Array.from(new Uint8Array(await response.arrayBuffer()))}},prepared.task_id)
  assert.equal(historicalResult.status,200);assert.equal(digest(Buffer.from(historicalResult.bytes)),digest(Buffer.from(result.bytes)))
  assert.deepEqual(ledger(prepared.task_id),settled);assert.deepEqual(snapshot(owner.id),afterBalance)
  assert.equal(stats().image_posts,postsBefore+1)
  report.history_after_unlist={task_id:prepared.task_id,status:historicalTask.status,download_status:historicalResult.status,original_sha256:digest(Buffer.from(historicalResult.bytes)),ledger_unchanged:true,balance_unchanged:true,no_regeneration:true}
  state=await lifecycle('relist',b.product_id);assert.equal(state.product_lifecycle[b.product_id].state,'active');save()
  const directArchive=await raw(accountPath+'/lifecycle','POST',{expected_version:state.record_version,action:'archive',product_id:a.product_id});assert.equal(directArchive.status,422)
  // Model disappears only from Account A's last-successful native snapshot.
  // The other model and the same Group's other Account must remain quotable.
  setCatalog({...nativeCatalog,models:nativeCatalog.models.filter(model=>model!=='gpt-image-2')});catalogChanged=true
  offers=ok(await catalog()).offers
  assert(!offers.some(o=>o.product_id===a.product_id));assert(offers.some(o=>o.product_id===b.product_id));assert(offers.some(o=>o.product_id===peerProduct.product_id))
  assert.equal((await quote(offerA)).status,409);assert.equal((await quote(offerB)).status,200);assert.equal((await quote(offerC)).status,200)
  await unchanged();setCatalog(nativeCatalog);catalogChanged=false
  assert.equal((await quote(offerA)).status,200)
  assert.equal(stats().image_posts,postsBefore+1)
  const peerAfter=await config(peerPath);assert.equal(peerAfter.sales.enabled,true);assert.equal(peerAfter.product_lifecycle?.[peerProduct.product_id]?.state||'active','active')
  assert(observedWrites.length>=5);assert(!observedWrites.some(w=>w.path.endsWith('/publish')),'lifecycle UI/action republished Draft')
  report.model_disappearance={missing_target_rejected:true,other_model_same_account_quotable:true,same_group_other_account_quotable:true,shared_gate_unchanged:true,original_catalog_restored:true}
  report.checks.push('Single product unlist/archive/restore/relist preserves saved Draft, Published snapshot, Account sales and shared paid gate','Frozen old quote rejected while unlisted; independent never-attempted old quote first submitted after relist also rejects with no supplier call, usage, dedup or balance change; archive restore stays unlisted','Healthy sibling completes through actual BFF/Bridge/Core, downloads original bytes and settles once; duplicate and reads do not regenerate; unlisting that delivered product preserves original task/result bytes and ledger','Missing native catalog model isolates only the affected product; same Account model and same Group peer Account remain quotable','Final embedded admin confirmation and customer unavailable prompt exercised without API mocks or Vite')
  report.admin_writes=observedWrites;report.assets=await proof();report.supplier_posts_after=stats().image_posts;report.pass=true;save();return report
 }catch(error){report.error=error.stack;await shot(customer,'native-model-lifecycle-failure.png').catch(()=>{});throw error}
 finally{
  page.off('request',recordWrites)
  if(catalogChanged)setCatalog(nativeCatalog)
  if(!report.pass){const closed=await change('image',false).catch(()=>null);report.failure_gate_close_status=closed?.status}
  save();await customer.close()
 }
}
