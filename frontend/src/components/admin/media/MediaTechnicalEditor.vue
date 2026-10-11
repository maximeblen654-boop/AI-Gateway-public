<template>
  <fieldset :disabled="disabled" class="mw-product-fields mw-technical-entry">
    <details class="mw-technical" data-test="advanced-technical">
      <summary>高级技术配置 · 接口、画质与执行能力</summary>
      <p class="mw-muted">供维护 Account 接口的管理员使用。依据已确认的接口合同填写，不代表系统已对供应商实测；保存和发布继续接受服务端适配校验。</p>
      <p v-if="binding" class="mw-muted">Account 适配绑定：{{ binding.kind }} · {{ binding.revision }} · {{ binding.task_flow }}。绑定由现有服务端适配器维护。</p>
      <details data-test="quality-options" data-field="capabilities.qualities"><summary>接口独立画质字段（仅在已确认支持时配置）</summary><MediaTokensField label="已确认的实际画质值" placeholder="留空表示不发送 quality 字段" :model-value="product.capabilities.qualities" @update:model-value="edit(next => { next.capabilities.qualities = $event.map(String) })" /><p class="mw-muted">分辨率不等于画质。不提供通用画质预设，也不会按模型名称推断。</p></details>
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
      <details data-field="capabilities.combination_rules"><summary>组合限制（可选）</summary>
        <p class="mw-muted">只录入已确认不可用的组合；没有规则时保持为空。</p>
        <div v-for="(rule, index) in product.capabilities.combination_rules" :key="index" class="mw-rule">
          <p>禁止组合 {{ index + 1 }}</p><MediaMatchEditor :model-value="rule.deny" @update:model-value="edit(next => { next.capabilities.combination_rules[index]!.deny = $event })" />
          <button type="button" class="btn btn-secondary" @click="edit(next => { next.capabilities.combination_rules.splice(index, 1) })">移除此限制</button>
        </div>
        <button type="button" class="btn btn-secondary" @click="edit(next => { next.capabilities.combination_rules.push({ deny: {} }) })">添加禁止组合</button>
      </details>
      <details><summary>产品标识与用途</summary>
        <label class="mw-field">产品 ID<input :value="product.product_id" class="input" data-field="product_id" @change="setIdentity" /></label>
        <label class="mw-field">本站模型 ID<input :value="product.site_model" class="input" data-field="site_model" @input="edit(next => { next.site_model = text($event) })" /></label>
        <label class="mw-field">业务用途<select :value="product.media_type" class="input" data-field="media_type" @change="setMediaType"><option v-for="type in mediaTypes" :key="type" :value="type">{{ type === 'image' ? '图片' : '视频' }}</option></select></label>
        <label><input :checked="product.enabled" type="checkbox" @change="edit(next => { next.enabled = ($event.target as HTMLInputElement).checked })" /> 商品启用（发布后生效，不改变 Account 销售开关）</label>
      </details>
    </details>
  </fieldset>
</template>
<script setup lang="ts">
import { nextTick } from 'vue'
import type { AdapterBinding, Product } from '@/api/admin/mediaWorkbench'
import MediaTokensField from './MediaTokensField.vue'
import MediaMatchEditor from './MediaMatchEditor.vue'
const props = defineProps<{ product: Product; mediaTypes: string[]; disabled: boolean; binding?: AdapterBinding }>()
const emit = defineEmits<{ 'update:product': [value: Product]; identity: [value: string] }>()
const text = (event: Event) => (event.target as HTMLInputElement).value
const numeric = (event: Event) => Number(text(event))
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
function setIdentity(event: Event) { const id = text(event); edit(next => { next.product_id = id }); emit('identity', id) }
</script>
