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
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { wrapper?.unmount(); document.body.innerHTML = '' })

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
    expect(wrapper.get('[data-test="publish"]').text()).toContain('发布配置')
    expect(wrapper.get('[data-test="sales"]').text()).toContain('暂停销售')
    await wrapper.get('[data-test="publish"]').trigger('click'); await flushPromises()
    const dialog = wrapper.find('dialog[open]')
    expect(dialog.text()).toContain('画布图片')
    expect(dialog.text()).toContain('不会自动开启销售')
  })

  it.each([
    ['SALES_PAUSED', '已暂停销售'], ['NOT_INITIALIZED', '未开启销售']
  ])('distinguishes initial sale state from paused state (%s)', async (state, label) => {
    const dto = supplier(); dto.effective_state = state; dto.effective_sales = false; dto.media_workbench_v1!.sales.enabled = false
    api.detail.mockResolvedValue(dto); api.suppliers.mockResolvedValue([dto])
    await openEditor()
    expect(wrapper.get('[data-test="sales-state"]').text()).toContain(label)
  })

  it('keeps dirty navigation protected inside the page flow', async () => {
    await openEditor(); await wrapper.get('[data-test="display-name"]').setValue('本地修改')
    await wrapper.get('.mw-back').trigger('click'); await flushPromises()
    expect(wrapper.find('dialog[open]').text()).toContain('有未保存修改')
    await wrapper.get('[data-test="discard-navigate"]').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="model-page"]').exists()).toBe(true)
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
