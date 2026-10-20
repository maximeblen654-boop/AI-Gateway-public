import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mediaWorkbenchAPI } from '@/api/admin/mediaWorkbench'
import { useMediaWorkbench } from '../useMediaWorkbench'
import { encodeDraftRecovery, recoveryKey, recoveryCopyKey, listDraftRecoveries, type DraftRecovery, type RecoveryEntry } from '../draftRecovery'
import { supplier, saved, copy, draftManagementSupplier } from '@/components/admin/media/__tests__/fixtures'

vi.mock('@/api/admin/mediaWorkbench', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/admin/mediaWorkbench')>(),
  mediaWorkbenchAPI: { suppliers: vi.fn(), detail: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), sales: vi.fn(), sync: vi.fn(), initialize: vi.fn(), lifecycle: vi.fn() }
}))
const api = vi.mocked(mediaWorkbenchAPI)
function acknowledgement(dto: ReturnType<typeof saved>, version: number, products: Parameters<typeof mediaWorkbenchAPI.saveDraft>[2], submissionId?: string) {
  dto = copy(dto)
  dto.media_workbench_v1!.record_version = Math.max(dto.media_workbench_v1!.record_version, version + 1)
  dto.media_workbench_v1!.draft.products = copy(products)
  dto.media_workbench_v1!.draft.save_receipt = { submission_id: submissionId!, base_record_version: version, draft_revision: dto.media_workbench_v1!.draft.revision }
  return dto
}
function mockSave(dto: ReturnType<typeof saved>) { api.saveDraft.mockImplementation(async (_id, version, products, _removed, submissionId) => { const result = acknowledgement(dto, version, products, submissionId); api.detail.mockResolvedValue(result); return result }) }
let state: ReturnType<typeof useMediaWorkbench>
let wrapper: ReturnType<typeof mount>
async function start(adminId: () => number | undefined = () => 1) {
  wrapper = mount(defineComponent({ setup() { state = useMediaWorkbench(adminId); return () => null } }))
  await state.selectSupplier(77)
}
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); vi.spyOn(console, 'warn').mockImplementation(() => undefined); api.detail.mockResolvedValue(supplier()); api.suppliers.mockResolvedValue([supplier(), supplier(44)]) })
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); vi.restoreAllMocks() })

it('confirms the new video receipt after legacy procurement fields are removed, retaining sale values', async () => {
  const source = supplier(); const video = source.media_workbench_v1!.draft.products[0]!
  video.media_type = 'video'; video.cost_rules = [{ match: {}, cost: { amount: '1.2', currency: 'CNY', billing_mode: 'per_request' } }]
  api.detail.mockResolvedValue(source)
  await start()
  state.products.value[0]!.display_name = '无采购成本视频'
  api.saveDraft.mockImplementation(async (_id, version, products, _removed, submissionId) => {
    expect(products[0]!.cost_rules).toBeUndefined()
    const response = acknowledgement(saved(), version, products, submissionId)
    delete response.media_workbench_v1!.draft.products[0]!.cost_rules
    api.detail.mockResolvedValue(response)
    return response
  })
  expect(await state.saveDraft()).toBe(true)
  expect(state.saveState.value).toBe('saved')
  expect(state.dirty.value).toBe(false)
  expect(state.products.value[0]!.pricing_rules).toEqual(video.pricing_rules)
})

it('reconciles a save timeout by reading persisted cost without repeating the write', async () => {
  await start()
  const dto = saved()
  dto.media_workbench_v1!.draft.products[0]!.cost_rules = [{ match: {}, cost: { amount: '0', currency: 'CNY', billing_mode: 'per_request' }, source: 'manual' }]
  state.products.value = copy(dto.media_workbench_v1!.draft.products)
  api.saveDraft.mockImplementation(async (_id, version, products, _removed, submissionId) => { api.detail.mockResolvedValue(acknowledgement(dto, version, products, submissionId)); throw { status: 0 } })
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
it.each([400, 422])('retains a rejected cost draft (%s) and allows correction followed by an explicit save', async status => {
  await start()
  state.products.value[0]!.display_name = '保留当前商品名称'
  state.products.value[0]!.cost_rules = [{ match: {}, cost: { amount: '-1', currency: 'CNY', billing_mode: 'per_request' }, source: 'manual' }]
  const diagnostic = { class: 'UI_FIXABLE', severity: 'error', code: 'INVALID_COST', scope: 'canvas-1', path: 'cost_rules.0.cost', message: '采购成本不合法', action: '修正后保存' }
  api.saveDraft.mockRejectedValue({ status, metadata: { diagnostics: [diagnostic] } })
  expect(await state.saveDraft()).toBe(false)
  expect(state.saveState.value).toBe('failed')
  expect(state.dirty.value).toBe(true)
  expect(state.config.value!.record_version).toBe(3)
  expect(state.products.value[0]!.display_name).toBe('保留当前商品名称')
  expect(state.products.value[0]!.cost_rules![0]!.cost!.amount).toBe('-1')
  expect(state.diagnostics.value).toEqual([diagnostic])
  expect(state.saveFeedback.value).toContain('修正字段后重新保存')
  expect(api.detail).toHaveBeenCalledTimes(1)
  expect(api.saveDraft).toHaveBeenCalledTimes(1)
  state.products.value[0]!.cost_rules![0]!.cost!.amount = '0.25'
  const dto = saved(); dto.media_workbench_v1!.draft.products = copy(state.products.value)
  mockSave(dto)
  expect(await state.saveDraft()).toBe(true)
  expect(api.saveDraft).toHaveBeenCalledTimes(2)
  expect(api.saveDraft.mock.calls[1]![1]).toBe(3)
  expect(state.saveState.value).toBe('saved')
  expect(state.products.value[0]!.cost_rules![0]!.cost!.amount).toBe('0.25')
})
it('keeps an acknowledged write uncertain when its readback is rejected with 400', async () => {
  await start()
  state.products.value[0]!.display_name = '待确认输入'
  api.saveDraft.mockResolvedValue(saved())
  api.detail.mockRejectedValue({ status: 400 })
  expect(await state.saveDraft()).toBe(false)
  expect(state.saveState.value).toBe('unconfirmed')
  expect(state.products.value[0]!.display_name).toBe('待确认输入')
  expect(await state.saveDraft()).toBe(false)
  expect(api.saveDraft).toHaveBeenCalledTimes(1)
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
    const result = acknowledgement(saved(), 3, copy(state.products.value), api.saveDraft.mock.calls[0]![4]); api.detail.mockResolvedValue(result); resolve(result); await saving; expect(state.saveState.value).toBe('saved')
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
    api.detail.mockResolvedValue(saved()); await state.reloadFromServer()
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
    vi.useFakeTimers(); await start(); api.saveDraft.mockImplementationOnce(async (_id, version, products, _removed, submissionId) => { const dto = acknowledgement(saved('PENDING'), version, products, submissionId); api.detail.mockResolvedValue(dto); return dto })
    await state.saveDraft(); let resolve!: (dto: ReturnType<typeof saved>) => void
    api.detail.mockReturnValueOnce(new Promise(r => { resolve = r })); await vi.advanceTimersByTimeAsync(1000)
    const b = saved('FAIL'); b.media_workbench_v1!.draft.revision = 'mwd_c'; b.media_workbench_v1!.validation.draft_revision = 'mwd_c'
    api.saveDraft.mockImplementationOnce(async (_id, version, products, _removed, submissionId) => { const dto = acknowledgement(b, version, products, submissionId); api.detail.mockResolvedValue(dto); return dto }); await state.saveDraft(); resolve(saved('PASS')); await flushPromises()
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
    expect(api.saveDraft).toHaveBeenCalledWith(77, 0, expect.arrayContaining([expect.objectContaining({ media_type: 'image', upstream_model: 'new-model' })]), [], expect.any(String))
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
    mockSave(dto)
    await state.saveDraft()
    expect(api.saveDraft).toHaveBeenCalledWith(77, 3, before.filter(p => p.product_id !== 'blank-3'), ['blank-3'], expect.any(String))
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
    await state.reloadFromServer(); expect(state.products.value).toHaveLength(7); expect(state.removedProducts.value).toEqual([])
  })
  it('allows explicitly removing the last saved blank', async () => {
    const dto = draftManagementSupplier(); dto.media_workbench_v1!.draft.products = [dto.media_workbench_v1!.draft.products[1]!]
    api.detail.mockResolvedValue(dto); await start(); state.removeProduct('blank-1'); mockSave(dto)
    await state.saveDraft(); expect(api.saveDraft).toHaveBeenCalledWith(77, 3, [], ['blank-1'], expect.any(String))
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

describe('pending blank removal recovery before autosave', () => {
  it.each(['image', 'video'] as const)('%s restores the removal intent after closing before autosave without resurrecting the blank', async type => {
    vi.useFakeTimers()
    const dto = draftManagementSupplier(type)
    api.detail.mockResolvedValue(dto); await start(); state.selectModel(dto.models[0]!.model_id)
    const before = copy(state.products.value)
    state.selectedProduct.value = 'blank-3'
    state.removeProduct('blank-3')
    expect(state.removedProducts.value.map(p => p.product_id)).toEqual(['blank-3'])
    await vi.advanceTimersByTimeAsync(1499)
    expect(api.saveDraft).not.toHaveBeenCalled()
    wrapper.unmount()

    await start(); state.selectModel(dto.models[0]!.model_id)
    const entry = state.recoveryEntries.value.find(item => item.value.identity.product_id === 'blank-3')
    expect(entry, 'the local copy must retain a removal made before the server saved it').toBeDefined()
    // Remount only discovers a local operation. Applying it is an explicit choice.
    expect(state.products.value).toEqual(before)
    expect(state.removedProducts.value).toEqual([])
    state.chooseRecovery(entry!.key)
    expect(await state.restoreRecovery()).toBe(true)
    expect(state.products.value).toEqual(before.filter(p => p.product_id !== 'blank-3'))
    expect(state.removedProducts.value.map(p => p.product_id)).toEqual(['blank-3'])
    expect(state.dirty.value).toBe(true)
    expect(api.saveDraft).not.toHaveBeenCalled()

    mockSave(dto)
    expect(await state.saveDraft()).toBe(true)
    expect(api.saveDraft).toHaveBeenCalledWith(77, 3, before.filter(p => p.product_id !== 'blank-3'), ['blank-3'], expect.any(String))
    expect(state.removedProducts.value).toEqual([])
    expect(api.publish).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
  })

  it.each(['image', 'video'] as const)('%s restores an existing blank edit copy as removal after that blank was removed', async type => {
    vi.useFakeTimers()
    const dto = draftManagementSupplier(type)
    api.detail.mockResolvedValue(dto); await start(); state.selectModel(dto.models[0]!.model_id)
    state.selectedProduct.value = 'blank-3'
    state.product.value!.display_name = '空白草稿的本地名称'
    expect(listDraftRecoveries(localStorage, 1, 77).entries.some(entry => entry.value.product.display_name === '空白草稿的本地名称')).toBe(true)
    expect(state.removalReason(state.product.value!)).toBe('')
    state.removeProduct('blank-3')
    wrapper.unmount()

    await start(); state.selectModel(dto.models[0]!.model_id)
    const entries = state.recoveryEntries.value.filter(entry => entry.value.identity.product_id === 'blank-3')
    expect(entries).toHaveLength(1)
    state.chooseRecovery(entries[0]!.key)
    expect(await state.restoreRecovery()).toBe(true)
    expect(state.products.value.some(p => p.product_id === 'blank-3')).toBe(false)
    expect(state.removedProducts.value.map(p => p.product_id)).toEqual(['blank-3'])
    expect(state.removedProducts.value[0]!.display_name).toBe('空白草稿的本地名称')
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
  })

  it.each(['image', 'video'] as const)('%s recovers removing the last saved blank when no selected product remains', async type => {
    vi.useFakeTimers()
    const dto = draftManagementSupplier(type)
    dto.media_workbench_v1!.draft.products = [dto.media_workbench_v1!.draft.products[1]!]
    api.detail.mockResolvedValue(dto); await start(); state.selectModel(dto.models[0]!.model_id)
    state.removeProduct('blank-1')
    expect(state.products.value).toEqual([]); expect(state.product.value).toBeUndefined()
    expect(state.removedProducts.value.map(p => p.product_id)).toEqual(['blank-1'])
    wrapper.unmount()

    await start(); state.selectModel(dto.models[0]!.model_id)
    const entry = state.recoveryEntries.value.find(item => item.value.identity.product_id === 'blank-1')
    expect(entry, 'unmount must persist removal even without a selected product').toBeDefined()
    state.chooseRecovery(entry!.key)
    expect(await state.restoreRecovery()).toBe(true)
    expect(state.products.value).toEqual([])
    expect(state.removedProducts.value.map(p => p.product_id)).toEqual(['blank-1'])
    expect(api.saveDraft).not.toHaveBeenCalled()
    mockSave(dto); expect(await state.saveDraft()).toBe(true)
    expect(api.saveDraft).toHaveBeenCalledWith(77, 3, [], ['blank-1'], expect.any(String))
  })

  it.each(['undo', 'discard', 'reload'] as const)('%s clears only this page removal so it cannot reappear after closing', async action => {
    vi.useFakeTimers(); const dto = draftManagementSupplier()
    api.detail.mockResolvedValue(dto); await start(); state.selectModel(dto.models[0]!.model_id)
    state.removeProduct('blank-3')
    expect(listDraftRecoveries(localStorage, 1, 77).entries.some(entry => entry.value.removed_product)).toBe(true)
    if (action === 'undo') state.undoRemoval('blank-3')
    else if (action === 'discard') state.discard()
    else expect(await state.reloadFromServer()).toBe(true)
    expect(state.products.value.some(p => p.product_id === 'blank-3')).toBe(true)
    expect(state.removedProducts.value).toEqual([])
    wrapper.unmount(); await start(); state.selectModel(dto.models[0]!.model_id)
    expect(state.recoveryEntries.value.some(entry => entry.value.removed_product)).toBe(false)
    expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('does not leave a recoverable new product after explicitly undoing its creation', async () => {
    vi.useFakeTimers(); await start(); state.selectModel('new-model'); state.addProduct('image')
    const id = state.product.value!.product_id
    state.product.value!.display_name = '已撤销的本地草稿'
    expect(listDraftRecoveries(localStorage, 1, 77).entries.some(entry => entry.value.identity.product_id === id)).toBe(true)
    state.removeProduct(id); wrapper.unmount(); await start(); state.selectModel('new-model')
    expect(state.unsubmittedRecoveries.value).toEqual([])
    expect(state.recoveryEntries.value.some(entry => entry.value.identity.product_id === id)).toBe(false)
    expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it.each(['identity', 'permission', 'configured', 'absent'] as const)('refuses a saved removal after the server product becomes %s, even with conflict acceptance', async changed => {
    vi.useFakeTimers(); const dto = draftManagementSupplier()
    api.detail.mockResolvedValue(dto); await start(); state.selectModel(dto.models[0]!.model_id)
    state.removeProduct('blank-3'); wrapper.unmount()
    const latest = copy(dto), p = latest.media_workbench_v1!.draft.products.find(p => p.product_id === 'blank-3')!
    latest.media_workbench_v1!.record_version = 4; latest.media_workbench_v1!.draft.revision = 'new-server'
    if (changed === 'identity') p.upstream_model = 'different-model'
    if (changed === 'permission') latest.product_removal!['blank-3'] = { allowed: false, reason: '已经发布' }
    if (changed === 'configured') p.cost_rules = [{ match: {}, cost: { amount: '0', currency: 'CNY', billing_mode: 'per_request' } }]
    if (changed === 'absent') latest.media_workbench_v1!.draft.products = latest.media_workbench_v1!.draft.products.filter(p => p.product_id !== 'blank-3')
    api.detail.mockResolvedValue(latest); await start()
    const entry = state.recoveryEntries.value.find(entry => entry.value.identity.product_id === 'blank-3')!
    state.chooseRecovery(entry.key)
    expect(state.recoveryConflict.value).toBe(true)
    expect(await state.restoreRecovery()).toBe(false)
    expect(await state.restoreRecovery(true)).toBe(false)
    expect(state.products.value).toEqual(latest.media_workbench_v1!.draft.products)
    expect(state.removedProducts.value).toEqual([])
    expect(localStorage.getItem(entry.key)).toBe(entry.raw)
    expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('explicitly rebases removal without dropping other local fields or resolving their conflicts', async () => {
    vi.useFakeTimers(); const dto = draftManagementSupplier()
    api.detail.mockResolvedValue(dto); await start(); state.selectModel(dto.models[0]!.model_id)
    state.removeProduct('blank-3')
    state.selectedProduct.value = 'canvas-1'; state.product.value!.display_name = '另一商品的本地名称'
    state.product.value!.cost_rules = [{ match: {}, cost: { amount: '0.27', currency: 'CNY', billing_mode: 'per_request' } }]
    const latest = copy(dto)
    latest.media_workbench_v1!.record_version = 4; latest.media_workbench_v1!.draft.revision = 'new-server'
    latest.media_workbench_v1!.draft.products[0]!.display_name = '另一商品的服务器名称'
    api.detail.mockResolvedValue(latest); expect(await state.checkServer()).toBe(false)
    const entry = state.recoveryEntries.value.find(entry => entry.value.identity.product_id === 'blank-3')!
    state.chooseRecovery(entry.key)
    expect(await state.restoreRecovery()).toBe(false)
    expect(await state.restoreRecovery(true)).toBe(true)
    expect(state.products.value.some(p => p.product_id === 'blank-3')).toBe(false)
    expect(state.removedProducts.value.map(p => p.product_id)).toEqual(['blank-3'])
    expect(state.products.value.find(p => p.product_id === 'canvas-1')!.display_name).toBe('另一商品的本地名称')
    expect(state.products.value.find(p => p.product_id === 'canvas-1')!.cost_rules![0]!.cost!.amount).toBe('0.27')
    expect(state.unresolvedProductConflicts.value).toEqual(['canvas-1'])
    expect(await state.restoreRecovery()).toBe(true)
    expect(state.unresolvedProductConflicts.value).toEqual(['canvas-1'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(state.saveState.value).toBe('conflict'); expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('keeps a different pending removal conflicted when that server blank was configured meanwhile', async () => {
    vi.useFakeTimers(); const dto = draftManagementSupplier()
    api.detail.mockResolvedValue(dto); await start(); state.selectModel(dto.models[0]!.model_id)
    state.removeProduct('blank-2'); state.removeProduct('blank-3')
    const latest = copy(dto)
    latest.media_workbench_v1!.record_version = 4; latest.media_workbench_v1!.draft.revision = 'new-server'
    latest.media_workbench_v1!.draft.products.find(p => p.product_id === 'blank-2')!.capabilities.resolutions = ['1K']
    api.detail.mockResolvedValue(latest); expect(await state.checkServer()).toBe(false)
    expect(state.unresolvedProductConflicts.value).toEqual(['blank-2'])
    state.chooseRecovery(state.recoveryEntries.value.find(entry => entry.value.identity.product_id === 'blank-3')!.key)
    expect(await state.restoreRecovery(true)).toBe(true)
    expect(state.unresolvedProductConflicts.value).toEqual(['blank-2'])
    expect(state.products.value.find(p => p.product_id === 'blank-2')!.capabilities.resolutions).toEqual(['1K'])
    const blocked = state.recoveryEntries.value.find(entry => entry.value.identity.product_id === 'blank-2')!
    expect(blocked.value.base_record_version).toBe(3)
    state.chooseRecovery(blocked.key); expect(await state.restoreRecovery(true)).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(state.conflict.value).toBe(true); expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('rechecks the exact removal copy before applying it if another page rewrote its key', async () => {
    vi.useFakeTimers(); const dto = draftManagementSupplier()
    api.detail.mockResolvedValue(dto); await start(); state.selectModel(dto.models[0]!.model_id)
    state.removeProduct('blank-3'); wrapper.unmount(); await start(); state.selectModel(dto.models[0]!.model_id)
    const entry = state.recoveryEntries.value.find(entry => entry.value.identity.product_id === 'blank-3')!
    state.chooseRecovery(entry.key)
    const newer = copy(entry.value); newer.copy_id = crypto.randomUUID(); newer.product.display_name = '另一个页面更新的副本'
    const raw = encodeDraftRecovery(newer); localStorage.setItem(entry.key, raw)
    expect(await state.restoreRecovery()).toBe(false)
    expect(state.products.value).toEqual(dto.media_workbench_v1!.draft.products)
    expect(state.removedProducts.value).toEqual([])
    expect(localStorage.getItem(entry.key)).toBe(raw)
    expect(api.saveDraft).not.toHaveBeenCalled()
  })
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
 await state.reloadFromServer();expect(state.canPublish.value).toBe(true)
})


describe('confirmed incremental autosave and local recovery', () => {
  async function editStart() { await start(); state.selectModel('image-native-1') }
  const stored = () => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith('ai-gateway:media-draft:'))!) || 'null') as DraftRecovery | null
  async function tick() { await vi.advanceTimersByTimeAsync(1500); await flushPromises() }
  it('invalidates old success immediately and saves stopped cost then price input with separate IDs and updated CAS', async () => {
    vi.useFakeTimers(); await editStart(); mockSave(saved())
    state.product.value!.cost_rules = [{ match: {}, cost: { amount: '0.25', currency: 'CNY', billing_mode: 'per_request' } }]
    expect(state.saveState.value).toBe('unsaved'); expect(stored()?.product.cost_rules![0]!.cost!.amount).toBe('0.25')
    await tick(); expect(state.saveState.value).toBe('saved'); expect(api.saveDraft).toHaveBeenCalledTimes(1)
    state.product.value!.pricing_rules[0]!.sale_price!.amount = '0.50'
    expect(state.saveState.value).toBe('unsaved'); expect(state.saveFeedback.value).toBe('')
    await tick(); expect(state.saveState.value).toBe('saved'); expect(api.saveDraft).toHaveBeenCalledTimes(2)
    expect(api.saveDraft.mock.calls[1]![1]).toBe(4)
    expect(api.saveDraft.mock.calls[1]![4]).not.toBe(api.saveDraft.mock.calls[0]![4]); expect(stored()).toBeNull()
  })
  it('coalesces quick edits and serializes a newer queued snapshot without applying the old response to the form', async () => {
    vi.useFakeTimers(); await editStart()
    state.product.value!.display_name = 'A'; state.product.value!.display_name = 'B'
    let resolve!: (value: ReturnType<typeof saved>) => void
    api.saveDraft.mockReturnValueOnce(new Promise(r => { resolve = r }))
    await tick(); expect(api.saveDraft).toHaveBeenCalledTimes(1); expect(api.saveDraft.mock.calls[0]![2][0]!.display_name).toBe('B')
    state.product.value!.display_name = 'C'; state.product.value!.pricing_rules[0]!.sale_price!.amount = '0.7'
    await tick(); expect(api.saveDraft).toHaveBeenCalledTimes(1)
    const call = api.saveDraft.mock.calls[0]!, dto = acknowledgement(saved(), call[1], call[2], call[4])
    api.detail.mockResolvedValue(dto); resolve(dto); await flushPromises()
    expect(state.product.value!.display_name).toBe('C'); expect(state.product.value!.pricing_rules[0]!.sale_price!.amount).toBe('0.7')
    expect(state.saveState.value).toBe('unsaved'); expect(stored()?.product.display_name).toBe('C')
    mockSave(saved()); await tick(); expect(api.saveDraft).toHaveBeenCalledTimes(2)
    expect(api.saveDraft.mock.calls[1]![1]).toBe(4); expect(api.saveDraft.mock.calls[1]![2][0]!.display_name).toBe('C')
    expect(state.saveState.value).toBe('saved')
  })
  it('does not accept another page response and GET as proof of this submission', async () => {
    await editStart(); state.product.value!.display_name = 'local A'
    const b = acknowledgement(saved(), 3, state.products.value, '99999999-9999-4999-8999-999999999999')
    b.media_workbench_v1!.draft.products[0]!.display_name = 'server B'
    api.saveDraft.mockResolvedValue(b); api.detail.mockResolvedValue(b)
    expect(await state.saveDraft()).toBe(false); expect(state.saveState.value).toBe('conflict')
    expect(state.product.value!.display_name).toBe('local A'); expect(stored()?.product.display_name).toBe('local A')
  })
  it('persists a newer reversion to the old server value while an earlier changed value is in flight', async () => {
    await editStart(); const original = state.product.value!.display_name
    state.product.value!.display_name = 'in flight A'
    let resolve!: (value: ReturnType<typeof saved>) => void
    api.saveDraft.mockReturnValueOnce(new Promise(r => { resolve = r }))
    const saving = state.saveDraft()
    state.product.value!.display_name = original
    expect(state.dirty.value).toBe(false); expect(stored()?.product.display_name).toBe(original)
    const call = api.saveDraft.mock.calls[0]!, dto = acknowledgement(saved(), call[1], call[2], call[4])
    api.detail.mockResolvedValue(dto); resolve(dto); await saving
    expect(state.product.value!.display_name).toBe(original); expect(state.dirty.value).toBe(true)
    expect(state.saveState.value).toBe('unsaved'); expect(stored()?.product.display_name).toBe(original)
  })
  it('requires a receipt even when the returned and reread products happen to match', async () => {
    await editStart(); state.product.value!.display_name = 'same values'
    const dto = saved(); dto.media_workbench_v1!.draft.products = copy(state.products.value)
    api.saveDraft.mockResolvedValue(dto); api.detail.mockResolvedValue(dto)
    expect(await state.saveDraft()).toBe(false); expect(state.saveState.value).toBe('unconfirmed')
    expect(state.dirty.value).toBe(true); expect(stored()).not.toBeNull()
  })
  it.each(['base_record_version', 'draft_revision'] as const)('rejects a receipt with the wrong %s', async key => {
    await editStart(); state.product.value!.display_name = 'local'
    api.saveDraft.mockImplementation(async (_id, base, products, _removed, submissionId) => {
      const dto = acknowledgement(saved(), base, products, submissionId)
      if (key === 'base_record_version') dto.media_workbench_v1!.draft.save_receipt!.base_record_version++
      else dto.media_workbench_v1!.draft.save_receipt!.draft_revision = 'other'
      api.detail.mockResolvedValue(dto); return dto
    })
    expect(await state.saveDraft()).toBe(false); expect(state.saveState.value).toBe('unconfirmed')
  })
  it('keeps newer edits during an unknown result and resumes only after GET confirms the original receipt', async () => {
    vi.useFakeTimers(); await editStart(); state.product.value!.display_name = 'sent A'
    api.saveDraft.mockRejectedValue({ status: 0 }); await state.saveDraft()
    expect(state.saveState.value).toBe('unconfirmed')
    state.product.value!.display_name = 'new B'; await tick()
    expect(api.saveDraft).toHaveBeenCalledTimes(1); expect(stored()?.product.display_name).toBe('new B')
    const call = api.saveDraft.mock.calls[0]!
    api.detail.mockResolvedValue(acknowledgement(saved(), call[1], call[2], call[4]))
    expect(await state.checkServer()).toBe(true); expect(state.product.value!.display_name).toBe('new B')
    expect(state.saveState.value).toBe('unsaved'); mockSave(saved()); await tick()
    expect(api.saveDraft).toHaveBeenCalledTimes(2); expect(state.saveState.value).toBe('saved')
  })
  it('lets a human recheck and retry the newest inputs with a new ID after an unsubmitted timeout', async () => {
    vi.useFakeTimers(); await editStart(); state.product.value!.display_name = 'sent A'
    api.saveDraft.mockRejectedValueOnce({ status: 0 })
    expect(await state.saveDraft()).toBe(false)
    expect(state.canRetryUnconfirmedSave.value).toBe(false)
    expect(await state.retryUnconfirmedSave()).toBe(false)
    state.product.value!.display_name = 'new B'; await tick()
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(await state.checkServer()).toBe(false)
    expect(state.canRetryUnconfirmedSave.value).toBe(true)
    state.product.value!.pricing_rules[0]!.sale_price!.amount = '0.72'
    const reads = api.detail.mock.calls.length
    mockSave(saved())
    expect(await state.retryUnconfirmedSave()).toBe(true)
    const [original, retry] = api.saveDraft.mock.calls
    expect(retry![1]).toBe(original![1]); expect(retry![4]).not.toBe(original![4])
    expect(retry![2][0]!.display_name).toBe('new B')
    expect(retry![2][0]!.pricing_rules[0]!.sale_price!.amount).toBe('0.72')
    expect(api.detail.mock.invocationCallOrder[reads]).toBeLessThan(api.saveDraft.mock.invocationCallOrder[1]!)
    expect(state.saveState.value).toBe('saved'); expect(stored()).toBeNull()
  })
  it('rechecks on the retry click and refuses to overwrite a newly changed server', async () => {
    await editStart(); state.product.value!.display_name = 'local A'
    api.saveDraft.mockRejectedValueOnce({ status: 0 }); await state.saveDraft(); await state.checkServer()
    expect(state.canRetryUnconfirmedSave.value).toBe(true)
    const other = saved(); other.media_workbench_v1!.draft.products[0]!.display_name = 'other page'
    api.detail.mockResolvedValue(other)
    expect(await state.retryUnconfirmedSave()).toBe(false)
    expect(api.saveDraft).toHaveBeenCalledTimes(1); expect(state.saveState.value).toBe('conflict')
    expect(state.product.value!.display_name).toBe('local A'); expect(stored()?.product.display_name).toBe('local A')
  })
  it('recognizes a late original commit before retry, preserves newer input and uses the advanced CAS', async () => {
    await editStart(); state.product.value!.display_name = 'sent A'
    api.saveDraft.mockRejectedValueOnce({ status: 0 }); await state.saveDraft(); await state.checkServer()
    state.product.value!.display_name = 'new B'
    const original = api.saveDraft.mock.calls[0]!
    api.detail.mockResolvedValue(acknowledgement(saved(), original[1], original[2], original[4]))
    mockSave(saved())
    expect(await state.retryUnconfirmedSave()).toBe(true)
    expect(api.saveDraft.mock.calls[1]![1]).toBe(4)
    expect(api.saveDraft.mock.calls[1]![2][0]!.display_name).toBe('new B')
    expect(state.product.value!.display_name).toBe('new B'); expect(state.saveState.value).toBe('saved')
  })
  it.each(['original', 'retry'])('CAS admits only one winner when the %s request commits first after the retry check', async winner => {
    await editStart(); let server = supplier()
    api.detail.mockImplementation(async () => copy(server))
    const commit = (call: (typeof api.saveDraft.mock.calls)[number]) => {
      if (server.media_workbench_v1!.record_version !== call[1]) throw { status: 409 }
      server = acknowledgement(saved(), call[1], call[2], call[4]); return copy(server)
    }
    state.product.value!.display_name = 'sent A'
    api.saveDraft.mockRejectedValueOnce({ status: 0 }); await state.saveDraft(); await state.checkServer()
    state.product.value!.display_name = 'new B'
    const original = api.saveDraft.mock.calls[0]!
    api.saveDraft.mockImplementationOnce(async (...call) => {
      if (winner === 'original') commit(original)
      return commit(call)
    })
    expect(await state.retryUnconfirmedSave()).toBe(winner === 'retry')
    if (winner === 'retry') expect(() => commit(original)).toThrow()
    expect(server.media_workbench_v1!.draft.products[0]!.display_name).toBe(winner === 'original' ? 'sent A' : 'new B')
    expect(state.product.value!.display_name).toBe('new B')
    expect(state.saveState.value).toBe(winner === 'original' ? 'conflict' : 'saved')
    if (winner === 'original') expect(stored()?.product.display_name).toBe('new B')
    expect(api.saveDraft).toHaveBeenCalledTimes(2)
  })
  it('does not mark edits made during a human retry as saved by that retry receipt', async () => {
    await editStart(); state.product.value!.display_name = 'sent A'
    api.saveDraft.mockRejectedValueOnce({ status: 0 }); await state.saveDraft(); await state.checkServer()
    state.product.value!.display_name = 'new B'
    let finish!: (dto: ReturnType<typeof saved>) => void
    api.saveDraft.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    const retrying = state.retryUnconfirmedSave(); await flushPromises()
    state.product.value!.display_name = 'newest C'
    const retry = api.saveDraft.mock.calls[1]!, dto = acknowledgement(saved(), retry[1], retry[2], retry[4])
    api.detail.mockResolvedValue(dto); finish(dto); expect(await retrying).toBe(true)
    expect(state.product.value!.display_name).toBe('newest C')
    expect(state.saveState.value).toBe('unsaved'); expect(stored()?.product.display_name).toBe('newest C')
  })
  it('can check and manually retry a refresh-restored uncertain copy without losing its newest values', async () => {
    vi.useFakeTimers(); await editStart(); state.product.value!.display_name = 'sent A'
    api.saveDraft.mockRejectedValueOnce({ status: 0 }); await state.saveDraft()
    const original = api.saveDraft.mock.calls[0]!
    state.product.value!.display_name = 'refresh-surviving B'
    wrapper.unmount(); await editStart()
    expect(await state.restoreRecovery()).toBe(true)
    expect(state.saveState.value).toBe('unconfirmed'); await tick()
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    await state.checkServer(); expect(state.canRetryUnconfirmedSave.value).toBe(true)
    mockSave(saved()); expect(await state.retryUnconfirmedSave()).toBe(true)
    const retry = api.saveDraft.mock.calls[1]!
    expect(retry[4]).not.toBe(original[4]); expect(retry[2][0]!.display_name).toBe('refresh-surviving B')
    expect(state.saveState.value).toBe('saved')
  })
  it('does not retry when the fresh verification fails even if an earlier check allowed it', async () => {
    await editStart(); state.product.value!.display_name = 'local A'
    api.saveDraft.mockRejectedValueOnce({ status: 0 }); await state.saveDraft(); await state.checkServer()
    expect(state.canRetryUnconfirmedSave.value).toBe(true)
    api.detail.mockRejectedValueOnce({ status: 401 })
    expect(await state.retryUnconfirmedSave()).toBe(false)
    expect(state.canRetryUnconfirmedSave.value).toBe(false); expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(state.saveState.value).toBe('unconfirmed'); expect(state.product.value!.display_name).toBe('local A')
  })
  it('keeps offline input and checks the server before reconnecting and sending one write', async () => {
    vi.useFakeTimers(); await editStart(); mockSave(saved()); window.dispatchEvent(new Event('offline'))
    state.product.value!.display_name = 'offline input'; await tick()
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(stored()?.product.display_name).toBe('offline input')
    window.dispatchEvent(new Event('online')); await flushPromises()
    expect(api.detail).toHaveBeenCalledTimes(3); expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(api.detail.mock.invocationCallOrder[1]).toBeLessThan(api.saveDraft.mock.invocationCallOrder[0]!)
    expect(state.saveState.value).toBe('saved')
  })
  it('does not send offline input after reconnecting to a different server version', async () => {
    vi.useFakeTimers(); await editStart(); window.dispatchEvent(new Event('offline'))
    state.product.value!.display_name = 'offline input'; api.detail.mockResolvedValue(saved())
    window.dispatchEvent(new Event('online')); await flushPromises(); await tick()
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(state.saveState.value).toBe('conflict'); expect(state.product.value!.display_name).toBe('offline input')
  })
  it('discovers a refresh-surviving copy without automatically applying or saving it', async () => {
    await editStart(); state.product.value!.display_name = 'recover me'; const key = Object.keys(localStorage)[0]!
    wrapper.unmount(); await start(); state.selectModel('image-native-1')
    expect(state.recovery.value?.product.display_name).toBe('recover me'); expect(state.product.value!.display_name).toBe('画布图片')
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(await state.restoreRecovery()).toBe(true)
    expect(state.product.value!.display_name).toBe('recover me'); expect(localStorage.getItem(key)).not.toBeNull()
  })
  it('shows conflict differences before an explicit restore and keeps the server untouched', async () => {
    await editStart(); state.product.value!.display_name = 'old local'; wrapper.unmount()
    const latest = saved(); latest.media_workbench_v1!.draft.products[0]!.display_name = 'new server'; api.detail.mockResolvedValue(latest)
    await start(); state.selectModel('image-native-1')
    expect(state.recoveryConflict.value).toBe(true); expect(state.recoveryDiff.value.some(d => d.field === 'display_name')).toBe(true)
    expect(await state.restoreRecovery()).toBe(false); expect(state.product.value!.display_name).toBe('new server')
    expect(await state.restoreRecovery(true)).toBe(true); expect(state.product.value!.display_name).toBe('old local')
    expect(state.config.value!.record_version).toBe(4); expect(api.saveDraft).not.toHaveBeenCalled()
  })
  it('read-only checking never overwrites input and only an explicit reload discards it', async () => {
    await editStart(); state.product.value!.display_name = 'local input'; const latest = saved(); api.detail.mockResolvedValue(latest)
    expect(await state.checkServer()).toBe(false); expect(state.product.value!.display_name).toBe('local input')
    expect(stored()).not.toBeNull(); expect(await state.reloadFromServer()).toBe(true)
    expect(state.products.value[0]!.display_name).toBe('画布图片'); expect(stored()).toBeNull()
  })
  it('warns on storage quota or denied reads without claiming the local copy exists', async () => {
    await editStart(); vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    state.product.value!.display_name = 'not persisted'
    expect(state.recoveryWarning.value).toContain('写入失败'); expect(state.saveState.value).toBe('unsaved'); expect(stored()).toBeNull()
  })
  it('does not delete another page newer recovery copy when this request is confirmed', async () => {
    await editStart(); state.product.value!.display_name = 'A'
    api.saveDraft.mockImplementation(async (_id, base, products, _removed, submissionId) => {
      const value = stored()!; value.copy_id = crypto.randomUUID(); value.editor_id = crypto.randomUUID(); value.product.display_name = 'other page B'
      localStorage.setItem(recoveryCopyKey(value.identity, value.editor_id)!, encodeDraftRecovery(value))
      const dto = acknowledgement(saved(), base, products, submissionId); api.detail.mockResolvedValue(dto); return dto
    })
    expect(await state.saveDraft()).toBe(true); expect(stored()?.product.display_name).toBe('other page B')
  })
  it('never overwrites an unrestored B copy when A is edited and B is selected during the whole-Account submission', async () => {
    const dto = supplier(), b = copy(dto.media_workbench_v1!.draft.products[0]!)
    b.product_id = 'product-b'; b.display_name = 'server B'; dto.media_workbench_v1!.draft.products.push(b)
    api.detail.mockResolvedValue(dto); await editStart()
    const value: DraftRecovery = { version: 1, identity: { admin_id: 1, account_id: 77, product_id: b.product_id, site_model: b.site_model, upstream_model: b.upstream_model }, base_record_version: 3, base_draft_revision: 'mwd_a', updated_at: 1, copy_id: crypto.randomUUID(), product: { ...copy(b), display_name: 'unrestored B' } }
    const key = recoveryKey(value.identity)!, raw = encodeDraftRecovery(value); localStorage.setItem(key, raw)
    state.product.value!.display_name = 'edited A'; state.selectedProduct.value = b.product_id
    expect(state.recovery.value?.product.display_name).toBe('unrestored B')
    mockSave(saved()); expect(await state.saveDraft()).toBe(true)
    expect(localStorage.getItem(key)).toBe(raw); expect(state.product.value!.display_name).toBe('server B')
  })
  it.each([false, true])('preserves another locally edited product during conflict recovery (server also changes other product: %s)', async otherChanged => {
    const dto = supplier(), b = copy(dto.media_workbench_v1!.draft.products[0]!)
    b.product_id = 'product-b'; b.display_name = 'server B'; dto.media_workbench_v1!.draft.products.push(b)
    api.detail.mockResolvedValue(dto); await editStart()
    state.product.value!.display_name = 'local A'; state.selectedProduct.value = b.product_id; state.product.value!.display_name = 'local B'
    state.selectedProduct.value = 'canvas-1'
    const latest = copy(dto); latest.media_workbench_v1!.record_version = 4; latest.media_workbench_v1!.draft.revision = 'new-server'; latest.media_workbench_v1!.draft.products[0]!.display_name = 'changed A'
    if (otherChanged) latest.media_workbench_v1!.draft.products[1]!.display_name = 'changed B'
    api.detail.mockResolvedValue(latest); await state.checkServer(); expect(await state.restoreRecovery(true)).toBe(true)
    expect(state.products.value.find(p => p.product_id === b.product_id)!.display_name).toBe('local B')
    expect(state.product.value!.display_name).toBe('local A'); expect(state.conflict.value).toBe(otherChanged)
    expect(api.saveDraft).not.toHaveBeenCalled()
  })
  it('logs only correlation versions HTTP and failure stage, never amounts or product payload', async () => {
    await editStart(); state.product.value!.display_name = 'SYNTHETIC_PRIVATE_DRAFT'; state.product.value!.pricing_rules[0]!.sale_price!.amount = '12345.6789'
    api.saveDraft.mockRejectedValue({ status: 503, message: 'secret vendor response' }); await state.saveDraft()
    const logs = JSON.stringify(vi.mocked(console.warn).mock.calls)
    expect(logs).toContain('submission_id'); expect(logs).toContain('base_record_version'); expect(logs).toContain('stage')
    expect(logs).not.toContain('12345.6789'); expect(logs).not.toContain('SYNTHETIC_PRIVATE_DRAFT'); expect(logs).not.toContain('secret vendor response')
  })
})


describe('recovery consumption identity', () => {
  beforeEach(() => { vi.useFakeTimers() })
  function sourceCopy(dto: ReturnType<typeof supplier>, rawInputs = false, adminId = 1): RecoveryEntry {
    const p = copy(dto.media_workbench_v1!.draft.products[0]!)
    p.display_name = 'adopted source input'
    if (rawInputs) p.media_type = 'video'
    const value: DraftRecovery = {
      version: 1, identity: { admin_id: adminId, account_id: dto.id, product_id: p.product_id, site_model: p.site_model, upstream_model: p.upstream_model },
      editor_id: crypto.randomUUID(), copy_id: crypto.randomUUID(), updated_at: 1,
      base_record_version: dto.media_workbench_v1!.record_version, base_draft_revision: dto.media_workbench_v1!.draft.revision, product: p,
      ...(rawInputs ? { video_sale_inputs: [{ resolution: '720p', group: {}, duration: 5, amount: '12.', source_price: null, domain: 'source-domain' }] } : {})
    }
    const key = recoveryCopyKey(value.identity, value.editor_id!)!, raw = encodeDraftRecovery(value)
    localStorage.setItem(key, raw)
    return { key, raw, value }
  }
  async function adopt(source: RecoveryEntry, adminId?: () => number | undefined) {
    await start(adminId); state.selectModel(source.value.identity.upstream_model); state.chooseRecovery(source.key)
    expect(await state.restoreRecovery()).toBe(true)
  }
  it.each([false, true])('preserves Account A adopted copy when Account B saves the same product ID (raw input: %s)', async rawInputs => {
    const a = supplier(), b = supplier(88)
    if (rawInputs) { a.media_workbench_v1!.draft.products[0]!.media_type = 'video'; b.media_workbench_v1!.draft.products[0]!.media_type = 'video' }
    const source = sourceCopy(a, rawInputs)
    api.detail.mockResolvedValue(a); await adopt(source)
    state.discard(); expect(localStorage.getItem(source.key)).toBe(source.raw)
    api.detail.mockResolvedValue(b); await state.selectSupplier(b.id); state.selectModel(source.value.identity.upstream_model)
    state.product.value!.display_name = rawInputs ? 'independent B change' : source.value.product.display_name
    mockSave(b)
    expect(await state.saveDraft()).toBe(true)
    expect(state.detail.value!.id).toBe(b.id); expect(state.saveState.value).toBe('saved')
    expect(api.saveDraft.mock.calls[0]![0]).toBe(b.id)
    expect(localStorage.getItem(source.key)).toBe(source.raw)
  })
  it.each([false, true])('preserves another admin adopted copy on the same Account (raw input: %s)', async rawInputs => {
    const dto = supplier(), adminId = ref(1)
    if (rawInputs) dto.media_workbench_v1!.draft.products[0]!.media_type = 'video'
    const source = sourceCopy(dto, rawInputs)
    api.detail.mockResolvedValue(dto); await adopt(source, () => adminId.value)
    state.discard(); adminId.value = 2; await flushPromises()
    state.product.value!.display_name = rawInputs ? 'second admin input' : source.value.product.display_name
    mockSave(dto); expect(await state.saveDraft()).toBe(true)
    expect(localStorage.getItem(source.key)).toBe(source.raw)
  })
  it.each([false, true])('consumes the exact adopted copy after the same Account confirms saving (raw input: %s)', async rawInputs => {
    const dto = supplier()
    if (rawInputs) dto.media_workbench_v1!.draft.products[0]!.media_type = 'video'
    const source = sourceCopy(dto, rawInputs)
    api.detail.mockResolvedValue(dto); await adopt(source)
    if (rawInputs) { state.updateVideoSaleInputs([]); state.product.value!.display_name = 'raw input explicitly resolved' }
    mockSave(dto); expect(await state.saveDraft()).toBe(true)
    expect(localStorage.getItem(source.key)).toBeNull()
    expect(listDraftRecoveries(localStorage, 1, dto.id).entries).toEqual([])
  })
  it.each(['adopted', 'owned'] as const)('preserves a byte-different externally rewritten %s copy after a matching save', async target => {
    const dto = supplier(), source = sourceCopy(dto, true)
    dto.media_workbench_v1!.draft.products[0]!.media_type = 'video'
    api.detail.mockResolvedValue(dto); await adopt(source)
    state.updateVideoSaleInputs([]); state.product.value!.display_name = 'raw input explicitly resolved'
    let rewritten!: { key: string; raw: string }
    api.saveDraft.mockImplementation(async (_id, version, products, _removed, submissionId) => {
      const entry = target === 'adopted' ? source : listDraftRecoveries(localStorage, 1, dto.id).entries.find(item => item.key !== source.key)!
      rewritten = { key: entry.key, raw: `${entry.raw} ` }
      localStorage.setItem(rewritten.key, rewritten.raw)
      const result = acknowledgement(dto, version, products, submissionId); api.detail.mockResolvedValue(result); return result
    })
    expect(await state.saveDraft()).toBe(true)
    expect(localStorage.getItem(rewritten.key)).toBe(rewritten.raw)
  })
  it('preserves Account A removal copy when Account B confirms removal of the same product ID', async () => {
    const a = draftManagementSupplier(), b = copy(a); b.id = 88
    a.media_workbench_v1!.draft.products = [copy(a.media_workbench_v1!.draft.products.find(p => p.product_id === 'blank-3')!)]
    const source = sourceCopy(a); source.value.removed_product = true; source.raw = encodeDraftRecovery(source.value); localStorage.setItem(source.key, source.raw)
    api.detail.mockResolvedValue(a); await adopt(source)
    api.detail.mockResolvedValue(b); await state.selectSupplier(b.id); state.selectModel(source.value.identity.upstream_model)
    state.removeProduct(source.value.identity.product_id); mockSave(b)
    expect(await state.saveDraft()).toBe(true)
    expect(localStorage.getItem(source.key)).toBe(source.raw)
  })
  it('preserves Account A adopted new product when Account B cancels its own product with the same ID', async () => {
    const a = supplier(), b = supplier(88), id = 'media-11111111-1111-4111-8111-111111111111'
    a.media_workbench_v1!.draft.products[0]!.product_id = id
    const source = sourceCopy(a); source.value.new_product = true; source.raw = encodeDraftRecovery(source.value); localStorage.setItem(source.key, source.raw)
    a.media_workbench_v1!.draft.products = []
    api.detail.mockResolvedValue(a); await adopt(source)
    api.detail.mockResolvedValue(b); await state.selectSupplier(b.id); state.selectModel(source.value.identity.upstream_model)
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
    state.addProduct('image', true); expect(state.selectedProduct.value).toBe(id)
    state.removeProduct(id)
    expect(state.products.value.some(p => p.product_id === id)).toBe(false)
    expect(localStorage.getItem(source.key)).toBe(source.raw)
  })
  it('preserves a preview from the previous admin when explicit discard runs before discovery updates', async () => {
    const adminId = ref(1), source = sourceCopy(supplier())
    await start(() => adminId.value); state.selectModel(source.value.identity.upstream_model); state.chooseRecovery(source.key)
    adminId.value = 2; state.discardRecovery()
    expect(localStorage.getItem(source.key)).toBe(source.raw)
  })
})

describe('reviewed per-page ownership and per-product conflicts', () => {
  const pages: ReturnType<typeof mount>[] = []
  async function page() {
    let value!: ReturnType<typeof useMediaWorkbench>
    const mounted = mount(defineComponent({ setup() { value = useMediaWorkbench(() => 1); return () => null } }))
    pages.push(mounted); await value.selectSupplier(77); value.selectModel('image-native-1')
    return { value, mounted }
  }
  const copies = () => listDraftRecoveries(localStorage, 1, 77).entries
  afterEach(() => { for (const mounted of pages.splice(0)) mounted.unmount() })
  function twoProducts() {
    const dto = supplier(), b = copy(dto.media_workbench_v1!.draft.products[0]!)
    b.product_id = 'product-b'; b.display_name = 'server B'; dto.media_workbench_v1!.draft.products.push(b)
    return dto
  }
  it('keeps another page edit copy when this page restores and confirms removal of the same blank', async () => {
    vi.useFakeTimers(); const dto = draftManagementSupplier(); api.detail.mockResolvedValue(dto)
    const a = await page(), b = await page()
    a.value.selectModel(dto.models[0]!.model_id); b.value.selectModel(dto.models[0]!.model_id)
    a.value.removeProduct('blank-3')
    b.value.selectedProduct.value = 'blank-3'; b.value.product.value!.display_name = '另一页面的空白编辑'
    a.mounted.unmount(); b.mounted.unmount()
    const removal = copies().find(entry => entry.value.removed_product)!
    const edit = copies().find(entry => entry.value.product.display_name === '另一页面的空白编辑')!
    expect(removal.key).not.toBe(edit.key)
    const c = await page(); c.value.selectModel(dto.models[0]!.model_id); c.value.chooseRecovery(removal.key)
    expect(await c.value.restoreRecovery()).toBe(true)
    expect(c.value.products.value.some(p => p.product_id === 'blank-3')).toBe(false)
    expect(localStorage.getItem(edit.key)).toBe(edit.raw)
    // Choosing another page's edit cannot silently undo an applied removal.
    c.value.chooseRecovery(edit.key); expect(await c.value.restoreRecovery()).toBe(false)
    expect(c.value.removedProducts.value.map(p => p.product_id)).toEqual(['blank-3'])
    mockSave(dto); expect(await c.value.saveDraft()).toBe(true)
    expect(localStorage.getItem(removal.key)).toBeNull()
    expect(localStorage.getItem(edit.key)).toBe(edit.raw)
    expect(copies().filter(entry => entry.value.removed_product)).toEqual([])
    expect(api.publish).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
  })
  it('repeatedly restoring A cannot release B conflict or overwrite its locally edited fields', async () => {
    vi.useFakeTimers(); const dto = twoProducts(); api.detail.mockResolvedValue(dto)
    const { value } = await page()
    value.product.value!.display_name = 'local A'; value.selectedProduct.value = 'product-b'; value.product.value!.display_name = 'local B'
    value.product.value!.cost_rules = [{ match: {}, cost: { amount: '0.37', currency: 'CNY', billing_mode: 'per_request' } }]
    value.selectedProduct.value = 'canvas-1'
    const latest = copy(dto); latest.media_workbench_v1!.record_version = 4; latest.media_workbench_v1!.draft.revision = 'server-new'
    latest.media_workbench_v1!.draft.products[0]!.display_name = 'server changed A'; latest.media_workbench_v1!.draft.products[1]!.display_name = 'server changed B'
    api.detail.mockResolvedValue(latest); await value.checkServer()
    expect(await value.restoreRecovery(true)).toBe(true)
    expect(value.unresolvedProductConflicts.value).toEqual(['product-b'])
    expect(await value.restoreRecovery(false)).toBe(true)
    expect(value.conflict.value).toBe(true); expect(value.saveState.value).toBe('conflict')
    expect(await value.checkServer()).toBe(false)
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.saveDraft).not.toHaveBeenCalled()
    const b = value.products.value.find(p => p.product_id === 'product-b')!
    expect(b.display_name).toBe('local B'); expect(b.cost_rules![0]!.cost!.amount).toBe('0.37')
    value.selectedProduct.value = 'product-b'
    expect(await value.restoreRecovery(false)).toBe(false)
    expect(value.recovery.value!.base_record_version).toBe(3)
    const refreshed = await page(); refreshed.value.selectedProduct.value = 'product-b'
    expect(refreshed.value.recoveryConflict.value).toBe(true)
    expect(await refreshed.value.restoreRecovery(false)).toBe(false)
    expect(await value.restoreRecovery(true)).toBe(true)
    expect(value.unresolvedProductConflicts.value).toEqual([]); expect(value.conflict.value).toBe(false)
    expect(value.products.value.find(p => p.product_id === 'canvas-1')!.display_name).toBe('local A')
  })
  it('keeps both pages copies when A edits first, B edits later, then A and B close', async () => {
    const a = await page(), b = await page()
    window.dispatchEvent(new Event('offline'))
    a.value.product.value!.display_name = 'page A older input'
    b.value.product.value!.display_name = 'page B newer input'
    expect(copies()).toHaveLength(2)
    const bCopy = copies().find(entry => entry.value.product.display_name === 'page B newer input')!
    a.mounted.unmount()
    expect(localStorage.getItem(bCopy.key)).toBe(bCopy.raw)
    b.mounted.unmount()
    const bAfterClose = localStorage.getItem(bCopy.key)
    expect(copies().map(entry => entry.value.product.display_name).sort()).toEqual(['page A older input', 'page B newer input'])
    const c = await page()
    expect(c.value.productRecoveries.value).toHaveLength(2)
    expect(c.value.product.value!.display_name).toBe('画布图片')
    const aCopy = copies().find(entry => entry.value.product.display_name === 'page A older input')!
    c.value.chooseRecovery(aCopy.key); expect(await c.value.restoreRecovery()).toBe(true)
    expect(c.value.product.value!.display_name).toBe('page A older input')
    expect(localStorage.getItem(bCopy.key)).toBe(bAfterClose)
  })
  it('discard and confirmed reload remove only the current owned copy and retain unrestored B and another page A', async () => {
    const dto = twoProducts(); api.detail.mockResolvedValue(dto)
    const a = await page(), other = await page()
    a.value.product.value!.display_name = 'owned local A'
    other.value.product.value!.display_name = 'other page A'
    const b = dto.media_workbench_v1!.draft.products[1]!
    const bValue: DraftRecovery = { version: 1, identity: { admin_id: 1, account_id: 77, product_id: b.product_id, site_model: b.site_model, upstream_model: b.upstream_model }, base_record_version: 3, base_draft_revision: 'mwd_a', updated_at: 1, copy_id: crypto.randomUUID(), editor_id: crypto.randomUUID(), product: { ...copy(b), display_name: 'unrestored B' } }
    const bKey = recoveryCopyKey(bValue.identity, bValue.editor_id!)!, bRaw = encodeDraftRecovery(bValue); localStorage.setItem(bKey, bRaw)
    const otherCopy = copies().find(entry => entry.value.product.display_name === 'other page A')!
    const owned = copies().find(entry => entry.value.product.display_name === 'owned local A')!
    a.value.discard()
    expect(localStorage.getItem(owned.key)).toBeNull(); expect(localStorage.getItem(otherCopy.key)).toBe(otherCopy.raw); expect(localStorage.getItem(bKey)).toBe(bRaw)
    a.value.product.value!.display_name = 'second owned edit'
    const second = copies().find(entry => entry.value.product.display_name === 'second owned edit')!
    expect(await a.value.reloadFromServer()).toBe(true)
    expect(localStorage.getItem(second.key)).toBeNull(); expect(localStorage.getItem(otherCopy.key)).toBe(otherCopy.raw); expect(localStorage.getItem(bKey)).toBe(bRaw)
    other.mounted.unmount()
    expect(copies().some(entry => entry.value.product.display_name === 'other page A')).toBe(true)
  })
  it('discovers an offline unsubmitted video and restores identity and sale without retired procurement', async () => {
    const first = await page(); first.value.selectModel('new-model'); window.dispatchEvent(new Event('offline'))
    first.value.addProduct('video')
    const id = first.value.product.value!.product_id
    first.value.product.value!.display_name = '离线新增视频'
    first.value.product.value!.capabilities.durations_seconds = [6, 12]
    first.value.product.value!.cost_rules = [{ match: { duration_seconds: [6] }, cost: { amount: '0.37', currency: 'CNY', billing_mode: 'per_request' }, source: 'calculator' }]
    first.value.product.value!.pricing_rules = [{ match: { duration_seconds: [6] }, sale_price: { amount: '0.8', currency: 'CNY', billing_mode: 'per_request' } }]
    first.mounted.unmount()
    const next = await page(); next.value.selectModel('new-model')
    expect(next.value.product.value).toBeUndefined(); expect(next.value.unsubmittedRecoveries.value).toHaveLength(1)
    next.value.chooseRecovery(next.value.unsubmittedRecoveries.value[0]!.key)
    expect(next.value.product.value).toBeUndefined(); expect(next.value.recovery.value!.new_product).toBe(true)
    expect(await next.value.restoreRecovery()).toBe(true)
    expect(next.value.product.value!.product_id).toBe(id); expect(next.value.addedProductIds.value).toContain(id)
    expect(next.value.product.value!.display_name).toBe('离线新增视频'); expect(next.value.product.value!.capabilities.durations_seconds).toEqual([6, 12])
    expect(next.value.product.value!.cost_rules).toBeUndefined(); expect(next.value.product.value!.pricing_rules[0]!.sale_price!.amount).toBe('0.8')
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
  })
  it('warns at the bounded Account copy limit and never evicts another editor recovery to make space', async () => {
    const { value } = await page()
    for (let index = 0; index < 32; index++) {
      const p = copy(value.product.value!)
      p.product_id = `retained-${index}`
      const entry: DraftRecovery = { version: 1, identity: { admin_id: 1, account_id: 77, product_id: p.product_id, site_model: p.site_model, upstream_model: p.upstream_model }, editor_id: crypto.randomUUID(), base_record_version: 3, base_draft_revision: 'mwd_a', updated_at: index, copy_id: crypto.randomUUID(), product: p }
      localStorage.setItem(recoveryCopyKey(entry.identity, entry.editor_id!)!, encodeDraftRecovery(entry))
    }
    const before = copies().map(entry => entry.raw).sort()
    value.product.value!.display_name = 'cannot yet persist this copy'
    expect(value.recoveryWarning.value).toContain('32 份上限')
    expect(copies().map(entry => entry.raw).sort()).toEqual(before)
    expect(value.product.value!.display_name).toBe('cannot yet persist this copy')
    expect(value.saveState.value).toBe('unsaved')
  })
})

it('does not auto-resend an unchanged rejected draft on step/blur, but permits correction or an explicit retry',async()=>{
 await start();state.products.value[0]!.display_name='Rejected input';api.saveDraft.mockRejectedValue({status:400})
 expect(await state.flushAutoSave()).toBe(false);expect(state.saveState.value).toBe('failed')
 expect(await state.flushAutoSave()).toBe(false);expect(await state.flushAutoSave()).toBe(false)
 expect(api.saveDraft).toHaveBeenCalledTimes(1)
 expect(await state.saveDraft()).toBe(false);expect(api.saveDraft).toHaveBeenCalledTimes(2)
 state.products.value[0]!.display_name='Corrected input';mockSave(saved())
 expect(await state.flushAutoSave()).toBe(true);expect(api.saveDraft).toHaveBeenCalledTimes(3)
 expect(state.products.value[0]!.display_name).toBe('Corrected input');expect(state.saveState.value).toBe('saved')
})
