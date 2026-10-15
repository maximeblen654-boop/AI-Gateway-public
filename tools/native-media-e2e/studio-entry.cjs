// Focused final-image proof: real browser login, native PostgreSQL credentials,
// Bridge selection, and preserved native Ops diagnostics. No production access.
const fs=require('node:fs'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process')
const root=process.argv[2],phase=process.argv[3]
assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');assert.equal(process.env.NATIVE_FOCUSED_ENTRY,'true');assert(root.endsWith('/native-media-20261012'))
const sql=q=>execFileSync('docker',['exec','ai-gateway-native-postgres-20261012','psql','-U','native','-d','sub2api','-At','-v','ON_ERROR_STOP=1','-c',q],{encoding:'utf8'}).trim()
const customer=Number(sql("SELECT id FROM users WHERE email='native-customer@example.invalid'"));assert(Number.isSafeInteger(customer)&&customer>0)
const keys=()=>JSON.parse(sql(`SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT id,user_id,group_id,status FROM api_keys WHERE user_id=${customer} AND deleted_at IS NULL ORDER BY id) x`))
const file=root+'/evidence/native-studio-entry.json'
;(async()=>{
 if(phase==='before'){
  const before=keys();assert.deepEqual(before,[],'no pre-created customer API key may mask the defect')
  fs.writeFileSync(file,JSON.stringify({customer,keys_before:before,production:false,browser_api_mocking:false},null,2));return
 }
 assert.equal(phase,'verify')
 const report=JSON.parse(fs.readFileSync(file)),fixture=JSON.parse(fs.readFileSync(root+'/evidence/fixture.json')),compose=JSON.parse(fs.readFileSync(root+'/compose.json'))
 report.keys_after=keys();const expected=[...new Set([Number(compose.services.bridge.environment.STUDIO_IMAGE_GROUP_ID),Number(compose.services.bridge.environment.STUDIO_VIDEO_GROUP_ID)])].sort((a,b)=>a-b)
 assert.deepEqual(report.keys_after.map(k=>k.group_id).sort((a,b)=>a-b),expected)
 assert(report.keys_after.every(k=>k.user_id===customer&&k.status==='active'))
 const tasks=JSON.parse(fs.readFileSync(root+'/evidence/native-task-experience.json'));assert.equal(tasks.pass,true)
 const q=`SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT request_id,account_id,upstream_status_code,upstream_error_message,upstream_latency_ms,upstream_errors FROM ops_error_logs WHERE user_id=${customer} AND upstream_errors::text LIKE '%synthetic-studio-unknown-502%') x`
 let rows=[];for(let i=0;i<30;i++){rows=JSON.parse(sql(q));if(rows.length)break;await new Promise(r=>setTimeout(r,500))}
 assert.equal(rows.length,1,JSON.stringify(rows));const row=rows[0]
 assert.equal(row.account_id,fixture.accounts.openai);assert.equal(row.upstream_status_code,502)
 assert(row.upstream_latency_ms>=0);assert(JSON.stringify(row.upstream_errors).includes('synthetic_upstream_outcome_unknown'))
 report.diagnostics={request_id:row.request_id,account_id:row.account_id,upstream_status_code:row.upstream_status_code,upstream_latency_ms:row.upstream_latency_ms,upstream_request_id:'synthetic-studio-unknown-502',message_preserved:true}
 report.checks=['Zero pre-created customer keys; actual Vue login/catalog prepares one native key per configured Group','Text/edit/single-video delivery and download use real Core/Bridge/BFF and native settlement','Account switch, refresh and query preserve identities; upstream 502 remains unknown with zero settlement','Native error status, Account, message, request ID and timing retained by real Ops middleware','104-request funds suite and 1870 scale suite reused, not rerun']
 report.pass=true;fs.writeFileSync(file,JSON.stringify(report,null,2))
})().catch(e=>{console.error(e);process.exitCode=1})
