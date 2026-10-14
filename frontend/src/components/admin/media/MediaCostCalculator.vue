<template>
  <details class="mw-cost" data-test="cost-calculator">
    <summary><span><strong>成本换算</strong><small>辅助估算 · 不改变售价</small></span><span aria-hidden="true" class="mw-cost-chevron">⌄</span></summary>
    <div class="mw-cost-body">
      <p class="mw-muted">采购参数按当前管理员和 Account 记在此浏览器，不跨设备同步。积分消耗按商品及规格单独记忆；规格范围变化后请重新估算。</p>
      <p v-if="storageWarning" class="mw-field-error" role="status">{{ storageWarning }}</p>
      <div class="mw-cost-purchase">
        <label class="mw-field">上游采购金额（人民币）<input class="input" data-test="cost-purchase" inputmode="decimal" placeholder="请输入采购金额" :value="memory.purchase" :aria-invalid="!!decimalError(memory.purchase, true)" @input="setAccount('purchase', $event)" /><span v-if="decimalError(memory.purchase, true)" class="mw-field-error">{{ decimalError(memory.purchase, true) }}</span></label>
        <label class="mw-field">实得积分（含赠送）<input class="input" data-test="cost-credits" inputmode="decimal" placeholder="请输入到账总积分" :value="memory.credits" :aria-invalid="!!decimalError(memory.credits, true)" @input="setAccount('credits', $event)" /><span v-if="decimalError(memory.credits, true)" class="mw-field-error">{{ decimalError(memory.credits, true) }}</span></label>
      </div>
      <p class="mw-cost-rate" data-test="cost-rate">每积分成本 <strong>{{ rate ? `${rate} CNY` : '待填写有效采购参数' }}</strong></p>
      <p class="mw-muted">同价档位覆盖不同上游消耗时，按最高单件消耗估算。{{ product.media_type === 'video' ? '视频按整条计算，不再乘秒数。' : '图片按单张计算。' }}</p>
      <div v-for="(row, index) in rows" :key="row.key" class="mw-cost-row" :data-test="`cost-row-${index}`">
        <div class="mw-cost-row-heading"><strong>{{ labels[index] || '统一售价' }}</strong><span>现有售价：{{ row.rule.sale_price ? `${row.rule.sale_price.amount} ${row.rule.sale_price.currency} / ${unit}` : '待填写' }}</span></div>
        <label class="mw-field">预计每{{ unit }}上游积分消耗<input class="input" inputmode="decimal" placeholder="待估算，允许明确填 0" :value="memory.consumption[row.key] ?? ''" :aria-invalid="!!decimalError(memory.consumption[row.key] ?? '')" :data-test="`cost-consumption-${index}`" @input="setConsumption(row.key, $event)" /><span v-if="decimalError(memory.consumption[row.key] ?? '')" class="mw-field-error">{{ decimalError(memory.consumption[row.key] ?? '') }}</span></label>
        <dl class="mw-cost-results"><div><dt>单{{ unit }}估算上游成本</dt><dd>{{ row.estimate.cost === undefined ? '待估算' : `${row.estimate.cost} CNY` }}</dd></div><div><dt>售价扣除上游成本后</dt><dd :class="{ 'mw-cost-loss': row.estimate.belowCost }">{{ row.estimate.difference === undefined ? '待估算' : `${row.estimate.difference} CNY` }}</dd></div></dl>
        <p v-if="row.estimate.belowCost" class="mw-cost-loss" role="status">当前售价低于估算上游成本。</p>
        <p v-if="row.rule.sale_price && (row.rule.sale_price.currency !== 'CNY' || row.rule.sale_price.billing_mode !== 'per_request')" class="mw-muted">原售价不是 CNY 单件价格，不作差额比较，也不进行汇率换算。</p>
        <p v-if="row.estimate.cost !== undefined" class="mw-muted">仅覆盖上游成本的参考底价：{{ row.estimate.cost }} CNY / {{ unit }}。</p>
      </div>
      <p class="mw-cost-disclaimer">未包含手续费、税费、服务器等费用。差额不是净利润，不保证不亏损；估算不进入发布、客户报价或正式结算。</p>
    </div>
  </details>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Product } from '@/api/admin/mediaWorkbench'
import { consumptionKey, decimalError, emptyCostMemory, estimateCost, readCostMemory, storageKey } from './costCalculator'
const props = defineProps<{ product: Product; accountId?: number; adminId?: number; labels: string[] }>()
const memory = ref(emptyCostMemory())
const storageWarning = ref('')
const identity = computed(() => storageKey(props.adminId, props.accountId))
const unit = computed(() => props.product.media_type === 'video' ? '条' : '张')
watch(identity, key => {
  memory.value = emptyCostMemory()
  storageWarning.value = ''
  if (!key) { storageWarning.value = '未取得管理员或账号身份，估算仅在当前编辑期间保留。'; return }
  try { memory.value = readCostMemory(localStorage.getItem(key)) } catch { storageWarning.value = '浏览器记忆不可用或已损坏，已忽略旧值；仍可继续估算和填写售价。' }
}, { immediate: true })
const rate = computed(() => estimateCost(memory.value.purchase, memory.value.credits, '', null).perCredit)
const rows = computed(() => (props.product.pricing_rules.length ? props.product.pricing_rules : [{ match: {}, sale_price: null }]).map(rule => {
  const key = consumptionKey(props.product, rule)
  return { key, rule, estimate: estimateCost(memory.value.purchase, memory.value.credits, memory.value.consumption[key] ?? '', rule.sale_price) }
}))
function persist() {
  if (!identity.value) return
  // Invalid intermediate input stays visible, but never poisons remembered values.
  if (decimalError(memory.value.purchase) || decimalError(memory.value.credits) || Object.values(memory.value.consumption).some(value => decimalError(value))) return
  try {
    const raw = JSON.stringify(memory.value)
    readCostMemory(raw)
    localStorage.setItem(identity.value, raw)
    storageWarning.value = ''
  } catch { storageWarning.value = '未能记住本次估算，请保持当前页面；正式售价编辑不受影响。' }
}
function setAccount(field: 'purchase' | 'credits', event: Event) { memory.value[field] = (event.target as HTMLInputElement).value; persist() }
function setConsumption(key: string, event: Event) { memory.value.consumption[key] = (event.target as HTMLInputElement).value; persist() }
</script>
<style scoped>
.mw-cost{--mw-cost-warning:#b43c23;margin-top:24px;border:1px solid var(--mw-border);border-radius:14px;background:var(--mw-soft);color:var(--mw-text);min-width:0}
.mw-cost summary{cursor:pointer;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;list-style:none}
.mw-cost summary::-webkit-details-marker{display:none}.mw-cost summary>span:first-child{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}.mw-cost summary small{color:var(--mw-muted);font-size:12px}.mw-cost summary:focus-visible{outline:3px solid #668bc4;outline-offset:3px;border-radius:12px}.mw-cost[open] .mw-cost-chevron{transform:rotate(180deg)}
.mw-cost-body{padding:0 20px 20px;display:grid;gap:16px;min-width:0}.mw-cost-body p{margin:0;line-height:1.7;font-size:13px}.mw-cost-purchase{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.mw-cost .mw-field{display:grid;gap:8px;font-size:13px;min-width:0}.mw-cost .input{width:100%;min-width:0;box-sizing:border-box}.mw-cost-rate{padding:12px 0;border-bottom:1px solid var(--mw-border);display:flex;gap:12px;flex-wrap:wrap}.mw-cost-rate strong{font-variant-numeric:tabular-nums}
.mw-cost-row{border-top:1px solid var(--mw-border);padding-top:18px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:16px 24px}.mw-cost-row-heading{grid-column:1/-1;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:14px}.mw-cost-row-heading>span{color:var(--mw-muted);font-size:13px}.mw-cost-results{display:grid;gap:10px;margin:0;font-size:13px}.mw-cost-results>div{display:flex;justify-content:space-between;gap:16px}.mw-cost-results dt{color:var(--mw-muted)}.mw-cost-results dd{margin:0;font-weight:650;font-variant-numeric:tabular-nums}.mw-cost-row>p{grid-column:1/-1}.mw-cost-loss{color:var(--mw-cost-warning);font-weight:600}:global(.dark .mw-cost){--mw-cost-warning:#ffab94}.mw-cost-disclaimer{color:var(--mw-muted);padding-top:16px;border-top:1px solid var(--mw-border)}.mw-cost :is(strong,dd,span){overflow-wrap:anywhere}
@media(max-width:640px){.mw-cost summary{padding:16px}.mw-cost-body{padding:0 16px 16px}.mw-cost-purchase,.mw-cost-row{grid-template-columns:minmax(0,1fr)}.mw-cost-results>div{flex-wrap:wrap;gap:6px}.mw-cost summary>span:first-child{gap:6px}}
</style>
