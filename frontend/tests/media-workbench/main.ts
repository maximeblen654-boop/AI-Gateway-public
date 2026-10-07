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
  let data: unknown = {}
  if (url === '/admin/media-workbench/suppliers') data = [copy(dto), supplier(44)]
  else if (url.startsWith('/admin/media-workbench/accounts/')) {
    if (config.method !== 'get' && (scenario === 'DELETED' || scenario === 'STALE')) {
      const status = scenario === 'DELETED' ? 410 : 409
      throw { isAxiosError: true, config, response: { status, data: { code: 'FIXTURE_ERROR', message: 'Deterministic fixture' } } }
    }
    if (url.endsWith('/draft')) {
      dto.media_workbench_v1!.draft.products = input.draft.products
      dto.media_workbench_v1!.record_version++
    }
    if (url.endsWith('/sales')) { dto.media_workbench_v1!.sales.enabled = input.enabled; dto.effective_sales = input.enabled; dto.media_workbench_v1!.record_version++ }
    data = copy(dto)
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
