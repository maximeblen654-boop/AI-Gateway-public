// Mutate only synthetic Account dependencies after a real customer quote.
const fs = require('node:fs')
const assert = require('node:assert/strict')
module.exports = async (root, change, report) => {
  assert.equal(process.env.NATIVE_ACCEPTANCE_SCENARIO, 'admin-ui-review')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  const compose = JSON.parse(fs.readFileSync(`${root}/compose.json`))
  assert.equal(compose.services.core.environment.ADMIN_EMAIL, 'native-admin@example.invalid')
  const fixture = JSON.parse(fs.readFileSync(`${root}/evidence/fixture.json`))
  let token
  const api = async (path, method='GET', body) => {
    const r=await fetch('http://127.0.0.1:28180/api/v1'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})})
    const v=await r.json(); assert(r.ok && v.code===0, `${path}: ${r.status} ${JSON.stringify(v)}`); return v.data
  }
  token=(await api('/auth/login','POST',{email:compose.services.core.environment.ADMIN_EMAIL,password:compose.services.core.environment.ADMIN_PASSWORD})).access_token
  const id=fixture.accounts.openai, path=`/admin/media-workbench/accounts/${id}`
  const original=(await api(path)).media_workbench_v1
  const account=await api(`/admin/accounts/${id}`)
  assert(account.name.startsWith('Synthetic '))
  const publish = async config => api(path+'/publish','POST',{expected_record_version:config.record_version,expected_draft_revision:config.draft.revision})
  const save = async products => {const current=(await api(path)).media_workbench_v1;return (await api(path+'/draft','PUT',{expected_record_version:current.record_version,draft:{products}})).media_workbench_v1}
  report.dependency_change={kind:change,published_before:original.published.revision,quote_before:JSON.parse(JSON.stringify(report.quote))}
  if (change==='draft' || change==='published') {
    const products=structuredClone(original.draft.products)
    const product=products.find(p=>p.display_name==='Synthetic geometry image')
    product.pricing_rules.forEach(r=>r.sale_price.amount='9.99')
    product.adapter_config.execution={mode:'native_multi',max_output_images:2}
    const saved=await save(products)
    if(change==='published') await publish(saved)
  } else if (change==='mapping') {
    await api(`/admin/accounts/${id}`,'PUT',{credentials:{...account.credentials,model_mapping:{...(account.credentials.model_mapping||{}),'gpt-image-2':'different-synthetic-model'}}})
  } else if (change==='routing') {
    await api(`/admin/accounts/${id}`,'PUT',{credentials:{...account.credentials,base_url:'https://localhost:19090/changed-route'}})
  } else throw Error('unexpected drift')
  const current=(await api(path)).media_workbench_v1
  report.dependency_change.published_after=current.published.revision
  if(change==='draft') assert.equal(current.published.revision,original.published.revision)
  if(change==='published') assert.notEqual(current.published.revision,original.published.revision)
  return async()=>{
    if(change==='mapping'||change==='routing') await api(`/admin/accounts/${id}`,'PUT',{credentials:account.credentials})
    else {const saved=await save(original.draft.products);if(change==='published')await publish(saved)}
    assert.deepEqual(report.quote,report.dependency_change.quote_before,'frozen quote must not be replaced')
  }
}
