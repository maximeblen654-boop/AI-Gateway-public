<template>
  <section class="mw-paid-panel mw-panel" aria-label="客户付费生成开关">
    <header><div><h2>客户生成服务</h2><p class="mw-muted">商品发布、Account 销售和全局付费提交分别管理。开启前检查不生成作品、不扣费。全局开关开放不代表每个商品或每个客户均可生成。</p></div><button class="btn btn-secondary" :disabled="busy" @click="refresh()">刷新状态</button></header>
    <p class="mw-muted">本开关只控制 Studio 付费提交，不修改独立 API Key 的原生权限、路由或受保护图片任务接口的访问限制。</p>
    <p v-if="error" role="alert" class="mw-paid-error">{{ error }}</p>
    <div class="mw-paid-grid">
      <article v-for="kind in kinds" :key="kind" :data-test="`paid-${kind}`">
        <h3>{{ label(kind) }}付费生成</h3>
        <p class="mw-paid-state" :class="{ 'is-open': states[kind]?.effective_enabled }">{{ states[kind]?.mode === 'managed-v1' ? (states[kind]?.effective_enabled ? '实际已开放' : '实际未开放') : '状态未确认' }}</p>
        <p class="mw-muted">{{ !states[kind] || states[kind]?.mode !== 'managed-v1' || states[kind]?.reason === 'state_unavailable' ? '请求状态未确认' : states[kind]?.requested_enabled ? '已请求开启' : '未请求开启' }} · {{ reason(states[kind]?.reason) }}</p>
        <p v-if="kind === 'image'" class="mw-muted">文生图与图生图共用此开关，视频独立控制。</p>
        <div class="mw-paid-actions">
          <button class="btn btn-secondary" :disabled="busy || states[kind]?.mode !== 'managed-v1'" @click="check(kind)">{{ pending === `check-${kind}` ? '正在检查…' : '开启前检查' }}</button>
          <button class="btn btn-primary" :disabled="busy || !reports[kind]?.pass || states[kind]?.effective_enabled || states[kind]?.mode !== 'managed-v1'" @click="confirmKind = kind">开启{{ label(kind) }}</button>
          <button class="btn btn-secondary" :disabled="busy || !states[kind]?.requested_enabled" @click="apply(kind, false)">关闭提交</button>
        </div>
        <div v-if="reports[kind]" class="mw-paid-checks" aria-live="polite">
          <strong>{{ partial(kind) ? '部分商品不可用，开启后仅通过检查的商品可用' : reports[kind]?.pass ? '检查通过，开启时服务端将再次核对' : '检查未通过；当前实际开关状态见上方' }}</strong>
          <aside v-if="hasCostFailure(kind)" class="mw-cost-guide" data-test="cost-guide">
            <p><strong>工作台采购成本未就绪</strong></p>
            <p>选择对应 Account 和商品，在第 4 步“采购成本与售价”填写采购成本，保存草稿后检查并发布。计算器结果采用后进入草稿自动保存，服务器确认后再检查并发布。</p>
            <p>成本按商品的合法规格独立匹配；客户售价与采购成本分别管理。旧发布版本缺少工作台成本时，请补齐成本后重新发布。</p>
          </aside>
          <details :open="!reports[kind]?.pass || partial(kind)"><summary>检查明细（{{ reports[kind]?.checks.length }} 项）</summary><ul><li v-for="(item, index) in reports[kind]?.checks" :key="index"><span>{{ item.pass ? '✓' : '×' }}</span><span>{{ checkLabel(item.code, kind) }}<small v-if="item.account_id">Account #{{ item.account_id }}<template v-if="checkProductName(item)"> · {{ checkProductName(item) }}</template><template v-if="item.path"> · {{ item.path === 'edit' ? '参考素材路径' : '无参考素材路径' }}</template></small><small v-if="costCodes.has(item.code) && checkUpstreamModel(item)">上游模型：{{ checkUpstreamModel(item) }}</small><small v-if="!item.pass && checkProductState(item)">{{ checkProductState(item)?.reason }} {{ checkProductState(item)?.action }}</small></span></li></ul></details>
        </div>
      </article>
    </div>
    <ConfirmDialog :show="confirmKind !== null" :title="`开启${label(confirmKind || 'image')}付费生成`" :message="partial(confirmKind || 'image') ? '部分商品不可用。开启后仅通过检查的商品可以继续核验客户原生权限并提交；失败商品保持不可用。不会发布草稿或改变其他类型。' : '将允许通过商品检查和客户原生权限核验的真实付费提交。不会发布商品、改价或打开另一类型；服务端会再次检查。'" confirm-text="确认开启" @cancel="confirmKind = null" @confirm="confirmOpen" />
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { mediaPaidAPI, type PaidMedia, type PaidReport, type PaidState, type PaidCheck } from '@/api/admin/mediaPaid'
import type { SupplierDetail } from '@/api/admin/mediaWorkbench'
const props = withDefaults(defineProps<{ suppliers?: SupplierDetail[] }>(), { suppliers: () => [] })
const kinds: PaidMedia[] = ['image', 'video']
const states = ref<Partial<Record<PaidMedia, PaidState>>>({})
const reports = ref<Partial<Record<PaidMedia, PaidReport>>>({})
const pending = ref('')
const busy = computed(() => pending.value !== '')
const error = ref('')
const confirmKind = ref<PaidMedia | null>(null)
const label = (kind: PaidMedia) => kind === 'image' ? '图片' : '视频'
const reasons: Record<string, string> = { runtime_restarted: '服务已重启，需要重新检查开启', deployment_mode: '当前部署尚未启用管理员开关模式', closed: '提交关闭', open: '运行状态已核对', dependencies_changed: '配置已变化，原检查失效', dependencies_unavailable: '依赖检查不可用，提交关闭', state_unavailable: '无法读取运行状态', apply_failed: '生效失败，提交关闭' }
const reason = (code?: string) => reasons[code || ''] || '等待服务端核对'
const checks: Record<string, string> = { quote_account_quota_requires_cost: '此 Account 设置了金额额度，不能承接未核算采购金额的视频；请管理员核对账号额度政策，不会自动修改配置', quote_cost_channel_missing: '历史发布配置缺少工作台采购成本，请补齐并重新发布', quote_cost_rule_missing: '没有匹配当前商品规格的已发布工作台采购成本', quote_cost_contract: '工作台成本须为 CNY 单张或整条成本，请核对规格与单位', native_account: '原生 Account 可用状态', published_offer: '至少一个已发布商品通过检查', check_timeout: '检查超时', check_cancelled: '检查已取消', dependencies_unavailable: '依赖不可用', sidecar_runtime: 'Core / Bridge / BFF 运行合同', customer_key: '当前管理员的工作台访问权限', customer_key_network_restricted: '工作台 Key 有网络限制，尚不能确认报价权限', billing_eligibility: '原生余额、订阅及权限', customer_quota: '原生 Key 配额', subscription: '订阅状态', private_result_storage: '私有结果存储', published_specs: '已发布规格与正数售价', spec_compilation_and_assets: '规格编译与私有素材', native_quote: '原生非付费报价', quote_account_admission: '账号运行准入未通过：核对 Group、模型映射、调度及运行限制', quote_account_cost: '已发布工作台采购成本未匹配，请在商品第 4 步补齐后重新发布', quote_workbench_cost: '已发布工作台采购成本未匹配，请在商品第 4 步补齐后重新发布', quote_published_offer: '发布依赖和报价规格', quote_binding: '原生报价绑定（旧版诊断）', quote_unknown: '报价检查原因未分类，请联系管理员核对服务端诊断', quote_request: '报价请求身份或请求大小不符合要求', quote_model_permission: '当前 Key 所属 Group 未允许此站点模型', quote_execution: '视频协议或规格不兼容：核对模型、时长、比例及参考素材合同', quote_account: '原生 Account 无法读取', quote_reference_preparation: '参考素材准备状态与当前报价不一致，请重新准备', quote_quote_store: '报价暂存失败，请稍后重试', dependencies_changed: '检查期间配置发生变化', video_reference_or_subscription_quote_requires_existing_preparation: '视频报价需要有效素材准备或受支持的计费合同', deployment_mode: '部署需启用管理员开关模式' }
const checkLabel = (code: string, kind: PaidMedia) => kind === 'video' && costCodes.has(code) ? '视频历史合同检查未通过，请核对服务端诊断；视频商品不再配置采购成本' : checks[code] || '其他服务端检查'
const costCodes = new Set(['quote_workbench_cost', 'quote_account_cost', 'quote_cost_channel_missing', 'quote_cost_rule_missing', 'quote_cost_contract'])
const hasCostFailure = (kind: PaidMedia) => kind === 'image' && (reports.value[kind]?.checks.some(item => !item.pass && costCodes.has(item.code)) ?? false)
const partial = (kind: PaidMedia) => !!reports.value[kind]?.pass && reports.value[kind]!.checks.some(item => !item.pass)
const checkProductState = (item: PaidCheck) => props.suppliers.find(s => s.id === item.account_id)?.product_states?.find(p => p.product_id === item.product_id)
function checkUpstreamModel(item: PaidCheck) {
 const supplier = props.suppliers.find(s => s.id === item.account_id)
 return supplier?.media_workbench_v1?.published?.products?.find(p => p.product_id === item.product_id)?.upstream_model || checkProductState(item)?.upstream_model || ''
}
function checkProductName(item: PaidCheck) {
 if (!item.product_id) return ''
 const supplier = props.suppliers.find(s => s.id === item.account_id)
 const product = checkProductState(item) ?? supplier?.media_workbench_v1?.published?.products?.find(p => p.product_id === item.product_id) ?? supplier?.media_workbench_v1?.draft.products.find(p => p.product_id === item.product_id)
 const name = product?.display_name?.trim()
 return name && !/^media[-_]/.test(name) ? name.replace(/\s*[·|•]\s*media-[a-z0-9-]{4,}$/i, '').trim() : product?.upstream_model || '商品名称待读取'
}

async function refresh(preserveError = false) {
  if (busy.value) return
  pending.value = 'status'; if (!preserveError) error.value = ''
  try { const values = await Promise.all(kinds.map(kind => mediaPaidAPI.status(kind))); values.forEach((value, i) => { states.value[kinds[i]] = value }) }
  catch { states.value = {}; error.value = '无法确认运行状态，请稍后刷新。' }
  finally { pending.value = '' }
}
async function check(kind: PaidMedia) {
  if (busy.value) return
  pending.value = `check-${kind}`; error.value = ''; delete reports.value[kind]
  try { reports.value[kind] = await mediaPaidAPI.check(kind); states.value[kind] = await mediaPaidAPI.status(kind) }
  catch { error.value = '检查失败，未执行开启。请刷新后重试。' }
  finally { pending.value = '' }
}
async function apply(kind: PaidMedia, enabled: boolean) {
  if (busy.value || !states.value[kind]) return
  pending.value = `apply-${kind}`; error.value = ''
  try { const value = await mediaPaidAPI.apply(kind, enabled, states.value[kind]!, reports.value[kind]); states.value[kind] = value.state; if (value.report) reports.value[kind] = value.report; if (enabled && !value.state.effective_enabled) error.value = '开关尚未实际生效，请刷新检查。' }
  catch { error.value = '操作未确认生效，请查看刷新后的实际状态。'; delete reports.value[kind] }
  finally { pending.value = ''; await refresh(true) }
}
function confirmOpen() { const kind = confirmKind.value; confirmKind.value = null; if (kind) void apply(kind, true) }
onMounted(() => refresh())
</script>
<style scoped>
.mw-cost-guide { margin-block:12px; padding:12px; border:1px solid var(--mw-border, #d8dee7); border-radius:8px; overflow-wrap:anywhere; }
.mw-cost-guide p + p { margin-top:8px; }
.mw-cost-guide a { display:inline-block; margin-top:10px; text-decoration:underline; }
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
@media(max-width:640px) { .mw-paid-grid { grid-template-columns:1fr; } .mw-cost-guide { margin-block:12px; padding:12px; border:1px solid var(--mw-border, #d8dee7); border-radius:8px; overflow-wrap:anywhere; }
.mw-cost-guide p + p { margin-top:8px; }
.mw-cost-guide a { display:inline-block; margin-top:10px; text-decoration:underline; }
.mw-paid-panel { padding:16px; } .mw-paid-panel > header { flex-wrap:wrap; } }
</style>
