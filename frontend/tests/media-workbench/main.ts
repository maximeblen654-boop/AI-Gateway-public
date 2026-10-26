// Browser-only fixture entry. This is never imported by the application entry.
import { createApp, h } from 'vue'
import axios from 'axios'
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
const mediaTypes = scenario.startsWith('MEDIA_TYPES_')
const initialDTO = management || videoPolish ? draftManagementSupplier(scenario.includes('VIDEO') ? 'video' : 'image') : supplier(77, ['UI_FIXABLE', 'NEEDS_DEVELOPMENT', 'VALUE_MAPPING'].includes(scenario) ? 'FAIL' : scenario === 'UNKNOWN' ? 'UNKNOWN' : 'PASS')
if (scenario.startsWith('MODEL_BINDING')) {
  const c = initialDTO.media_workbench_v1!, current = c.draft.products[0]!
  current.upstream_model = 'new-model'
  current.pricing_rules[0]!.sale_price!.amount = '9.00'
  const second = copy(current); second.product_id = 'second-product'; second.upstream_model = 'other-retired-model'; second.display_name = '另一旧型号商品'
  c.draft.products.push(second)
  initialDTO.model_catalog = { source: 'upstream', synced_at: new Date().toISOString(), models: ['new-model', 'existing-model'] }
  initialDTO.models = [{ model_id: 'new-model', state: 'DRAFT' }, { model_id: 'existing-model', state: 'PENDING' }, { model_id: 'image-native-1', state: 'UPSTREAM_NOT_DISCOVERED' }, { model_id: 'other-retired-model', state: 'UPSTREAM_NOT_DISCOVERED' }]
  initialDTO.model_catalog_change = { schema_version: 1, detected_at: new Date().toISOString(), previous_synced_at: new Date().toISOString(), added_count: 1, missing_count: 2, added_models: ['new-model'], missing_models: ['image-native-1', 'other-retired-model'], truncated: false }
  c.product_lifecycle = { 'canvas-1': { state: 'unlisted', revision: 1, updated_at: new Date().toISOString() } }
}
if (scenario.endsWith('_SINGLE')) initialDTO.media_workbench_v1!.draft.products.splice(1)
if (scenario === 'SALES_CATEGORIES') {
  initialDTO.host = 'api.image2pro.top'
  const config = initialDTO.media_workbench_v1!, original = config.draft.products[0]!
  const names = ['晴空图片', '流光创作', '新建创作商品', '旧款图片商品', '暂停的创作商品', '待核对的上游商品', '已收起的旧商品']
  const states = ['READY', 'READY', 'NOT_PUBLISHED', 'UNLISTED', 'UNLISTED', 'UPSTREAM_REMOVED', 'ARCHIVED']
  config.draft.products = names.map((display_name, index) => ({ ...copy(original), product_id: `sales-category-product-${index}`, display_name }))
  initialDTO.product_states = config.draft.products.map((product, index) => ({
    product_id: product.product_id, display_name: product.display_name, upstream_model: product.upstream_model, media_type: product.media_type,
    published: states[index] !== 'NOT_PUBLISHED', published_ready: states[index] === 'READY', state: states[index]!,
    reason: ({ READY: '此商品的已发布配置及账号销售条件满足。', UNLISTED: '商品已手动下架。', NOT_PUBLISHED: '此商品尚未发布；草稿保存不代表可售。', UPSTREAM_REMOVED: '上次成功目录中未找到此型号。', ARCHIVED: '商品已收起，配置仍然保留。' } as Record<string, string>)[states[index]!]!,
    action: ({ READY: '实际使用仍需全局开关与客户权限通过。', UNLISTED: '核对商品后，可通过重新上架操作恢复。', NOT_PUBLISHED: '补齐规格和售价，再选择此商品发布。', UPSTREAM_REMOVED: '先同步上游目录，再核对模型是否更名；不会自动删除商品。', ARCHIVED: '需要继续使用时，先恢复显示，再核对重新上架条件。' } as Record<string, string>)[states[index]!]!
  }))
}
const persistent = management || videoPolish || mediaTypes || scenario.startsWith('WIZARD')
const savedFixture = persistent ? sessionStorage.getItem(scenario) : null
const dto = savedFixture ? JSON.parse(savedFixture) as typeof initialDTO : initialDTO
const otherAccount = supplier(44)
if (mediaTypes) {
  // Synthetic legacy state only: the catalog name never grants a media type.
  // Account 44 deliberately has the same model and product IDs but image only.
  const legacyAccount = (account: typeof dto, videoAdapter: boolean) => {
    const config = account.media_workbench_v1!
    const image = copy(config.draft.products[0]!)
    image.display_name = `Account ${account.id} 原有图片商品`
    image.site_model = 'gpt-image-2.0'
    image.upstream_model = 'gpt-image-2.0'
    const seedance = copy(image)
    seedance.product_id = 'seedance-misclassified'
    seedance.site_model = 'seedance-video-offer'
    seedance.display_name = `Account ${account.id} Seedance 误分类草稿`
    seedance.upstream_model = 'Seedance2.0'
    seedance.enabled = false
    seedance.capabilities = {
      resolutions: ['720p', '1080p'], aspect_ratios: ['16:9', '9:16'], qualities: [], durations_seconds: [],
      count: { min: 1, max: 1 }, references: { image: { min: 0, max: 2 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 2 }, combination_rules: []
    }
    seedance.pricing_rules = [{ match: {}, sale_price: { amount: '4', currency: 'CNY', billing_mode: 'per_request' } }]
    seedance.adapter_config = { size_mappings: [] }
    config.media_types = ['image']
    config.adapter_bindings = { image: { kind: 'openai_images', revision: 'fixture_images_v1', auth: 'account_apikey', task_flow: 'sync' } }
    config.draft.products = [image, seedance]
    config.published!.products = [copy(image)]
    config.published!.offers = [{ product_id: image.product_id, offer_id: `fixture-frozen-image-${account.id}` }]
    account.name = videoAdapter ? '历史图片配置 · 双媒体接口' : '仅图片接口 · 同名 Seedance 反例'
    account.native_adapters = { image: { ...config.adapter_bindings.image!, media_type: 'image', max_references: 4, parameters: {} } }
    if (videoAdapter) account.native_adapters.video = { kind: 'image2pro_video', revision: 'fixture_video_v1', auth: 'account_apikey', task_flow: 'async', media_type: 'video', max_references: 30, parameters: {} }
    account.model_catalog = { source: 'upstream', synced_at: '2026-10-22T00:00:00Z', models: ['gpt-image-2.0', 'Seedance2.0'] }
    account.models = [{ model_id: 'gpt-image-2.0', state: 'PUBLISHED' }, { model_id: 'Seedance2.0', state: 'DRAFT' }]
    account.discovered_count = 2; account.configured_count = 2; account.pending_count = 0
    account.product_removal = { [image.product_id]: { allowed: false, reason: '已发布，不能移除。' }, [seedance.product_id]: { allowed: false, reason: '已有规格和售价。' } }
  }
  if (!savedFixture) legacyAccount(dto, scenario === 'MEDIA_TYPES_MIXED_ADAPTERS')
  legacyAccount(otherAccount, false)
}
if (scenario === 'ADMIN_READABLE') {
  dto.media_workbench_v1!.published!.published_at = '2026-10-20T01:08:00Z'
  dto.media_workbench_v1!.published!.revision = 'mwp_private_opaque_long_revision'
  dto.media_workbench_v1!.draft.products[0]!.display_name = '新供应商图片（隔离配置）'
  dto.media_workbench_v1!.validation.diagnostics = [{ class: 'NEEDS_DEVELOPMENT', severity: 'error', code: 'IMAGE2PRO_VIDEO_METADATA_REQUIRED', scope: 'canvas-1', path: 'adapter_config.image2pro', message: 'opaque_wire_profile_very_long_revision', action: 'internal_action_only' }]
}

if (scenario === 'MODEL_ISSUES_TOP') {
  const product = dto.media_workbench_v1!.draft.products[0]!
  product.media_type = 'video'
  dto.models[0]!.state = 'NEEDS_DEVELOPMENT'
  dto.media_workbench_v1!.validation = { ...dto.media_workbench_v1!.validation, status: 'FAIL', publish_ready: false, diagnostics: [{ class: 'NEEDS_DEVELOPMENT', severity: 'error', code: 'FIXTURE_REAL_CAPABILITY_UNSUPPORTED', scope: product.product_id, path: 'adapter_config.wire_profile', message: '当前商品的视频能力需要技术适配', action: '复制当前商品说明核查' }] }
}

if (scenario.startsWith('MODEL_DIAGNOSTIC_')) {
  const product = dto.media_workbench_v1!.draft.products[0]!
  product.media_type = scenario.endsWith('VIDEO') ? 'video' : 'image'
  if (product.media_type === 'video') product.capabilities.durations_seconds = [4, 8]
  dto.models[0]!.state = 'UPSTREAM_NOT_DISCOVERED'
  dto.model_catalog = { source: 'upstream', synced_at: '2026-10-22T00:00:00Z', models: ['new-model'] }
  dto.media_workbench_v1!.adapter_bindings = { image: { kind: 'openai_images', revision: 'fixture', auth: 'account_apikey', task_flow: 'sync' } }
  dto.media_workbench_v1!.validation = { ...dto.media_workbench_v1!.validation, status: 'FAIL', publish_ready: false, diagnostics: [{ class: 'UI_FIXABLE', severity: 'error', code: 'MODEL_NOT_DISCOVERED', scope: product.product_id, path: 'upstream_model', message: 'Upstream model is absent from the last successful snapshot', action: 'Edit the indicated Draft field and save again' }] }
}

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
if (scenario === 'PUBLICATION_LONG_LIST') { const extra=Array.from({ length: 30 }, (_, i) => ({ model_id: `sample-model-${i + 1}`, state: 'UNCONFIGURED' })); dto.models.push(...extra);dto.model_catalog!.models.push(...extra.map(m=>m.model_id)) }
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
if (scenario === 'CURRENT_UPSTREAM_NAMES') {
 dto.model_catalog={source:'upstream',synced_at:'2026-10-21T07:32:00Z',models:['gpt-image-2.0','gpt-image-2.0-原生4K']}
 dto.models=[{model_id:'image-native-1',state:'UPSTREAM_NOT_DISCOVERED'},{model_id:'gpt-image-2.0',state:'PENDING'},{model_id:'gpt-image-2.0-原生4K',state:'PENDING'}]
}
if (['CATALOG_CHANGE', 'CATALOG_DELAYED', 'CATALOG_BASELINE', 'CATALOG_RETIRED', 'CATALOG_INCOMPLETE'].includes(scenario)) {
  const now = new Date()
  const success = new Date(now.getTime() - (scenario === 'CATALOG_DELAYED' ? 11 : 1) * 60_000).toISOString()
  dto.host = 'api.image2pro.top'
  dto.model_catalog = { source: 'upstream', synced_at: success, models: ['gpt-image-2.0', 'video-new-id'] }
  dto.model_catalog_change = { schema_version: 1, detected_at: success, previous_synced_at: new Date(now.getTime() - 16 * 60_000).toISOString(), added_count: 2, missing_count: 2, added_models: ['gpt-image-2.0', 'video-new-id'], missing_models: ['image-native-1', 'video-old-id'], truncated: false }
  dto.models = [{ model_id: 'image-native-1', state: 'UPSTREAM_NOT_DISCOVERED' }, { model_id: 'gpt-image-2.0', state: 'PENDING' }, { model_id: 'video-new-id', state: 'PENDING' }]
  dto.product_states = [
    { product_id: 'canvas-1', display_name: '隔离图片商品', upstream_model: 'image-native-1', media_type: 'image', published: true, published_ready: false, state: 'UPSTREAM_REMOVED', reason: '本次目录未返回此型号', action: '先核对目录及文档，不猜替代型号' },
    { product_id: 'fixture-video', display_name: '隔离视频商品', upstream_model: 'video-old-id', media_type: 'video', published: true, published_ready: false, state: 'UPSTREAM_REMOVED', reason: '本次目录未返回此型号', action: '先核对目录及文档，不猜替代型号' }
  ]
}
if (scenario === 'CATALOG_RETIRED') {
  dto.product_states![0]!.state = 'UNLISTED'
  dto.product_states![1]!.state = 'ARCHIVED'
}
if (scenario === 'CATALOG_INCOMPLETE') delete dto.product_states
if (scenario === 'CATALOG_BASELINE') delete dto.model_catalog_change
if (['SELLING', 'PUBLISHED_NOT_READY', 'ACCOUNT_RUNTIME_BLOCKED'].includes(scenario)) { dto.effective_state = scenario; dto.effective_sales = scenario === 'SELLING' }
if (scenario === 'VALUE_MAPPING') Object.assign(dto.media_workbench_v1!.validation.diagnostics[0]!, {
  code: 'MISSING_VALUE_MAPPING', path: 'draft.products[0].adapter_config.size_mappings',
  message: '分辨率和比例缺少供应商尺寸映射', action: '填写供应商尺寸映射后保存草稿'
})
// All shell and media API requests terminate in this local Axios adapter.
apiClient.defaults.adapter = async config => {
  const url = config.url ?? ''
  // Opt-in diagnostic-script regression: preserve the actual Axios GET
  // interceptor and XHR path; Playwright supplies only these local responses.
  if (query.get('networkPaidReads') === '1' && config.method === 'get' && /^\/admin\/media-workbench\/paid-controls\/(image|video)$/.test(url)) return axios.getAdapter('xhr')(config)
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
    if (url.endsWith('/model-binding')) {
      // Canned browser response only; real atomic writes are tested in Go.
      const input = JSON.parse(config.data) as { action: string; new_model_id?: string }
      if (!scenario.startsWith('MODEL_BINDING') || input.action !== 'rebind' || input.new_model_id !== 'new-model') throw new Error('Unexpected browser binding fixture request')
      if (scenario === 'MODEL_BINDING_REJECT') {
        const receipt = copy(account)
        const candidate = copy(account.media_workbench_v1!.published!.products![0]!)
        candidate.upstream_model = 'new-model'; candidate.media_type = 'video'
        receipt.binding_validation_products = [candidate]
        receipt.publish_validation = { draft_revision: account.media_workbench_v1!.draft.revision, checked_at: '2026-10-26T09:52:44Z', status: 'FAIL', publish_ready: false, diagnostics: [{ class: 'NEEDS_DEVELOPMENT', severity: 'error', code: 'FIXTURE_REAL_CAPABILITY_UNSUPPORTED', scope: candidate.product_id, path: 'adapter_config.wire_profile', message: '新型号所需的视频能力尚未接入', action: '复制当前商品技术说明核查' }] }
        throw { isAxiosError: true, config, response: { status: 422, data: { code: 'MODEL_BINDING_VALIDATION_FAILED', message: 'Model binding validation failed; no changes were saved', data: receipt } } }
      }
      account.media_workbench_v1!.record_version++
      account.media_workbench_v1!.published!.products![0]!.upstream_model = 'new-model'
      data = copy(account)
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
      if (mediaTypes) {
        // Match SaveDraft's union from explicit submitted types in this scenario.
        // Merely discovering a native adapter must not rewrite stored config.
        for (const product of current.draft.products) {
          if (['image', 'video'].includes(product.media_type) && !current.media_types.includes(product.media_type)) current.media_types.push(product.media_type)
        }
      }
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
