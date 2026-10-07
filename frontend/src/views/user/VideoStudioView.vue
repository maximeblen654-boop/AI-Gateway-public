<template>
  <AppLayout>
    <div class="mx-auto flex max-w-7xl flex-col gap-5 lg:h-[calc(100vh-9rem)] lg:min-h-[42rem]">
      <header class="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm dark:border-dark-700 dark:bg-dark-800 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <h1 class="text-2xl font-semibold text-slate-900 dark:text-white">{{ t('videoStudio.title') }}</h1>
          <p class="mt-1 text-sm text-slate-500 dark:text-dark-300">{{ t('videoStudio.description') }}</p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="inline-flex w-fit items-center rounded-full bg-teal-50 px-3 py-1 text-xs font-medium text-teal-700 dark:bg-teal-900/20 dark:text-teal-300">
            {{ t('videoStudio.grokOnly') }}
          </span>
          <button type="button" class="btn btn-secondary btn-sm" data-testid="face-tool-open" @click="showFaceTool = true">
            {{ t('videoStudio.face.open') }}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" data-testid="studio-media-open" @click="showStudioMedia = true">
            Studio 素材工作台
          </button>
        </div>
      </header>

      <StudioMediaPanel v-if="showStudioMedia" />

      <div v-if="pageError" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/20 dark:text-red-300" role="alert">
        {{ pageError }}
      </div>

      <div v-if="loadingKeys" class="flex min-h-32 items-center justify-center rounded-2xl border border-slate-200 bg-white py-8 shadow-sm dark:border-dark-700 dark:bg-dark-800">
        <LoadingSpinner size="md" />
        <span class="ml-3 text-sm text-slate-500 dark:text-dark-300">{{ t('videoStudio.loadingKeys') }}</span>
      </div>

      <div v-else-if="apiKeys.length === 0" class="rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center shadow-sm dark:border-dark-600 dark:bg-dark-800">
        <p class="text-sm font-medium text-slate-700 dark:text-gray-200">{{ t('videoStudio.noKeys') }}</p>
        <p class="mt-1 text-sm text-slate-500 dark:text-dark-300">{{ t('videoStudio.noKeysHint') }}</p>
      </div>

      <div v-else class="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <section data-testid="video-creative-panel" class="min-h-0 overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-dark-700 dark:bg-dark-800">
          <form class="space-y-6 p-5 sm:p-6" @submit.prevent="submitVideo">
            <div class="grid gap-5 md:grid-cols-2">
              <div>
                <label for="video-studio-key" class="input-label mb-1.5 block">{{ t('videoStudio.apiKey') }}</label>
                <select
                  id="video-studio-key"
                  v-model.number="selectedKeyId"
                  class="input w-full"
                  data-testid="video-key-select"
                  :disabled="submitting"
                >
                  <option v-for="key in apiKeys" :key="key.id" :value="key.id">
                    {{ key.name || `#${key.id}` }}
                  </option>
                </select>
                <p class="input-hint mt-1.5">{{ t('videoStudio.apiKeyHint') }}</p>
              </div>

              <div>
                <span class="input-label mb-1.5 block">{{ t('videoStudio.model') }}</span>
                <div class="grid gap-2 sm:grid-cols-2" role="radiogroup" :aria-label="t('videoStudio.model')">
                  <button
                    v-for="model in modelOptions"
                    :key="model"
                    type="button"
                    class="min-h-14 rounded-xl border px-3 py-2 text-left text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-teal-500"
                    :class="selectedModel === model ? 'border-teal-500 bg-teal-50 text-teal-800 shadow-sm dark:border-teal-400 dark:bg-teal-950/30 dark:text-teal-200' : 'border-slate-200 bg-white text-slate-700 hover:border-teal-300 dark:border-dark-600 dark:bg-dark-800 dark:text-gray-200'"
                    role="radio"
                    :aria-checked="selectedModel === model"
                    data-testid="video-model-card"
                    :data-model="model"
                    :disabled="submitting || modelsLoading"
                    @click="selectedModel = model"
                  >
                    <span class="break-all">{{ model }}</span>
                  </button>
                </div>
                <select
                  id="video-studio-model"
                  v-model="selectedModel"
                  class="sr-only"
                  data-testid="video-model-select"
                  :disabled="submitting || modelsLoading || modelOptions.length === 0"
                  :aria-label="t('videoStudio.model')"
                >
                  <option value="" disabled>{{ modelsLoading ? t('videoStudio.loadingModels') : t('videoStudio.selectModel') }}</option>
                  <option v-for="model in modelOptions" :key="model" :value="model">{{ model }}</option>
                </select>
                <p v-if="modelsError" class="input-error-text mt-1.5">{{ modelsError }}</p>
                <p v-else class="input-hint mt-1.5">{{ t('videoStudio.modelHint') }}</p>
                <p v-if="selectedModel" class="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600 dark:bg-dark-700/60 dark:text-dark-300">
                  {{ t('videoStudio.modelCapability') }}
                </p>
              </div>
            </div>

            <div class="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(16rem,0.7fr)]">
              <TextArea
                v-model="prompt"
                :label="t('videoStudio.prompt')"
                :placeholder="t('videoStudio.promptPlaceholder')"
                :rows="8"
                :disabled="submitting"
                :error="formError === 'prompt' ? t('videoStudio.promptRequired') : ''"
                data-testid="video-prompt"
              />
              <section class="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 dark:border-dark-600 dark:bg-dark-700/40" data-testid="video-reference-status">
                <h3 class="text-sm font-semibold text-slate-700 dark:text-gray-200">{{ t('videoStudio.references.title') }}</h3>
                <p class="mt-2 text-sm leading-6 text-slate-500 dark:text-dark-300">{{ t('videoStudio.references.pending') }}</p>
                <span class="mt-3 inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                  {{ t('videoStudio.references.notOpen') }}
                </span>
              </section>
            </div>

            <div class="grid gap-5 md:grid-cols-2">
              <div>
                <span class="input-label mb-1.5 block">{{ t('videoStudio.seconds') }}</span>
                <div class="grid grid-cols-4 gap-2" role="radiogroup" :aria-label="t('videoStudio.seconds')">
                  <button
                    v-for="option in durationOptions"
                    :key="option"
                    type="button"
                    class="rounded-xl border px-2 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-teal-500"
                    :class="seconds === option ? 'border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-400 dark:bg-teal-950/30 dark:text-teal-200' : 'border-slate-200 bg-white text-slate-700 hover:border-teal-300 dark:border-dark-600 dark:bg-dark-800 dark:text-gray-200'"
                    role="radio"
                    :aria-checked="seconds === option"
                    data-testid="video-duration-option"
                    :data-value="option"
                    :disabled="submitting"
                    @click="seconds = option"
                  >
                    {{ option }}s
                  </button>
                </div>
                <p class="input-hint mt-1.5">{{ t('videoStudio.secondsHint', durationBounds) }}</p>
              </div>

              <div>
                <span class="input-label mb-1.5 block">{{ t('videoStudio.resolution') }}</span>
                <div class="grid grid-cols-2 gap-2" role="radiogroup" :aria-label="t('videoStudio.resolution')">
                  <button
                    v-for="option in resolutionOptions"
                    :key="option"
                    type="button"
                    class="rounded-xl border px-3 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-teal-500"
                    :class="resolution === option ? 'border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-400 dark:bg-teal-950/30 dark:text-teal-200' : 'border-slate-200 bg-white text-slate-700 hover:border-teal-300 dark:border-dark-600 dark:bg-dark-800 dark:text-gray-200'"
                    role="radio"
                    :aria-checked="resolution === option"
                    data-testid="video-resolution-option"
                    :data-value="option"
                    :disabled="submitting"
                    @click="resolution = option"
                  >
                    {{ option }}
                  </button>
                </div>
                <p class="input-hint mt-1.5">{{ t('videoStudio.resolutionHint') }}</p>
              </div>
            </div>

            <div>
              <span class="input-label mb-1.5 block">{{ t('videoStudio.aspectRatio') }}</span>
              <div class="grid grid-cols-3 gap-2 sm:grid-cols-6" role="radiogroup" :aria-label="t('videoStudio.aspectRatio')">
                <button
                  v-for="option in aspectRatioOptions"
                  :key="option"
                  type="button"
                  class="rounded-xl border px-2 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-teal-500"
                  :class="aspectRatio === option ? 'border-teal-500 bg-teal-50 text-teal-800 dark:border-teal-400 dark:bg-teal-950/30 dark:text-teal-200' : 'border-slate-200 bg-white text-slate-700 hover:border-teal-300 dark:border-dark-600 dark:bg-dark-800 dark:text-gray-200'"
                  role="radio"
                  :aria-checked="aspectRatio === option"
                  data-testid="video-aspect-ratio-option"
                  :data-value="option"
                  :disabled="submitting"
                  @click="aspectRatio = option"
                >
                  {{ option }}
                </button>
              </div>
              <p class="input-hint mt-1.5">{{ t('videoStudio.aspectRatioHint') }}</p>
            </div>

            <p v-if="formError && formError !== 'prompt'" class="input-error-text" role="alert">{{ formError }}</p>
            <p v-if="submissionError" class="input-error-text" role="alert">{{ submissionError }}</p>
            <p v-if="draftRestored" class="rounded-xl border border-teal-100 bg-teal-50 px-3 py-2 text-xs text-teal-800 dark:border-teal-900/50 dark:bg-teal-950/20 dark:text-teal-200" data-testid="video-draft-status">
              {{ t('videoStudio.draftRestored') }}
            </p>

            <div class="grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-dark-700 dark:bg-dark-700/40 sm:grid-cols-[minmax(0,1fr)_7rem] sm:items-end">
              <div>
                <p class="text-sm font-medium text-slate-700 dark:text-gray-200">{{ t('videoStudio.summary.title') }}</p>
                <p class="mt-1 text-sm text-slate-500 dark:text-dark-300" data-testid="video-submit-summary">
                  {{ selectedModel || '—' }} · {{ seconds }}s · {{ resolution }} · {{ aspectRatio }} · {{ t('videoStudio.summary.jobs', { count: generateCount }) }}
                </p>
                <p class="mt-1 text-xs text-slate-500 dark:text-dark-400">{{ t('videoStudio.summary.billing') }}</p>
              </div>
              <label class="block">
                <span class="input-label mb-1.5 block">{{ t('videoStudio.generateCount') }}</span>
                <input v-model.number="generateCount" type="number" min="1" max="10" step="1" class="input w-full" data-testid="video-generate-count" :disabled="submitting">
              </label>
            </div>

            <div class="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5 dark:border-dark-700">
              <button
                type="submit"
                class="btn btn-primary"
                data-testid="video-submit"
                :disabled="submitting || modelsLoading || !selectedModel || !prompt.trim()"
              >
                <LoadingSpinner v-if="submitting" size="sm" color="white" class="mr-2" />
                {{ submitting ? t('videoStudio.submittingProgress', { done: submittingCount, total: generateCount }) : t('videoStudio.submit') }}
              </button>
              <span v-if="modelsLoading" class="text-sm text-slate-500 dark:text-dark-300">{{ t('videoStudio.loadingModels') }}</span>
            </div>
          </form>
        </section>

        <section data-testid="video-recent-panel" class="min-h-0 overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-dark-700 dark:bg-dark-800">
          <div class="sticky top-0 z-10 border-b border-slate-100 bg-white/95 px-5 py-4 backdrop-blur dark:border-dark-700 dark:bg-dark-800/95 sm:px-6">
            <div class="flex items-start justify-between gap-3">
              <div>
                <h2 class="text-lg font-semibold text-slate-900 dark:text-white">{{ t('videoStudio.recent.title') }}</h2>
                <p class="mt-1 text-sm text-slate-500 dark:text-dark-300">{{ t('videoStudio.recent.description') }}</p>
              </div>
              <span class="text-xs text-slate-400 dark:text-dark-400">{{ tasks.length }}/{{ maxRecentTasks }}</span>
            </div>
            <div class="mt-4 flex flex-wrap gap-2">
              <button type="button" class="btn btn-secondary btn-sm" data-testid="video-refresh-all" :disabled="refreshingTasks || refreshableTaskCount === 0" @click="refreshPendingTasks">
                <LoadingSpinner v-if="refreshingTasks" size="sm" class="mr-1.5" />
                {{ t('videoStudio.recent.refresh') }}
              </button>
              <button type="button" class="btn btn-secondary btn-sm" data-testid="video-clear-failed" :disabled="failedTaskCount === 0" @click="clearFailedTasks">
                {{ t('videoStudio.recent.clearFailed') }}
              </button>
            </div>
            <p class="mt-2 text-xs text-slate-500 dark:text-dark-400">{{ t('videoStudio.recent.localActionsHint') }}</p>
          </div>

          <div v-if="tasks.length === 0" class="flex min-h-80 flex-col items-center justify-center px-5 py-10 text-center">
            <div class="text-4xl text-slate-300 dark:text-dark-500" aria-hidden="true">▹</div>
            <p class="mt-3 text-sm text-slate-500 dark:text-dark-300">{{ t('videoStudio.recent.empty') }}</p>
          </div>

          <div v-else class="space-y-3 p-4 sm:p-5">
            <article
              v-for="task in tasks"
              :key="task.id"
              class="rounded-xl border border-slate-200 p-4 dark:border-dark-700"
              data-testid="video-task"
            >
              <div class="flex flex-col gap-3">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="rounded-full px-2.5 py-1 text-xs font-medium" :class="statusClass(task.status)">
                      {{ statusLabel(task.status) }}
                    </span>
                    <span class="max-w-full truncate text-sm font-medium text-slate-700 dark:text-gray-200">{{ task.model }}</span>
                    <span class="text-xs text-slate-400 dark:text-dark-400">{{ formatDate(task.createdAt) }}</span>
                  </div>
                  <p class="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-gray-300">{{ task.prompt }}</p>
                  <p class="mt-2 text-xs text-slate-500 dark:text-dark-400">
                    {{ task.seconds }}s · {{ task.resolution }} · {{ task.aspectRatio || '—' }} · {{ t('videoStudio.taskId') }} {{ task.id }}
                  </p>
                  <p v-if="task.error" class="mt-2 text-sm text-red-600 dark:text-red-300">{{ task.error }}</p>
                  <p v-if="task.queryError" class="mt-2 text-sm text-amber-700 dark:text-amber-300" role="alert">{{ task.queryError }}</p>
                  <div v-if="previewTaskId === task.id && previewUrl" class="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-black dark:border-dark-600">
                    <video
                      :src="previewUrl"
                      controls
                      preload="metadata"
                      class="max-h-64 w-full"
                      data-testid="video-preview-player"
                    />
                  </div>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    data-testid="video-use-prompt"
                    :disabled="submitting"
                    @click="reusePrompt(task)"
                  >
                    {{ t('videoStudio.usePrompt') }}
                  </button>
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm"
                    data-testid="video-copy-prompt"
                    @click="copyPrompt(task)"
                  >
                    {{ t('videoStudio.copyPrompt') }}
                  </button>
                  <button
                    v-if="task.queryError"
                    type="button"
                    class="btn btn-secondary btn-sm"
                    :disabled="isPolling(task.id)"
                    data-testid="video-retry"
                    @click="retryStatus(task.id)"
                  >
                    {{ t('videoStudio.retryStatus') }}
                  </button>
                  <button
                    v-if="task.status === 'completed'"
                    type="button"
                    class="btn btn-secondary btn-sm"
                    :disabled="previewLoadingIds.has(task.id)"
                    data-testid="video-preview"
                    @click="previewTask(task.id)"
                  >
                    <LoadingSpinner v-if="previewLoadingIds.has(task.id)" size="sm" class="mr-1.5" />
                    {{ previewTaskId === task.id && previewUrl ? t('videoStudio.closePreview') : t('videoStudio.preview') }}
                  </button>
                  <button
                    v-if="task.status === 'completed'"
                    type="button"
                    class="btn btn-secondary btn-sm"
                    :disabled="downloadingIds.has(task.id)"
                    data-testid="video-download"
                    @click="downloadTask(task.id)"
                  >
                    <LoadingSpinner v-if="downloadingIds.has(task.id)" size="sm" class="mr-1.5" />
                    {{ t('videoStudio.download') }}
                  </button>
                </div>
              </div>
            </article>
          </div>
        </section>
      </div>
    </div>
    <FacePrivacyTool :open="showFaceTool" @close="showFaceTool = false" />
  </AppLayout>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppLayout from '@/components/layout/AppLayout.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import TextArea from '@/components/common/TextArea.vue'
import FacePrivacyTool from '@/components/video/FacePrivacyTool.vue'
import { keysAPI } from '@/api/keys'
import { fetchGatewayModels } from '@/api/models'
import { createVideo, getVideo, getVideoContent, type VideoJob, type VideoStatus } from '@/api/video'
import type { ApiKey } from '@/types'
import { useClipboard } from '@/composables/useClipboard'
import StudioMediaPanel from '@/components/video/StudioMediaPanel.vue'

const { t, locale } = useI18n()
const { copyToClipboard } = useClipboard()

const STORAGE_KEY = 'video_studio_recent_tasks'
const DRAFT_STORAGE_KEY = 'video_studio_draft'
const SELECTED_KEY_STORAGE = 'video_studio_selected_key_id'
const PENDING_SUBMISSION_STORAGE = 'video_studio_pending_submission'
const POLL_INTERVAL_MS = 2500
const maxRecentTasks = 20
const durationOptions = Array.from({ length: 12 }, (_, index) => index + 4)
const resolutionOptions = ['480p', '720p']
const aspectRatioOptions = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9']
const allowedVideoModels = new Set(['jimeng-2.0-s', 'jimeng-2.5-s'])
const storedStatuses = new Set(['queued', 'in_progress', 'processing', 'completed', 'failed', 'expired'])

interface VideoTask {
  id: string
  keyId: number
  model: string
  prompt: string
  seconds: number
  resolution: string
  aspectRatio: string
  status: VideoStatus
  createdAt: number
  error?: string
  queryError?: string
}

const apiKeys = ref<ApiKey[]>([])
const selectedKeyId = ref<number | null>(null)
const models = ref<string[]>([])
const selectedModel = ref('')
const prompt = ref('')
const seconds = ref(5)
const resolution = ref('720p')
const aspectRatio = ref('16:9')
const generateCount = ref(1)
const tasks = ref<VideoTask[]>([])
const loadingKeys = ref(false)
const modelsLoading = ref(false)
const modelsError = ref('')
const pageError = ref('')
const formError = ref('')
const submissionError = ref('')
const submitting = ref(false)
const submittingCount = ref(0)
const draftRestored = ref(false)
const draftHydrated = ref(false)
const draftModel = ref('')
const refreshingTasks = ref(false)
const showFaceTool = ref(false)
const downloadingIds = ref(new Set<string>())
const previewLoadingIds = ref(new Set<string>())
const previewTaskId = ref<string | null>(null)
const previewUrl = ref<string | null>(null)
const showStudioMedia = ref(false)
let modelController: AbortController | null = null
let modelRequestId = 0
let previewRequestId = 0
let pendingSubmission: { fingerprint: string; idempotencyKey: string } | null = null
let isUnmounted = false
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pollInFlight = new Set<string>()

const modelOptions = computed(() => models.value)
const selectedKey = computed(() => apiKeys.value.find((key) => key.id === selectedKeyId.value) || null)
// ponytail: cap every model at 15 until shared billing normalization safely prices 16–30.
const durationBounds = computed(() => ({ min: 4, max: 15 }))
const failedTaskCount = computed(() => tasks.value.filter((task) => ['failed', 'expired'].includes(String(task.status).toLowerCase())).length)
const refreshableTaskCount = computed(() => tasks.value.filter((task) => !isTerminalStatus(task.status) || Boolean(task.queryError)).length)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTerminalStatus(status: VideoStatus): boolean {
  return ['completed', 'failed', 'expired'].includes(String(status).toLowerCase())
}

function normalizeStatus(status: unknown): VideoStatus {
  return typeof status === 'string' && status.trim() ? status.trim().toLowerCase() : 'queued'
}

function statusLabel(status: VideoStatus): string {
  const key = String(status).toLowerCase()
  const known: Record<string, string> = {
    queued: 'videoStudio.status.queued',
    in_progress: 'videoStudio.status.inProgress',
    processing: 'videoStudio.status.processing',
    completed: 'videoStudio.status.completed',
    failed: 'videoStudio.status.failed',
    expired: 'videoStudio.status.expired',
  }
  return t(known[key] || 'videoStudio.status.unknown')
}

function statusClass(status: VideoStatus): string {
  switch (String(status).toLowerCase()) {
    case 'completed':
      return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
    case 'failed':
    case 'expired':
      return 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
    default:
      return 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
  }
}

function formatDate(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
  } catch {
    return new Date(timestamp).toLocaleString()
  }
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) return error.message
  return fallback
}

function extractJobError(job: VideoJob): string | undefined {
  if (typeof job.error === 'string' && job.error.trim()) return job.error.trim()
  if (isRecord(job.error) && typeof job.error.message === 'string' && job.error.message.trim()) return job.error.message.trim()
  return undefined
}

function readStoredTasks() {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return
    tasks.value = parsed
      .slice(0, maxRecentTasks)
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item): VideoTask | null => {
        const id = typeof item.id === 'string' ? item.id.trim() : ''
        const keyId = typeof item.keyId === 'number' ? item.keyId : Number(item.keyId)
        const model = typeof item.model === 'string' ? item.model : ''
        const taskPrompt = typeof item.prompt === 'string' ? item.prompt : ''
        const taskSeconds = Number(item.seconds)
        const taskResolution = typeof item.resolution === 'string' ? item.resolution : ''
        const taskAspectRatio = typeof item.aspectRatio === 'string' && aspectRatioOptions.includes(item.aspectRatio) ? item.aspectRatio : ''
        const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : ''
        const createdAt = Number(item.createdAt)
        if (
          !id || id.length > 512 ||
          !Number.isSafeInteger(keyId) || keyId <= 0 ||
          !model || model.length > 200 ||
          !taskPrompt || taskPrompt.length > 20_000 ||
          !Number.isSafeInteger(taskSeconds) || taskSeconds < 1 || taskSeconds > 60 ||
          !['480p', '720p', '1080p'].includes(taskResolution) ||
          !storedStatuses.has(String(status)) ||
          !Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > Date.now() + 86_400_000
        ) return null
        return {
          id,
          keyId,
          model,
          prompt: taskPrompt,
          seconds: taskSeconds,
          resolution: taskResolution,
          aspectRatio: taskAspectRatio,
          status,
          createdAt,
          error: typeof item.error === 'string' && item.error.length <= 2000 ? item.error : undefined,
        }
      })
      .filter((task): task is VideoTask => task !== null)
  } catch {
    tasks.value = []
  }
}

function persistTasks() {
  if (typeof window === 'undefined') return
  try {
    const stored = tasks.value.map(({ queryError: _queryError, ...task }) => task)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    // localStorage may be unavailable in private browsing; the page still works in memory.
  }
}

function readDraft() {
  draftHydrated.value = false
  if (typeof window === 'undefined') {
    draftHydrated.value = true
    return
  }
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY)
    if (!raw) return
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return
    if (typeof parsed.prompt === 'string' && parsed.prompt.length <= 20_000) prompt.value = parsed.prompt
    if (typeof parsed.model === 'string' && parsed.model.length <= 200) draftModel.value = parsed.model
    const storedSeconds = Number(parsed.seconds)
    if (Number.isSafeInteger(storedSeconds) && durationOptions.includes(storedSeconds)) seconds.value = storedSeconds
    if (parsed.resolution === '480p' || parsed.resolution === '720p') resolution.value = parsed.resolution
    if (typeof parsed.aspectRatio === 'string' && aspectRatioOptions.includes(parsed.aspectRatio)) aspectRatio.value = parsed.aspectRatio
    const storedCount = Number(parsed.generateCount)
    if (Number.isSafeInteger(storedCount) && storedCount >= 1 && storedCount <= 10) generateCount.value = storedCount
    draftRestored.value = true
  } catch {
    // Corrupted browser drafts are ignored; the form remains usable.
  } finally {
    draftHydrated.value = true
  }
}

function persistDraft() {
  if (!draftHydrated.value || typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
      prompt: prompt.value.slice(0, 20_000),
      model: (selectedModel.value || draftModel.value).slice(0, 200),
      seconds: durationOptions.includes(seconds.value) ? seconds.value : 5,
      resolution: resolution.value === '480p' ? '480p' : '720p',
      aspectRatio: aspectRatioOptions.includes(aspectRatio.value) ? aspectRatio.value : '16:9',
      generateCount: Number.isSafeInteger(generateCount.value) && generateCount.value >= 1 && generateCount.value <= 10 ? generateCount.value : 1,
    }))
  } catch {
    // localStorage is optional; the form still works in memory.
  }
}

function findTask(taskId: string): VideoTask | undefined {
  return tasks.value.find((task) => task.id === taskId)
}

function keyForTask(task: VideoTask): ApiKey | undefined {
  return apiKeys.value.find((key) => key.id === task.keyId)
}

function clearPollTimer(taskId: string) {
  const timer = pollTimers.get(taskId)
  if (timer) {
    clearTimeout(timer)
    pollTimers.delete(taskId)
  }
}

function schedulePoll(taskId: string, delay = POLL_INTERVAL_MS) {
  if (isUnmounted || pollTimers.has(taskId) || pollInFlight.has(taskId)) return
  const task = findTask(taskId)
  if (!task || isTerminalStatus(task.status)) return
  const timer = setTimeout(() => {
    pollTimers.delete(taskId)
    void pollTask(taskId)
  }, delay)
  pollTimers.set(taskId, timer)
}

function isPolling(taskId: string): boolean {
  return pollInFlight.has(taskId) || pollTimers.has(taskId)
}

async function pollTask(taskId: string) {
  clearPollTimer(taskId)
  if (isUnmounted || pollInFlight.has(taskId)) return
  const task = findTask(taskId)
  if (!task || (isTerminalStatus(task.status) && !task.queryError)) return
  const key = keyForTask(task)
  if (!key) {
    task.queryError = t('videoStudio.keyUnavailable')
    persistTasks()
    return
  }

  pollInFlight.add(taskId)
  let shouldContinue = false
  try {
    const job = await getVideo(key.key, taskId)
    if (isUnmounted) return
    task.status = normalizeStatus(job.status)
    task.error = extractJobError(job)
    task.queryError = undefined
    persistTasks()
    shouldContinue = !isTerminalStatus(task.status)
  } catch (error) {
    if (!isUnmounted) {
      task.queryError = errorMessage(error, t('videoStudio.statusQueryFailed'))
      persistTasks()
    }
  } finally {
    pollInFlight.delete(taskId)
    if (shouldContinue) schedulePoll(taskId)
  }
}

function retryStatus(taskId: string) {
  const task = findTask(taskId)
  if (!task) return
  void pollTask(taskId)
}

async function refreshPendingTasks() {
  if (refreshingTasks.value) return
  const refreshable = tasks.value.filter((task) => !isTerminalStatus(task.status) || Boolean(task.queryError))
  if (refreshable.length === 0) return
  refreshingTasks.value = true
  try {
    await Promise.all(refreshable.map((task) => pollTask(task.id)))
  } finally {
    refreshingTasks.value = false
  }
}

function clearFailedTasks() {
  const failedIds = new Set(tasks.value.filter((task) => ['failed', 'expired'].includes(String(task.status).toLowerCase())).map((task) => task.id))
  if (failedIds.size === 0) return
  if (previewTaskId.value && failedIds.has(previewTaskId.value)) clearPreview()
  tasks.value = tasks.value.filter((task) => !failedIds.has(task.id))
  persistTasks()
}

function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `video-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function idempotencyKeyFor(fingerprint: string): string {
  if (pendingSubmission?.fingerprint === fingerprint) return pendingSubmission.idempotencyKey
  try {
    const raw = window.sessionStorage.getItem(PENDING_SUBMISSION_STORAGE)
    if (raw) {
      const stored = JSON.parse(raw) as unknown
      if (
        isRecord(stored) &&
        stored.fingerprint === fingerprint &&
        typeof stored.idempotencyKey === 'string' &&
        stored.idempotencyKey.length >= 8 &&
        stored.idempotencyKey.length <= 200
      ) {
        pendingSubmission = { fingerprint, idempotencyKey: stored.idempotencyKey }
        return stored.idempotencyKey
      }
    }
  } catch {
    // sessionStorage may be unavailable; in-memory submission still remains guarded.
  }

  const idempotencyKey = makeIdempotencyKey()
  pendingSubmission = { fingerprint, idempotencyKey }
  try {
    window.sessionStorage.setItem(PENDING_SUBMISSION_STORAGE, JSON.stringify({ fingerprint, idempotencyKey }))
  } catch {
    // Best effort only; the key is still reused by the current POST attempt.
  }
  return idempotencyKey
}

function clearPendingSubmission(idempotencyKey: string) {
  if (pendingSubmission?.idempotencyKey === idempotencyKey) pendingSubmission = null
  try {
    const raw = window.sessionStorage.getItem(PENDING_SUBMISSION_STORAGE)
    if (!raw) return
    const stored = JSON.parse(raw) as unknown
    if (isRecord(stored) && stored.idempotencyKey === idempotencyKey) {
      window.sessionStorage.removeItem(PENDING_SUBMISSION_STORAGE)
    }
  } catch {
    // Ignore unavailable or corrupted browser storage.
  }
}

function reusePrompt(task: VideoTask) {
  prompt.value = task.prompt
  formError.value = ''
  draftRestored.value = true
}

function copyPrompt(task: VideoTask) {
  void copyToClipboard(task.prompt, t('videoStudio.promptCopied'))
}

async function submitVideo() {
  if (submitting.value) return
  formError.value = ''
  submissionError.value = ''
  const key = selectedKey.value
  const trimmedPrompt = prompt.value.trim()
  if (!trimmedPrompt) {
    formError.value = 'prompt'
    return
  }
  if (!key) {
    formError.value = t('videoStudio.selectApiKey')
    return
  }
  if (!selectedModel.value) {
    formError.value = t('videoStudio.selectModel')
    return
  }
  if (!Number.isInteger(seconds.value) || seconds.value < durationBounds.value.min || seconds.value > durationBounds.value.max) {
    formError.value = t('videoStudio.secondsInvalid', durationBounds.value)
    return
  }
  if (!aspectRatioOptions.includes(aspectRatio.value)) {
    formError.value = t('videoStudio.aspectRatioInvalid')
    return
  }
  if (!Number.isSafeInteger(generateCount.value) || generateCount.value < 1 || generateCount.value > 10) {
    formError.value = t('videoStudio.generateCountInvalid')
    return
  }

  submitting.value = true
  submittingCount.value = 0
  const payload = {
    prompt: trimmedPrompt,
    model: selectedModel.value,
    seconds: seconds.value,
    resolution: resolution.value,
    aspect_ratio: aspectRatio.value,
  }
  const total = generateCount.value
  const fingerprint = JSON.stringify({ keyId: key.id, ...payload })
  const errors: string[] = []
  let created = 0
  for (let index = 0; index < total; index += 1) {
    const idempotencyKey = idempotencyKeyFor(fingerprint)
    try {
      const job = await createVideo(key.key, payload, idempotencyKey)
      clearPendingSubmission(idempotencyKey)
      const task: VideoTask = {
        id: job.id,
        keyId: key.id,
        model: selectedModel.value,
        prompt: trimmedPrompt,
        seconds: seconds.value,
        resolution: resolution.value,
        aspectRatio: aspectRatio.value,
        status: normalizeStatus(job.status),
        createdAt: Date.now(),
        error: extractJobError(job),
      }
      tasks.value = [task, ...tasks.value.filter((item) => item.id !== task.id)].slice(0, maxRecentTasks)
      persistTasks()
      if (!isTerminalStatus(task.status)) schedulePoll(task.id, 0)
      created += 1
    } catch (error) {
      errors.push(errorMessage(error, t('videoStudio.submitFailed')))
      break
    } finally {
      submittingCount.value = index + 1
    }
  }
  if (errors.length === 0) {
    prompt.value = ''
    draftRestored.value = false
  } else {
    generateCount.value = total - created
    submissionError.value = `${t('videoStudio.batchPartial', { created, failed: errors.length, total })} ${errors[0]}`
  }
  submitting.value = false
}

function saveBlob(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}

function clearPreview() {
  previewRequestId += 1
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = null
  previewTaskId.value = null
}

async function previewTask(taskId: string) {
  const task = findTask(taskId)
  if (!task || task.status !== 'completed') return
  if (previewTaskId.value === taskId && previewUrl.value) {
    clearPreview()
    return
  }
  const key = keyForTask(task)
  if (!key) {
    task.queryError = t('videoStudio.keyUnavailable')
    persistTasks()
    return
  }

  clearPreview()
  const requestId = previewRequestId
  const next = new Set(previewLoadingIds.value)
  next.add(taskId)
  previewLoadingIds.value = next
  try {
    const blob = await getVideoContent(key.key, task.id)
    if (isUnmounted || requestId !== previewRequestId) return
    previewTaskId.value = taskId
    previewUrl.value = URL.createObjectURL(blob)
  } catch (error) {
    if (!isUnmounted) {
      task.queryError = errorMessage(error, t('videoStudio.previewFailed'))
      persistTasks()
    }
  } finally {
    const remaining = new Set(previewLoadingIds.value)
    remaining.delete(taskId)
    previewLoadingIds.value = remaining
  }
}

async function downloadTask(taskId: string) {
  const task = findTask(taskId)
  if (!task || task.status !== 'completed' || downloadingIds.value.has(taskId)) return
  const key = keyForTask(task)
  if (!key) {
    task.queryError = t('videoStudio.keyUnavailable')
    persistTasks()
    return
  }
  const next = new Set(downloadingIds.value)
  next.add(taskId)
  downloadingIds.value = next
  try {
    const blob = await getVideoContent(key.key, task.id)
    saveBlob(blob, `video-${task.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.mp4`)
  } catch (error) {
    task.queryError = errorMessage(error, t('videoStudio.downloadFailed'))
    persistTasks()
  } finally {
    const remaining = new Set(downloadingIds.value)
    remaining.delete(taskId)
    downloadingIds.value = remaining
  }
}

async function loadModelsForSelectedKey() {
  modelController?.abort()
  const requestId = ++modelRequestId
  models.value = []
  selectedModel.value = ''
  modelsError.value = ''
  const key = selectedKey.value
  if (!key) {
    modelsLoading.value = false
    return
  }
  const controller = new AbortController()
  modelController = controller
  modelsLoading.value = true
  try {
    const available = await fetchGatewayModels(window.location.origin, key.key, controller.signal)
    if (requestId !== modelRequestId || controller.signal.aborted) return
    models.value = available.filter((model) => allowedVideoModels.has(model))
    const preferred = draftModel.value && models.value.includes(draftModel.value)
      ? draftModel.value
      : tasks.value.find((task) => task.keyId === key.id)?.model
    selectedModel.value = preferred && models.value.includes(preferred) ? preferred : models.value[0] || ''
    if (models.value.length === 0) modelsError.value = t('videoStudio.noModels')
  } catch (error) {
    if (requestId === modelRequestId && !controller.signal.aborted) {
      modelsError.value = errorMessage(error, t('videoStudio.modelsFailed'))
    }
  } finally {
    if (requestId === modelRequestId) modelsLoading.value = false
  }
}

async function loadKeys() {
  loadingKeys.value = true
  pageError.value = ''
  try {
    const response = await keysAPI.list(1, 100, {
      status: 'active',
      sort_by: 'created_at',
      sort_order: 'desc',
    })
    apiKeys.value = response.items.filter((key) => key.status === 'active' && key.group?.platform === 'grok')
    let storedKeyId = 0
    try {
      storedKeyId = Number(window.localStorage.getItem(SELECTED_KEY_STORAGE))
    } catch {
      // Storage is optional; fall back to the newest usable key.
    }
    const taskKeyId = tasks.value.find((task) => apiKeys.value.some((key) => key.id === task.keyId))?.keyId
    if (apiKeys.value.some((key) => key.id === storedKeyId)) selectedKeyId.value = storedKeyId
    else selectedKeyId.value = taskKeyId ?? apiKeys.value[0]?.id ?? null
    for (const task of tasks.value) {
      if (!isTerminalStatus(task.status)) schedulePoll(task.id, 0)
    }
  } catch (error) {
    pageError.value = errorMessage(error, t('videoStudio.keysFailed'))
  } finally {
    loadingKeys.value = false
  }
}

watch(selectedKeyId, (keyId) => {
  if (typeof window !== 'undefined' && keyId !== null) {
    try {
      window.localStorage.setItem(SELECTED_KEY_STORAGE, String(keyId))
    } catch {
      // Storage is optional; model loading must still continue.
    }
  }
  void loadModelsForSelectedKey()
})

watch([prompt, selectedModel, seconds, resolution, aspectRatio, generateCount], () => {
  if (selectedModel.value) draftModel.value = selectedModel.value
  persistDraft()
})

onMounted(() => {
  readDraft()
  readStoredTasks()
  void loadKeys()
})

onBeforeUnmount(() => {
  isUnmounted = true
  modelController?.abort()
  clearPreview()
  for (const taskId of pollTimers.keys()) clearPollTimer(taskId)
})
</script>

