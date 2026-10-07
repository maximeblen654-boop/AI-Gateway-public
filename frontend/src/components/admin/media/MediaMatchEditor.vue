<template>
  <div class="mw-field-grid">
    <MediaTokensField label="分辨率条件（空为不限）" :model-value="modelValue.resolution ?? []" @update:model-value="set('resolution', $event)" />
    <MediaTokensField label="比例条件（空为不限）" :model-value="modelValue.aspect_ratio ?? []" @update:model-value="set('aspect_ratio', $event)" />
    <MediaTokensField label="时长条件（秒，空为不限）" numeric :model-value="modelValue.duration_seconds ?? []" @update:model-value="set('duration_seconds', $event)" />
    <MediaTokensField label="画质条件（空为不限）" :model-value="modelValue.quality ?? []" @update:model-value="set('quality', $event)" />
  </div>
  <label><input type="checkbox" :checked="!!modelValue.count" @change="toggleCount" /> 限定单次数量</label>
  <div v-if="modelValue.count" class="mw-field-grid">
    <label class="mw-field">数量下限<input :value="modelValue.count.min" class="input" type="number" step="1" @input="setCount('min', $event)" /></label>
    <label class="mw-field">数量上限<input :value="modelValue.count.max" class="input" type="number" step="1" @input="setCount('max', $event)" /></label>
  </div>
  <label><input type="checkbox" :checked="!!modelValue.references" @change="toggleReferences" /> 限定参考素材数量</label>
  <div v-if="modelValue.references" class="mw-field-grid">
    <template v-for="kind in kinds" :key="kind.key">
      <label class="mw-field">{{ kind.label }}下限<input :value="modelValue.references[kind.key].min" class="input" type="number" step="1" @input="setReference(kind.key, 'min', $event)" /></label>
      <label class="mw-field">{{ kind.label }}上限<input :value="modelValue.references[kind.key].max" class="input" type="number" step="1" @input="setReference(kind.key, 'max', $event)" /></label>
    </template>
    <label class="mw-field">参考素材合计上限<input :value="modelValue.references.total_max" class="input" type="number" step="1" @input="setReferenceTotal($event)" /></label>
  </div>
</template>
<script setup lang="ts">
import type { Match } from '@/api/admin/mediaWorkbench'
import MediaTokensField from './MediaTokensField.vue'
const props = defineProps<{ modelValue: Match }>()
const emit = defineEmits<{ 'update:modelValue': [value: Match] }>()
const kinds = [{ key: 'image', label: '图片' }, { key: 'video', label: '视频' }, { key: 'audio', label: '音频' }] as const
const numeric = (event: Event) => Number((event.target as HTMLInputElement).value)
function setCount(key: 'min' | 'max', event: Event) {
  if (props.modelValue.count) emit('update:modelValue', { ...props.modelValue, count: { ...props.modelValue.count, [key]: numeric(event) } })
}
function setReference(kind: 'image' | 'video' | 'audio', key: 'min' | 'max', event: Event) {
  const refs = props.modelValue.references
  if (refs) emit('update:modelValue', { ...props.modelValue, references: { ...refs, [kind]: { ...refs[kind], [key]: numeric(event) } } })
}
function setReferenceTotal(event: Event) {
  const refs = props.modelValue.references
  if (refs) emit('update:modelValue', { ...props.modelValue, references: { ...refs, total_max: numeric(event) } })
}
function set(key: keyof Match, value: string[] | number[]) {
  const next = { ...props.modelValue }
  if (value.length) Object.assign(next, { [key]: value })
  else delete next[key]
  emit('update:modelValue', next)
}
function toggleCount(event: Event) {
  const next = { ...props.modelValue }
  if ((event.target as HTMLInputElement).checked) next.count = { min: 1, max: 1 }
  else delete next.count
  emit('update:modelValue', next)
}
function toggleReferences(event: Event) {
  const next = { ...props.modelValue }
  if ((event.target as HTMLInputElement).checked) next.references = { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 }
  else delete next.references
  emit('update:modelValue', next)
}
</script>
