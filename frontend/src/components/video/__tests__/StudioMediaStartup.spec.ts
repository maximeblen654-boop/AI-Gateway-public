import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import StudioMediaPanel from '../StudioMediaPanel.vue'

const api=vi.hoisted(()=>({session:vi.fn(),catalog:vi.fn(),history:vi.fn(),request:vi.fn()}))
vi.mock('@/api/studioMedia',async original=>({...await original<typeof import('@/api/studioMedia')>(),ensureStudioSession:api.session,studioCatalog:api.catalog,studioHistory:api.history,studioRequest:api.request}))
let wrapper:ReturnType<typeof mount>
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();api.catalog.mockResolvedValue([]);api.history.mockResolvedValue([]);api.request.mockResolvedValue({paid_enabled:false})})
afterEach(()=>{wrapper?.unmount()})
function pendingSession(){let resolve!:(value:{owner_id:number})=>void;const promise=new Promise<{owner_id:number}>(done=>{resolve=done});api.session.mockReturnValue(promise);return resolve}

it('keeps every mode disabled until initial identity and restored mode are ready',async()=>{
 const resolve=pendingSession();sessionStorage.setItem('studio-media-view-7',JSON.stringify({kind:'video',view:'compose'}))
 wrapper=mount(StudioMediaPanel);await flushPromises()
 for(const mode of ['text','edit','video','history'])expect(wrapper.get(`[data-testid="studio-mode-${mode}"]`).attributes('disabled')).toBeDefined()
 expect(api.catalog).not.toHaveBeenCalled();resolve({owner_id:7});await flushPromises()
 expect(api.catalog).toHaveBeenCalledTimes(1);expect(api.catalog).toHaveBeenCalledWith('video');expect(wrapper.get('[data-testid="studio-mode-video"]').attributes('aria-pressed')).toBe('true')
 expect(wrapper.get('[data-testid="studio-mode-video"]').attributes('disabled')).toBeUndefined()
})
it('releases initial loading after an authentication failure without claiming the gate is closed',async()=>{
 api.session.mockRejectedValue(new Error('unavailable'));wrapper=mount(StudioMediaPanel);await flushPromises()
 expect(wrapper.get('[data-testid="studio-error"]').exists()).toBe(true);expect(wrapper.get('[data-testid="studio-mode-text"]').attributes('disabled')).toBeUndefined()
 expect(wrapper.find('[data-testid="studio-gate"]').exists()).toBe(false);expect(api.catalog).not.toHaveBeenCalled()
})
it('does not start catalog, history or readiness after unmounting during bootstrap',async()=>{
 const resolve=pendingSession();wrapper=mount(StudioMediaPanel);await flushPromises();wrapper.unmount();resolve({owner_id:7});await flushPromises()
 expect(api.catalog).not.toHaveBeenCalled();expect(api.history).not.toHaveBeenCalled();expect(api.request).not.toHaveBeenCalled()
})

async function imageGallery(){
 api.session.mockResolvedValue({owner_id:7});api.history.mockImplementation(async(kind:string)=>kind==='image'?[{id:'img_'+'1'.repeat(32),kind:'image',status:'completed',createdAt:'2026-10-20',expiresAt:'2099-01-01',offerId:'synthetic-image',model:'Synthetic image',spec:{count:1},price:{amount:'1',currency:'CNY',billing_mode:'per_request'},resultCount:1}]:[])
 wrapper=mount(StudioMediaPanel);await flushPromises();return wrapper.findAll('.studio-work-preview img').map(item=>item.element)
}
it('releases leaving preview readers only within its own panel on a cross-media switch',async()=>{
 const images=await imageGallery();expect(images).toHaveLength(1);images.forEach(image=>expect(image.getAttribute('src')).toContain('/results/0'))
 const otherPanel=document.createElement('div');otherPanel.className='studio-work-preview';const external=document.createElement('img');external.src='/unrelated-preview';otherPanel.append(external);document.body.append(otherPanel)
 try{await wrapper.get('[data-testid="studio-mode-video"]').trigger('click');await flushPromises();images.forEach(image=>expect(image.hasAttribute('src')).toBe(false));expect(external.getAttribute('src')).toBe('/unrelated-preview');expect(api.request.mock.calls.every(call=>call[1]==='readiness')).toBe(true)}finally{otherPanel.remove()}
})
it('keeps current image previews bound when switching between text and edit modes',async()=>{
 const images=await imageGallery(),urls=images.map(image=>image.getAttribute('src'))
 await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await flushPromises();expect(images.map(image=>image.getAttribute('src'))).toEqual(urls)
})
it('releases preview readers before the component DOM is removed',async()=>{
 const images=await imageGallery();wrapper.unmount();images.forEach(image=>expect(image.hasAttribute('src')).toBe(false))
})
