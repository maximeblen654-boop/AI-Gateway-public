<template>
  <label class="mw-field">
    <span>{{ label }}</span>
    <div v-if="presets?.length" class="mw-token-presets" :aria-label="`${label}常用值`">
      <button v-for="preset in presets" :key="preset" type="button" class="mw-token-chip" :class="{ 'mw-token-chip-selected': values.includes(preset) }" :disabled="disabled" @click="toggle(preset)">{{ preset }}</button>
    </div>
    <input class="input" :value="modelValue.join(', ')" :disabled="disabled" :placeholder="placeholder" :aria-describedby="hintId" @change="change" />
    <small :id="hintId">{{ numeric ? '用逗号分隔整数' : '用逗号分隔多个值' }}</small>
  </label>
</template>
<script setup lang="ts">
import { computed, useId } from 'vue'
const props = defineProps<{ label: string; modelValue: string[] | number[]; numeric?: boolean; disabled?: boolean; presets?: string[]; placeholder?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string[] | number[]] }>()
const hintId = `media-tokens-${useId()}`
function change(event: Event) {
  const values = (event.target as HTMLInputElement).value.split(/[,，]/).map(s => s.trim()).filter(Boolean)
  emit('update:modelValue', props.numeric ? values.map(Number) : values)
}
const values = computed(() => props.modelValue.map(String))
function toggle(value: string) {
  const next = values.value.includes(value) ? values.value.filter(item => item !== value) : [...values.value, value]
  emit('update:modelValue', props.numeric ? next.map(Number) : next)
}
</script>
