<template>
    <details class="mw-adapter-status" data-test="adapter-status" :open="adapterDiagnostics.length > 0">
      <summary>{{ adapterStatus.title }}</summary><p class="mw-muted">{{ adapterStatus.description }}</p>
      <p v-for="diagnostic in adapterDiagnostics" :key="diagnostic.code + diagnostic.path" class="mw-muted">{{ diagnostic.code }}：{{ diagnostic.message }} {{ diagnostic.action }}</p>
    </details>
  <fieldset ref="wizardElement" :disabled="disabled" class="mw-product-fields mw-wizard" :style="{ '--mw-step-index': wizardStep - 1 }">
    <nav class="mw-wizard-steps" aria-label="当前模型配置步骤">
      <button v-for="(label, index) in stepLabels" :key="label" type="button" :data-test="`wizard-step-${index + 1}`" :aria-current="wizardStep === index + 1 ? 'step' : undefined" @click="goToStep(index + 1)"><span>{{ index + 1 }}</span><strong>{{ label }}</strong></button>
    </nav>
    <div ref="stepHeading" class="mw-wizard-heading" tabindex="-1">
      <h3>{{ stepQuestions[wizardStep - 1] }}</h3>
      <p class="mw-muted">{{ stepDescriptions[wizardStep - 1] }}</p>
      <span class="mw-draft-state">{{ dirty ? '有未保存修改' : '正在查看草稿' }} · 切换步骤不会保存或发布</span>
    </div>
    <div v-show="wizardStep === 1" data-test="wizard-page-1">
    <section data-field="capabilities">

      <div class="mw-field-grid">
        <MediaTokensField label="分辨率" :presets="resolutionPresets" placeholder="例如：1K, 2K, 2048x2048" :model-value="product.capabilities.resolutions" @update:model-value="setCapability('resolution', $event)" />
        <MediaTokensField label="比例" aspect-ratio :presets="ratioPresets" placeholder="例如：1:1, 16:9" :model-value="product.capabilities.aspect_ratios" @update:model-value="setCapability('aspect_ratio', $event)" />
        <MediaTokensField v-if="product.media_type === 'video'" label="时长（秒）" numeric :presets="durationPresets" placeholder="例如：5, 10, 15" :model-value="product.capabilities.durations_seconds" @update:model-value="setCapability('duration_seconds', $event)" />
        <div data-test="quantity-policy">
          <p class="mw-muted">{{ product.media_type === 'video' ? '视频固定为 1 条。' : '系统图片购买范围为 1～10 张；上游请求由系统按接口能力分批。' }}</p>
          <template v-if="product.media_type === 'image' && (product.capabilities.count.min !== 1 || product.capabilities.count.max !== 10)">
            <p class="mw-muted">此历史草稿保留 {{ product.capabilities.count.min }}～{{ product.capabilities.count.max }} 张。应用系统范围后，仍须保存、校验并发布才会影响新报价；历史报价和任务不变。</p>
            <button type="button" class="btn btn-secondary" data-test="apply-system-count" @click="edit(next => { next.capabilities.count = { min: 1, max: 10 } })">在草稿应用 1～10 张</button>
          </template>
        </div>
      </div>

    </section>

    </div>
    <section v-show="wizardStep === 2" data-field="capabilities.references" data-test="wizard-page-2">
      <MediaReferenceEditor ref="referenceEditor" :model-value="product.capabilities.references" :media-type="product.media_type" :max-references="nativeAdapter?.max_references" @update:model-value="editPricing(next => { next.capabilities.references = $event })" />
    </section>
    <section v-show="wizardStep === 3" data-test="wizard-page-3">

      <p class="mw-muted">只为勾选的选项组合填写单{{ unitLabel }}价格。数量按单价 × 数量计算；视频时长只决定单条价格，不再乘秒数。</p>
      <div class="mw-pricing-dimensions" role="group" aria-label="会改变单价的规格">
        <label v-if="creationModePricingVisible" class="mw-check-card" :class="{ 'mw-check-card-selected': creationModePricing }" data-test="creation-mode-pricing">
          <input type="checkbox" :checked="creationModePricing" :disabled="disabled || creationModePricingLocked" @change="toggleCreationModePricing" />
          <span class="mw-check-content"><strong>文生图 / 图生图分别定价</strong><span class="mw-option-values">文生图 0 张参考图 · 图生图 1～{{ product.capabilities.references.image.max }} 张参考图</span><span class="mw-check-state">{{ creationModePricing ? '已选择 · 分别定价' : '不区分 · 共享单价' }}</span><small>{{ creationModePricingLocked ? '当前草稿已有更细的参考素材价格规则，继续保留原规则。' : creationModePricing ? '每个分辨率等规格会生成两行价格。' : '客户仍可选择两种创作方式，售价保持相同。' }}</small></span>
        </label>
        <label v-for="dimension in availablePricingDimensions" :key="dimension.key" class="mw-check-card" :class="{ 'mw-check-card-selected': activePricingDimensions.includes(dimension.key) }">
          <input type="checkbox" :checked="activePricingDimensions.includes(dimension.key)" :disabled="disabled || !dimensionValues(dimension.key).length && !activePricingDimensions.includes(dimension.key)" :data-test="`pricing-dimension-${dimension.key}`" @change="togglePricingDimension(dimension.key, $event)" />
          <span class="mw-check-content"><strong>{{ dimension.label }}不同，价格不同</strong><span class="mw-option-values">{{ dimensionValues(dimension.key).join(' · ') }}</span><span class="mw-check-state">{{ activePricingDimensions.includes(dimension.key) ? '已选择 · 分别定价' : '不区分 · 共享单价' }}</span><small>{{ activePricingDimensions.includes(dimension.key) ? '每个有效选项组合填写一个单价。' : '客户仍可选择这些规格，售价保持相同。' }}</small></span>
        </label>
      </div>
      <p v-if="!availablePricingDimensions.length" class="mw-muted" data-test="no-pricing-dimensions">尚未配置可用于定价的规格。可使用统一售价，或返回规格页面配置。</p>
      <p v-if="hiddenPricingDimensions.length" class="mw-banner" data-test="legacy-dimensions">已有价格包含当前规格页未配置的维度，已保留原规则。请先返回规格页核对，不能将其视为已确认能力。</p>
      <p class="mw-muted" data-test="same-price-specs">{{ samePriceText }}</p>
      <div class="mw-matrix-summary" aria-live="polite" data-test="expected-prices"><strong>{{ expectedPriceCount === undefined ? '暂时无法计算价格行数' : `下一步预计需要填写 ${expectedPriceCount} 个价格` }}</strong><p class="mw-muted">{{ expectedPriceCount === undefined ? '请先修正规格、素材上限或未完成的组合限制；已有价格保留。' : '已排除禁止组合；购买数量不会展开成价格行。' }}</p></div>
    </section>
    <section v-show="wizardStep === 4" data-field="pricing_rules" data-test="wizard-page-4">
      <p class="mw-muted">图片和视频售价均须大于 0 CNY；空白可保存草稿，但不能发布。 已有价格规则继续保留，由服务端核验。</p>
      <div class="mw-price-table" role="table" aria-label="商品单价表">
        <div class="mw-price-table-head" role="row"><span role="columnheader">规格组合</span><span role="columnheader">单{{ unitLabel }}售价 · CNY</span><span role="columnheader">填写状态</span></div>
        <div v-for="(rule, index) in priceRows" :key="index" class="mw-price-row" role="row">
          <div role="cell" class="mw-price-spec"><span class="mw-row-number">{{ String(index + 1).padStart(2, '0') }}</span><div><strong>{{ pricingRuleLabel(rule) }}</strong><p class="mw-muted">{{ samePriceText }}</p><button type="button" class="mw-link mw-row-cost" :data-test="`open-cost-${index}`" @click="calculator?.open(index, $event.currentTarget as HTMLElement)">估算成本 ↗</button></div></div>
          <div role="cell"><label class="mw-field"><span class="mw-price-mobile-label">单{{ unitLabel }}售价 · CNY</span>
            <input class="input" inputmode="decimal" placeholder="待填写" :aria-label="`${pricingRuleLabel(rule)} 单${unitLabel}价格（CNY）`" :value="rule.sale_price?.amount ?? ''" :data-test="`price-${index}`" :aria-invalid="!!priceError(rule)" :aria-describedby="`media-price-hint-${index}`" @input="setAmount(index, $event)" />
          </label><p v-if="priceError(rule)" class="mw-field-error" role="alert">{{ priceError(rule) }}</p><p v-if="rule.sale_price && (rule.sale_price.currency !== 'CNY' || rule.sale_price.billing_mode !== 'per_request')" class="mw-muted">原价格 {{ rule.sale_price.currency }} / {{ rule.sale_price.billing_mode }}；重新填写才改为 CNY / {{ unitLabel }}。</p></div>
          <div role="cell" class="mw-price-state"><span :id="`media-price-hint-${index}`" :class="{ 'mw-price-missing': rule.sale_price == null }">{{ rule.sale_price == null ? '待填写' : priceError(rule) ? '需要修正' : '已填写' }}</span><button v-if="rule.sale_price" type="button" class="mw-link" @click="edit(next => { next.pricing_rules[index]!.sale_price = null })">清空单价</button></div>
        </div>
      </div>
      <MediaCostCalculator ref="calculator" :active="wizardStep === 4" @toggle="emit('cost-toggle', $event)" :product="product" :account-id="accountId" :admin-id="adminId" :labels="priceRows.map(pricingRuleLabel)" />
      <p class="mw-muted" data-test="pricing-row-summary">价格行：{{ priceRows.length }}，已填写 {{ filledPricingRows }}，待填写 {{ priceRows.length - filledPricingRows }}。</p>
    </section>
    <section v-show="wizardStep === 5" data-test="wizard-page-5">
      <label class="mw-field">商品名称<input :value="product.display_name" class="input" data-test="display-name" data-field="display_name" @input="edit(next => { next.display_name = text($event) })" /></label>
      <p class="mw-muted" data-field="model">{{ accountLabel || '当前 Account' }} · {{ product.upstream_model }}</p>
      <div class="mw-review-block"><div class="mw-review-heading"><h3>客户可选规格</h3><button type="button" class="mw-link" @click="goToStep(1)">返回修改规格</button></div>
        <dl class="mw-review-specs"><template v-for="dimension in availablePricingDimensions" :key="dimension.key"><dt>{{ dimension.label }}</dt><dd>{{ configuredValues(dimension.key).join(' / ') }}</dd></template><dt>购买数量</dt><dd>{{ product.media_type === 'video' ? '固定 1 条' : `${product.capabilities.count.min}～${product.capabilities.count.max} 张` }}</dd></dl>
      </div>
      <div class="mw-review-block"><div class="mw-review-heading"><h3>参考素材要求</h3><button type="button" class="mw-link" @click="goToStep(2)">返回修改素材</button></div><p class="mw-muted">{{ referenceSummary }}</p></div>
      <div class="mw-review-block"><div class="mw-review-heading"><h3>价格档位</h3><button type="button" class="mw-link" @click="goToStep(3)">修改计费维度</button><button type="button" class="mw-link" @click="goToStep(4)">修改单价</button></div><p class="mw-muted">{{ samePriceText }}</p>
        <dl class="mw-review-prices"><div v-for="(rule, index) in priceRows" :key="index"><dt>{{ pricingRuleLabel(rule) }}</dt><dd>{{ rule.sale_price ? `${rule.sale_price.amount} ${rule.sale_price.currency} / ${unitLabel}` : '待填写' }}</dd></div></dl>
      </div>
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
      <slot name="review" />
      <slot name="save" />
    </section>
    <div class="mw-wizard-footer"><button v-if="wizardStep > 1" type="button" class="btn btn-secondary" data-test="wizard-back" @click="goToStep(wizardStep - 1)">← 上一步</button><span v-else class="mw-muted">仅编辑当前草稿</span><button v-if="wizardStep < 5" type="button" class="btn btn-primary" data-test="wizard-next" @click="goToStep(wizardStep + 1)">下一步：{{ stepLabels[wizardStep] }} →</button><span v-else class="mw-muted">保存不自动发布或启售。</span></div>
  </fieldset>
  <MediaTechnicalEditor :product="product" :media-types="mediaTypes" :disabled="disabled" :binding="binding" :native-adapter="nativeAdapter" @update:product="updateTechnical" />
</template>
<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { NativeAdapter, AdapterBinding, Diagnostic, Product } from '@/api/admin/mediaWorkbench'
import MediaReferenceEditor from './MediaReferenceEditor.vue'
import MediaTokensField from './MediaTokensField.vue'
import MediaTechnicalEditor from './MediaTechnicalEditor.vue'
import MediaCostCalculator from './MediaCostCalculator.vue'
import { multiplyDecimalText } from './decimalText'
import { allowedSpecs, buildPricingRules, dimensionsFor, hasDetailedReferencePricingRules, mergeCreationModePricing, matchesSpec, pricingDimensions, splitCreationModePricing, supportsCreationModePricing, type MatrixSpec, type PricingDimension } from './pricingMatrix'
const props = defineProps<{ product: Product; mediaTypes: string[]; disabled: boolean; dirty?: boolean; binding?: AdapterBinding; nativeAdapter?: NativeAdapter; diagnostics?: Diagnostic[]; accountLabel?: string; accountId?: number; adminId?: number }>()
const emit = defineEmits<{ 'update:product': [value: Product]; 'cost-toggle': [open: boolean] }>()
const text = (event: Event) => (event.target as HTMLInputElement).value
const baseRatioPresets = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '9:21', '21:9']
const ratioPresets = computed(() => props.product.media_type === 'image' ? [...baseRatioPresets, '1:4', '4:1', '1:8', '8:1'] : baseRatioPresets)
const durationPresets = ['5', '10', '15']
const resolutionPresets = computed(() => props.product.media_type === 'video' ? ['720p', '1080p', '4K'] : ['1K', '2K', '4K'])
const pricingDimensionDefinitions: { key: PricingDimension; label: string }[] = [
  { key: 'resolution', label: '分辨率' },
  { key: 'aspect_ratio', label: '比例' },
  { key: 'quality', label: '画质' },
  { key: 'duration_seconds', label: '时长' }
]

const stepLabels = ['可售规格', '参考素材', '计费维度', '填写单价', '确认保存']
const stepQuestions = ['这个模型可以出售什么规格？', '客户可以上传什么参考素材？', '什么情况需要卖不同的价格？', '每个价格档位卖多少钱？', '确认商品配置并保存']
const stepDescriptions = computed(() => ['只选择已经确认支持、并准备出售的规格。常用按钮是候选，不代表供应商能力。', '按已确认的接口能力，选择客户是否需要上传素材。', '只选择需要分别收费的规格。没有选中的规格默认同价。', props.product.media_type === 'video' ? '按整条填写人民币单价，须大于 0。空白是未配置。' : '按张填写人民币单价，须大于 0。空白是未配置。', '检查规格、素材要求和售价。保存为草稿后，由后台核验。'])
const calculator = ref<InstanceType<typeof MediaCostCalculator>>()
const wizardStep = ref(1)
const stepHeading = ref<HTMLElement>()
const wizardElement = ref<HTMLElement>()
const referenceEditor = ref<InstanceType<typeof MediaReferenceEditor>>()
async function goToStep(step: number) { wizardStep.value = step; await nextTick(); stepHeading.value?.focus({ preventScroll: true }); wizardElement.value?.scrollIntoView?.({ block: 'start' }) }
function showField(path: string, code?: string) {
  // Some Core capability diagnostics cover a whole section, not an exact field.
  if (path.endsWith('capabilities') && (code === 'VIDEO_REFERENCES_UNSUPPORTED' || code === 'INVALID_REFERENCE_LIMIT' && referenceEditor.value?.error)) path += '.references'
  wizardStep.value = path.includes('pricing_rules') ? 4 : path.includes('references') ? 2 : path.includes('display_name') ? 5 : 1
  return path
}
defineExpose({ showField })
const adapterDiagnostics = computed(() => (props.diagnostics ?? []).filter(d => d.class === 'NEEDS_DEVELOPMENT' && (!d.scope || d.scope === 'account' || d.scope === props.product.product_id)))
const adapterStatus = computed(() => {
  if (adapterDiagnostics.value.length) return { title: '当前工作台适配尚未接通', description: '上次服务端校验发现以下适配缺口。请交由技术维护者处理；填写协议名称不能使未实现的接口获得支持。' }
  if (props.nativeAdapter) return { title: '已接入 Sub2API 原生媒体执行', description: '调用合同、认证和模型映射由现有账号提供，无需选择协议。请配置准备出售的规格和售价；保存时由服务端校验，接入状态不代表供应商已实测。' }
  if (!props.binding || props.binding.kind.startsWith('unbound')) return { title: '适配器能力待确认', description: '可以整理商品草稿，接口是否可用由后台校验；未确认前不能发布。' }
  return { title: '接口配置已记录，可继续整理商品', description: '保存草稿后请查看后台校验结果；这不代表供应商已实测。技术维护入口位于向导外。' }
})
function configuredValues(key: PricingDimension): (string | number)[] {
  const c = props.product.capabilities
  return key === 'resolution' ? c.resolutions : key === 'aspect_ratio' ? c.aspect_ratios : key === 'quality' ? c.qualities : c.durations_seconds
}
const availablePricingDimensions = computed(() => pricingDimensionDefinitions.filter(({ key }) => (key !== 'duration_seconds' || props.product.media_type === 'video') && configuredValues(key).length))
const hiddenPricingDimensions = computed(() => activePricingDimensions.value.filter(key => !availablePricingDimensions.value.some(item => item.key === key)))
const expectedPriceCount = computed(() => {
  const specs = allowedSpecs(props.product.capabilities)
  return specs ? buildPricingRules(props.product, activePricingDimensions.value, specs).length : undefined
})

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
const creationModePricingVisible = computed(() => supportsCreationModePricing(props.product))
const creationModePricingLocked = computed(() => creationModePricingVisible.value && hasDetailedReferencePricingRules(props.product))
const creationModePricing = computed(() => creationModePricingVisible.value && props.product.pricing_rules.some(rule => rule.match.references))
function losesPrices(previous: Product, nextRules: Product['pricing_rules'], specs: MatrixSpec[]): boolean {
  const previousSpecs = sellableSpecs(previous)
  if (!previousSpecs) return previous.pricing_rules.some(rule => rule.sale_price != null)
  const nextSpecs = new Set(specs.map(spec => JSON.stringify(spec)))
  if (previous.pricing_rules.some(rule => rule.sale_price &&
    !previousSpecs.some(spec => matchesSpec(rule.match, spec)) &&
    !nextRules.some(next => JSON.stringify(next) === JSON.stringify(rule)))) return true
  // Check every formerly priced combination, not merely one surviving value per rule.
  return previousSpecs.some(spec => previous.pricing_rules.some(rule => rule.sale_price && matchesSpec(rule.match, spec) && (
    !nextSpecs.has(JSON.stringify(spec)) ||
    !nextRules.some(next => matchesSpec(next.match, spec) && JSON.stringify(next.sale_price) === JSON.stringify(rule.sale_price))
  )))
}
function editPricing(change: (value: Product) => void, dimensions = activePricingDimensions.value): boolean {
  if (props.disabled) return false
  const next: Product = JSON.parse(JSON.stringify(props.product))
  change(next)
  const specs = sellableSpecs(next)
  if (specs) {
    const rules = buildPricingRules(next, dimensions, specs)
    if (losesPrices(props.product, rules, specs) && typeof window !== 'undefined' && !window.confirm('此修改会移除已有价格覆盖的规格，或合并不同售价。仍然一致的价格会保留，冲突价格会变为“待填写”。确认修改当前草稿？')) return false
    next.pricing_rules = rules
  }
  emit('update:product', next)
  return true
}
function togglePricingDimension(key: PricingDimension, event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  const current = activePricingDimensions.value
  if (!availablePricingDimensions.value.some(item => item.key === key)) return
  if (checked) {
    if (!editPricing(() => {}, [...current, key])) (event.target as HTMLInputElement).checked = false
    return
  }
  if (!editPricing(() => {}, current.filter(item => item !== key))) (event.target as HTMLInputElement).checked = true
}
function toggleCreationModePricing(event: Event) {
  if (!creationModePricingVisible.value || creationModePricingLocked.value) return
  const checked = (event.target as HTMLInputElement).checked
  const specs = sellableSpecs(props.product)
  if (!specs) return
  if (checked) {
    edit(next => { next.pricing_rules = splitCreationModePricing(next, activePricingDimensions.value, specs) })
    return
  }
  const merged = mergeCreationModePricing(props.product)
  if (!merged) return
  edit(next => { next.pricing_rules = merged })
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
  editPricing(change)
}
function updateTechnical(value: Product) {
  if (JSON.stringify(value.capabilities) !== JSON.stringify(props.product.capabilities)) editPricing(next => Object.assign(next, value))
  else emit('update:product', value)
}
const referenceSummary = computed(() => {
  const refs = props.product.capabilities.references
  if (refs.total_max === 0) return '不允许上传素材（合计上限为 0，保留原语义）。'
  return (['image', 'video', 'audio'] as const).filter(key => refs[key].max > 0).map(key => `${({ image: '图片', video: '视频', audio: '音频' })[key]}：${refs[key].min > 0 ? `必填 ${refs[key].min}～` : '可选，最多 '}${Math.min(refs[key].max, refs.total_max)} 份`).join('；') + `。合计最多 ${refs.total_max} 份。`
})
const pricingPreview = computed(() => {
  const selected = previewDimensions.value.reduce<Record<string, string>>((result, { key }) => { result[key] = previewValue(key); return result }, {})
  const specs = sellableSpecs(props.product)
  const quantity = props.product.media_type === 'image' ? previewQuantity.value : 1
  if (!specs || !specs.some(spec => spec.count === quantity && pricingDimensions.every(key => !selected[key] || String(spec[key]) === selected[key]))) return undefined
  const matching = priceRows.value.filter(item => activePricingDimensions.value.every(key => { const values = matchValues(item.match, key); return !values.length || values.includes(selected[key] ?? '') }))
  const rule = matching.length === 1 ? matching[0] : undefined
  if (!rule?.sale_price || priceError(rule) || rule.sale_price.currency !== 'CNY' || rule.sale_price.billing_mode !== 'per_request' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(rule.sale_price.amount)) return undefined
  if (!Number.isInteger(quantity) || quantity < props.product.capabilities.count.min || quantity > props.product.capabilities.count.max) return undefined
  return { unit: rule.sale_price.amount, quantity, total: multiplyDecimalText(rule.sale_price.amount, quantity) }
})
function edit(change: (value: Product) => void) {
  if (props.disabled) return
  const next: Product = JSON.parse(JSON.stringify(props.product))
  change(next)
  emit('update:product', next)
}
function priceError(rule: Product['pricing_rules'][number]): string {
  if (!rule.sale_price) return ''
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(rule.sale_price.amount)) return '请输入有效金额，最多 8 位小数。'
  return /^0(?:\.0+)?$/.test(rule.sale_price.amount) ? '客户售价须大于 0 CNY；0 元可保留在草稿中，但不能发布或生成。' : ''
}
function setAmount(index: number, event: Event) {
  edit(next => {
    if (!next.pricing_rules?.length) next.pricing_rules = [{ match: {}, sale_price: null }]
    const rule = next.pricing_rules[index]!
    const amount = text(event)
    rule.sale_price = amount === '' ? null : { amount, currency: 'CNY', billing_mode: 'per_request' }
  })
}
</script>
