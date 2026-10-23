import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StudioVideoCover from '../StudioVideoCover.vue'

let wrapper: ReturnType<typeof mount>
let videos: HTMLVideoElement[]
const drawImage = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined)
  videos = []
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    const element = create(tag, options)
    if (tag === 'video') videos.push(element as HTMLVideoElement)
    return element
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,frame')
  drawImage.mockClear()
})
afterEach(() => { wrapper?.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
const open = () => { wrapper = mount(StudioVideoCover, {props:{src:'/original/one',alt:'视频封面'}}) }
function metadata(video: HTMLVideoElement, duration = 4) {
  Object.defineProperties(video, { duration:{value:duration,configurable:true}, videoWidth:{value:1920,configurable:true}, videoHeight:{value:1080,configurable:true}, readyState:{value:2,configurable:true} })
  video.dispatchEvent(new Event('loadedmetadata'))
}
describe('Saved video frame cover', () => {
  it.each([4, 0.2])('extracts a real frame after seeking a %s second clip and releases the decoder', async duration => {
    open(); const video=videos[0]!
    expect(video.muted).toBe(true);expect(video.autoplay).toBe(false)
    metadata(video,duration);expect(video.currentTime).toBe(Math.min(1,duration/2))
    video.dispatchEvent(new Event('seeked'));await wrapper.vm.$nextTick()
    expect(drawImage).toHaveBeenCalledWith(video,0,0,960,540)
    expect(wrapper.get('img').attributes()).toMatchObject({src:'data:image/jpeg;base64,frame',alt:'视频封面'})
    expect(video.hasAttribute('src')).toBe(false);expect(video.pause).toHaveBeenCalled()
  })
  it('waits until the card is visible before reading the original', () => {
    let enter!: IntersectionObserverCallback
    const disconnect=vi.fn()
    vi.stubGlobal('IntersectionObserver',class {constructor(callback:IntersectionObserverCallback){enter=callback}observe=vi.fn();disconnect=disconnect})
    open();expect(videos).toHaveLength(0)
    enter([{isIntersecting:false}] as IntersectionObserverEntry[],{} as IntersectionObserver);expect(videos).toHaveLength(0)
    enter([{isIntersecting:true}] as IntersectionObserverEntry[],{} as IntersectionObserver);expect(videos).toHaveLength(1);expect(disconnect).toHaveBeenCalled()
  })
  it.each(['error','timeout','invalid-duration','canvas-error'])('keeps the task usable on %s', async cause => {
    vi.useFakeTimers();open();const video=videos[0]!
    if(cause==='error')video.dispatchEvent(new Event('error'))
    else if(cause==='timeout')vi.advanceTimersByTime(15000)
    else if(cause==='invalid-duration')metadata(video,Infinity)
    else {vi.mocked(HTMLCanvasElement.prototype.toDataURL).mockImplementationOnce(()=>{throw new Error('tainted canvas')});metadata(video);video.dispatchEvent(new Event('seeked'))}
    await wrapper.vm.$nextTick();expect(wrapper.text()).toContain('打开查看视频');expect(wrapper.find('img').exists()).toBe(false);expect(video.hasAttribute('src')).toBe(false)
  })
  it('ignores stale video callbacks after source change and clears work on unmount', async () => {
    open();const previous=videos[0]!;await wrapper.setProps({src:'/original/two'})
    expect(previous.hasAttribute('src')).toBe(false)
    metadata(previous);previous.dispatchEvent(new Event('seeked'));expect(drawImage).not.toHaveBeenCalled()
    wrapper.unmount();expect(videos[1]!.hasAttribute('src')).toBe(false)
  })
})
