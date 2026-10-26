import { mount, flushPromises } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { Product } from '@/api/admin/mediaWorkbench'
import { mediaProductForType } from '@/utils/mediaProductType'
import { allowedSpecs } from '../pricingMatrix'
import MediaProductEditor from '../MediaProductEditor.vue'
import MediaReferenceEditor from '../MediaReferenceEditor.vue'
import MediaTechnicalEditor from '../MediaTechnicalEditor.vue'
import { copy, imageProduct } from './fixtures'

describe('media type field transitions', () => {
  it('does not offer an image quality input for a clean video, while allowing old values to be corrected', async () => {
    const product = mediaProductForType(copy(imageProduct), 'video')
    const wrapper = mount(MediaTechnicalEditor, { props: { product, mediaTypes: ['image', 'video'], disabled: false } })
    expect(wrapper.find('[data-test="quality-options"]').exists()).toBe(false)
    product.capabilities.qualities = ['legacy-quality']
    await wrapper.setProps({ product: copy(product) })
    expect(wrapper.find('[data-test="quality-options"]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('clears image-only fields for video and preserves common configuration and entered video durations', () => {
    const product = copy(imageProduct)
    product.capabilities.qualities = ['high']; product.capabilities.output_formats = ['png']; product.capabilities.durations_seconds = [4, 8]
    product.adapter_config = { ...product.adapter_config, version: 1, model_family: 'openai_json', execution: { mode: 'native_multi', max_output_images: 2 }, edit_execution: { mode: 'single', max_output_images: 1 } }
    product.capabilities.combination_rules = [{ deny: { resolution: ['4K'] } }, { deny: { resolution: ['1K'], quality: ['high'] } }]
    const before = copy(product), next = mediaProductForType(product, 'video')
    expect(product).toEqual(before)
    expect(next).toMatchObject({ product_id: product.product_id, upstream_model: product.upstream_model, capabilities: { resolutions: product.capabilities.resolutions, aspect_ratios: product.capabilities.aspect_ratios, durations_seconds: [4, 8], qualities: [], references: product.capabilities.references, count: { min: 1, max: 1 }, combination_rules: [{ deny: { resolution: ['4K'] } }] }, adapter_config: { size_mappings: [] }, pricing_rules: product.pricing_rules })
    expect(next.adapter_config).not.toHaveProperty('model_family')
    expect(next.adapter_config).not.toHaveProperty('execution')
    expect(next.adapter_config).not.toHaveProperty('edit_execution')
    expect(next.capabilities).not.toHaveProperty('output_formats')
    expect(mediaProductForType(product, 'image')).toEqual(product)
  })

  it('does not revive hidden duration, video/audio references or image quality after a round trip', () => {
    const product = copy(imageProduct); product.media_type = 'video'
    product.capabilities.durations_seconds = [4, 8]
    product.capabilities.references = { image: { min: 0, max: 4 }, video: { min: 1, max: 2 }, audio: { min: 0, max: 2 }, total_max: 8 }
    product.adapter_config = { wire_profile: 'inline_multimedia', version: 1, size_mappings: [] }
    product.capabilities.combination_rules = [{ deny: { duration_seconds: [4], resolution: ['4K'] } }, { deny: { aspect_ratio: ['16:9'] } }]
    const image = mediaProductForType(product, 'image')
    expect(image.capabilities).toMatchObject({ durations_seconds: [], references: { image: { min: 0, max: 4 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 4 }, combination_rules: [{ deny: { aspect_ratio: ['16:9'] } }] })
    expect(image.adapter_config).not.toHaveProperty('wire_profile')
    const videoAgain = mediaProductForType(image, 'video')
    expect(videoAgain.capabilities.durations_seconds).toEqual([])
    expect(videoAgain.capabilities.references.video.max).toBe(0)
    expect(videoAgain.capabilities.references.audio.max).toBe(0)
    expect(videoAgain.pricing_rules).toEqual(product.pricing_rules)
    product.capabilities.references.total_max = 0
    expect(mediaProductForType(product, 'image').capabilities.references.total_max).toBe(0)
  })

  it('projects optional video/audio deny ranges into the image domain without dropping their common restrictions', () => {
    const product = copy(imageProduct); product.media_type = 'video'
    product.capabilities.count = { min: 1, max: 1 }
    product.capabilities.durations_seconds = [4]
    product.capabilities.references = { image: { min: 0, max: 4 }, video: { min: 0, max: 2 }, audio: { min: 0, max: 1 }, total_max: 7 }
    product.capabilities.combination_rules = [{ deny: { resolution: ['4K'], references: copy(product.capabilities.references) } }]
    Object.assign(product.adapter_config, { wire_profile: 'image2pro', version: 1, image2pro: { model: 'frozen-video-contract', max_videos: 2 } })
    expect(allowedSpecs(product.capabilities)).toBeDefined()
    const before = copy(product), image = mediaProductForType(product, 'image')
    expect(product).toEqual(before)
    expect(image.capabilities.combination_rules[0]!.deny.references).toEqual({ image: { min: 0, max: 4 }, video: { min: 0, max: 0 }, audio: { min: 0, max: 0 }, total_max: 4 })
    const specs = allowedSpecs(image.capabilities)
    expect(specs).toBeDefined()
    expect(specs!.length).toBeGreaterThan(0)
    expect(specs!.every(spec => spec.resolution === '1K' && spec.videos === 0 && spec.audio === 0)).toBe(true)
    expect(image.adapter_config).not.toHaveProperty('image2pro')
    expect(mediaProductForType(image, 'video').adapter_config).not.toHaveProperty('image2pro')
  })

  it('intersects a retained image deny count with the fixed video count rather than leaving an invalid upper bound', () => {
    const product = copy(imageProduct)
    product.capabilities.count = { min: 1, max: 10 }
    product.capabilities.combination_rules = [{ deny: { resolution: ['4K'], count: { min: 1, max: 10 } } }]
    const video = mediaProductForType(product, 'video')
    expect(video.capabilities.combination_rules).toEqual([{ deny: { resolution: ['4K'], count: { min: 1, max: 1 } } }])
    const specs = allowedSpecs(video.capabilities)
    expect(specs).toBeDefined()
    expect(specs!.length).toBeGreaterThan(0)
    expect(specs!.every(spec => spec.count === 1 && spec.resolution === '1K')).toBe(true)
  })

  it('keeps the existing price confirmation effective for cleanup and restores all fields on cancel', async () => {
    const product = copy(imageProduct)
    product.capabilities.qualities = ['standard', 'high']
    product.capabilities.count = { min: 1, max: 10 }
    product.adapter_config.execution = { mode: 'native_multi', max_output_images: 2 }
    product.pricing_rules = ['standard', 'high'].map((quality, index) => ({ match: { quality: [quality] }, sale_price: { amount: String(index + 1), currency: 'CNY', billing_mode: 'per_request' } }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const wrapper = mount(MediaProductEditor, { props: { product, mediaTypes: ['image', 'video'], disabled: false, 'onUpdate:product': (value: Product) => { void wrapper.setProps({ product: value }) } } })
    await wrapper.get('[data-field="media_type"]').setValue('video'); await flushPromises()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(wrapper.props('product')).toEqual(product)
    expect(wrapper.get('[data-field="media_type"]').element).toHaveProperty('value', 'image')
    confirm.mockReturnValue(true)
    await wrapper.get('[data-field="media_type"]').setValue('video'); await flushPromises()
    expect(wrapper.props('product').media_type).toBe('video')
    expect(wrapper.props('product').capabilities.qualities).toEqual([])
    expect(wrapper.props('product').adapter_config.size_mappings).toEqual([])
    expect(wrapper.props('product').pricing_rules.every(rule => !rule.match.quality?.length)).toBe(true)
    confirm.mockRestore(); wrapper.unmount()
  })

  it('discards a hidden buffered reference edit when an accepted type change closes its context', async () => {
    const video = copy(imageProduct); video.media_type = 'video'
    video.capabilities.references.video = { min: 0, max: 2 }; video.capabilities.references.total_max = 6
    const wrapper = mount(MediaReferenceEditor, { props: { modelValue: video.capabilities.references, mediaType: 'video' } })
    const input = wrapper.get('[data-test="reference-video-max"]')
    ;(input.element as HTMLInputElement).value = '3'
    await input.trigger('input')
    const image = mediaProductForType(video, 'image')
    await wrapper.setProps({ mediaType: 'image', modelValue: image.capabilities.references })
    expect(await wrapper.vm.commitPending()).toBe(true)
    expect(wrapper.emitted('update:modelValue')).toBeUndefined()
    await wrapper.setProps({ mediaType: 'video' })
    expect(wrapper.get('[data-test="reference-video-mode"]').element).toHaveProperty('value', 'none')
    expect(wrapper.find('[data-test="reference-video-max"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
