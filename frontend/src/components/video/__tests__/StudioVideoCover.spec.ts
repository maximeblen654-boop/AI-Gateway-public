import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const recover = vi.hoisted(() => vi.fn())
vi.mock('@/api/studioMedia', () => ({ recoverStudioMediaRead: recover }))
import StudioVideoCover from '../StudioVideoCover.vue'

let wrapper: ReturnType<typeof mount>
const src = '/studio-v2/api/video/operations/op_' + 'a'.repeat(64) + '/cover'
beforeEach(() => { vi.stubGlobal('IntersectionObserver', undefined); recover.mockReset(); recover.mockResolvedValue(undefined) })
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const open = async () => { wrapper = mount(StudioVideoCover, { props: { src, alt: '视频封面' } }); await wrapper.vm.$nextTick() }

describe('Private saved video cover', () => {
  it('loads a JPEG endpoint without creating or decoding an original video', async () => {
    const create = vi.spyOn(document, 'createElement')
    await open()
    expect(wrapper.get('img').attributes('src')).toBe(src)
    expect(create.mock.calls.some(([tag]) => tag === 'video' || tag === 'canvas')).toBe(false)
    await wrapper.get('img').trigger('load')
    expect(wrapper.find('[data-testid="studio-video-cover-fallback"]').exists()).toBe(false)
    expect(wrapper.get('img').attributes('alt')).toBe('视频封面')
    expect(recover).not.toHaveBeenCalled()
  })
  it('waits until a card approaches the viewport before loading its thumbnail', async () => {
    let enter!: IntersectionObserverCallback
    const disconnect = vi.fn()
    vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { enter = callback; expect(options.rootMargin).toBe('150px') } observe = vi.fn(); disconnect = disconnect })
    await open(); expect(wrapper.find('img').exists()).toBe(false)
    enter([{ isIntersecting: false }] as IntersectionObserverEntry[], {} as IntersectionObserver)
    await flushPromises(); expect(wrapper.find('img').exists()).toBe(false)
    enter([{ isIntersecting: true }] as IntersectionObserverEntry[], {} as IntersectionObserver)
    await flushPromises(); expect(wrapper.find('img').exists()).toBe(true); expect(disconnect).toHaveBeenCalledOnce()
  })
  it('repairs the session once, then keeps the task usable on another failure', async () => {
    await open(); const first = wrapper.get('img').element
    await wrapper.get('img').trigger('error'); await flushPromises()
    expect(recover).toHaveBeenCalledTimes(1); expect(recover).toHaveBeenCalledWith(src)
    expect(wrapper.get('img').element).not.toBe(first)
    await wrapper.get('img').trigger('error'); await flushPromises()
    expect(recover).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('打开查看视频')
    expect(wrapper.text()).not.toContain('过期')
  })
  it('ignores a failed recovery for the previous source', async () => {
    let reject!: (reason: Error) => void
    recover.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
    await open(); await wrapper.get('img').trigger('error')
    const next = src.replace('a'.repeat(64), 'b'.repeat(64))
    await wrapper.setProps({ src: next }); reject(new Error('old failed')); await flushPromises()
    expect(wrapper.get('img').attributes('src')).toBe(next)
    expect(wrapper.text()).not.toContain('打开查看视频')
    await wrapper.get('img').trigger('load'); expect(wrapper.find('[data-testid="studio-video-cover-fallback"]').exists()).toBe(false)
  })
})
