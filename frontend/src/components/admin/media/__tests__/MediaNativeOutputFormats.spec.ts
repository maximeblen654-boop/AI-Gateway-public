import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MediaProductEditor from '../MediaProductEditor.vue'
import { draftInput, type Product } from '@/api/admin/mediaWorkbench'
import { copy, imageProduct } from './fixtures'
const binding = { kind: 'openai_images', revision: 'r1', auth: 'account_apikey', task_flow: 'sync' }
describe('native output format capabilities', () => {
  it('starts unselected and changes only explicit draft capability without repricing', async () => {
    const product = copy(imageProduct)
    const w = mount(MediaProductEditor, { props: { product, mediaTypes: ['image'], disabled: false, binding } })
    expect(w.emitted('update:product')).toBeUndefined()
    expect(w.get('[data-test="native-output-png"]').attributes('aria-pressed')).toBe('false')
    for (const format of ['png','jpeg','webp']) {
      await w.get(`[data-test="native-output-${format}"]`).trigger('click')
      const events=w.emitted('update:product')!
      const next=events[events.length-1]![0] as Product
      expect(next.capabilities.output_formats).toContain(format)
      expect(next.pricing_rules).toEqual(product.pricing_rules)
      expect(next.adapter_config).toEqual(product.adapter_config)
      await w.setProps({product:next})
    }
    await w.get('[data-test="native-output-jpeg"]').trigger('click')
    const events=w.emitted('update:product')!
    expect((events[events.length-1]![0] as Product).capabilities.output_formats).toEqual(['png','webp'])
    expect(w.text()).toContain('仅勾选已确认当前供应商线路支持的格式')
  })
  it.each(['grok_images','gemini_images','openai_images_oauth','laoli_video'])('does not enable unsupported adapter %s', kind => {
    const product=copy(imageProduct)
    const w=mount(MediaProductEditor,{props:{product,mediaTypes:['image'],disabled:false,binding:{...binding,kind}}})
    expect(w.find('[data-test="native-output-formats"]').exists()).toBe(false)
  })
  it('keeps existing unsupported capabilities visible but read-only', () => {
    const product=copy(imageProduct);product.capabilities.output_formats=['png']
    const w=mount(MediaProductEditor,{props:{product,mediaTypes:['image'],disabled:false,binding:{...binding,kind:'gemini_images'}}})
    expect(w.get('[data-test="native-output-png"]').attributes('disabled')).toBeDefined()
    expect(w.emitted('update:product')).toBeUndefined()
  })
  it('serializes a copy of selected formats and omits default empty capability', () => {
    const product=copy(imageProduct)
    expect(draftInput([product]).products[0]!.capabilities).not.toHaveProperty('output_formats')
    product.capabilities.output_formats=['png','jpeg','webp']
    const input=draftInput([product]);expect(input.products[0]!.capabilities.output_formats).toEqual(['png','jpeg','webp'])
    input.products[0]!.capabilities.output_formats!.pop()
    expect(product.capabilities.output_formats).toHaveLength(3)
    product.capabilities.output_formats=[]
    expect(draftInput([product]).products[0]!.capabilities).not.toHaveProperty('output_formats')
  })
})
