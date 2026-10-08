import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StudioMediaPanel from '../StudioMediaPanel.vue'
import type { StudioTask } from '@/api/studioMedia'

const api = vi.hoisted(() => ({ session:vi.fn(), catalog:vi.fn(), request:vi.fn(), history:vi.fn(), task:vi.fn(), generate:vi.fn() }))
vi.mock('@/api/studioMedia', async original => ({ ...await original<typeof import('@/api/studioMedia')>(), ensureStudioSession:api.session, studioCatalog:api.catalog, studioRequest:api.request, studioHistory:api.history, studioTask:api.task, studioGenerate:api.generate }))
const prepared:StudioTask={id:'op_'+'a'.repeat(64),kind:'video',status:'prepared',createdAt:'2026-01-01',expiresAt:'2099-01-01',offerId:'offer',model:'synthetic-video',spec:{resolution:'720p',duration_seconds:5,count:1},price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},resultCount:0}
const offer={offer_id:'offer',model:'synthetic-video',display_name:'合成视频模型',upstream_model:'synthetic-video',spec:{resolution:['720p'],duration_seconds:[5],aspect_ratio:['16:9'],count:{min:1,max:1},references:{image:{min:0,max:1},video:{min:0,max:0},audio:{min:0,max:0},total_max:1}}}
let wrapper:ReturnType<typeof mount>
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();api.session.mockResolvedValue({owner_id:1});api.catalog.mockResolvedValue([offer]);api.history.mockResolvedValue([prepared]);api.request.mockResolvedValue({paid_enabled:true});api.task.mockImplementation(async t=>t)})
afterEach(()=>{wrapper?.unmount();vi.useRealTimers()})
describe('Published customer task confirmation and recovery',()=>{
 it('restores server history, displays exact price, and generates only on an explicit click',async()=>{
  wrapper=mount(StudioMediaPanel);await flushPromises();expect(wrapper.get('[data-testid="studio-price"]').text()).toContain('0.80 CNY');expect(api.generate).not.toHaveBeenCalled()
  let finish!:(value:StudioTask)=>void;api.generate.mockReturnValue(new Promise<StudioTask>(r=>{finish=r}))
  await wrapper.get('[data-testid="studio-generate"]').trigger('click');expect(api.generate).toHaveBeenCalledTimes(1);expect(wrapper.find('[data-testid="studio-generate"]').exists()).toBe(false)
  finish({...prepared,status:'completed',resultCount:1});await flushPromises();expect(wrapper.get('video').attributes('src')).toContain(`/operations/${prepared.id}/original`);expect(wrapper.get('[data-testid="studio-download"]').attributes('href')).toContain(prepared.id)
 })
 it('unknown response survives remount and only queries, even if a stale history still says prepared',async()=>{
  api.generate.mockRejectedValue(new TypeError('synthetic network loss'));wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-generate"]').trigger('click');await flushPromises()
  expect(wrapper.get('[data-testid="studio-status"]').text()).toBe('结果待确认');wrapper.unmount();wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.find('[data-testid="studio-generate"]').exists()).toBe(false);await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises();expect(api.generate).toHaveBeenCalledTimes(1)
 })
 it('a closed server gate or expired quote never enables generation',async()=>{
  api.request.mockResolvedValue({paid_enabled:false});wrapper=mount(StudioMediaPanel);await flushPromises();expect(wrapper.get('[data-testid="studio-generate"]').attributes('disabled')).toBeDefined();wrapper.unmount()
  api.request.mockResolvedValue({paid_enabled:true});api.history.mockResolvedValue([{...prepared,expiresAt:'2000-01-01'}]);wrapper=mount(StudioMediaPanel);await flushPromises();expect(wrapper.text()).toContain('报价已失效');expect(wrapper.get('[data-testid="studio-generate"]').attributes('disabled')).toBeDefined();expect(api.generate).not.toHaveBeenCalled()
 })
 it('input changes require a new quote, never mutate or auto-submit the existing task',async()=>{
  wrapper=mount(StudioMediaPanel);await flushPromises();expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined();await wrapper.get('[data-testid="studio-new"]').trigger('click');await wrapper.get('[data-testid="studio-prompt"]').setValue('changed prompt');expect(api.generate).not.toHaveBeenCalled();expect(wrapper.find('[data-testid="studio-generate"]').exists()).toBe(false)
 })
 it('catalog or readiness failure does not hide server history or completed results',async()=>{
  api.catalog.mockRejectedValue(new Error('catalog unavailable'));api.request.mockRejectedValue(new Error('readiness unavailable'))
  api.history.mockResolvedValue([{...prepared,status:'completed',resultCount:1}]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.get('[data-testid="studio-download"]').attributes('href')).toContain(prepared.id);expect(wrapper.text()).toContain('仍可查询原任务');expect(api.generate).not.toHaveBeenCalled()
 })
 it('an older history refresh cannot overwrite a newly selected media type',async()=>{
  wrapper=mount(StudioMediaPanel);await flushPromises()
  let finish!:(tasks:StudioTask[])=>void;const image:StudioTask={...prepared,kind:'image',id:'img_'+'b'.repeat(32)}
  api.history.mockReturnValueOnce(new Promise<StudioTask[]>(r=>{finish=r})).mockResolvedValueOnce([image])
  await wrapper.findAll('button').find(b=>b.text()==='刷新记录')!.trigger('click');await wrapper.get('[data-testid="studio-kind"]').setValue('image');await flushPromises()
  finish([prepared]);await flushPromises();expect(wrapper.findAll('[data-task-id]').map(b=>b.attributes('data-task-id'))).toEqual([image.id]);expect(api.task).toHaveBeenCalledWith(image)
 })
 it('selecting another historical task during a query eventually queries the new identity',async()=>{
  const second={...prepared,id:'op_'+'b'.repeat(64)};api.history.mockResolvedValue([prepared,second]);wrapper=mount(StudioMediaPanel);await flushPromises()
  let finish!:(task:StudioTask)=>void;api.task.mockReturnValueOnce(new Promise<StudioTask>(r=>{finish=r}))
  await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await wrapper.get(`[data-task-id="${second.id}"]`).trigger('click');finish(prepared);await flushPromises()
  expect(api.task).toHaveBeenLastCalledWith(second);expect(wrapper.get('[data-testid="studio-task-id"]').text()).toContain(second.id);expect(api.generate).not.toHaveBeenCalled()
 })
})
