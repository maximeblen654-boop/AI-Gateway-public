<template>
  <fieldset :disabled="disabled" class="mw-product-fields">
    <section data-field="model">
      <h3 data-test="upstream-model-name">{{ product.upstream_model }}</h3>
      <p class="mw-muted" data-test="internal-id">内部 ID: {{ product.site_model }}</p>
      <label class="mw-field">展示名称<input :value="product.display_name" class="input" data-test="display-name" data-field="display_name" @input="edit(next => { next.display_name = text($event) })" /></label>
      <label class="mw-field">业务用途<select :value="product.media_type" class="input" data-field="media_type" @change="edit(next => { next.media_type = text($event); next.capabilities.count = { min: 1, max: next.media_type === 'video' ? 1 : 10 } })"><option v-for="type in mediaTypes" :key="type" :value="type">{{ type === 'image' ? '图片' : '视频' }}</option></select></label>
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
        <MediaTokensField label="分辨率" :presets="resolutionPresets" placeholder="例如：1K, 2K, 2048x2048" :model-value="product.capabilities.resolutions" @update:model-value="setCapability('resolution', $event)" />
        <MediaTokensField label="比例" :presets="ratioPresets" placeholder="例如：1:1, 16:9" :model-value="product.capabilities.aspect_ratios" @update:model-value="setCapability('aspect_ratio', $event)" />
        <MediaTokensField v-if="product.media_type === 'video'" label="时长（秒）" numeric :presets="durationPresets" placeholder="例如：5, 10, 15" :model-value="product.capabilities.durations_seconds" @update:model-value="setCapability('duration_seconds', $event)" />
        <div data-test="quantity-policy">
          <p class="mw-muted">{{ product.media_type === 'video' ? '视频固定为 1 条。' : '系统图片购买范围为 1～10 张；上游请求由系统按接口能力分批。' }}</p>
          <template v-if="product.media_type === 'image' && (product.capabilities.count.min !== 1 || product.capabilities.count.max !== 10)">
            <p class="mw-muted">此历史草稿保留 {{ product.capabilities.count.min }}～{{ product.capabilities.count.max }} 张。应用系统范围后，仍须保存、校验并发布才会影响新报价；历史报价和任务不变。</p>
            <button type="button" class="btn btn-secondary" data-test="apply-system-count" @click="edit(next => { next.capabilities.count = { min: 1, max: 10 } })">在草稿应用 1～10 张</button>
          </template>
        </div>
        <template v-for="kind in referenceKinds" :key="kind.key">
          <label class="mw-field">{{ kind.label }}下限<input :value="product.capabilities.references[kind.key].min" class="input" type="number" step="1" @input="edit(next => { next.capabilities.references[kind.key].min = numeric($event) })" /></label>
          <label class="mw-field">{{ kind.label }}上限<input :value="product.capabilities.references[kind.key].max" class="input" type="number" step="1" @input="edit(next => { next.capabilities.references[kind.key].max = numeric($event) })" /></label>
        </template>
        <label class="mw-field">参考素材合计上限<input :value="product.capabilities.references.total_max" class="input" type="number" step="1" @input="edit(next => { next.capabilities.references.total_max = numeric($event) })" /></label>
      </div>
      <details><summary>可选画质</summary><MediaTokensField label="画质（仅填写已确认支持的值）" :presets="qualityPresets" placeholder="例如：standard, high" :model-value="product.capabilities.qualities" @update:model-value="setCapability('quality', $event)" /></details>
      <details><summary>组合限制（可选）</summary>
        <p class="mw-muted">只录入已确认不可用的组合；没有规则时保持为空。</p>
        <div v-for="(rule, index) in product.capabilities.combination_rules" :key="index" class="mw-rule">
          <p>禁止组合 {{ index + 1 }}</p><MediaMatchEditor :model-value="rule.deny" @update:model-value="updateCombination(index, $event)" />
          <button type="button" class="btn btn-secondary" @click="removeCombination(index)">移除此限制</button>
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
    <details v-if="product.media_type === 'image'" data-test="image-execution-advanced">
      <summary>高级技术配置：图片接口单请求能力</summary>
      <p class="mw-muted">由管理员依据已确认的 Account、模型和接口能力配置；这不是系统实测结果。未确认多图时保留单图，无需为购买多张修改接口能力。</p>
    <section data-field="adapter_config.execution">
      <h3>文生图单请求产出能力</h3>
      <p class="mw-muted">只填写已经核实的 Account、模型和接口能力；未知或没有多图证据时保持单图，客户 1～10 张会按批次执行。客户购买数量不在这里配置。</p>
      <div class="mw-field-grid">
        <label class="mw-field">执行方式<select :value="product.adapter_config.execution?.mode ?? 'single'" class="input" data-test="image-execution-mode" @change="edit(next => { const mode = text($event) as 'single' | 'native_multi'; next.adapter_config.execution = { ...(next.adapter_config.execution ?? {}), mode, max_output_images: mode === 'native_multi' ? Math.max(2, next.adapter_config.execution?.max_output_images ?? 2) : 1 }; delete next.adapter_config.execution!.provider })">
          <option value="single">单图接口（未知能力也用此项）</option><option value="native_multi">已核实原生多图（使用 n）</option>
        </select></label>
        <label class="mw-field">单请求最多输出图片数<input :value="product.adapter_config.execution?.max_output_images ?? 1" class="input" data-test="image-execution-max" type="number" :min="product.adapter_config.execution?.mode === 'native_multi' ? 2 : 1" max="10" step="1" :disabled="product.adapter_config.execution?.mode !== 'native_multi'" @input="edit(next => { const mode = next.adapter_config.execution?.mode ?? 'single'; next.adapter_config.execution = { ...(next.adapter_config.execution ?? {}), mode, max_output_images: mode === 'native_multi' ? numeric($event) : 1 } })" /><small>这是上游单请求上限，不是客户一次购买数量。</small></label>
      </div>
    </section>
    <section v-if="product.capabilities.references.image.max > 0" data-field="adapter_config.edit_execution">
      <h3>参考图编辑单请求产出能力</h3>
      <p class="mw-muted">这是参考图编辑接口的独立管理员配置；未填写时按单图执行，不会继承文生图多图能力。这里只记录已确认能力，不代表系统已对供应商实测。</p>
      <div class="mw-field-grid">
        <label class="mw-field">编辑执行方式<select :value="product.adapter_config.edit_execution?.mode ?? 'single'" class="input" data-test="image-edit-execution-mode" @change="edit(next => { const mode = text($event) as 'single' | 'native_multi'; next.adapter_config.edit_execution = { ...(next.adapter_config.edit_execution ?? {}), mode, max_output_images: mode === 'native_multi' ? Math.max(2, next.adapter_config.edit_execution?.max_output_images ?? 2) : 1 }; delete next.adapter_config.edit_execution!.provider })">
          <option value="single">单图接口（默认）</option><option value="native_multi">已核实原生多图（使用 n）</option>
        </select></label>
        <label class="mw-field">编辑单请求最多输出图片数<input :value="product.adapter_config.edit_execution?.max_output_images ?? 1" class="input" data-test="image-edit-execution-max" type="number" :min="product.adapter_config.edit_execution?.mode === 'native_multi' ? 2 : 1" max="10" step="1" :disabled="product.adapter_config.edit_execution?.mode !== 'native_multi'" @input="edit(next => { const mode = next.adapter_config.edit_execution?.mode ?? 'single'; next.adapter_config.edit_execution = { ...(next.adapter_config.edit_execution ?? {}), mode, max_output_images: mode === 'native_multi' ? numeric($event) : 1 } })" /><small>客户购买数量仍由商品规格控制；没有编辑能力配置时每次只提交一张。</small></label>
      </div>
    </section>
    </details>
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
      <h3>哪些选项会改变单价？</h3>
      <p class="mw-muted">只为勾选的选项组合填写单{{ unitLabel }}价格。数量按单价 × 数量计算；视频时长只决定单条价格，不再乘秒数。</p>
      <div class="mw-pricing-dimensions" role="group" aria-label="会改变单价的规格">
        <label v-for="dimension in pricingDimensionDefinitions" :key="dimension.key" class="mw-check-card">
          <input type="checkbox" :checked="activePricingDimensions.includes(dimension.key)" :disabled="disabled || !dimensionValues(dimension.key).length && !activePricingDimensions.includes(dimension.key)" :data-test="`pricing-dimension-${dimension.key}`" @change="togglePricingDimension(dimension.key, $event)" />
          <span><strong>按{{ dimension.label }}分别定价</strong><small>{{ dimensionValues(dimension.key).length ? `${dimensionValues(dimension.key).length} 个可用值` : '先填写能力值' }}</small></span>
        </label>
      </div>
      <p class="mw-muted" data-test="same-price-specs">{{ samePriceText }}</p>
      <div v-for="(rule, index) in priceRows" :key="index" class="mw-rule">
        <strong>{{ pricingRuleLabel(rule) }}</strong>
        <label class="mw-field">单{{ unitLabel }}价格（CNY）
          <input class="input" inputmode="decimal" placeholder="待填写" :value="rule.sale_price?.amount ?? ''" :data-test="`price-${index}`" :aria-describedby="`media-price-hint-${index}`" @input="setAmount(index, $event)" />
          <small :id="`media-price-hint-${index}`">{{ rule.sale_price == null ? '待填写：未配置售价' : /^0(?:\.0+)?$/.test(rule.sale_price.amount) ? '明确免费：0 元' : '已填写单价' }}</small>
        </label>
        <p v-if="rule.sale_price && (rule.sale_price.currency !== 'CNY' || rule.sale_price.billing_mode !== 'per_request')" class="mw-muted">原价格使用 {{ rule.sale_price.currency }} / {{ rule.sale_price.billing_mode }}，重新填写后按 CNY / {{ unitLabel }}保存。</p>
        <button v-if="rule.sale_price" type="button" class="btn btn-secondary" @click="edit(next => { next.pricing_rules[index]!.sale_price = null })">清空单价</button>
      </div>
      <p class="mw-muted" data-test="pricing-row-summary">价格行：{{ priceRows.length }}，已填写 {{ filledPricingRows }}，待填写 {{ priceRows.length - filledPricingRows }}。</p>
      <div class="mw-price-preview" data-test="pricing-preview">
        <strong>客户报价预览</strong>
        <div class="mw-field-grid">
          <label v-for="dimension in previewDimensions" :key="dimension.key" class="mw-field">{{ dimension.label }}<select class="input" :value="previewValue(dimension.key)" :data-test="`preview-${dimension.key}`" @change="previewSelection[dimension.key] = text($event)"><option v-for="value in dimensionValues(dimension.key)" :key="value" :value="value">{{ value }}</option></select></label>
          <label class="mw-field">数量（{{ unitLabel }}）<input v-model.number="previewQuantity" class="input" data-test="preview-quantity" type="number" :min="product.capabilities.count.min" :max="product.capabilities.count.max" :disabled="product.media_type === 'video'" /></label>
        </div>
        <span v-if="pricingPreview">单价：{{ pricingPreview.unit }} CNY / {{ unitLabel }} × {{ previewQuantity }} {{ unitLabel }} = 总价：{{ pricingPreview.total }} CNY</span>
        <span v-else>当前组合价格待填写，或数量不在已配置范围内。</span>
        <small>仅预览当前草稿；实际报价由服务器核验并冻结，不保存或生成。</small>
      </div>
    </section>
  </fieldset>
</template>
<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { Product } from '@/api/admin/mediaWorkbench'
import MediaTokensField from './MediaTokensField.vue'
import MediaMatchEditor from './MediaMatchEditor.vue'
import { allowedSpecs, buildPricingRules, dimensionsFor, matchesSpec, pricingDimensions, type MatrixSpec, type PricingDimension } from './pricingMatrix'
const props = defineProps<{ product: Product; mediaTypes: string[]; disabled: boolean }>()
const emit = defineEmits<{ 'update:product': [value: Product]; identity: [value: string] }>()
const text = (event: Event) => (event.target as HTMLInputElement).value
const numeric = (event: Event) => Number(text(event))
const ratioPresets = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '9:21', '21:9']
const durationPresets = ['5', '10', '15']
const qualityPresets = ['standard', 'high', 'hd', 'ultra']
const resolutionPresets = computed(() => props.product.media_type === 'video' ? ['720p', '1080p', '4K'] : ['1K', '2K', '4K'])
const pricingDimensionDefinitions: { key: PricingDimension; label: string }[] = [
  { key: 'resolution', label: '分辨率' },
  { key: 'aspect_ratio', label: '比例' },
  { key: 'quality', label: '画质' },
  { key: 'duration_seconds', label: '时长' }
]

function valuesFor(product: Product, key: PricingDimension): (string | number)[] {
  const capability = key === 'resolution' ? product.capabilities.resolutions
    : key === 'aspect_ratio' ? product.capabilities.aspect_ratios
      : key === 'quality' ? product.capabilities.qualities
        : product.capabilities.durations_seconds
  const configured = [...(capability ?? [])].map(String)
  if (configured.length) return [...new Set(configured)]
  const result: (string | number)[] = []
  for (const rule of product.pricing_rules ?? []) {
    const values = rule.match[key]
    if (Array.isArray(values)) result.push(...values)
  }
  return [...new Set(result.map(String))]
}
function dimensionValues(key: PricingDimension): string[] { return valuesFor(props.product, key).map(String) }
function matchValues(match: Product['pricing_rules'][number]['match'], key: PricingDimension): string[] {
  const values = match[key]
  return Array.isArray(values) ? values.map(String) : []
}
function sellableSpecs(product: Product) {
  const capabilities = {
    ...product.capabilities,
    resolutions: product.capabilities.resolutions.length ? product.capabilities.resolutions : valuesFor(product, 'resolution').map(String),
    aspect_ratios: product.capabilities.aspect_ratios.length ? product.capabilities.aspect_ratios : valuesFor(product, 'aspect_ratio').map(String),
    qualities: product.capabilities.qualities.length ? product.capabilities.qualities : valuesFor(product, 'quality').map(String),
    durations_seconds: product.capabilities.durations_seconds.length ? product.capabilities.durations_seconds : valuesFor(product, 'duration_seconds').map(Number)
  }
  return allowedSpecs(capabilities)
}
const activePricingDimensions = computed<PricingDimension[]>(() => dimensionsFor(props.product))
function losesPrices(previous: Product, nextRules: Product['pricing_rules'], specs: MatrixSpec[]): boolean {
  return previous.pricing_rules.some(previousRule => previousRule.sale_price && !specs.some(spec => {
    if (!matchesSpec(previousRule.match, spec)) return false
    return nextRules.some(nextRule => matchesSpec(nextRule.match, spec) && JSON.stringify(nextRule.sale_price) === JSON.stringify(previousRule.sale_price))
  }))
}
function editPricing(change: (value: Product) => void, dimensions = activePricingDimensions.value): boolean {
  if (props.disabled) return false
  const next: Product = JSON.parse(JSON.stringify(props.product))
  change(next)
  const specs = sellableSpecs(next)
  if (specs) {
    const rules = buildPricingRules(next, dimensions, specs)
    if (losesPrices(props.product, rules, specs) && typeof window !== 'undefined' && !window.confirm('此修改会移除或合并已有售价，相关价格将变为“待填写”。是否继续？')) return false
    next.pricing_rules = rules
  }
  emit('update:product', next)
  return true
}
function togglePricingDimension(key: PricingDimension, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const current = activePricingDimensions.value
  if (checked) {
    editPricing(() => {}, [...current, key])
    return
  }
  if (!editPricing(() => {}, current.filter(item => item !== key))) (event.target as HTMLInputElement).checked = true
}
function pricingRuleLabel(rule: Product['pricing_rules'][number]): string {
  const labels = pricingDimensionDefinitions.flatMap(({ key, label }) => {
    const values = matchValues(rule.match, key)
    return values.length ? [`${label} ${values.join(' / ')}`] : []
  })
  return labels.length ? labels.join(' · ') : '统一售价（所有未按维度区分的规格）'
}
const filledPricingRows = computed(() => (props.product.pricing_rules ?? []).filter(rule => !!rule.sale_price?.amount).length)
const priceRows = computed<Product['pricing_rules']>(() => props.product.pricing_rules?.length ? props.product.pricing_rules : [{ match: {}, sale_price: null }])
const unitLabel = computed(() => props.product.media_type === 'video' ? '条' : '张')
const previewSelection = reactive<Partial<Record<PricingDimension, string>>>({})
const previewQuantity = ref(1)
const previewDimensions = computed(() => pricingDimensionDefinitions.filter(({ key }) => dimensionValues(key).length))
const samePriceText = computed(() => {
  const active = activePricingDimensions.value.map(key => pricingDimensionDefinitions.find(item => item.key === key)?.label).filter(Boolean)
  const same = pricingDimensionDefinitions.filter(item => !activePricingDimensions.value.includes(item.key) && dimensionValues(item.key).length).map(item => `${item.label}（${dimensionValues(item.key).join('、')}）`)
  const activeText = active.length ? `当前按${active.join('、')}分别定价。` : '当前未按任何规格拆分价格，所有已启用规格使用统一单价。'
  return same.length ? `${activeText} ${same.join('、')}不改变单价。` : activeText
})
function syncPreview(product: Product) {
  for (const { key } of pricingDimensionDefinitions) {
    const values = valuesFor(product, key).map(String)
    if (!values.includes(previewSelection[key] ?? '')) previewSelection[key] = values[0]
  }
  const min = product.media_type === 'video' ? 1 : Math.max(1, product.capabilities.count.min || 1)
  const max = product.media_type === 'video' ? 1 : Math.max(min, product.capabilities.count.max || min)
  if (!Number.isInteger(previewQuantity.value) || previewQuantity.value < min || previewQuantity.value > max) previewQuantity.value = min
}
watch(() => props.product, syncPreview, { immediate: true })
function previewValue(key: PricingDimension): string { return previewSelection[key] ?? dimensionValues(key)[0] ?? '' }
function setCapability(key: PricingDimension, value: string[] | number[]) {
  const change = (next: Product) => {
    if (key === 'resolution') next.capabilities.resolutions = value.map(String)
    else if (key === 'aspect_ratio') next.capabilities.aspect_ratios = value.map(String)
    else if (key === 'quality') next.capabilities.qualities = value.map(String)
    else next.capabilities.durations_seconds = value.map(Number)
  }
  if (activePricingDimensions.value.length) editPricing(change)
  else edit(change)
}
function updateCombination(index: number, deny: Product['capabilities']['combination_rules'][number]['deny']) {
  editPricing(next => { next.capabilities.combination_rules[index]!.deny = deny })
}
function removeCombination(index: number) {
  editPricing(next => { next.capabilities.combination_rules.splice(index, 1) })
}
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
  const selected = previewDimensions.value.reduce<Record<string, string>>((result, { key }) => { result[key] = previewValue(key); return result }, {})
  const specs = sellableSpecs(props.product)
  const quantity = props.product.media_type === 'image' ? previewQuantity.value : 1
  if (!specs || !specs.some(spec => spec.count === quantity && pricingDimensions.every(key => !selected[key] || String(spec[key]) === selected[key]))) return undefined
  const matching = priceRows.value.filter(item => activePricingDimensions.value.every(key => { const values = matchValues(item.match, key); return !values.length || values.includes(selected[key] ?? '') }))
  const rule = matching.length === 1 ? matching[0] : undefined
  if (!rule?.sale_price || rule.sale_price.currency !== 'CNY' || rule.sale_price.billing_mode !== 'per_request' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(rule.sale_price.amount)) return undefined
  if (!Number.isInteger(quantity) || quantity < props.product.capabilities.count.min || quantity > props.product.capabilities.count.max) return undefined
  return { unit: rule.sale_price.amount, quantity, total: multiplyDecimalText(rule.sale_price.amount, quantity) }
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
    if (!next.pricing_rules?.length) next.pricing_rules = [{ match: {}, sale_price: null }]
    const rule = next.pricing_rules[index]!
    const amount = text(event)
    rule.sale_price = amount === '' ? null : { amount, currency: 'CNY', billing_mode: 'per_request' }
  })
}
</script>
