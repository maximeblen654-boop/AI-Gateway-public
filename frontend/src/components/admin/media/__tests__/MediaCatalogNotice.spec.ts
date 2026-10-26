import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import MediaCatalogNotice from '../MediaCatalogNotice.vue'
import { supplier } from './fixtures'

const { copy } = vi.hoisted(() => ({ copy: vi.fn() }))
vi.mock('@/composables/useClipboard', () => ({ useClipboard: () => ({ copyToClipboard: copy }) }))
const wrappers: ReturnType<typeof mount>[] = []
const now = new Date('2026-10-21T12:00:00Z')
const detail = () => {
  const dto = supplier()
  dto.model_catalog = { source: 'upstream', synced_at: now.toISOString(), models: ['model-new'] }
  dto.model_catalog_change = { schema_version: 1, detected_at: now.toISOString(), previous_synced_at: '2026-10-21T11:55:00Z', added_count: 1, missing_count: 1, added_models: ['model-new'], missing_models: ['model-old'], truncated: false }
  const product = dto.media_workbench_v1!.published!.products![0]!
  dto.product_states = [{ product_id: product.product_id, display_name: product.display_name, media_type: product.media_type, upstream_model: product.upstream_model, published: true, published_ready: false, state: 'UPSTREAM_REMOVED', reason: '', action: '' }]
  return dto
}
const open = (dto = detail()) => { const wrapper = mount(MediaCatalogNotice, { props: { detail: dto } }); wrappers.push(wrapper); return wrapper }
it.each(['UNLISTED', 'ARCHIVED'])('separates %s history from active product handling', state => {
  const dto = detail()
  const product = dto.media_workbench_v1!.published!.products![0]!
  dto.product_states = [{ product_id: product.product_id, display_name: product.display_name, media_type: product.media_type, upstream_model: product.upstream_model, published: true, published_ready: false, state, reason: '', action: '' }]
  const wrapper = open(dto)
  expect(wrapper.get('[data-test="catalog-historical"]').text()).toContain('仅保留观察')
  expect(wrapper.find('[data-test="catalog-affected"]').exists()).toBe(false)
  expect(wrapper.get('[data-test="catalog-no-affected"]').text()).toContain('无需操作')
  expect(wrapper.find('[data-test="catalog-copy"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="catalog-old-model"]').exists()).toBe(false)
})
it.each(['archived', 'unlisted'] as const)('hides handling for explicit %s lifecycle even when an old response reports removal', state => {
  const dto = detail(), productId = dto.product_states![0]!.product_id
  dto.media_workbench_v1!.product_lifecycle = { [productId]: { state, revision: 4, updated_at: now.toISOString() } }
  expect(dto.product_states![0]!.state).toBe('UPSTREAM_REMOVED')
  const wrapper = open(dto)
  expect(wrapper.get('[data-test="catalog-historical"]').text()).toContain('仅保留观察')
  expect(wrapper.get('[data-test="catalog-no-affected"]').text()).toContain('无需操作')
  expect(wrapper.find('[data-test="catalog-copy"]').exists()).toBe(false)
  expect(wrapper.find(`[data-test="catalog-configure-${productId}"]`).exists()).toBe(false)
})
it.each(['missing', 'incomplete'])('shows unknown for %s product state evidence', mode => {
  const dto = detail()
  if (mode === 'incomplete') dto.product_states = []
  else delete dto.product_states
  const wrapper = open(dto)
  expect(wrapper.get('[data-test="catalog-impact-unknown"]').text()).toContain('当前影响尚未确认')
  expect(wrapper.find('[data-test="catalog-no-affected"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="catalog-copy"]').exists()).toBe(false)
})
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); copy.mockReset(); copy.mockResolvedValue(true) })
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.useRealTimers() })

it('shows the observation and copies through the existing clipboard helper without emitting changes', async () => {
  const dto = detail(); const before = JSON.stringify(dto); const wrapper = open(dto)
  expect(wrapper.get('[data-test="catalog-change-summary"]').text()).toContain('新增 1 个型号')
  await wrapper.get('[data-test="catalog-copy"]').trigger('click'); await flushPromises()
  expect(copy).toHaveBeenCalledOnce()
  expect(copy.mock.calls[0]![0]).toContain('受影响商品检查信息')
  expect(copy.mock.calls[0]![0]).toContain('原型号不可用')
  expect(wrapper.get('[data-test="catalog-copy-status"]').text()).toContain('复制本身不会修改网站')
  expect(wrapper.emitted('update')).toBeUndefined()
  expect(JSON.stringify(dto)).toBe(before)
})
it('keeps a selectable report when clipboard permission is denied', async () => {
  copy.mockResolvedValue(false); const wrapper = open()
  await wrapper.get('[data-test="catalog-copy"]').trigger('click'); await flushPromises()
  expect(wrapper.get('[data-test="catalog-copy-text"]').attributes('readonly')).toBeDefined()
  expect(wrapper.get('[data-test="catalog-copy-status"]').text()).toContain('手动复制')
})
it('marks an old page snapshot unconfirmed and accepts a refreshed snapshot without blaming the observer', async () => {
  const dto = detail(); const before = JSON.stringify(dto); const wrapper = open(dto)
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  const message = wrapper.get('[data-test="catalog-delayed"]').text()
  expect(message).toContain('当前页面里的目录信息尚未确认')
  expect(message).toContain('刷新页面查看最新检查')
  expect(message).not.toContain('目录更新延迟')
  expect(wrapper.find('[data-test="catalog-change-summary"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="catalog-copy"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="catalog-no-affected"]').exists()).toBe(false)
  const refreshed = detail(); refreshed.model_catalog!.synced_at = new Date(Date.now()).toISOString()
  await wrapper.setProps({ detail: refreshed })
  expect(wrapper.find('[data-test="catalog-delayed"]').exists()).toBe(false)
  expect(wrapper.get('[data-test="catalog-change-summary"]').text()).toContain('新增 1 个型号')
  expect(JSON.stringify(dto)).toBe(before)
  expect(wrapper.emitted('update')).toBeUndefined()
  expect(copy).not.toHaveBeenCalled()
})
it('shows a baseline for a new account instead of manufacturing a change', () => {
  const dto = detail(); delete dto.model_catalog_change
  expect(open(dto).get('[data-test="catalog-baseline"]').text()).toContain('建立基线')
})
it('does not show an old copy result after an account switch', async () => {
  let resolve!: (value: boolean) => void
  copy.mockImplementation(() => new Promise<boolean>(r => { resolve = r }))
  const wrapper = open()
  await wrapper.get('[data-test="catalog-copy"]').trigger('click')
  const other = detail(); other.id = 44
  await wrapper.setProps({ detail: other }); resolve(false); await flushPromises()
  expect(wrapper.find('[data-test="catalog-copy-status"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="catalog-copy-text"]').exists()).toBe(false)
})

it('routes an affected published product into its configuration without changing data', async () => {
  const dto = detail(); const before = JSON.stringify(dto); const wrapper = open(dto)
  const automatic = wrapper.get('[data-test="catalog-auto-list"]').text()
  expect(automatic).toContain('成功同步的新型号会自动进入本账号模型列表')
  expect(automatic).toContain('不会自动上架、改售价或开启销售')
  const oldModel = wrapper.get('[data-test="catalog-old-model"]').text()
  expect(oldModel).toContain('不代表永久下架')
  expect(oldModel).toContain('草稿、历史任务和账务会保留')
  expect(oldModel).toContain('需要新增技术能力时')
  await wrapper.get(`[data-test="catalog-configure-${dto.product_states![0]!.product_id}"]`).trigger('click')
  expect(wrapper.emitted('configure')).toEqual([[dto.product_states![0]!.product_id]])
  expect(wrapper.findAll('button')).toHaveLength(2)
  expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
  expect(JSON.stringify(dto)).toBe(before)
})
it('does not request product decisions for changed IDs without an affected published product', async () => {
  const dto = detail()
  dto.product_states = [{ product_id: 'unpublished-old', display_name: '保留的草稿', media_type: 'video', upstream_model: 'video-old', published: false, published_ready: false, state: 'UPSTREAM_REMOVED', reason: '', action: '' }]
  dto.media_workbench_v1!.published!.products = []
  const before = JSON.stringify(dto); const wrapper = open(dto)
  expect(wrapper.get('[data-test="catalog-no-affected"]').text()).toContain('目录已更新，未影响当前已发布商品，无需操作')
  expect(wrapper.find('[data-test="catalog-affected"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="catalog-copy"]').exists()).toBe(false)
  expect(wrapper.find('[data-test="catalog-old-model"]').exists()).toBe(false)
  expect(copy).not.toHaveBeenCalled()
  expect(JSON.stringify(dto)).toBe(before)
  expect(wrapper.emitted('update')).toBeUndefined()
})
