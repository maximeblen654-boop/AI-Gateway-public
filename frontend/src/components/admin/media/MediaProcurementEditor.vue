<template>
  <div data-field="cost_rules" data-test="procurement-editor">
    <h3>逐规格采购成本与售价 · CNY / {{ unit }}</h3>
    <p class="mw-muted">填写采购参数与整条任务积分，再明确采用换算成本。实际成本与售价独立；空白是未配置，成本可明确填 0。售价须大于 0，0 元可保留草稿，但不能发布或生成。</p>
    <details class="mw-cost-partitions"><summary>采购成本如何分档（独立于售价）</summary>
      <div class="mw-pricing-dimensions" role="group" aria-label="采购成本适用规格">
        <label v-for="dimension in available" :key="dimension.key" class="mw-check-card"><input type="checkbox" :checked="dimensions.includes(dimension.key)" :disabled="disabled || complexReferences" :data-test="`cost-dimension-${dimension.key}`" @change="toggle(dimension.key, $event)" /><span>{{ dimension.label }}分别配置成本</span></label>
        <label v-if="supportsCreationModePricing(product)" class="mw-check-card"><input type="checkbox" :checked="separateMode" :disabled="disabled || complexReferences" data-test="cost-creation-mode" @change="changeMode" /><span>文生图 / 图生图分别配置成本</span></label>
      </div>
      <p v-if="complexReferences" class="mw-muted">更细的输出格式或参考素材条件保留在高级规则中，不会合并。</p>
    </details>
    <p v-if="matrixMessage" class="mw-field-error" role="status">{{ matrixMessage }}</p>
    <p v-if="joined.reason" class="mw-banner" data-test="spec-table-fallback">{{ joined.reason }}</p>
    <MediaCostCalculator v-if="joined.rows.length" inline :product="product" :account-id="accountId" :admin-id="adminId" :disabled="disabled">
      <template #default="{ memory, setConsumption }">
        <div class="mw-spec-table" role="table" aria-label="逐规格采购成本与售价" data-test="unified-spec-table">
          <div class="mw-spec-head" role="row"><span role="columnheader">规格 / 积分换算</span><span role="columnheader">实际采购成本</span><span role="columnheader">实际售价</span><span role="columnheader">单{{ unit }}毛利润 / 毛利率</span></div>
          <div v-for="(row, index) in joined.rows" :key="row.key" class="mw-spec-row" role="row" :data-test="`spec-row-${index}`">
            <div role="cell" class="mw-spec-identity">
              <strong>{{ product.display_name || product.upstream_model }}</strong><span>{{ row.label }}</span>
              <label class="mw-field">整{{ unit }}任务消耗积分<input class="input" inputmode="decimal" placeholder="待填写，允许 0" :data-test="`cost-consumption-${index}`" :disabled="disabled" :value="memory.consumption[row.consumptionKey] ?? ''" :aria-invalid="!!decimalError(memory.consumption[row.consumptionKey] ?? '')" @input="setConsumption(row.consumptionKey, text($event))" /></label>
              <p v-if="decimalError(memory.consumption[row.consumptionKey] ?? '')" class="mw-field-error">{{ decimalError(memory.consumption[row.consumptionKey] ?? '') }}</p>
              <span class="mw-converted-cost" :data-test="`converted-cost-${index}`">换算成本 {{ estimate(row, memory).cost === undefined ? '待填写有效积分' : `${estimate(row, memory).cost} CNY` }}</span>
            </div>
            <div role="cell" class="mw-spec-amount">
              <label class="mw-field">实际采购成本 · CNY<input class="input" inputmode="decimal" placeholder="待填写，允许 0" :data-test="costSelector(row, index)" :data-spec-cost="index" :data-field="row.costIndex === undefined ? 'cost_rules' : `cost_rules.${row.costIndex}.cost`" :aria-label="`${row.label} 采购成本（CNY）`" :disabled="disabled || row.costConflict" :value="costFor(row)?.amount ?? ''" :aria-invalid="!!amountError(costFor(row))" @input="setSpecCost(row, text($event))" /></label>
              <p v-if="row.costConflict" class="mw-field-error">成本规则重叠，请在高级规则核对；简表不会选择其中一条。</p>
              <p v-else-if="row.costCount > 1" class="mw-shared" :data-test="`cost-shared-${index}`">共享成本：修改影响 {{ row.costCount }} 个规格行（{{ costLabel(costs[row.costIndex!]!.match) }}）。</p>
              <p v-if="amountError(costFor(row))" class="mw-field-error" role="alert">{{ amountError(costFor(row)) }}</p>
              <p v-if="legacy(costFor(row))" class="mw-muted">原成本 {{ costFor(row)?.currency }} / {{ costFor(row)?.billing_mode }}；重新填写才使用 CNY / {{ unit }}。</p>
              <div v-if="costSuggestion(row, memory)" class="mw-suggestion" :data-test="`cost-suggestion-${index}`"><span>建议成本 {{ costSuggestion(row, memory)!.amount }} CNY</span><small>{{ costSuggestion(row, memory)!.basis }}</small><button type="button" class="mw-link" :data-test="`cost-apply-${index}`" :disabled="disabled || row.costConflict || !canApply(costSuggestion(row, memory)?.amount) || conflictingEstimates(row, memory)" @click="adoptCost(row, costSuggestion(row, memory)!.amount)">采用{{ row.costCount > 1 ? `至 ${row.costCount} 个规格的共享成本` : '此成本' }}</button></div>
              <button v-else type="button" class="mw-link" :data-test="`cost-apply-${index}`" disabled>待有效成本建议</button>
              <p v-if="conflictingEstimates(row, memory)" class="mw-field-error">共享成本下存在不同换算结果，请先明确成本分档。</p>
              <p v-if="estimate(row, memory).cost?.includes('<')" class="mw-field-error">换算结果低于成本字段精度，不能作为零成本采用。</p>
            </div>
            <div role="cell" class="mw-spec-amount">
              <label class="mw-field">实际售价 · CNY<input class="input" inputmode="decimal" placeholder="待填写" :data-test="priceSelector(row, index)" :data-spec-price="index" :data-field="row.priceIndex === undefined ? 'pricing_rules' : `pricing_rules.${row.priceIndex}.sale_price`" :aria-label="`${row.label} 售价（CNY）`" :disabled="disabled || row.priceConflict" :value="priceFor(row)?.amount ?? ''" :aria-invalid="!!amountError(priceFor(row), true)" @input="setSpecPrice(row, text($event))" /></label>
              <p v-if="row.priceConflict" class="mw-field-error">售价规则重叠，请在高级规则核对。</p>
              <p v-else-if="row.priceCount > 1" class="mw-shared" :data-test="`sale-shared-${index}`">共享售价：修改影响 {{ row.priceCount }} 个规格行（{{ costLabel(prices[row.priceIndex!]!.match) }}）。</p>
              <p v-if="amountError(priceFor(row), true)" class="mw-field-error" role="alert">{{ amountError(priceFor(row), true) }}</p>
              <p v-if="legacy(priceFor(row))" class="mw-muted">原售价 {{ priceFor(row)?.currency }} / {{ priceFor(row)?.billing_mode }}；重新填写才使用 CNY / {{ unit }}。</p>
              <span class="mw-price-state">{{ priceFor(row) == null ? '待填写' : amountError(priceFor(row), true) ? '需要修正' : '已填写' }}</span>
              <div v-if="saleSuggestion(row)" class="mw-suggestion" :data-test="`sale-suggestion-${index}`"><span>建议售价 {{ saleSuggestion(row)!.amount }} CNY</span><small>{{ saleSuggestion(row)!.basis }}</small><button type="button" class="mw-link" :data-test="`sale-apply-${index}`" :disabled="disabled || row.priceConflict" @click="adoptSale(row, saleSuggestion(row)!.amount)">采用建议售价</button></div>
              <small v-else class="mw-muted" :data-test="`sale-suggestion-empty-${index}`">暂无可靠售价建议</small>
            </div>
            <dl role="cell" class="mw-spec-profit" :data-test="`spec-profit-${index}`"><dt>单{{ unit }}毛利润</dt><dd :class="{ 'mw-cost-loss': profit(row).belowCost }">{{ profit(row).profit === undefined ? '待填写成本与售价' : `${profit(row).profit} CNY` }}</dd><dt>毛利率</dt><dd>{{ profit(row).margin === undefined ? '待有效售价' : `${profit(row).margin}%` }}</dd><small>按实际采购成本；未扣其他费用，非净利润。</small></dl>
          </div>
        </div>
      </template>
    </MediaCostCalculator>
    <p class="mw-muted" data-test="pricing-row-summary">价格行：{{ prices.length }}，已填写 {{ prices.filter(rule => !!rule.sale_price?.amount).length }}。成本与售价按各自规则匹配，不自动拆分或合并共享规则。</p>
    <details class="mw-advanced-rules" :open="!!joined.reason" data-test="advanced-financial-rules"><summary>高级规则与历史条件（全部 {{ costs.length }} 条成本、{{ prices.length }} 条售价规则）</summary>
      <p class="mw-muted">直接编辑原规则。复杂条件、重叠及当前未启用的规则全部保留。</p>
      <div v-for="(rule, index) in costs" :key="`cost-${index}`" class="mw-advanced-rule"><strong>采购成本：{{ costLabel(rule.match) }}</strong><label class="mw-field">实际采购成本 · CNY<input class="input" inputmode="decimal" :disabled="disabled" :data-test="advancedCostSelector(index)" :value="rule.cost?.amount ?? ''" :aria-invalid="!!amountError(rule.cost)" @input="setAmount(index, text($event))" /></label><p v-if="amountError(rule.cost)" class="mw-field-error">{{ amountError(rule.cost) }}</p><MediaMatchEditor :model-value="rule.match" @update:model-value="setMatch(index, $event)" /><button type="button" class="mw-link" :data-test="`remove-cost-rule-${index}`" :disabled="disabled" @click="removeRule(index)">移除此成本条件</button></div>
      <button type="button" class="btn btn-secondary" data-test="add-cost-rule" :disabled="disabled || costs.length >= maxCostRules" @click="replace([...costs, { match: {}, cost: null }])">新增独立成本条件</button>
      <div v-for="(rule, index) in prices" :key="`sale-${index}`" class="mw-advanced-rule"><strong>客户售价：{{ costLabel(rule.match) }}</strong><label class="mw-field">实际售价 · CNY<input class="input" inputmode="decimal" :disabled="disabled" :data-test="advancedPriceSelector(index)" :value="rule.sale_price?.amount ?? ''" :aria-invalid="!!amountError(rule.sale_price, true)" @input="setPrice(index, text($event))" /></label><p v-if="amountError(rule.sale_price, true)" class="mw-field-error">{{ amountError(rule.sale_price, true) }}</p></div>
    </details>
    <p v-if="adopted" class="mw-banner" role="status" data-test="cost-adopted">已采用到当前商品草稿；实际成本与售价的服务器保存结果以上方确认状态为准。</p>
  </div>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CostRule, Match, Price, Product } from '@/api/admin/mediaWorkbench'
import { decimalError, decimalUnits, estimateCost, grossProfit, type CostMemory } from './costCalculator'
import { costSpecRows, durationSuggestion, saleRows, type CostSpecRow } from './costSpecRows'
import { buildCostRules, costDimensions, costLabel, costRows, maxCostRules } from './procurementMatrix'
import { hasDetailedReferencePricingRules, supportsCreationModePricing, type PricingDimension } from './pricingMatrix'
import MediaCostCalculator from './MediaCostCalculator.vue'
import MediaMatchEditor from './MediaMatchEditor.vue'
const props = defineProps<{ product: Product; accountId?: number; adminId?: number; active?: boolean; dirty?: boolean; disabled: boolean }>()
const emit = defineEmits<{ 'update:product': [product: Product]; 'cost-toggle': [open: boolean] }>()
const text = (event: Event) => (event.target as HTMLInputElement).value
const unit = computed(() => props.product.media_type === 'video' ? '条' : '张')
const costs = computed(() => costRows(props.product))
const prices = computed(() => saleRows(props.product))
const joined = computed(() => costSpecRows(props.product))
const dimensions = computed(() => costDimensions(props.product))
const separateMode = computed(() => costs.value.some(row => row.match.references))
const complexReferences = computed(() => costs.value.some(row => row.match.output_formats?.length) || hasDetailedReferencePricingRules({ ...props.product, pricing_rules: costs.value.map(row => ({ match: row.match, sale_price: row.cost })) }))
const available = computed(() => ([{ key: 'resolution', label: '分辨率', values: props.product.capabilities.resolutions }, { key: 'aspect_ratio', label: '比例', values: props.product.capabilities.aspect_ratios }, { key: 'quality', label: '画质', values: props.product.capabilities.qualities }, { key: 'duration_seconds', label: '时长', values: props.product.capabilities.durations_seconds }] as const).filter(item => item.values.length || dimensions.value.includes(item.key)))
const adopted = ref(false)
watch(() => props.dirty, dirty => { if (dirty === false) adopted.value = false })
const matrixMessage = ref('')
const costFor = (row: CostSpecRow) => row.costIndex === undefined ? null : costs.value[row.costIndex]!.cost
const priceFor = (row: CostSpecRow) => row.priceIndex === undefined ? null : prices.value[row.priceIndex]!.sale_price
const legacy = (value: Price | null) => value && (value.currency !== 'CNY' || value.billing_mode !== 'per_request')
function amountError(value: Price | null, sale = false) {
  if (!value) return ''
  return decimalError(value.amount) || (sale && !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(value.amount) ? '请输入有效售价，最多 8 位小数。' : '') || (sale && decimalUnits(value.amount) === 0n ? '客户售价须大于 0 CNY；0 元可保留草稿，但不能发布或生成。' : '')
}
const profit = (row: CostSpecRow) => grossProfit(costFor(row), priceFor(row))
const estimate = (row: CostSpecRow, memory: CostMemory) => estimateCost(memory.purchase, memory.credits, memory.consumption[row.consumptionKey] ?? '', null)
function costSuggestion(row: CostSpecRow, memory: CostMemory) {
  const amount = estimate(row, memory).cost
  return amount === undefined ? durationSuggestion(props.product, row, 'cost') : { amount, basis: '实际采购金额 ÷ 到账积分 × 本规格整条任务积分消耗；不再乘时长。' }
}
const saleSuggestion = (row: CostSpecRow) => durationSuggestion(props.product, row, 'sale')
const canApply = (amount?: string) => amount !== undefined && decimalUnits(amount) !== undefined
function conflictingEstimates(row: CostSpecRow, memory: CostMemory) {
  if (row.costIndex === undefined) return false
  const values = joined.value.rows.filter(other => other.costIndex === row.costIndex).map(other => estimate(other, memory).cost).filter((value): value is string => value !== undefined)
  return new Set(values).size > 1
}
const costSelector = (row: CostSpecRow, index: number) => row.costIndex !== undefined && joined.value.rows.find(value => value.costIndex === row.costIndex) === row ? `procurement-cost-${row.costIndex}` : `spec-cost-${index}`
const priceSelector = (row: CostSpecRow, index: number) => row.priceIndex !== undefined && joined.value.rows.find(value => value.priceIndex === row.priceIndex) === row ? `price-${row.priceIndex}` : `spec-price-${index}`
const advancedCostSelector = (index: number) => joined.value.rows.some(row => row.costIndex === index) ? `advanced-cost-${index}` : `procurement-cost-${index}`
const advancedPriceSelector = (index: number) => joined.value.rows.some(row => row.priceIndex === index) ? `advanced-price-${index}` : `price-${index}`
function replace(next: CostRule[]) { if (!props.disabled) emit('update:product', { ...props.product, cost_rules: next }) }
function rebuild(nextDimensions: PricingDimension[], mode: boolean): boolean {
  const next = buildCostRules(props.product, nextDimensions, mode)
  if (!next) { matrixMessage.value = '请先修正规格或组合限制；成本行最多 100 行。已有成本保留。'; return false }
  if (costs.value.some(row => row.cost) && next.some(row => row.cost === null) && !window.confirm('此修改可能合并不同成本或改变覆盖范围，冲突项会待填写。确认修改采购成本条件？')) return false
  matrixMessage.value = ''; adopted.value = false; replace(next); return true
}
function toggle(key: PricingDimension, event: Event) { const input = event.target as HTMLInputElement; if (!rebuild(input.checked ? [...dimensions.value, key] : dimensions.value.filter(value => value !== key), separateMode.value)) input.checked = !input.checked }
function changeMode(event: Event) { const input = event.target as HTMLInputElement; if (!rebuild(dimensions.value, input.checked)) input.checked = !input.checked }
function setAmount(index: number, amount: string, source: CostRule['source'] = 'manual') {
  const next = JSON.parse(JSON.stringify(costs.value)) as CostRule[]
  next[index] = { ...next[index]!, cost: amount === '' ? null : { amount, currency: 'CNY', billing_mode: 'per_request' }, source }
  adopted.value = source === 'calculator'; replace(next)
}
function setPrice(index: number, amount: string) {
  if (props.disabled) return
  const next = JSON.parse(JSON.stringify(prices.value)) as Product['pricing_rules']
  next[index] = { ...next[index]!, sale_price: amount === '' ? null : { amount, currency: 'CNY', billing_mode: 'per_request' } }
  emit('update:product', { ...props.product, pricing_rules: next })
}
function setSpecCost(row: CostSpecRow, amount: string, source: CostRule['source'] = 'manual') {
  if (props.disabled || row.costConflict) return
  if (row.costIndex !== undefined) setAmount(row.costIndex, amount, source)
  else if (amount !== '') {
    if (costs.value.length >= maxCostRules) { matrixMessage.value = '采购成本规则最多 100 条，请在高级规则中核对覆盖范围。'; return }
    replace([...costs.value, { match: row.match, cost: { amount, currency: 'CNY', billing_mode: 'per_request' }, source }])
  }
}
function setSpecPrice(row: CostSpecRow, amount: string) {
  if (props.disabled || row.priceConflict) return
  if (row.priceIndex !== undefined) setPrice(row.priceIndex, amount)
  else if (amount !== '') emit('update:product', { ...props.product, pricing_rules: [...prices.value, { match: row.match, sale_price: { amount, currency: 'CNY', billing_mode: 'per_request' } }] })
}
function adoptCost(row: CostSpecRow, amount: string) {
  if (props.disabled || !canApply(amount) || row.costConflict) return
  if (costFor(row) && costFor(row)!.amount !== amount && !window.confirm(`当前成本已有填写，确认采用 ${amount} CNY${row.costCount > 1 ? `，影响 ${row.costCount} 个规格行的共享成本` : ''}？`)) return
  setSpecCost(row, amount, 'calculator'); adopted.value = true
}
function adoptSale(row: CostSpecRow, amount: string) {
  if (props.disabled || decimalUnits(amount, true) === undefined || row.priceConflict) return
  if (priceFor(row) && priceFor(row)!.amount !== amount && !window.confirm('当前售价已有填写。确认采用建议售价？')) return
  setSpecPrice(row, amount); adopted.value = true
}
function setMatch(index: number, match: Match) { const next = JSON.parse(JSON.stringify(costs.value)) as CostRule[]; next[index] = { ...next[index]!, match, source: 'manual' }; adopted.value = false; replace(next) }
function removeRule(index: number) { if (costs.value[index]?.cost && !window.confirm('确认从当前草稿移除此采购成本条件？')) return; adopted.value = false; replace(costs.value.filter((_, rowIndex) => rowIndex !== index)) }
</script>
<style scoped>
.mw-cost-partitions,.mw-advanced-rules{margin:16px 0;padding:12px;border:1px solid var(--mw-border);border-radius:10px;min-width:0}.mw-cost-partitions summary,.mw-advanced-rules summary{cursor:pointer;font-size:13px;font-weight:600}.mw-spec-table{min-width:0;border:1px solid var(--mw-border);border-radius:12px;overflow:hidden}.mw-spec-head,.mw-spec-row{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) minmax(0,.85fr);gap:16px;padding:16px}.mw-spec-head{background:var(--mw-soft);font-size:12px;font-weight:600}.mw-spec-row+.mw-spec-row{border-top:1px solid var(--mw-border)}.mw-spec-row>div,.mw-spec-row>dl{min-width:0}.mw-spec-identity,.mw-spec-amount{display:flex;flex-direction:column;gap:10px}.mw-spec-row .mw-field{display:grid;gap:7px;font-size:12px;margin:0;min-width:0}.mw-spec-row :is(strong,p,small){overflow-wrap:anywhere}.mw-spec-row .input{width:100%;min-width:0;box-sizing:border-box}.mw-spec-identity>span{font-size:12px;overflow-wrap:anywhere}.mw-converted-cost{font-weight:600;font-variant-numeric:tabular-nums}.mw-shared{font-size:12px;color:var(--mw-muted);margin:0;line-height:1.6}.mw-suggestion{display:grid;gap:6px;font-size:12px;padding:10px;background:var(--mw-soft);border-radius:8px}.mw-suggestion small{color:var(--mw-muted);line-height:1.6}.mw-suggestion button{text-align:left;align-self:start}.mw-spec-profit{margin:0;display:flex;flex-direction:column;gap:8px;font-size:12px}.mw-spec-profit dt,.mw-spec-profit small{color:var(--mw-muted)}.mw-spec-profit dd{margin:0;font-size:16px;font-weight:600;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.mw-cost-loss{color:#b43c23}.mw-advanced-rule{display:grid;gap:10px;padding:16px 0;border-top:1px solid var(--mw-border);margin-top:12px;min-width:0}.mw-advanced-rule>.mw-field{max-width:400px}.mw-price-state{font-size:12px;color:var(--mw-muted)}
@media(max-width:1050px){.mw-spec-head{display:none}.mw-spec-row{grid-template-columns:repeat(2,minmax(0,1fr))}.mw-spec-identity{grid-column:1/-1}.mw-spec-profit{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr}.mw-spec-profit small{grid-column:1/-1}.mw-spec-identity>.mw-field{max-width:340px}}
@media(max-width:560px){.mw-spec-row{grid-template-columns:minmax(0,1fr);padding:14px;gap:18px}.mw-spec-identity,.mw-spec-profit{grid-column:auto}.mw-spec-identity>.mw-field{max-width:none}.mw-spec-profit{grid-template-columns:minmax(0,1fr)}.mw-spec-profit small{grid-column:auto}}
</style>
