// Real final Core -> Bridge -> BFF catalog; only existing isolated V2 tables
// receive synthetic observations. No API mocks, supplier calls or production I/O.
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync,spawn}=require('node:child_process'),{createHash}=require('node:crypto')
const root=process.argv[2],base='http://127.0.0.1:28100'
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO,'paid-controls');assert(root?.endsWith('/native-media-20261012'))
const compose=JSON.parse(fs.readFileSync(root+'/compose.json')),fixture=JSON.parse(fs.readFileSync(root+'/evidence/fixture.json')),env=compose.services.core.environment
assert.equal(compose.services.core.container_name,'ai-gateway-native-core-20261012');assert.equal(compose.services.postgres.environment.POSTGRES_DB,'sub2api')
const docker=['compose','-p','ai-gateway-native-20261012','-f',root+'/compose.json'],psql=['exec','-T','postgres','psql','-X','-U','native','-d','sub2api','-At','-v','ON_ERROR_STOP=1']
const sql=q=>execFileSync('docker',[...docker,...psql,'-c',q],{encoding:'utf8',stdio:'pipe'}).trim()
const literal=v=>"'"+String(v).replaceAll("'","''")+"'",json=v=>literal(JSON.stringify(v))+'::json'
const snapshot=(table,where)=>JSON.parse(sql(`SELECT COALESCE(json_agg(t ORDER BY to_jsonb(t)::text),'[]'::json) FROM (SELECT * FROM ${table} WHERE ${where}) t`))
const restore=(table,where,rows)=>`DELETE FROM ${table} WHERE ${where}; INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},${json(rows)});`
const stats=()=>JSON.parse(fs.readFileSync(root+'/evidence/native-supplier-state.json'))
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),sleep=ms=>new Promise(r=>setTimeout(r,ms))
const report={production:false,api_mocking:false,source_sha:process.env.NATIVE_CANDIDATE_SOURCE_SHA,checks:[],observations:[],pass:false}
async function core(token,path,method='GET',body){const r=await fetch(base+'/api/v1'+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer '+token,'X-Admin-UI-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});const b=await r.json();assert.equal(r.status,200,path+': '+r.status);assert.equal(b.code,0);return b.data}
async function catalog(cookie,kind){const r=await fetch(base+'/studio-v2/api/'+kind+'/catalog',{headers:{Cookie:cookie,Origin:base,'X-Studio-Request':kind+'-binding-v1'},signal:AbortSignal.timeout(30000)});assert.equal(r.status,200,kind+' catalog');const b=await r.json();assert(Array.isArray(b.offers));return b.offers}
async function holdNativeAggregator(){
 // Exact FNV-1a hash used by existing ops_advisory_lock.go; hold that native
 // lock on one psql connection so background rollups cannot race fixture data.
 let key=14695981039346656037n;for(const b of Buffer.from('channel-monitor-v2-aggregator'))key=BigInt.asUintN(64,(key^BigInt(b))*1099511628211n)
 key=BigInt.asIntN(64,key)
 const child=spawn('docker',[...docker,...psql],{stdio:['pipe','pipe','pipe']})
 let exited=false;child.once('exit',()=>{exited=true})
 try{await new Promise((resolve,reject)=>{let text='';const timeout=setTimeout(()=>reject(Error('isolated aggregator lock timed out')),60000);child.stdout.on('data',b=>{text+=b;if(text.includes('PASSIVE_LOCK_READY')){clearTimeout(timeout);resolve()}});child.once('error',error=>{clearTimeout(timeout);reject(error)});child.once('exit',code=>{clearTimeout(timeout);if(!text.includes('PASSIVE_LOCK_READY'))reject(Error('isolated lock process exited '+code))});child.stdin.write(`SET lock_timeout='55s'; SELECT pg_advisory_lock(${key}); SELECT 'PASSIVE_LOCK_READY';\n`)})}
 catch(error){child.stdin.destroy();child.kill();throw error}
 return async()=>{if(exited)return;const done=new Promise(resolve=>child.once('exit',resolve));child.stdin.end('\\q\n');await done}
}
;(async()=>{
 let release,backup,where,metricWhere,cookie
 const before=stats()
 try{
  const token=(await core('','/auth/login','POST',{email:env.ADMIN_EMAIL,password:env.ADMIN_PASSWORD})).access_token
  const me=await core(token,'/auth/me');assert.equal(me.email,'native-admin@example.invalid')
  const ticket=await core(token,'/auth/studio-media-ticket','POST',{})
  const exchange=await fetch(base+'/studio-v2/api/session/exchange',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Studio-Request':'session-exchange-v1'},body:JSON.stringify({ticket:ticket.ticket})});assert.equal(exchange.status,200);cookie=exchange.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ')
  const denied=await fetch(base+'/studio-v2/api/image/catalog',{headers:{Origin:base,'X-Studio-Request':'image-binding-v1'}});assert([401,403].includes(denied.status),'monitor catalog must retain session authentication')
  const initial=await catalog(cookie,'image'),target=initial.find(o=>o.upstream_model==='gpt-image-2');assert(target,'published synthetic image offer required')
  const videoBefore=await catalog(cookie,'video');assert(videoBefore.length,'published synthetic video offer required')
  const plain=offers=>offers.map(({passive_status,...offer})=>offer),catalogHash=hash(plain(initial)),videoHash=hash(plain(videoBefore))
  const group=Number(compose.services.bridge.environment.STUDIO_IMAGE_GROUP_ID),otherGroup=Number(fixture.groups.grok),model=target.model,otherModel=model+'-passive-unrelated'
  assert(Number.isSafeInteger(group)&&group>0);assert(Number.isSafeInteger(otherGroup)&&otherGroup>0&&otherGroup!==group)
  assert.equal(Number(fixture.groups.openai),group)
  // Existing catalog permission already maps each offer to its true Account.
  // Monitor facts deliberately contain no Account dimension: two Accounts in
  // this group/model must be described as an aggregate, never account health.
  const scope='platform_group_requested_model'
  release=await holdNativeAggregator()
  where="key IN ('channel_monitor_enabled','channel_monitor_mode')"
  metricWhere=`bucket_seconds=300 AND model IN (${literal(model)},${literal(otherModel)})`
  backup={settings:snapshot('settings',where),config:snapshot('channel_monitor_v2_config','id=1'),watermarks:snapshot('channel_monitor_v2_watermarks','id=1'),metrics:snapshot('channel_monitor_v2_metrics_rollup',metricWhere)}
  assert.equal(backup.config.length,1);assert.equal(backup.watermarks.length,1)
  const mode=value=>sql(`INSERT INTO settings(key,value) VALUES ('channel_monitor_enabled','true'),('channel_monitor_mode',${literal(value)}) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`)
  mode('v1')
  const inspect=async(state,rate)=>{
   const offers=await catalog(cookie,'image');assert.equal(hash(plain(offers)),catalogHash,'monitor must not alter products, prices or allowed specs')
   const current=offers.filter(o=>o.model===model);assert(current.length)
   for(const o of current){const s=o.passive_status;assert(s);assert.equal(s.state,state,JSON.stringify(s));assert.equal(s.scope,scope);assert.equal(s.window_seconds,5400);assert.deepEqual(Object.keys(s).filter(k=>!['state','scope','window_seconds','reason','data_through','computed_at','error_rate'].includes(k)),[]);if(rate===undefined)assert.equal(s.error_rate,undefined);else assert.equal(s.error_rate,rate)}
   report.observations.push({state,offer_count:current.length,status:current[0].passive_status})
   return current[0].passive_status
  }
  assert.equal((await inspect('unavailable')).reason,'monitor_disabled')
  const videoDisabled=await catalog(cookie,'video');assert.equal(hash(plain(videoDisabled)),videoHash);assert(videoDisabled.every(o=>o.passive_status?.state==='unavailable'))
  sql(`UPDATE channel_monitor_v2_config SET enabled=true,platforms='[{"platform":"openai","enabled":true,"models":[]},{"platform":"grok","enabled":true,"models":[]},{"platform":"gemini","enabled":true,"models":[]}]',group_ids='{}',ignored_error_categories='[]',health_thresholds=jsonb_set(health_thresholds,'{minimum_sample}','50') WHERE id=1; DELETE FROM channel_monitor_v2_metrics_rollup WHERE ${metricWhere}; UPDATE channel_monitor_v2_watermarks SET usage_coverage_start=NULL,error_coverage_start=NULL,data_through=NULL,last_successful_at=NULL WHERE id=1`)
  mode('v2');await inspect('no_data')
  const watermark=stale=>sql(`UPDATE channel_monitor_v2_watermarks SET usage_coverage_start=NOW()-INTERVAL '2 hours',error_coverage_start=NOW()-INTERVAL '2 hours',backfill_cursor=NOW()-INTERVAL '2 hours',data_through=NOW()-INTERVAL '${stale?'20':'1'} minutes',last_successful_at=NOW()-INTERVAL '${stale?'20':'0'} minutes' WHERE id=1`)
  const metric=(platform,gid,name,success,error)=>`INSERT INTO channel_monitor_v2_metrics_rollup(bucket_seconds,bucket_start,platform,group_id,model,success_requests,error_requests) VALUES (300,to_timestamp(floor(extract(epoch FROM NOW())/300)*300)-INTERVAL '30 minutes',${literal(platform)},${gid},${literal(name)},${success},${error});`
  watermark(false)
  sql(metric('openai',otherGroup,model,0,100)+metric('gemini',group,model,0,100)+metric('openai',group,otherModel,0,100))
  await inspect('no_data')
  sql(metric('openai',group,model,49,0));await inspect('insufficient')
  sql(`UPDATE channel_monitor_v2_metrics_rollup SET success_requests=80,error_requests=20 WHERE bucket_seconds=300 AND platform='openai' AND group_id=${group} AND model=${literal(model)}`)
  await inspect('observed',0.2)

  const {chromium,expect}=require('../../frontend/node_modules/@playwright/test')
  const browser=await chromium.launch({channel:'chrome',headless:true})
  report.screenshots=[]
  try{
   const page=await browser.newPage({locale:'zh-CN',viewport:{width:1440,height:1000}})
   const assetProof=require('./artifact-assets.cjs')(page)
   await page.addInitScript(()=>{localStorage.setItem('sub2api_locale','zh');localStorage.setItem('admin_guide_1_admin_v4_interactive','true')})
   await page.goto(base+'/login');await page.getByLabel('邮箱').fill(env.ADMIN_EMAIL);await page.getByLabel('密码').fill(env.ADMIN_PASSWORD);await page.getByRole('button',{name:'登录',exact:true}).click();await page.waitForURL('**/dashboard')
   for(const width of [1440,390])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:900});await page.evaluate(theme=>localStorage.setItem('theme',theme),theme)
    await page.goto(base+'/video-studio');await expect(page.getByTestId('studio-model-toggle')).toBeEnabled();await page.getByTestId('studio-model-toggle').click()
    const row=page.locator('.picker-list li').filter({has:page.locator(`[data-offer-id="${target.offer_id}"]`)})
    await expect(row.locator('.picker-status')).toContainText('错误 20%');await row.locator('.picker-status').click()
    await expect(page.locator('#studio-model-observation')).toContainText('不代表某个具体渠道')
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'final UI mobile overflow')
    const name=`native-model-status-${width}-${theme}.png`;await page.screenshot({path:root+'/evidence/'+name,fullPage:true,animations:'disabled'});report.screenshots.push(name)
    await page.keyboard.press('Escape');await expect(page.getByTestId('studio-model-toggle')).toBeFocused()
   }
   report.assets=await assetProof()
  }finally{await browser.close()}
  const videoObserved=await catalog(cookie,'video');assert.equal(hash(plain(videoObserved)),videoHash)
  for(const o of videoObserved){assert(o.passive_status);if(o.model!==model)assert.notEqual(o.passive_status.state,'observed','image observation must not leak into different video model')}
  watermark(true);await inspect('stale')
  report.checks.push('Real authenticated catalog: V1 disabled, no watermark, wrong Group/platform/model, insufficient samples, observed aggregate and stale states','Catalog identities/specs/prices unchanged; no private counts, credentials, raw errors or Account-health claim; image/video scope isolated')
  // Existing finality harness supplies the simulated generation evidence. This
  // script never generates again merely to obtain monitoring samples.
  const finalityFile=root+'/evidence/native-image-finality.json'
  if(fs.existsSync(finalityFile)){
   const finality=JSON.parse(fs.readFileSync(finalityFile)),failed=finality.tasks.filter(t=>t.scenario==='502'),users=[...new Set(failed.map(t=>t.user_id))]
   assert(failed.length>0&&users.every(Number.isSafeInteger));let rows=[]
   for(let i=0;i<30;i++){rows=JSON.parse(sql(`SELECT COALESCE(json_agg(t),'[]'::json) FROM (SELECT request_id,requested_model,account_id,group_id,status_code,upstream_status_code,stream FROM ops_error_logs WHERE user_id IN (${users.join(',')}) AND error_body LIKE '%upstream_http_502_no_delivery%') t`));if(rows.length>=failed.length)break;await sleep(500)}
   assert.equal(rows.length,failed.length);assert.equal(new Set(rows.map(r=>r.request_id)).size,failed.length)
   for(const r of rows){assert.equal(r.requested_model,model);assert.equal(r.account_id,fixture.accounts.openai);assert.equal(r.group_id,group);assert.equal(r.status_code,502);assert.equal(r.upstream_status_code,502);assert.equal(r.stream,false)}
   report.terminal_502={expected:failed.length,logical_error_rows:rows.length,requested_model:model,identity_preserved:true,duplicate_queries_not_counted:true}
  }else report.terminal_502={tested:false,reason:'Existing image-finality scenario not run in this candidate mode; directed handler tests cover the marker'}
  assert.deepEqual(stats(),before,'monitoring read acceptance must add zero supplier requests')
  report.pass=true
 }catch(error){report.error=error.stack;throw error}
 finally{
  try{if(backup){sql('BEGIN;'+restore('settings',where,backup.settings)+restore('channel_monitor_v2_config','id=1',backup.config)+restore('channel_monitor_v2_watermarks','id=1',backup.watermarks)+restore('channel_monitor_v2_metrics_rollup',metricWhere,backup.metrics)+'COMMIT;');report.fixture_restored=true;assert.deepEqual(snapshot('settings',where),backup.settings);assert.deepEqual(snapshot('channel_monitor_v2_config','id=1'),backup.config);assert.deepEqual(snapshot('channel_monitor_v2_watermarks','id=1'),backup.watermarks);assert.deepEqual(snapshot('channel_monitor_v2_metrics_rollup',metricWhere),backup.metrics)}}
  catch(error){report.pass=false;report.restore_error=error.stack;throw error}
  finally{if(release)await release();fs.writeFileSync(root+'/evidence/native-passive-status.json',JSON.stringify(report,null,2))}
 }
})().catch(error=>{console.error(error);process.exitCode=1})
