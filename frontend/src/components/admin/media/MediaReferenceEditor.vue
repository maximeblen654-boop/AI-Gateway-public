<template>
  <div class="mw-references" data-test="reference-editor">
    <h3>参考素材</h3>
    <p class="mw-muted">只开放接口已确认支持的素材。数量是输入素材上限，与客户购买的成品数量无关。</p>
    <div v-for="kind in kinds" :key="kind.key" class="mw-reference-row">
      <label class="mw-field">{{ kind.label }}
        <select class="input" :value="mode(kind.key)" :data-test="`reference-${kind.key}-mode`" @change="setMode(kind.key, $event)">
          <option value="none">不支持{{ kind.label }}</option>
          <option value="optional">支持，客户可选上传</option>
          <option value="required">支持，客户必须上传</option>
        </select>
      </label>
      <label v-if="modelValue[kind.key].max !== 0" class="mw-field">已确认的最多上传数量
        <input class="input" type="number" min="1" :max="effectiveMax" step="1" :value="inputValues[kind.key]" :data-test="`reference-${kind.key}-max`" :aria-invalid="!!error" @input="buffer(kind.key, $event)" @change="commit([kind.key])" @blur="commit([kind.key])" @keydown.enter.prevent="commit([kind.key])" />
        <small>请按实际接口限制填写，当前接入上限 {{ effectiveMax }} 份；不是供应商能力承诺。</small>
      </label>
      <p v-if="modelValue[kind.key].min > 1" class="mw-muted">保留原配置：至少上传 {{ modelValue[kind.key].min }} 份。重新选择上传方式才会改为至少 1 份。</p>
    </div>
    <label v-if="!imageOnly" class="mw-field">所有素材合计最多上传
      <input class="input" type="number" min="0" :max="effectiveMax" step="1" :value="inputValues.total" data-test="reference-total" :aria-invalid="!!error" @input="buffer('total', $event)" @change="commit(['total'])" @blur="commit(['total'])" @keydown.enter.prevent="commit(['total'])" />
      <small>图片、视频与音频共享此上限，最高 {{ effectiveMax }}。0 表示不能上传素材。</small>
    </label>
    <p v-if="mediaType === 'image' && modelValue.image.max === 0" class="mw-reference-empty" data-test="text-only">当前商品按纯文生图配置，无需上传参考素材。只有确认接口支持后才选择开放上传。</p>
    <p v-if="imageOnly" class="mw-muted" data-test="reference-total-summary">有效参考图片上限：{{ Math.min(modelValue.image.max, modelValue.total_max) }} 张。修改上传方式或数量后，合计上限自动与图片上限一致。</p>
    <p v-if="modelValue.total_max === 0 && kinds.some(kind => modelValue[kind.key].max > 0)" class="mw-banner" data-test="legacy-reference-zero">原配置合计上限为 0，当前不允许上传素材；0 不表示无限。查看或切换步骤不会更改它，请明确修改上传方式或上限后再保存。</p>
    <p v-if="error" role="alert" class="mw-field-error" data-test="reference-error">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import type { References } from '@/api/admin/mediaWorkbench'
const props = defineProps<{ modelValue: References; mediaType: string; maxReferences?: number }>()
const emit = defineEmits<{ 'update:modelValue': [value: References] }>()
const effectiveMax = computed(() => Math.min(props.mediaType === 'image' ? 16 : 30, props.maxReferences ?? 16))
type Kind = 'image' | 'video' | 'audio'
const kinds = computed(() => props.mediaType === 'image' ? [{ key: 'image' as const, label: '参考图片' }] : [
  { key: 'image' as const, label: '参考图片' }, { key: 'video' as const, label: '参考视频' }, { key: 'audio' as const, label: '参考音频' }
])
const imageOnly = computed(() => props.mediaType === 'image' && props.modelValue.video.max === 0 && props.modelValue.audio.max === 0)
function mode(kind: Kind) { const value = props.modelValue[kind]; return value.max === 0 ? 'none' : value.min > 0 ? 'required' : 'optional' }
const inputError = ref('')
function validate(refs: References) {
  if (Object.values({ image: refs.image, video: refs.video, audio: refs.audio }).some(r => !Number.isInteger(r.min) || !Number.isInteger(r.max) || r.min < 0 || r.max < r.min || r.max > effectiveMax.value) || !Number.isInteger(refs.total_max) || refs.total_max < 0 || refs.total_max > effectiveMax.value) return `参考素材数量必须是 0～${effectiveMax.value} 的整数，且上限不能小于必填数量。请按已确认接口限制修正。`
  if (refs.image.min + refs.video.min + refs.audio.min > refs.total_max) return '必填素材数量超过合计上限，当前配置不可用。请明确调整上传方式或上限。'
  return ''
}
const error = computed(() => inputError.value || validate(props.modelValue))

// Keystrokes are local editing state, not product/CAS/autosave updates.
type Field = Kind | 'total'
const inputValues = reactive<Record<Field, string>>({ image: '', video: '', audio: '', total: '' })
const dirty = new Set<Field>()
const current = (field: Field) => field === 'total' ? props.modelValue.total_max : props.modelValue[field].max
const display = (field: Field) => current(field) < 0 ? '' : String(current(field))
watch(() => props.modelValue, () => {
  for (const field of Object.keys(inputValues) as Field[]) if (!dirty.has(field)) inputValues[field] = display(field)
}, { deep: true, immediate: true })
function buffer(field: Field, event: Event) {
  inputValues[field] = (event.target as HTMLInputElement).value
  dirty.add(field)
  inputError.value = ''
}
let pending: Promise<boolean> | undefined
function commit(fields: Field[]): Promise<boolean> {
  // Native change, Enter, blur and wizard navigation may all finish one edit.
  // Serialize them; after the first result, later events see no dirty value.
  const operation = (pending ?? Promise.resolve(true)).then(() => apply(fields))
  pending = operation
  void operation.finally(() => { if (pending === operation) pending = undefined })
  return operation
}
async function apply(fields: Field[]): Promise<boolean> {
  const edits = fields.filter(field => dirty.has(field)).map(field => ({ field, raw: inputValues[field] }))
  if (!edits.length) return true
  const next: References = JSON.parse(JSON.stringify(props.modelValue))
  for (const { field, raw } of edits) {
    const value = Number(raw)
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < (field === 'total' ? 0 : 1) || value > effectiveMax.value) {
      inputError.value = `参考素材数量必须是 0～${effectiveMax.value} 的整数，且上限不能小于必填数量。请按已确认接口限制修正。`
      return false
    }
    if (field === 'total') next.total_max = value
    else next[field].max = value
  }
  if (imageOnly.value) next.total_max = next.image.max
  inputError.value = validate(next)
  if (inputError.value) return false
  // An unchanged field is not a request to repair legacy data or rebuild prices.
  const changed = edits.some(({ field, raw }) => Number(raw) !== current(field))
  if (changed) emit('update:modelValue', next)
  await nextTick()
  const accepted = !changed || JSON.stringify(props.modelValue) === JSON.stringify(next)
  for (const { field, raw } of edits) if (inputValues[field] === raw) {
    dirty.delete(field)
    inputValues[field] = display(field)
  }
  return accepted
}
function commitPending() { return dirty.size || pending ? commit(Object.keys(inputValues) as Field[]) : true }

defineExpose({ error, commitPending })
function change(update: (next: References) => void) {
  const next: References = JSON.parse(JSON.stringify(props.modelValue))
  update(next)
  if (imageOnly.value) next.total_max = next.image.max
  emit('update:modelValue', next)
}
async function setMode(kind: Kind, event: Event) {
  const target = event.target as HTMLSelectElement
  const value = target.value
  const committed = commitPending()
  if (committed !== true && !await committed) { target.value = mode(kind); return }
  change(next => { next[kind] = value === 'none' ? { min: 0, max: 0 } : { min: value === 'required' ? 1 : 0, max: Math.max(1, next[kind].max) } })
  await nextTick()
  // The parent may cancel a price-loss confirmation. Restore the native control too.
  target.value = mode(kind)
}
</script>
