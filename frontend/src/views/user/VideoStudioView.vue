<template>
  <AppLayout>
    <div class="mx-auto flex max-w-7xl flex-col gap-5">
      <header>
        <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">{{ t('videoStudio.title') }}</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-dark-300">{{ t('videoStudio.description') }}</p>
      </header>
      <StudioMediaPanel />
    </div>
  </AppLayout>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import StudioMediaPanel from '@/components/video/StudioMediaPanel.vue'

const { t } = useI18n()
</script>
