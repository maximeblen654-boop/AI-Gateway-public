<template>
  <div ref="pickerRef" class="site-theme-picker relative" @pointerenter="handlePointerEnter" @pointerleave="handlePointerLeave" @keydown.esc.stop.prevent="closeAndFocus">
    <button
      ref="triggerRef"
      type="button"
      class="site-theme-picker-trigger btn-ghost inline-flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-sm"
      :aria-label="t('common.siteTheme.label')"
      :aria-expanded="open"
      :aria-controls="menuId"
      aria-haspopup="true"
      data-test="site-theme-trigger"
      @click="toggleOnClick"
    >
      <span class="h-4 w-4 rounded-full border border-white shadow-sm" :style="{ backgroundColor: selectedColor }" />
      <span class="hidden lg:inline">{{ t(`common.siteTheme.${siteTheme}`) }}</span>
      <Icon name="chevronDown" size="sm" />
    </button>
    <div v-if="open" :id="menuId" class="dropdown site-theme-picker-menu right-0 w-48 overflow-y-auto" role="group" :aria-label="t('common.siteTheme.label')" style="max-height: min(80vh, 32rem)">
      <button
        v-for="option in siteThemeOptions"
        :key="option.value"
        type="button"
        class="dropdown-item w-full"
        :aria-pressed="siteTheme === option.value"
        :data-test="`site-theme-${option.value}`"
        @click="choose(option.value)"
      >
        <span class="h-3.5 w-3.5 rounded-full border border-white shadow-sm" :style="{ backgroundColor: option.color }" />
        {{ t(`common.siteTheme.${option.value}`) }}
        <Icon v-if="siteTheme === option.value" name="check" size="sm" class="ml-auto" />
      </button>
      <div v-if="showSidebarStyle && siteTheme === 'blue'" class="mt-1 border-t border-gray-200/70 pt-2 dark:border-dark-600" role="group" :aria-label="t('nav.sidebarStyle')">
        <p class="px-3 pb-1 text-xs text-gray-500 dark:text-dark-400">{{ t('nav.sidebarStyle') }}</p>
        <button
          v-for="option in sidebarStyleOptions"
          :key="option.value"
          type="button"
          class="dropdown-item w-full min-h-11"
          :aria-pressed="sidebarStyle === option.value"
          :data-test="`sidebar-style-${option.value}`"
          @click="chooseSidebarStyle(option.value)"
        >
          {{ t(option.label) }}
          <Icon v-if="sidebarStyle === option.value" name="check" size="sm" class="ml-auto" />
        </button>
      </div>
      <div v-if="showSidebarStyle && siteTheme === 'yellow'" class="mt-1 border-t border-gray-200/70 pt-2 dark:border-dark-600" role="group" :aria-label="t('nav.sidebarStyle')">
        <p class="px-3 pb-1 text-xs text-gray-500 dark:text-dark-400">{{ t('nav.sidebarStyle') }}</p>
        <button
          v-for="option in yellowSidebarStyleOptions"
          :key="option.value"
          type="button"
          class="dropdown-item w-full min-h-11"
          :aria-pressed="yellowSidebarStyle === option.value"
          :data-test="`yellow-sidebar-style-${option.value}`"
          @click="chooseYellowSidebarStyle(option.value)"
        >
          {{ t(option.label) }}
          <Icon v-if="yellowSidebarStyle === option.value" name="check" size="sm" class="ml-auto" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/icons/Icon.vue'
import { setSidebarStyle, setSiteTheme, setYellowSidebarStyle, sidebarStyle, siteTheme, siteThemeOptions, yellowSidebarStyle } from '@/utils/siteTheme'
import type { SidebarStyle, SiteTheme, YellowSidebarStyle } from '@/utils/siteTheme'

defineProps<{ showSidebarStyle?: boolean }>()

const { t } = useI18n()
const pickerRef = ref<HTMLElement | null>(null)
const triggerRef = ref<HTMLButtonElement | null>(null)
const menuId = `site-theme-picker-${useId()}`
const open = ref(false)
const hoverOpened = ref(false)
const selectedColor = computed(() => siteThemeOptions.find((option) => option.value === siteTheme.value)?.color)
const sidebarStyleOptions: { value: SidebarStyle; label: string }[] = [
  { value: 'botanical', label: 'nav.botanicalBlue' },
  { value: 'whale', label: 'nav.whaleBlue' },
  { value: 'whale_girl', label: 'nav.whaleGirlBlue' }
]
const yellowSidebarStyleOptions: { value: YellowSidebarStyle; label: string }[] = [
  { value: 'osmanthus', label: 'nav.osmanthusYellow' },
  { value: 'lion', label: 'nav.claudeLion' },
  { value: 'scholar', label: 'nav.claudeScholar' },
  { value: 'robot', label: 'nav.claudeRobot' }
]

function choose(theme: SiteTheme) {
  setSiteTheme(theme)
  open.value = false
  nextTick(() => triggerRef.value?.focus())
}

function chooseSidebarStyle(style: SidebarStyle) {
  setSidebarStyle(style)
  open.value = false
  nextTick(() => triggerRef.value?.focus())
}

function chooseYellowSidebarStyle(style: YellowSidebarStyle) {
  setYellowSidebarStyle(style)
  open.value = false
  nextTick(() => triggerRef.value?.focus())
}

function handlePointerEnter(event: PointerEvent) {
  if (event.pointerType !== 'mouse') return
  open.value = true
  hoverOpened.value = true
}

function handlePointerLeave(event: PointerEvent) {
  if (event.pointerType !== 'mouse') return
  open.value = false
  hoverOpened.value = false
}

function toggleOnClick() {
  if (hoverOpened.value) {
    hoverOpened.value = false
    open.value = true
    return
  }
  open.value = !open.value
}

function closeAndFocus() {
  open.value = false
  hoverOpened.value = false
  triggerRef.value?.focus()
}

function handleClickOutside(event: MouseEvent) {
  if (!pickerRef.value?.contains(event.target as Node)) {
    open.value = false
    hoverOpened.value = false
  }
}

onMounted(() => document.addEventListener('click', handleClickOutside))
onBeforeUnmount(() => document.removeEventListener('click', handleClickOutside))
</script>
