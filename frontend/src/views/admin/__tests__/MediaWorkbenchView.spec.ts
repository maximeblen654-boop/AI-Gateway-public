import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MediaWorkbenchView from '../MediaWorkbenchView.vue'
import { mediaWorkbenchAPI } from '@/api/admin/mediaWorkbench'
import { supplier, saved } from '@/components/admin/media/__tests__/fixtures'

vi.mock('@/api/admin/mediaWorkbench', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/admin/mediaWorkbench')>(),
  mediaWorkbenchAPI: { suppliers: vi.fn(), detail: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), sales: vi.fn(), sync: vi.fn(), initialize: vi.fn() }
}))
const api = vi.mocked(mediaWorkbenchAPI)
let wrapper: VueWrapper
let router: ReturnType<typeof createRouter>

async function mountWorkbench() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/media', component: MediaWorkbenchView }, { path: '/admin/accounts', component: { template: '<div>Accounts</div>' } }] })
  await router.push('/admin/media')
  wrapper = mount({ template: '<router-view />' }, { attachTo: document.body, global: { plugins: [router], stubs: { AppLayout: { template: '<div><slot /></div>' } } } })
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
  vi.resetAllMocks()
  api.suppliers.mockResolvedValue([supplier(), supplier(44)])
  api.detail.mockImplementation(async id => supplier(id))
  api.saveDraft.mockResolvedValue(saved())
  vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); document.body.innerHTML = '' })

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
    api.saveDraft.mockResolvedValue(response)
    await mountWorkbench(); await selectAccount(); await wrapper.get('[data-test="model-new-model"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="add-product-image"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.initialize).not.toHaveBeenCalled()
    expect(api.saveDraft).toHaveBeenCalledWith(77, 0, expect.arrayContaining([expect.objectContaining({ media_type: 'image', upstream_model: 'new-model' })]))
  })

  it('shows separate save, publish, and sales actions with account-wide publish scope', async () => {
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

  it('appends image and video drafts before the first save without discarding or initializing early', async () => {
    const nil = supplier(); nil.media_workbench_v1 = null; nil.effective_state = 'NOT_INITIALIZED'; nil.effective_sales = false
    api.detail.mockResolvedValue(nil)
    await mountWorkbench(); await selectAccount()
    await wrapper.get('[data-test="model-new-model"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="add-product-image"]').trigger('click'); await flushPromises()
    await wrapper.get('[data-test="display-name"]').setValue('保留的图片草稿')
    const append = wrapper.findAll('button').find(button => button.text() === '添加视频产品后一起保存')!
    await append.trigger('click'); await flushPromises()
    expect(wrapper.find('dialog[open]').exists()).toBe(false)
    expect(api.initialize).not.toHaveBeenCalled()
    expect(api.saveDraft).not.toHaveBeenCalled()
    await wrapper.get('[data-test="display-name"]').setValue('视频草稿')
    await wrapper.get('[data-test="wizard-step-5"]').trigger('click')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft).toHaveBeenCalledTimes(1)
    expect(api.saveDraft).toHaveBeenCalledWith(77, 0, [
      expect.objectContaining({ media_type: 'image', display_name: '保留的图片草稿', capabilities: expect.objectContaining({ count: { min: 1, max: 10 } }) }),
      expect.objectContaining({ media_type: 'video', display_name: '视频草稿', capabilities: expect.objectContaining({ count: { min: 1, max: 1 } }) })
    ])
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
    await wrapper.get('[data-test="reload"]').trigger('click')
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
    api.saveDraft.mockResolvedValue(response)

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
    expect(wrapper.get('[data-test="price-0"]').element).toHaveProperty('value', '')
    await wrapper.get('[data-test="product-select"]').setValue(first.product_id); await flushPromises()
    await wrapper.get('[data-test="wizard-step-4"]').trigger('click')
    expect(wrapper.get('[data-test="price-0"]').element).toHaveProperty('value', '0.18')
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
