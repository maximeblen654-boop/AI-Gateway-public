import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StudioMediaPanel from '../StudioMediaPanel.vue'
import { type StudioTask } from '@/api/studioMedia'

const api = vi.hoisted(() => ({ session:vi.fn(), catalog:vi.fn(), request:vi.fn(), history:vi.fn(), task:vi.fn(), generate:vi.fn(), upload:vi.fn() }))
vi.mock('@/api/studioMedia', async original => ({ ...await original<typeof import('@/api/studioMedia')>(), ensureStudioSession:api.session, studioCatalog:api.catalog, studioRequest:api.request, studioHistory:api.history, studioTask:api.task, studioGenerate:api.generate, uploadStudioAsset:api.upload }))
const prepared:StudioTask={id:'op_'+'a'.repeat(64),kind:'video',status:'prepared',createdAt:'2026-01-01',expiresAt:'2099-01-01',offerId:'offer',model:'synthetic-video',spec:{resolution:'720p',duration_seconds:5,count:1},price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},resultCount:0}
const offer={offer_id:'offer',model:'synthetic-video',display_name:'合成视频模型',upstream_model:'synthetic-video',spec:{resolution:['720p'],duration_seconds:[5],aspect_ratio:['16:9'],count:{min:1,max:1},references:{image:{min:0,max:1},video:{min:0,max:0},audio:{min:0,max:0},total_max:1}}}
let wrapper:ReturnType<typeof mount>
beforeEach(()=>{vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:200,y:500,width:200,height:40,top:500,bottom:540,left:200,right:400,toJSON:()=>({})});vi.clearAllMocks();sessionStorage.clear();sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video'}));if(typeof URL.createObjectURL!=='function')Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>`blob:studio-asset`)});if(typeof URL.revokeObjectURL!=='function')Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});api.session.mockResolvedValue({owner_id:1});api.catalog.mockResolvedValue([offer]);api.history.mockResolvedValue([prepared]);api.request.mockResolvedValue({paid_enabled:true});api.task.mockImplementation(async t=>t);api.upload.mockImplementation(async (file:File,kind:string)=>({asset_ref:`asset_${'a'.repeat(8)}-0000-0000-0000-000000000000`,kind,mime_type:file.type,size:file.size,duration_seconds:null}))})
afterEach(()=>{wrapper?.unmount();document.body.innerHTML='';vi.restoreAllMocks();vi.useRealTimers()})

const imageFile=(name='reference.png')=>new File(['12345678'],name,{type:'image/png'})
async function pick(files:File[]){const input=wrapper.get('[data-testid="studio-asset-input"]');Object.defineProperty(input.element,'files',{value:files,configurable:true});await input.trigger('change');await flushPromises()}

const notices=()=>wrapper.findAll('.studio-notice').map(x=>x.text()).join(' ')
async function compose(){api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel);await flushPromises()}
async function refreshModels(){await wrapper.get('[data-testid="studio-refresh-models"]').trigger('click');await flushPromises()}
it('control: video navigation requests video catalog',async()=>{
 sessionStorage.clear();await compose();api.catalog.mockClear();await wrapper.get('[data-testid="studio-mode-video"]').trigger('click');await flushPromises();expect(api.catalog).toHaveBeenLastCalledWith('video');expect(wrapper.get('[data-testid="studio-mode-video"]').attributes('aria-pressed')).toBe('true')
})
it('A: text-mode notice must not survive switching to video',async()=>{
 sessionStorage.clear();await compose();await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await pick([imageFile()]);await wrapper.get('[data-testid="studio-mode-text"]').trigger('click');await wrapper.get('[data-testid="studio-mode-video"]').trigger('click');await flushPromises();expect(notices().includes('已切换为文生图')).toBe(false)
})
it('B: recovered catalog refresh must clear failure notice',async()=>{
 await compose();api.catalog.mockRejectedValueOnce(new Error('offline'));await refreshModels();expect(notices().includes('无法刷新')).toBe(true);await refreshModels();expect(notices().includes('无法刷新')).toBe(false)
})
it('C: removing failed asset must clear its global error',async()=>{
 await compose();api.upload.mockRejectedValueOnce(new Error('file_changed'));await pick([imageFile()]);expect(wrapper.find('[data-testid="studio-asset-feedback"]').exists()).toBe(true);await wrapper.get('[data-testid^="studio-asset-remove-"]').trigger('click');expect(wrapper.find('[data-testid="studio-asset-failure"]').exists()).toBe(false);expect(wrapper.find('[data-testid="studio-asset-feedback"]').exists()).toBe(false)
})
const imageTask={...prepared,kind:'image' as const,id:'img_'+'b'.repeat(32),offerId:'image-offer',status:'completed' as const,resultCount:0}
async function mixedHistory(){
 sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video',view:'compose'}));api.history.mockImplementation(async(kind:string)=>kind==='image'?[imageTask]:[]);api.catalog.mockImplementation(async(kind:string)=>kind==='image'?[{...offer,offer_id:'image-offer',display_name:'图片专属模型'}]:[offer]);wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-mode-history"]').trigger('click');await flushPromises();await wrapper.get(`[data-task-id="${imageTask.id}"]`).trigger('click');await flushPromises()
}
it('D: continuing image task from video history must load image catalog',async()=>{
 await mixedHistory();await wrapper.get('.studio-header-new').trigger('click');await flushPromises();expect(wrapper.get('[data-testid="studio-mode-text"]').attributes('aria-pressed')).toBe('true');expect(wrapper.get('[data-testid="studio-model-toggle"]').text()).toContain('图片专属模型')
})
it('E: explicit video navigation after selecting image history must stay video',async()=>{
 await mixedHistory();await wrapper.get('[data-testid="studio-mode-video"]').trigger('click');await flushPromises();expect(wrapper.get('[data-testid="studio-mode-video"]').attributes('aria-pressed')).toBe('true')
})
it('F: edit quote return-to-input must preserve edit mode and usable references',async()=>{
 sessionStorage.clear();await compose();await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await pick([imageFile()]);await wrapper.get('[data-testid="studio-prompt"]').setValue('Modify image');api.request.mockImplementation(async(kind:string,action:string)=>action==='quotes'?{quote_token:'synthetic-quote'}:{contract:'published_image_binding_v1',task_id:imageTask.id,status:'prepared',created_at:prepared.createdAt,expires_at:prepared.expiresAt,offer_id:offer.offer_id,model:offer.model,spec:{resolution:'720p',aspect_ratio:'16:9',count:1},sale_price:prepared.price});await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises();expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(true);await wrapper.get('[data-testid="studio-new"]').trigger('click');await flushPromises();expect(wrapper.findAll('[data-testid="studio-asset-success"]')).toHaveLength(1);expect(wrapper.get('[data-testid="studio-mode-edit"]').attributes('aria-pressed')).toBe('true');expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeUndefined()
})
it('G: a returned model must clear its unavailable marker after catalog refresh',async()=>{
 await compose();await wrapper.get('[data-testid="studio-prompt"]').setValue('Video');api.catalog.mockResolvedValueOnce([]);await refreshModels();expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(true);await refreshModels();expect(wrapper.get('[data-testid="studio-model-toggle"]').text()).toContain(offer.display_name);expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(false)
})



it('keeps a successful upload notice when catalog failure recovers',async()=>{
 await compose()
 await pick([imageFile()])
 api.catalog.mockRejectedValueOnce(new Error('offline'))
 await refreshModels()
 expect(notices()).toContain('无法刷新')
 await refreshModels()
 expect(notices()).not.toContain('无法刷新')
 expect(notices()).toContain('素材已私有保存')
 expect(wrapper.findAll('[data-testid="studio-asset-success"]')).toHaveLength(1)
})
it('keeps a readiness error after catalog recovers and clears it only when readiness recovers',async()=>{
 await compose()
 api.request.mockRejectedValueOnce(new Error('offline'))
 await refreshModels()
 expect(notices()).toContain('生成服务状态暂时无法确认')
 await refreshModels()
 expect(notices()).not.toContain('生成服务状态暂时无法确认')
})
it('allows a returned model for new input but never revives its invalidated quote',async()=>{
 wrapper=mount(StudioMediaPanel)
 await flushPromises()
 api.catalog.mockResolvedValueOnce([])
 await refreshModels()
 expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false)
 await refreshModels()
 expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(false)
 await wrapper.get(`[data-task-id="${prepared.id}"]`).trigger('click')
 await flushPromises()
 expect(wrapper.get('[data-testid="studio-generate"]').attributes('disabled')).toBeDefined()
 expect(api.generate).not.toHaveBeenCalled()
})
it('selects the initial model when the first failed catalog load recovers',async()=>{
 api.catalog.mockRejectedValueOnce(new Error('offline'))
 await compose()
 await wrapper.get('[data-testid="studio-prompt"]').setValue('Preserved video input')
 expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined()
 await refreshModels()
 expect(wrapper.get('[data-testid="studio-model-toggle"]').text()).toContain(offer.display_name)
 expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeUndefined()
})
it('keeps mixed history out of the video composer after explicit navigation',async()=>{
 await mixedHistory()
 await wrapper.get('[data-testid="studio-mode-video"]').trigger('click')
 await flushPromises()
 expect(wrapper.get('[data-testid="studio-mode-video"]').attributes('aria-pressed')).toBe('true')
 expect(wrapper.find(`[data-task-id="${imageTask.id}"]`).exists()).toBe(false)
})
it('ignores a late history response after returning to the same creation mode',async()=>{
 await compose()
 let resolve!:(tasks:StudioTask[])=>void
 const pending=new Promise<StudioTask[]>(done=>{resolve=done})
 api.history.mockImplementation((kind:string)=>kind==='image'?pending:Promise.resolve([]))
 await wrapper.get('[data-testid="studio-mode-history"]').trigger('click')
 await wrapper.get('[data-testid="studio-mode-video"]').trigger('click')
 resolve([imageTask])
 await flushPromises()
 expect(wrapper.find(`[data-task-id="${imageTask.id}"]`).exists()).toBe(false)
 expect(wrapper.get('[data-testid="studio-mode-video"]').attributes('aria-pressed')).toBe('true')
})
it('does not let an earlier composer refresh replace a newly opened mixed history',async()=>{
 await compose()
 let resolve!:(tasks:StudioTask[])=>void
 api.history.mockReturnValueOnce(new Promise<StudioTask[]>(done=>{resolve=done}))
 const refresh=wrapper.findAll('button').find(button=>button.text()==='刷新记录')!
 await refresh.trigger('click')
 api.history.mockImplementation(async(kind:string)=>kind==='image'?[imageTask]:[])
 await wrapper.get('[data-testid="studio-mode-history"]').trigger('click')
 await flushPromises()
 expect(wrapper.find(`[data-task-id="${imageTask.id}"]`).exists()).toBe(true)
 resolve([])
 await flushPromises()
 expect(wrapper.find(`[data-task-id="${imageTask.id}"]`).exists()).toBe(true)
})
it.each(['history','task'])('clears composer notices when opening %s without hiding a catalog failure',async(destination)=>{
 api.history.mockResolvedValue([{...prepared,status:'completed',resultCount:0}])
 wrapper=mount(StudioMediaPanel)
 await flushPromises()
 await pick([imageFile()])
 api.catalog.mockRejectedValueOnce(new Error('offline'))
 await refreshModels()
 expect(notices()).toContain('素材已私有保存')
 if(destination==='history')await wrapper.get('[data-testid="studio-mode-history"]').trigger('click')
 else await wrapper.get(`[data-task-id="${prepared.id}"]`).trigger('click')
 await flushPromises()
 expect(notices()).not.toContain('素材已私有保存')
 expect(notices()).toContain('无法刷新')
})
it('does not mark a returned model unavailable again when refreshing its invalidated old quote',async()=>{
 wrapper=mount(StudioMediaPanel)
 await flushPromises()
 await wrapper.get('[data-testid="studio-prompt"]').setValue('New input')
 api.catalog.mockResolvedValueOnce([])
 await refreshModels()
 await refreshModels()
 await wrapper.get(`[data-task-id="${prepared.id}"]`).trigger('click')
 await flushPromises()
 expect(wrapper.get('[data-testid="studio-generate"]').attributes('disabled')).toBeDefined()
 await refreshModels()
 expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false)
 expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(false)
 expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeUndefined()
 expect(api.generate).not.toHaveBeenCalled()
})
