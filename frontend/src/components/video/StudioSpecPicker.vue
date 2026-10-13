<template>
  <div class="studio-spec-control" @keydown.esc.stop.prevent="close" @focusout="leave">
    <button ref="trigger" type="button" class="studio-chip" :disabled="disabled" :data-testid="id"
      :aria-expanded="open" :aria-controls="`${id}-menu`" :aria-invalid="invalid || undefined"
      :aria-describedby="describedby" @click="emit('update:open', !open)">
      <span>{{ label }}</span><strong>{{ modelValue }}{{ unit ? ` ${unit}` : '' }}</strong><Icon name="chevronDown" />
    </button>
    <Transition name="studio-pop">
      <div v-if="open" :id="`${id}-menu`" ref="menu" class="studio-popover studio-spec-menu"
        :class="{ 'studio-count-menu': columns === 5 }" :style="{ left: `${left}px` }" role="group" :aria-label="`选择${label}`">
        <p>{{ label }}<span v-if="unit">单位：{{ unit }}</span></p>
        <div class="studio-spec-options" :style="{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }" @keydown="navigate">
          <button v-for="value in options" :key="value" type="button" :disabled="disabled"
            :data-value="value" :aria-pressed="modelValue === value" :class="{ chosen: modelValue === value }"
            @click="choose(value)">{{ value }}</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import Icon from '@/components/icons/Icon.vue'
const props = withDefaults(defineProps<{
  id: string; label: string; modelValue: string | number; options: readonly (string | number)[];
  open: boolean; disabled?: boolean; unit?: string; columns?: number; invalid?: boolean; describedby?: string
}>(), { columns: 2 })
const emit = defineEmits<{ 'update:modelValue': [value: string | number]; 'update:open': [value: boolean] }>()
const trigger = ref<HTMLButtonElement>(), menu = ref<HTMLElement>(), left = ref(0)
watch(() => props.open, async open => {
  if (!open) return
  await nextTick()
  if (!props.open || !menu.value || !trigger.value) return
  // Keep the small panel inside the viewport even when the last chip wraps on a phone.
  const box = trigger.value.getBoundingClientRect(), width = menu.value.offsetWidth
  left.value = Math.max(16 - box.left, Math.min(0, window.innerWidth - 16 - box.left - width))
  menu.value.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus()
})
function close() { emit('update:open', false); void nextTick(() => trigger.value?.focus()) }
function choose(value: string | number) {
  if (props.disabled || !props.options.includes(value)) return
  emit('update:modelValue', value); close()
}
function leave(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) emit('update:open', false)
}
function navigate(event: KeyboardEvent) {
  const buttons = [...(menu.value?.querySelectorAll<HTMLButtonElement>('[data-value]') || [])]
  const current = buttons.indexOf(event.target as HTMLButtonElement)
  const offsets: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: props.columns, ArrowUp: -props.columns }
  const offset = offsets[event.key]
  if (current < 0 || (offset === undefined && !['Home', 'End'].includes(event.key))) return
  event.preventDefault()
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, current + (offset || 0)))
  buttons[index]?.focus()
}
</script>
