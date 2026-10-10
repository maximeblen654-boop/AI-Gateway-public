import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StudioMediaPanel from '../StudioMediaPanel.vue'
import type { StudioTask } from '@/api/studioMedia'
import type { StudioAssetReceipt } from '@/api/studioAssets'

const api = vi.hoisted(() => ({ session:vi.fn(), catalog:vi.fn(), request:vi.fn(), history:vi.fn(), task:vi.fn(), generate:vi.fn(), upload:vi.fn() }))
vi.mock('@/api/studioMedia', async original => ({ ...await original<typeof import('@/api/studioMedia')>(), ensureStudioSession:api.session, studioCatalog:api.catalog, studioRequest:api.request, studioHistory:api.history, studioTask:api.task, studioGenerate:api.generate, uploadStudioAsset:api.upload }))
const prepared:StudioTask={id:'op_'+'a'.repeat(64),kind:'video',status:'prepared',createdAt:'2026-01-01',expiresAt:'2099-01-01',offerId:'offer',model:'synthetic-video',spec:{resolution:'720p',duration_seconds:5,count:1},price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},resultCount:0}
const offer={offer_id:'offer',model:'synthetic-video',display_name:'合成视频模型',upstream_model:'synthetic-video',spec:{resolution:['720p'],duration_seconds:[5],aspect_ratio:['16:9'],count:{min:1,max:1},references:{image:{min:0,max:1},video:{min:0,max:0},audio:{min:0,max:0},total_max:1}}}
let wrapper:ReturnType<typeof mount>
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();if(typeof URL.createObjectURL!=='function')Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>`blob:studio-asset`)});if(typeof URL.revokeObjectURL!=='function')Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});api.session.mockResolvedValue({owner_id:1});api.catalog.mockResolvedValue([offer]);api.history.mockResolvedValue([prepared]);api.request.mockResolvedValue({paid_enabled:true});api.task.mockImplementation(async t=>t);api.upload.mockImplementation(async (file:File,kind:string)=>({asset_ref:`asset_${'a'.repeat(8)}-0000-0000-0000-000000000000`,kind,mime_type:file.type,size:file.size,duration_seconds:null}))})
afterEach(()=>{wrapper?.unmount();document.body.innerHTML='';vi.useRealTimers()})

const imageFile=(name='reference.png')=>new File(['12345678'],name,{type:'image/png'})
const withImageReferences=(max=3)=>({...offer,spec:{...offer.spec,references:{...offer.spec.references,image:{min:0,max},total_max:max}}})
const receipt=(file:File):StudioAssetReceipt=>({asset_ref:'asset_aaaaaaaa-0000-0000-0000-000000000000',kind:'image',mime_type:file.type,size:file.size,duration_seconds:null})
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(reason:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
async function pick(files:File[]){const input=wrapper.get('[data-testid="studio-asset-input"]');Object.defineProperty(input.element,'files',{value:files,configurable:true});await input.trigger('change');await flushPromises()}
function pasteAt(target:Element,clipboardData:unknown){const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:clipboardData});target.dispatchEvent(event)}

describe('Reference asset input',()=>{
 it('routes picker, drag and image paste through the private uploader and shows thumbnails',async()=>{
  api.catalog.mockResolvedValue([withImageReferences()]);api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel);await flushPromises()
  const input=wrapper.get('[data-testid="studio-asset-input"]'),dropzone=wrapper.get('[data-testid="studio-asset-uploader"]')
  const picked=imageFile('picked.png');Object.defineProperty(input.element,'files',{value:[picked],configurable:true});await input.trigger('change');await flushPromises()
  const dragged=imageFile('dragged.png');await dropzone.trigger('drop',{dataTransfer:{files:[dragged]}});await flushPromises()
  const pasted=imageFile('pasted.png');await dropzone.trigger('paste',{clipboardData:{items:[{kind:'file',type:'image/png',getAsFile:()=>pasted}]}});await flushPromises()
  expect(api.upload).toHaveBeenCalledTimes(3);expect(wrapper.findAll('[data-testid="studio-asset-success"]')).toHaveLength(3);expect(wrapper.findAll('[data-testid="studio-asset-thumbnail"]')).toHaveLength(3)
  await wrapper.get('[data-testid="studio-assets-clear"]').trigger('click');expect(wrapper.find('[data-testid="studio-assets"]').exists()).toBe(false)
 })

 it('keeps a failed item visible and enforces the model count limit before upload',async()=>{
  api.catalog.mockResolvedValue([withImageReferences(1)]);api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel);await flushPromises()
  const input=wrapper.get('[data-testid="studio-asset-input"]'),first=imageFile('first.png');Object.defineProperty(input.element,'files',{value:[first],configurable:true});await input.trigger('change');await flushPromises()
  const second=imageFile('second.png');Object.defineProperty(input.element,'files',{value:[second],configurable:true});await input.trigger('change');await flushPromises()
  expect(api.upload).toHaveBeenCalledTimes(1);expect(wrapper.find('[data-testid="studio-asset-failure"]').exists()).toBe(true);expect(wrapper.text()).toContain('上传失败')
  const failed=wrapper.find('[data-testid="studio-asset-failure"] button');await failed.trigger('click');expect(wrapper.find('[data-testid="studio-asset-failure"]').exists()).toBe(false)
 })

 it('ignores non-image clipboard content without reading text or uploading',async()=>{
  api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel);await flushPromises();const getAsFile=vi.fn();await wrapper.get('[data-testid="studio-asset-uploader"]').trigger('paste',{clipboardData:{items:[{kind:'string',type:'text/plain',getAsFile}]}});await flushPromises();expect(getAsFile).not.toHaveBeenCalled();expect(api.upload).not.toHaveBeenCalled()
 })

 it('handles each bubbling panel or body image paste once without requesting a quote',async()=>{
  api.catalog.mockResolvedValue([withImageReferences()]);api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel,{attachTo:document.body});await flushPromises();api.request.mockClear()
  const file=imageFile(),getAsFile=vi.fn(()=>file),clipboardData={items:[{kind:'file',type:'image/png',getAsFile}]}
  pasteAt(wrapper.get('[data-testid="studio-asset-uploader"]').element,clipboardData);await flushPromises();expect(getAsFile).toHaveBeenCalledTimes(1);expect(api.upload).toHaveBeenCalledTimes(1)
  pasteAt(document.body,clipboardData);await flushPromises();expect(getAsFile).toHaveBeenCalledTimes(2);expect(api.upload).toHaveBeenCalledTimes(2)
  expect(api.request).not.toHaveBeenCalled();expect(api.generate).not.toHaveBeenCalled()
 })

 it.each(['success','failure'])('renders each pending upload changing to %s while another stays pending',async outcome=>{
  api.catalog.mockResolvedValue([withImageReferences()]);api.history.mockResolvedValue([]);const pending=[deferred<StudioAssetReceipt>(),deferred<StudioAssetReceipt>(),deferred<StudioAssetReceipt>()]
  pending.forEach(value=>api.upload.mockReturnValueOnce(value.promise));wrapper=mount(StudioMediaPanel);await flushPromises();const files=[imageFile('one.png'),imageFile('two.png'),imageFile('three.png')];await pick(files)
  expect(wrapper.findAll('[data-testid="studio-asset-pending"]')).toHaveLength(3)
  for(const index of [0,1]){if(outcome==='success')pending[index]!.resolve(receipt(files[index]!));else pending[index]!.reject(new Error('asset_upload_failed'));await flushPromises();expect(wrapper.findAll(`[data-testid="studio-asset-${outcome}"]`)).toHaveLength(index+1)}
  expect(wrapper.findAll('[data-testid="studio-asset-pending"]')).toHaveLength(1);pending[2]!.resolve(receipt(files[2]!));await flushPromises()
 })

 it('removes and aborts an uploading item without restoring it on late completion',async()=>{
  api.history.mockResolvedValue([]);const pending=deferred<StudioAssetReceipt>();api.upload.mockReturnValueOnce(pending.promise);wrapper=mount(StudioMediaPanel);await flushPromises();const file=imageFile();await pick([file])
  const signal=api.upload.mock.calls[0]![2] as AbortSignal;await wrapper.get('[data-testid="studio-asset-pending"] button').trigger('click');expect(signal.aborted).toBe(true);expect(wrapper.find('[data-testid="studio-assets"]').exists()).toBe(false)
  pending.resolve(receipt(file));await flushPromises();expect(wrapper.find('[data-testid="studio-assets"]').exists()).toBe(false);expect(URL.revokeObjectURL).toHaveBeenCalled()
 })

 it.each(['remove','clear','unmount'])('does not start an upload after %s while its session is pending',async action=>{
  api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel);await flushPromises();const session=deferred<{owner_id:number}>();api.session.mockReturnValueOnce(session.promise);await pick([imageFile()]);expect(wrapper.find('[data-testid="studio-asset-pending"]').exists()).toBe(true)
  if(action==='unmount')wrapper.unmount();else await wrapper.get(action==='clear'?'[data-testid="studio-assets-clear"]':'[data-testid="studio-asset-pending"] button').trigger('click')
  session.resolve({owner_id:1});await flushPromises();expect(api.upload).not.toHaveBeenCalled();expect(URL.revokeObjectURL).toHaveBeenCalled()
 })

 it.each(['clear','unmount'])('aborts outstanding requests on %s',async action=>{
  api.catalog.mockResolvedValue([withImageReferences()]);api.history.mockResolvedValue([]);const pending=deferred<StudioAssetReceipt>();api.upload.mockReturnValue(pending.promise);wrapper=mount(StudioMediaPanel);await flushPromises();const files=[imageFile('one.png'),imageFile('two.png')];await pick(files)
  const signals=api.upload.mock.calls.map(call=>call[2] as AbortSignal);if(action==='unmount')wrapper.unmount();else await wrapper.get('[data-testid="studio-assets-clear"]').trigger('click');expect(signals.every(signal=>signal.aborted)).toBe(true)
  pending.resolve(receipt(files[0]!));await flushPromises();expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
 })

 it('ignores pasted URLs without reading any text or fetching them',async()=>{
  api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel,{attachTo:document.body});await flushPromises();api.request.mockClear();const getData=vi.fn(()=> 'https://example.com/reference.png'),getAsFile=vi.fn(),getAsString=vi.fn()
  const clipboardData={items:[{kind:'string',type:'text/uri-list',getAsFile,getAsString}],files:[],getData};pasteAt(document.body,clipboardData);await flushPromises();expect(getData).not.toHaveBeenCalled();expect(getAsString).not.toHaveBeenCalled();expect(getAsFile).not.toHaveBeenCalled();expect(api.upload).not.toHaveBeenCalled();expect(api.request).not.toHaveBeenCalled();expect(api.generate).not.toHaveBeenCalled()
 })

 it.each([['invalid_local_asset','类型或大小'],['file_changed','文件发生变化']])('shows an upload-specific error for %s',async(code,message)=>{
  api.history.mockResolvedValue([]);api.upload.mockRejectedValueOnce(new Error(code));wrapper=mount(StudioMediaPanel);await flushPromises();await pick([imageFile()]);expect(wrapper.get('[data-testid="studio-asset-failure"]').text()).toContain(message);expect(wrapper.text()).not.toContain('若已点击生成')
 })
})
describe('Published customer task confirmation and recovery',()=>{
 it.each(['unknown','billing_pending'])('keeps %s pending and never infers a paid amount from the quote',async status=>{
  const task={...prepared,kind:'image' as const,status,spec:{count:5},quantity:5,price:{amount:'3.50',currency:'CNY',billing_mode:'per_request'},billingState:'billing_unknown'};
  api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises();
  expect(wrapper.get('[data-testid="studio-settlement"]').text()).toContain('待结算');expect(wrapper.get('[data-testid="studio-settlement"]').text()).not.toContain('3.50');
  expect(wrapper.find('[data-testid="studio-new"]').exists()).toBe(false);expect(wrapper.find('[data-testid="studio-generate"]').exists()).toBe(false);
  await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises();expect(api.generate).not.toHaveBeenCalled();
 });
 it('delivers a settled partial task without repricing or resubmission across refresh and remount',async()=>{
  const task={...prepared,id:'img_'+'b'.repeat(32),kind:'image' as const,status:'partial',spec:{count:5},quantity:5,price:{amount:'3.50',currency:'CNY',billing_mode:'per_request'},unitPrice:{amount:'0.70',currency:'CNY',billing_mode:'per_request'},expectedCount:5,deliveredCount:2,failedCount:3,pendingCount:0,resultCount:2,billingState:'billed',settledPrice:{amount:'1.40',currency:'CNY',billing_mode:'per_request'}}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',id:task.id,attempted:[]}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.get('[data-testid="studio-status"]').text()).toContain('部分完成')
  expect(wrapper.get('[data-testid="studio-partial-counts"]').text()).toContain('已交付 2')
  expect(wrapper.get('[data-testid="studio-price"]').text()).toContain('3.50 CNY')
  expect(wrapper.get('[data-testid="studio-settlement"]').text()).toContain('1.40 CNY')
  expect(wrapper.findAll('[data-testid="studio-download"]')).toHaveLength(2)
  await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises();wrapper.unmount();wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.findAll('[data-testid="studio-download"]')).toHaveLength(2);expect(api.generate).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="studio-new"]').trigger('click');expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false);expect(api.generate).not.toHaveBeenCalled()
 })
 it('shows unit price only when a historical receipt contains an explicit unit price',async()=>{
  const oldImage={...prepared,kind:'image' as const,spec:{count:4},quantity:4};api.history.mockResolvedValue([oldImage]);wrapper=mount(StudioMediaPanel);await flushPromises();expect(wrapper.get('[data-testid="studio-price"]').text()).not.toContain('×');wrapper.unmount()
  api.history.mockResolvedValue([{...oldImage,unitPrice:{amount:'0.20',currency:'CNY',billing_mode:'per_request'}}]);wrapper=mount(StudioMediaPanel);await flushPromises();expect(wrapper.get('[data-testid="studio-price"]').text()).toContain('0.20 × 4')
 })
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
