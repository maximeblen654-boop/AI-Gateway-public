<template>
  <fieldset :disabled="disabled" class="mw-product-fields">
    <section data-field="model">
      <h3 data-test="upstream-model-name">{{ product.upstream_model }}</h3>
      <p class="mw-muted" data-test="internal-id">内部 ID: {{ product.site_model }}</p>
      <label class="mw-field">展示名称<input :value="product.display_name" class="input" data-test="display-name" data-field="display_name" @input="edit(next => { next.display_name = text($event) })" /></label>
      <label class="mw-field">业务用途<select :value="product.media_type" class="input" data-field="media_type" @change="edit(next => { next.media_type = text($event) })"><option v-for="type in mediaTypes" :key="type" :value="type">{{ type === 'image' ? '图片' : '视频' }}</option></select></label>
      <label><input :checked="product.enabled" type="checkbox" @change="edit(next => { next.enabled = ($event.target as HTMLInputElement).checked })" /> 本站启用（发布后生效）</label>
      <details><summary>产品标识</summary>
        <label class="mw-field">产品 ID<input :value="product.product_id" class="input" data-field="product_id" @input="setIdentity" /></label>
        <label class="mw-field">本站模型 ID<input :value="product.site_model" class="input" data-field="site_model" @input="edit(next => { next.site_model = text($event) })" /></label>
      </details>
    </section>
    <section data-field="capabilities">
      <h3>规格</h3>
      <p class="mw-muted">按供应商实际能力填写，保存后由后台检查。</p>
      <div class="mw-field-grid">
        <MediaTokensField label="分辨率" :presets="resolutionPresets" placeholder="例如：1K, 2K, 2048x2048" :model-value="product.capabilities.resolutions" @update:model-value="edit(next => { next.capabilities.resolutions = $event as string[] })" />
        <MediaTokensField label="比例" :presets="ratioPresets" placeholder="例如：1:1, 16:9" :model-value="product.capabilities.aspect_ratios" @update:model-value="edit(next => { next.capabilities.aspect_ratios = $event as string[] })" />
        <MediaTokensField v-if="product.media_type === 'video'" label="时长（秒）" numeric :presets="durationPresets" placeholder="例如：5, 10, 15" :model-value="product.capabilities.durations_seconds" @update:model-value="edit(next => { next.capabilities.durations_seconds = $event as number[] })" />
        <label class="mw-field">单次生成数量下限<input :value="product.media_type === 'video' ? 1 : product.capabilities.count.min" class="input" type="number" step="1" :disabled="disabled || product.media_type === 'video'" @input="edit(next => { next.capabilities.count.min = product.media_type === 'video' ? 1 : numeric($event) })" /><small>{{ product.media_type === 'video' ? '视频协议固定为 1 条。' : '图片是每次生成的张数。' }}</small></label>
        <label class="mw-field">单次生成数量上限<input :value="product.media_type === 'video' ? 1 : product.capabilities.count.max" class="input" type="number" step="1" :disabled="disabled || product.media_type === 'video'" @input="edit(next => { next.capabilities.count.max = product.media_type === 'video' ? 1 : numeric($event) })" /><small>数量不会生成额外价格行。</small></label>
        <template v-for="kind in referenceKinds" :key="kind.key">
          <label class="mw-field">{{ kind.label }}下限<input :value="product.capabilities.references[kind.key].min" class="input" type="number" step="1" @input="edit(next => { next.capabilities.references[kind.key].min = numeric($event) })" /></label>
          <label class="mw-field">{{ kind.label }}上限<input :value="product.capabilities.references[kind.key].max" class="input" type="number" step="1" @input="edit(next => { next.capabilities.references[kind.key].max = numeric($event) })" /></label>
        </template>
        <label class="mw-field">参考素材合计上限<input :value="product.capabilities.references.total_max" class="input" type="number" step="1" @input="edit(next => { next.capabilities.references.total_max = numeric($event) })" /></label>
      </div>
      <details><summary>可选画质</summary><MediaTokensField label="画质（仅填写已确认支持的值）" :presets="qualityPresets" placeholder="例如：standard, high" :model-value="product.capabilities.qualities" @update:model-value="edit(next => { next.capabilities.qualities = $event as string[] })" /></details>
      <details><summary>组合限制（可选）</summary>
        <p class="mw-muted">只录入已确认不可用的组合；没有规则时保持为空。</p>
        <div v-for="(rule, index) in product.capabilities.combination_rules" :key="index" class="mw-rule">
          <p>禁止组合 {{ index + 1 }}</p><MediaMatchEditor :model-value="rule.deny" @update:model-value="edit(next => { next.capabilities.combination_rules[index]!.deny = $event })" />
          <button type="button" class="btn btn-secondary" @click="edit(next => { next.capabilities.combination_rules.splice(index, 1) })">移除此限制</button>
        </div>
        <button type="button" class="btn btn-secondary" @click="edit(next => { next.capabilities.combination_rules.push({ deny: {} }) })">添加禁止组合</button>
      </details>
    </section>
    <section v-if="product.media_type === 'video'" data-field="adapter_config.wire_profile">
      <h3>协议输入类型</h3>
      <p class="mw-muted">仅选择受控适配器已实现的协议表达；不会开放任意请求模板。</p>
      <label class="mw-field">素材协议<select :value="product.adapter_config.wire_profile ?? ''" class="input" data-test="wire-profile" @change="edit(next => { next.adapter_config.version = 1; next.adapter_config.wire_profile = text($event); delete next.adapter_config.model_family })">
        <option value="">请选择</option><option value="images">内联图片</option><option value="inline_multimedia">内联图片/视频/音频</option><option value="references">Account 引用素材</option>
      </select></label>
    </section>
    <section v-if="product.media_type === 'image'" data-field="adapter_config.model_family">
      <h3>图片协议族</h3>
      <p class="mw-muted">仅选择受控 JSON 图片适配器。</p>
      <label class="mw-field">适配器族<select :value="product.adapter_config.model_family ?? ''" class="input" data-test="model-family" @change="edit(next => { next.adapter_config.version = 1; next.adapter_config.model_family = text($event); delete next.adapter_config.wire_profile })">
        <option value="">请选择</option><option value="openai_json">OpenAI Images JSON</option>
      </select></label>
    </section>
    <section v-if="product.media_type === 'image'" data-field="adapter_config.size_mappings">
      <details data-test="size-mappings">
        <summary>供应商尺寸映射</summary>
        <p class="mw-muted">填写本站分辨率、比例对应的供应商尺寸值。保存后由后台检查；不修改请求字段或连接设置。</p>
        <div v-for="(mapping, index) in product.adapter_config.size_mappings" :key="index" class="mw-rule">
          <div class="mw-field-grid">
            <label class="mw-field">本站分辨率<input :value="mapping.resolution" class="input" :data-test="`mapping-resolution-${index}`" @input="edit(next => { next.adapter_config.size_mappings[index]!.resolution = text($event) })" /></label>
            <label class="mw-field">本站比例<input :value="mapping.aspect_ratio" class="input" :data-test="`mapping-aspect-${index}`" @input="edit(next => { next.adapter_config.size_mappings[index]!.aspect_ratio = text($event) })" /></label>
            <label class="mw-field">供应商尺寸值<input :value="mapping.wire_size" class="input" :data-test="`mapping-size-${index}`" @input="edit(next => { next.adapter_config.size_mappings[index]!.wire_size = text($event) })" /></label>
          </div>
          <button type="button" class="btn btn-secondary" :data-test="`remove-mapping-${index}`" @click="edit(next => { next.adapter_config.size_mappings.splice(index, 1) })">移除此映射</button>
        </div>
        <button type="button" class="btn btn-secondary" data-test="add-mapping" @click="edit(next => { next.adapter_config.size_mappings.push({ resolution: '', aspect_ratio: '', wire_size: '' }) })">添加尺寸映射</button>
      </details>
    </section>
    <section data-field="pricing_rules">
      <h3>本站售价与价格维度</h3>
      <p class="mw-muted">客户可以选择已发布的全部规格；只有勾选为“会改变单价”的维度才生成价格行。数量始终按单价 × 数量计算，不进入价格矩阵。</p>
      <div class="mw-pricing-dimensions" role="group" aria-label="会改变单价的规格">
        <label v-for="dimension in pricingDimensionDefinitions" :key="dimension.key" class="mw-check-card">
          <input type="checkbox" :checked="activePricingDimensions.includes(dimension.key)" :disabled="disabled || !dimensionValues(dimension.key).length" :data-test="`pricing-dimension-${dimension.key}`" @change="togglePricingDimension(dimension.key, $event)" />
          <span><strong>{{ dimension.label }}</strong><small>{{ dimensionValues(dimension.key).length ? `${dimensionValues(dimension.key).length} 个可用值` : '先填写能力值' }}</small></span>
        </label>
      </div>
      <p class="mw-muted">不勾选时使用统一售价；比例仍可选择和发送请求，只与其他价格相同。取消有不同价格的维度时会要求确认合并。</p>
      <div v-for="(rule, index) in product.pricing_rules" :key="index" class="mw-rule">
        <strong>{{ pricingRuleLabel(rule) }}</strong>
        <label class="mw-field">售价
          <input class="input" inputmode="decimal" :value="rule.sale_price?.amount ?? ''" :data-test="`price-${index}`" :aria-describedby="`media-price-hint-${index}`" @input="setAmount(index, $event)" />
          <small :id="`media-price-hint-${index}`">{{ rule.sale_price == null ? '未配置售价' : /^0(?:\.0+)?$/.test(rule.sale_price.amount) ? '明确免费：0 元' : '已填写售价' }}</small>
        </label>
        <template v-if="rule.sale_price">
          <label class="mw-field">币种<input :value="rule.sale_price.currency" class="input" @input="edit(next => { next.pricing_rules[index]!.sale_price!.currency = text($event) })" /></label>
          <label class="mw-field">计价单位<select :value="rule.sale_price.billing_mode" class="input" @change="edit(next => { next.pricing_rules[index]!.sale_price!.billing_mode = text($event) })"><option value="per_request">每次请求</option><option value="per_second">每秒</option></select></label>
        </template>
        <details><summary>此行覆盖的规格</summary><p class="mw-muted">{{ pricingRuleLabel(rule) }}。单次数量不参与价格行。</p></details>
        <button type="button" class="btn btn-secondary" @click="edit(next => { next.pricing_rules.splice(index, 1) })">移除此售价</button>
      </div>
      <p v-if="product.pricing_rules.length" class="mw-muted" data-test="pricing-row-summary">价格行：{{ product.pricing_rules.length }}，已填写 {{ filledPricingRows }}，待填写 {{ pendingPricingRows }}。</p>
      <div v-if="pricingPreview" class="mw-price-preview" data-test="pricing-preview"><strong>客户报价预览</strong><span>{{ pricingPreview.unit }} {{ pricingPreview.currency }} / {{ pricingPreview.quantity }} 份 = {{ pricingPreview.total }} {{ pricingPreview.currency }}</span><small>这是当前填写价格的展示预览；服务器会在报价时冻结规格、单位价、数量和总价。</small></div>
      <button v-if="!activePricingDimensions.length && !product.pricing_rules.length" type="button" class="btn btn-secondary" data-test="add-price" @click="edit(next => { next.pricing_rules.push({ match: {}, sale_price: null }) })">添加统一售价</button>
    </section>
  </fieldset>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import type { Product } from '@/api/admin/mediaWorkbench'
import MediaTokensField from './MediaTokensField.vue'
import MediaMatchEditor from './MediaMatchEditor.vue'
const props = defineProps<{ product: Product; mediaTypes: string[]; disabled: boolean }>()
const emit = defineEmits<{ 'update:product': [value: Product]; identity: [value: string] }>()
const text = (event: Event) => (event.target as HTMLInputElement).value
const numeric = (event: Event) => Number(text(event))
type PricingDimensionKey = 'resolution' | 'aspect_ratio' | 'quality' | 'duration_seconds'
const ratioPresets = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '9:21', '21:9']
const durationPresets = ['5', '10', '15']
const qualityPresets = ['standard', 'high', 'hd', 'ultra']
const resolutionPresets = computed(() => props.product.media_type === 'video' ? ['720p', '1080p', '4K'] : ['1K', '2K', '4K'])
const pricingDimensionDefinitions: { key: PricingDimensionKey; label: string }[] = [
  { key: 'resolution', label: '分辨率' },
  { key: 'aspect_ratio', label: '比例' },
  { key: 'quality', label: '画质' },
  { key: 'duration_seconds', label: '时长' }
]

function valuesFor(product: Product, key: PricingDimensionKey): (string | number)[] {
  const capability = key === 'resolution' ? product.capabilities.resolutions
    : key === 'aspect_ratio' ? product.capabilities.aspect_ratios
      : key === 'quality' ? product.capabilities.qualities
        : product.capabilities.durations_seconds
  const result: (string | number)[] = [...(capability ?? [])]
  for (const rule of product.pricing_rules ?? []) {
    const values = rule.match[key]
    if (Array.isArray(values)) result.push(...values)
  }
  return [...new Set(result.map(String))]
}
function dimensionValues(key: PricingDimensionKey): string[] { return valuesFor(props.product, key).map(String) }
function matchValues(match: Product['pricing_rules'][number]['match'], key: PricingDimensionKey): string[] {
  const values = match[key]
  return Array.isArray(values) ? values.map(String) : []
}
const activePricingDimensions = computed<PricingDimensionKey[]>(() => pricingDimensionDefinitions
  .filter(({ key }) => (props.product.pricing_rules ?? []).some(rule => matchValues(rule.match, key).length > 0))
  .map(({ key }) => key))

function cartesian(values: string[][]): string[][] {
  return values.reduce<string[][]>((rows, current) => rows.flatMap(row => current.map(value => [...row, value])), [[]])
}
function pricingMatch(key: PricingDimensionKey, value: string): Record<string, string[]> {
  return key === 'resolution' ? { resolution: [value] }
    : key === 'aspect_ratio' ? { aspect_ratio: [value] }
      : key === 'quality' ? { quality: [value] }
        : { duration_seconds: [value] }
}
function buildPricingRules(product: Product, dimensions: PricingDimensionKey[]): Product['pricing_rules'] {
  const oldRules = product.pricing_rules ?? []
  if (!dimensions.length) {
    const source = oldRules.find(rule => Object.keys(rule.match).length === 0) ?? oldRules[0]
    return [{ match: {}, sale_price: source?.sale_price ?? null }]
  }
  const combinations = cartesian(dimensions.map(key => valuesFor(product, key).map(String))).filter(row => row.length === dimensions.length)
  return combinations.map(row => {
    const match = dimensions.reduce<Record<string, string[]>>((result, key, index) => Object.assign(result, pricingMatch(key, row[index]!)), {})
    const existing = oldRules.find(rule => dimensions.every((key, index) => {
      const values = matchValues(rule.match, key)
      return values.length === 1 && values[0] === row[index]
    }))
    return { match, sale_price: existing?.sale_price ?? null }
  })
}
function pricesDiffer(rules: Product['pricing_rules']): boolean {
  const amounts = new Set(rules.map(rule => rule.sale_price?.amount ?? ''))
  return amounts.size > 1
}
function togglePricingDimension(key: PricingDimensionKey, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const current = activePricingDimensions.value
  if (checked) {
    edit(next => { next.pricing_rules = buildPricingRules(next, [...current, key]) })
    return
  }
  if (pricesDiffer(props.product.pricing_rules ?? []) && typeof window !== 'undefined' && !window.confirm('取消此价格维度会把不同价格合并为一条统一价，是否继续？')) return
  edit(next => { next.pricing_rules = buildPricingRules(next, current.filter(item => item !== key)) })
}
function pricingRuleLabel(rule: Product['pricing_rules'][number]): string {
  const labels = pricingDimensionDefinitions.flatMap(({ key, label }) => {
    const values = matchValues(rule.match, key)
    return values.length ? [`${label} ${values.join(' / ')}`] : []
  })
  return labels.length ? labels.join(' · ') : '统一售价（所有未按维度区分的规格）'
}
const filledPricingRows = computed(() => (props.product.pricing_rules ?? []).filter(rule => !!rule.sale_price?.amount).length)
const pendingPricingRows = computed(() => Math.max(0, (props.product.pricing_rules ?? []).length - filledPricingRows.value))
function multiplyDecimalText(left: string, right: number): string {
  if (!/^\d+(?:\.\d+)?$/.test(left) || !Number.isInteger(right) || right < 1) return left
  const [whole, fraction = ''] = left.split('.')
  const digits = BigInt(`${whole}${fraction}`) * BigInt(right)
  const scale = fraction.length
  if (!scale) return digits.toString()
  const text = digits.toString().padStart(scale + 1, '0')
  const result = `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return result
}
const pricingPreview = computed(() => {
  const rule = (props.product.pricing_rules ?? []).find(item => !!item.sale_price?.amount)
  if (!rule?.sale_price?.amount) return undefined
  const quantity = props.product.media_type === 'image' ? Math.max(1, props.product.capabilities.count.min || 1) : 1
  return { unit: rule.sale_price.amount, currency: rule.sale_price.currency, quantity, total: multiplyDecimalText(rule.sale_price.amount, quantity) }
})
function edit(change: (value: Product) => void) {
  if (props.disabled) return
  const next: Product = JSON.parse(JSON.stringify(props.product))
  change(next)
  emit('update:product', next)
}
function setIdentity(event: Event) {
  const id = text(event)
  edit(next => { next.product_id = id })
  emit('identity', id)
}
const referenceKinds = computed(() => props.product.media_type === 'video'
  ? [{ key: 'image', label: '参考图片' }, { key: 'video', label: '参考视频' }, { key: 'audio', label: '参考音频' }] as const
  : [{ key: 'image', label: '参考图片' }] as const)
function setAmount(index: number, event: Event) {
  edit(next => {
    const rule = next.pricing_rules[index]!
    const amount = text(event)
    rule.sale_price = amount === '' ? null : { amount, currency: rule.sale_price?.currency ?? 'CNY', billing_mode: rule.sale_price?.billing_mode ?? 'per_request' }
  })
}
</script>
