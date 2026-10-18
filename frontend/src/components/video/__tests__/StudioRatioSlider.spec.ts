import {mount} from '@vue/test-utils'
import {describe,it,expect} from 'vitest'
import StudioRatioSlider from '../StudioRatioSlider.vue'
describe('Discrete ratio slider',()=>{
 it('keeps square in the visual center and snaps mouse/touch input to a published ratio',async()=>{const wrapper=mount(StudioRatioSlider,{props:{modelValue:'1:1',options:['9:16','3:4','1:1','16:9']}});expect(wrapper.get('input').element.value).toBe('500');await wrapper.get('input').setValue('980');expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['16:9']);expect(wrapper.get('input').attributes('aria-valuetext')).toBe('1:1');wrapper.unmount()})
 it('keyboard visits adjacent discrete values rather than inventing intermediate ratios',async()=>{const wrapper=mount(StudioRatioSlider,{props:{modelValue:'1:1',options:['9:16','1:1','16:9']}});await wrapper.get('input').trigger('keydown',{key:'ArrowLeft'});await wrapper.get('input').trigger('keydown',{key:'End'});expect(wrapper.emitted('update:modelValue')).toEqual([['9:16'],['16:9']]);wrapper.unmount()})
 it('shows a disabled state when current references/spec have no legal match',()=>{const wrapper=mount(StudioRatioSlider,{props:{modelValue:'1:1',options:[]}});expect(wrapper.get('input').attributes('disabled')).toBeDefined();expect(wrapper.text()).toContain('当前规格或素材没有可选比例');wrapper.unmount()})
})
