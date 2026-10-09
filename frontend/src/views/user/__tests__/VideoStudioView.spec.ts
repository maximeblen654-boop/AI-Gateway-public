import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import VideoStudioView from '../VideoStudioView.vue'
import zh from '@/i18n/locales/zh/videoStudio'
import type { StudioKind, StudioOffer } from '@/api/studioMedia'

const api = vi.hoisted(() => ({ session: vi.fn(), catalog: vi.fn(), history: vi.fn(), request: vi.fn(), generate: vi.fn() }))
vi.mock('@/api/studioMedia', async original => ({
  ...await original<typeof import('@/api/studioMedia')>(),
  ensureStudioSession: api.session, studioCatalog: api.catalog, studioHistory: api.history,
  studioRequest: api.request, studioGenerate: api.generate,
}))
vi.mock('vue-i18n', async original => ({
  ...await original<typeof import('vue-i18n')>(),
  useI18n: () => ({ t: (key: string) => zh.videoStudio[key.split('.')[1] as keyof typeof zh.videoStudio] }),
}))

const video: StudioOffer = {
  offer_id: 'published-video', model: 'site-video', display_name: '本站视频模型', upstream_model: 'synthetic-video',
  spec: { resolution: ['720p'], duration_seconds: [5], aspect_ratio: ['16:9'], count: { min: 1, max: 1 },
    references: { image: { min: 0, max: 0 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 0 } },
}
const image: StudioOffer = { ...video, offer_id: 'published-image', model: 'site-image', display_name: '本站图片模型', upstream_model: 'synthetic-image' }
let wrapper: ReturnType<typeof mount>

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  api.session.mockResolvedValue({ owner_id: 1 })
  api.catalog.mockImplementation(async (kind: StudioKind) => [kind === 'image' ? image : video])
  api.history.mockResolvedValue([])
  api.request.mockResolvedValue({ paid_enabled: false })
})
afterEach(() => wrapper?.unmount())

function mountView() {
  return mount(VideoStudioView, { global: { stubs: { AppLayout: { template: '<main><slot /></main>' } } } })
}

describe('Published image and video studio page', () => {
  it('opens the existing panel directly and switches published catalogs without a Grok key', async () => {
    wrapper = mountView()
    expect(wrapper.get('h1').text()).toBe('AI 生图与视频工作台')
    expect(wrapper.find('[data-testid="studio-media-panel"]').exists()).toBe(true)
    await flushPromises()
    expect(wrapper.get('[data-testid="studio-offer-select"]').text()).toBe('本站视频模型')
    expect(api.catalog).toHaveBeenCalledWith('video')
    await wrapper.get('[data-testid="studio-kind"]').setValue('image')
    await flushPromises()
    expect(wrapper.get('[data-testid="studio-offer-select"]').text()).toBe('本站图片模型')
    expect(api.catalog).toHaveBeenLastCalledWith('image')
    expect(api.history).toHaveBeenLastCalledWith('image')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(wrapper.find('[data-testid="video-key-select"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="studio-media-open"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Grok')
    expect(api.generate).not.toHaveBeenCalled()
  })

  it('keeps an unpublished catalog empty for both media types', async () => {
    api.catalog.mockResolvedValue([])
    wrapper = mountView()
    for (const kind of ['video', 'image']) {
      await flushPromises()
      await wrapper.get('[data-testid="studio-kind"]').setValue(kind)
      await flushPromises()
      expect(wrapper.findAll('[data-testid="studio-offer-select"] option')).toHaveLength(0)
      expect(wrapper.text()).toContain('暂无可用模型')
      expect(wrapper.text()).not.toContain('当前模型不支持这些素材')
      expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined()
    }
    expect(api.generate).not.toHaveBeenCalled()
  })
})
