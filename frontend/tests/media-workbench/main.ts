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
import { supplier, copy, draftManagementSupplier } from '@/components/admin/media/__tests__/fixtures'
import type { User } from '@/types'
import { draftInput } from '@/api/admin/mediaWorkbench'
import { encodeDraftRecovery, recoveryCopyKey } from '@/composables/draftRecovery'
import '@/style.css'
import '@/styles/site-theme.css'

const query = new URLSearchParams(location.search)
const scenario = query.get('scenario') ?? 'PASS'
const management = scenario.startsWith('DRAFT_MANAGEMENT')
const videoPolish = scenario === 'VIDEO_POLISH'
const initialDTO = management || videoPolish ? draftManagementSupplier(scenario.includes('VIDEO') ? 'video' : 'image') : supplier(77, ['UI_FIXABLE', 'NEEDS_DEVELOPMENT', 'VALUE_MAPPING'].includes(scenario) ? 'FAIL' : scenario === 'UNKNOWN' ? 'UNKNOWN' : 'PASS')
if (scenario.endsWith('_SINGLE')) initialDTO.media_workbench_v1!.draft.products.splice(1)
const persistent = management || videoPolish || scenario.startsWith('WIZARD')
const savedFixture = persistent ? sessionStorage.getItem(scenario) : null
const dto = savedFixture ? JSON.parse(savedFixture) as typeof initialDTO : initialDTO
const otherAccount = supplier(44)
if (videoPolish && !savedFixture) {
  const product = dto.media_workbench_v1!.draft.products[0]!
  product.capabilities.resolutions = ['720p', '1080p', '4K']
  product.capabilities.aspect_ratios = ['9:16', '3:4', '1:1', '4:3', '3:2', '16:9']
  product.capabilities.durations_seconds = Array.from({ length: 27 }, (_, i) => i + 4)
  product.capabilities.references.image = { min: 0, max: 10 }
  product.capabilities.references.total_max = 10
  product.pricing_rules = [
    { match: { resolution: ['720p'], duration_seconds: [4] }, sale_price: { amount: '1', currency: 'CNY', billing_mode: 'per_request' } },
    { match: { resolution: ['720p'], duration_seconds: [5] }, sale_price: { amount: '2', currency: 'CNY', billing_mode: 'per_request' } },
    { match: { resolution: ['720p'], duration_seconds: product.capabilities.durations_seconds.slice(2) }, sale_price: null },
    { match: { resolution: ['1080p', '4K'] }, sale_price: { amount: '4', currency: 'CNY', billing_mode: 'per_request' } }
  ]
  dto.native_adapters = { video: { kind: 'native_video', revision: 'fixture_v1', auth: 'account_apikey', task_flow: 'async', media_type: 'video', max_references: 30, parameters: {} } }
}
// Deterministic recovery fixture: current Product price 3, retained raw text
// still bound to prior source price 1. No real Account or browser data is read.
if (videoPolish && query.get('seedVideoConflict')) {
  const product = dto.media_workbench_v1!.draft.products[0]!
  product.pricing_rules[0]!.sale_price!.amount = '3'
  const identity = { admin_id: 1, account_id: dto.id, product_id: product.product_id, site_model: product.site_model, upstream_model: product.upstream_model }
  const editorId = crypto.randomUUID()
  localStorage.setItem(recoveryCopyKey(identity, editorId)!, encodeDraftRecovery({
    version: 1, identity, editor_id: editorId, copy_id: crypto.randomUUID(), updated_at: Date.now(),
    base_record_version: dto.media_workbench_v1!.record_version, base_draft_revision: dto.media_workbench_v1!.draft.revision,
    product: copy(product), video_sale_inputs: [
      { resolution: '720p', group: {}, duration: 4, amount: '12.', source_price: { amount: '1', currency: 'CNY', billing_mode: 'per_request' }, domain: JSON.stringify(draftInput([product]).products[0]!.capabilities) },
      { resolution: '720p', group: {}, duration: 5, amount: '23.', source_price: { amount: '2', currency: 'CNY', billing_mode: 'per_request' }, domain: JSON.stringify(draftInput([product]).products[0]!.capabilities) }
    ]
  }))
}
if (scenario === 'PUBLICATION_LONG_LIST') dto.models.push(...Array.from({ length: 30 }, (_, i) => ({ model_id: `sample-model-${i + 1}`, state: 'UNCONFIGURED' })))
if (scenario === 'DRAFT_MANAGEMENT_VIDEO_LIMITS') {
  // Browser fixture only: the real model contract remains validated by Core.
  dto.native_adapters = { video: { kind: 'native_video', revision: 'fixture_v1', auth: 'account_apikey', task_flow: 'async', media_type: 'video', max_references: 30, parameters: {} } }
}
const fixtureCalls: { method: string; url: string; input: unknown }[] = []
let nextDraftOutcome: 'reject' | 'hold' | undefined
const detailOutcomes = new Map<number, 'hold' | 'reject'>()
const heldDetails = new Map<number, () => void>()
let releaseDraft: (() => void) | undefined
let releaseSuppliers: (() => void) | undefined
let releasePaidCheck: (() => void) | undefined
let releasePaidApply: (() => void) | undefined
const paidEnabled = { image: true, video: false }
Object.assign(window, { mediaFixture: {
  calls: fixtureCalls, snapshot: () => copy(dto),
  setDraftOutcome: (outcome: 'reject' | 'hold') => { nextDraftOutcome = outcome },
  setDetailOutcome: (id: number, outcome: 'reject' | 'hold') => { detailOutcomes.set(id, outcome) },
  releaseDetail: (id: number) => { heldDetails.get(id)?.(); heldDetails.delete(id) },
  releaseDraft: () => { releaseDraft?.(); releaseDraft = undefined },
  releaseSuppliers: () => { releaseSuppliers?.(); releaseSuppliers = undefined },
  releasePaidCheck: () => { releasePaidCheck?.(); releasePaidCheck = undefined },
  releasePaidApply: () => { releasePaidApply?.(); releasePaidApply = undefined }

} })
if (scenario.startsWith('WIZARD') && !savedFixture) {
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
  if (url.startsWith('/admin/media-workbench/paid-controls/')) {
    const kind = url.includes('/video') ? 'video' : 'image'
    const paidState = () => ({ media: kind, mode: 'managed-v1', requested_enabled: paidEnabled[kind], effective_enabled: paidEnabled[kind], revision: 'fixture-paid-revision', reason: paidEnabled[kind] ? 'open' : query.get('paidStateReason') ?? 'apply_failed' })
    if (url.endsWith('/check')) {
      if (query.get('holdPaidCheck')) await new Promise<void>(resolve => { releasePaidCheck = resolve })
      if (query.get('paidCheck') === 'post-error') throw { code: 'ERR_NETWORK', status: 0 }
      data = { media: kind, pass: query.get('paidCheck') !== 'business-failure', fingerprint: 'fixture-check', checked_at: '2026-10-20T03:00:00Z', checks: [{ code: query.get('paidCheck') === 'business-failure' ? 'published_offer' : 'native_quote', pass: query.get('paidCheck') !== 'business-failure', account_id: 77 }] }
    } else if (config.method === 'put') {
      if (query.get('holdPaidApply')) await new Promise<void>(resolve => { releasePaidApply = resolve })
      if (query.get('paidApply') === 'timeout') throw { code: 'ECONNABORTED', status: 0 }
      paidEnabled[kind] = input.enabled
      data = { state: paidState() }
    } else {
      if (query.get('paidCheck') === 'status-error' && fixtureCalls.some(call => call.url === `${url}/check`)) throw { status: 503 }
      data = paidState()
    }
  } else if (url === '/admin/media-workbench/suppliers') {
    if (query.get('holdSuppliers')) await new Promise<void>(resolve => { releaseSuppliers = resolve })
    data = scenario === 'NAVIGATION' ? copy(navigationAccounts) : [copy(dto), copy(otherAccount)]
  }
  else if (url.startsWith('/admin/media-workbench/accounts/')) {
    const accountId = Number(url.split('/')[4])
    const account = scenario === 'NAVIGATION' ? navigationAccounts.find(item => item.id === accountId)! : accountId === dto.id ? dto : otherAccount
    if (config.method === 'get' && url === `/admin/media-workbench/accounts/${accountId}`) {
      const outcome = detailOutcomes.get(accountId)
      detailOutcomes.delete(accountId)
      if (outcome === 'reject') throw { isAxiosError: true, config, response: { status: 503, data: { code: 'FIXTURE_DETAIL_REJECTED', message: 'Deterministic detail failure' } } }
      if (outcome === 'hold') await new Promise<void>(resolve => { heldDetails.set(accountId, resolve) })
    }
    if (config.method !== 'get' && (scenario === 'DELETED' || scenario === 'STALE')) {
      const status = scenario === 'DELETED' ? 410 : 409
      throw { isAxiosError: true, config, response: { status, data: { code: 'FIXTURE_ERROR', message: 'Deterministic fixture' } } }
    }
    if (url.endsWith('/draft')) {
      // Control one response without disabling autosave or changing application state.
      const outcome = nextDraftOutcome
      nextDraftOutcome = undefined
      if (outcome === 'reject') throw { isAxiosError: true, config, response: { status: 422, data: { code: 'FIXTURE_DRAFT_REJECTED', message: 'Deterministic draft rejection' } } }
      if (outcome === 'hold') await new Promise<void>(resolve => { releaseDraft = resolve })
      const current = account.media_workbench_v1!
      if (input.expected_record_version !== current.record_version) {
        throw { isAxiosError: true, config, response: { status: 409, data: { code: 'RECORD_VERSION_CONFLICT', message: 'Fixture CAS conflict' } } }
      }
      const baseVersion = current.record_version
      current.draft.products = copy(input.draft.products)
      if (management) {
        dto.product_removal = Object.fromEntries(dto.media_workbench_v1!.draft.products.map(p => [p.product_id, {
          allowed: p.product_id !== 'canvas-1' && p.capabilities.resolutions.length === 0 && p.pricing_rules.length === 0,
          reason: p.product_id === 'canvas-1' ? '已发布，不能移除。' : ''
        }]))
      }
      current.record_version++
      current.draft.revision = `fixture_${current.record_version}`
      if (videoPolish) current.draft.updated_at = '2026-10-20T03:24:00Z'
      // Match the real draft acknowledgement/readback contract, not a generic HTTP 200.
      current.draft.save_receipt = input.submission_id && scenario !== 'WIZARD_MISSING_RECEIPT' ? {
        submission_id: input.submission_id, base_record_version: baseVersion, draft_revision: current.draft.revision
      } : undefined
      current.validation.draft_revision = current.draft.revision
      // Deterministic UI fixture only. Real validation is covered separately by Core tests.
      if (scenario.startsWith('WIZARD') && scenario !== 'WIZARD_UNSUPPORTED') {
        const complete = current.draft.products.every(product => product.pricing_rules.length && product.pricing_rules.every(rule => rule.sale_price != null))
        current.validation.status = complete ? 'PASS' : 'FAIL'
        current.validation.publish_ready = complete
      }
    }
    if (url.endsWith('/sales')) { account.media_workbench_v1!.sales.enabled = input.enabled; account.effective_sales = input.enabled; account.media_workbench_v1!.record_version++ }
    if (persistent && config.method !== 'get' && account.id === dto.id) sessionStorage.setItem(scenario, JSON.stringify(dto))
    data = copy(account)
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
