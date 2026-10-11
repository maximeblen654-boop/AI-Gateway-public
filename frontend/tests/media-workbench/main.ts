// Browser-only fixture entry. This is never imported by the application entry.
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import MediaWorkbenchView from '@/views/admin/MediaWorkbenchView.vue'
import { apiClient } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import i18n, { initI18n } from '@/i18n'
import { initSiteTheme, setSiteTheme, setSidebarStyle, setYellowSidebarStyle, siteThemeOptions, type SidebarStyle, type YellowSidebarStyle } from '@/utils/siteTheme'
import { supplier, copy } from '@/components/admin/media/__tests__/fixtures'
import type { User } from '@/types'
import '@/style.css'
import '@/styles/site-theme.css'

const query = new URLSearchParams(location.search)
const scenario = query.get('scenario') ?? 'PASS'
const dto = supplier(77, ['UI_FIXABLE', 'NEEDS_DEVELOPMENT', 'VALUE_MAPPING'].includes(scenario) ? 'FAIL' : scenario === 'UNKNOWN' ? 'UNKNOWN' : 'PASS')
const fixtureCalls: { method: string; url: string; input: unknown }[] = []
Object.assign(window, { mediaFixture: { calls: fixtureCalls, snapshot: () => copy(dto) } })
if (scenario.startsWith('WIZARD')) {
  const product = dto.media_workbench_v1!.draft.products[0]!
  dto.effective_sales = false; dto.effective_state = 'SALES_PAUSED'
  dto.media_workbench_v1!.sales.enabled = false
  dto.media_workbench_v1!.adapter_bindings = { image: { kind: 'openai_images', revision: 'openai_images_v1', auth: 'account_apikey', task_flow: 'sync' } }
  product.display_name = '晴空创作图片'
  product.capabilities.resolutions = ['1K', '2K', '4K']
  product.capabilities.count = { min: 1, max: 10 }
  product.capabilities.references.image = { min: 0, max: scenario === 'WIZARD_ZERO' ? 4 : 0 }
  product.capabilities.references.total_max = 0
  product.pricing_rules = []
  product.adapter_config = { version: 1, model_family: 'openai_json', execution: { mode: 'native_multi', max_output_images: 2 }, edit_execution: { mode: 'single', max_output_images: 1 }, size_mappings: ['1K', '2K', '4K'].flatMap((resolution, i) => ['1:1', '16:9'].map(aspect_ratio => ({ resolution, aspect_ratio, wire_size: aspect_ratio === '1:1' ? `${1024 * (i + 1)}x${1024 * (i + 1)}` : `${1024 * (i + 1)}x${576 * (i + 1)}` }))) }
  if (scenario === 'WIZARD_DENY') product.capabilities.combination_rules = [{ deny: { resolution: ['4K'], aspect_ratio: ['16:9'] } }]
  if (scenario === 'WIZARD_UNSUPPORTED') {
    dto.platform = 'grok'
    dto.media_workbench_v1!.adapter_bindings.image!.kind = 'unbound_image'
    dto.media_workbench_v1!.validation = { ...dto.media_workbench_v1!.validation, status: 'FAIL', publish_ready: false, diagnostics: [{ class: 'NEEDS_DEVELOPMENT', severity: 'error', code: 'BUILDER_REFACTOR_REQUIRED', scope: product.product_id, path: 'draft.products[0].adapter_config', message: '当前 Account 没有可用图片适配器', action: '需要技术适配，不能通过填写协议名称启用' }] }
  }
}
const navigationAccounts = Array.from({ length: 46 }, (_, index) => {
  const account = supplier(index + 1)
  account.name = `账号 ${account.id}`
  account.host = account.id === 46 ? '' : `source-${Math.floor(index / 15) + 1}.example.invalid`
  account.platform = account.id % 2 ? 'openai' : 'gemini'
  account.effective_state = account.id % 2 ? 'SELLING' : 'SALES_PAUSED'
  account.effective_sales = account.id % 2 === 1
  if ([15, 25].includes(account.id)) { account.media_workbench_v1 = null; account.effective_state = 'NOT_INITIALIZED'; account.effective_sales = false }
  return account
})
if (scenario === 'NEEDS_DEVELOPMENT') Object.assign(dto.media_workbench_v1!.validation.diagnostics[0]!, { class: 'NEEDS_DEVELOPMENT', code: 'UNSUPPORTED_REFERENCE_FLOW', message: '当前适配器还不能表达首尾帧参数', action: '请开发共享请求构造能力' })
if (scenario === 'PAUSED') { dto.effective_sales = false; dto.effective_state = 'SALES_PAUSED'; dto.media_workbench_v1!.sales.enabled = false }
if (scenario === 'UPSTREAM_MISSING') { dto.models[0]!.state = 'UPSTREAM_NOT_DISCOVERED'; dto.media_workbench_v1!.validation.publish_ready = false }
if (['SELLING', 'PUBLISHED_NOT_READY', 'ACCOUNT_RUNTIME_BLOCKED'].includes(scenario)) { dto.effective_state = scenario; dto.effective_sales = scenario === 'SELLING' }
if (scenario === 'VALUE_MAPPING') Object.assign(dto.media_workbench_v1!.validation.diagnostics[0]!, {
  code: 'MISSING_VALUE_MAPPING', path: 'draft.products[0].adapter_config.size_mappings',
  message: '分辨率和比例缺少供应商尺寸映射', action: '填写供应商尺寸映射后保存草稿'
})
// All shell and media API requests terminate in this local Axios adapter.
apiClient.defaults.adapter = async config => {
  const url = config.url ?? ''
  const input = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
  fixtureCalls.push({ method: config.method ?? 'get', url, input })
  let data: unknown = {}
  if (url === '/admin/media-workbench/suppliers') data = scenario === 'NAVIGATION' ? copy(navigationAccounts) : [copy(dto), supplier(44)]
  else if (url.startsWith('/admin/media-workbench/accounts/')) {
    if (config.method !== 'get' && (scenario === 'DELETED' || scenario === 'STALE')) {
      const status = scenario === 'DELETED' ? 410 : 409
      throw { isAxiosError: true, config, response: { status, data: { code: 'FIXTURE_ERROR', message: 'Deterministic fixture' } } }
    }
    if (url.endsWith('/draft')) {
      dto.media_workbench_v1!.draft.products = input.draft.products
      dto.media_workbench_v1!.record_version++
      dto.media_workbench_v1!.draft.revision = `fixture_${dto.media_workbench_v1!.record_version}`
      dto.media_workbench_v1!.validation.draft_revision = dto.media_workbench_v1!.draft.revision
      // Deterministic UI fixture only. Real validation is covered separately by Core tests.
      if (scenario.startsWith('WIZARD') && scenario !== 'WIZARD_UNSUPPORTED') {
        const complete = dto.media_workbench_v1!.draft.products.every(product => product.pricing_rules.length && product.pricing_rules.every(rule => rule.sale_price != null))
        dto.media_workbench_v1!.validation.status = complete ? 'PASS' : 'FAIL'
        dto.media_workbench_v1!.validation.publish_ready = complete
      }
    }
    if (url.endsWith('/sales')) { dto.media_workbench_v1!.sales.enabled = input.enabled; dto.effective_sales = input.enabled; dto.media_workbench_v1!.record_version++ }
    data = scenario === 'NAVIGATION' ? copy(navigationAccounts.find(account => account.id === Number(url.split('/')[4]))) : copy(dto)
  } else if (url === '/announcements') data = []
  else if (url === '/keys') data = { items: [], pages: 1, total: 0 }
  else if (url.includes('settings')) data = { site_name: 'Media UI fixture', ops_monitoring_enabled: false }
  return { config, status: 200, statusText: 'OK', headers: {}, data: { code: 0, message: '', data } }
}
localStorage.setItem('sub2api_locale', 'zh')
i18n.global.locale.value = 'zh'
localStorage.setItem('admin_guide_1_admin_v4_interactive', 'true')
localStorage.setItem('theme', query.get('mode') ?? 'light')
initSiteTheme()
const theme = siteThemeOptions.find(option => option.value === query.get('theme'))?.value
if (theme) setSiteTheme(theme)
if (query.get('blueArtwork')) setSidebarStyle(query.get('blueArtwork') as SidebarStyle)
if (query.get('yellowArtwork')) setYellowSidebarStyle(query.get('yellowArtwork') as YellowSidebarStyle)
document.documentElement.classList.toggle('dark', query.get('mode') === 'dark')
const pinia = createPinia()
const app = createApp({ render: () => h(RouterView) })
app.use(pinia)
const auth = useAuthStore()
auth.user = { id: 1, username: 'Fixture Admin', role: 'admin', balance: 0, status: 'active' } as User
const appStore = useAppStore()
appStore.publicSettingsLoaded = true
appStore.siteName = 'Media UI fixture'
const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/media', component: MediaWorkbenchView, meta: { title: '媒体工作台' } }, { path: '/:pathMatch(.*)*', component: { render: () => h('div', 'Fixture destination') } }] })
await initI18n()
app.use(i18n); app.use(router)
await router.push('/admin/media'); await router.isReady()
app.mount('#app')
