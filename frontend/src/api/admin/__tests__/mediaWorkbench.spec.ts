import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '@/api/client'
import { syncUpstreamModels } from '../accounts'
import { draftInput, mediaWorkbenchAPI } from '../mediaWorkbench'
import { copy, imageProduct, supplier } from '@/components/admin/media/__tests__/fixtures'
vi.mock('@/api/client', () => ({ apiClient: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }))
vi.mock('../accounts', () => ({ syncUpstreamModels: vi.fn() }))
const client = vi.mocked(apiClient)
beforeEach(() => { vi.resetAllMocks(); client.get.mockResolvedValue({ data: supplier() }); client.put.mockResolvedValue({ data: supplier() }); client.post.mockResolvedValue({ data: supplier() }) })
describe('strict Media Workbench API boundary', () => {
  it('strips unknown and server-owned response fields at every editable level', async () => {
    const p = copy(imageProduct)
    Object.assign(p, { revision: 'server-only', unknown: 'future', credentials: { api_key: 'SYNTHETIC-DO-NOT-SEND' } })
    Object.assign(p.capabilities, { adapter_binding: { kind: 'future' } })
    Object.assign(p.capabilities.references.image, { secret: 'SYNTHETIC-DO-NOT-SEND' })
    Object.assign(p.pricing_rules[0]!, { compiled_offer: 'future' })
    Object.assign(p.pricing_rules[0]!.sale_price!, { supplier_cost: 'future' })
    Object.assign(p.pricing_rules[0]!.match, { unknown: 'future' })
    Object.assign(p.adapter_config, { headers: { Authorization: 'SYNTHETIC-DO-NOT-SEND' } })
    Object.assign(p.adapter_config.size_mappings[0]!, { wire_field: 'arbitrary', url: 'https://example.invalid' })
    await mediaWorkbenchAPI.saveDraft(77, 3, [p])
    expect(client.put).toHaveBeenCalledWith('/admin/media-workbench/accounts/77/draft', { expected_record_version: 3, draft: { products: [imageProduct] } })
  })
  it('preserves null price, explicit zero and arbitrary decimal precision', () => {
    const p = copy(imageProduct); p.pricing_rules = [{ match: {}, sale_price: null }, { match: {}, sale_price: { amount: '0', currency: 'CNY', billing_mode: 'per_request' } }, { match: {}, sale_price: { amount: '0.12345678901234567890', currency: 'CNY', billing_mode: 'per_request' } }]
    expect(draftInput([p]).products[0]!.pricing_rules).toEqual(p.pricing_rules)
  })
  it('accepts added response fields without rejecting the response', async () => {
    const dto = { ...supplier(), future_summary: { state: 'new-state' } }; client.get.mockResolvedValue({ data: dto })
    expect(await mediaWorkbenchAPI.detail(77)).toEqual(dto)
  })
  it('preserves the public Phase-2A size mappings in the strict Draft request', async () => {
    const dto = await mediaWorkbenchAPI.detail(77)
    const products = draftInput(dto.media_workbench_v1!.draft.products).products
    await mediaWorkbenchAPI.saveDraft(77, 3, products)
    expect(client.put.mock.calls[0]![1]).toEqual({ expected_record_version: 3, draft: { products: [imageProduct] } })
    products[0]!.adapter_config.size_mappings[0]!.wire_size = '1536x1536'
    await mediaWorkbenchAPI.saveDraft(77, 3, products)
    const body = client.put.mock.calls[1]![1] as { draft: { products: typeof products } }
    expect(body.draft.products[0]!.adapter_config.size_mappings[0]!.wire_size).toBe('1536x1536')
    expect(dto.media_workbench_v1!.draft.products[0]!.adapter_config).toEqual(imageProduct.adapter_config)
  })
  it('normalizes absent Phase-1 mapping config and null mapping lists', () => {
    const p = copy(imageProduct)
    delete (p as Partial<typeof p>).adapter_config
    expect(draftInput([p]).products[0]!.adapter_config).toEqual({ size_mappings: [] })
    Object.assign(p, { adapter_config: { size_mappings: null } })
    expect(draftInput([p]).products[0]!.adapter_config).toEqual({ size_mappings: [] })
  })
  it('uses documented initialize, publish and sales payloads', async () => {
    await mediaWorkbenchAPI.initialize(77, ['image', 'video']); await mediaWorkbenchAPI.publish(77, 3, 'mwd_a'); await mediaWorkbenchAPI.sales(77, 4, false)
    expect(client.post).toHaveBeenCalledWith('/admin/media-workbench/accounts/77/initialize', { media_types: ['image', 'video'] })
    expect(client.post).toHaveBeenCalledWith('/admin/media-workbench/accounts/77/publish', { expected_record_version: 3, expected_draft_revision: 'mwd_a' })
    expect(client.put).toHaveBeenCalledWith('/admin/media-workbench/accounts/77/sales', { expected_record_version: 4, enabled: false })
  })
  it('reuses native Account model synchronization', async () => {
    await mediaWorkbenchAPI.sync(77); expect(syncUpstreamModels).toHaveBeenCalledWith(77)
    expect(client.post).not.toHaveBeenCalled()
  })
})
