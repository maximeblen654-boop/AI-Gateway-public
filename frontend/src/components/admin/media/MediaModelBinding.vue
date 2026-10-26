<template>
  <section class="mw-banner mw-model-binding" aria-label="处理原型号不可用" data-test="model-binding">
    <h3>原型号不可用，请更换绑定</h3>
    <p>原型号已不在最近成功同步的目录中。先处理型号绑定，已有规格和售价会保留。</p>
    <label class="mw-field">原型号（必选）
      <select v-model="oldModel" class="input" data-test="binding-old" :disabled="disabled">
        <option value="" disabled>请选择原型号</option>
        <option v-for="group in groups" :key="group.model_id" :value="group.model_id">{{ group.model_id }} · {{ group.products.map(p => p.label).join('、') }}</option>
      </select>
    </label>
    <fieldset data-test="binding-products"><legend>选择本次处理的商品</legend><label v-for="p in selected?.products ?? []" :key="p.id" class="mw-product-toggle"><input v-model="productIds" type="checkbox" :value="p.id" :disabled="disabled" :data-test="`binding-product-${p.id}`" />{{ p.label }}<small v-if="p.current_model && p.current_model !== oldModel">当前草稿型号：{{ p.current_model }}；确认后采用下方的新型号。</small></label></fieldset>
    <label class="mw-field">新型号或处理方式
      <select v-model="replacement" class="input" data-test="binding-new" :disabled="disabled">
        <option value="" disabled>请选择新型号或明确删除</option>
        <optgroup v-if="added.length" label="本次同步新增的型号"><option v-for="id in added" :key="id" :value="id">{{ id }}</option></optgroup>
        <optgroup label="其他可用型号"><option v-for="id in other" :key="id" :value="id">{{ id }}</option></optgroup>
        <option :value="deleteChoice">不替换，删除此商品</option>
      </select>
    </label>
    <p v-if="deleting" role="alert">将删除上面勾选的 {{ selectedProducts.length }} 份当前商品配置和销售入口，保留历史订单、任务与账务。</p>
    <p v-else>更换后会检查原销售配置与新型号是否兼容。未发布的规格、售价改动仍保留为草稿；手动下架的商品仍需重新上架。</p>
    <p v-if="disabled" class="mw-muted">请先保存或放弃当前修改；操作结果未确认时，请先重新读取。</p>
    <p v-if="message" role="alert" data-test="binding-feedback">{{ message }}</p>
    <button type="button" class="btn btn-primary" data-test="binding-confirm" :disabled="disabled || !selectedProducts.length || !replacement" @click="confirm">{{ deleting ? `确认删除 ${selectedProducts.length} 份商品` : '确认更换绑定' }}</button>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ModelBindingInput } from '@/api/admin/mediaWorkbench'
export interface MissingModelGroup { model_id: string; products: { id: string; label: string; current_model?: string }[] }
const props = defineProps<{ groups: MissingModelGroup[]; available: string[]; addedModels: string[]; initialModel: string; initialProduct?: string; disabled: boolean; message?: string }>()
const emit = defineEmits<{ submit: [input: ModelBindingInput] }>()
const oldModel = ref('')
const replacement = ref('')
const productIds = ref<string[]>([])
const selected = computed(() => props.groups.find(g => g.model_id === oldModel.value))
const selectedProducts = computed(() => selected.value?.products.filter(p => productIds.value.includes(p.id)) ?? [])
watch(() => [props.initialModel, props.groups.map(g => `${g.model_id}:${g.products.map(p => p.id).join(',')}`).join('\n')], () => {
  oldModel.value = props.groups.some(g => g.model_id === props.initialModel) ? props.initialModel : props.groups[0]?.model_id ?? ''
  replacement.value = ''
}, { immediate: true })
watch([oldModel, () => props.initialProduct, () => selected.value?.products], () => {
  replacement.value = ''
  productIds.value = selected.value?.products.some(p => p.id === props.initialProduct) ? [props.initialProduct!] : selected.value?.products.length === 1 ? [selected.value.products[0]!.id] : []
}, { immediate: true })
const added = computed(() => [...new Set(props.addedModels)].filter(id => props.available.includes(id)))
const other = computed(() => props.available.filter(id => !added.value.includes(id)))
const deleteChoice = computed(() => { let value = '__delete_product__'; while (props.available.includes(value)) value += '_'; return value })
const deleting = computed(() => replacement.value === deleteChoice.value)
function confirm() {
  if (props.disabled || !selectedProducts.value.length || !replacement.value || (!deleting.value && !props.available.includes(replacement.value))) return
  emit('submit', { action: deleting.value ? 'delete' : 'rebind', old_model_id: oldModel.value,
    ...(deleting.value ? {} : { new_model_id: replacement.value }), product_ids: selectedProducts.value.map(p => p.id) })
}
</script>
