import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Picker from '../StudioModelPicker.vue'
import type { StudioOffer, StudioPassiveStatus } from '@/api/studioMedia'
const offers = (status?: StudioPassiveStatus): StudioOffer[] => [{offer_id:'a',model:'same',display_name:'模型 A',upstream_model:'same',passive_status:status,spec:{resolution:['1K'],aspect_ratio:['1:1'],count:{min:1,max:10},references:{image:{min:0,max:0},video:{min:0,max:0},audio:{min:0,max:0},total_max:0}}}]
const observation = (state: StudioPassiveStatus['state']='observed'): StudioPassiveStatus => ({state,scope:'platform_group_requested_model',window_seconds:5400,data_through:new Date().toISOString(),computed_at:new Date().toISOString(),error_rate:.12})
afterEach(()=>vi.useRealTimers())
describe('passive model picker',()=>{
 for (const state of ['unavailable','no_data','insufficient','stale'] as const) it(`keeps ${state} neutral`,async()=>{
  const w=mount(Picker,{props:{offers:offers(observation(state)),modelValue:'a'}})
  expect(w.find('.picker-status').classes()).toContain('neutral');expect(w.find('.picker-status').text()).not.toContain('%');w.unmount()
 })
 it('shows evidence scope without inventing health and does not select on details',async()=>{
  const w=mount(Picker,{props:{offers:offers(observation()),modelValue:'a'}})
  await w.get('.picker-status').trigger('click');expect(w.text()).toContain('错误 12%');expect(w.text()).toContain('不代表某个具体渠道');expect(w.emitted('select')).toBeUndefined()
  await w.get('.picker-choice').trigger('click');expect(w.emitted('select')).toEqual([['a']]);w.unmount()
 })
 it('ages out an open observation without a network request',async()=>{
  vi.useFakeTimers();const w=mount(Picker,{props:{offers:offers(observation()),modelValue:'a'}})
  await vi.advanceTimersByTimeAsync(630000);expect(w.text()).toContain('数据已过期');w.unmount()
 })
 it('does not match same-name offers to one another',()=>{
  const a=offers(observation())[0]!;const b={...a,offer_id:'b',passive_status:undefined}
  const w=mount(Picker,{props:{offers:[a,b],modelValue:'a'}})
  expect(w.findAll('.picker-status')[1]!.text()).toContain('暂无状态数据');w.unmount()
 })
 for(const rate of [-1,2,NaN])it(`rejects invalid rate ${rate}`,()=>{const s=observation();s.error_rate=rate;const w=mount(Picker,{props:{offers:offers(s),modelValue:'a'}});expect(w.text()).toContain('暂无状态数据');w.unmount()})
})
