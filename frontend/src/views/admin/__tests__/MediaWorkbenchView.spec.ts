import { createPinia } from 'pinia'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MediaWorkbenchView from '../MediaWorkbenchView.vue'
import { useAuthStore } from '@/stores/auth'
import { encodeDraftRecovery, recoveryCopyKey, type DraftRecovery } from '@/composables/draftRecovery'
import { mediaWorkbenchAPI } from '@/api/admin/mediaWorkbench'
import { supplier, saved, copy, draftManagementSupplier } from '@/components/admin/media/__tests__/fixtures'

vi.mock('@/api/admin/mediaWorkbench', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/admin/mediaWorkbench')>(),
  mediaWorkbenchAPI: { suppliers: vi.fn(), detail: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), sales: vi.fn(), sync: vi.fn(), initialize: vi.fn(), lifecycle: vi.fn() }
}))
vi.mock('@/api/admin/mediaPaid', () => ({ mediaPaidAPI: { status: vi.fn(async (media: string) => ({ media, mode: 'managed-v1', effective_enabled: false, requested_enabled: false })) } }))
const api = vi.mocked(mediaWorkbenchAPI)
function acknowledgement(dto: ReturnType<typeof saved>, version: number, products: Parameters<typeof mediaWorkbenchAPI.saveDraft>[2], submissionId?: string) {
  dto = copy(dto)
  dto.media_workbench_v1!.record_version = Math.max(dto.media_workbench_v1!.record_version, version + 1)
  dto.media_workbench_v1!.draft.products = copy(products)
  dto.media_workbench_v1!.draft.save_receipt = { submission_id: submissionId!, base_record_version: version, draft_revision: dto.media_workbench_v1!.draft.revision }
  return dto
}
function mockSave(dto: ReturnType<typeof saved>) { api.saveDraft.mockImplementation(async (_id, version, products, _removed, submissionId) => { const result = acknowledgement(dto, version, products, submissionId); api.detail.mockResolvedValue(result); return result }) }
let wrapper: VueWrapper
let router: ReturnType<typeof createRouter>

async function mountWorkbench() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/media', component: MediaWorkbenchView }, { path: '/admin/accounts', component: { template: '<div>Accounts</div>' } }] })
  await router.push('/admin/media')
  wrapper = mount({ template: '<router-view />' }, { attachTo: document.body, global: { plugins: [createPinia(), router], stubs: { MediaPaidControls: true, AppLayout: { template: '<div><slot /></div>' } } } })
  await flushPromises()
}
async function expandSource(host: string) {
  await wrapper.get(`[data-test="source-${host}"] summary`).trigger('click')
  await flushPromises()
}
async function selectAccount(id = 77) {
  await expandSource(id === 77 ? 'images.example.invalid' : 'video.example.invalid')
  await wrapper.get(`[data-test="supplier-${id}"]`).trigger('click')
  await flushPromises()
}
async function openEditor(id = 77, model = 'image-native-1') {
  await mountWorkbench(); await selectAccount(id)
  await wrapper.get(`[data-test="model-${model}"]`).trigger('click')
  await flushPromises()
}
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear(); vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  api.suppliers.mockResolvedValue([supplier(), supplier(44)])
  api.detail.mockImplementation(async id => supplier(id))
  mockSave(saved())
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); document.body.innerHTML = '' })

it('opens missing procurement at step four and focuses the exact cost field', async () => {
  const dto = supplier(77, 'FAIL')
  dto.media_workbench_v1!.draft.products[0]!.cost_rules = [
    { match: { resolution: ['1K'] }, cost: { amount: '0.1', currency: 'CNY', billing_mode: 'per_request' } },
    { match: { resolution: ['4K'] }, cost: null }
  ]
  dto.media_workbench_v1!.validation.diagnostics = [{ class: 'UI_FIXABLE', severity: 'error', code: 'MISSING_COST', scope: 'canvas-1', path: 'draft.products.0.cost_rules.1.cost', message: '4K 采购成本尚未填写', action: '前往第4步填写' }]
  api.detail.mockResolvedValue(dto)
  await mountWorkbench(); await selectAccount()
  await wrapper.get('.mw-diagnostic').trigger('click'); await flushPromises()
  expect(wrapper.get('[data-test="wizard-page-4"]').isVisible()).toBe(true)
  expect(document.activeElement).toBe(wrapper.get('[data-test="procurement-cost-1"]').element)
  expect(wrapper.get('[data-test="procurement-cost-1"]').classes()).toContain('mw-field-located')
})
it('keeps failed account sales confirmation open with its scope and old server state', async () => {
  api.sales.mockRejectedValue({ status: 422 })
  await mountWorkbench(); await selectAccount()
  const sales = wrapper.get('[data-test="sales"]')
  const modelList = wrapper.get('.mw-model-list')
  expect(!!(sales.element.compareDocumentPosition(modelList.element) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  await sales.trigger('click'); await wrapper.get('[data-test="confirm-sales"]').trigger('click'); await flushPromises()
  expect(wrapper.get('[data-test="sales-products"]').text()).toContain('画布图片')
  expect(wrapper.get('[data-test="sales-dialog-feedback"]').text()).toContain('失败或结果未确认')
  expect(wrapper.get('[data-test="confirm-sales"]').element.closest('dialog')?.open).toBe(true)
  expect(wrapper.get('[data-test="sales-state"]').text()).toContain('销售中')
})

describe('Media Workbench page flow', () => {
  it('keeps source groups collapsed by default and opens exact numeric search results', async () => {
    await mountWorkbench()
    expect(wrapper.get('[data-test="source-images.example.invalid"]').attributes('open')).toBeUndefined()
    expect(wrapper.get('[data-test="source-video.example.invalid"]').attributes('open')).toBeUndefined()
    await wrapper.get('[data-test="account-search"]').setValue('77')
    await flushPromises()
    expect(wrapper.get('[data-test="supplier-77"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="supplier-44"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="source-images.example.invalid"]').attributes('open')).toBeDefined()
  })

  it('selects an account into a model page with account context and model search', async () => {
    await mountWorkbench(); await selectAccount()
    expect(wrapper.get('[data-test="model-page"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="selected-account-summary"]').text()).toContain('#77')
    await wrapper.get('[data-test="model-search"]').setValue('new-model')
    await flushPromises()
    expect(wrapper.findAll('.mw-model-row')).toHaveLength(1)
    expect(wrapper.get('[data-test="model-new-model"]').text()).toContain('配置')
  })

  it('opens a selected model in the full-width editor page', async () => {
    await openEditor()
    expect(wrapper.get('[data-test="editor-page"]').exists()).toBe(true)
    expect(wrapper.find('.mw-columns').exists()).toBe(false)
    expect(wrapper.find('[data-test="selected-model-summary"]').text()).toContain('image-native-1')
    expect(wrapper.get('[data-test="display-name"]').exists()).toBe(true)
  })

  it('preserves model search when returning from the editor', async () => {
    await mountWorkbench(); await selectAccount()
    await wrapper.get('[data-test="model-search"]').setValue('new-model')
    await wrapper.get('[data-test="model-new-model"]').trigger('click'); await flushPromises()
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="model-page"]').exists()).toBe(true)
    expect((wrapper.get('[data-test="model-search"]').element as HTMLInputElement).value).toBe('new-model')
  })

  it('restores document scroll when returning to the model list', async () => {
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 12 })
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 })
    await openEditor()
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ left: 12, top: 420 }))
  })

  it('initializes only on the first explicit save and sends expected version zero', async () => {
    const nil = supplier(); nil.media_workbench_v1 = null; nil.effective_state = 'NOT_INITIALIZED'; nil.effective_sales = false
    api.detail.mockResolvedValue(nil)
    const response = saved(); response.media_workbench_v1!.draft.products[0]!.upstream_model = 'new-model'; response.media_workbench_v1!.draft.products[0]!.site_model = 'new-model'
    mockSave(response)
    await mountWorkbench(); await selectAccount(); await wrapper.get('[data-test="model-new-model"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="add-product-image"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.initialize).not.toHaveBeenCalled()
    expect(api.saveDraft).toHaveBeenCalledWith(77, 0, expect.arrayContaining([expect.objectContaining({ media_type: 'image', upstream_model: 'new-model' })]), [], expect.any(String))
  })

  it('shows separate save, publish, and sales actions with an explicit product publication scope', async () => {
    await openEditor()
    expect(wrapper.get('[data-test="save"]').text()).toContain('保存草稿')
    expect(wrapper.find('[data-test="publish"]').exists()).toBe(false)
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="publish"]').text()).toContain('发布配置')
    expect(wrapper.get('[data-test="sales"]').text()).toContain('暂停销售')
    await wrapper.get('[data-test="publish"]').trigger('click'); await flushPromises()
    const dialog = wrapper.find('dialog[open]')
    expect(dialog.text()).toContain('画布图片')
    expect(dialog.text()).toContain('不会自动开启销售')
  })

  it('appends image and video drafts until a wizard boundary flush without discarding or initializing early', async () => {
    const nil = supplier(); nil.media_workbench_v1 = null; nil.effective_state = 'NOT_INITIALIZED'; nil.effective_sales = false
    api.detail.mockResolvedValue(nil)
    await mountWorkbench(); await selectAccount()
    await wrapper.get('[data-test="model-new-model"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="add-product-image"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="display-name"]').setValue('保留的图片草稿')
    await wrapper.get('[data-test="new-independent-product"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="new-product-type"]').setValue('video')
    await wrapper.get('[data-test="confirm-add-product"]').trigger('click'); await flushPromises()
    expect(wrapper.find('dialog[open]').exists()).toBe(false)
    expect(api.initialize).not.toHaveBeenCalled()
    expect(api.saveDraft).not.toHaveBeenCalled()
    await wrapper.get('[data-test="display-name"]').setValue('视频草稿')
    await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
    await flushPromises()
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(api.saveDraft).toHaveBeenCalledWith(77, 0, [
      expect.objectContaining({ media_type: 'image', display_name: '保留的图片草稿', capabilities: expect.objectContaining({ count: { min: 1, max: 10 } }) }),
      expect.objectContaining({ media_type: 'video', display_name: '视频草稿', capabilities: expect.objectContaining({ count: { min: 1, max: 1 } }) })
    ], [], expect.any(String))
  })

  it('lists only published products when confirming an account-wide sales change', async () => {
    const dto = supplier()
    dto.media_workbench_v1!.draft.products[0]!.display_name = '未发布草稿'
    dto.media_workbench_v1!.published!.products![0]!.display_name = '已发布产品'
    api.suppliers.mockResolvedValue([dto]); api.detail.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="sales"]').trigger('click'); await flushPromises()
    const list = wrapper.get('[data-test="sales-products"]')
    expect(list.text()).toContain('已发布产品')
    expect(list.text()).not.toContain('未发布草稿')
  })

  it.each([
    ['NOT_YET_ENABLED', '未开启销售'], ['SALES_PAUSED', '已暂停销售'], ['SALES_OFF_UNKNOWN', '销售已关闭（历史启售状态未知）']
  ])('distinguishes initial sale state from paused state (%s)', async (state, label) => {
    const dto = supplier(); dto.effective_state = state; dto.effective_sales = false; dto.media_workbench_v1!.sales.enabled = false
    api.detail.mockResolvedValue(dto); api.suppliers.mockResolvedValue([dto])
    await openEditor()
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="sales-state"]').text()).toContain(label)
  })

  it('keeps the selected model and product after reloading the editor', async () => {
    const dto = supplier()
    const second = JSON.parse(JSON.stringify(dto.media_workbench_v1!.draft.products[0]))
    second.product_id = 'canvas-2'; second.display_name = '第二已配置产品'
    dto.media_workbench_v1!.draft.products.push(second)
    dto.media_workbench_v1!.published!.products!.push(JSON.parse(JSON.stringify(second)))
    api.suppliers.mockResolvedValue([dto]); api.detail.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('[data-test="product-select"]').setValue('canvas-2')
    await wrapper.get('[data-test="display-name"]').setValue('本地修改')
    api.saveDraft.mockRejectedValue({ status: 409 })
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="discard-reload"]').trigger('click')
    await wrapper.get('[data-test="confirm-reload"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="editor-page"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="selected-model-summary"]').text()).toContain('image-native-1')
    expect((wrapper.get('[data-test="product-select"]').element as HTMLSelectElement).value).toBe('canvas-2')
  })

  it('keeps product identity and collection stable while changing independent execution limits', async () => {
    const dto = supplier()
    const blank = JSON.parse(JSON.stringify(dto.media_workbench_v1!.draft.products[0]))
    blank.product_id = 'canvas-blank'
    blank.display_name = ''
    blank.pricing_rules = []
    dto.media_workbench_v1!.draft.products.push(blank)
    dto.media_workbench_v1!.published!.products!.push(JSON.parse(JSON.stringify(blank)))
    api.suppliers.mockResolvedValue([dto]); api.detail.mockResolvedValue(dto)
    const response = JSON.parse(JSON.stringify(dto))
    response.media_workbench_v1.record_version = 4
    response.media_workbench_v1.draft.revision = 'mwd_b'
    response.media_workbench_v1.validation.draft_revision = 'mwd_b'
    mockSave(response)

    await openEditor()
    const trace: Array<{ step: string; productCount: number; ids: string[]; selected: string }> = []
    const record = (step: string) => {
      const select = wrapper.get('[data-test="product-select"]')
      const options = select.findAll('option')
      trace.push({
        step,
        productCount: options.length,
        ids: options.map(option => (option.element as HTMLOptionElement).value).sort(),
        selected: (select.element as HTMLSelectElement).value
      })
    }
    record('initial configured + blank')
    await wrapper.get('[data-test="product-select"]').setValue('canvas-blank')
    await flushPromises()
    record('select blank')
    await wrapper.get('[data-test="product-select"]').setValue('canvas-1')
    await flushPromises()
    record('select configured')
    await wrapper.get('[data-test="image-execution-mode"]').setValue('native_multi')
    await wrapper.get('[data-test="image-execution-max"]').setValue(10)
    await flushPromises()
    record('text 10')
    await wrapper.get('[data-test="image-edit-execution-mode"]').setValue('native_multi')
    await wrapper.get('[data-test="image-edit-execution-max"]').setValue(1)
    await flushPromises()
    record('edit 1')
    await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    const body = api.saveDraft.mock.calls[0]![2] as Array<{ product_id: string; adapter_config: { execution?: unknown; edit_execution?: unknown } }>
    expect(body.map(product => product.product_id).sort()).toEqual(['canvas-1', 'canvas-blank'])
    expect(body).toHaveLength(2)
    expect(trace).toEqual([
      { step: 'initial configured + blank', productCount: 2, ids: ['canvas-1', 'canvas-blank'], selected: 'canvas-1' },
      { step: 'select blank', productCount: 2, ids: ['canvas-1', 'canvas-blank'], selected: 'canvas-blank' },
      { step: 'select configured', productCount: 2, ids: ['canvas-1', 'canvas-blank'], selected: 'canvas-1' },
      { step: 'text 10', productCount: 2, ids: ['canvas-1', 'canvas-blank'], selected: 'canvas-1' },
      { step: 'edit 1', productCount: 2, ids: ['canvas-1', 'canvas-blank'], selected: 'canvas-1' }
    ])
    expect(body.find(product => product.product_id === 'canvas-1')?.adapter_config.execution).toEqual({ mode: 'native_multi', max_output_images: 10 })
    expect(body.find(product => product.product_id === 'canvas-1')?.adapter_config.edit_execution).toEqual({ mode: 'native_multi', max_output_images: 1 })
    expect(body.find(product => product.product_id === 'canvas-blank')?.adapter_config.execution).toBeUndefined()
  })

  it('keeps a single product when independent execution limits are edited and saved', async () => {
    await openEditor()
    expect(wrapper.find('[data-test="product-select"]').exists()).toBe(false)
    await wrapper.get('[data-test="image-execution-mode"]').setValue('native_multi')
    await wrapper.get('[data-test="image-execution-max"]').setValue(2)
    await wrapper.get('[data-test="image-edit-execution-mode"]').setValue('native_multi')
    await wrapper.get('[data-test="image-edit-execution-max"]').setValue(1)
    await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    const body = api.saveDraft.mock.calls[0]![2] as Array<{ product_id: string; adapter_config: { execution?: unknown; edit_execution?: unknown } }>
    expect(body).toHaveLength(1)
    expect(body[0]?.product_id).toBe('canvas-1')
    expect(body[0]?.adapter_config.execution).toEqual({ mode: 'native_multi', max_output_images: 2 })
    expect(body[0]?.adapter_config.edit_execution).toEqual({ mode: 'native_multi', max_output_images: 1 })
  })

  it('keeps internal product identities out of model and product selection UI', async () => {
    const dto = supplier()
    const second = JSON.parse(JSON.stringify(dto.media_workbench_v1!.draft.products[0]))
    second.product_id = 'media-290f101c-internal'
    second.display_name = '高清商品 · media-290f101c-internal'
    dto.media_workbench_v1!.draft.products.push(second)
    api.suppliers.mockResolvedValue([dto]); api.detail.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="model-image-native-1"]').text()).not.toContain('media-290f101c-internal')
    await wrapper.get('[data-test="model-image-native-1"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="product-select"]').text()).not.toContain('media-290f101c-internal')
  })

  it('distinguishes identical product names with readable business details and stable ordinals', async () => {
    const dto = supplier()
    const second = JSON.parse(JSON.stringify(dto.media_workbench_v1!.draft.products[0]))
    second.product_id = 'media-second-internal'
    dto.media_workbench_v1!.draft.products.push(second)
    api.suppliers.mockResolvedValue([dto]); api.detail.mockResolvedValue(dto)
    await openEditor()
    const options = wrapper.get('[data-test="product-select"]').findAll('option').map(option => option.text())
    expect(options[0]).toContain('画布图片')
    expect(options[0]).toContain('规格 1K/4K · 1:1/16:9')
    expect(options[0]).toContain('CNY 0.18')
    expect(options[0]).toContain('商品 1')
    expect(options[1]).toContain('商品 2')
    expect(options[0]).not.toContain('media-')
    expect(options[1]).not.toContain('media-')
  })

  it('keeps dirty navigation protected inside the page flow', async () => {
    await openEditor(); await wrapper.get('[data-test="display-name"]').setValue('本地修改')
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    expect(wrapper.find('dialog[open]').text()).toContain('有未保存修改')
    await wrapper.get('[data-test="discard-navigate"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="model-page"]').exists()).toBe(true)
  })

  it('requires a decision before changing products with unsaved edits', async () => {
    const dto = supplier()
    const second = JSON.parse(JSON.stringify(dto.media_workbench_v1!.draft.products[0]))
    second.product_id = 'canvas-2'; second.display_name = '第二商品'
    dto.media_workbench_v1!.draft.products.push(second)
    api.detail.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('[data-test="display-name"]').setValue('尚未保存')
    await wrapper.get('[data-test="product-select"]').setValue('canvas-2'); await flushPromises()
    expect(wrapper.get('dialog[open]').text()).toContain('有未保存修改')
    expect(wrapper.get('[data-test="product-select"]').element).toHaveProperty('value', 'canvas-1')
    expect(wrapper.get('[data-test="display-name"]').element).toHaveProperty('value', '尚未保存')
    expect(api.saveDraft).not.toHaveBeenCalled()
    await wrapper.get('[data-test="discard-navigate"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="product-select"]').element).toHaveProperty('value', 'canvas-2')
    expect(wrapper.get('[data-test="display-name"]').element).toHaveProperty('value', '第二商品')
  })

  it.each(['qualities', 'combination_rules'])('opens the target technical details itself for a %s diagnostic', async (field) => {
    const dto = supplier(77, 'FAIL')
    dto.media_workbench_v1!.validation.diagnostics[0]!.path = `draft.products[0].capabilities.${field}`
    api.detail.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
    await wrapper.get('.mw-diagnostic').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="advanced-technical"]').attributes('open')).toBeDefined()
    expect(wrapper.get(`[data-field="capabilities.${field}"]`).attributes('open')).toBeDefined()
    expect(wrapper.get(`[data-field="capabilities.${field}"]`).element.contains(document.activeElement)).toBe(true)
  })

  it.each(['image', 'video'])('labels missing prices with their actual %s product and locates it without changing prices', async mediaType => {
    const dto = supplier(77, 'FAIL')
    const first = dto.media_workbench_v1!.draft.products[0]!
    first.media_type = mediaType
    if (mediaType === 'video') { first.capabilities.durations_seconds = [5]; first.capabilities.count = { min: 1, max: 1 } }
    first.display_name = '已配置商品'
    const blank = JSON.parse(JSON.stringify(first))
    blank.product_id = 'media-blank-private'
    blank.display_name = '待配置商品'
    blank.pricing_rules = []
    dto.media_workbench_v1!.draft.products.push(blank)
    dto.media_workbench_v1!.validation.diagnostics = [{
      class: 'UI_FIXABLE', severity: 'error', code: 'MISSING_PRICE', scope: blank.product_id,
      path: 'pricing_rules', message: 'Some allowed specifications have no sale price', action: '填写缺少的单价',
      specs: [{ resolution: '4K', aspect_ratio: '16:9', quality: '', duration_seconds: mediaType === 'video' ? 5 : 0, count: 1, images: 0, videos: 0, audio: 0 }], spec_count: 1
    }]
    api.detail.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
    expect(wrapper.get('[data-test="diagnostic-product"]').text()).toContain('待配置商品')
    expect(wrapper.get('[data-test="diagnostic-product"]').text()).not.toContain('media-blank-private')
    expect(wrapper.get('[data-test="diagnostic-spec"]').text()).toContain('4K · 16:9')
    await wrapper.get('.mw-diagnostic').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="product-select"]').element).toHaveProperty('value', blank.product_id)
    expect(wrapper.get('[data-test="wizard-page-4"]').isVisible()).toBe(true)
    const priceSelector = mediaType === 'video' ? '[data-test="video-sale-5"]' : '[data-test="price-0"]'
    expect(wrapper.get(priceSelector).element).toHaveProperty('value', '')
    await wrapper.get('[data-test="product-select"]').setValue(first.product_id); await flushPromises()
    await wrapper.get('[data-test="wizard-step-4"]').trigger('click')
    expect(wrapper.get(priceSelector).element).toHaveProperty('value', '0.18')
    expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('locates an edit count diagnostic at the edit numeric input', async () => {
    const dto = supplier(77, 'FAIL')
    dto.media_workbench_v1!.draft.products[0]!.adapter_config.edit_execution = { mode: 'native_multi', max_output_images: 1 }
    Object.assign(dto.media_workbench_v1!.validation.diagnostics[0]!, {
      code: 'IMAGE_EDIT_EXECUTION_CAPABILITY_INVALID', scope: 'canvas-1', path: 'adapter_config.edit_execution.max_output_images'
    })
    api.detail.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
    await wrapper.get('.mw-diagnostic').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="advanced-technical"]').attributes('open')).toBeDefined()
    expect(wrapper.get('[data-test="image-execution-advanced"]').attributes('open')).toBeDefined()
    expect(document.activeElement).toBe(wrapper.get('[data-test="image-edit-execution-max"]').element)
    expect(wrapper.get('[data-test="adapter-status"]').text()).not.toContain('尚未接通')
  })

  it.each([
    ['INVALID_REFERENCE_LIMIT', 100, 2],
    ['VIDEO_REFERENCES_UNSUPPORTED', 4, 2],
    ['INVALID_REFERENCE_LIMIT', 4, 1]
  ] as const)('locates broad %s diagnostics using the actual reference error (%s)', async (code, max, step) => {
    const dto = supplier(77, 'FAIL')
    dto.media_workbench_v1!.draft.products[0]!.capabilities.references.image.max = max
    Object.assign(dto.media_workbench_v1!.validation.diagnostics[0]!, { code, path: 'capabilities', scope: 'canvas-1' })
    api.detail.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
    await wrapper.get('.mw-diagnostic').trigger('click'); await flushPromises()
    expect(wrapper.get(`[data-test="wizard-page-${step}"]`).isVisible()).toBe(true)
    expect(wrapper.get(`[data-test="wizard-page-${step}"]`).element.contains(document.activeElement)).toBe(true)
  })

  it('allows route navigation after explicitly saving dirty changes', async () => {
    await openEditor(); await wrapper.get('[data-test="display-name"]').setValue('保存后离开')
    const leaving = router.push('/admin/accounts'); await flushPromises()
    expect(wrapper.find('dialog[open]').text()).toContain('有未保存修改')
    await wrapper.get('[data-test="save-navigate"]').trigger('click'); await flushPromises(); await leaving
    expect(router.currentRoute.value.path).toBe('/admin/accounts')
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
  })
})


describe('Media Workbench product and model lifecycle', () => {
  it('confirms only the selected product and never publishes other drafts', async () => {
    const dto = supplier()
    const first = dto.media_workbench_v1!.draft.products[0]!
    const second = structuredClone(first); second.product_id = 'second-product'; second.display_name = '第二份独立商品'
    dto.media_workbench_v1!.draft.products.push(second)
    api.detail.mockResolvedValue(dto); api.lifecycle.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('[data-test="product-select"]').setValue(second.product_id)
    await wrapper.get('[data-test="product-unlist"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="lifecycle-products"]').text()).toContain('第二份独立商品')
    expect(wrapper.get('[data-test="lifecycle-products"]').text()).not.toContain(first.display_name)
    expect(wrapper.get('[data-test="lifecycle-products"]').text()).not.toContain(second.product_id)
    await wrapper.get('[data-test="confirm-lifecycle"]').trigger('click'); await flushPromises()
    expect(api.lifecycle).toHaveBeenCalledWith(77, 3, 'unlist', { product_id: second.product_id })
    expect(api.publish).not.toHaveBeenCalled(); expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('lists all model products in the bulk confirmation, including archived and published-only entries', async () => {
    const dto = supplier(); const c = dto.media_workbench_v1!
    const archived = structuredClone(c.draft.products[0]!); archived.product_id = 'archived'; archived.display_name = '已归档独立商品'
    const publishedOnly = structuredClone(archived); publishedOnly.product_id = 'published-only'; publishedOnly.display_name = '仅发布商品'
    c.draft.products.push(archived); c.published!.products!.push(publishedOnly)
    c.product_lifecycle = { archived: { state: 'archived', revision: 1, updated_at: '' } }
    api.detail.mockResolvedValue(dto); api.lifecycle.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('[data-test="model-unlist"]').trigger('click'); await flushPromises()
    const list = wrapper.get('[data-test="lifecycle-products"]')
    expect(list.findAll('li')).toHaveLength(3)
    expect(list.text()).toContain('已归档独立商品'); expect(list.text()).toContain('仅发布商品')
    await wrapper.get('[data-test="confirm-lifecycle"]').trigger('click'); await flushPromises()
    expect(api.lifecycle).toHaveBeenCalledWith(77, 3, 'unlist', { model_id: 'image-native-1' })
  })

  it('disables lifecycle actions while edits are unsaved and requires unlisting before archive', async () => {
    await openEditor()
    expect(wrapper.get('[data-test="product-archive"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="model-archive"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-test="display-name"]').setValue('未保存的名称')
    expect(wrapper.get('[data-test="product-unlist"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="model-unlist"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="lifecycle-dirty"]').text()).toContain('先保存或放弃')
    expect(api.lifecycle).not.toHaveBeenCalled(); expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('filters archived products only for display and retains them in a later draft save', async () => {
    const dto = supplier(); const c = dto.media_workbench_v1!
    const archived = structuredClone(c.draft.products[0]!); archived.product_id = 'archived'; archived.display_name = '归档保留'
    c.draft.products.push(archived); c.product_lifecycle = { archived: { state: 'archived', revision: 1, updated_at: '' } }
    api.detail.mockResolvedValue(dto)
    await openEditor()
    expect(wrapper.find('[data-test="product-select"]').exists()).toBe(false)
    await wrapper.get('[data-test="show-archived-products"]').setValue(true)
    await wrapper.get('[data-test="product-select"]').setValue('archived')
    expect(wrapper.get('[data-test="product-status"]').text()).toContain('已归档')
    expect(wrapper.get('[data-test="product-restore"]').text()).toContain('已下架')
    await wrapper.get('[data-test="show-archived-products"]').setValue(false)
    await wrapper.get('[data-test="display-name"]').setValue('活动商品修改')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft.mock.calls[0]![2]).toHaveLength(2)
    expect(api.saveDraft.mock.calls[0]![2][1]!.product_id).toBe('archived')
  })

  it('hides archived models by default and restores hidden unconfigured models without syncing native catalog', async () => {
    const dto = supplier(); dto.models.find(m => m.model_id === 'new-model')!.state = 'ARCHIVED'
    dto.media_workbench_v1!.hidden_models = ['new-model']
    api.detail.mockResolvedValue(dto); api.lifecycle.mockResolvedValue(dto)
    await mountWorkbench(); await selectAccount()
    expect(wrapper.find('[data-test="model-new-model"]').exists()).toBe(false)
    await wrapper.get('[data-test="show-archived-models"]').setValue(true)
    expect(wrapper.get('[data-test="model-new-model"]').text()).toContain('已归档')
    await wrapper.get('[data-test="model-new-model"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="model-hide-restore"]').trigger('click'); await flushPromises()
    expect(wrapper.find('dialog[open]').text()).toContain('保留上游模型目录')
    await wrapper.get('[data-test="confirm-lifecycle"]').trigger('click'); await flushPromises()
    expect(api.lifecycle).toHaveBeenCalledWith(77, 3, 'restore', { model_id: 'new-model' })
    expect(api.sync).not.toHaveBeenCalled()
  })

  it('offers independent lifecycle management for published-only products', async () => {
    const dto = supplier(); const p = structuredClone(dto.media_workbench_v1!.published!.products![0]!)
    p.product_id = 'published-only'; p.display_name = '仅发布商品'
    dto.media_workbench_v1!.published!.products!.push(p)
    api.detail.mockResolvedValue(dto); api.lifecycle.mockResolvedValue(dto)
    await openEditor()
    await wrapper.get('[data-test="published-unlist-published-only"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="lifecycle-products"]').findAll('li')).toHaveLength(1)
    await wrapper.get('[data-test="confirm-lifecycle"]').trigger('click'); await flushPromises()
    expect(api.lifecycle).toHaveBeenCalledWith(77, 3, 'unlist', { product_id: 'published-only' })
    expect(api.saveDraft).not.toHaveBeenCalled()
  })
})


it('restores an archived product as unlisted without automatically relisting', async () => {
  const dto = supplier(); const id = dto.media_workbench_v1!.draft.products[0]!.product_id
  dto.models[0]!.state = 'ARCHIVED'
  dto.media_workbench_v1!.product_lifecycle = { [id]: { state: 'archived', revision: 1, updated_at: '' } }
  const restored = structuredClone(dto)
  restored.models[0]!.state = 'UNLISTED'; restored.media_workbench_v1!.record_version = 4
  restored.media_workbench_v1!.product_lifecycle![id]!.state = 'unlisted'
  api.detail.mockResolvedValue(dto); api.lifecycle.mockResolvedValue(restored)
  await mountWorkbench(); await selectAccount()
  await wrapper.get('[data-test="show-archived-models"]').setValue(true)
  await wrapper.get('[data-test="model-image-native-1"]').trigger('click'); await flushPromises()
  await wrapper.get('[data-test="product-restore"]').trigger('click'); await flushPromises()
  expect(wrapper.find('dialog[open]').text()).toContain('不会自动重新上架')
  await wrapper.get('[data-test="confirm-lifecycle"]').trigger('click'); await flushPromises()
  expect(api.lifecycle).toHaveBeenCalledTimes(1)
  expect(api.lifecycle).toHaveBeenCalledWith(77, 3, 'restore', { product_id: id })
  expect(wrapper.get('[data-test="product-status"]').text()).toContain('已下架')
  expect(wrapper.get('[data-test="product-relist"]').exists()).toBe(true)
  expect(api.publish).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
})

it('shows both Draft and Published model identities and blocks ambiguous bulk action', async () => {
  const dto = supplier(); const c = dto.media_workbench_v1!
  c.draft.products[0]!.upstream_model = 'new-model'
  api.detail.mockResolvedValue(dto); api.lifecycle.mockResolvedValue(dto)
  await mountWorkbench(); await selectAccount()
  await wrapper.get('[data-test="model-image-native-1"]').trigger('click'); await flushPromises()
  await wrapper.get('[data-test="model-unlist"]').trigger('click'); await flushPromises()
  expect(wrapper.find('dialog[open]').text()).toContain('草稿与已发布商品使用不同模型')
  expect(wrapper.get('[data-test="confirm-lifecycle"]').attributes('disabled')).toBeDefined()
  expect(api.lifecycle).not.toHaveBeenCalled()
})


describe('Per-product readiness and explicit publication',()=>{
 it('associates real reasons with separate product identities on the same model without exposing internal IDs',async()=>{
  const dto=supplier();const first=dto.media_workbench_v1!.draft.products[0]!
  const second=structuredClone(first);second.product_id='private-product-b';second.display_name='Banana 独立商品'
  dto.media_workbench_v1!.draft.products.push(second);dto.effective_state='PUBLISHED_NOT_READY'
  dto.product_states=[
   {product_id:first.product_id,display_name:'画布图片',upstream_model:first.upstream_model,media_type:'image',published:true,published_ready:true,state:'READY',reason:'此商品已发布配置与账号销售已就绪。',action:'仍需核验全局开关与客户原生权限。'},
   {product_id:second.product_id,display_name:second.display_name,upstream_model:second.upstream_model,media_type:'image',published:true,published_ready:false,state:'PUBLISHED_INVALID',reason:'此商品已发布的价格无效。',action:'修复此商品价格后，明确选择此商品重新发布。'}]
  api.detail.mockResolvedValue(dto)
  await mountWorkbench();await selectAccount()
  expect(wrapper.text()).toContain('已发布配置当前不可售');expect(wrapper.text()).not.toContain('发布未就绪')
  const row=wrapper.get('[data-test="readiness-private-product-b"]')
  expect(row.text()).toContain('Account #77 · Banana 独立商品');expect(row.text()).toContain('已发布的价格无效')
  expect(row.text()).not.toContain('private-product-b')
  expect(wrapper.get('[data-test="publication-layers"]').text()).toContain('通过（仅草稿）')
  expect(wrapper.get('[data-test="publication-layers"]').text()).toContain('全局付费开关和客户原生权限仍分别生效')
  await row.get('button').trigger('click');await flushPromises()
  expect(wrapper.get('[data-test="selected-product-readiness"]').text()).toContain('Banana 独立商品')
  expect(wrapper.get('[data-test="selected-product-readiness"]').text()).toContain('价格无效')
  expect(api.publish).not.toHaveBeenCalled();expect(api.sync).not.toHaveBeenCalled()
 })
 it('defaults publication only to the selected product while another incomplete draft remains unselected',async()=>{
  const dto=supplier(77,'FAIL');const c=dto.media_workbench_v1!
  const banana=structuredClone(c.draft.products[0]!);banana.product_id='banana-draft';banana.display_name='Banana 未完成草稿';banana.upstream_model='banana-image';banana.pricing_rules=[]
  c.draft.products.push(banana);dto.models.push({model_id:'banana-image',state:'DRAFT'})
  api.detail.mockResolvedValue(dto);api.publish.mockResolvedValue(dto)
  await openEditor();await wrapper.get('.mw-back').trigger('click');await flushPromises()
  await wrapper.get('[data-test="model-search"]').setValue('image-native-1')
  expect(wrapper.get('[data-test="publish"]').attributes('disabled')).toBeUndefined()
  await wrapper.get('[data-test="publish"]').trigger('click');await flushPromises()
  expect(wrapper.get('[data-test="publish-products"]').text()).toContain('Banana 未完成草稿')
  expect(wrapper.get('[data-test="publish-product-canvas-1"]').element).toHaveProperty('checked',true)
  expect(wrapper.get('[data-test="publish-product-banana-draft"]').element).toHaveProperty('checked',false)
  expect(wrapper.get('[data-test="publish-scope"]').text()).toContain('仅发布本次勾选的 1 份商品')
  await wrapper.get('[data-test="confirm-publish"]').trigger('click');await flushPromises()
  expect(api.publish).toHaveBeenCalledWith(77,3,'mwd_a',['canvas-1'])
  expect(api.saveDraft).not.toHaveBeenCalled();expect(api.sales).not.toHaveBeenCalled()
 })
 it('requires explicit checking when no current product is selected and permits independent multi-selection',async()=>{
  const dto=supplier();const extra=structuredClone(dto.media_workbench_v1!.draft.products[0]!);extra.product_id='second';extra.display_name='第二商品';dto.media_workbench_v1!.draft.products.push(extra)
  api.detail.mockResolvedValue(dto);api.publish.mockResolvedValue(dto)
  await mountWorkbench();await selectAccount();await wrapper.get('[data-test="publish"]').trigger('click');await flushPromises()
  expect(wrapper.get('[data-test="confirm-publish"]').attributes('disabled')).toBeDefined()
  await wrapper.get('[data-test="publish-product-canvas-1"]').setValue(true)
  await wrapper.get('[data-test="publish-product-second"]').setValue(true)
  await wrapper.get('[data-test="confirm-publish"]').trigger('click');await flushPromises()
  expect(api.publish).toHaveBeenCalledWith(77,3,'mwd_a',['canvas-1','second'])
 })
 it('shows selected publish diagnostics in the confirmation without masking them with another Draft failure',async()=>{
  const dto=supplier(77,'FAIL')
  dto.publish_validation={...dto.media_workbench_v1!.validation,diagnostics:[{...dto.media_workbench_v1!.validation.diagnostics[0]!,scope:'canvas-1',message:'本次商品报价存在冲突',action:'请修复当前商品的重复价格。'}]}
  api.publish.mockRejectedValue({status:422,data:dto})
  await openEditor();await wrapper.get('.mw-back').trigger('click');await flushPromises()
  await wrapper.get('[data-test="publish"]').trigger('click');await wrapper.get('[data-test="confirm-publish"]').trigger('click');await flushPromises()
  const feedback=wrapper.get('[data-test="publish-validation"]')
  expect(feedback.text()).toContain('本次商品报价存在冲突');expect(feedback.text()).toContain('修复当前商品的重复价格')
  expect(feedback.text()).not.toContain('4K 条件缺少售价');expect(feedback.text()).not.toContain('canvas-1')
  expect(wrapper.get('[data-test="confirm-publish"]').attributes('disabled')).toBeUndefined()
  expect(wrapper.find('dialog[open]').exists()).toBe(true)
 })
 it('does not infer product readiness from Draft PASS when per-product evidence is absent',async()=>{
  await mountWorkbench();await selectAccount()
  expect(wrapper.get('[data-test="product-readiness-list"]').text()).toContain('后台尚未返回逐商品状态')
  expect(wrapper.get('[data-test="native-api-boundary"]').text()).toContain('不修改独立 API Key 的原生权限或路由')
  expect(wrapper.get('[data-test="native-api-boundary"]').text()).toContain('受保护的图片任务接口')
 })
})


describe('confirmed draft save time and human publication feedback', () => {
  const initialSavedAt = new Date(2026, 9, 20, 9, 8, 47).toISOString()
  const latestSavedAt = new Date(2026, 9, 20, 10, 15, 59).toISOString()
  function serverDraft(updatedAt = initialSavedAt) {
    const dto = supplier()
    dto.media_workbench_v1!.draft.updated_at = updatedAt
    return dto
  }

  it('shows the confirmed draft time beside publication and sales actions while keeping revisions internal', async () => {
    const dto = serverDraft()
    dto.media_workbench_v1!.draft.revision = `mwd_${'a'.repeat(64)}`
    dto.media_workbench_v1!.validation.draft_revision = dto.media_workbench_v1!.draft.revision
    dto.media_workbench_v1!.published!.revision = `mwp_${'b'.repeat(64)}`
    api.detail.mockResolvedValue(dto)
    await mountWorkbench(); await selectAccount()
    const actions = wrapper.get('[data-test="account-publication"]')
    expect(actions.text()).toContain('草稿最近保存：2026-10-20 09:08')
    expect(actions.get('[data-test="publish"]').exists()).toBe(true)
    expect(actions.get('[data-test="sales"]').exists()).toBe(true)
    expect(wrapper.text()).not.toContain(dto.media_workbench_v1!.published!.revision)
    await wrapper.get('[data-test="model-image-native-1"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toBe('草稿最近保存：2026-10-20 09:08')
    expect(wrapper.text()).not.toContain(dto.media_workbench_v1!.draft.revision)
  })

  it('updates the time only after matching server readback and keeps the previous time while saving', async () => {
    api.detail.mockResolvedValue(serverDraft())
    await openEditor()
    await wrapper.get('[data-test="display-name"]').setValue('待确认的草稿名称')
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toContain('2026-10-20 09:08')
    let written!: ReturnType<typeof saved>
    let confirm!: (value: ReturnType<typeof saved>) => void
    const readback = new Promise<ReturnType<typeof saved>>(resolve => { confirm = resolve })
    api.saveDraft.mockImplementationOnce(async (_id, version, products, _removed, submissionId) => {
      const dto = saved()
      dto.media_workbench_v1!.draft.updated_at = new Date(2026, 9, 20, 10, 14).toISOString()
      dto.media_workbench_v1!.draft.revision = `mwd_${'c'.repeat(64)}`
      dto.media_workbench_v1!.validation.draft_revision = dto.media_workbench_v1!.draft.revision
      written = acknowledgement(dto, version, products, submissionId)
      return written
    })
    api.detail.mockImplementationOnce(() => readback)
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="autosave-status"]').text()).toContain('保存中')
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toContain('2026-10-20 09:08')
    const confirmed = copy(written)
    confirmed.media_workbench_v1!.draft.updated_at = latestSavedAt
    confirm(confirmed); await flushPromises()
    expect(wrapper.get('[data-test="autosave-status"]').text()).toContain('已确认保存')
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toBe('草稿最近保存：2026-10-20 10:15')
    expect(wrapper.get('[data-test="save-feedback"]').text()).not.toContain(confirmed.media_workbench_v1!.draft.revision)
  })

  it.each([
    [422, '保存失败'], [0, '保存结果待核对']
  ])('retains the last confirmed time after a failed or ambiguous save (%s)', async (status, label) => {
    api.detail.mockResolvedValue(serverDraft())
    await openEditor()
    api.saveDraft.mockRejectedValueOnce({ status })
    await wrapper.get('[data-test="display-name"]').setValue('保留的本地输入')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="autosave-status"]').text()).toContain(label)
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toBe('草稿最近保存：2026-10-20 09:08')
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('保留的本地输入')
  })

  it('does not adopt a later timestamp from an unconfirmed write or mismatching readback', async () => {
    api.detail.mockResolvedValue(serverDraft())
    await openEditor()
    const unconfirmed = saved()
    unconfirmed.media_workbench_v1!.draft.updated_at = latestSavedAt
    api.saveDraft.mockResolvedValueOnce(unconfirmed)
    api.detail.mockResolvedValueOnce(unconfirmed)
    await wrapper.get('[data-test="display-name"]').setValue('回执不匹配的输入')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="autosave-status"]').text()).toContain('保存结果待核对')
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toBe('草稿最近保存：2026-10-20 09:08')
  })

  it.each(['', 'invalid-server-time', '0001-01-01T00:00:00Z'])('shows no invented time when the server save time is unknown (%s)', async updatedAt => {
    api.detail.mockResolvedValue(serverDraft(updatedAt))
    const response = saved()
    response.media_workbench_v1!.draft.updated_at = updatedAt
    mockSave(response)
    await openEditor()
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toBe('草稿最近保存：尚未保存')
    await wrapper.get('[data-test="display-name"]').setValue('服务端时间仍未知')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="autosave-status"]').text()).toContain('已确认保存')
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toBe('草稿最近保存：尚未保存')
  })

  it('shows not yet saved before an Account has a server draft', async () => {
    const dto = supplier()
    dto.media_workbench_v1 = null
    api.detail.mockResolvedValue(dto)
    await mountWorkbench(); await selectAccount()
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toBe('草稿最近保存：尚未保存')
    expect(wrapper.get('[data-test="publication-layers"]').text()).toContain('尚未建立')
  })

  it('reports a confirmed publication without a hash and leaves Account sales separate', async () => {
    const dto = serverDraft()
    dto.media_workbench_v1!.sales.enabled = false; dto.effective_sales = false; dto.effective_state = 'SALES_PAUSED'
    api.detail.mockResolvedValue(dto)
    const published = copy(dto)
    published.media_workbench_v1!.record_version++
    published.media_workbench_v1!.published!.revision = `mwp_${'d'.repeat(64)}`
    api.publish.mockResolvedValue(published)
    await openEditor(); await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="publish"]').trigger('click')
    await wrapper.get('[data-test="confirm-publish"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="publication-feedback"]').text()).toBe('配置已发布。Account 销售尚未开启，请在账号操作区开启。')
    expect(wrapper.text()).not.toContain(published.media_workbench_v1!.published!.revision)
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toBe('草稿最近保存：2026-10-20 09:08')
    expect(wrapper.get('[data-test="sales-state"]').text()).toContain('已暂停销售')
    expect(api.publish).toHaveBeenCalledWith(77, 3, 'mwd_a', ['canvas-1'])
    expect(api.sales).not.toHaveBeenCalled()
  })

  it('keeps a reconciled publication revision internal after an ambiguous response', async () => {
    const dto = serverDraft()
    dto.media_workbench_v1!.sales.enabled = false; dto.effective_sales = false; dto.effective_state = 'SALES_PAUSED'
    api.detail.mockResolvedValue(dto)
    await openEditor(); await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    const confirmed = copy(dto)
    confirmed.media_workbench_v1!.record_version++
    confirmed.media_workbench_v1!.published!.revision = `mwp_${'e'.repeat(64)}`
    api.publish.mockRejectedValueOnce({ status: 0 })
    api.detail.mockResolvedValueOnce(confirmed)
    await wrapper.get('[data-test="publish"]').trigger('click')
    await wrapper.get('[data-test="confirm-publish"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="publication-feedback"]').text()).toBe('配置已发布（已重新读取核对）。Account 销售尚未开启，请在账号操作区开启。')
    expect(wrapper.text()).not.toContain(confirmed.media_workbench_v1!.published!.revision)
    expect(wrapper.get('[data-test="draft-save-time"]').text()).toBe('草稿最近保存：2026-10-20 09:08')
    expect(api.publish).toHaveBeenCalledTimes(1)
    expect(api.sales).not.toHaveBeenCalled()
  })
})

describe('video sale buffers at workbench save and navigation boundaries', () => {
  function videoSupplier() {
    const dto = supplier()
    const product = dto.media_workbench_v1!.draft.products[0]!
    product.media_type = 'video'
    product.capabilities.resolutions = ['720p']
    product.capabilities.aspect_ratios = ['16:9']
    product.capabilities.durations_seconds = [5, 10]
    product.capabilities.references = { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }
    dto.media_workbench_v1!.published!.products = [copy(product)]
    return dto
  }

  it('applies the current video input before an explicit server save', async () => {
    const dto = videoSupplier()
    api.detail.mockResolvedValue(dto); mockSave(dto)
    await openEditor()
    await wrapper.get('[data-test="wizard-step-4"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="video-sale-5"]').setValue('12.50')
    expect(api.saveDraft).not.toHaveBeenCalled()
    expect(wrapper.get('[data-test="pending-video-sales"]').text()).toContain('尚未应用草稿')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(api.saveDraft.mock.calls[0]![2][0]!.pricing_rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ match: expect.objectContaining({ duration_seconds: [5] }), sale_price: expect.objectContaining({ amount: '12.50' }) })
    ]))
    expect(wrapper.find('[data-test="pending-video-sales"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="autosave-status"]').text()).toContain('已确认保存')
  })

  it('retains invalid video text on navigation and saves corrected text before leaving', async () => {
    const dto = videoSupplier()
    api.detail.mockResolvedValue(dto); mockSave(dto)
    await openEditor()
    await wrapper.get('[data-test="wizard-step-4"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="video-sale-5"]').setValue('0')
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="editor-page"]').exists()).toBe(true)
    expect((wrapper.get('[data-test="video-sale-5"]').element as HTMLInputElement).value).toBe('0')
    expect(wrapper.find('dialog[open]').exists()).toBe(false)
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft).not.toHaveBeenCalled()
    await wrapper.get('[data-test="video-sale-5"]').setValue('12.50')
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    expect(wrapper.find('dialog[open]').text()).toContain('有未保存修改')
    await wrapper.get('[data-test="save-navigate"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="model-page"]').exists()).toBe(true)
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(api.saveDraft.mock.calls[0]![2][0]!.pricing_rules.some(rule => rule.sale_price?.amount === '12.50')).toBe(true)
  })

  it('keeps incomplete video text on the original product before adding and consumes repeated confirmation once', async () => {
    const dto = videoSupplier()
    api.detail.mockResolvedValue(dto); mockSave(dto)
    await openEditor()
    await wrapper.get('[data-test="wizard-step-4"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="video-sale-5"]').setValue('12.')
    await wrapper.get('[data-test="new-independent-product"]').trigger('click')
    let confirm = wrapper.get('[data-test="confirm-add-product"]').element as HTMLButtonElement
    confirm.click(); confirm.click(); await flushPromises()
    expect(wrapper.find('[data-test="product-select"]').exists()).toBe(false)
    expect((wrapper.get('[data-test="video-sale-5"]').element as HTMLInputElement).value).toBe('12.')
    expect(api.saveDraft).not.toHaveBeenCalled()
    await wrapper.get('[data-test="video-sale-5"]').setValue('12.50')
    await wrapper.get('[data-test="new-independent-product"]').trigger('click')
    confirm = wrapper.get('[data-test="confirm-add-product"]').element as HTMLButtonElement
    confirm.click(); confirm.click(); await flushPromises()
    expect(wrapper.get('[data-test="product-select"]').findAll('option')).toHaveLength(2)
    expect((wrapper.get('[data-test="product-select"]').element as HTMLSelectElement).value).not.toBe('canvas-1')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    const products = api.saveDraft.mock.calls[0]![2]
    expect(new Set(products.map(product => product.product_id)).size).toBe(2)
    expect(products.find(product => product.product_id === 'canvas-1')!.pricing_rules.some(rule => rule.sale_price?.amount === '12.50')).toBe(true)
    expect(wrapper.get('[data-test="autosave-status"]').text()).toContain('已确认保存')
  })

  it('adds only one independent product on repeated confirmation when no video input is buffered', async () => {
    api.detail.mockResolvedValue(videoSupplier())
    await openEditor()
    await wrapper.get('[data-test="new-independent-product"]').trigger('click')
    const confirm = wrapper.get('[data-test="confirm-add-product"]').element as HTMLButtonElement
    confirm.click(); confirm.click(); await flushPromises()
    expect(wrapper.get('[data-test="product-select"]').findAll('option')).toHaveLength(2)
    expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('does not switch to another product recovery while the current video text is incomplete', async () => {
    const dto = videoSupplier()
    api.detail.mockResolvedValue(dto)
    await openEditor()
    const auth = useAuthStore(); auth.user = { id: 1 } as NonNullable<typeof auth.user>; await flushPromises()
    const product = copy(dto.media_workbench_v1!.draft.products[0]!)
    product.product_id = `media-${crypto.randomUUID()}`; product.display_name = '尚未提交的视频 B'
    const editorId = crypto.randomUUID()
    const value: DraftRecovery = {
      version: 1, identity: { admin_id: 1, account_id: 77, product_id: product.product_id, site_model: product.site_model, upstream_model: product.upstream_model },
      base_record_version: 3, base_draft_revision: 'mwd_a', updated_at: Date.now(), copy_id: crypto.randomUUID(), editor_id: editorId, new_product: true, product
    }
    const key = recoveryCopyKey(value.identity, editorId)!
    localStorage.setItem(key, encodeDraftRecovery(value)); window.dispatchEvent(new StorageEvent('storage', { key })); await flushPromises()
    await wrapper.get('[data-test="wizard-step-4"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="video-sale-5"]').setValue('12.')
    await wrapper.get(`[data-test="recover-unsubmitted"][data-product-id="${product.product_id}"]`).trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('画布图片')
    expect((wrapper.get('[data-test="video-sale-5"]').element as HTMLInputElement).value).toBe('12.')
    expect(wrapper.get('[data-test="unsubmitted-recoveries"]').text()).toContain('尚未提交的视频 B')
    expect(api.saveDraft).not.toHaveBeenCalled()
  })

  it('commits current video text before undoing another product removal and keeps invalid text visible', async () => {
    const dto = draftManagementSupplier('video')
    api.detail.mockResolvedValue(dto); mockSave(dto)
    await openEditor(77, 'video-model')
    window.dispatchEvent(new Event('offline'))
    await wrapper.get('[data-test="product-select"]').setValue('blank-1')
    await wrapper.get('[data-test="remove-blank-product"]').trigger('click')
    await wrapper.get('[data-test="confirm-remove-product"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="product-select"]').element as HTMLSelectElement).value).toBe('canvas-1')
    await wrapper.get('[data-test="wizard-step-4"]').trigger('click'); await flushPromises()
    api.saveDraft.mockClear()
    await wrapper.get('[data-test="video-sale-5"]').setValue('12.')
    await wrapper.get('[data-test="undo-removal-blank-1"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="product-select"]').element as HTMLSelectElement).value).toBe('canvas-1')
    expect((wrapper.get('[data-test="video-sale-5"]').element as HTMLInputElement).value).toBe('12.')
    expect(wrapper.find('[data-test="undo-removal-blank-1"]').exists()).toBe(true)
    expect(api.saveDraft).not.toHaveBeenCalled()
    await wrapper.get('[data-test="video-sale-5"]').setValue('12.50')
    await wrapper.get('[data-test="undo-removal-blank-1"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="product-select"]').element as HTMLSelectElement).value).toBe('blank-1')
    expect(wrapper.find('[data-test="undo-removal-blank-1"]').exists()).toBe(false)
    window.dispatchEvent(new Event('online')); await flushPromises()
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(api.saveDraft.mock.calls[0]![2].find(product => product.product_id === 'canvas-1')!.pricing_rules.some(rule => rule.sale_price?.amount === '12.50')).toBe(true)
  })
})

describe('draft recovery choices and read-only server check', () => {
  async function identifyAdmin() { const auth = useAuthStore(); auth.user = { id: 1 } as NonNullable<typeof auth.user>; await flushPromises() }
  it('offers refresh-surviving copies without applying them and discards only the selected copy', async () => {
    await openEditor(); await identifyAdmin(); await wrapper.get('[data-test="display-name"]').setValue('未保存的本地名称')
    wrapper.unmount(); await openEditor(); await identifyAdmin()
    expect(wrapper.get('[data-test="draft-recovery"]').text()).toContain('本地恢复副本')
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('画布图片')
    expect(api.saveDraft).not.toHaveBeenCalled()
    await wrapper.get('[data-test="restore-recovery"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('未保存的本地名称')
    await wrapper.get('[data-test="discard-recovery"]').trigger('click'); await flushPromises()
    expect(wrapper.find('[data-test="draft-recovery"]').exists()).toBe(true)
    await wrapper.get('[data-test="confirm-discard-recovery"]').trigger('click'); await flushPromises()
    expect(wrapper.find('[data-test="draft-recovery"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="recovery-copy-select"]').exists()).toBe(false)
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('未保存的本地名称')
  })
  it('lists an offline new product after refresh and restores its original identity only after an explicit choice', async () => {
    await openEditor(77, 'new-model'); await identifyAdmin(); window.dispatchEvent(new Event('offline'))
    await wrapper.get('[data-test="add-product-video"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="display-name"]').setValue('离线新视频商品')
    const key = Object.keys(localStorage).find(k => k.startsWith('ai-gateway:media-draft:'))!
    const original = JSON.parse(localStorage.getItem(key)!) as DraftRecovery
    wrapper.unmount(); await openEditor(77, 'new-model'); await identifyAdmin()
    expect(wrapper.get('[data-test="unsubmitted-recoveries"]').text()).toContain('离线新视频商品')
    expect(wrapper.find('[data-test="display-name"]').exists()).toBe(false)
    await wrapper.get('[data-test="recover-unsubmitted"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="draft-recovery"]').text()).toContain('本地恢复副本')
    expect(wrapper.find('[data-test="display-name"]').exists()).toBe(false)
    await wrapper.get('[data-test="restore-recovery"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('离线新视频商品')
    const savedCopies = Object.keys(localStorage).filter(k => k.startsWith('ai-gateway:media-draft:')).map(k => JSON.parse(localStorage.getItem(k)!) as DraftRecovery)
    expect(savedCopies.every(c => c.product.product_id === original.product.product_id)).toBe(true)
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled()
  })
  it('lets the administrator choose another page copy without overwriting current input until explicit restore', async () => {
    await openEditor(); await identifyAdmin(); await wrapper.get('[data-test="display-name"]').setValue('本页 A')
    const key = Object.keys(localStorage).find(k => k.startsWith('ai-gateway:media-draft:'))!
    const other = JSON.parse(localStorage.getItem(key)!) as DraftRecovery
    other.editor_id = crypto.randomUUID(); other.copy_id = crypto.randomUUID(); other.product.display_name = '其他页 B'
    const otherKey = recoveryCopyKey(other.identity, other.editor_id)!
    localStorage.setItem(otherKey, encodeDraftRecovery(other)); window.dispatchEvent(new StorageEvent('storage', { key: otherKey })); await flushPromises()
    expect(wrapper.get('[data-test="recovery-copy-select"]').findAll('option')).toHaveLength(2)
    await wrapper.get('[data-test="recovery-copy-select"]').setValue(otherKey); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('本页 A')
    await wrapper.get('[data-test="restore-recovery"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('其他页 B')
    expect(api.saveDraft).not.toHaveBeenCalled()
  })
  it('checks without replacing input, shows conflicting fields and requires a confirmed discard to reload', async () => {
    await openEditor(); await identifyAdmin(); await wrapper.get('[data-test="display-name"]').setValue('本地 A')
    const latest = saved(); latest.media_workbench_v1!.draft.products[0]!.display_name = '服务器 B'; api.detail.mockResolvedValue(latest)
    await wrapper.get('[data-test="check-server"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('本地 A')
    expect(wrapper.get('[data-test="recovery-differences"]').text()).toContain('服务器 B')
    expect((wrapper.get('[data-test="restore-recovery"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.get('[data-test="editor-discard-reload"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('本地 A')
    await wrapper.get('[data-test="confirm-reload"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('服务器 B')
    expect(wrapper.find('[data-test="draft-recovery"]').exists()).toBe(false); expect(api.saveDraft).not.toHaveBeenCalled()
  })
  it('offers a human CAS retry only after checking an unchanged server and saves the latest input', async () => {
    await openEditor(); await identifyAdmin()
    expect(wrapper.text()).toContain('切换步骤会自动保存草稿，不会正式发布')
    await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
    api.saveDraft.mockRejectedValueOnce({ status: 0 })
    await wrapper.get('[data-test="display-name"]').setValue('sent A')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="autosave-status"]').text()).toContain('待核对')
    expect(wrapper.find('[data-test="retry-unconfirmed-save"]').exists()).toBe(false)
    await wrapper.get('[data-test="display-name"]').setValue('latest B')
    await wrapper.get('[data-test="check-server"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="retry-unconfirmed-save"]').text()).toContain('当前草稿')
    mockSave(saved())
    await wrapper.get('[data-test="retry-unconfirmed-save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft).toHaveBeenCalledTimes(2)
    expect(api.saveDraft.mock.calls[1]![2][0]!.display_name).toBe('latest B')
    expect(api.saveDraft.mock.calls[1]![4]).not.toBe(api.saveDraft.mock.calls[0]![4])
    expect(wrapper.get('[data-test="autosave-status"]').text()).toContain('已确认保存')
    expect(wrapper.find('[data-test="retry-unconfirmed-save"]').exists()).toBe(false)
    expect(api.publish).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
  })
})


describe('account selection feedback and request identity', () => {
  // The normal DOM path blocks another click while busy. Invoke the real Vue
  // method here to exercise its additional stale-response defence.
  function selectThroughView(id: number) {
    const instance = wrapper.findComponent(MediaWorkbenchView).vm.$ as unknown as { setupState: { openSupplier: (id: number) => Promise<void> } }
    return instance.setupState.openSupplier(id)
  }
  it('keeps the source list after an initial detail request fails', async () => {
    await mountWorkbench()
    api.detail.mockRejectedValueOnce({ status: 503 })
    await selectAccount()
    expect(wrapper.get('[data-test="account-page"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="model-page"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="selected-account-summary"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="sales"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="banner"]').text()).toContain('后台服务暂不可用')
  })
  it('keeps the source list when reselecting the old Account fails', async () => {
    await mountWorkbench(); await selectAccount()
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    api.detail.mockRejectedValueOnce({ status: 503 })
    await wrapper.get('[data-test="supplier-77"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="account-page"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="model-page"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="editor-page"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="banner"]').text()).toContain('后台服务暂不可用')
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
  })
  it('names the pending target without treating the old Account as that target', async () => {
    await mountWorkbench(); await selectAccount()
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    await expandSource('video.example.invalid')
    let release!: (dto: ReturnType<typeof supplier>) => void
    api.detail.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    await wrapper.get('[data-test="supplier-44"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="account-loading"]').text()).toContain('Account #44')
    expect(wrapper.get('[data-test="supplier-77"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.get('[data-test="supplier-44"]').attributes('aria-pressed')).toBe('false')
    expect(wrapper.get('[data-test="supplier-77"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="supplier-44"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="model-page"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="sales"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="display-name"]').exists()).toBe(false)
    release(supplier(44)); await flushPromises()
    expect(wrapper.get('[data-test="selected-account-summary"]').text()).toContain('#44')
    expect(wrapper.get('[data-test="selected-account-summary"]').text()).not.toContain('#77')
    expect(wrapper.find('[data-test="account-loading"]').exists()).toBe(false)
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled()
  })
  it.each(['success', 'failure'])('isolates late A %s after B is selected through the actual Vue view', async outcome => {
    await mountWorkbench()
    let resolveA!: (dto: ReturnType<typeof supplier>) => void
    let rejectA!: (error: unknown) => void
    api.detail.mockReturnValueOnce(new Promise((resolve, reject) => { resolveA = resolve; rejectA = reject }))
      .mockResolvedValueOnce(supplier(44))
    const old = selectThroughView(77)
    await selectThroughView(44); await flushPromises()
    expect(wrapper.get('[data-test="selected-account-summary"]').text()).toContain('#44')
    if (outcome === 'success') resolveA(supplier(77))
    else rejectA({ status: 404 })
    await old; await flushPromises()
    expect(wrapper.get('[data-test="selected-account-summary"]').text()).toContain('#44')
    expect(wrapper.find('[data-test="banner"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="sales"]').attributes('disabled')).toBeUndefined()
    expect(api.sales).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled()
  })
  it('keeps the old editor actions disabled while loading a different Account', async () => {
    await openEditor()
    let release!: (dto: ReturnType<typeof supplier>) => void
    api.detail.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const loading = selectThroughView(44); await flushPromises()
    expect(wrapper.get('[data-test="account-loading"]').text()).toContain('#44')
    expect(wrapper.get('[data-test="display-name"]').element.matches(':disabled')).toBe(true)
    expect(wrapper.get('[data-test="save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="product-enabled"]').attributes('disabled')).toBeDefined()
    release(supplier(44)); await loading; await flushPromises()
    expect(wrapper.find('[data-test="editor-page"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="selected-account-summary"]').text()).toContain('#44')
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
  })
  it('keeps publication and sales unavailable while an Account detail request is pending', async () => {
    await mountWorkbench(); await selectAccount()
    let release!: (dto: ReturnType<typeof supplier>) => void
    api.detail.mockReturnValueOnce(new Promise(resolve => { release = resolve }))
    const loading = selectThroughView(44); await flushPromises()
    expect(wrapper.get('[data-test="account-loading"]').text()).toContain('#44')
    expect(wrapper.get('[data-test="selected-account-summary"]').text()).toContain('#77')
    expect(wrapper.get('[data-test="sales"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="publish"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('[data-test="model-image-native-1"]').attributes('disabled')).toBeDefined()
    release(supplier(44)); await loading; await flushPromises()
    expect(wrapper.get('[data-test="selected-account-summary"]').text()).toContain('#44')
    expect(api.sales).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled()
  })
  it('discovers only the successful Account recovery even when both Accounts share Product IDs', async () => {
    await mountWorkbench()
    const auth = useAuthStore(); auth.user = { id: 1 } as NonNullable<typeof auth.user>
    const copies = [77, 44].map(id => {
      const dto = supplier(id), product = copy(dto.media_workbench_v1!.draft.products[0]!)
      product.display_name = `Account ${id} 的本地恢复`
      const editorId = crypto.randomUUID()
      const value: DraftRecovery = { version: 1, identity: { admin_id: 1, account_id: id, product_id: product.product_id, site_model: product.site_model, upstream_model: product.upstream_model }, base_record_version: 3, base_draft_revision: 'mwd_a', updated_at: Date.now(), copy_id: crypto.randomUUID(), editor_id: editorId, product }
      const key = recoveryCopyKey(value.identity, editorId)!, raw = encodeDraftRecovery(value)
      localStorage.setItem(key, raw)
      return { key, raw }
    })
    await selectAccount(); await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    await expandSource('video.example.invalid')
    await wrapper.get('[data-test="supplier-44"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="model-image-native-1"]').trigger('click'); await flushPromises()
    const recovery = wrapper.get('[data-test="draft-recovery"]')
    expect(recovery.text()).toContain('Account 44 的本地恢复')
    expect(recovery.text()).not.toContain('Account 77 的本地恢复')
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('画布图片')
    for (const item of copies) expect(localStorage.getItem(item.key)).toBe(item.raw)
    window.dispatchEvent(new Event('offline'))
    await wrapper.get('[data-test="restore-recovery"]').trigger('click'); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('Account 44 的本地恢复')
    expect(localStorage.getItem(copies[0]!.key)).toBe(copies[0]!.raw)
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(api.sales).not.toHaveBeenCalled()
  })
})
