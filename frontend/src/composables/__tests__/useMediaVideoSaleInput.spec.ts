import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mediaWorkbenchAPI, type Product, type SupplierDetail } from '@/api/admin/mediaWorkbench'
import MediaVideoSaleEditor from '@/components/admin/media/MediaVideoSaleEditor.vue'
import { copy, supplier } from '@/components/admin/media/__tests__/fixtures'
import * as saleGroups from '@/components/admin/media/videoSaleGroups'
import * as matrix from '@/components/admin/media/pricingMatrix'
import { listDraftRecoveries } from '../draftRecovery'
import { useMediaWorkbench } from '../useMediaWorkbench'

vi.mock('@/api/admin/mediaWorkbench', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/admin/mediaWorkbench')>(),
  mediaWorkbenchAPI: { suppliers: vi.fn(), detail: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), sales: vi.fn(), sync: vi.fn(), initialize: vi.fn(), lifecycle: vi.fn() }
}))
const api = vi.mocked(mediaWorkbenchAPI)
let state: ReturnType<typeof useMediaWorkbench>
let wrapper: ReturnType<typeof mount>
function videoSupplier() {
  const dto = supplier()
  const p = dto.media_workbench_v1!.draft.products[0]!
  p.media_type = 'video'; p.capabilities.resolutions = ['720p', '1080p', '4K']
  p.capabilities.durations_seconds = Array.from({ length: 32 }, (_, i) => i + 1)
  p.capabilities.aspect_ratios = ['1:1', '4:3', '3:4', '16:9', '9:16', '2:1']
  p.capabilities.qualities = ['standard', 'high']; p.pricing_rules = [{ match: {}, sale_price: null }]
  return dto
}
function acknowledged(dto: SupplierDetail, base: number, products: Product[], id?: string) {
  const response = copy(dto), config = response.media_workbench_v1!
  config.record_version = base + 1; config.draft.revision = 'mwd_buffer_saved'; config.draft.products = copy(products)
  config.draft.save_receipt = { submission_id: id!, base_record_version: base, draft_revision: config.draft.revision }
  config.validation = { ...config.validation, draft_revision: config.draft.revision }
  return response
}
async function start() {
  wrapper = mount(defineComponent({ setup() {
    state = useMediaWorkbench(() => 1)
    return () => state.product.value ? h(MediaVideoSaleEditor, {
      product: state.product.value, pendingVideoSales: state.videoSaleInputs.value,
      'onPending-video-sales': state.updateVideoSaleInputs,
      'onUpdate:product': (value: Product) => { const at = state.products.value.findIndex(p => p.product_id === value.product_id); state.products.value[at] = value }
    }) : null
  } }))
  await state.selectSupplier(77); state.selectModel('image-native-1'); await flushPromises()
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); vi.resetAllMocks(); localStorage.clear()
  HTMLDialogElement.prototype.showModal = vi.fn(); HTMLDialogElement.prototype.close = vi.fn()
  api.detail.mockResolvedValue(videoSupplier()); api.suppliers.mockResolvedValue([videoSupplier()])
  api.saveDraft.mockImplementation(async (_id, base, products, _removed, submissionId) => {
    const dto = acknowledged(videoSupplier(), base, products, submissionId); api.detail.mockResolvedValue(dto); return dto
  })
})
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); vi.restoreAllMocks() })

it('protects each raw decimal immediately, restores it after refresh, and only saves the committed final value', async () => {
  await start()
  const original = copy(state.product.value!)
  const groups = vi.spyOn(saleGroups, 'videoGroups'), specs = vi.spyOn(matrix, 'allowedSpecs')
  const startTime = performance.now()
  for (const amount of ['1', '12', '12.', '12.5', '12.50', '12.5', '12.']) {
    await wrapper.get('[data-test="video-sale-1"]').setValue(amount)
    expect(listDraftRecoveries(localStorage, 1, 77).entries[0]!.value.video_sale_inputs![0]!.amount).toBe(amount)
  }
  console.info('[video-input-recovery-measurement]', JSON.stringify({ keys: 7, elapsed_ms: Number((performance.now() - startTime).toFixed(2)), group_recalculations: groups.mock.calls.length, domain_enumerations: specs.mock.calls.length }))
  expect(groups).toHaveBeenCalledTimes(0); expect(specs).toHaveBeenCalledTimes(0)
  expect(state.product.value).toEqual(original); expect(state.dirty.value).toBe(true)
  expect(await state.saveDraft()).toBe(false); expect(api.saveDraft).not.toHaveBeenCalled()
  wrapper.unmount(); await start()
  expect(state.recovery.value?.video_sale_inputs?.[0]!.amount).toBe('12.')
  expect(await state.restoreRecovery()).toBe(true); await flushPromises()
  expect((wrapper.get('[data-test="video-sale-1"]').element as HTMLInputElement).value).toBe('12.')
  await vi.advanceTimersByTimeAsync(800); await flushPromises()
  expect(api.saveDraft).not.toHaveBeenCalled()
  expect(wrapper.text()).toContain('本地输入已保留')
  await wrapper.get('[data-test="video-sale-1"]').setValue('12.50')
  await wrapper.get('[data-test="video-sale-1"]').trigger('blur'); await flushPromises()
  await vi.advanceTimersByTimeAsync(1500); await flushPromises()
  expect(api.saveDraft).toHaveBeenCalledTimes(1)
  expect(api.saveDraft.mock.calls[0]![1]).toBe(3)
  expect(api.saveDraft.mock.calls[0]![2][0]!.pricing_rules.some(rule => rule.sale_price?.amount === '12.50')).toBe(true)
  expect(state.saveState.value).toBe('saved'); expect(state.videoSaleInputs.value).toEqual([])
  expect(listDraftRecoveries(localStorage, 1, 77).entries).toEqual([])
})

it('keeps newer raw input and its recovery when an older matching save receipt arrives', async () => {
  await start()
  state.product.value!.display_name = '较早的商品名称'
  let resolveSave!: (value: SupplierDetail) => void
  api.saveDraft.mockImplementation(() => new Promise(resolve => { resolveSave = resolve }))
  const saving = state.saveDraft()
  const submission = api.saveDraft.mock.calls[0]!
  await wrapper.get('[data-test="video-sale-1"]').setValue('12.')
  expect(listDraftRecoveries(localStorage, 1, 77).entries[0]!.value.pending_submission).toBeDefined()
  const confirmed = acknowledged(videoSupplier(), submission[1], submission[2], submission[4])
  api.detail.mockResolvedValue(confirmed)
  resolveSave(confirmed); await saving; await flushPromises()
  expect(state.saveState.value).toBe('unsaved')
  expect(state.dirty.value).toBe(true); expect(state.videoSaleInputs.value[0]!.amount).toBe('12.')
  expect(listDraftRecoveries(localStorage, 1, 77).entries[0]!.value.video_sale_inputs![0]!.amount).toBe('12.')
  expect(await state.flushAutoSave()).toBe(false); expect(api.saveDraft).toHaveBeenCalledTimes(1)
})

it('retains raw input when storage is unavailable and never sends the stale product', async () => {
  await start()
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
  await wrapper.get('[data-test="video-sale-1"]').setValue('12.')
  expect(state.recoveryWarning.value).toContain('写入失败')
  expect(state.videoSaleInputs.value[0]!.amount).toBe('12.')
  expect(await state.saveDraft()).toBe(false); expect(api.saveDraft).not.toHaveBeenCalled()
})

it('does not leave an orphan price buffer after cancelling a newly added video product', async () => {
  await start()
  const originalId = state.selectedProduct.value, capabilities = copy(state.product.value!.capabilities)
  state.addProduct('video', true)
  const newId = state.selectedProduct.value
  state.product.value!.capabilities = capabilities
  await flushPromises()
  await wrapper.get('[data-test="video-sale-1"]').setValue('12.')
  expect(state.videoSaleInputs.value[0]!.amount).toBe('12.')
  expect(listDraftRecoveries(localStorage, 1, 77).entries.some(entry => entry.value.product.product_id === newId)).toBe(true)
  state.removeProduct(newId); await flushPromises()
  expect(state.products.value.some(p => p.product_id === newId)).toBe(false)
  expect(state.selectedProduct.value).toBe(originalId)
  expect(state.videoSaleInputs.value).toEqual([])
  expect(listDraftRecoveries(localStorage, 1, 77).entries.some(entry => entry.value.product.product_id === newId)).toBe(false)
  state.product.value!.display_name = '撤销新增后仍可保存'
  expect(await state.saveDraft()).toBe(true)
  expect(api.saveDraft).toHaveBeenCalledTimes(1)
  expect(state.dirty.value).toBe(false)
})

it('clears only the cancelled product buffer and retains another product buffer on a denied removal', async () => {
  await start()
  const originalId = state.selectedProduct.value, capabilities = copy(state.product.value!.capabilities)
  await wrapper.get('[data-test="video-sale-1"]').setValue('7.')
  state.addProduct('video', true)
  const newId = state.selectedProduct.value
  state.product.value!.capabilities = capabilities
  await flushPromises()
  await wrapper.get('[data-test="video-sale-1"]').setValue('12.')
  state.removeProduct(newId); await flushPromises()
  expect(state.selectedProduct.value).toBe(originalId)
  expect(state.videoSaleInputs.value[0]!.amount).toBe('7.')
  state.removeProduct(originalId)
  expect(state.products.value.some(p => p.product_id === originalId)).toBe(true)
  expect(state.videoSaleInputs.value[0]!.amount).toBe('7.')
  expect(await state.saveDraft()).toBe(false)
  await wrapper.get('[data-test="video-sale-1"]').setValue('7.25')
  await wrapper.get('[data-test="video-sale-1"]').trigger('blur'); await flushPromises()
  expect(await state.saveDraft()).toBe(true)
  expect(api.saveDraft).toHaveBeenCalledTimes(1)
})

it('retains another video product raw input while removing and undoing removal of an existing blank product', async () => {
  const dto = videoSupplier(), blank = copy(dto.media_workbench_v1!.draft.products[0]!)
  blank.product_id = 'blank-video'; blank.enabled = false; blank.pricing_rules = []
  blank.capabilities = { resolutions: [], aspect_ratios: [], qualities: [], durations_seconds: [], count: { min: 1, max: 1 }, references: { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }, combination_rules: [] }
  dto.media_workbench_v1!.draft.products.push(blank)
  dto.product_removal = { [blank.product_id]: { allowed: true, reason: '' } }
  api.detail.mockResolvedValue(dto)
  await start()
  await wrapper.get('[data-test="video-sale-1"]').setValue('7.')
  state.removeProduct(blank.product_id)
  expect(state.removedProducts.value.map(p => p.product_id)).toEqual([blank.product_id])
  expect(state.videoSaleInputs.value[0]!.amount).toBe('7.')
  state.undoRemoval(blank.product_id); await flushPromises()
  expect(state.removedProducts.value).toEqual([])
  expect(state.products.value.some(p => p.product_id === blank.product_id)).toBe(true)
  state.selectedProduct.value = 'canvas-1'; await flushPromises()
  expect(state.videoSaleInputs.value[0]!.amount).toBe('7.')
  expect(await state.saveDraft()).toBe(false)
  await wrapper.get('[data-test="video-sale-1"]').setValue('7.25')
  await wrapper.get('[data-test="video-sale-1"]').trigger('blur'); await flushPromises()
  expect(await state.saveDraft()).toBe(true)
})
