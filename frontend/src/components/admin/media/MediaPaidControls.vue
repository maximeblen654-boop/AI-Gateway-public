<template>
  <section class="mw-paid-panel mw-panel" aria-label="客户付费生成开关">
    <header><div><h2>客户生成服务</h2><p class="mw-muted">商品发布、Account 销售和全局付费提交分别管理。开启前检查不生成作品、不扣费。全局开关开放不代表每个商品或每个客户均可生成。</p></div><button class="btn btn-secondary" :disabled="busy" @click="refresh()">刷新状态</button></header>
    <p class="mw-muted">本开关只控制 Studio 付费提交，不修改独立 API Key 的原生权限、路由或受保护图片任务接口的访问限制。</p>
    <p v-if="error" role="alert" class="mw-paid-error">{{ error }}</p>
    <div class="mw-paid-grid">
      <article v-for="kind in kinds" :key="kind" :data-test="`paid-${kind}`" :data-phase="phase(kind)" :aria-busy="pending === `check-${kind}` || pending === `apply-${kind}`">
        <h3>{{ label(kind) }}付费生成</h3>
        <p class="mw-paid-state" :class="{ 'is-open': knownState(kind) && states[kind]?.effective_enabled }">{{ knownState(kind) ? (states[kind]?.effective_enabled ? '实际已开放' : '实际未开放') : '状态未确认' }}</p>
        <p class="mw-muted">{{ !knownState(kind) ? '请求状态未确认' : states[kind]?.requested_enabled ? '已请求开启' : '未请求开启' }} · {{ reason(states[kind]?.reason) }}</p>
        <p v-if="kind === 'image'" class="mw-muted">文生图与图生图共用此开关，视频独立控制。</p>
        <div class="mw-paid-actions">
          <button class="btn btn-secondary" :disabled="busy || suppliersLoading || states[kind]?.mode !== 'managed-v1'" @click="check(kind)">{{ pending === `check-${kind}` ? '正在检查…' : '开启前检查' }}</button>
          <button class="btn btn-primary" :disabled="busy || !canEnable(kind)" @click="confirmKind = kind">开启{{ label(kind) }}</button>
          <button class="btn btn-secondary" :disabled="busy || !knownState(kind) || !states[kind]?.requested_enabled" @click="apply(kind, false)">关闭提交</button>
        </div>
        <p v-if="suppliersLoading" class="mw-muted" role="status">供应商列表仍在读取，请等待完成后执行开启前检查。</p>
        <p v-if="pending === `check-${kind}`" class="mw-muted" role="status">正在执行完整检查，本次最多等待 {{ PAID_CHECK_TIMEOUT_MS / 1000 }} 秒；检查不会开启提交。超时后需要重新检查，不能从状态页恢复未返回的报告。</p>
        <p v-if="pending === `apply-${kind}`" class="mw-muted" role="status" data-test="paid-applying">正在提交并核对生效状态；开启时会再次执行完整检查，最多等待 {{ PAID_CHECK_TIMEOUT_MS / 1000 }} 秒。服务器确认前请勿重复操作。</p>
        <div v-if="reports[kind]" class="mw-paid-checks" aria-live="polite">
          <strong>{{ reportSummary(kind) }}</strong>
          <details :open="!reports[kind]?.pass || !checkedRevisions[kind] || partial(kind)"><summary>检查明细（{{ reports[kind]?.checks.length }} 项）</summary><ul><li v-for="(item, index) in reports[kind]?.checks" :key="index"><span>{{ item.pass ? '✓' : '×' }}</span><span>{{ checkLabel(item) }}<small v-if="item.account_id">Account #{{ item.account_id }}<template v-if="checkProductName(item)"> · {{ checkProductName(item) }}</template><template v-if="pathLabel(item.path)"> · {{ pathLabel(item.path) }}</template></small><small v-if="!item.pass && productGuidance(item)">{{ productGuidance(item) }}</small></span></li></ul></details>
        </div>
      </article>
    </div>
    <ConfirmDialog :show="confirmKind !== null" :title="`开启${label(confirmKind || 'image')}付费生成`" :message="partial(confirmKind || 'image') ? '部分商品不可用。开启后仅通过检查的商品可以继续核验客户原生权限并提交；失败商品保持不可用。不会发布草稿或改变其他类型。' : '将允许通过商品检查和客户原生权限核验的真实付费提交。不会发布商品、改价或打开另一类型；服务端会再次检查。'" confirm-text="确认开启" @cancel="confirmKind = null" @confirm="confirmOpen" />
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { mediaPaidAPI, paidFailureMessage, PAID_CHECK_TIMEOUT_MS, type PaidMedia, type PaidReport, type PaidState, type PaidCheck } from '@/api/admin/mediaPaid'
import type { SupplierDetail } from '@/api/admin/mediaWorkbench'
const props = withDefaults(defineProps<{ suppliers?: SupplierDetail[]; suppliersLoading?: boolean }>(), { suppliers: () => [], suppliersLoading: false })
const kinds: PaidMedia[] = ['image', 'video']
const states = ref<Partial<Record<PaidMedia, PaidState>>>({})
const reports = ref<Partial<Record<PaidMedia, PaidReport>>>({})
// A report is eligible for confirmation only after its own follow-up status
// succeeds, and until a refresh or an observed dependency change invalidates it.
const checkedRevisions = ref<Partial<Record<PaidMedia, { revision: string }>>>({})
const dependencyVersions: Record<PaidMedia, number> = { image: 0, video: 0 }
const invalidationMessages = ref<Partial<Record<PaidMedia, string>>>({})
const pending = ref('')
const busy = computed(() => pending.value !== '')
const error = ref('')
const unconfirmedApply = ref<Partial<Record<PaidMedia, boolean>>>({})
const confirmKind = ref<PaidMedia | null>(null)
const label = (kind: PaidMedia) => kind === 'image' ? '图片' : '视频'
function phase(kind: PaidMedia) {
  if (pending.value === `check-${kind}`) return 'checking'
  if (pending.value === `apply-${kind}`) return 'applying'
  if (unconfirmedApply.value[kind] || !knownState(kind)) return 'unconfirmed'
  if (states.value[kind]?.effective_enabled) return 'confirmed-effective'
  return canEnable(kind) ? 'check-passed' : 'closed'
}
const reasons: Record<string, string> = { runtime_restarted: '服务已重启，需要重新检查开启', deployment_mode: '当前部署尚未启用管理员开关模式', closed: '提交关闭', open: '运行状态已核对', dependencies_changed: '原付费准入依赖已变化，提交关闭；需重新检查并确认开启', dependencies_unavailable: '依赖检查不可用，提交关闭', state_unavailable: '无法读取运行状态', apply_failed: '生效失败，提交关闭', no_approved_offer: '没有仍有效的已核准商品，需要重新检查', revision_changed: '开关版本已变化，需要重新检查' }
const invalidCheckReasons = new Set(['dependencies_unavailable', 'revision_changed', 'deployment_mode'])
const reason = (code?: string) => code && Object.prototype.hasOwnProperty.call(reasons, code) ? reasons[code] : '等待服务端核对'
const checks: Record<string, string> = { model_catalog: '上游模型目录更新尚未确认，请同步目录后重新检查', quote_model_catalog: '上游模型目录更新尚未确认，不能签发新报价', quote_account_quota_requires_cost: '此 Account 设置了金额额度，工作台采购成本未知，暂不可用；请使用无金额额度的账号，不会自动修改配置', native_account: '原生 Account 可用状态', published_offer: '至少一个已发布商品通过检查', check_timeout: '检查超时', check_cancelled: '检查已取消', dependencies_unavailable: '依赖不可用', sidecar_runtime: 'Core / Bridge / BFF 运行合同', customer_key: '当前管理员的工作台访问权限', customer_key_network_restricted: '工作台 Key 有网络限制，尚不能确认报价权限', billing_eligibility: '原生余额、订阅及权限', customer_quota: '原生 Key 配额', subscription: '订阅状态', private_result_storage: '私有结果存储', published_specs: '已发布规格与正数售价', spec_compilation_and_assets: '规格编译与私有素材', native_quote: '原生非付费报价', quote_account_admission: '账号运行准入未通过：核对 Group、模型映射、调度及运行限制', quote_published_offer: '发布依赖和报价规格', quote_binding: '原生报价绑定（旧版诊断）', quote_unknown: '报价检查原因未分类，请联系管理员核对服务端诊断', quote_request: '报价请求身份或请求大小不符合要求', quote_model_permission: '当前 Key 所属 Group 未允许此站点模型', quote_execution: '视频协议或规格不兼容：核对模型、时长、比例及参考素材合同', quote_account: '原生 Account 无法读取', quote_reference_preparation: '参考素材准备状态与当前报价不一致，请重新准备', quote_quote_store: '报价暂存失败，请稍后重试', dependencies_changed: '检查期间配置发生变化', video_reference_or_subscription_quote_requires_existing_preparation: '视频报价需要有效素材准备或受支持的计费合同', deployment_mode: '部署需启用管理员开关模式' }
function checkLabel(item: PaidCheck) {
  if (obsoleteCostChecks.has(item.code)) return '历史检查结果已失效，请重新执行开启前检查'
  if (!item.pass && item.code === 'published_offer') return '没有可用的已发布商品，当前不能开启；请核对商品发布、销售及原生准入状态'
  if (!item.pass && item.code === 'sidecar_runtime') return 'Core / Bridge / BFF 运行合同检查未通过，请核对服务可用性与版本配置'
  if (!item.pass && item.code === 'dependencies_unavailable') return '依赖暂时不可用，当前不能开启；请核对服务运行状态后重新检查'
  if (!item.pass && item.code === 'dependencies_changed') return '检查期间配置发生变化，本次结果已失效，请重新检查'
  return Object.prototype.hasOwnProperty.call(checks, item.code) ? checks[item.code] : '其他服务端检查，请管理员核对诊断'
}
const obsoleteCostChecks = new Set(['quote_workbench_cost', 'quote_account_cost', 'quote_cost_channel_missing', 'quote_cost_rule_missing', 'quote_cost_contract'])
const partial = (kind: PaidMedia) => !!reports.value[kind]?.pass && reports.value[kind]!.checks.some(item => !item.pass)
const checkProductState = (item: PaidCheck) => props.suppliers.find(s => s.id === item.account_id)?.product_states?.find(p => p.product_id === item.product_id)
const pathLabel = (path?: string) => path === 'edit' || path === 'with_references' ? '参考素材路径' : path === 'text' || path === 'without_references' ? '无参考素材路径' : ''
const productGuidance = (item: PaidCheck) => checkProductState(item)?.state === 'UPSTREAM_REMOVED' ? '上游目录未发现此商品模型。先核对并同步目录，再重新检查。' : ''

function knownState(kind: PaidMedia) {
  const state = states.value[kind]
  return !!state && state.media === kind && state.mode === 'managed-v1' &&
    typeof state.requested_enabled === 'boolean' && typeof state.effective_enabled === 'boolean' &&
    typeof state.revision === 'string' && Object.prototype.hasOwnProperty.call(reasons, state.reason) && state.reason !== 'state_unavailable' &&
    (!state.effective_enabled || state.requested_enabled)
}
function canEnable(kind: PaidMedia) {
  const state = states.value[kind]
  return !props.suppliersLoading && knownState(kind) && !!state && !state.effective_enabled &&
    !invalidCheckReasons.has(state.reason) &&
    reports.value[kind]?.pass === true && !!reports.value[kind]?.fingerprint &&
    checkedRevisions.value[kind]?.revision === state.revision
}
function reportSummary(kind: PaidMedia) {
  if (!reports.value[kind]?.pass) return '检查未通过；当前实际开关状态见上方'
  if (!knownState(kind)) return '已取得检查报告；运行状态暂时无法确认，当前不能开启'
  if (props.suppliersLoading) return '供应商列表仍在读取，完成后核对检查结果'
  if (!checkedRevisions.value[kind]) return invalidationMessages.value[kind] || '检查结果已失效，请重新执行开启前检查'
  return partial(kind) ? '部分商品不可用，开启后仅通过检查的商品可用' : '检查通过，开启时服务端将再次核对'
}
function invalidate(kind: PaidMedia, message = '') {
  delete checkedRevisions.value[kind]
  invalidationMessages.value[kind] = message
  if (confirmKind.value === kind) confirmKind.value = null
}
// Object key order and catalog/set order carry no admission meaning.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
function supplierDependencies(kind: PaidMedia) {
  return JSON.stringify(canonical(props.suppliers.filter(s => s.media_workbench_v1?.media_types.includes(kind)).map(s => ({
    id: s.id, status: s.status, schedulable: s.schedulable, sales: s.effective_sales,
    configuredSales: s.media_workbench_v1?.sales.enabled,
    published: s.media_workbench_v1?.published?.revision,
    lifecycle: s.media_workbench_v1?.product_lifecycle, hidden: [...(s.media_workbench_v1?.hidden_models ?? [])].sort(),
    models: [...(s.model_catalog?.models ?? [])].sort(), adapters: s.native_adapters, bindings: s.media_workbench_v1?.adapter_bindings
  })).sort((a, b) => a.id - b.id)))
}
watch(() => kinds.map(supplierDependencies), (current, previous) => {
  kinds.forEach((kind, index) => { if (current[index] !== previous[index]) {
    dependencyVersions[kind]++
    invalidate(kind, pending.value === `check-${kind}` ? '检查结果已失效：检查期间商品或账号配置发生变化，请重新执行开启前检查' : '检查结果已失效：已发布商品、销售或账号依赖发生变化，请重新执行开启前检查')
  } })
})
function checkProductName(item: PaidCheck) {
 if (!item.product_id) return ''
 const supplier = props.suppliers.find(s => s.id === item.account_id)
 const product = checkProductState(item) ?? supplier?.media_workbench_v1?.published?.products?.find(p => p.product_id === item.product_id) ?? supplier?.media_workbench_v1?.draft.products.find(p => p.product_id === item.product_id)
 const name = product?.display_name?.trim()
 return name && !/^media[-_]/.test(name) ? name.replace(/\s*[·|•]\s*media-[a-z0-9-]{4,}$/i, '').trim() : product?.upstream_model || '商品名称待读取'
}

async function refresh(preserveError = false) {
  if (busy.value) return
  kinds.forEach(kind => invalidate(kind))
  pending.value = 'status'; if (!preserveError) { error.value = ''; unconfirmedApply.value = {} }
  try {
    const values = await Promise.allSettled(kinds.map(kind => mediaPaidAPI.status(kind)))
    values.forEach((value, index) => {
      const kind = kinds[index]!
      if (value.status === 'fulfilled') states.value[kind] = value.value
      else {
        delete states.value[kind]
        error.value += `${error.value ? ' ' : ''}${label(kind)}状态读取失败（GET）：${paidFailureMessage(value.reason)}`
      }
    })
  }
  finally { pending.value = '' }
}
async function check(kind: PaidMedia) {
  if (busy.value || props.suppliersLoading) return
  const dependencies = supplierDependencies(kind)
  const dependencyVersion = dependencyVersions[kind]
  const revision = states.value[kind]?.revision
  pending.value = `check-${kind}`; error.value = ''; delete reports.value[kind]; invalidate(kind)
  delete unconfirmedApply.value[kind]
  try {
    try { reports.value[kind] = await mediaPaidAPI.check(kind) }
    catch (failure) {
      delete states.value[kind]
      error.value = `${label(kind)}开启前检查请求失败（POST）：${paidFailureMessage(failure)} 未执行开启。`
      return
    }
    try {
      const state = await mediaPaidAPI.status(kind)
      states.value[kind] = state
      // GET describes the previous grant; dependencies_changed on that grant
      // does not invalidate a fresh POST report. PUT still repeats the full
      // server check and fingerprint comparison before it can enable anything.
      if (reports.value[kind]?.pass && knownState(kind) && !props.suppliersLoading &&
          dependencyVersion === dependencyVersions[kind] && dependencies === supplierDependencies(kind) &&
          revision === state.revision && !invalidCheckReasons.has(state.reason)) {
        checkedRevisions.value[kind] = { revision: state.revision }
        delete invalidationMessages.value[kind]
      } else if (props.suppliersLoading) {
        invalidate(kind, '检查结果待核对：供应商列表仍在读取，请等待完成后重新执行开启前检查')
      } else if (revision !== state.revision) {
        invalidate(kind, '检查结果已失效：开关版本在检查期间发生变化，请重新执行开启前检查')
      } else if (invalidCheckReasons.has(state.reason)) {
        invalidate(kind, `检查结果已失效：${reason(state.reason)}，请重新执行开启前检查`)
      }
    } catch (failure) {
      delete states.value[kind]
      error.value = `${label(kind)}检查报告已返回，但状态读取失败（GET）：${paidFailureMessage(failure)} 当前不能开启。`
    }
  }
  finally { pending.value = '' }
}
async function apply(kind: PaidMedia, enabled: boolean) {
  if (busy.value || !knownState(kind) || (enabled && !canEnable(kind))) return
  pending.value = `apply-${kind}`; error.value = ''
  delete unconfirmedApply.value[kind]
  invalidate(kind)
  try { const value = await mediaPaidAPI.apply(kind, enabled, states.value[kind]!, reports.value[kind]); states.value[kind] = value.state; if (value.report) reports.value[kind] = value.report; if (enabled && !value.state.effective_enabled) error.value = '开关尚未实际生效，请刷新检查。' }
  catch (failure) {
    unconfirmedApply.value[kind] = true
    delete reports.value[kind]
    error.value = enabled
      ? `${label(kind)}开启结果未确认（PUT）：${paidFailureMessage(failure)} 暂勿重复开启；请读取实际状态并重新检查。`
      : `${label(kind)}操作未确认生效（PUT）：${paidFailureMessage(failure)} 请查看刷新后的实际状态。`
  }
  finally { pending.value = ''; await refresh(true) }
}
function confirmOpen() { const kind = confirmKind.value; confirmKind.value = null; if (kind) void apply(kind, true) }
onMounted(() => refresh())
</script>
<style scoped>
.mw-paid-panel { margin: 0 0 24px; padding: 24px; }
.mw-paid-panel > header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:20px; }
.mw-paid-panel h2,.mw-paid-panel h3 { font-weight:650; margin-bottom:8px; }
.mw-paid-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px; }
.mw-paid-grid article { border:1px solid var(--mw-border, #d8dee7); border-radius:12px; padding:20px; min-width:0; }
.mw-paid-state { font-size:18px; font-weight:600; margin:12px 0 6px; }
.mw-paid-state.is-open { color:#15803d; }
.mw-paid-actions { display:flex; flex-wrap:wrap; gap:8px; margin:16px 0; }
.mw-paid-checks { border-top:1px solid var(--mw-border, #d8dee7); padding-top:14px; font-size:13px; }
.mw-paid-checks summary { cursor:pointer; padding:12px 0 4px; }
.mw-paid-checks ul { margin-top:12px; display:grid; gap:8px; }
.mw-paid-checks li { display:flex; gap:8px; }
.mw-paid-checks small { display:block; opacity:.7; margin-top:3px; }
.mw-paid-error { color:#b91c1c; margin-bottom:12px; }
:global(html.dark .mw-paid-grid article),:global(html.dark .mw-paid-checks) { border-color:#374151; }
:global(html.dark .mw-paid-state.is-open) { color:#86efac; }
:global(html.dark .mw-paid-error) { color:#fca5a5; }
@media(max-width:640px) { .mw-paid-grid { grid-template-columns:1fr; } .mw-paid-panel { padding:16px; } .mw-paid-panel > header { flex-wrap:wrap; } }
</style>
