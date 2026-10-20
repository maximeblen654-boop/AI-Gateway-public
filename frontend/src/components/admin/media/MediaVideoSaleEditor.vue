<template>
  <section class="mw-video-sales" data-test="video-sale-editor">
    <div class="mw-pricing-dimensions" role="group" aria-label="售价分辨率">
      <button v-for="resolution in product.capabilities.resolutions" :key="resolution" type="button" class="btn" :class="selectedResolution === resolution ? 'btn-primary' : 'btn-secondary'" :aria-pressed="selectedResolution === resolution" :data-test="`sale-resolution-${resolution}`" @click="selectResolution(resolution)">{{ resolution }} <small>{{ progress.get(resolution) }}</small></button>
    </div>
    <div class="mw-video-price-actions" data-test="video-sale-tools">
      <button type="button" class="btn btn-secondary" :disabled="disabled || !current || current.rows.some(row => row.ambiguous)" data-test="arithmetic-preview" @click="previewFill">按等差补齐售价</button>
      <button v-if="undo" type="button" class="mw-link" :disabled="disabled || !canUndo" data-test="arithmetic-undo" @click="undoFill">撤销最近一次补齐</button>
      <button type="button" class="btn btn-secondary" :disabled="disabled || !pricedRules && !inputs.length" data-test="clear-video-sales" @click="openClear">清空当前商品全部售价</button>
    </div>
    <p v-if="!groups" class="mw-banner">当前规格超出安全组合预算或尚未完成配置，请返回核对规格；已有售价和本地输入保留。</p>
    <template v-else>
      <label v-if="groups.length > 1" class="mw-field">售价子分组<select :value="selectedGroup" class="input" data-test="sale-subgroup" @change="selectGroup($event)"><option v-for="group in groups" :key="group.key" :value="group.key">{{ groupLabel(group.match) }}</option></select></label>
      <p class="mw-muted">{{ current ? groupLabel(current.match) : '请先配置合法分辨率与时长。' }} · 以下为整条视频售价，不再乘秒数。</p>
      <div v-if="current" class="mw-video-price-list">
        <label v-for="row in current.rows" :key="`${selectedResolution}:${current.key}:${row.duration}`" class="mw-video-price-line" :data-duration="row.duration"><strong>{{ row.duration }} 秒</strong><span><input class="input" inputmode="decimal" maxlength="128" :aria-label="`${selectedResolution} ${row.duration} 秒客户售价`" :value="inputValue(row.duration, row.price?.amount ?? '')" :aria-invalid="!!decimalError(inputValue(row.duration, row.price?.amount ?? ''), true)" :disabled="disabled || row.ambiguous" :data-test="`video-sale-${row.duration}`" @input="setPrice(row.duration, ($event.target as HTMLInputElement).value)" @blur="commitPending()" @keydown.enter.prevent="commitPending()" /><small>CNY / 条</small><small v-if="row.ambiguous">存在重叠售价，请先核对规则。</small><small v-else-if="decimalError(inputValue(row.duration, row.price?.amount ?? ''), true)">{{ decimalError(inputValue(row.duration, row.price?.amount ?? ''), true) }}</small></span></label>
      </div>
      <p v-if="undo && !canUndo" class="mw-muted">本批次填入的售价均已改变，或商品规格已变化；保留最新输入。</p>
    </template>
    <p v-if="inputs.length" class="mw-muted" data-test="pending-video-sales">{{ inputs.length }} 处售价输入尚未应用草稿；完成输入后自动应用。</p>
    <p v-if="message" role="status">{{ message }}</p>
    <MediaDialog v-if="preview" :show="!!preview" title="确认按等差补齐售价" @close="preview = undefined"><template v-if="preview"><p>仅 {{ selectedResolution }} · {{ current && groupLabel(current.match) }}，每下一档增加 {{ preview.delta }} 元（不是每秒）。</p><p>保留 {{ preview.retained }} 项已填写售价；填入 {{ preview.changes.length }} 项。</p><ul><li v-for="row in preview.changes" :key="row.duration">{{ row.duration }} 秒 → {{ row.amount }} CNY / 条</li></ul></template><template #actions><button type="button" class="btn btn-primary" :disabled="disabled || !preview?.changes.length" data-test="arithmetic-confirm" @click="applyFill">确认填入草稿</button></template></MediaDialog>
    <MediaDialog v-if="clearSource !== undefined" :show="true" title="确认清空当前视频商品全部售价" @close="cancelClear"><p>将清空「{{ product.display_name }}」的 {{ pricedRules }} 条已有售价，涵盖全部分辨率和售价子分组。规格、素材要求和合法组合均保留。</p><p v-if="inputs.length">同时清除 {{ inputs.length }} 处尚未应用的本地售价输入。</p><p>仅修改当前商品的草稿；已发布售价保持原样，重新发布前不会影响客户。</p><template #actions><button type="button" class="btn btn-primary" :disabled="disabled" data-test="confirm-clear-video-sales" @click="clearSales">确认清空草稿售价</button></template></MediaDialog>
  </section>
</template>
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { draftInput, type Match, type Product } from '@/api/admin/mediaWorkbench'
import MediaDialog from './MediaDialog.vue'
import { costLabel } from './procurementMatrix'
import { decimalError } from './costCalculator'
import { arithmeticFill, setVideoSales, videoGroups, videoGroupKey, videoSaleInputKey, type VideoSaleInput } from './videoSaleGroups'

const props = defineProps<{ product: Product; disabled?: boolean; pendingVideoSales?: VideoSaleInput[] }>()
const emit = defineEmits<{ 'update:product': [product: Product]; 'pending-video-sales': [inputs: VideoSaleInput[]] }>()
const selectedResolution = ref(''), selectedGroup = ref(''), message = ref('')
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
// Text edits do not invalidate either the rows or the progress badges.
const groupsByResolution = computed(() => new Map(props.product.capabilities.resolutions.map(resolution => [resolution, videoGroups(props.product, resolution)])))
const progress = computed(() => new Map([...groupsByResolution.value].map(([resolution, groups]) => {
  const rows = groups?.flatMap(group => group.rows) ?? []
  return [resolution, `${rows.filter(row => row.price && !decimalError(row.price.amount, true)).length}/${rows.length}`]
})))
const groups = computed(() => groupsByResolution.value.get(selectedResolution.value))
const current = computed(() => groups.value?.find(group => group.key === selectedGroup.value))
const domain = computed(() => JSON.stringify(draftInput([props.product]).products[0]!.capabilities))
const inputs = ref<VideoSaleInput[]>([])
const inputMap = computed(() => new Map(inputs.value.map(input => [videoSaleInputKey(input), input.amount])))
let inputTimer: ReturnType<typeof setTimeout> | undefined
function scheduleCommit() { clearTimeout(inputTimer); if (inputs.value.length) inputTimer = setTimeout(() => { void commitPending() }, 800) }
watch(() => props.pendingVideoSales, value => { inputs.value = clone(value ?? []); scheduleCommit() }, { immediate: true })
watch(() => props.product.capabilities.resolutions, values => { if (!values.includes(selectedResolution.value)) selectedResolution.value = values[0] ?? '' }, { immediate: true })
watch(groups, values => { if (!values?.some(group => group.key === selectedGroup.value)) selectedGroup.value = values?.[0]?.key ?? '' }, { immediate: true })
const groupLabel = (match: Match) => Object.keys(match).length ? costLabel(match) : '所有已配置比例、画质与素材共享'
function inputValue(duration: number, fallback: string) { return current.value ? inputMap.value.get(videoSaleInputKey({ resolution: selectedResolution.value, group: current.value.match, duration })) ?? fallback : fallback }
function publishInputs() { emit('pending-video-sales', clone(inputs.value)) }
function setPrice(duration: number, amount: string) {
  if (props.disabled || !current.value) return
  const row = current.value.rows.find(row => row.duration === duration)
  if (!row || row.ambiguous) return
  const target = { resolution: selectedResolution.value, group: current.value.match, duration }
  const key = videoSaleInputKey(target), existing = inputs.value.find(input => videoSaleInputKey(input) === key)
  const input: VideoSaleInput = { ...target, group: clone(target.group), amount, source_price: clone(existing ? existing.source_price : row.price ?? null), domain: existing?.domain ?? domain.value }
  inputs.value = [...inputs.value.filter(input => videoSaleInputKey(input) !== key), input]
  message.value = ''; publishInputs(); scheduleCommit()
}
async function commitPending(): Promise<boolean> {
  clearTimeout(inputTimer)
  if (!inputs.value.length) return true
  if (props.disabled) return false
  try {
    for (const input of inputs.value) {
      const error = decimalError(input.amount, true)
      if (error) throw new Error(`${input.resolution} ${input.duration} 秒：${error}本地输入已保留，尚未应用草稿。`)
      const row = groupsByResolution.value.get(input.resolution)?.find(group => group.key === videoGroupKey(input.group))?.rows.find(row => row.duration === input.duration)
      if (input.domain !== domain.value || !row || row.ambiguous || JSON.stringify(row.price ?? null) !== JSON.stringify(input.source_price)) throw new Error('商品规格或售价已变化；本地输入已保留，尚未应用草稿。请核对后再修改，或明确清空草稿售价。')
    }
    const next = setVideoSales(props.product, inputs.value)
    emit('update:product', next)
    inputs.value = []; publishInputs(); message.value = ''
    await nextTick()
    return true
  } catch (error) { message.value = (error as Error).message; return false }
}
async function selectResolution(resolution: string) { if (resolution !== selectedResolution.value && await commitPending()) selectedResolution.value = resolution }
async function selectGroup(event: Event) {
  const target = event.target as HTMLSelectElement, key = target.value
  target.value = selectedGroup.value
  if (key !== selectedGroup.value && await commitPending()) selectedGroup.value = key
}
const preview = ref<ReturnType<typeof arithmeticFill>>()
let previewSource = '', previewResolution = '', previewGroup = ''
const undo = ref<{ resolution: string; group: Match; domain: string; changes: { duration: number; amount: string }[] }>()
const fingerprint = () => JSON.stringify(props.product)
const undoable = computed(() => {
  const batch = undo.value
  if (!batch || batch.domain !== domain.value) return []
  const rows = groupsByResolution.value.get(batch.resolution)?.find(group => group.key === videoGroupKey(batch.group))?.rows ?? []
  return batch.changes.filter(change => rows.some(row => row.duration === change.duration && !row.ambiguous && row.price?.amount === change.amount))
})
const canUndo = computed(() => undoable.value.length > 0)
async function previewFill() {
  if (!await commitPending()) return
  message.value = ''
  try { if (!current.value) return; preview.value = arithmeticFill(current.value.rows); previewSource = fingerprint(); previewResolution = selectedResolution.value; previewGroup = selectedGroup.value }
  catch (error) { message.value = (error as Error).message }
}
function applyFill() {
  if (props.disabled || !preview.value || !current.value) return
  if (fingerprint() !== previewSource || previewResolution !== selectedResolution.value || previewGroup !== selectedGroup.value || inputs.value.length) { preview.value = undefined; message.value = '草稿或分组已变化，请重新预览。'; return }
  try {
    const next = setVideoSales(props.product, preview.value.changes.map(row => ({ resolution: selectedResolution.value, group: current.value!.match, duration: row.duration, amount: row.amount })))
    undo.value = { resolution: selectedResolution.value, group: clone(current.value.match), domain: domain.value, changes: preview.value.changes }
    preview.value = undefined; emit('update:product', next)
  } catch (error) { message.value = (error as Error).message; preview.value = undefined }
}
async function undoFill() {
  if (!await commitPending() || props.disabled || !canUndo.value || !undo.value) return
  try {
    const next = setVideoSales(props.product, undoable.value.map(row => ({ resolution: undo.value!.resolution, group: undo.value!.group, duration: row.duration, amount: '' })))
    undo.value = undefined; emit('update:product', next)
  } catch (error) { message.value = (error as Error).message }
}
const pricedRules = computed(() => props.product.pricing_rules.filter(rule => !!rule.sale_price?.amount).length)
const clearSource = ref<string>()
function openClear() { clearTimeout(inputTimer); clearSource.value = fingerprint() }
function cancelClear() { clearSource.value = undefined; scheduleCommit() }
function clearSales() {
  if (props.disabled || clearSource.value === undefined) return
  if (clearSource.value !== fingerprint()) { cancelClear(); message.value = '草稿已变化，请重新核对清空范围。'; return }
  const groups = [...groupsByResolution.value.values()]
  const pending = groups.some(group => !group) ? '当前商品全部售价' : `${groups.reduce((sum, group) => sum + group!.reduce((sum, cell) => sum + cell.rows.length, 0), 0)} 项售价`
  const next: Product = { ...props.product, pricing_rules: props.product.pricing_rules.map(rule => ({ ...rule, sale_price: null })) }
  clearSource.value = undefined; invalidateUndo(); inputs.value = []
  emit('update:product', next); publishInputs()
  message.value = `已清空当前商品草稿，${pending}待填写。已发布售价保持原样；补齐并重新发布前不会改变客户价格。`
}
function invalidateUndo() { preview.value = undefined; undo.value = undefined }
defineExpose({ invalidateUndo, commitPending })
watch(() => props.product.product_id, () => { clearTimeout(inputTimer); inputs.value = clone(props.pendingVideoSales ?? []); invalidateUndo() })
onBeforeUnmount(() => clearTimeout(inputTimer))
</script>
<style scoped>
.mw-video-price-list { display:grid; gap:.65rem; max-width:48rem; }
.mw-video-price-line { display:grid; grid-template-columns:6rem minmax(0,1fr); align-items:center; gap:1rem; padding:.75rem 1rem; border:1px solid rgb(var(--site-primary-300) / .3); border-radius:.8rem; }
.mw-video-price-line span { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; }
.mw-video-price-line input { width:min(100%,15rem); }
.mw-video-price-actions { display:flex; align-items:center; flex-wrap:wrap; gap:.75rem; margin:1rem 0; }
@media (max-width:640px) { .mw-video-price-actions { gap:.5rem; } .mw-video-price-line { grid-template-columns:4rem minmax(0,1fr); gap:.5rem; padding:.65rem; } }
</style>
