import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const detectorMocks = vi.hoisted(() => ({
  load: vi.fn(),
  estimateFaces: vi.fn(),
  dispose: vi.fn(),
  setBackend: vi.fn(),
  ready: vi.fn(),
}))

vi.mock('@tensorflow/tfjs-backend-webgl', () => ({}))
vi.mock('@tensorflow/tfjs-core', () => ({
  setBackend: detectorMocks.setBackend,
  ready: detectorMocks.ready,
}))
vi.mock('@tensorflow-models/blazeface', () => ({ load: detectorMocks.load }))

vi.mock('vue-i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: { count?: number }) => params?.count ? `${key}:${params.count}` : key,
  }),
}))

import FacePrivacyTool from '../FacePrivacyTool.vue'

class MockImage {
  naturalWidth = 100
  naturalHeight = 100
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  set src(_value: string) {
    queueMicrotask(() => this.onload?.())
  }
}

describe('FacePrivacyTool', () => {
  const drawImage = vi.fn()
  const toBlobTargets: HTMLCanvasElement[] = []
  const context = {
    canvas: document.createElement('canvas'),
    imageSmoothingEnabled: true,
    clearRect: vi.fn(),
    drawImage,
    beginPath: vi.fn(),
    ellipse: vi.fn(),
    rect: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    bezierCurveTo: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    save: vi.fn(),
    clip: vi.fn(),
    restore: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
  } as unknown as CanvasRenderingContext2D

  beforeEach(() => {
    vi.clearAllMocks()
    detectorMocks.setBackend.mockResolvedValue(true)
    detectorMocks.ready.mockResolvedValue(undefined)
    detectorMocks.estimateFaces.mockResolvedValue([{ topLeft: [20, 20], bottomRight: [60, 60] }])
    detectorMocks.load.mockResolvedValue({ estimateFaces: detectorMocks.estimateFaces, dispose: detectorMocks.dispose })
    toBlobTargets.length = 0
    vi.stubGlobal('Image', MockImage)
    vi.stubGlobal('fetch', vi.fn())
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) {
      toBlobTargets.push(this)
      callback(new Blob(['png'], { type: 'image/png' }))
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect)
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:local') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    delete (window as Window & { FaceDetector?: unknown }).FaceDetector
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps the image local and renders a manually selected mosaic region', async () => {
    const wrapper = mount(FacePrivacyTool, { props: { open: true } })
    const input = wrapper.get('[data-testid="face-file-input"]').element as HTMLInputElement
    const file = new File(['image'], 'face.png', { type: 'image/png' })
    Object.defineProperty(input, 'files', { configurable: true, value: [file] })
    await wrapper.get('[data-testid="face-file-input"]').trigger('change')
    await flushPromises()

    const canvas = wrapper.get('[data-testid="face-canvas"]')
    expect((canvas.element as HTMLCanvasElement).width).toBe(100)
    await canvas.trigger('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 })
    await canvas.trigger('pointermove', { clientX: 65, clientY: 65, pointerId: 1 })
    await canvas.trigger('pointerup', { clientX: 65, clientY: 65, pointerId: 1 })
    expect(drawImage).toHaveBeenCalled()

    await wrapper.get('[data-testid="face-auto-detect"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('videoStudio.face.detected:1')
    expect(detectorMocks.load).toHaveBeenCalledTimes(1)
    await wrapper.get('[data-testid="face-show-original"]').setValue(true)
    vi.mocked(context.clip).mockClear()
    await wrapper.get('[data-testid="face-download"]').trigger('click')
    expect(fetch).not.toHaveBeenCalled()
    expect(URL.createObjectURL).toHaveBeenCalled()
    expect(toBlobTargets).toHaveLength(1)
    expect(toBlobTargets[0]).not.toBe(canvas.element)
    expect(context.clip).toHaveBeenCalled()

    await wrapper.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalled()
  })

  it('loads the local detector once when the browser has no native face detector', async () => {
    const wrapper = mount(FacePrivacyTool, { props: { open: true } })
    const input = wrapper.get('[data-testid="face-file-input"]').element as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'face.png', { type: 'image/png' })] })
    await wrapper.get('[data-testid="face-file-input"]').trigger('change')
    await flushPromises()

    await wrapper.get('[data-testid="face-auto-detect"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="face-auto-detect"]').trigger('click')
    await flushPromises()

    expect(detectorMocks.load).toHaveBeenCalledTimes(1)
    expect(detectorMocks.estimateFaces).toHaveBeenCalledTimes(2)
    expect(wrapper.get('[data-testid="face-clear-selections"]').attributes('disabled')).toBeUndefined()
    await wrapper.unmount()
    expect(detectorMocks.dispose).toHaveBeenCalledTimes(1)
  })

  it('ignores stale face detection results after the photo changes', async () => {
    let resolveDetection: ((faces: unknown[]) => void) | undefined
    class DeferredFaceDetector {
      detect() {
        return new Promise<unknown[]>((resolve) => { resolveDetection = resolve })
      }
    }
    Object.assign(window, { FaceDetector: DeferredFaceDetector })

    const wrapper = mount(FacePrivacyTool, { props: { open: true } })
    const input = wrapper.get('[data-testid="face-file-input"]').element as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['one'], 'one.png', { type: 'image/png' })] })
    await wrapper.get('[data-testid="face-file-input"]').trigger('change')
    await flushPromises()
    await wrapper.get('[data-testid="face-auto-detect"]').trigger('click')

    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['two'], 'two.png', { type: 'image/png' })] })
    await wrapper.get('[data-testid="face-file-input"]').trigger('change')
    await flushPromises()
    resolveDetection?.([{ boundingBox: { x: 10, y: 10, width: 30, height: 30 } }])
    await flushPromises()

    expect(wrapper.get('[data-testid="face-clear-selections"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).not.toContain('videoStudio.face.detected')
    await wrapper.unmount()
  })

  it('renders every face effect and exports both layers for face separation', async () => {
    const wrapper = mount(FacePrivacyTool, { props: { open: true } })
    const input = wrapper.get('[data-testid="face-file-input"]').element as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['image'], 'face.png', { type: 'image/png' })] })
    await wrapper.get('[data-testid="face-file-input"]').trigger('change')
    await flushPromises()

    const canvas = wrapper.get('[data-testid="face-canvas"]')
    await canvas.trigger('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 })
    await canvas.trigger('pointerup', { clientX: 70, clientY: 70, pointerId: 1 })
    await wrapper.get('[data-testid="face-shape"]').setValue('rectangle')

    for (const value of ['fishnet', 'scribble', 'blur', 'crosslines', 'landscape', 'label', 'puzzle', 'lightdots', 'metalgrid', 'horn', 'separate']) {
      await wrapper.get('[data-testid="face-effect"]').setValue(value)
    }
    expect(context.quadraticCurveTo).toHaveBeenCalled()
    expect(context.createRadialGradient).toHaveBeenCalled()
    expect(context.bezierCurveTo).toHaveBeenCalled()

    toBlobTargets.length = 0
    await wrapper.get('[data-testid="face-download"]').trigger('click')
    expect(toBlobTargets).toHaveLength(2)
    await wrapper.unmount()
  })
})
