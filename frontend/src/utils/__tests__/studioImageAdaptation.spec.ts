import { afterEach, describe, expect, it, vi } from 'vitest'
import { adaptStudioImage, studioImageAdaptedSize } from '../studioImageAdaptation'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('bounded browser image adaptation', () => {
  it('uses the smallest proportional enlargement and leaves legal dimensions unchanged', () => {
    expect(studioImageAdaptedSize({ width: 278, height: 270 }, 300)).toEqual({ width: 309, height: 300 })
    expect(studioImageAdaptedSize({ width: 900, height: 500 }, 300)).toEqual({ width: 900, height: 500 })
  })
  it.each([{ width: 10, height: 10 }, { width: 16000, height: 10 }, { width: 3000, height: 3000 }])('rejects unsafe source/output sizes before decoding %j', async size => {
    const decode = vi.fn(); vi.stubGlobal('createImageBitmap', decode)
    await expect(adaptStudioImage(new File(['12345678'], 'x.png', { type: 'image/png' }), size, 300, new AbortController().signal)).rejects.toThrow('image_adaptation_limit')
    expect(decode).not.toHaveBeenCalled()
  })
  it('creates a separate PNG and releases bitmap and canvas memory', async () => {
    const close = vi.fn(), drawImage = vi.fn(), bitmap = { width: 278, height: 270, close }
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D)
    const encoded = new Blob(['png-fixture-bytes'], { type: 'image/png' })
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (callback) { expect(this.width).toBe(309); expect(this.height).toBe(300); callback(encoded) })
    const source = new File(['original'], 'reference.webp', { type: 'image/webp' })
    const result = await adaptStudioImage(source, bitmap, 300, new AbortController().signal)
    expect(result.name).toBe('reference-适配.png'); expect(result.type).toBe('image/png')
    expect(source.name).toBe('reference.webp'); expect(source.size).toBe(8)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0, 309, 300); expect(close).toHaveBeenCalledOnce()
  })
  it('cleans up a decoded bitmap when removal aborts the action', async () => {
    const controller = new AbortController(), close = vi.fn()
    vi.stubGlobal('createImageBitmap', vi.fn().mockImplementation(async () => { controller.abort(); return { width: 278, height: 270, close } }))
    await expect(adaptStudioImage(new File(['original'], 'reference.png', { type: 'image/png' }), { width: 278, height: 270 }, 300, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
    expect(close).toHaveBeenCalledOnce()
  })
})
