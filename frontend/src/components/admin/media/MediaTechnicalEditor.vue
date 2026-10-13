<template>
  <fieldset :disabled="disabled" class="mw-product-fields mw-technical-entry">
    <details class="mw-technical" data-test="advanced-technical">
      <summary>高级技术配置 · 接口、画质与执行能力</summary>
      <p class="mw-muted">供维护 Account 接口的管理员使用。依据已确认的接口合同填写，不代表系统已对供应商实测；保存和发布继续接受服务端适配校验。</p>
      <p v-if="binding" class="mw-muted">当前 Account 已接入媒体调用合同；绑定由 Sub2API 服务端维护，商品配置无需选择协议或适配器。</p>
      <details v-if="nativeAdapter?.parameters.quality?.mode !== 'unsupported' || product.capabilities.qualities.length" data-test="quality-options" data-field="capabilities.qualities"><summary>接口独立画质字段（仅在已确认支持时配置）</summary><MediaTokensField label="已确认的实际画质值" placeholder="留空表示不发送 quality 字段" :model-value="product.capabilities.qualities" @update:model-value="edit(next => { next.capabilities.qualities = $event.map(String) })" /><p class="mw-muted">分辨率不等于画质。不提供通用画质预设，也不会按模型名称推断。</p></details>
    <p class="mw-muted" data-test="native-contract">调用合同、认证与模型映射继承 Sub2API Account；商品不需要选择协议。已保存的内部技术字段保留兼容，服务端负责校验。</p>
    <details v-if="product.media_type === 'image'" data-test="image-execution-advanced">
      <summary>高级技术配置：图片接口单请求能力</summary>
      <p class="mw-muted">由管理员依据已确认的 Account、模型和接口能力配置；这不是系统实测结果。未确认多图时保留单图，无需为购买多张修改接口能力。</p>
    <section data-field="adapter_config.execution">
      <h3>文生图单请求产出能力</h3>
      <p class="mw-muted">只填写已经核实的 Account、模型和接口能力；未知或没有多图证据时保持单图，客户 1～10 张会按批次执行。客户购买数量不在这里配置。</p>
      <div class="mw-field-grid">
        <label class="mw-field">执行方式<select :value="product.adapter_config.execution?.mode ?? 'single'" class="input" data-test="image-execution-mode" @change="changeExecutionMode('execution', $event)">
          <option value="single">单图接口（未知能力也用此项）</option><option v-if="nativeAdapter?.parameters.count?.mode !== 'fixed_by_model'" value="native_multi">已核实原生多图（使用 n）</option>
        </select></label>
        <label class="mw-field">单请求最多输出图片数<input :value="product.adapter_config.execution?.max_output_images ?? 1" class="input" data-test="image-execution-max" data-field="adapter_config.execution.max_output_images" type="number" :min="product.adapter_config.execution?.mode === 'native_multi' ? 2 : 1" max="10" step="1" :disabled="product.adapter_config.execution?.mode !== 'native_multi'" :aria-invalid="!!imageExecutionError" :aria-describedby="imageExecutionError ? 'image-execution-hint image-execution-error' : 'image-execution-hint'" @input="edit(next => { const mode = next.adapter_config.execution?.mode ?? 'single'; next.adapter_config.execution = { ...(next.adapter_config.execution ?? {}), mode, max_output_images: mode === 'native_multi' ? numeric($event) : 1 } })" /><small id="image-execution-hint">这是上游单请求上限，不是客户一次购买数量。</small><p v-if="imageExecutionError" id="image-execution-error" class="mw-field-error" data-test="image-execution-error" role="alert">{{ imageExecutionError }}</p></label>
      </div>
    </section>
    <section v-if="product.capabilities.references.image.max > 0" data-field="adapter_config.edit_execution">
      <h3>参考图编辑单请求产出能力</h3>
      <p class="mw-muted">这是参考图编辑接口的独立管理员配置；未填写时按单图执行，不会继承文生图多图能力。这里只记录已确认能力，不代表系统已对供应商实测。</p>
      <div class="mw-field-grid">
        <label class="mw-field">编辑执行方式<select :value="product.adapter_config.edit_execution?.mode ?? 'single'" class="input" data-test="image-edit-execution-mode" @change="changeExecutionMode('edit_execution', $event)">
          <option value="single">单图接口（默认）</option><option v-if="nativeAdapter?.parameters.count?.mode !== 'fixed_by_model'" value="native_multi">已核实原生多图（使用 n）</option>
        </select></label>
        <label class="mw-field">编辑单请求最多输出图片数<input :value="product.adapter_config.edit_execution?.max_output_images ?? 1" class="input" data-test="image-edit-execution-max" data-field="adapter_config.edit_execution.max_output_images" type="number" :min="product.adapter_config.edit_execution?.mode === 'native_multi' ? 2 : 1" max="10" step="1" :disabled="product.adapter_config.edit_execution?.mode !== 'native_multi'" :aria-invalid="!!editExecutionError" :aria-describedby="editExecutionError ? 'image-edit-execution-hint image-edit-execution-error' : 'image-edit-execution-hint'" @input="edit(next => { const mode = next.adapter_config.edit_execution?.mode ?? 'single'; next.adapter_config.edit_execution = { ...(next.adapter_config.edit_execution ?? {}), mode, max_output_images: mode === 'native_multi' ? numeric($event) : 1 } })" /><small id="image-edit-execution-hint">客户购买数量仍由商品规格控制；没有编辑能力配置时每次只提交一张。</small><p v-if="editExecutionError" id="image-edit-execution-error" class="mw-field-error" data-test="image-edit-execution-error" role="alert">{{ editExecutionError }}</p></label>
      </div>
    </section>
    </details>
    <section v-if="product.media_type === 'image' && (nativeAdapter?.parameters.resolution?.mode !== 'passthrough' || product.adapter_config.size_mappings.length)" data-field="adapter_config.size_mappings">
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
      <details data-field="capabilities.combination_rules"><summary>组合限制（可选）</summary>
        <p class="mw-muted">只录入已确认不可用的组合；没有规则时保持为空。</p>
        <div v-for="(rule, index) in product.capabilities.combination_rules" :key="index" class="mw-rule">
          <p>禁止组合 {{ index + 1 }}</p><MediaMatchEditor :model-value="rule.deny" @update:model-value="edit(next => { next.capabilities.combination_rules[index]!.deny = $event })" />
          <button type="button" class="btn btn-secondary" @click="edit(next => { next.capabilities.combination_rules.splice(index, 1) })">移除此限制</button>
        </div>
        <button type="button" class="btn btn-secondary" @click="edit(next => { next.capabilities.combination_rules.push({ deny: {} }) })">添加禁止组合</button>
      </details>
      <details><summary>产品标识与用途</summary>
        <p class="mw-muted">商品身份由系统生成；模型选择和 Account 的 canonical model mapping 统一来自当前 Account，不在商品层重复填写。</p>
        <p class="mw-muted" data-field="site_model">当前上游模型：{{ product.upstream_model }}。模型身份由 Account 的 canonical mapping 管理。</p>
        <label class="mw-field">业务用途<select :value="product.media_type" class="input" data-field="media_type" @change="setMediaType"><option v-for="type in mediaTypes" :key="type" :value="type">{{ type === 'image' ? '图片' : '视频' }}</option></select></label>

      </details>
    </details>
  </fieldset>
</template>
<script setup lang="ts">
import { computed, nextTick } from 'vue'
import type { AdapterBinding, ImageExecutionConfig, NativeAdapter, Product } from '@/api/admin/mediaWorkbench'
import MediaTokensField from './MediaTokensField.vue'
import MediaMatchEditor from './MediaMatchEditor.vue'
const props = defineProps<{ product: Product; mediaTypes: string[]; disabled: boolean; binding?: AdapterBinding; nativeAdapter?: NativeAdapter }>()
const emit = defineEmits<{ 'update:product': [value: Product] }>()
const text = (event: Event) => (event.target as HTMLInputElement).value
const numeric = (event: Event) => Number(text(event))
function executionError(config: ImageExecutionConfig | undefined, label: string): string {
  const mode = config?.mode ?? 'single'
  const max = config?.max_output_images ?? 1
  if (mode === 'single' && max !== 1) return `${label}选择了单图接口，单请求上限必须是 1。`
  if (mode === 'native_multi' && (!Number.isInteger(max) || max < 2 || max > 10)) return `${label}选择了原生多图，请填写已确认的 2～10 张上限；若每次一张，请将此接口切换为单图。不会自动提高上限。`
  if (mode === 'provider_async') return `${label}使用原生异步批量，需要独立队列和结算合同；当前工作台不会提交此配置。`
  if (mode !== 'single' && mode !== 'native_multi') return `${label}的执行方式不是当前工作台支持的模式。`
  if (config?.provider) return `${label}不能在普通单图或原生多图模式中填写 provider。`
  return ''
}
const imageExecutionError = computed(() => executionError(props.product.adapter_config.execution, '文生图'))
const editExecutionError = computed(() => executionError(props.product.adapter_config.edit_execution, '参考图编辑'))
function changeExecutionMode(field: 'execution' | 'edit_execution', event: Event) {
  const mode = text(event) as 'single' | 'native_multi'
  edit(next => {
    const previous = next.adapter_config[field]
    next.adapter_config[field] = { mode, max_output_images: mode === 'single' ? 1 : previous?.max_output_images ?? 1 }
  })
}
function edit(change: (next: Product) => void) {
  if (props.disabled) return
  const next: Product = JSON.parse(JSON.stringify(props.product))
  change(next)
  emit('update:product', next)
}
async function setMediaType(event: Event) {
  edit(next => { next.media_type = text(event); next.capabilities.count = { min: 1, max: next.media_type === 'video' ? 1 : 10 } })
  await nextTick()
  ;(event.target as HTMLSelectElement).value = props.product.media_type
}
</script>
