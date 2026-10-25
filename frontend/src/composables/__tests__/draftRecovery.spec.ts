import { describe, expect, it } from 'vitest'
import { copy, imageProduct, supplier } from '@/components/admin/media/__tests__/fixtures'
import { draftFingerprint, videoSaleInputsFingerprint, persistedFingerprint, confirmedRecoveryProduct, recoveryKey, recoveryCopyKey, listDraftRecoveries, readDraftRecovery, encodeDraftRecovery, recoveryDifferences, type DraftRecovery } from '../draftRecovery'

const identity = { admin_id: 1, account_id: 77, product_id: imageProduct.product_id, site_model: imageProduct.site_model, upstream_model: imageProduct.upstream_model }
const fixture = (): DraftRecovery => ({ version: 1, identity, base_record_version: 3, base_draft_revision: 'mwd_a', updated_at: 1, copy_id: '99999999-9999-4999-8999-999999999999', product: copy(imageProduct) })

describe('bounded product recovery and save comparison', () => {
  it('matches live video inputs to recovered key order while retaining amount, source, domain and row order', () => {
    const value = fixture(); value.product.media_type = 'video'
    value.video_sale_inputs = [{ resolution: '720p', group: { aspect_ratio: ['16:9'] }, duration: 5, amount: '12.', source_price: null, domain: 'confirmed-spec-domain' }]
    const recovered = readDraftRecovery(encodeDraftRecovery(value), identity)!.video_sale_inputs!
    expect(JSON.stringify(value.video_sale_inputs)).not.toBe(JSON.stringify(recovered))
    expect(videoSaleInputsFingerprint(value.video_sale_inputs)).toBe(videoSaleInputsFingerprint(recovered))
    for (const patch of [{ amount: '12.5' }, { domain: 'different-domain' }, { source_price: { amount: '2', currency: 'CNY', billing_mode: 'per_request' } }]) {
      expect(videoSaleInputsFingerprint([{ ...recovered[0]!, ...patch }])).not.toBe(videoSaleInputsFingerprint(recovered))
    }
    const rows = [recovered[0]!, { ...recovered[0]!, duration: 10 }]
    expect(videoSaleInputsFingerprint(rows)).not.toBe(videoSaleInputsFingerprint([...rows].reverse()))
  })
  it('round-trips unfinished video price text with its exact source and strips undocumented buffer fields', () => {
    const value = fixture(); value.product.media_type = 'video'
    value.video_sale_inputs = [{ resolution: '720p', group: { aspect_ratio: ['16:9'] }, duration: 5, amount: '12.', source_price: null, domain: JSON.stringify(value.product.capabilities) }]
    Object.assign(value.video_sale_inputs[0]!, { token: 'SYNTHETIC_SECRET' })
    Object.assign(value.video_sale_inputs[0]!.group, { authorization: 'SYNTHETIC_SECRET' })
    const raw = encodeDraftRecovery(value)
    expect(raw).not.toContain('SYNTHETIC_SECRET')
    expect(readDraftRecovery(raw, identity)?.video_sale_inputs).toEqual([{ resolution: '720p', group: { aspect_ratio: ['16:9'] }, duration: 5, amount: '12.', source_price: null, domain: JSON.stringify(value.product.capabilities) }])
    expect(readDraftRecovery(encodeDraftRecovery(fixture()), identity)?.video_sale_inputs).toBeUndefined()
    for (const patch of [{ amount: '1'.repeat(129) }, { duration: -1 }, { group: { aspect_ratio: 'invalid' } }, { source_price: {} }]) {
      const invalid = { ...value, video_sale_inputs: [{ ...value.video_sale_inputs[0], ...patch }] }
      expect(() => readDraftRecovery(JSON.stringify(invalid), identity)).toThrow()
    }
    value.product.media_type = 'image'
    expect(() => readDraftRecovery(JSON.stringify(value), identity)).toThrow()
  })
  it('normalizes retired procurement for both media while preserving exact sale prices', () => {
    const original = copy(imageProduct)
    original.cost_rules = [{ match: {}, cost: { amount: '1.5', currency: 'CNY', billing_mode: 'per_request' } }]
    const cleared = copy(original); delete cleared.cost_rules
    expect(draftFingerprint([original])).toBe(draftFingerprint([cleared]))
    expect(readDraftRecovery(encodeDraftRecovery({ ...fixture(), product: original }), identity)?.product).not.toHaveProperty('cost_rules')
    original.media_type = 'video'; cleared.media_type = 'video'
    expect(persistedFingerprint([original], supplier())).toBe(draftFingerprint([cleared]))
    cleared.pricing_rules[0]!.sale_price!.amount = '99'
    expect(persistedFingerprint([original], supplier())).not.toBe(draftFingerprint([cleared]))
  })
  it('keys by administrator Account product and exact model identity, independently of server version', () => {
    const a = fixture(), b = fixture(); b.base_record_version = 100
    expect(recoveryKey(a.identity)).toBe(recoveryKey(b.identity))
    for (const changed of [{ admin_id: 2 }, { account_id: 44 }, { product_id: 'other' }, { site_model: 'other' }, { upstream_model: 'other' }]) expect(recoveryKey({ ...identity, ...changed })).not.toBe(recoveryKey(identity))
    expect(recoveryKey({ ...identity, admin_id: 0 })).toBeUndefined()
  })
  it('discovers independent editor copies and legacy copies within the exact administrator Account scope', () => {
    localStorage.clear()
    const a = fixture(), b = fixture(), legacy = fixture()
    a.editor_id = crypto.randomUUID(); b.editor_id = crypto.randomUUID(); b.product.display_name = 'page B'
    for (const value of [a, b, legacy]) localStorage.setItem(value.editor_id ? recoveryCopyKey(value.identity, value.editor_id)! : recoveryKey(value.identity)!, encodeDraftRecovery(value))
    const { entries, invalid } = listDraftRecoveries(localStorage, 1, 77)
    expect(entries).toHaveLength(3); expect(invalid).toBe(false)
    expect(listDraftRecoveries(localStorage, 2, 77).entries).toEqual([])
    expect(listDraftRecoveries(localStorage, 1, 44).entries).toEqual([])
    const before = entries.map(entry => localStorage.getItem(entry.key))
    listDraftRecoveries(localStorage, 1, 77)
    expect(entries.map(entry => localStorage.getItem(entry.key))).toEqual(before)
    localStorage.clear()
  })
  it('persists only writable Product fields and bounded receipt metadata', () => {
    const value = fixture()
    Object.assign(value, { token: 'SYNTHETIC_SECRET', account: { credential: 'SYNTHETIC_SECRET' } })
    Object.assign(value.product, { credentials: { key: 'SYNTHETIC_SECRET' }, cost_version: 1 })
    Object.assign(value.product.adapter_config, { headers: { Authorization: 'SYNTHETIC_SECRET' } })
    const raw = encodeDraftRecovery(value)
    expect(raw).not.toContain('SYNTHETIC_SECRET'); expect(raw).not.toContain('cost_version')
    expect(readDraftRecovery(raw, identity)?.product.pricing_rules).toEqual(imageProduct.pricing_rules)
  })
  it('round-trips an optional removal tombstone while retaining legacy edit compatibility', () => {
    const value = fixture(); value.removed_product = true
    const raw = encodeDraftRecovery(value)
    expect(readDraftRecovery(raw, identity)?.removed_product).toBe(true)
    expect(readDraftRecovery(encodeDraftRecovery(fixture()), identity)?.removed_product).toBeUndefined()
    expect(() => readDraftRecovery(JSON.stringify({ ...value, removed_product: 'yes' }), identity)).toThrow()
    expect(() => readDraftRecovery(JSON.stringify({ ...value, new_product: true }), identity)).toThrow()
    const editor = crypto.randomUUID(); value.editor_id = editor
    localStorage.clear()
    localStorage.setItem(recoveryCopyKey(identity, editor)!, encodeDraftRecovery(value))
    expect(listDraftRecoveries(localStorage, 1, 77).entries[0]!.value.removed_product).toBe(true)
    expect(listDraftRecoveries(localStorage, 2, 77).entries).toEqual([])
    expect(listDraftRecoveries(localStorage, 1, 44).entries).toEqual([])
    localStorage.clear()
  })
  it('rejects corrupt oversized malformed and wrong-identity values', () => {
    expect(readDraftRecovery(null, identity)).toBeNull()
    for (const raw of ['{', 'x'.repeat(256001), JSON.stringify({ ...fixture(), base_record_version: -1 }), JSON.stringify({ ...fixture(), product: { ...imageProduct, enabled: 'yes' } }), JSON.stringify({ ...fixture(), product: { ...imageProduct, capabilities: {} } })]) expect(() => readDraftRecovery(raw, identity)).toThrow()
    expect(() => readDraftRecovery(encodeDraftRecovery(fixture()), { ...identity, admin_id: 2 })).toThrow()
  })
  it('normalizes object order server markers and documented empty optional arrays only', () => {
    const a = copy(imageProduct), b = copy(imageProduct)
    Object.assign(b, { cost_version: 1, future: 'ignored' }); b.cost_rules = []
    b.pricing_rules[0]!.match = { quality: [], resolution: [] }
    b.capabilities.output_formats = []
    expect(draftFingerprint([a])).toBe(draftFingerprint([b]))
    for (const field of ['site_model', 'upstream_model', 'display_name'] as const) { const changed = copy(a); changed[field] = 'different'; expect(draftFingerprint([a])).not.toBe(draftFingerprint([changed])) }
    const cost = copy(a); cost.cost_rules = [{ match: {}, cost: { amount: '0', currency: 'CNY', billing_mode: 'per_request' } }]
    expect(draftFingerprint([a])).toBe(draftFingerprint([cost]))
    const price = copy(a); price.pricing_rules[0]!.sale_price!.amount = '0.18000001'
    expect(draftFingerprint([a])).not.toBe(draftFingerprint([price]))
  })
  it('accepts only known native adapter defaults without ignoring explicit adapter changes', () => {
    const a = copy(imageProduct), b = copy(imageProduct), dto = supplier()
    dto.native_adapters = { image: { kind: 'gemini_images', revision: 'v1', auth: '', task_flow: '', media_type: 'image', max_references: 1, parameters: {} } }
    b.adapter_config.version = 1; b.adapter_config.model_family = 'gemini_images'
    expect(persistedFingerprint([a], dto)).toBe(draftFingerprint([b]))
    a.adapter_config.model_family = 'explicit'
    expect(persistedFingerprint([a], dto)).not.toBe(draftFingerprint([b]))
  })
  it('shows meaningful sale-price and exact model differences without including Account data', () => {
    const a = copy(imageProduct), b = copy(imageProduct)
    a.pricing_rules[0]!.sale_price!.amount = '0.5'; a.upstream_model = 'other-real-model'
    expect(recoveryDifferences(a, b).map(d => d.field)).toEqual(['upstream_model', 'pricing_rules'])
  })
  it('normalizes only the exact laoli video reference-domain default and leaves immutable legacy profiles alone', () => {
    const dto = supplier(), submitted = copy(imageProduct)
    submitted.media_type = 'video'
    dto.native_adapters = { video: { kind: 'laoli_video', revision: 'v1', auth: '', task_flow: '', media_type: 'video', max_references: 1, parameters: {} } }
    const persisted = copy(submitted); persisted.adapter_config.version = 1; persisted.adapter_config.wire_profile = 'images'
    dto.media_workbench_v1!.draft.products = [persisted]
    expect(persistedFingerprint([submitted], dto)).toBe(draftFingerprint([persisted]))
    persisted.adapter_config.wire_profile = 'inline_multimedia'
    expect(persistedFingerprint([submitted], dto)).not.toBe(draftFingerprint([persisted]))
    dto.media_workbench_v1!.draft.products = [copy(submitted)]
    expect(persistedFingerprint([submitted], dto)).toBe(draftFingerprint([submitted]))
  })
})

describe('exact persisted recovery proof and readable differences', () => {
  function confirmed() {
    const value=fixture(), dto=supplier(), submission=crypto.randomUUID()
    value.pending_submission={submission_id:submission,base_record_version:3,product:copy(value.product)}
    dto.media_workbench_v1!.record_version=4
    dto.media_workbench_v1!.draft.save_receipt={submission_id:submission,base_record_version:3,draft_revision:dto.media_workbench_v1!.draft.revision}
    return {value,dto}
  }
  it('recognizes complete receipt/payload proof without confusing the record number for proof', () => {
    const {value,dto}=confirmed()
    expect(confirmedRecoveryProduct(value,dto)).toBe(true)
    delete value.pending_submission
    expect(confirmedRecoveryProduct(value,dto)).toBe(false)
  })
  it.each(['account','model','receipt','base','revision','version','newer','raw','removal'] as const)('retains unresolved or mismatched %s evidence', kind => {
    const {value,dto}=confirmed()
    if(kind==='account')dto.id=88
    if(kind==='model')dto.media_workbench_v1!.draft.products[0]!.upstream_model='another-model'
    if(kind==='receipt')dto.media_workbench_v1!.draft.save_receipt!.submission_id=crypto.randomUUID()
    if(kind==='base')dto.media_workbench_v1!.draft.save_receipt!.base_record_version=2
    if(kind==='revision')dto.media_workbench_v1!.draft.save_receipt!.draft_revision='other-revision'
    if(kind==='version')dto.media_workbench_v1!.record_version=3
    if(kind==='newer')value.product.display_name='new local input'
    if(kind==='raw'){value.product.media_type='video';value.video_sale_inputs=[{resolution:'720p',duration:5,amount:'12.',group:{},source_price:null,domain:'incomplete'}]}
    if(kind==='removal')value.removed_product=true
    expect(confirmedRecoveryProduct(value,dto)).toBe(false)
  })
  it('shows only real differences, with Chinese price labels and bounded non-JSON values', () => {
    const local=copy(imageProduct),server=copy(imageProduct)
    local.pricing_rules[0]!.sale_price!.amount='9.50'
    const differences=recoveryDifferences(local,server)
    expect(differences).toHaveLength(1)
    expect(differences[0]!.label).toBe('售价')
    expect(differences[0]!.local).toContain('9.50')
    expect(differences[0]!.local).not.toContain('sale_price')
    expect(differences[0]!.local.length).toBeLessThanOrEqual(180)
    local.pricing_rules=copy(server.pricing_rules)
    local.pricing_rules[0]!.match.quality=[]
    expect(recoveryDifferences(local,server)).toEqual([])
    local.display_name='x'.repeat(600)
    expect(recoveryDifferences(local,server)[0]!.label).toBe('商品名称')
    expect(recoveryDifferences(local,server)[0]!.local).toHaveLength(180)
  })
})

it('explains a changed fourth price or same-length size mapping instead of identical summaries', () => {
  const local=copy(imageProduct),server=copy(imageProduct)
  local.pricing_rules=Array.from({length:4},()=>copy(imageProduct.pricing_rules[0]!));server.pricing_rules=copy(local.pricing_rules)
  local.pricing_rules[3]!.sale_price!.amount='99'
  let diff=recoveryDifferences(local,server)[0]!
  expect(diff.label).toBe('售价');expect(diff.local).toContain('第4条');expect(diff.local).toContain('99');expect(diff.local).not.toEqual(diff.server)
  local.pricing_rules=copy(server.pricing_rules)
  local.adapter_config.size_mappings=[{resolution:'1K',aspect_ratio:'1:1',wire_size:'1024x1024'}]
  server.adapter_config.size_mappings=[{resolution:'1K',aspect_ratio:'1:1',wire_size:'512x512'}]
  diff=recoveryDifferences(local,server)[0]!
  expect(diff.label).toBe('画幅尺寸映射');expect(diff.local).toContain('1024x1024');expect(diff.server).toContain('512x512')
})

it('shows the actual tail difference in long names without unbounded text', () => {
  const local=copy(imageProduct),server=copy(imageProduct)
  local.display_name='共'.repeat(300)+'本地';server.display_name='共'.repeat(300)+'服务器'
  const difference=recoveryDifferences(local,server)[0]!
  expect(difference.local).toContain('本地');expect(difference.server).toContain('服务器')
  expect(difference.local.length).toBeLessThan(180);expect(difference.server.length).toBeLessThan(180)
})


describe('Image2Pro server-owned save defaults', () => {
  it.each(['image', 'video'] as const)('confirms exact %s defaults without accepting a newer price or another product', media => {
    const dto = supplier(), submitted = copy(imageProduct), persisted = copy(imageProduct)
    submitted.media_type = persisted.media_type = media
    dto.native_adapters = { [media]: { kind: media === 'image' ? 'openai_images' : 'image2pro_video', revision: 'private-internal', auth: '', task_flow: '', media_type: media, max_references: 9, parameters: {} } }
    persisted.adapter_config.version = 1
    if (media === 'image') { submitted.adapter_config.model_family = 'openai_json'; persisted.adapter_config.model_family = 'image2pro_json' }
    else { submitted.capabilities.resolutions = ['720p']; persisted.capabilities.resolutions = ['720p']; persisted.adapter_config.wire_profile = 'image2pro' }
    dto.media_workbench_v1!.draft.products = [persisted]
    expect(persistedFingerprint([submitted], dto)).toBe(draftFingerprint([persisted]))
    const changed = copy(submitted); changed.pricing_rules[0]!.sale_price!.amount = '99'
    expect(persistedFingerprint([changed], dto)).not.toBe(draftFingerprint([persisted]))
    dto.media_workbench_v1!.draft.products = [{ ...persisted, product_id: 'another' }]
    expect(persistedFingerprint([submitted], dto)).not.toBe(draftFingerprint([persisted]))
    dto.media_workbench_v1!.draft.products = [persisted]
    submitted.adapter_config.wire_profile = 'explicit-other-protocol'
    expect(persistedFingerprint([submitted], dto)).not.toBe(draftFingerprint([persisted]))
  })
})
