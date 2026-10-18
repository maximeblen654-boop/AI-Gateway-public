// Isolated browser fault harness. The actual Vue view, layout, sidebar, editor,
// composable and API serializer run unchanged; only HTTP transport is simulated.
// This fixture is UI evidence, never evidence of Core/Bridge/BFF integration.
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import MediaWorkbenchView from '@/views/admin/MediaWorkbenchView.vue'
import { apiClient } from '@/api/client'
import type { Diagnostic, Product, SupplierDetail } from '@/api/admin/mediaWorkbench'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import type { User } from '@/types'
import i18n, { initI18n } from '@/i18n'
import { initSiteTheme, setSiteTheme } from '@/utils/siteTheme'
import '@/style.css'
import '@/styles/site-theme.css'

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const price = (amount: string) => ({ amount, currency: 'CNY', billing_mode: 'per_request' })
const query = new URLSearchParams(location.search)
const scenario = query.get('scenario') || 'complete'
const key = `procurement-ui-fixture:${scenario}`
const image: Product = {
  product_id: 'procurement-image', media_type: 'image', site_model: 'image-native-1', display_name: '隔离图片商品', upstream_model: 'image-native-1', enabled: true,
  capabilities: { resolutions: ['1K', '2K'], aspect_ratios: ['1:1', '16:9'], qualities: [], durations_seconds: [], count: { min: 1, max: 5 }, references: { image: { min: 0, max: 4 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 4 }, combination_rules: [] },
  // Unified customer price deliberately has two independent procurement costs.
  pricing_rules: [{ match: {}, sale_price: price('0.90') }],
  cost_rules: [{ match: { resolution: ['1K'] }, cost: price('0.10'), source: 'manual' }, { match: { resolution: ['2K'] }, cost: price('0.20'), source: 'manual' }],
  adapter_config: { version: 1, model_family: 'openai_json', execution: { mode: 'native_multi', max_output_images: 5 }, edit_execution: { mode: 'single', max_output_images: 1 }, size_mappings: [] }
}
const video: Product = {
  product_id: 'procurement-wan', media_type: 'video', site_model: 'WAN3.0-可参考视频', display_name: 'WAN3.0 隔离商品', upstream_model: 'WAN3.0-可参考视频', enabled: true,
  capabilities: { resolutions: ['720p'], aspect_ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'], qualities: [], durations_seconds: [5, 10, 15], count: { min: 1, max: 1 }, references: { image: { min: 0, max: 10 }, video: { min: 0, max: 5 }, audio: { min: 0, max: 5 }, total_max: 14 }, combination_rules: [] },
  pricing_rules: [5, 10, 15].map(seconds => ({ match: { duration_seconds: [seconds] }, sale_price: price(String(seconds / 5)) })),
  cost_rules: [5, 10, 15].map((seconds, index) => ({ match: { duration_seconds: [seconds] }, cost: price(['0.3', '0.6', '0.9'][index]!), source: 'manual' })),
  adapter_config: { version: 1, wire_profile: 'inline_multimedia', size_mappings: [] }
}
const blank: Product = { ...copy(image), product_id: 'procurement-unselected', site_model: 'incomplete-model', upstream_model: 'incomplete-model', display_name: '未选中的未完成草稿', pricing_rules: [], cost_rules: [] }
const initial: SupplierDetail = {
  id: 44, name: 'Synthetic procurement Account', host: 'supplier.example.invalid', platform: 'openai', type: 'apikey', status: 'active', schedulable: true,
  effective_sales: false, effective_state: 'SALES_PAUSED', sales_resume_ready: true,
  discovered_count: 34, configured_count: 3, pending_count: 31, problem_count: 1,
  model_catalog: { source: 'isolated-fixture', synced_at: '2026-10-19T00:00:00Z', models: [image.upstream_model, video.upstream_model, blank.upstream_model] },
  models: [image, video, blank].map(product => ({ model_id: product.upstream_model, state: product === blank ? 'DRAFT' : 'PUBLISHED' })).concat(Array.from({ length: 31 }, (_, n) => ({ model_id: `unconfigured-${n}`, state: 'PENDING' }))),
  media_workbench_v1: {
    record_version: 3, media_types: ['image', 'video'], sales: { enabled: false },
    adapter_bindings: { image: { kind: 'openai_images', revision: 'openai_images_v1', auth: 'account_apikey', task_flow: 'sync' }, video: { kind: 'native_video', revision: 'fixture_v1', auth: 'account_apikey', task_flow: 'async' } },
    draft: { revision: 'fixture-draft-3', updated_at: '2026-10-19T00:00:00Z', products: [copy(image), copy(video), copy(blank)] },
    validation: { draft_revision: 'fixture-draft-3', status: 'FAIL', publish_ready: false, checked_at: '2026-10-19T00:00:00Z', diagnostics: [] },
    published: { revision: 'fixture-published-2', source_draft_revision: 'fixture-draft-2', products: [copy(image), copy(video)], offers: [{ product_id: image.product_id, offer_id: 'fixture-image-offer' }, { product_id: video.product_id, offer_id: 'fixture-wan-offer' }] }
  }
}
if (scenario === 'missing') initial.media_workbench_v1!.draft.products[0]!.cost_rules = [{ match: {}, cost: null, source: 'manual' }]
const persisted = sessionStorage.getItem(key)
const dto: SupplierDetail = persisted ? JSON.parse(persisted) : initial
type Fault = 'fail' | 'invalid' | 'timeout-committed' | 'timeout-rejected' | 'conflict' | 'delay'
type Call = { method: string; url: string; input: unknown }
const calls: Call[] = []
const faults = new Map<string, Fault>()
let release: (() => void) | undefined
const persist = () => sessionStorage.setItem(key, JSON.stringify(dto))
function diagnostics(products: Product[]): Diagnostic[] {
  return products.flatMap(product => {
    const index = dto.media_workbench_v1!.draft.products.findIndex(p => p.product_id === product.product_id)
    const missing = !product.cost_rules?.length || product.cost_rules.some(rule => rule.cost == null)
    return [
      ...(missing ? [{ class: 'UI_FIXABLE', severity: 'error', code: 'MISSING_COST', scope: product.product_id, path: `draft.products[${index}].cost_rules[0].cost`, message: `${product.display_name} 的采购成本尚未填写`, action: '前往第4步填写采购成本', match: product.cost_rules?.[0]?.match ?? {} }] : []),
      ...(!product.pricing_rules.length || product.pricing_rules.some(rule => rule.sale_price == null) ? [{ class: 'UI_FIXABLE', severity: 'error', code: 'MISSING_PRICE', scope: product.product_id, path: `draft.products[${index}].pricing_rules[0].sale_price`, message: `${product.display_name} 的客户售价尚未填写`, action: '前往第4步填写客户售价' }] : [])
    ]
  })
}
function validate() {
  const c = dto.media_workbench_v1!
  c.validation = { ...c.validation, draft_revision: c.draft.revision, status: 'FAIL', publish_ready: false, diagnostics: diagnostics(c.draft.products) }
  if (!c.validation.diagnostics.length) { c.validation.status = 'PASS'; c.validation.publish_ready = true }
}
validate()
Object.assign(window, { procurementFixture: {
  calls, snapshot: () => copy(dto), failNext: (operation: string, fault: Fault) => faults.set(operation, fault),
  release: () => { release?.(); release = undefined }
} })

apiClient.defaults.adapter = async config => {
  const url = config.url || '', method = config.method || 'get'
  const input = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
  calls.push({ method, url, input: copy(input ?? null) })
  const operation = url.split('/').pop() || ''
  const fault = method !== 'get' ? faults.get(operation) : undefined
  if (fault) faults.delete(operation)
  const reject = (status: number, message: string, data?: unknown) => {
    throw { isAxiosError: true, config, response: { status, data: { code: 'ISOLATED_FIXTURE', message, ...(data ? { data } : {}) } } }
  }
  if (fault === 'delay') await new Promise<void>(resolve => { release = resolve })
  if (fault === 'fail') reject(operation === 'sales' ? 422 : 503, 'Isolated write failure')
  if (fault === 'invalid') reject(400, 'Isolated definitive input rejection before write')
  if (fault === 'conflict') {
    dto.media_workbench_v1!.record_version++
    dto.media_workbench_v1!.draft.revision = `fixture-draft-${dto.media_workbench_v1!.record_version}`
    persist(); reject(409, 'Isolated concurrent update')
  }
  if (fault === 'timeout-rejected') throw { isAxiosError: true, config, code: 'ECONNABORTED', message: 'Isolated transport timeout' }
  let data: unknown = {}
  if (url === '/admin/media-workbench/suppliers') data = [copy(dto)]
  else if (url.startsWith('/admin/media-workbench/accounts/')) {
    const c = dto.media_workbench_v1!
    if (method !== 'get' && input?.expected_record_version !== c.record_version) reject(409, 'Isolated compare-and-swap conflict')
    if (operation === 'draft' && method === 'put') {
      c.draft.products = copy(input.draft.products)
      c.record_version++; c.draft.revision = `fixture-draft-${c.record_version}`
      validate(); persist()
    } else if (operation === 'publish' && method === 'post') {
      const selected = c.draft.products.filter(p => input.product_ids.includes(p.product_id))
      const issues = diagnostics(selected)
      if (!selected.length || issues.length) {
        const rejected = copy(dto)
        rejected.publish_validation = { ...copy(c.validation), diagnostics: issues, status: 'FAIL', publish_ready: false }
        reject(422, 'Selected product validation rejected', rejected)
      }
      const untouched = c.published?.products?.filter(p => !input.product_ids.includes(p.product_id)) || []
      c.record_version++
      c.published = { revision: `fixture-published-${c.record_version}`, source_draft_revision: c.draft.revision, products: [...untouched, ...copy(selected)], offers: selected.map(p => ({ product_id: p.product_id, offer_id: `fixture-${p.product_id}-${c.record_version}` })) }
      persist()
    } else if (operation === 'sales' && method === 'put') {
      c.record_version++; c.sales.enabled = input.enabled
      dto.effective_sales = input.enabled; dto.effective_state = input.enabled ? 'SELLING' : 'SALES_PAUSED'
      persist()
    }
    data = copy(dto)
  } else if (url.includes('/paid-controls/')) data = { media: operation, mode: 'managed-v1', requested_enabled: false, effective_enabled: false, revision: 'fixture-paid-1', reason: 'disabled' }
  else if (url === '/announcements') data = []
  else if (url === '/keys') data = { items: [], pages: 1, total: 0 }
  else if (url.includes('settings')) data = { site_name: 'Procurement UI fixture', ops_monitoring_enabled: false }
  if (fault === 'timeout-committed') throw { isAxiosError: true, config, code: 'ECONNABORTED', message: 'Isolated timeout after commit' }
  return { config, status: 200, statusText: 'OK', headers: {}, data: { code: 0, message: '', data } }
}
localStorage.setItem('sub2api_locale', 'zh')
localStorage.setItem('admin_guide_1_admin_v4_interactive', 'true')
localStorage.setItem('theme', query.get('mode') || 'light')
initSiteTheme(); setSiteTheme('blue')
document.documentElement.classList.toggle('dark', query.get('mode') === 'dark')
const pinia = createPinia()
const app = createApp({ render: () => h(RouterView) })
app.use(pinia)
useAuthStore().user = { id: 1, username: 'Isolated Admin', role: 'admin', balance: 0, status: 'active' } as User
const settings = useAppStore(); settings.publicSettingsLoaded = true; settings.siteName = 'Procurement UI fixture'
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/media', component: MediaWorkbenchView, meta: { title: '媒体工作台' } }] })
await initI18n(); i18n.global.locale.value = 'zh'
app.use(i18n); app.use(router)
await router.push('/admin/media'); await router.isReady(); app.mount('#app')
