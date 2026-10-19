<template>
  <section class="mw-video-sales" data-test="video-sale-editor">
    <div class="mw-pricing-dimensions" role="group" aria-label="售价分辨率">
      <button v-for="resolution in product.capabilities.resolutions" :key="resolution" type="button" class="btn" :class="selectedResolution === resolution ? 'btn-primary' : 'btn-secondary'" :aria-pressed="selectedResolution === resolution" :data-test="`sale-resolution-${resolution}`" @click="selectedResolution = resolution">{{ resolution }} <small>{{ progress(resolution) }}</small></button>
    </div>
    <p v-if="!groups" class="mw-banner">当前规格超出安全组合预算或尚未完成配置，请返回核对规格；已有售价保留。</p>
    <template v-else>
      <label v-if="groups.length > 1" class="mw-field">售价子分组<select v-model="selectedGroup" class="input" data-test="sale-subgroup"><option v-for="group in groups" :key="group.key" :value="group.key">{{ groupLabel(group.match) }}</option></select></label>
      <p class="mw-muted">{{ current ? groupLabel(current.match) : '请先配置合法分辨率与时长。' }} · 以下为整条视频售价，不再乘秒数。</p>
      <div v-if="current" class="mw-video-price-list">
        <label v-for="row in current.rows" :key="`${selectedResolution}:${current.key}:${row.duration}`" class="mw-video-price-line" :data-duration="row.duration"><strong>{{ row.duration }} 秒</strong><span><input class="input" inputmode="decimal" :aria-label="`${selectedResolution} ${row.duration} 秒客户售价`" :value="row.price?.amount ?? ''" :aria-invalid="!!decimalError(row.price?.amount ?? '', true)" :disabled="disabled || row.ambiguous" :data-test="`video-sale-${row.duration}`" @input="setPrice(row.duration, ($event.target as HTMLInputElement).value)" /><small>CNY / 条</small><small v-if="row.ambiguous">存在重叠售价，请先核对规则。</small><small v-else-if="decimalError(row.price?.amount ?? '', true)">{{ decimalError(row.price?.amount ?? '', true) }}</small></span></label>
      </div>
      <div class="mw-video-price-actions"><button type="button" class="btn btn-secondary" :disabled="disabled || !current || current.rows.some(row => row.ambiguous)" data-test="arithmetic-preview" @click="previewFill">按等差补齐售价</button><button v-if="undo" type="button" class="mw-link" :disabled="disabled || !canUndo" data-test="arithmetic-undo" @click="undoFill">撤销最近一次补齐</button></div>
      <p v-if="undo && !canUndo" class="mw-muted">本批次填入的售价均已改变，或商品规格已变化；保留最新输入。</p>
      <p v-if="message" role="status">{{ message }}</p>
    </template>
    <MediaDialog v-if="preview" :show="!!preview" title="确认按等差补齐售价" @close="preview = undefined"><template v-if="preview"><p>仅 {{ selectedResolution }} · {{ current && groupLabel(current.match) }}，每下一档增加 {{ preview.delta }} 元（不是每秒）。</p><p>保留 {{ preview.retained }} 项已填写售价；填入 {{ preview.changes.length }} 项。</p><ul><li v-for="row in preview.changes" :key="row.duration">{{ row.duration }} 秒 → {{ row.amount }} CNY / 条</li></ul></template><template #actions><button type="button" class="btn btn-primary" :disabled="disabled || !preview?.changes.length" data-test="arithmetic-confirm" @click="applyFill">确认填入草稿</button></template></MediaDialog>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Match, Product } from '@/api/admin/mediaWorkbench'
import MediaDialog from './MediaDialog.vue'
import { costLabel } from './procurementMatrix'
import { decimalError } from './costCalculator'
import { arithmeticFill, setVideoSale, videoGroups } from './videoSaleGroups'
const props = defineProps<{ product: Product; disabled?: boolean }>()
const emit = defineEmits<{ 'update:product': [product: Product] }>()
const selectedResolution = ref(''), selectedGroup = ref(''), message = ref('')
const groups = computed(() => videoGroups(props.product, selectedResolution.value))
const current = computed(() => groups.value?.find(group => group.key === selectedGroup.value))
watch(() => props.product.capabilities.resolutions, values => { if (!values.includes(selectedResolution.value)) selectedResolution.value = values[0] ?? '' }, { immediate: true })
watch(groups, values => { if (!values?.some(group => group.key === selectedGroup.value)) selectedGroup.value = values?.[0]?.key ?? '' }, { immediate: true })
const groupLabel = (match: Match) => Object.keys(match).length ? costLabel(match) : '所有已配置比例、画质与素材共享'
function progress(resolution: string) { const rows = videoGroups(props.product, resolution)?.flatMap(group => group.rows) ?? []; return `${rows.filter(row => row.price && !decimalError(row.price.amount, true)).length}/${rows.length}` }
function setPrice(duration: number, amount: string) {
  if (props.disabled || !current.value) return
  try { emit('update:product', setVideoSale(props.product, selectedResolution.value, current.value.match, duration, amount)); message.value = '' }
  catch (error) { message.value = (error as Error).message }
}
const preview = ref<ReturnType<typeof arithmeticFill>>()
let previewSource = '', previewResolution = '', previewGroup = ''
const undo = ref<{ resolution: string; group: Match; domain: string; changes: { duration: number; amount: string }[] }>()
const fingerprint = () => JSON.stringify(props.product)
const undoable = computed(() => {
  const batch = undo.value
  if (!batch || batch.domain !== JSON.stringify(props.product.capabilities)) return []
  const rows = videoGroups(props.product, batch.resolution)?.find(group => group.key === JSON.stringify(Object.fromEntries(Object.entries(batch.group).sort(([a], [b]) => a.localeCompare(b)))))?.rows ?? []
  return batch.changes.filter(change => rows.some(row => row.duration === change.duration && !row.ambiguous && row.price?.amount === change.amount))
})
const canUndo = computed(() => undoable.value.length > 0)
function previewFill() { message.value = ''; try { if (!current.value) return; preview.value = arithmeticFill(current.value.rows); previewSource = fingerprint(); previewResolution = selectedResolution.value; previewGroup = selectedGroup.value } catch (error) { message.value = (error as Error).message } }
function applyFill() {
  if (props.disabled || !preview.value || !current.value) return
  if (fingerprint() !== previewSource || previewResolution !== selectedResolution.value || previewGroup !== selectedGroup.value) { preview.value = undefined; message.value = '草稿或分组已变化，请重新预览。'; return }
  let next = props.product
  try { for (const row of preview.value.changes) next = setVideoSale(next, selectedResolution.value, current.value.match, row.duration, row.amount) }
  catch (error) { message.value = (error as Error).message; preview.value = undefined; return }
  undo.value = { resolution: selectedResolution.value, group: JSON.parse(JSON.stringify(current.value.match)), domain: JSON.stringify(props.product.capabilities), changes: preview.value.changes }
  preview.value = undefined
  emit('update:product', next)
}
function undoFill() {
  if (props.disabled || !canUndo.value || !undo.value) return
  let next = props.product
  for (const row of undoable.value) next = setVideoSale(next, undo.value.resolution, undo.value.group, row.duration, '')
  undo.value = undefined
  emit('update:product', next)
}
function invalidateUndo() { preview.value = undefined; undo.value = undefined }
defineExpose({ invalidateUndo })
watch(() => props.product.product_id, invalidateUndo)
</script>
<style scoped>
.mw-video-price-list { display:grid; gap:.65rem; max-width:48rem; }
.mw-video-price-line { display:grid; grid-template-columns:6rem minmax(0,1fr); align-items:center; gap:1rem; padding:.75rem 1rem; border:1px solid rgb(var(--site-primary-300) / .3); border-radius:.8rem; }
.mw-video-price-line span { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; }
.mw-video-price-line input { width:min(100%,15rem); }
.mw-video-price-actions { display:flex; flex-wrap:wrap; gap:1rem; margin:1rem 0; }
</style>
