<template>
    <details class="mw-adapter-status" data-test="adapter-status">
      <summary>{{ adapterStatus.title }}</summary><p class="mw-muted">{{ adapterStatus.description }}</p>
      <p v-for="diagnostic in adapterDiagnostics" :key="diagnostic.code + diagnostic.path" class="mw-muted">{{ mediaDiagnosticGuidance(diagnostic).message }} {{ mediaDiagnosticGuidance(diagnostic).action }}</p>
    </details>
  <fieldset ref="wizardElement" :disabled="disabled" class="mw-product-fields mw-wizard" :style="{ '--mw-step-index': wizardStep - 1 }">
    <nav class="mw-wizard-steps" aria-label="当前模型配置步骤">
      <button v-for="(label, index) in stepLabels" :key="label" type="button" :data-test="`wizard-step-${index + 1}`" :aria-current="wizardStep === index + 1 ? 'step' : undefined" @pointerdown="wizardStep === 2 && $event.preventDefault()" @click="goToStep(index + 1)"><span>{{ index + 1 }}</span><strong>{{ label }}</strong></button>
    </nav>
    <div ref="stepHeading" class="mw-wizard-heading" tabindex="-1">
      <h3>{{ stepQuestions[wizardStep - 1] }}</h3>
      <p class="mw-muted">{{ stepDescriptions[wizardStep - 1] }}</p>
      <span class="mw-draft-state">{{ dirty ? '有未保存修改' : '正在查看草稿' }} · 停止输入或切换步骤会自动保存草稿，不会正式发布</span>
    </div>
    <div v-show="wizardStep === 1" data-test="wizard-page-1">
    <section data-field="capabilities">

      <div class="mw-field-grid">
        <MediaTokensField label="分辨率" :presets="resolutionPresets" placeholder="例如：1K, 2K, 2048x2048" :model-value="product.capabilities.resolutions" @update:model-value="setCapability('resolution', $event)" />
        <MediaTokensField label="比例" aspect-ratio :presets="ratioPresets" placeholder="例如：1:1, 16:9" :model-value="product.capabilities.aspect_ratios" @update:model-value="setCapability('aspect_ratio', $event)" />
        <MediaTokensField v-if="product.media_type === 'video'" label="时长（秒）" numeric duration-range placeholder="例如：5, 10, 15" :model-value="product.capabilities.durations_seconds" @update:model-value="setCapability('duration_seconds', $event)" />
        <div v-if="supportsNativeOutputFormat || product.capabilities.output_formats?.length" class="mw-field" data-test="native-output-formats">
          <span>生成时的原生图片格式</span>
          <div class="mw-token-presets" role="group" aria-label="已确认的上游输出格式">
            <button v-for="format in ['png', 'jpeg', 'webp']" :key="format" type="button" class="mw-token-chip" :class="{ 'mw-token-chip-selected': product.capabilities.output_formats?.includes(format) }" :aria-pressed="!!product.capabilities.output_formats?.includes(format)" :disabled="disabled || !supportsNativeOutputFormat" :data-test="`native-output-${format}`" @click="toggleOutputFormat(format)">{{ format === 'jpeg' ? 'JPEG' : format.toUpperCase() }}</button>
          </div>
          <small>仅勾选已确认当前供应商线路支持的格式。不选则沿用上游默认格式；保存、校验并发布后才对客户生效。与生成后的本地格式转换不同，不改变现有价格。</small>
          <small v-if="!supportsNativeOutputFormat">当前适配器不支持配置原生输出格式；保留原配置供核查，服务端会再次校验。</small>
        </div>
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
      <MediaVideoSaleEditor ref="videoSaleEditor" v-if="product.media_type === 'video'" :active="wizardStep === 4" :account-id="accountId" :admin-id="adminId" :product="product" :pricing-dimensions="activePricingDimensions" :disabled="disabled" :pending-video-sales="pendingVideoSales" @pending-video-sales="emit('pending-video-sales', $event)" @update:product="emit('update:product', $event)" />
      <MediaPricingEditor v-else :product="product" :labels="priceRows.map(pricingRuleLabel)" :disabled="disabled" @update:product="emit('update:product', $event)" />
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
          <label v-if="creationModePricing" class="mw-field">创作方式<select class="input" v-model="previewCreationMode" data-test="preview-creation-mode"><option value="text">文生图</option><option value="edit">图生图</option></select></label>
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
    <div class="mw-wizard-footer"><button v-if="wizardStep > 1" type="button" class="btn btn-secondary" data-test="wizard-back" @pointerdown="wizardStep === 2 && $event.preventDefault()" @click="goToStep(wizardStep - 1)">← 上一步</button><span v-else class="mw-muted">仅编辑当前草稿</span><button v-if="wizardStep < 5" type="button" class="btn btn-primary" data-test="wizard-next" @pointerdown="wizardStep === 2 && $event.preventDefault()" @click="goToStep(wizardStep + 1)">下一步：{{ stepLabels[wizardStep] }} →</button><span v-else class="mw-muted">保存不自动发布或启售。</span></div>
  </fieldset>
  <MediaTechnicalEditor :product="product" :media-types="mediaTypes" :disabled="disabled" :binding="binding" :native-adapter="nativeAdapter" @update:product="updateTechnical" />
</template>
<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { NativeAdapter, AdapterBinding, Diagnostic, Product } from '@/api/admin/mediaWorkbench'
import { mediaDiagnosticGuidance } from '@/utils/mediaAdminPresentation'
import MediaReferenceEditor from './MediaReferenceEditor.vue'
import MediaTokensField from './MediaTokensField.vue'
import MediaTechnicalEditor from './MediaTechnicalEditor.vue'
import MediaPricingEditor from './MediaPricingEditor.vue'
import MediaVideoSaleEditor from './MediaVideoSaleEditor.vue'
import { videoGroups, type VideoSaleInput } from './videoSaleGroups'
import { multiplyDecimalText } from './decimalText'
import { mediaSpecLabel } from './mediaSpecLabel'
import { allowedSpecs, buildPricingRules, creationModeForRule, dimensionsFor, hasDetailedReferencePricingRules, mergeCreationModePricing, matchesSpec, pricingDimensions, splitCreationModePricing, supportsCreationModePricing, type MatrixSpec, type PricingDimension } from './pricingMatrix'
const props = defineProps<{ product: Product; mediaTypes: string[]; disabled: boolean; dirty?: boolean; binding?: AdapterBinding; nativeAdapter?: NativeAdapter; diagnostics?: Diagnostic[]; accountLabel?: string; accountId?: number; adminId?: number; pendingVideoSales?: VideoSaleInput[] }>()
const emit = defineEmits<{ 'update:product': [value: Product]; 'pending-video-sales': [inputs: VideoSaleInput[]] }>()
const text = (event: Event) => (event.target as HTMLInputElement).value
const baseRatioPresets = ['1:1', '4:5', '5:4', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9', '9:21', '21:9']
const ratioPresets = computed(() => props.product.media_type === 'image' ? [...baseRatioPresets, '1:4', '4:1', '1:8', '8:1'] : baseRatioPresets)
const supportsNativeOutputFormat = computed(() => props.product.media_type === 'image' && (props.nativeAdapter?.kind ?? props.binding?.kind) === 'openai_images')
function toggleOutputFormat(format: string) {
  if (props.disabled || !supportsNativeOutputFormat.value) return
  edit(next => {
    const formats = next.capabilities.output_formats ?? []
    next.capabilities.output_formats = formats.includes(format) ? formats.filter(value => value !== format) : [...formats, format]
  })
}
const resolutionPresets = computed(() => props.product.media_type === 'video' ? ['720p', '1080p', '4K'] : ['1K', '2K', '4K'])
const pricingDimensionDefinitions: { key: PricingDimension; label: string }[] = [
  { key: 'resolution', label: '分辨率' },
  { key: 'aspect_ratio', label: '比例' },
  { key: 'quality', label: '画质' },
  { key: 'duration_seconds', label: '时长' }
]

const stepLabels = computed(() => ['可售规格', '参考素材', '计费维度', '客户售价', '确认保存'])
const stepQuestions = computed(() => ['这个模型可以出售什么规格？', '客户可以上传什么参考素材？', '什么情况需要卖不同的价格？', props.product.media_type === 'video' ? '每条视频的客户售价是多少？' : '每张图片的客户售价是多少？', '确认商品配置并保存'])
const stepDescriptions = computed(() => ['只选择已经确认支持、并准备出售的规格。常用按钮是候选，不代表供应商能力。', '按已确认的接口能力，选择客户是否需要上传素材。', '只选择需要分别收费的规格。没有选中的规格默认同价。', props.product.media_type === 'video' ? '按分辨率选择时长售价。售价为整条人民币金额，须大于 0；独立计算器仅供试算。' : '按张填写人民币客户售价，须大于 0。空白是未配置；独立计算器仅供试算。', '检查规格、素材要求和售价。保存为草稿后，由后台核验。'])
const wizardStep = ref(1)
const stepHeading = ref<HTMLElement>()
const wizardElement = ref<HTMLElement>()
const referenceEditor = ref<InstanceType<typeof MediaReferenceEditor>>()
async function goToStep(step: number) {
  // Commit before moving focus: blur can otherwise move the clicked button
  // when the parent's recovery/autosave status changes the page height.
  if (wizardStep.value === 2 && step !== 2 && referenceEditor.value) {
    const committed = referenceEditor.value.commitPending()
    if (committed !== true && !await committed) return
  }
  if (wizardStep.value === 4 && step !== 4 && videoSaleEditor.value && !await videoSaleEditor.value.commitPending()) return
  wizardStep.value = step
  await nextTick()
  stepHeading.value?.focus({ preventScroll: true })
  wizardElement.value?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
}
function showField(path: string, code?: string) {
  // Model identity is displayed outside the specification wizard.
  if (path === 'upstream_model' || path.endsWith('.upstream_model')) return path
  // Some Core capability diagnostics cover a whole section, not an exact field.
  if (path.endsWith('capabilities') && (code === 'VIDEO_REFERENCES_UNSUPPORTED' || code === 'INVALID_REFERENCE_LIMIT' && referenceEditor.value?.error)) path += '.references'
  wizardStep.value = path.includes('pricing_rules') ? 4 : path.includes('references') ? 2 : path.includes('display_name') ? 5 : 1
  return path
}
const videoSaleEditor = ref<InstanceType<typeof MediaVideoSaleEditor>>()
function invalidateSaleUndo() { videoSaleEditor.value?.invalidateUndo() }
async function commitPending(): Promise<boolean> {
  if (videoSaleEditor.value && !await videoSaleEditor.value.commitPending()) return false
  return await referenceEditor.value?.commitPending() ?? true
}
defineExpose({ showField, invalidateSaleUndo, commitPending, goToStep })
const adapterDiagnostics = computed(() => (props.diagnostics ?? []).filter(d => d.class === 'NEEDS_DEVELOPMENT' && (!d.scope || d.scope === 'account' || d.scope === props.product.product_id)))
const adapterStatus = computed(() => {
  if (adapterDiagnostics.value.length) return { title: '连接配置需要处理', description: '后台检查发现以下问题。请按提示处理后重新保存并检查；目前不能据此开启销售。' }
  if (props.nativeAdapter) return { title: '已识别账号连接方式', description: '连接方式由账号设置自动确定，无需手工选择。请配置准备出售的规格和售价，保存后执行检查；识别成功不代表已完成真实生成。' }
  if (!props.binding || props.binding.kind.startsWith('unbound')) return { title: '连接能力待确认', description: '可以整理商品草稿，接口是否可用由后台校验；未确认前不能发布。' }
  return { title: '接口配置已记录，可继续整理商品', description: '保存草稿后请查看后台校验结果；这不代表供应商已实测。技术维护入口位于向导外。' }
})
function configuredValues(key: PricingDimension): (string | number)[] {
  const c = props.product.capabilities
  return key === 'resolution' ? c.resolutions : key === 'aspect_ratio' ? c.aspect_ratios : key === 'quality' ? c.qualities : c.durations_seconds
}
const availablePricingDimensions = computed(() => pricingDimensionDefinitions.filter(({ key }) => (key !== 'duration_seconds' || props.product.media_type === 'video') && configuredValues(key).length))
const hiddenPricingDimensions = computed(() => activePricingDimensions.value.filter(key => !availablePricingDimensions.value.some(item => item.key === key)))
// Track the complete reactive input once; the bounded pure calculations below
// should not pay a reactive Proxy traversal for every spec/rule comparison.
const calculationProduct = computed<Product>(() => JSON.parse(JSON.stringify(props.product)))
const expectedPriceCount = computed(() => {
  if (wizardStep.value !== 3) return undefined
  const product = calculationProduct.value
  if (product.media_type === 'video') {
    const splitDuration = activePricingDimensions.value.includes('duration_seconds')
    const splitResolution = activePricingDimensions.value.includes('resolution')
    const resolutions = splitResolution ? product.capabilities.resolutions : ['']
    const groups = resolutions.map(resolution => videoGroups(product, resolution, { splitDuration }))
    return groups.some(value => !value) ? undefined : groups.reduce((total, value) => total + value!.reduce((count, group) => count + group.rows.length, 0), 0)
  }
  const specs = allowedSpecs(product.capabilities)
  if (!specs) return undefined
  return creationModePricing.value
    ? splitCreationModePricing(product, activePricingDimensions.value, specs).length
    : buildPricingRules(product, activePricingDimensions.value, specs).length
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
  const nextRuleKeys = new Set(nextRules.map(rule => JSON.stringify(rule)))
  if (previous.pricing_rules.some(rule => rule.sale_price &&
    !previousSpecs.some(spec => matchesSpec(rule.match, spec)) &&
    !nextRuleKeys.has(JSON.stringify(rule)))) return true
  const previousPrices = previous.pricing_rules.filter(rule => rule.sale_price).map(rule => ({ match: rule.match, price: JSON.stringify(rule.sale_price) }))
  const nextPrices = nextRules.map(rule => ({ match: rule.match, price: JSON.stringify(rule.sale_price) }))
  // Check every formerly priced combination, not merely one surviving value per rule.
  return previousSpecs.some(spec => {
    const prices = previousPrices.filter(rule => matchesSpec(rule.match, spec))
    if (!prices.length) return false
    if (!nextSpecs.has(JSON.stringify(spec))) return true
    const preserved = new Set(nextPrices.filter(rule => matchesSpec(rule.match, spec)).map(rule => rule.price))
    return prices.some(rule => !preserved.has(rule.price))
  })
}
function editPricing(change: (value: Product) => void, dimensions = activePricingDimensions.value): boolean {
  if (props.disabled) return false
  const next: Product = JSON.parse(JSON.stringify(props.product))
  change(next)
  const specs = sellableSpecs(next)
  if (specs) {
    const rules = supportsCreationModePricing(next) && creationModePricing.value && !creationModePricingLocked.value
      ? splitCreationModePricing(next, dimensions, specs)
      : buildPricingRules(next, dimensions, specs)
    if (losesPrices(calculationProduct.value, rules, specs) && typeof window !== 'undefined' && !window.confirm('此修改会移除已有价格覆盖的规格，或合并不同售价。仍然一致的价格会保留，冲突价格会变为“待填写”。确认修改当前草稿？')) return false
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
  if (merged.some(rule => rule.sale_price == null) && typeof window !== 'undefined' && !window.confirm('关闭分别定价会合并不同售价，冲突价格将变为“待填写”。确认继续？')) {
    (event.target as HTMLInputElement).checked = true
    return
  }
  edit(next => { next.pricing_rules = merged })
}
function pricingRuleLabel(rule: Product['pricing_rules'][number]): string {
  const mode = creationModeForRule(rule, props.product)
  const modeLabel = mode === 'text' ? '文生图' : mode === 'edit' ? '图生图' : ''
  const other = { ...rule.match }
  delete other.references
  const label = mediaSpecLabel(modeLabel ? other : rule.match)
  return modeLabel ? [modeLabel, ...(Object.keys(other).length ? [label] : [])].join(' · ') : label
}
const priceRows = computed<Product['pricing_rules']>(() => props.product.pricing_rules?.length ? props.product.pricing_rules : [{ match: {}, sale_price: null }])
const unitLabel = computed(() => props.product.media_type === 'video' ? '条' : '张')
const previewSelection = reactive<Partial<Record<PricingDimension, string>>>({})
const previewQuantity = ref(1)
const previewCreationMode = ref<'text' | 'edit'>('text')
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
  if (!supportsCreationModePricing(product)) previewCreationMode.value = 'text'
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
  if (wizardStep.value !== 5) return undefined
  const selected = previewDimensions.value.reduce<Record<string, string>>((result, { key }) => { result[key] = previewValue(key); return result }, {})
  const specs = sellableSpecs(calculationProduct.value)
  const quantity = props.product.media_type === 'image' ? previewQuantity.value : 1
  if (!specs || !specs.some(spec => spec.count === quantity && pricingDimensions.every(key => !selected[key] || String(spec[key]) === selected[key]))) return undefined
  const matching = priceRows.value.filter(item => {
    if (!activePricingDimensions.value.every(key => { const values = matchValues(item.match, key); return !values.length || values.includes(selected[key] ?? '') })) return false
    const mode = creationModeForRule(item, props.product)
    if (!mode) return true
    return mode === previewCreationMode.value
  })
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
</script>
