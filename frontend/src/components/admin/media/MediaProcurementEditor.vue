<template>
  <div data-field="cost_rules" data-test="procurement-editor">
    <h3>采购成本 · CNY / {{ unit }}</h3>
    <p class="mw-muted">采购成本与客户售价分别配置。空白是未配置；明确填写 0 表示零成本。草稿允许缺项，发布时由服务器检查全部合法规格。</p>
    <div class="mw-pricing-dimensions" role="group" aria-label="采购成本适用规格">
      <label v-for="dimension in available" :key="dimension.key" class="mw-check-card" :class="{ 'mw-check-card-selected': dimensions.includes(dimension.key) }"><input type="checkbox" :checked="dimensions.includes(dimension.key)" :disabled="disabled || complexReferences" :data-test="`cost-dimension-${dimension.key}`" @change="toggle(dimension.key, $event)" /><span>{{ dimension.label }}分别配置成本</span></label>
      <label v-if="supportsCreationModePricing(product)" class="mw-check-card"><input type="checkbox" :checked="separateMode" :disabled="disabled || complexReferences" data-test="cost-creation-mode" @change="changeMode" /><span>文生图 / 图生图分别配置成本</span></label>
    </div>
    <p v-if="complexReferences" class="mw-muted">已有更细的输出格式或参考素材成本条件，保留原规则；可逐行修改成本，不会合并。</p>
    <p v-if="matrixMessage" class="mw-field-error" role="status">{{ matrixMessage }}</p>
    <div class="mw-price-table" role="table" aria-label="采购成本表">
      <div class="mw-price-table-head" role="row"><span role="columnheader">成本适用规格</span><span role="columnheader">单{{ unit }}采购成本 · CNY</span><span role="columnheader">填写状态</span></div>
      <div v-for="(rule, index) in rows" :key="index" class="mw-price-row" role="row">
        <div role="cell" class="mw-price-spec"><strong>{{ costLabel(rule.match) }}</strong><p class="mw-muted">仅按这里的条件匹配成本；客户售价单独管理。</p><button type="button" class="mw-link mw-row-cost" :data-test="`open-cost-${index}`" :disabled="disabled" @click="calculator?.open(index, $event.currentTarget as HTMLElement)">计算此规格成本 ↗</button><details><summary>细分此成本的适用条件</summary><MediaMatchEditor :model-value="rule.match" @update:model-value="setMatch(index, $event)" /><button type="button" class="mw-link" :data-test="`remove-cost-rule-${index}`" :disabled="disabled" @click="removeRule(index)">移除此成本条件</button></details></div>
        <div role="cell"><label class="mw-field"><span class="mw-price-mobile-label">单{{ unit }}采购成本 · CNY</span><input class="input" inputmode="decimal" placeholder="待填写，允许明确填 0" :data-field="`cost_rules.${index}.cost`" :data-test="`procurement-cost-${index}`" :aria-label="`${costLabel(rule.match)} 采购成本（CNY）`" :aria-invalid="!!costError(rule)" :value="rule.cost?.amount ?? ''" @input="setAmount(index, ($event.target as HTMLInputElement).value)" /></label><p v-if="costError(rule)" class="mw-field-error" role="alert">{{ costError(rule) }}</p><p v-if="rule.cost && (rule.cost.currency !== 'CNY' || rule.cost.billing_mode !== 'per_request')" class="mw-muted">原成本 {{ rule.cost.currency }} / {{ rule.cost.billing_mode }}；重新填写将使用 CNY / {{ unit }}。</p></div>
        <div role="cell" class="mw-cost-state"><span>{{ rule.cost === null ? '待填写' : costError(rule) ? '需要修正' : '已填写' }}</span><span v-if="rule.source === 'calculator'">来自管理员确认的计算结果</span><button v-if="rule.cost" type="button" class="mw-link" :disabled="disabled" @click="setAmount(index, '')">清空成本</button></div>
      </div>
    </div>
    <button type="button" class="btn btn-secondary" data-test="add-cost-rule" :disabled="disabled || rows.length >= maxCostRules" @click="replace([...rows, { match: {}, cost: null }])">新增独立成本条件</button>
    <p class="mw-muted">细分条件只影响采购成本；请覆盖全部合法规格并避免重叠。修改规格后已有输入会保留，保存和发布时由服务器重新检查。</p>
    <p v-if="adopted" class="mw-banner" role="status" data-test="cost-adopted">已采用，尚未保存：计算结果已填入采购成本。请前往第 5 步保存草稿。</p>
    <MediaCostCalculator ref="calculator" :active="active" :product="product" :account-id="accountId" :admin-id="adminId" :labels="rows.map(row => costLabel(row.match))" :cost-rules="rows" :disabled="disabled" :dirty="dirty" @toggle="emit('cost-toggle', $event)" @apply="applyResult" />
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CostRule, Match, Product } from '@/api/admin/mediaWorkbench'
import { decimalError } from './costCalculator'
import { buildCostRules, costDimensions, costLabel, costRows, maxCostRules } from './procurementMatrix'
import { hasDetailedReferencePricingRules, supportsCreationModePricing, type PricingDimension } from './pricingMatrix'
import MediaCostCalculator from './MediaCostCalculator.vue'
import MediaMatchEditor from './MediaMatchEditor.vue'
const props = defineProps<{ product: Product; accountId?: number; adminId?: number; active?: boolean; dirty?: boolean; disabled: boolean }>()
const emit = defineEmits<{ 'update:product': [product: Product]; 'cost-toggle': [open: boolean] }>()
const unit = computed(() => props.product.media_type === 'video' ? '条' : '张')
const rows = computed(() => costRows(props.product))
const dimensions = computed(() => costDimensions(props.product))
const separateMode = computed(() => rows.value.some(row => row.match.references))
const complexReferences = computed(() => rows.value.some(row => row.match.output_formats?.length) || hasDetailedReferencePricingRules({ ...props.product, pricing_rules: rows.value.map(row => ({ match: row.match, sale_price: row.cost })) }))
const available = computed(() => ([{ key: 'resolution', label: '分辨率', values: props.product.capabilities.resolutions }, { key: 'aspect_ratio', label: '比例', values: props.product.capabilities.aspect_ratios }, { key: 'quality', label: '画质', values: props.product.capabilities.qualities }, { key: 'duration_seconds', label: '时长', values: props.product.capabilities.durations_seconds }] as const).filter(item => item.values.length || dimensions.value.includes(item.key)))
const calculator = ref<InstanceType<typeof MediaCostCalculator>>()
const adopted = ref(false)
watch(() => props.dirty, dirty => { if (dirty === false) adopted.value = false })
const matrixMessage = ref('')
const costError = (rule: CostRule) => rule.cost ? decimalError(rule.cost.amount) : ''
function replace(next: CostRule[]) { if (!props.disabled) emit('update:product', { ...props.product, cost_rules: next }) }
function rebuild(nextDimensions: PricingDimension[], mode: boolean): boolean {
  const next = buildCostRules(props.product, nextDimensions, mode)
  if (!next) { matrixMessage.value = '请先修正规格或组合限制；成本行最多 100 行。已有成本保留。'; return false }
  if (rows.value.some(row => row.cost) && next.some(row => row.cost === null) && !window.confirm('此修改可能合并不同成本或改变覆盖范围，冲突项会待填写。确认修改采购成本条件？')) return false
  matrixMessage.value = ''; adopted.value = false; replace(next); return true
}
function toggle(key: PricingDimension, event: Event) { const input = event.target as HTMLInputElement; if (!rebuild(input.checked ? [...dimensions.value, key] : dimensions.value.filter(value => value !== key), separateMode.value)) input.checked = !input.checked }
function changeMode(event: Event) { const input = event.target as HTMLInputElement; if (!rebuild(dimensions.value, input.checked)) input.checked = !input.checked }
function setAmount(index: number, amount: string, source: CostRule['source'] = 'manual') {
  const next = JSON.parse(JSON.stringify(rows.value)) as CostRule[]
  next[index] = { ...next[index]!, cost: amount === '' ? null : { amount, currency: 'CNY', billing_mode: 'per_request' }, source }
  adopted.value = source === 'calculator'; replace(next)
}
function setMatch(index: number, match: Match) { const next = JSON.parse(JSON.stringify(rows.value)) as CostRule[]; next[index] = { ...next[index]!, match, source: 'manual' }; adopted.value = false; replace(next) }
function removeRule(index: number) { if (rows.value[index]?.cost && !window.confirm('确认从当前草稿移除此采购成本条件？')) return; adopted.value = false; replace(rows.value.filter((_, rowIndex) => rowIndex !== index)) }
function applyResult(index: number, amount: string) { if (!props.disabled && !decimalError(amount) && amount !== '') setAmount(index, amount, 'calculator') }
</script>

<style scoped>
.mw-price-spec{display:grid;grid-template-columns:minmax(0,1fr);align-content:start;gap:8px;min-width:0}
.mw-price-spec>strong,.mw-price-spec>details{min-width:0;max-width:100%;overflow-wrap:anywhere}
.mw-cost-state{display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--mw-muted)}
</style>
