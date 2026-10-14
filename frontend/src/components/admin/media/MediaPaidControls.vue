<template>
  <section class="mw-paid-panel mw-panel" aria-label="客户付费生成开关">
    <header><div><h2>客户生成服务</h2><p class="mw-muted">商品发布、Account 销售和全局付费提交分别管理。开启前检查不生成作品、不扣费。</p></div><button class="btn btn-secondary" :disabled="busy" @click="refresh()">刷新状态</button></header>
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
          <strong>{{ reports[kind]?.pass ? '检查通过，开启时服务端将再次核对' : '检查未通过，保持关闭' }}</strong>
          <details :open="!reports[kind]?.pass"><summary>检查明细（{{ reports[kind]?.checks.length }} 项）</summary><ul><li v-for="(item, index) in reports[kind]?.checks" :key="index"><span>{{ item.pass ? '✓' : '×' }}</span><span>{{ checkLabel(item.code) }}<small v-if="item.account_id">Account #{{ item.account_id }}<template v-if="item.path"> · {{ item.path === 'edit' ? '参考素材路径' : '无参考素材路径' }}</template></small></span></li></ul></details>
        </div>
      </article>
    </div>
    <ConfirmDialog :show="confirmKind !== null" :title="`开启${label(confirmKind || 'image')}付费生成`" message="将允许客户提交该类型的真实付费生成。不会发布商品、改价或打开另一类型。服务端会重新检查；配置变化或检查失败时保持关闭。" confirm-text="确认开启" @cancel="confirmKind = null" @confirm="confirmOpen" />
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import { mediaPaidAPI, type PaidMedia, type PaidReport, type PaidState } from '@/api/admin/mediaPaid'
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
const checks: Record<string, string> = { dependencies_unavailable: '依赖不可用', sidecar_runtime: 'Core / Bridge / BFF 运行合同', customer_key: '当前管理员的工作台访问权限', customer_key_network_restricted: '工作台 Key 有网络限制，尚不能确认报价权限', billing_eligibility: '原生余额、订阅及权限', customer_quota: '原生 Key 配额', subscription: '订阅状态', private_result_storage: '私有结果存储', published_specs: '已发布规格与正数售价', spec_compilation_and_assets: '规格编译与私有素材', native_quote: '原生非付费报价', quote_account_admission: '账号运行准入', quote_account_cost: '原生 Account 成本规则', quote_published_offer: '发布依赖和报价规格', quote_binding: '原生报价绑定', dependencies_changed: '检查期间配置发生变化', video_reference_or_subscription_quote_requires_existing_preparation: '视频报价需要有效素材准备或受支持的计费合同', deployment_mode: '部署需启用管理员开关模式' }
const checkLabel = (code: string) => checks[code] || '服务端检查未完成'
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
  try { const value = await mediaPaidAPI.apply(kind, enabled, states.value[kind]!, reports.value[kind]); states.value[kind] = value.state; if (enabled && !value.state.effective_enabled) error.value = '开关尚未实际生效，请刷新检查。' }
  catch { error.value = '操作未确认生效，请查看刷新后的实际状态。'; delete reports.value[kind] }
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
