import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mediaWorkbenchAPI } from '@/api/admin/mediaWorkbench'
import { useMediaWorkbench } from '../useMediaWorkbench'
import { supplier, saved, copy } from '@/components/admin/media/__tests__/fixtures'

vi.mock('@/api/admin/mediaWorkbench', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/admin/mediaWorkbench')>(),
  mediaWorkbenchAPI: { suppliers: vi.fn(), detail: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), sales: vi.fn(), sync: vi.fn(), initialize: vi.fn() }
}))
const api = vi.mocked(mediaWorkbenchAPI)
let state: ReturnType<typeof useMediaWorkbench>
let wrapper: ReturnType<typeof mount>
async function start() {
  wrapper = mount(defineComponent({ setup() { state = useMediaWorkbench(); return () => null } }))
  await state.selectSupplier(77)
}
beforeEach(() => { vi.resetAllMocks(); api.detail.mockResolvedValue(supplier()); api.suppliers.mockResolvedValue([supplier(), supplier(44)]) })
afterEach(() => { wrapper?.unmount(); vi.useRealTimers() })
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
  it('renders server readiness and rejects stale validation revisions', async () => {
    await start(); expect(state.canPublish.value).toBe(true)
    state.config.value!.validation.draft_revision = 'old'; expect(state.canPublish.value).toBe(false)
    state.config.value!.validation.draft_revision = 'mwd_a'; state.config.value!.validation.publish_ready = false
    expect(state.canPublish.value).toBe(false)
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
    resolve(saved()); await saving; expect(state.saveState.value).toBe('saved')
  })
  it('a saved validation FAIL remains a successfully saved Draft', async () => {
    await start(); api.saveDraft.mockResolvedValue(saved('FAIL')); expect(await state.saveDraft()).toBe(true)
    expect(state.saveState.value).toBe('saved'); expect(state.dirty.value).toBe(false); expect(state.canPublish.value).toBe(false)
    expect(state.diagnostics.value[0]?.code).toBe('MISSING_PRICE')
  })
  it('UNKNOWN disables Publish without removing a saved Draft', async () => {
    await start(); api.saveDraft.mockResolvedValue(saved('UNKNOWN')); await state.saveDraft()
    expect(state.saveState.value).toBe('saved'); expect(state.products.value).toHaveLength(1); expect(state.canPublish.value).toBe(false)
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
    api.saveDraft.mockResolvedValue(saved()); await state.saveDraft(); expect(api.saveDraft.mock.calls[0]![1]).toBe(9)
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
    api.publish.mockReturnValue(new Promise(r => { resolve = r })); const publishing = state.publish(); await state.publish()
    expect(api.publish).toHaveBeenCalledTimes(1); expect(api.publish).toHaveBeenCalledWith(77, 3, 'mwd_a')
    resolve(saved()); await publishing
  })
  it('422 Publish rereads diagnostics and blocks stale PASS', async () => {
    await start(); api.publish.mockRejectedValue({ status: 422 }); api.detail.mockResolvedValue(supplier(77, 'FAIL'))
    await state.publish(); expect(state.canPublish.value).toBe(false); expect(state.diagnostics.value[0]?.class).toBe('UI_FIXABLE')
  })
  it('revision-only Publish acknowledgement refreshes the editor exactly once', async () => {
    await start(); api.publish.mockResolvedValue({ record_version: 4, published_revision: 'mwp_b' }); api.detail.mockResolvedValue(saved())
    await state.publish(); expect(api.detail).toHaveBeenCalledTimes(2); expect(state.config.value!.record_version).toBe(4)
  })
  it('slow supplier responses cannot replace the current supplier', async () => {
    await start(); let resolve!: (dto: ReturnType<typeof supplier>) => void
    api.detail.mockReturnValueOnce(new Promise(r => { resolve = r })).mockResolvedValueOnce(supplier(44))
    const old = state.selectSupplier(77); await state.selectSupplier(44); resolve(supplier(77)); await old
    expect(state.detail.value!.id).toBe(44)
  })
  it('late validation A cannot overwrite saved Draft B', async () => {
    vi.useFakeTimers(); await start(); api.saveDraft.mockResolvedValueOnce(saved('PENDING'))
    await state.saveDraft(); let resolve!: (dto: ReturnType<typeof saved>) => void
    api.detail.mockReturnValueOnce(new Promise(r => { resolve = r })); await vi.advanceTimersByTimeAsync(1000)
    const b = saved('FAIL'); b.media_workbench_v1!.draft.revision = 'mwd_c'; b.media_workbench_v1!.validation.draft_revision = 'mwd_c'
    api.saveDraft.mockResolvedValueOnce(b); await state.saveDraft(); resolve(saved('PASS')); await flushPromises()
    expect(state.config.value!.draft.revision).toBe('mwd_c'); expect(state.config.value!.validation.status).toBe('FAIL'); expect(state.canPublish.value).toBe(false)
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
    api.saveDraft.mockResolvedValue(saved()); await state.saveDraft()
    expect(api.saveDraft.mock.calls[0]![2][0]!.adapter_config).toEqual(config)
  })
  it('a failed selection of a deleted supplier does not mark the current supplier deleted', async () => {
    await start(); api.detail.mockRejectedValueOnce({ status: 404 }); await state.selectSupplier(44)
    expect(state.detail.value!.id).toBe(77); expect(state.deleted.value).toBe(false)
  })
  it('first explicit save atomically initializes a nil media configuration', async () => {
    const dto = supplier(); dto.media_workbench_v1 = null; dto.effective_state = 'NOT_INITIALIZED'; dto.effective_sales = false
    api.detail.mockResolvedValue(dto); await start(); state.selectModel('new-model'); state.addProduct('image')
    api.saveDraft.mockResolvedValue(saved())
    expect(await state.saveDraft()).toBe(true)
    expect(api.saveDraft).toHaveBeenCalledWith(77, 0, expect.arrayContaining([expect.objectContaining({ media_type: 'image', upstream_model: 'new-model' })]))
  })
})
