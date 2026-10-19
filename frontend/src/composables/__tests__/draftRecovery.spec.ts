import { describe, expect, it } from 'vitest'
import { copy, imageProduct, supplier } from '@/components/admin/media/__tests__/fixtures'
import { draftFingerprint, persistedFingerprint, recoveryKey, recoveryCopyKey, listDraftRecoveries, readDraftRecovery, encodeDraftRecovery, recoveryDifferences, type DraftRecovery } from '../draftRecovery'

const identity = { admin_id: 1, account_id: 77, product_id: imageProduct.product_id, site_model: imageProduct.site_model, upstream_model: imageProduct.upstream_model }
const fixture = (): DraftRecovery => ({ version: 1, identity, base_record_version: 3, base_draft_revision: 'mwd_a', updated_at: 1, copy_id: '99999999-9999-4999-8999-999999999999', product: copy(imageProduct) })

describe('bounded product recovery and save comparison', () => {
  it('normalizes retired video procurement only and still compares image procurement exactly', () => {
    const original = copy(imageProduct)
    original.cost_rules = [{ match: {}, cost: { amount: '1.5', currency: 'CNY', billing_mode: 'per_request' } }]
    const cleared = copy(original); delete cleared.cost_rules
    expect(draftFingerprint([original])).not.toBe(draftFingerprint([cleared]))
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
    expect(draftFingerprint([a])).not.toBe(draftFingerprint([cost]))
    const price = copy(a); price.pricing_rules[0]!.sale_price!.amount = '0.18000001'
    expect(draftFingerprint([a])).not.toBe(draftFingerprint([price]))
  })
  it('accepts only known native adapter defaults without ignoring explicit adapter or cost changes', () => {
    const a = copy(imageProduct), b = copy(imageProduct), dto = supplier()
    dto.native_adapters = { image: { kind: 'gemini_images', revision: 'v1', auth: '', task_flow: '', media_type: 'image', max_references: 1, parameters: {} } }
    b.adapter_config.version = 1; b.adapter_config.model_family = 'gemini_images'
    expect(persistedFingerprint([a], dto)).toBe(draftFingerprint([b]))
    a.adapter_config.model_family = 'explicit'
    expect(persistedFingerprint([a], dto)).not.toBe(draftFingerprint([b]))
  })
  it('shows meaningful cost price and exact model differences without including Account data', () => {
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
