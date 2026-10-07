import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  listKeys: vi.fn(),
  fetchModels: vi.fn(),
  createVideo: vi.fn(),
  getVideo: vi.fn(),
  getVideoContent: vi.fn(),
}))

vi.mock('@/api/keys', () => ({
  keysAPI: { list: mocks.listKeys },
}))

vi.mock('@/api/models', () => ({
  fetchGatewayModels: mocks.fetchModels,
}))

vi.mock('@/api/video', () => ({
  createVideo: mocks.createVideo,
  getVideo: mocks.getVideo,
  getVideoContent: mocks.getVideoContent,
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string) => key,
      locale: { value: 'en' },
    }),
  }
})

vi.mock('@/components/video/FacePrivacyTool.vue', () => ({
  default: { template: '<div />' },
}))

import VideoStudioView from '../VideoStudioView.vue'

const grokKey = {
  id: 11,
  key: 'sk-secret-value',
  name: 'Video key',
  status: 'active',
  group: { platform: 'grok' },
} as any

const openAIKey = {
  id: 12,
  key: 'sk-other-value',
  name: 'Other key',
  status: 'active',
  group: { platform: 'openai' },
} as any

function mountView() {
  return mount(VideoStudioView, {
    global: {
      stubs: {
        AppLayout: { template: '<main><slot /></main>' },
        LoadingSpinner: { template: '<span />' },
      },
    },
  })
}

describe('VideoStudioView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    window.localStorage.clear()
    window.sessionStorage.clear()
    mocks.listKeys.mockResolvedValue({ items: [grokKey, openAIKey] })
    mocks.fetchModels.mockResolvedValue(['gpt-5.6-sol', 'jimeng-2.5-s'])
    mocks.createVideo.mockResolvedValue({ id: 'task-1', status: 'completed' })
    mocks.getVideoContent.mockResolvedValue(new Blob(['video'], { type: 'video/mp4' }))
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:video-preview') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  afterEach(() => vi.useRealTimers())

  it('filters keys by active Grok group and submits only once', async () => {
    const wrapper = mountView()
    await flushPromises()

    const keyOptions = wrapper.find('[data-testid="video-key-select"]').findAll('option')
    expect(keyOptions).toHaveLength(1)
    expect(keyOptions[0].text()).toContain('Video key')
    expect(wrapper.find('[data-testid="video-model-select"]').findAll('option').map((option) => option.text())).toContain('jimeng-2.5-s')
    expect(wrapper.find('[data-testid="video-model-select"]').findAll('option').map((option) => option.text())).not.toContain('gpt-5.6-sol')
    expect(wrapper.findAll('[data-testid="video-model-card"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="video-duration-option"]')).toHaveLength(12)
    expect(wrapper.find('[data-testid="video-duration-option"]').attributes('data-value')).toBe('4')
    expect(wrapper.find('[data-testid="video-duration-option"][data-value="15"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="video-duration-option"][data-value="16"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="video-resolution-option"]').map((option) => option.attributes('data-value'))).toEqual(['480p', '720p'])
    expect(wrapper.findAll('[data-testid="video-aspect-ratio-option"]').map((option) => option.attributes('data-value'))).toEqual(['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'])
    expect(wrapper.find('[data-testid="video-reference-status"]').exists()).toBe(true)

    await wrapper.find('[data-testid="video-prompt"] textarea').setValue('A red ball bounces once.')
    await wrapper.find('form').trigger('submit')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(mocks.createVideo).toHaveBeenCalledTimes(1)
    expect(mocks.createVideo).toHaveBeenCalledWith('sk-secret-value', expect.objectContaining({
      prompt: 'A red ball bounces once.',
      model: 'jimeng-2.5-s',
      seconds: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
    }), expect.any(String))
    expect(window.localStorage.getItem('video_studio_recent_tasks')).not.toContain('sk-secret-value')
    expect(wrapper.find('[data-testid="video-task"]').exists()).toBe(true)

    await wrapper.find('[data-testid="video-use-prompt"]').trigger('click')
    expect(wrapper.find('[data-testid="video-prompt"] textarea').element).toHaveProperty('value', 'A red ball bounces once.')
    expect(mocks.createVideo).toHaveBeenCalledTimes(1)

    await wrapper.find('[data-testid="video-copy-prompt"]').trigger('click')
    await flushPromises()
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('A red ball bounces once.')

    await wrapper.find('[data-testid="video-preview"]').trigger('click')
    await flushPromises()
    expect(mocks.getVideoContent).toHaveBeenCalledWith('sk-secret-value', 'task-1')
    expect(wrapper.find('[data-testid="video-preview-player"]').attributes('src')).toBe('blob:video-preview')
    expect(window.localStorage.getItem('video_studio_recent_tasks')).not.toContain('blob:video-preview')

    await wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:video-preview')
  })

  it('does not replace the draft from history while a submission is pending', async () => {
    let resolveSubmission!: (value: { id: string; status: string }) => void
    mocks.createVideo.mockImplementationOnce(() => new Promise((resolve) => { resolveSubmission = resolve }))
    window.localStorage.setItem('video_studio_recent_tasks', JSON.stringify([{
      id: 'history-task', keyId: 11, model: 'jimeng-2.5-s', prompt: 'Historical prompt.',
      seconds: 5, resolution: '720p', aspectRatio: '16:9', status: 'completed', createdAt: Date.now(),
    }]))
    const wrapper = mountView()
    await flushPromises()
    await wrapper.find('[data-testid="video-prompt"] textarea').setValue('Submitting prompt.')
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    const reuse = wrapper.find('[data-testid="video-use-prompt"]')
    expect(reuse.attributes('disabled')).toBeDefined()
    await reuse.trigger('click')
    expect(wrapper.find('[data-testid="video-prompt"] textarea').element).toHaveProperty('value', 'Submitting prompt.')

    resolveSubmission({ id: 'new-task', status: 'completed' })
    await flushPromises()
  })

  it('keeps polling after an in-progress response and stops on completion', async () => {
    vi.useFakeTimers()
    mocks.createVideo.mockResolvedValue({ id: 'task-poll', status: 'queued' })
    mocks.getVideo
      .mockResolvedValueOnce({ id: 'task-poll', status: 'in_progress' })
      .mockResolvedValueOnce({ id: 'task-poll', status: 'completed' })
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('[data-testid="video-prompt"] textarea').setValue('Keep polling this task.')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(mocks.getVideo).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2500)
    await flushPromises()
    expect(mocks.getVideo).toHaveBeenCalledTimes(2)

    await wrapper.unmount()
  })

  it('reuses the idempotency key after an ambiguous submit failure', async () => {
    mocks.createVideo
      .mockRejectedValueOnce(new Error('network interrupted'))
      .mockResolvedValueOnce({ id: 'task-retry', status: 'completed' })
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('[data-testid="video-prompt"] textarea').setValue('Retry the same request safely.')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(mocks.createVideo).toHaveBeenCalledTimes(2)
    expect(mocks.createVideo.mock.calls[1][2]).toBe(mocks.createVideo.mock.calls[0][2])
    expect(window.sessionStorage.getItem('video_studio_pending_submission')).toBeNull()

    await wrapper.unmount()
  })

  it('restores the draft without submitting it', async () => {
    const first = mountView()
    await flushPromises()
    await first.find('[data-testid="video-prompt"] textarea').setValue('Keep this as a local draft.')
    await first.find('[data-testid="video-duration-option"][data-value="7"]').trigger('click')
    await first.find('[data-testid="video-resolution-option"][data-value="480p"]').trigger('click')
    await first.find('[data-testid="video-aspect-ratio-option"][data-value="9:16"]').trigger('click')
    await first.find('[data-testid="video-generate-count"]').setValue(3)
    await first.find('[data-testid="video-model-card"]').trigger('click')
    await first.vm.$nextTick()
    await first.unmount()

    mocks.createVideo.mockClear()
    const restored = mountView()
    await flushPromises()
    expect(restored.find('[data-testid="video-prompt"] textarea').element).toHaveProperty('value', 'Keep this as a local draft.')
    expect(restored.find('[data-testid="video-duration-option"][data-value="7"]').attributes('aria-checked')).toBe('true')
    expect(restored.find('[data-testid="video-resolution-option"][data-value="480p"]').attributes('aria-checked')).toBe('true')
    expect(restored.find('[data-testid="video-aspect-ratio-option"][data-value="9:16"]').attributes('aria-checked')).toBe('true')
    expect(restored.find('[data-testid="video-generate-count"]').element).toHaveProperty('value', '3')
    expect(restored.find('[data-testid="video-draft-status"]').exists()).toBe(true)
    expect(mocks.createVideo).not.toHaveBeenCalled()
    await restored.unmount()
  })

  it('does not invent an aspect ratio for legacy task history', async () => {
    window.localStorage.setItem('video_studio_recent_tasks', JSON.stringify([{
      id: 'legacy-task',
      keyId: 11,
      model: 'jimeng-2.5-s',
      prompt: 'Legacy task without ratio.',
      seconds: 5,
      resolution: '720p',
      status: 'completed',
      createdAt: Date.now(),
    }]))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-testid="video-task"]').text()).toContain('720p · — ·')
    await wrapper.unmount()
  })

  it('stops a partial batch and safely resumes with the failed idempotency key', async () => {
    mocks.createVideo
      .mockResolvedValueOnce({ id: 'batch-1', status: 'completed' })
      .mockRejectedValueOnce(new Error('provider rejected one job'))
      .mockResolvedValueOnce({ id: 'batch-2', status: 'completed' })
      .mockResolvedValueOnce({ id: 'batch-3', status: 'queued' })
    const wrapper = mountView()
    await flushPromises()

    await wrapper.find('[data-testid="video-prompt"] textarea').setValue('Create three independent clips.')
    await wrapper.find('[data-testid="video-aspect-ratio-option"][data-value="9:16"]').trigger('click')
    await wrapper.find('[data-testid="video-generate-count"]').setValue(3)
    await wrapper.find('form').trigger('submit')
    await flushPromises()

    expect(mocks.createVideo).toHaveBeenCalledTimes(2)
    expect(mocks.createVideo.mock.calls[0][2]).not.toBe(mocks.createVideo.mock.calls[1][2])
    expect(mocks.createVideo.mock.calls[0][1]).toMatchObject({ aspect_ratio: '9:16' })
    expect(wrapper.findAll('[data-testid="video-task"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('videoStudio.batchPartial')
    expect(window.localStorage.getItem('video_studio_recent_tasks')).toContain('batch-1')

    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(mocks.createVideo).toHaveBeenCalledTimes(4)
    expect(mocks.createVideo.mock.calls[2][2]).toBe(mocks.createVideo.mock.calls[1][2])
    expect(mocks.createVideo.mock.calls[3][2]).not.toBe(mocks.createVideo.mock.calls[2][2])
    expect(wrapper.findAll('[data-testid="video-task"]')).toHaveLength(3)
    expect(window.localStorage.getItem('video_studio_recent_tasks')).toContain('batch-2')
    expect(window.localStorage.getItem('video_studio_recent_tasks')).toContain('batch-3')
    await wrapper.unmount()
  })

  it('refreshes unfinished tasks and clears failed records locally', async () => {
    const wrapper = mountView()
    await flushPromises()
    mocks.createVideo.mockResolvedValueOnce({ id: 'task-refresh', status: 'queued' })
    mocks.getVideo.mockResolvedValueOnce({ id: 'task-refresh', status: 'completed' })
    await wrapper.find('[data-testid="video-prompt"] textarea').setValue('Refresh this task safely.')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    await wrapper.find('[data-testid="video-refresh-all"]').trigger('click')
    await flushPromises()
    expect(mocks.getVideo).toHaveBeenCalledWith('sk-secret-value', 'task-refresh')
    expect(wrapper.find('[data-testid="video-task"]').text()).toContain('videoStudio.status.completed')

    mocks.createVideo.mockResolvedValueOnce({ id: 'task-failed', status: 'failed', error: 'provider failed' })
    await wrapper.find('[data-testid="video-prompt"] textarea').setValue('Keep this failed record local.')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="video-task"]')).toHaveLength(2)
    await wrapper.find('[data-testid="video-clear-failed"]').trigger('click')
    expect(wrapper.findAll('[data-testid="video-task"]')).toHaveLength(1)
    expect(window.localStorage.getItem('video_studio_recent_tasks')).not.toContain('task-failed')
    await wrapper.unmount()
  })
})
