<template>
  <div class="mw-field">
    <label :for="inputId">{{ label }}</label>
    <div v-if="presets?.length || aspectRatio" class="mw-token-presets" role="group" :aria-label="`${label}常用值`">
      <button v-for="preset in presets" :key="preset" type="button" class="mw-token-chip" :class="{ 'mw-token-chip-selected': values.includes(preset) }" :aria-pressed="values.includes(preset)" :disabled="disabled" @click="toggle(preset)">{{ preset }}</button>
      <button v-if="aspectRatio" type="button" class="mw-token-chip mw-custom-toggle" :aria-expanded="customOpen" :aria-controls="customId" :disabled="disabled" data-test="custom-ratio-toggle" @click="openCustom">＋ 自定义比例</button>
    </div>
    <div v-if="aspectRatio && customValues.length" class="mw-token-presets" role="group" aria-label="已选自定义比例">
      <button v-for="value in customValues" :key="value" type="button" class="mw-token-chip mw-token-chip-selected" :disabled="disabled" :aria-label="`移除比例 ${value}`" @click="toggle(value)">{{ value }} <span aria-hidden="true">×</span></button>
    </div>
    <div v-if="aspectRatio && customOpen" :id="customId" class="mw-custom-ratio">
      <div class="mw-custom-ratio-entry">
        <input ref="customInput" v-model="customValue" class="input" :disabled="disabled" aria-label="自定义比例" placeholder="例如 3:5" :aria-invalid="!!customError" :aria-describedby="customError ? `${customId}-error` : undefined" data-test="custom-ratio-input" @keydown.enter.prevent="addCustom" @input="customError = ''" />
        <button type="button" class="btn btn-secondary" :disabled="disabled || !customValue.trim()" data-test="custom-ratio-add" @click="addCustom">添加</button>
      </div>
      <p v-if="customError" :id="`${customId}-error`" class="mw-field-error" role="alert">{{ customError }}</p>
    </div>
    <input :id="inputId" class="input" :value="modelValue.join(', ')" :disabled="disabled" :placeholder="placeholder" :aria-invalid="!!listError" :aria-describedby="listError ? `${hintId} ${inputId}-error` : hintId" data-test="tokens-input" @change="change" />
    <small :id="hintId">{{ numeric ? '用逗号分隔整数' : aspectRatio ? '也可用逗号批量编辑。仅配置已确认支持的比例，保存校验并发布后才对客户生效。' : '用逗号分隔多个值' }}</small>
    <p v-if="listError" :id="`${inputId}-error`" class="mw-field-error" role="alert">{{ listError }}</p>
    <span v-if="notice" class="mw-token-notice" role="status">{{ notice }}</span>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
const props = defineProps<{ label: string; modelValue: string[] | number[]; numeric?: boolean; disabled?: boolean; presets?: string[]; placeholder?: string; aspectRatio?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[] | number[]] }>()
const inputId = `media-tokens-${useId()}`
const hintId = `${inputId}-hint`
const customId = `${inputId}-custom`
const customOpen = ref(false)
const customValue = ref('')
const customInput = ref<HTMLInputElement>()
const customError = ref('')
const listError = ref('')
const notice = ref('')
const values = computed(() => props.modelValue.map(String))
const customValues = computed(() => values.value.filter(value => !props.presets?.includes(value)))
const ratioError = '请输入正整数比例，例如 3:5；冒号两侧都须大于 0。'
function validRatio(value: string) {
  // Preserve the existing automatic-specification token without translating it.
  return value === 'auto' || /^\d+:\d+$/.test(value) && value.split(':').every(part => Number.isSafeInteger(Number(part)) && Number(part) > 0)
}
function normalize(value: string) { return props.aspectRatio ? value.trim().replace(/\s*:\s*/g, ':') : value.trim() }
async function openCustom() {
  customOpen.value = !customOpen.value
  if (customOpen.value) { await nextTick(); customInput.value?.focus() }
}
function addCustom() {
  if (props.disabled) return
  const value = normalize(customValue.value)
  if (!validRatio(value)) { customError.value = ratioError; return }
  customError.value = ''
  if (values.value.includes(value)) notice.value = `${value} 已在当前比例中，无需重复添加。`
  else { emit('update:modelValue', [...values.value, value]); notice.value = `已添加 ${value}。` }
  customValue.value = ''
  customInput.value?.focus()
}
async function change(event: Event) {
  if (props.disabled) return
  const target = event.target as HTMLInputElement
  const parsed = target.value.split(/[,，]/).map(normalize).filter(Boolean)
  const next = props.aspectRatio ? [...new Set(parsed)] : parsed
  if (props.aspectRatio && next.some(value => !validRatio(value))) { listError.value = ratioError; return }
  listError.value = ''; notice.value = ''
  emit('update:modelValue', props.numeric ? next.map(Number) : next)
  await nextTick()
  target.value = props.modelValue.join(', ')
}
function toggle(value: string) {
  if (props.disabled) return
  const next = values.value.includes(value) ? values.value.filter(item => item !== value) : [...values.value, value]
  listError.value = ''; notice.value = ''
  emit('update:modelValue', props.numeric ? next.map(Number) : next)
}
</script>
<style scoped>
.mw-custom-toggle { border-style: dashed; }
.mw-custom-ratio { padding: .7rem; border: 1px solid var(--mw-border); border-radius: .65rem; background: var(--mw-soft); }
.mw-custom-ratio-entry { display: flex; align-items: center; gap: .5rem; }
.mw-custom-ratio-entry .input { flex: 1; width: 0; }
.mw-custom-ratio-entry button { flex-shrink: 0; min-height: 44px; }
.mw-token-notice { color: var(--mw-muted); font-size: .8rem; }
</style>
