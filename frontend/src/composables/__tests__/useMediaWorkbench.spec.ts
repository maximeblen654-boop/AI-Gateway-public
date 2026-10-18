import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mediaWorkbenchAPI } from '@/api/admin/mediaWorkbench'
import { useMediaWorkbench } from '../useMediaWorkbench'
import { supplier, saved, copy, draftManagementSupplier } from '@/components/admin/media/__tests__/fixtures'

vi.mock('@/api/admin/mediaWorkbench', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/admin/mediaWorkbench')>(),
  mediaWorkbenchAPI: { suppliers: vi.fn(), detail: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), sales: vi.fn(), sync: vi.fn(), initialize: vi.fn(), lifecycle: vi.fn() }
}))
const api = vi.mocked(mediaWorkbenchAPI)
function mockSave(dto: ReturnType<typeof saved>) { api.saveDraft.mockImplementation(async () => { api.detail.mockResolvedValue(dto); return dto }) }
let state: ReturnType<typeof useMediaWorkbench>
let wrapper: ReturnType<typeof mount>
async function start() {
  wrapper = mount(defineComponent({ setup() { state = useMediaWorkbench(); return () => null } }))
  await state.selectSupplier(77)
}
beforeEach(() => { vi.resetAllMocks(); api.detail.mockResolvedValue(supplier()); api.suppliers.mockResolvedValue([supplier(), supplier(44)]) })
afterEach(() => { wrapper?.unmount(); vi.useRealTimers() })

it('reconciles a save timeout by reading persisted cost without repeating the write', async () => {
  await start()
  const dto = saved()
  dto.media_workbench_v1!.draft.products[0]!.cost_rules = [{ match: {}, cost: { amount: '0', currency: 'CNY', billing_mode: 'per_request' }, source: 'manual' }]
  state.products.value = copy(dto.media_workbench_v1!.draft.products)
  api.saveDraft.mockRejectedValue({ status: 0 })
  api.detail.mockResolvedValue(dto)
  expect(await state.saveDraft()).toBe(true)
  expect(api.saveDraft).toHaveBeenCalledTimes(1)
  expect(state.saveFeedback.value).toContain('重新读取核对')
  expect(state.products.value[0]!.cost_rules![0]!.cost!.amount).toBe('0')
})
it('keeps ambiguous writes blocked when readback cannot confirm the cost draft', async () => {
  await start(); state.products.value[0]!.cost_rules = [{ match: {}, cost: null }]
  api.saveDraft.mockRejectedValue({ status: 503 })
  expect(await state.saveDraft()).toBe(false)
  expect(await state.saveDraft()).toBe(false)
  expect(api.saveDraft).toHaveBeenCalledTimes(1)
  expect(state.saveState.value).toBe('unconfirmed')
  expect(state.products.value[0]!.cost_rules).toEqual([{ match: {}, cost: null }])
})
it('sales rejection remains false and timeout is reconciled without duplicate mutation', async () => {
  await start(); api.sales.mockRejectedValue({ status: 422 })
  expect(await state.sales(false)).toBe(false)
  expect(state.config.value!.sales.enabled).toBe(true)
  const dto = saved(); dto.media_workbench_v1!.sales.enabled = false
  api.sales.mockRejectedValue({ status: 0 }); api.detail.mockResolvedValue(dto)
  expect(await state.sales(false)).toBe(true)
  expect(api.sales).toHaveBeenCalledTimes(2)
  expect(state.salesFeedback.value).toContain('重新读取核对')
})
describe('Media Workbench request lifecycle', () => {
  it('creates images with system quantity 1..10 and videos with one while retaining old products', async () => {
    await start()
    const old = copy(state.products.value[0]!)
    state.selectModel('new-model'); state.addProduct('image')
    expect(state.product.value?.capabilities.count).toEqual({ min: 1, max: 10 })
    expect(state.product.value?.adapter_config.execution).toBeUndefined()
    state.addProduct('video')
    expect(state.product.value?.capabilities.count).toEqual({ min: 1, max: 1 })
    expect(state.products.value[0]).toEqual(old)
    expect(state.config.value!.published!.products![0]!.capabilities.count).toEqual({ min: 1, max: 1 })
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled()
  })
  it('keeps Draft validation freshness separate from selected publication', async () => {
    await start(); expect(state.canPublish.value).toBe(true)
    state.config.value!.validation.draft_revision = 'old'; expect(state.validationCurrent.value).toBe(false); expect(state.canPublish.value).toBe(true)
    state.config.value!.validation.draft_revision = 'mwd_a'; state.config.value!.validation.publish_ready = false
    expect(state.canPublish.value).toBe(true)
  })
  it('never derives readiness from prices or capabilities', async () => {
    const dto = supplier(); dto.media_workbench_v1!.validation.publish_ready = false; api.detail.mockResolvedValue(dto)
    await start(); state.products.value[0]!.pricing_rules[0]!.sale_price!.amount = '0'
    expect(state.canPublish.value).toBe(false)
  })
  it('guards save double clicks and preserves exact decimal input', async () => {
    await start(); state.products.value[0]!.pricing_rules[0]!.sale_price!.amount = '0.12345678901234567890'
    let resolve!: (dto: ReturnType<typeof saved>) => void
    api.saveDraft.mockReturnValue(new Promise(r => { resolve = r }))
    const saving = state.saveDraft(); await state.saveDraft(); expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(api.saveDraft.mock.calls[0]![2][0]!.pricing_rules[0]!.sale_price!.amount).toBe('0.12345678901234567890')
    api.detail.mockResolvedValue(saved()); resolve(saved()); await saving; expect(state.saveState.value).toBe('saved')
  })
  it('a saved validation FAIL remains a successfully saved Draft', async () => {
    await start(); mockSave(saved('FAIL')); expect(await state.saveDraft()).toBe(true)
    expect(state.saveState.value).toBe('saved'); expect(state.dirty.value).toBe(false); expect(state.canPublish.value).toBe(true)
    expect(state.diagnostics.value[0]?.code).toBe('MISSING_PRICE')
  })
  it.each(['UNKNOWN', 'PENDING', 'FAIL'])('confirmed saved Draft %s allows selected server validation', async status => {
    await start(); mockSave(saved(status)); await state.saveDraft()
    expect(state.saveState.value).toBe('saved'); expect(state.products.value).toHaveLength(1); expect(state.canPublish.value).toBe(true)
    api.publish.mockResolvedValue(saved()); expect(await state.publish(['canvas-1'])).toBe(true)
    expect(api.publish).toHaveBeenCalledWith(77, 4, 'mwd_b', ['canvas-1'])
  })
  it('409 preserves local changes and never retries the old CAS', async () => {
    await start(); state.products.value[0]!.display_name = '未保存'; api.saveDraft.mockRejectedValue({ status: 409 })
    await state.saveDraft(); await state.saveDraft(); expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(state.products.value[0]!.display_name).toBe('未保存'); expect(state.conflict.value).toBe(true)
    api.detail.mockResolvedValue(saved()); await state.selectSupplier(77)
    expect(state.conflict.value).toBe(false); expect(state.dirty.value).toBe(false)
  })
  it('network ambiguity disables Publish and keeps edits', async () => {
    await start(); state.products.value[0]!.display_name = '待确认'; api.saveDraft.mockRejectedValue({ status: 0 })
    await state.saveDraft(); expect(state.saveState.value).toBe('unconfirmed'); expect(state.canPublish.value).toBe(false)
    expect(state.products.value[0]!.display_name).toBe('待确认')
  })
  it('sales updates the CAS version without losing unsaved form', async () => {
    await start(); state.products.value[0]!.display_name = '本地修改'; const dto = supplier(); dto.media_workbench_v1!.record_version = 9
    dto.media_workbench_v1!.sales.enabled = false; api.sales.mockResolvedValue(dto); await state.sales(false)
    expect(state.products.value[0]!.display_name).toBe('本地修改'); expect(state.config.value!.record_version).toBe(9)
    mockSave(saved()); await state.saveDraft(); expect(api.saveDraft.mock.calls[0]![1]).toBe(9)
  })
  it('failed sync preserves the last successful model list', async () => {
    await start(); const models = copy(state.detail.value!.models); api.sync.mockRejectedValue({ status: 503 })
    await state.sync(); expect(state.detail.value!.models).toEqual(models); expect(api.detail).toHaveBeenCalledTimes(1)
    expect(state.message.value).toContain('仍使用上次成功目录')
  })
  it('successful sync refreshes once and preserves local Draft edits', async () => {
    await start(); state.products.value[0]!.display_name = '本地修改'; api.sync.mockResolvedValue({} as never)
    const dto = supplier(); dto.models.push({ model_id: 'new-exact-ID', state: 'PENDING' }); api.detail.mockResolvedValue(dto)
    await state.sync(); expect(api.detail).toHaveBeenCalledTimes(2); expect(state.products.value[0]!.display_name).toBe('本地修改')
    expect(state.detail.value!.models.at(-1)?.model_id).toBe('new-exact-ID'); expect(state.canPublish.value).toBe(false)
  })
  it.each([404, 410])('deleted Account (%s) becomes read-only without losing Draft', async status => {
    await start(); state.products.value[0]!.display_name = '保留'; api.saveDraft.mockRejectedValue({ status })
    await state.saveDraft(); expect(state.deleted.value).toBe(true); expect(state.products.value[0]!.display_name).toBe('保留'); expect(state.canPublish.value).toBe(false)
  })
  it('publish double clicks send one request with exact expected versions', async () => {
    await start(); let resolve!: (dto: ReturnType<typeof saved>) => void
    api.publish.mockReturnValue(new Promise(r => { resolve = r })); const publishing = state.publish(['canvas-1']); await state.publish(['canvas-1'])
    expect(api.publish).toHaveBeenCalledTimes(1); expect(api.publish).toHaveBeenCalledWith(77, 3, 'mwd_a', ['canvas-1'])
    resolve(saved()); await publishing
  })
  it('legacy Published recovery rejection is a definite no-write, not a conflict or unknown save', async () => {
    await start(); mockSave(saved()); await state.saveDraft()
    const originalConfig = copy(state.config.value)
    const originalProducts = copy(state.products.value)
    api.publish.mockRejectedValue({ status: 409, reason: 'MEDIA_PUBLISHED_RECOVERY_REQUIRED', message: 'Historical published configuration requires controlled revalidation' })
    expect(await state.publish(['canvas-1'])).toBe(false)
    expect(state.message.value).toBe('历史已发布配置需先受控校验恢复；没有发布本次草稿。')
    expect(state.errorStatus.value).toBe(409)
    expect(state.conflict.value).toBe(false)
    expect(state.saveState.value).toBe('saved')
    expect(state.validationUnavailable.value).toBe(false)
    expect(state.canPublish.value).toBe(true)
    expect(state.config.value).toEqual(originalConfig)
    expect(state.products.value).toEqual(originalProducts)
    expect(api.publish).toHaveBeenCalledTimes(1)
    expect(api.detail).toHaveBeenCalledTimes(2)
  })
  it('ordinary publish CAS rejection still blocks publishing until reload', async () => {
    await start(); api.publish.mockRejectedValue({ status: 409, reason: 'MEDIA_WORKBENCH_STALE' })
    expect(await state.publish(['canvas-1'])).toBe(false)
    expect(state.conflict.value).toBe(true)
    expect(state.canPublish.value).toBe(false)
    expect(state.message.value).toContain('配置已被其他页面修改')
  })
  it('422 selected publish keeps server diagnostics and allows another explicit selection', async () => {
    await start(); api.publish.mockRejectedValue({ status: 422, metadata: { diagnostics: supplier(77, 'FAIL').media_workbench_v1!.validation.diagnostics } })
    await state.publish(['canvas-1']); expect(state.canPublish.value).toBe(true); expect(state.diagnostics.value[0]?.class).toBe('UI_FIXABLE')
  })
  it('keeps selected publish validation separate from the saved whole-Draft validation', async () => {
    await start()
    const dto = supplier(77, 'FAIL')
    dto.publish_validation = { ...dto.media_workbench_v1!.validation, diagnostics: [{ ...dto.media_workbench_v1!.validation.diagnostics[0]!, scope: 'canvas-1', message: '本次选中商品价格冲突' }] }
    api.publish.mockRejectedValue({ status: 422, data: dto })
    expect(await state.publish(['canvas-1'])).toBe(false)
    expect(state.publishValidation.value?.diagnostics[0]?.message).toBe('本次选中商品价格冲突')
    expect(state.config.value!.validation.diagnostics[0]?.message).toBe('4K 条件缺少售价')
    expect(state.canPublish.value).toBe(true)
    api.publish.mockResolvedValue(saved())
    expect(await state.publish(['canvas-1'])).toBe(true)
    expect(state.publishValidation.value).toBeNull()
  })
  it('revision-only Publish acknowledgement refreshes the editor exactly once', async () => {
    await start(); api.publish.mockResolvedValue({ record_version: 4, published_revision: 'mwp_b' }); const dto = saved(); dto.media_workbench_v1!.published!.revision = 'mwp_b'; api.detail.mockResolvedValue(dto)
    await state.publish(['canvas-1']); expect(api.detail).toHaveBeenCalledTimes(2); expect(state.config.value!.record_version).toBe(4)
  })
  it('does not confirm an acknowledgement when readback still reports another Published revision', async () => {
    await start(); api.publish.mockResolvedValue({ record_version: 4, published_revision: 'mwp_b' }); api.detail.mockResolvedValue(saved())
    expect(await state.publish(['canvas-1'])).toBe(false)
    expect(state.saveState.value).toBe('unconfirmed')
    expect(state.publicationFeedback.value).toContain('仍未确认')
    expect(api.publish).toHaveBeenCalledTimes(1)
  })
  it('slow supplier responses cannot replace the current supplier', async () => {
    await start(); let resolve!: (dto: ReturnType<typeof supplier>) => void
    api.detail.mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValueOnce(supplier(44))
    const old = state.selectSupplier(77); await state.selectSupplier(44); resolve(supplier(77)); await old
    expect(state.detail.value!.id).toBe(44)
  })
  it('late validation A cannot overwrite saved Draft B', async () => {
    vi.useFakeTimers(); await start(); api.saveDraft.mockImplementationOnce(async () => { const dto = saved('PENDING'); api.detail.mockResolvedValue(dto); return dto })
    await state.saveDraft(); let resolve!: (dto: ReturnType<typeof saved>) => void
    api.detail.mockReturnValueOnce(new Promise(r => { resolve = r })); await vi.advanceTimersByTimeAsync(1000)
    const b = saved('FAIL'); b.media_workbench_v1!.draft.revision = 'mwd_c'; b.media_workbench_v1!.validation.draft_revision = 'mwd_c'
    api.saveDraft.mockImplementationOnce(async () => { api.detail.mockResolvedValue(b); return b }); await state.saveDraft(); resolve(saved('PASS')); await flushPromises()
    expect(state.config.value!.draft.revision).toBe('mwd_c'); expect(state.config.value!.validation.status).toBe('FAIL'); expect(state.canPublish.value).toBe(true)
  })
  it('new product defaults never infer model specs or a price', async () => {
    await start(); state.selectModel('new-model'); state.addProduct('image')
    expect(state.product.value!.capabilities.resolutions).toEqual([]); expect(state.product.value!.pricing_rules).toEqual([])
    expect(state.product.value!.site_model).toBe('new-model'); expect(state.product.value!.upstream_model).toBe('new-model')
    expect(state.product.value!.product_id).toMatch(/^media-[0-9a-f-]{36}$/)
    expect(state.product.value!.adapter_config).toEqual({ size_mappings: [] })
  })
  it('loading and saving an existing mapping does not erase or alter it', async () => {
    const dto = supplier(); api.detail.mockResolvedValue(dto); await start()
    const config = copy(dto.media_workbench_v1!.draft.products[0]!.adapter_config)
    expect(state.products.value[0]!.adapter_config).toEqual(config); expect(state.dirty.value).toBe(false)
    mockSave(saved()); await state.saveDraft()
    expect(api.saveDraft.mock.calls[0]![2][0]!.adapter_config).toEqual(config)
  })
  it('a failed selection of a deleted supplier does not mark the current supplier deleted', async () => {
    await start(); api.detail.mockRejectedValueOnce({ status: 404 }); await state.selectSupplier(44)
    expect(state.detail.value!.id).toBe(77); expect(state.deleted.value).toBe(false)
  })
  it('first explicit save atomically initializes a nil media configuration', async () => {
    const dto = supplier(); dto.media_workbench_v1 = null; dto.effective_state = 'NOT_INITIALIZED'; dto.effective_sales = false
    api.detail.mockResolvedValue(dto); await start(); state.selectModel('new-model'); state.addProduct('image')
    mockSave(saved())
    expect(await state.saveDraft()).toBe(true)
    expect(api.saveDraft).toHaveBeenCalledWith(77, 0, expect.arrayContaining([expect.objectContaining({ media_type: 'image', upstream_model: 'new-model' })]))
  })
})


describe('explicit product management', () => {
  it('repeated default creation continues the existing model and media product', async () => {
    await start(); state.selectModel('image-native-1')
    const before = copy(state.products.value)
    state.addProduct('image'); state.addProduct('image')
    expect(state.products.value).toEqual(before)
    expect(state.selectedProduct.value).toBe(before[0]!.product_id)
    expect(api.saveDraft).not.toHaveBeenCalled()
  })
})


describe('blank draft lifecycle', () => {
  it.each(['image', 'video'] as const)('%s removes only a confirmed blank and preserves the configured product', async type => {
    const dto = draftManagementSupplier(type)
    api.detail.mockResolvedValue(dto); await start(); state.selectModel(dto.models[0]!.model_id)
    const before = copy(state.products.value)
    state.removeProduct('canvas-1'); expect(state.products.value).toEqual(before)
    state.removeProduct('blank-3'); expect(state.products.value).toHaveLength(6)
    state.undoRemoval('blank-3'); expect(state.products.value).toEqual(before); expect(state.dirty.value).toBe(false)
    state.removeProduct('blank-3')
    api.saveDraft.mockImplementation(async (_id, _version, products) => {
      const result = copy(dto); result.media_workbench_v1!.draft.products = copy(products); api.detail.mockResolvedValue(result); return result
    })
    await state.saveDraft()
    expect(api.saveDraft).toHaveBeenCalledWith(77, 3, before.filter(p => p.product_id !== 'blank-3'), ['blank-3'])
    expect(state.products.value[0]).toEqual(before[0]); expect(state.removedProducts.value).toEqual([])
    expect(state.config.value!.published).toEqual(dto.media_workbench_v1!.published)
    expect(api.publish).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
  })
  it('undoes a new product without sending any write and guards repeated explicit creation', async () => {
    await start(); state.selectModel('image-native-1'); const before = copy(state.products.value)
    state.addProduct('image', true); const id = state.selectedProduct.value
    state.addProduct('image', true); expect(state.products.value).toHaveLength(2)
    state.product.value!.display_name = '未保存的编辑也能撤销'
    state.removeProduct(id)
    expect(state.products.value).toEqual(before); expect(state.selectedProduct.value).toBe(before[0]!.product_id)
    expect(state.dirty.value).toBe(false); expect(api.saveDraft).not.toHaveBeenCalled()
  })
  it('does not treat a configured zero price or locally edited blank as removable', async () => {
    api.detail.mockResolvedValue(draftManagementSupplier()); await start()
    const p = state.products.value.find(p => p.product_id === 'blank-1')!
    p.pricing_rules = [{ match: {}, sale_price: { amount: '0', currency: 'CNY', billing_mode: 'per_request' } }]
    state.removeProduct(p.product_id); expect(state.products.value).toHaveLength(7)
  })
  it('keeps a pending removal after conflict or ambiguous save and requires reread before further management', async () => {
    api.detail.mockResolvedValue(draftManagementSupplier()); await start()
    state.removeProduct('blank-2'); api.saveDraft.mockRejectedValue({ status: 0 }); await state.saveDraft()
    state.removeProduct('blank-3'); state.undoRemoval('blank-2')
    expect(state.products.value).toHaveLength(6); expect(state.removedProducts.value.map(p => p.product_id)).toEqual(['blank-2'])
    await state.selectSupplier(77); expect(state.products.value).toHaveLength(7); expect(state.removedProducts.value).toEqual([])
  })
  it('allows explicitly removing the last saved blank', async () => {
    const dto = draftManagementSupplier(); dto.media_workbench_v1!.draft.products = [dto.media_workbench_v1!.draft.products[1]!]
    api.detail.mockResolvedValue(dto); await start(); state.removeProduct('blank-1'); mockSave(dto)
    await state.saveDraft(); expect(api.saveDraft).toHaveBeenCalledWith(77, 3, [], ['blank-1'])
  })
})


it('allows an untouched blank price placeholder but protects a specified price match', async () => {
  api.detail.mockResolvedValue(draftManagementSupplier()); await start()
  const p = state.products.value.find(p => p.product_id === 'blank-1')!
  p.pricing_rules = [{ match: {}, sale_price: null }]
  expect(state.removalReason(p)).toBe('')
  p.pricing_rules[0]!.match.resolution = ['1K']
  expect(state.removalReason(p)).not.toBe('')
})


describe('explicit lifecycle mutations', () => {
  it('blocks dirty drafts even when called directly and does not autosave', async () => {
    await start(); state.products.value[0]!.display_name = '未保存'
    expect(await state.lifecycle('unlist', { product_id: state.products.value[0]!.product_id })).toBe(false)
    expect(api.lifecycle).not.toHaveBeenCalled(); expect(api.saveDraft).not.toHaveBeenCalled()
  })
  it('uses current CAS and blocks ambiguous retries until reload', async () => {
    await start(); api.lifecycle.mockRejectedValue({ status: 503 })
    await state.lifecycle('unlist', { model_id: 'image-native-1' })
    await state.lifecycle('unlist', { model_id: 'image-native-1' })
    expect(api.lifecycle).toHaveBeenCalledTimes(1)
    expect(api.lifecycle).toHaveBeenCalledWith(77, 3, 'unlist', { model_id: 'image-native-1' })
    expect(state.saveState.value).toBe('unconfirmed')
  })
  it('adopts returned lifecycle and version without publishing or dropping archived products', async () => {
    await start(); const dto = supplier(); const id = dto.media_workbench_v1!.draft.products[0]!.product_id
    dto.media_workbench_v1!.record_version = 4
    dto.media_workbench_v1!.product_lifecycle = { [id]: { state: 'archived', revision: 1, updated_at: '' } }
    api.lifecycle.mockResolvedValue(dto)
    expect(await state.lifecycle('archive', { product_id: id })).toBe(true)
    expect(state.config.value!.record_version).toBe(4)
    expect(state.products.value).toHaveLength(1); expect(state.dirty.value).toBe(false)
    expect(api.publish).not.toHaveBeenCalled(); expect(api.saveDraft).not.toHaveBeenCalled()
  })
})


it('requires nonempty known unique selected product identities before publication',async()=>{
 await start()
 for(const ids of [[],['unknown'],['canvas-1','canvas-1']])expect(await state.publish(ids)).toBe(false)
 expect(api.publish).not.toHaveBeenCalled()
})
it('allows selected-product validation despite another saved draft failing, while preserving unconfirmed write and dirty guards',async()=>{
 const dto=supplier(77,'FAIL');api.detail.mockResolvedValue(dto);api.publish.mockResolvedValue(dto)
 await start();expect(await state.publish(['canvas-1'])).toBe(true)
 expect(api.publish).toHaveBeenCalledWith(77,3,'mwd_a',['canvas-1'])
 state.products.value[0]!.display_name='未保存';expect(await state.publish(['canvas-1'])).toBe(false)
 state.discard();state.config.value!.validation.status='UNKNOWN';expect(await state.publish(['canvas-1'])).toBe(true)
 api.publish.mockRejectedValue({status:503});expect(await state.publish(['canvas-1'])).toBe(false)
 expect(state.saveState.value).toBe('unconfirmed');expect(await state.publish(['canvas-1'])).toBe(false)
 expect(api.publish).toHaveBeenCalledTimes(3)
 await state.selectSupplier(77);expect(state.canPublish.value).toBe(true)
})
