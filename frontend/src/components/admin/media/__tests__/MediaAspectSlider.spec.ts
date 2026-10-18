import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MediaProductEditor from '../MediaProductEditor.vue'
import { draftInput, type Product } from '@/api/admin/mediaWorkbench'
import { copy, imageProduct } from './fixtures'
const editor = (product = copy(imageProduct)) => mount(MediaProductEditor, {props:{product,mediaTypes:['image','video'],disabled:false}})
const latest = (w:ReturnType<typeof editor>) => {const events=w.emitted('update:product')!;return events[events.length-1]![0] as Product}
describe('discrete aspect slider configuration',()=>{
  it('defaults off, sorts ratio endpoints, preserves ratios and pricing on toggle and range change',async()=>{
    const product=copy(imageProduct);product.capabilities.aspect_ratios=['16:9','9:16','1:1']
    const w=editor(product)
    expect(w.emitted('update:product')).toBeUndefined()
    await w.get('[data-test="aspect-slider-enabled"]').setValue(true)
    let next=latest(w)
    expect(next.capabilities.aspect_ratio_slider).toEqual({enabled:true,mode:'discrete',min:'9:16',max:'16:9'})
    expect(next.pricing_rules).toEqual(product.pricing_rules)
    expect(next.capabilities.aspect_ratios).toEqual(product.capabilities.aspect_ratios)
    await w.setProps({product:next})
    await w.get('[data-test="aspect-slider-min"]').setValue('1:1')
    next=latest(w);await w.setProps({product:next})
    expect(w.get('[data-test="aspect-slider-error"]').text()).toContain('请先调整比例列表并核对售价')
    expect(next.pricing_rules).toEqual(product.pricing_rules)
    expect(next.capabilities.aspect_ratios).toEqual(product.capabilities.aspect_ratios)
    await w.get('[data-test="aspect-slider-enabled"]').setValue(false)
    next=latest(w)
    expect(next.capabilities.aspect_ratio_slider?.enabled).toBe(false)
    expect(next.pricing_rules).toEqual(product.pricing_rules)
  })
  it('does not expose video slider or enable an empty/non-numeric ratio list',()=>{
    const video=copy(imageProduct);video.media_type='video'
    expect(editor(video).find('[data-test="aspect-slider-config"]').exists()).toBe(false)
    const product=copy(imageProduct);product.capabilities.aspect_ratios=['auto']
    expect(editor(product).get('[data-test="aspect-slider-enabled"]').attributes('disabled')).toBeDefined()
  })
  it('reports invalid restored endpoints and keeps all existing configuration untouched',()=>{
    const product=copy(imageProduct);product.capabilities.aspect_ratio_slider={enabled:true,mode:'discrete',min:'4:1',max:'1:1'}
    const w=editor(product)
    expect(w.get('[data-test="aspect-slider-error"]').text()).toContain('滑块端点须')
    expect(w.emitted('update:product')).toBeUndefined()
  })
  it('serializes enabled and disabled settings, while legacy omission remains omitted',()=>{
    const product=copy(imageProduct)
    expect(draftInput([product]).products[0]!.capabilities).not.toHaveProperty('aspect_ratio_slider')
    for(const enabled of [true,false]){
      product.capabilities.aspect_ratio_slider={enabled,mode:'discrete',min:'1:1',max:'16:9'}
      const input=draftInput([product]);expect(input.products[0]!.capabilities.aspect_ratio_slider).toEqual(product.capabilities.aspect_ratio_slider)
      input.products[0]!.capabilities.aspect_ratio_slider!.min='4:1'
      expect(product.capabilities.aspect_ratio_slider.min).toBe('1:1')
    }
  })
})
