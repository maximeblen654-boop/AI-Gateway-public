<template>
  <label class="mw-field">
    <span>{{ label }}</span>
    <input class="input" :value="modelValue.join(', ')" :disabled="disabled" :aria-describedby="hintId" @change="change" />
    <small :id="hintId">{{ numeric ? '用逗号分隔整数' : '用逗号分隔多个值' }}</small>
  </label>
</template>
<script setup lang="ts">
import { useId } from 'vue'
const props = defineProps<{ label: string; modelValue: string[] | number[]; numeric?: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[] | number[]] }>()
const hintId = `media-tokens-${useId()}`
function change(event: Event) {
  const values = (event.target as HTMLInputElement).value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
  emit('update:modelValue', props.numeric ? values.map(Number) : values)
}
</script>
