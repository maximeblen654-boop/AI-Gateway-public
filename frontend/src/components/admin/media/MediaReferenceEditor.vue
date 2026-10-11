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
        <input class="input" type="number" min="1" max="16" step="1" :value="modelValue[kind.key].max < 0 ? '' : modelValue[kind.key].max" :data-test="`reference-${kind.key}-max`" :aria-invalid="!!error" @input="setMax(kind.key, $event)" />
        <small>请按实际接口限制填写，本站最多 16 份；不是供应商能力承诺。</small>
      </label>
      <p v-if="modelValue[kind.key].min > 1" class="mw-muted">保留原配置：至少上传 {{ modelValue[kind.key].min }} 份。重新选择上传方式才会改为至少 1 份。</p>
    </div>
    <label v-if="!imageOnly" class="mw-field">所有素材合计最多上传
      <input class="input" type="number" min="0" max="16" step="1" :value="modelValue.total_max < 0 ? '' : modelValue.total_max" data-test="reference-total" :aria-invalid="!!error" @input="setTotal($event)" />
      <small>图片、视频与音频共享此上限，最高 16。0 表示不能上传素材。</small>
    </label>
    <p v-if="mediaType === 'image' && modelValue.image.max === 0" class="mw-reference-empty" data-test="text-only">当前商品按纯文生图配置，无需上传参考素材。只有确认接口支持后才选择开放上传。</p>
    <p v-if="imageOnly" class="mw-muted" data-test="reference-total-summary">有效参考图片上限：{{ Math.min(modelValue.image.max, modelValue.total_max) }} 张。修改上传方式或数量后，合计上限自动与图片上限一致。</p>
    <p v-if="modelValue.total_max === 0 && kinds.some(kind => modelValue[kind.key].max > 0)" class="mw-banner" data-test="legacy-reference-zero">原配置合计上限为 0，当前不允许上传素材；0 不表示无限。查看或切换步骤不会更改它，请明确修改上传方式或上限后再保存。</p>
    <p v-if="error" role="alert" class="mw-field-error" data-test="reference-error">{{ error }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick } from 'vue'
import type { References } from '@/api/admin/mediaWorkbench'
const props = defineProps<{ modelValue: References; mediaType: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: References] }>()
type Kind = 'image' | 'video' | 'audio'
const kinds = computed(() => props.mediaType === 'image' ? [{ key: 'image' as const, label: '参考图片' }] : [
  { key: 'image' as const, label: '参考图片' }, { key: 'video' as const, label: '参考视频' }, { key: 'audio' as const, label: '参考音频' }
])
const imageOnly = computed(() => props.mediaType === 'image' && props.modelValue.video.max === 0 && props.modelValue.audio.max === 0)
function mode(kind: Kind) { const value = props.modelValue[kind]; return value.max === 0 ? 'none' : value.min > 0 ? 'required' : 'optional' }
const error = computed(() => {
  const refs = props.modelValue
  if (Object.values({ image: refs.image, video: refs.video, audio: refs.audio }).some(r => !Number.isInteger(r.min) || !Number.isInteger(r.max) || r.min < 0 || r.max < r.min || r.max > 16) || !Number.isInteger(refs.total_max) || refs.total_max < 0 || refs.total_max > 16) return '参考素材数量必须是 0～16 的整数，且上限不能小于必填数量。请按已确认接口限制修正。'
  if (refs.image.min + refs.video.min + refs.audio.min > refs.total_max) return '必填素材数量超过合计上限，当前配置不可用。请明确调整上传方式或上限。'
  return ''
})
defineExpose({ error })
function change(update: (next: References) => void) {
  const next: References = JSON.parse(JSON.stringify(props.modelValue))
  update(next)
  if (imageOnly.value) next.total_max = next.image.max
  emit('update:modelValue', next)
}
async function setMode(kind: Kind, event: Event) {
  const target = event.target as HTMLSelectElement
  const value = target.value
  change(next => { next[kind] = value === 'none' ? { min: 0, max: 0 } : { min: value === 'required' ? 1 : 0, max: Math.max(1, next[kind].max) } })
  await nextTick()
  // The parent may cancel a price-loss confirmation. Restore the native control too.
  target.value = mode(kind)
}
async function setMax(kind: Kind, event: Event) {
  const target = event.target as HTMLInputElement
  const value = target.value
  change(next => { next[kind].max = value === '' ? -1 : Number(value) })
  await nextTick()
  target.value = props.modelValue[kind].max < 0 ? '' : String(props.modelValue[kind].max)
}
async function setTotal(event: Event) {
  const target = event.target as HTMLInputElement
  const next = JSON.parse(JSON.stringify(props.modelValue)) as References
  next.total_max = target.value === '' ? -1 : Number(target.value)
  emit('update:modelValue', next)
  await nextTick()
  target.value = props.modelValue.total_max < 0 ? '' : String(props.modelValue.total_max)
}
</script>
