import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MediaWorkbenchView from '../MediaWorkbenchView.vue'
import { mediaWorkbenchAPI } from '@/api/admin/mediaWorkbench'
import { setSiteTheme, setSidebarStyle, setYellowSidebarStyle, type SiteTheme } from '@/utils/siteTheme'
import { supplier, saved, copy } from '@/components/admin/media/__tests__/fixtures'

vi.mock('@/api/admin/mediaWorkbench', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/admin/mediaWorkbench')>(),
  mediaWorkbenchAPI: { suppliers: vi.fn(), detail: vi.fn(), saveDraft: vi.fn(), publish: vi.fn(), sales: vi.fn(), sync: vi.fn(), initialize: vi.fn() }
}))
const api = vi.mocked(mediaWorkbenchAPI)
let wrapper: VueWrapper
let router: ReturnType<typeof createRouter>
async function start() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/media', component: MediaWorkbenchView }, { path: '/admin/accounts', component: { template: '<div>Accounts</div>' } }] })
  await router.push('/admin/media')
  wrapper = mount({ template: '<router-view />' }, { attachTo: document.body, global: { plugins: [router], stubs: { AppLayout: { template: '<div><slot /></div>' } } } })
  await flushPromises(); await wrapper.get('[data-test="supplier-77"]').trigger('click'); await flushPromises()
}
beforeEach(() => {
  vi.resetAllMocks(); api.suppliers.mockResolvedValue([supplier(), supplier(44)]); api.detail.mockImplementation(async id => supplier(id)); api.saveDraft.mockResolvedValue(saved())
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
})
afterEach(() => { wrapper?.unmount(); document.documentElement.classList.remove('dark') })
describe('Media Workbench admin interactions', () => {
  it('renders the Go DTO null slices as empty specifications and missing prices', async () => {
    const dto = supplier(77, 'FAIL')
    Object.assign(dto.media_workbench_v1!.draft.products[0]!.capabilities, { resolutions: null })
    Object.assign(dto.media_workbench_v1!.draft.products[0]!, { pricing_rules: null })
    api.detail.mockResolvedValue(dto); await start()
    expect(wrapper.get('[data-test="model-image-native-1"]').text()).toContain('未配置售价')
    expect(wrapper.get('[data-test="display-name"]').exists()).toBe(true)
  })
  it('keeps the upstream platform name as the primary model identity', async () => {
    const dto = supplier()
    const p = dto.media_workbench_v1!.draft.products[0]!
    p.upstream_model = '特价2.0-需要过人脸技术-可参考过人脸素材库'
    p.site_model = '3.0'
    p.display_name = '本站产品别名'
    dto.models = [{ model_id: p.upstream_model, state: 'DRAFT' }]
    api.detail.mockResolvedValue(dto); api.suppliers.mockResolvedValue([dto]); await start()
    expect(wrapper.get('[data-test="upstream-model-name"]').text()).toBe(p.upstream_model)
    expect(wrapper.get('[data-test="internal-id"]').text()).toBe('内部 ID: 3.0')
    expect(wrapper.text()).not.toContain('WAN3.0')
  })
  it.each([
    ['capabilities', 'input'], ['pricing_rules.0.sale_price', '[data-test="price-0"]'],
    ['adapter_config.size_mappings', '[data-test="mapping-resolution-0"]']
  ])('locates Phase 2A scope + relative path %s in another product', async (path, field) => {
    const dto = supplier(77, 'FAIL')
    const other = copy(dto.media_workbench_v1!.draft.products[0]!)
    other.product_id = 'other-product'; other.upstream_model = 'new-model'; other.display_name = 'other product'
    dto.media_workbench_v1!.draft.products.push(other)
    Object.assign(dto.media_workbench_v1!.validation.diagnostics[0]!, { scope: other.product_id, path })
    api.detail.mockResolvedValue(dto); await start()
    await wrapper.get('.mw-diagnostic').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="model-new-model"]').attributes('aria-pressed')).toBe('true')
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('other product')
    const selector = path === 'capabilities' ? '[data-field="capabilities"] input' : field
    expect(document.activeElement).toBe(wrapper.get(selector).element)
  })
  it('model switching offers save/discard/cancel and keeps edits on cancel', async () => {
    await start(); await wrapper.get('[data-test="display-name"]').setValue('本地修改')
    await wrapper.get('[data-test="model-new-model"]').trigger('click'); await flushPromises()
    expect(wrapper.find('dialog[open]').text()).toContain('有未保存修改')
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('本地修改')
    await wrapper.find('dialog[open]').findAll('button').at(-1)!.trigger('click'); await flushPromises()
    expect(wrapper.find('dialog[open]').exists()).toBe(false); expect(wrapper.get('[data-test="unsaved"]').exists()).toBe(true)
  })
  it('supplier switching saves first, then opens exactly the chosen supplier', async () => {
    await start(); await wrapper.get('[data-test="display-name"]').setValue('本地修改')
    await wrapper.get('[data-test="supplier-44"]').trigger('click'); await wrapper.get('[data-test="save-navigate"]').trigger('click'); await flushPromises()
    expect(api.saveDraft).toHaveBeenCalledTimes(1); expect(api.detail).toHaveBeenLastCalledWith(44)
  })
  it('discard switches model without sending a save', async () => {
    await start(); await wrapper.get('[data-test="display-name"]').setValue('丢弃')
    await wrapper.get('[data-test="model-new-model"]').trigger('click'); await wrapper.get('[data-test="discard-navigate"]').trigger('click'); await flushPromises()
    expect(api.saveDraft).not.toHaveBeenCalled(); expect(wrapper.text()).toContain('此模型待配置')
  })
  it('route navigation can cancel or discard without silent data loss', async () => {
    await start(); await wrapper.get('[data-test="display-name"]').setValue('保留')
    const cancelled = router.push('/admin/accounts'); await flushPromises()
    await wrapper.find('dialog[open]').findAll('button').at(-1)!.trigger('click'); await cancelled
    expect(router.currentRoute.value.path).toBe('/admin/media')
    const leaving = router.push('/admin/accounts'); await flushPromises(); await wrapper.get('[data-test="discard-navigate"]').trigger('click'); await leaving
    expect(router.currentRoute.value.path).toBe('/admin/accounts')
  })
  it('renders saved + FAIL, and shows Copy-to-Codex only for development diagnostics', async () => {
    await start(); api.saveDraft.mockResolvedValue(saved('FAIL')); await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(wrapper.text()).toContain('草稿已保存'); expect(wrapper.text()).toContain('4K 条件缺少售价'); expect(wrapper.find('[data-test="copy-codex"]').exists()).toBe(false)
    const dto = saved('FAIL'); dto.media_workbench_v1!.validation.diagnostics[0]!.class = 'NEEDS_DEVELOPMENT'
    api.saveDraft.mockResolvedValue(dto); await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(wrapper.find('[data-test="copy-codex"]').exists()).toBe(true)
  })
  it('409 requires an explicit reload and never resubmits automatically', async () => {
    await start(); await wrapper.get('[data-test="display-name"]').setValue('保留')
    api.saveDraft.mockRejectedValue({ status: 409 }); await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft).toHaveBeenCalledTimes(1); expect(wrapper.get('[data-test="save"]').attributes('disabled')).toBeDefined()
    await wrapper.get('[data-test="reload"]').trigger('click'); await wrapper.get('[data-test="confirm-reload"]').trigger('click'); await flushPromises()
    expect(api.detail).toHaveBeenCalledTimes(2); expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('画布图片')
  })
  it('publish confirmation and pending lock suppress duplicate publishes', async () => {
    await start(); await wrapper.get('[data-test="publish"]').trigger('click'); await flushPromises()
    expect(wrapper.find('dialog[open]').text()).toContain('已有订单不会改变')
    let resolve!: (dto: ReturnType<typeof saved>) => void; api.publish.mockReturnValue(new Promise(r => { resolve = r }))
    await wrapper.get('[data-test="confirm-publish"]').trigger('click'); await wrapper.get('[data-test="confirm-publish"]').trigger('click')
    expect(api.publish).toHaveBeenCalledTimes(1); resolve(saved()); await flushPromises()
  })
  it('missing and zero prices remain distinct after editing', async () => {
    await start(); await wrapper.get('[data-test="price-0"]').setValue(''); expect(wrapper.text()).toContain('未配置售价')
    await wrapper.get('[data-test="price-0"]').setValue('0'); expect(wrapper.text()).toContain('明确免费：0 元')
    await wrapper.get('[data-test="price-0"]').setValue('0.12345678901234567890'); await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft.mock.calls[0]![2][0]!.pricing_rules[0]!.sale_price!.amount).toBe('0.12345678901234567890')
  })
  it('diagnostic locates a field in another product without losing edits', async () => {
    await start(); api.saveDraft.mockResolvedValue(saved('FAIL')); await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    await wrapper.get('.mw-diagnostic').trigger('click'); await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-test="price-0"]').element)
  })
  it('size mapping diagnostics open the mapping editor; existing mappings can be saved and edited', async () => {
    const dto = supplier(77, 'FAIL')
    dto.media_workbench_v1!.validation.diagnostics[0]!.path = 'draft.products[0].adapter_config.size_mappings'
    dto.media_workbench_v1!.validation.diagnostics[0]!.code = 'MISSING_VALUE_MAPPING'
    api.detail.mockResolvedValue(dto); await start()
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft.mock.calls[0]![2][0]!.adapter_config).toEqual(dto.media_workbench_v1!.draft.products[0]!.adapter_config)
    api.saveDraft.mockResolvedValue(dto); await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    await wrapper.get('.mw-diagnostic').trigger('click'); await flushPromises()
    expect(wrapper.get('[data-test="size-mappings"]').attributes('open')).toBeDefined()
    expect(document.activeElement).toBe(wrapper.get('[data-test="mapping-resolution-0"]').element)
    await wrapper.get('[data-test="mapping-size-0"]').setValue('1536x1536')
    await wrapper.get('[data-test="save"]').trigger('click'); await flushPromises()
    expect(api.saveDraft.mock.calls.at(-1)![2][0]!.adapter_config.size_mappings[0]!.wire_size).toBe('1536x1536')
    expect(dto.media_workbench_v1!.draft.products[0]!.adapter_config.size_mappings[0]!.wire_size).toBe('2048x2048')
  })
  it.each([
    ['SELLING', '媒体销售中'], ['PUBLISHED_NOT_READY', '已发布配置暂未满足销售条件'],
    ['ACCOUNT_RUNTIME_BLOCKED', '账户暂时无法提供服务，请打开账户详情处理']
  ])('renders a friendly label for %s', async (effectiveState, label) => {
    const dto = supplier(); dto.effective_state = effectiveState; dto.effective_sales = effectiveState === 'SELLING'
    api.detail.mockResolvedValue(dto); api.suppliers.mockResolvedValue([dto]); await start()
    expect(wrapper.text()).toContain(label); expect(wrapper.text()).not.toContain(effectiveState)
  })
  it.each(['yellow', 'blue', 'pink', 'green', 'lavender'] as SiteTheme[])('%s light/dark and artwork changes preserve form/selection without API calls', async theme => {
    await start(); await wrapper.get('[data-test="display-name"]').setValue('主题切换不丢失')
    const calls = api.detail.mock.calls.length
    setSiteTheme(theme); document.documentElement.classList.add('dark'); setSidebarStyle('whale_girl'); setYellowSidebarStyle('robot'); await flushPromises()
    expect((wrapper.get('[data-test="display-name"]').element as HTMLInputElement).value).toBe('主题切换不丢失')
    expect(wrapper.get('[data-test="model-image-native-1"]').attributes('aria-pressed')).toBe('true')
    expect(api.detail).toHaveBeenCalledTimes(calls); expect(api.saveDraft).not.toHaveBeenCalled(); expect(api.publish).not.toHaveBeenCalled()
  })
  it.each(['ACCOUNT_INACTIVE', 'ACCOUNT_UNSCHEDULABLE'])('displays %s while keeping Draft visible', async effectiveState => {
    const dto = supplier(); dto.effective_state = effectiveState; dto.effective_sales = false; dto.sales_resume_ready = false; dto.media_workbench_v1!.sales.enabled = false
    api.detail.mockResolvedValue(dto); await start(); expect(wrapper.find('[data-test="display-name"]').exists()).toBe(true); expect(wrapper.get('[data-test="sales"]').attributes('disabled')).toBeDefined()
  })
})
