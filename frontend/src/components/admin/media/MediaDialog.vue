<template>
  <dialog ref="element" class="media-dialog" :aria-labelledby="titleId" tabindex="-1" @keydown="trapFocus" @cancel.prevent="!busy && emit('close')">
    <h2 :id="titleId">{{ title }}</h2>
    <slot v-if="show" />
    <footer v-if="show"><slot name="actions" /><button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('close')">取消</button></footer>
  </dialog>
</template>
<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
const props = defineProps<{ show: boolean; title: string; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const element = ref<HTMLDialogElement>()
const titleId = `media-dialog-${useId()}`
let previousFocus: HTMLElement | null = null
function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !element.value) return
  const focusable = Array.from(element.value.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])')).filter(node => node.getClientRects().length > 0)
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first) { event.preventDefault(); element.value.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === element.value)) {
    event.preventDefault(); last?.focus()
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element.value)) {
    event.preventDefault(); first.focus()
  }
}
watch(() => props.show, async show => {
  await nextTick()
  if (show) {
    previousFocus = document.activeElement as HTMLElement
    element.value?.showModal()
  } else {
    element.value?.close()
    previousFocus?.focus()
  }
}, { immediate: true })
onBeforeUnmount(() => element.value?.close())
</script>
<style>
.media-dialog { width: min(32rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); padding: 1.5rem; border-radius: 1.25rem; border: 1px solid rgb(var(--site-primary-300)); color: #1f2937; background: var(--site-canvas-light, white); box-shadow: 0 18px 70px var(--site-shadow); }
.media-dialog::backdrop { background: rgb(15 23 42 / .55); }
.media-dialog h2 { font-size: 1.2rem; font-weight: 700; margin-bottom: 1rem; }
.media-dialog footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: .75rem; margin-top: 1.5rem; }
.media-dialog p { margin: .75rem 0; }
.dark .media-dialog { background: #1f2937; color: #f3f4f6; border-color: rgb(var(--site-primary-400) / .4); }
</style>
