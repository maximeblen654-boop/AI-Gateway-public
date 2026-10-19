<template>
  <section v-if="inline" class="mw-inline-calculator" data-test="inline-cost-calculator">
    <div class="mw-cost-purchase">
      <label class="mw-field">实际采购金额（CNY）<input class="input" data-test="cost-purchase" inputmode="decimal" placeholder="人民币采购金额" :value="memory.purchase" :aria-invalid="!!decimalError(memory.purchase, true)" :disabled="disabled" @input="setAccount('purchase', $event)" /><span v-if="decimalError(memory.purchase, true)" class="mw-field-error">{{ decimalError(memory.purchase, true) }}</span></label>
      <label class="mw-field">实际到账积分（含赠送）<input class="input" data-test="cost-credits" inputmode="decimal" placeholder="到账总积分" :value="memory.credits" :aria-invalid="!!decimalError(memory.credits, true)" :disabled="disabled" @input="setAccount('credits', $event)" /><span v-if="decimalError(memory.credits, true)" class="mw-field-error">{{ decimalError(memory.credits, true) }}</span></label>
    </div>
    <p class="mw-muted" data-test="cost-rate">每积分成本：{{ rate ? `${rate} CNY` : '待填写有效采购参数' }}。{{ product.media_type === 'video' ? '积分填写整条任务消耗，不再乘时长。' : '积分按单张消耗填写，购买数量不重复计入单价。' }}</p>
    <p class="mw-muted" data-test="cost-memory-scope">采购金额、到账积分和消耗积分为本浏览器试算参数，输入后立即在本地记忆。只有采用后的实际成本及售价同步服务器草稿，保存是否成功以上方服务器确认状态为准。同一字段在多个页面编辑时，以最后一次明确输入为准。</p>
    <p v-if="storageWarning" class="mw-field-error" role="status">{{ storageWarning }}</p>
    <slot :memory="memory" :set-consumption="setConsumptionValue" />
  </section>
  <template v-else>
  <div class="mw-cost-entry"><button type="button" class="mw-cost-trigger" data-test="cost-open" @click="open()"><span aria-hidden="true">↗</span> 成本换算</button><span class="mw-muted">先计算，再采用为采购成本；服务器保存结果以上方状态为准</span></div>
  <dialog ref="panel" class="mw-cost" data-test="cost-calculator" :aria-labelledby="titleId" :aria-modal="narrow ? 'true' : 'false'" @cancel.prevent="close" @keydown="narrow && containDialogFocus($event, panel)">
    <header class="mw-cost-header"><div><h2 :id="titleId" tabindex="-1">成本换算</h2><p>Account #{{ accountId }} · {{ product.display_name || product.upstream_model }}</p></div><button type="button" class="mw-cost-close" data-test="cost-close" aria-label="收起成本换算" @click="close">×</button></header>
    <div class="mw-cost-body">
      <div class="mw-cost-tabs" role="tablist" aria-label="选择采购成本规格"><button v-for="(row, index) in rows" :key="row.tabKey" type="button" role="tab" :id="`${titleId}-tab-${index}`" :aria-controls="`${titleId}-panel-${index}`" :aria-selected="selectedKey === row.tabKey" :tabindex="selectedKey === row.tabKey ? 0 : -1" :data-test="`cost-tab-${index}`" @click="selectedKey = row.tabKey" @keydown="moveTab($event, index)">{{ labels?.[index] || '统一成本' }}</button></div>
      <p class="mw-muted">采购金额、到账积分和消耗积分为本浏览器试算参数，输入后立即在本地记忆。只有采用后的实际成本及售价同步服务器草稿，保存是否成功以上方服务器确认状态为准。同一字段在多个页面编辑时，以最后一次明确输入为准。</p>
      <p v-if="storageWarning" class="mw-field-error" role="status">{{ storageWarning }}</p>
      <div class="mw-cost-purchase">
        <label class="mw-field">上游采购金额（人民币）<input class="input" data-test="cost-purchase" inputmode="decimal" placeholder="请输入采购金额" :value="memory.purchase" :aria-invalid="!!decimalError(memory.purchase, true)" @input="setAccount('purchase', $event)" /><span v-if="decimalError(memory.purchase, true)" class="mw-field-error">{{ decimalError(memory.purchase, true) }}</span></label>
        <label class="mw-field">实得积分（含赠送）<input class="input" data-test="cost-credits" inputmode="decimal" placeholder="请输入到账总积分" :value="memory.credits" :aria-invalid="!!decimalError(memory.credits, true)" @input="setAccount('credits', $event)" /><span v-if="decimalError(memory.credits, true)" class="mw-field-error">{{ decimalError(memory.credits, true) }}</span></label>
      </div>
      <p class="mw-cost-rate" data-test="cost-rate">每积分成本 <strong>{{ rate ? `${rate} CNY` : '待填写有效采购参数' }}</strong></p>
      <p class="mw-muted">不同规格消耗不同，请先在采购成本表中分别配置。{{ product.media_type === 'video' ? '视频按整条计算，不再乘秒数。' : '图片按单张计算。' }}</p>
      <div v-for="(row, index) in rows" :key="row.tabKey" v-show="row.tabKey === selectedKey" class="mw-cost-row" role="tabpanel" :id="`${titleId}-panel-${index}`" :aria-labelledby="`${titleId}-tab-${index}`" :data-test="`cost-row-${index}`">
        <div class="mw-cost-row-heading"><strong>{{ labels?.[index] || '统一成本' }}</strong><span v-if="costRules">客户售价按独立售价表配置</span><span v-else>现有售价：{{ row.rule.sale_price ? `${row.rule.sale_price.amount} ${row.rule.sale_price.currency} / ${unit}` : '待填写' }}</span></div>
        <label class="mw-field">预计每{{ unit }}上游积分消耗<input class="input" inputmode="decimal" placeholder="待估算，允许明确填 0" :value="memory.consumption[row.key] ?? ''" :aria-invalid="!!decimalError(memory.consumption[row.key] ?? '')" :data-test="`cost-consumption-${index}`" @input="setConsumption(row.key, $event)" /><span v-if="decimalError(memory.consumption[row.key] ?? '')" class="mw-field-error">{{ decimalError(memory.consumption[row.key] ?? '') }}</span></label>
        <dl class="mw-cost-results"><div><dt>单{{ unit }}估算上游成本</dt><dd>{{ row.estimate.cost === undefined ? '待估算' : `${row.estimate.cost} CNY` }}</dd></div><div v-if="!costRules"><dt>售价扣除上游成本后</dt><dd :class="{ 'mw-cost-loss': row.estimate.belowCost }">{{ row.estimate.difference === undefined ? '待估算' : `${row.estimate.difference} CNY` }}</dd></div></dl>
        <p v-if="row.estimate.belowCost" class="mw-cost-loss" role="status">当前售价低于估算上游成本。</p>
        <p v-if="row.rule.sale_price && (row.rule.sale_price.currency !== 'CNY' || row.rule.sale_price.billing_mode !== 'per_request')" class="mw-muted">原售价不是 CNY 单件价格，不作差额比较，也不进行汇率换算。</p>
        <p v-if="row.estimate.cost !== undefined" class="mw-muted">仅覆盖上游成本的参考底价：{{ row.estimate.cost }} CNY / {{ unit }}。</p>
        <button type="button" class="btn btn-primary" :data-test="`cost-apply-${index}`" :disabled="disabled || !canApply(row.estimate.cost)" @click="adopt(index, row.estimate.cost)">采用此结果</button>
        <p v-if="appliedKey === row.tabKey" role="status" data-test="calculator-applied">已采用到当前商品草稿；服务器保存结果以上方确认状态为准。</p>
        <p v-if="row.estimate.cost !== undefined && !canApply(row.estimate.cost)" class="mw-field-error">结果小于成本字段支持的最小精度，不能作为零成本采用；请直接核对并填写成本。</p>
      </div>
      <p class="mw-cost-disclaimer">未包含手续费、税费、服务器等费用。差额不是净利润。只有点击“采用此结果”才填入采购成本；保存并发布后用于新报价，客户售价独立管理。</p>
    </div>
  </dialog>
  </template>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { CostRule, Product } from '@/api/admin/mediaWorkbench'
import { containDialogFocus } from './mediaDialogFocus'
import { consumptionKey, decimalError, decimalUnits, emptyCostMemory, estimateCost, storageKey } from './costCalculator'
import { loadCostMemory, writeCostMemoryField, type CostMemoryField } from './costMemoryStorage'
const props = defineProps<{ product: Product; accountId?: number; adminId?: number; labels?: string[]; active?: boolean; costRules?: CostRule[]; disabled?: boolean; dirty?: boolean; inline?: boolean }>()
const emit = defineEmits<{ toggle: [open: boolean]; apply: [index: number, amount: string] }>()
const panel = ref<HTMLDialogElement>()
const titleId = `media-cost-${useId()}`
const selectedKey = ref('')
const opened = ref(false)
const narrow = ref(false)
let trigger: HTMLElement | null = null
let viewport: MediaQueryList | undefined
const memory = ref(emptyCostMemory())
const loadWarning = ref('')
const fieldWarnings = ref<Record<string, string>>({})
const storageWarning = computed(() => [loadWarning.value, ...Object.values(fieldWarnings.value)].filter(Boolean).join(' '))
const identity = computed(() => storageKey(props.adminId, props.accountId))
const unit = computed(() => props.product.media_type === 'video' ? '条' : '张')
watch(identity, key => {
  memory.value = emptyCostMemory()
  loadWarning.value = ''; fieldWarnings.value = {}
  if (!key) { loadWarning.value = '未取得管理员或账号身份，估算仅在当前编辑期间保留。'; return }
  try { const loaded = loadCostMemory(localStorage, key); memory.value = loaded.memory; loadWarning.value = loaded.warning } catch { loadWarning.value = '浏览器记忆不可用或超出读取范围，请保持当前页面；仍可继续估算和填写。' }
}, { immediate: true })
async function open(index = 0, source?: HTMLElement) {
  const row = rows.value[index]
  if (!row) return
  trigger = source ?? document.activeElement as HTMLElement
  selectedKey.value = row.tabKey
  opened.value = true; emit('toggle', true)
  await nextTick()
  if (!panel.value?.open) {
    if (narrow.value) panel.value?.showModal?.()
    else panel.value?.show?.()
  }
  panel.value?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
}
function close() {
  if (!opened.value) return
  opened.value = false; panel.value?.close?.(); emit('toggle', false)
  if (trigger?.isConnected) trigger.focus({ preventScroll: true })
}
function resize() {
  narrow.value = viewport?.matches ?? true
  if (opened.value) {
    panel.value?.close?.()
    if (narrow.value) panel.value?.showModal?.()
    else panel.value?.show?.()
  }
}
function escape(event: KeyboardEvent) { if (event.key === 'Escape' && opened.value && !document.querySelector('dialog.media-dialog[open]')) { event.preventDefault(); close() } }
onMounted(() => {
  viewport = window.matchMedia?.('(max-width: 1279px)'); resize()
  viewport?.addEventListener('change', resize); window.addEventListener('keydown', escape)
})
onBeforeUnmount(() => { emit('toggle', false); panel.value?.close?.(); viewport?.removeEventListener('change', resize); window.removeEventListener('keydown', escape) })
watch(() => props.active, active => { if (active === false) close() })
watch([() => props.adminId, () => props.accountId, () => props.product.product_id], () => close())
defineExpose({ open, close })
const rate = computed(() => estimateCost(memory.value.purchase, memory.value.credits, '', null).perCredit)
const appliedKey = ref('')
watch(() => props.dirty, dirty => { if (dirty === false) appliedKey.value = '' })
const canApply = (amount?: string) => amount !== undefined && decimalUnits(amount) !== undefined
function adopt(index: number, amount?: string) {
  if (props.disabled || !canApply(amount)) return
  appliedKey.value = rows.value[index]!.tabKey
  emit('apply', index, amount!)
}
const rows = computed(() => (props.costRules
  ? props.costRules.map(rule => ({ match: rule.match, sale_price: null }))
  : props.product.pricing_rules.length ? props.product.pricing_rules : [{ match: {}, sale_price: null }]).map((rule, index) => {
  const key = consumptionKey(props.product, rule)
  return { key, tabKey: `${key}#${index}`, rule, estimate: estimateCost(memory.value.purchase, memory.value.credits, memory.value.consumption[key] ?? '', rule.sale_price) }
}))
watch(rows, value => { if (opened.value && !value.some(row => row.tabKey === selectedKey.value)) close() })
function moveTab(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? rows.value.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + rows.value.length) % rows.value.length
  selectedKey.value = rows.value[target]!.tabKey
  panel.value?.querySelectorAll<HTMLButtonElement>('[role=tab]')[target]?.focus()
}
function persist(field: CostMemoryField, value: string, specKey?: string) {
  if (!identity.value) return
  const warningKey = field === 'consumption' ? `consumption:${specKey}` : field
  try {
    writeCostMemoryField(localStorage, identity.value, field, value, specKey)
    delete fieldWarnings.value[warningKey]
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    fieldWarnings.value[warningKey] = reason === 'input_too_long' ? '本字段输入超过 128 字符，未能记住；请缩短输入或保持当前页面。'
      : reason === 'consumption_limit' ? '本账号已记忆 256 个规格，未能记住新增规格；已有记忆未删除，请保持当前页面。'
        : '未能记住本字段，请保持当前页面；已有记忆与服务器草稿不受影响。'
  }
}
function setAccount(field: 'purchase' | 'credits', event: Event) { if (props.disabled) return; const value = (event.target as HTMLInputElement).value; memory.value[field] = value; appliedKey.value = ''; persist(field, value) }
function setConsumptionValue(key: string, value: string) { if (props.disabled) return; memory.value.consumption[key] = value; appliedKey.value = ''; persist('consumption', value, key) }
function setConsumption(key: string, event: Event) { setConsumptionValue(key, (event.target as HTMLInputElement).value) }
</script>
<style scoped>
.mw-cost-entry{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:16px}.mw-cost-trigger{display:flex;align-items:center;gap:8px;padding:10px 14px;border:1px solid var(--mw-border);border-radius:8px;font-weight:600;font-size:13px;background:var(--mw-surface)}
.mw-inline-calculator{display:grid;gap:16px;min-width:0}.mw-inline-calculator>.mw-cost-purchase{max-width:680px}.mw-inline-calculator .mw-field{min-width:0}.mw-inline-calculator .input{width:100%;min-width:0;box-sizing:border-box}
.mw-cost{--mw-cost-warning:#b43c23;position:fixed;inset:80px 16px 16px auto;margin:0;width:400px;height:calc(100dvh - 96px);max-height:none;max-width:calc(100vw - 24px);padding:0;border:1px solid var(--mw-border);border-radius:16px;background:var(--mw-surface);color:var(--mw-text);box-shadow:0 14px 50px #101d1626;z-index:45;overflow:hidden}
.mw-cost[open]{display:flex;flex-direction:column;animation:mw-cost-in .28s cubic-bezier(.2,.75,.2,1)}.mw-cost::backdrop{background:#0b171950;backdrop-filter:blur(2px)}
.mw-cost-header{padding:24px;display:flex;align-items:flex-start;gap:12px;justify-content:space-between;border-bottom:1px solid var(--mw-border);flex-shrink:0}.mw-cost-header h2{font-size:20px;font-weight:600;letter-spacing:-.025em;margin:0}.mw-cost-header p{font-size:12px;color:var(--mw-muted);margin-top:8px;overflow-wrap:anywhere}.mw-cost-close{width:36px;height:36px;flex-shrink:0;border:1px solid var(--mw-border);border-radius:50%;font-size:24px;line-height:1}
.mw-cost-body{padding:20px 24px;display:grid;gap:20px;min-width:0;overflow-y:auto;overscroll-behavior:contain}.mw-cost-body p{margin:0;line-height:1.7;font-size:13px}.mw-cost-tabs{display:flex;gap:6px;flex-wrap:wrap;padding:4px;background:var(--mw-soft);border-radius:10px}.mw-cost-tabs button{flex:1 1 90px;min-width:0;padding:9px 8px;font-size:12px;border-radius:7px;overflow-wrap:anywhere;transition:background .2s,color .2s}.mw-cost-tabs [aria-selected=true]{background:var(--mw-surface);color:var(--mw-accent);box-shadow:0 1px 4px #00000012;font-weight:600}
.mw-cost-purchase{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.mw-cost .mw-field{display:grid;gap:8px;font-size:12px;min-width:0;margin:0}.mw-cost .input{width:100%;min-width:0;box-sizing:border-box}.mw-cost-rate{padding-bottom:16px;border-bottom:1px solid var(--mw-border);display:flex;gap:12px;flex-wrap:wrap}.mw-cost-rate strong{font-variant-numeric:tabular-nums}
.mw-cost-row{display:grid;gap:18px}.mw-cost-row-heading{display:grid;gap:8px;font-size:14px}.mw-cost-row-heading>span{color:var(--mw-muted);font-size:13px}.mw-cost-results{display:grid;gap:18px;margin:0;padding:18px;background:var(--mw-soft);border-radius:10px;font-size:13px}.mw-cost-results>div{display:grid;gap:6px}.mw-cost-results dt{color:var(--mw-muted)}.mw-cost-results dd{margin:0;font-size:22px;font-weight:600;color:var(--mw-text);font-variant-numeric:tabular-nums}.mw-cost-results>div:last-child{padding-top:16px;border-top:1px solid var(--mw-border)}.mw-cost-loss,.mw-cost-results dd.mw-cost-loss{color:var(--mw-cost-warning);font-weight:600}:global(.dark .mw-cost){--mw-cost-warning:#ffab94}.mw-cost-disclaimer{color:var(--mw-muted);padding-top:16px;border-top:1px solid var(--mw-border)}.mw-cost :is(strong,dd,span){overflow-wrap:anywhere}
@keyframes mw-cost-in{from{transform:translateX(24px);opacity:0}to{transform:translateX(0);opacity:1}}
@media(max-width:1279px){.mw-cost{inset:auto 8px 8px;width:calc(100vw - 16px);max-width:520px;height:min(780px,calc(100dvh - 24px));margin:0 auto;border-radius:20px;z-index:60;animation-name:mw-cost-up}.mw-cost-header{padding:20px}.mw-cost-body{padding:20px}.mw-cost-close{width:44px;height:44px}.mw-cost-tabs button{min-height:44px}}
@keyframes mw-cost-up{from{transform:translateY(28px);opacity:0}to{transform:translateY(0);opacity:1}}
@media(prefers-reduced-motion:reduce){.mw-cost[open]{animation:none}.mw-cost-tabs button{transition:none}}
</style>
