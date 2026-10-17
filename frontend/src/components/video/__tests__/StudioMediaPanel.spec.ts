import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StudioMediaPanel from '../StudioMediaPanel.vue'
import StudioSpecPicker from '../StudioSpecPicker.vue'
import { StudioError, type StudioTask } from '@/api/studioMedia'
import type { StudioAssetReceipt } from '@/api/studioAssets'

const api = vi.hoisted(() => ({ session:vi.fn(), catalog:vi.fn(), request:vi.fn(), history:vi.fn(), task:vi.fn(), generate:vi.fn(), upload:vi.fn() }))
vi.mock('@/api/studioMedia', async original => ({ ...await original<typeof import('@/api/studioMedia')>(), ensureStudioSession:api.session, studioCatalog:api.catalog, studioRequest:api.request, studioHistory:api.history, studioTask:api.task, studioGenerate:api.generate, uploadStudioAsset:api.upload }))
const prepared:StudioTask={id:'op_'+'a'.repeat(64),kind:'video',status:'prepared',createdAt:'2026-01-01',expiresAt:'2099-01-01',offerId:'offer',model:'synthetic-video',spec:{resolution:'720p',duration_seconds:5,count:1},price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},resultCount:0}
const offer={offer_id:'offer',model:'synthetic-video',display_name:'合成视频模型',upstream_model:'synthetic-video',spec:{resolution:['720p'],duration_seconds:[5],aspect_ratio:['16:9'],count:{min:1,max:1},references:{image:{min:0,max:1},video:{min:0,max:0},audio:{min:0,max:0},total_max:1}}}
let wrapper:ReturnType<typeof mount>
async function quantityChoices() { if(wrapper.get('[data-testid="studio-count"]').attributes('aria-expanded') !== 'true') await wrapper.get('[data-testid="studio-count"]').trigger('click'); return wrapper.findAll('#studio-count-menu [data-value]') }
async function chooseQuantity(value: number) { await quantityChoices(); await wrapper.get(`#studio-count-menu [data-value="${value}"]`).trigger('click') }
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video'}));if(typeof URL.createObjectURL!=='function')Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>`blob:studio-asset`)});if(typeof URL.revokeObjectURL!=='function')Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});api.session.mockResolvedValue({owner_id:1});api.catalog.mockResolvedValue([offer]);api.history.mockResolvedValue([prepared]);api.request.mockResolvedValue({paid_enabled:true});api.task.mockImplementation(async t=>t);api.upload.mockImplementation(async (file:File,kind:string)=>({asset_ref:`asset_${'a'.repeat(8)}-0000-0000-0000-000000000000`,kind,mime_type:file.type,size:file.size,duration_seconds:null}))})
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
 it('hides only finalized failed history until the administrator explicitly shows it',async()=>{
  const failed={...prepared,id:'op_'+'f'.repeat(64),status:'failed',billingState:'not_charged'}
  const processing={...prepared,id:'op_'+'p'.repeat(64),status:'processing',billingState:'pending'}
  const completed={...prepared,id:'op_'+'c'.repeat(64),status:'completed',resultCount:1,billingState:'billed'}
  api.history.mockResolvedValue([failed,processing,completed]);wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-mode-history"]').trigger('click');await flushPromises()
  expect(wrapper.get('[data-testid="studio-failed-toggle"]').text()).toContain('显示失败任务（1）')
  expect(wrapper.find(`[data-task-id="${failed.id}"]`).exists()).toBe(false)
  expect(wrapper.find(`[data-task-id="${processing.id}"]`).exists()).toBe(true)
  await wrapper.get('[data-testid="studio-failed-toggle"]').trigger('click')
  expect(wrapper.get('[data-testid="studio-failed-toggle"]').text()).toContain('隐藏失败任务（1）')
  expect(wrapper.find(`[data-task-id="${failed.id}"]`).exists()).toBe(true)
 })

 it.each(['unknown','billing_pending'])('keeps %s pending and never infers a paid amount from the quote',async status=>{
  const task={...prepared,kind:'image' as const,status,spec:{count:5},quantity:5,price:{amount:'3.50',currency:'CNY',billing_mode:'per_request'},billingState:'billing_unknown'};
  api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises();
  expect(wrapper.get('[data-testid="studio-settlement"]').text()).toContain('待结算');expect(wrapper.get('[data-testid="studio-settlement"]').text()).not.toContain('3.50');
  expect(wrapper.find('[data-testid="studio-new"]').exists()).toBe(true);expect(wrapper.find('[data-testid="studio-generate"]').exists()).toBe(false);
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
   expect(wrapper.get('[data-testid="studio-download"]').attributes('href')).toContain(prepared.id);expect(wrapper.text()).toContain('仍可查询原任务');expect(wrapper.find('[data-testid="studio-gate"]').exists()).toBe(false);expect(api.generate).not.toHaveBeenCalled()
 })
 it('an older history refresh cannot overwrite a newly selected media type',async()=>{
  wrapper=mount(StudioMediaPanel);await flushPromises()
  let finish!:(tasks:StudioTask[])=>void;const image:StudioTask={...prepared,kind:'image',id:'img_'+'b'.repeat(32)}
  api.history.mockReturnValueOnce(new Promise<StudioTask[]>(r=>{finish=r})).mockResolvedValueOnce([image])
  await wrapper.findAll('button').find(b=>b.text()==='刷新记录')!.trigger('click');await wrapper.get('[data-testid="studio-mode-text"]').trigger('click');await flushPromises()
  finish([prepared]);await flushPromises();expect(wrapper.findAll('[data-task-id]').map(b=>b.attributes('data-task-id'))).toEqual([image.id]);expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false)
 })
 it('selecting another historical task during a query eventually queries the new identity',async()=>{
  const second={...prepared,id:'op_'+'b'.repeat(64)};api.history.mockResolvedValue([prepared,second]);wrapper=mount(StudioMediaPanel);await flushPromises()
  let finish!:(task:StudioTask)=>void;api.task.mockReturnValueOnce(new Promise<StudioTask>(r=>{finish=r}))
  await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await wrapper.get(`[data-task-id="${second.id}"]`).trigger('click');finish(prepared);await flushPromises()
  expect(api.task).toHaveBeenLastCalledWith(second);expect(wrapper.get('[data-testid="studio-task-id"]').text()).toContain(second.id);expect(api.generate).not.toHaveBeenCalled()
 })
})


describe('Customer image purchase quantity',()=>{
 async function imageSetup(range={min:1,max:10}) {
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image'}))
  api.history.mockResolvedValue([])
  api.catalog.mockResolvedValue([{...offer,model:'synthetic-image',spec:{...offer.spec,count:range}}])
  wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-prompt"]').setValue('morning light');api.request.mockClear()
 }
 it.each(['0','11','1000000','1.5',''])('blocks invalid quantity %s before requesting a quote',async value=>{
  await imageSetup()
  // Bypass the picker to verify the quote action guard independently of its options.
  wrapper.findAllComponents(StudioSpecPicker).find(c=>c.props('id')==='studio-count')!.vm.$emit('update:modelValue',Number(value))
  await flushPromises()
  expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined()
  expect(wrapper.get('[data-testid="studio-count-error"]').text()).toContain('数量')
  // Even if a caller bypasses the disabled button, no invalid quote is sent.
  ;(wrapper.get('[data-testid="studio-quote"]').element as HTMLButtonElement).disabled=false
  await wrapper.get('[data-testid="studio-quote"]').trigger('click')
  expect(api.request).not.toHaveBeenCalled();expect(api.generate).not.toHaveBeenCalled()
 })
 it('offers only 1 to 10 and preserves a lower published product limit',async()=>{
  await imageSetup();expect((await quantityChoices()).map(o=>o.attributes('data-value'))).toEqual(Array.from({length:10},(_,i)=>String(i+1)))
  await chooseQuantity(10);expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeUndefined()
  wrapper.unmount();await imageSetup({min:1,max:3})
  expect((await quantityChoices()).map(o=>o.attributes('data-value'))).toEqual(['1','2','3'])
 })
 it('does not present an invalid catalog range as purchasable',async()=>{
  await imageSetup({min:1,max:100});expect(await quantityChoices()).toHaveLength(0)
  expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined();expect(api.request).not.toHaveBeenCalled()
 })
 it('sends selected image quantity to the existing server quote endpoint',async()=>{
  await imageSetup();await chooseQuantity(10)
  api.request.mockRejectedValueOnce(new Error('stop after inspecting quote'))
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(api.request).toHaveBeenCalledTimes(1);expect(api.request).toHaveBeenCalledWith('image','quotes',expect.objectContaining({spec:expect.objectContaining({count:10})}));expect(api.generate).not.toHaveBeenCalled()
 })
 it('keeps video quantity fixed with no image quantity selector',async()=>{
  api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.find('[data-testid="studio-count"]').exists()).toBe(false)
  await wrapper.get('[data-testid="studio-prompt"]').setValue('a quiet cafe');api.request.mockClear();api.request.mockRejectedValueOnce(new Error('stop after inspecting quote'))
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(api.request).toHaveBeenCalledTimes(1);expect(api.request.mock.calls[0]?.[0]).toBe('video');expect(api.generate).not.toHaveBeenCalled()
 })
})


describe('Artwork desk navigation',()=>{
 async function setup(){sessionStorage.clear();api.history.mockResolvedValue([]);api.catalog.mockResolvedValue([{...offer,display_name:'图片商品',spec:{...offer.spec,count:{min:1,max:10}}}]);wrapper=mount(StudioMediaPanel,{attachTo:document.body});await flushPromises()}
 it('starts with text-to-image, a bounded quantity and no attachment button',async()=>{await setup();expect(wrapper.get('[data-testid="studio-mode-text"]').attributes('aria-pressed')).toBe('true');expect(wrapper.find('[data-testid="studio-attachment"]').exists()).toBe(false);expect(wrapper.get('[data-testid="studio-quote"]').text()).toContain('开始生成');expect(await quantityChoices()).toHaveLength(10);expect(wrapper.findAll('svg.studio-mark')).toHaveLength(2)})
 it('requires a reference for edit while preserving independent output count',async()=>{await setup();await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await chooseQuantity(5);await wrapper.get('[data-testid="studio-prompt"]').setValue('change background');expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined();await pick([imageFile()]);api.request.mockClear();api.request.mockRejectedValueOnce(new Error('inspect'));await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises();expect(api.request).toHaveBeenCalledWith('image','quotes',expect.objectContaining({spec:expect.objectContaining({count:5,images:1})}));expect(api.generate).not.toHaveBeenCalled()})
 it('switching explicitly to text removes references but preserves prompt and output count',async()=>{await setup();await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await chooseQuantity(5);await wrapper.get('[data-testid="studio-prompt"]').setValue('keep this prompt');await pick([imageFile()]);await wrapper.get('[data-testid="studio-mode-text"]').trigger('click');expect(wrapper.find('[data-testid="studio-attachment"]').exists()).toBe(false);expect(wrapper.find('[data-testid="studio-asset-success"]').exists()).toBe(false);expect((wrapper.get('[data-testid="studio-prompt"]').element as HTMLTextAreaElement).value).toBe('keep this prompt');expect(wrapper.get('[data-testid="studio-count"]').text()).toContain('5 张');api.request.mockClear();api.request.mockRejectedValueOnce(new Error('inspect'));await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises();expect(api.request).toHaveBeenCalledWith('image','quotes',expect.objectContaining({spec:expect.objectContaining({count:5,images:0})}));expect(api.generate).not.toHaveBeenCalled()})
 it('keeps model selection within offered reference capabilities',async()=>{sessionStorage.clear();api.history.mockResolvedValue([]);api.catalog.mockResolvedValue([{...offer,offer_id:'text-only',spec:{...offer.spec,references:{...offer.spec.references,image:{min:0,max:0},total_max:0}}},{...offer,offer_id:'edit-required',spec:{...offer.spec,references:{...offer.spec.references,image:{min:1,max:2},total_max:2}}}]);wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click');expect(wrapper.findAll('#studio-offer [data-offer-id]').map(o=>o.attributes('data-offer-id'))).toEqual(['text-only']);await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click');expect(wrapper.findAll('#studio-offer [data-offer-id]').map(o=>o.attributes('data-offer-id'))).toEqual(['edit-required']);expect(api.generate).not.toHaveBeenCalled()})
 it('shows saved works without locking a new visit to a completed task',async()=>{sessionStorage.clear();api.history.mockResolvedValue([{...prepared,kind:'image',status:'completed',resultCount:1}]);wrapper=mount(StudioMediaPanel);await flushPromises();expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false);expect(wrapper.findAll('[data-task-id]')).toHaveLength(1);expect(api.task).not.toHaveBeenCalled()})
  it('opens a completed history card without querying Core again',async()=>{sessionStorage.clear();const task={...prepared,kind:'image' as const,status:'completed',billingState:'billed',resultCount:1};api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get(`[data-task-id="${task.id}"]`).trigger('click');await flushPromises();expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(true);expect(api.task).not.toHaveBeenCalled()})
 it('opens and closes the ratio selector using Escape and restores focus',async()=>{await setup();await wrapper.get('[data-testid="studio-ratio-toggle"]').trigger('click');expect(wrapper.find('#studio-ratio-menu').exists()).toBe(true);await wrapper.get('#studio-ratio-menu button').trigger('keydown',{key:'Escape'});await flushPromises();expect(wrapper.get('[data-testid="studio-ratio-toggle"]').attributes('aria-expanded')).toBe('false');expect(document.activeElement).toBe(wrapper.get('[data-testid="studio-ratio-toggle"]').element)})
 it('keeps unavailable originals separate from completed billing and retries only a read',async()=>{sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',id:prepared.id}));api.history.mockResolvedValue([{...prepared,kind:'image',status:'completed',resultCount:1}]);wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-result-image"]').trigger('error');expect(wrapper.find('[data-testid="studio-download"]').exists()).toBe(false);expect(wrapper.text()).toContain('原片暂不可用');const oldImage=wrapper.get('[data-testid="studio-result-image"]').element;await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises();expect(wrapper.get('[data-testid="studio-result-image"]').element).not.toBe(oldImage);await wrapper.get('[data-testid="studio-result-image"]').trigger('load');expect(wrapper.get('[data-testid="studio-download"]').exists()).toBe(true);expect(api.generate).not.toHaveBeenCalled()})
 it('does not create a replacement when an unresolved task mode is clicked',async()=>{sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image'}));api.history.mockResolvedValue([{...prepared,kind:'image',status:'unknown'}]);wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false);expect(wrapper.get('[data-testid="studio-prompt"]').isVisible()).toBe(true);expect(wrapper.get('[data-testid="studio-history"]').text()).toContain('结果待确认');expect(api.generate).not.toHaveBeenCalled()})
})

describe('Unresolved tasks do not lock creation',()=>{
 it('opens text and edit with an unknown image task retained in history',async()=>{
  const task={...prepared,id:'img_'+'c'.repeat(32),kind:'image' as const,status:'unknown'}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',id:task.id}));api.catalog.mockResolvedValue([withImageReferences()]);api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-mode-text"]').trigger('click');await flushPromises();expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false)
  await wrapper.get('[data-testid="studio-prompt"]').setValue('new independent idea');await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await flushPromises()
  expect(wrapper.get('[data-testid="studio-attachment"]').isVisible()).toBe(true);expect(wrapper.find(`[data-task-id="${task.id}"]`).exists()).toBe(true)
  wrapper.unmount();wrapper=mount(StudioMediaPanel);await flushPromises();expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false);expect(api.generate).not.toHaveBeenCalled()
 })
 it('reports query progress, unchanged state and persistent failure',async()=>{
  const task={...prepared,status:'unknown'};api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises();const query=deferred<StudioTask>();api.task.mockReturnValueOnce(query.promise)
  await wrapper.get('[data-testid="studio-refresh"]').trigger('click');expect(wrapper.get('[data-testid="studio-refresh"]').attributes('aria-busy')).toBe('true');expect(wrapper.get('[data-testid="studio-refresh"]').text()).toContain('查询中')
  query.resolve(task);await flushPromises();expect(wrapper.get('[data-testid="studio-query-feedback"]').text()).toContain('暂无新结果');expect(wrapper.get('[data-testid="studio-query-feedback"] time').attributes('datetime')).toBeTruthy()
  api.task.mockRejectedValueOnce(new Error('network'));await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises();expect(wrapper.get('[data-testid="studio-query-error"]').text()).toContain('查询未完成');expect(api.generate).not.toHaveBeenCalled()
 })
 it('allows editing during a pending POST and a late response never reopens task detail',async()=>{
  wrapper=mount(StudioMediaPanel);await flushPromises();const dispatch=deferred<StudioTask>();api.generate.mockReturnValueOnce(dispatch.promise);await wrapper.get('[data-testid="studio-generate"]').trigger('click')
  expect(wrapper.get('[data-testid="studio-waiting"]').text()).toContain('提交处理中');await wrapper.get('[data-testid="studio-new"]').trigger('click');await wrapper.get('[data-testid="studio-prompt"]').setValue('next task')
  dispatch.resolve({...prepared,status:'completed',resultCount:1});await flushPromises();expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false);expect(wrapper.get('[data-testid="studio-prompt"]').element).toHaveProperty('value','next task');expect(wrapper.find(`[data-task-id="${prepared.id}"]`).exists()).toBe(true);expect(api.generate).toHaveBeenCalledTimes(1)
 })
})


describe('Task-local asynchronous feedback',()=>{
 it('submits two explicit identities and prices without cross-updating the active task',async()=>{
  wrapper=mount(StudioMediaPanel);await flushPromises();const first=deferred<StudioTask>(),secondResponse=deferred<StudioTask>();api.generate.mockReturnValueOnce(first.promise).mockReturnValueOnce(secondResponse.promise)
  await wrapper.get('[data-testid="studio-generate"]').trigger('click');await wrapper.get('[data-testid="studio-new"]').trigger('click');await wrapper.get('[data-testid="studio-prompt"]').setValue('second independent task')
  const second={...prepared,id:'op_'+'d'.repeat(64),price:{...prepared.price,amount:'1.20'}}
  api.request.mockResolvedValueOnce({contract:'account_video_v1',operation_id:second.id,model:second.model,status:'prepared',created_at:second.createdAt,expires_at:second.expiresAt,offer_id:second.offerId,spec:second.spec,sale_price:second.price})
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises();await wrapper.get('[data-testid="studio-generate"]').trigger('click')
  first.resolve({...prepared,status:'completed',resultCount:1});await flushPromises();expect(wrapper.get('[data-testid="studio-task-id"]').text()).toContain(second.id);expect(wrapper.get('[data-testid="studio-price"]').text()).toContain('1.20')
  secondResponse.resolve({...second,status:'completed',resultCount:1});await flushPromises();expect(wrapper.findAll('[data-task-id]')).toHaveLength(2);expect(api.generate.mock.calls.map(c=>c[0].id)).toEqual([prepared.id,second.id])
  await wrapper.get(`[data-task-id="${prepared.id}"]`).trigger('click');await flushPromises();expect(wrapper.get('[data-testid="studio-price"]').text()).toContain('0.80');expect(api.generate).toHaveBeenCalledTimes(2)
 })
 it('does not automatically poll unknown outcomes',async()=>{
  vi.useFakeTimers();api.history.mockResolvedValue([{...prepared,status:'unknown'}]);wrapper=mount(StudioMediaPanel);await flushPromises();api.task.mockClear();await vi.advanceTimersByTimeAsync(120000);expect(api.task).not.toHaveBeenCalled();expect(api.generate).not.toHaveBeenCalled();expect(wrapper.get('[data-testid="studio-waiting"]').text()).toContain('不等于仍在正常生成')
 })
 it('bounds known-state refreshes and stops polling after a visible query failure',async()=>{
  vi.useFakeTimers();api.history.mockResolvedValue([{...prepared,status:'processing'}]);wrapper=mount(StudioMediaPanel);await flushPromises();api.task.mockClear();await vi.advanceTimersByTimeAsync(180000);expect(api.task).toHaveBeenCalledTimes(12)
  api.task.mockRejectedValueOnce(new Error('query failed'));await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises();api.task.mockClear();await vi.advanceTimersByTimeAsync(60000);expect(api.task).not.toHaveBeenCalled();expect(wrapper.get('[data-testid="studio-query-error"]').text()).toContain('查询未完成');expect(api.generate).not.toHaveBeenCalled()
 })
 it('shows elapsed long-wait feedback but keeps creation available',async()=>{
  vi.useFakeTimers();wrapper=mount(StudioMediaPanel);await flushPromises();const pending=deferred<StudioTask>();api.generate.mockReturnValueOnce(pending.promise);await wrapper.get('[data-testid="studio-generate"]').trigger('click');await vi.advanceTimersByTimeAsync(61000);expect(wrapper.get('[data-testid="studio-elapsed"]').text()).toContain('1 分');expect(wrapper.get('[data-testid="studio-waiting"]').text()).toContain('仍未返回');expect(wrapper.get('[data-testid="studio-new"]').attributes('disabled')).toBeUndefined();pending.resolve({...prepared,status:'unknown'});await flushPromises()
 })
})


describe('Explicit HTTP failure finality',()=>{
 it('shows no charge and the fixed reason without claiming a supplier refund',async()=>{
  const task={...prepared,id:'img_'+'d'.repeat(32),kind:'image' as const,status:'failed',billingState:'not_charged',failureCode:'upstream_http_502_no_delivery',resultCount:0}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.text()).toContain('生成失败，未收费');expect(wrapper.get('[data-testid="studio-http-failure"]').text()).toContain('HTTP 502');expect(wrapper.text()).not.toContain('供应商已退款')
  await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises();expect(api.generate).not.toHaveBeenCalled();expect(wrapper.get('[data-testid="studio-settlement"]').text()).toContain('未收费')
 })
})


describe('Catalog lifecycle changes preserve customer work',()=>{
 const other={...offer,offer_id:'other-offer',model:'other-model',display_name:'另一个模型'}
 async function composer(){api.history.mockResolvedValue([{...prepared,status:'completed',resultCount:1}]);wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-prompt"]').setValue('保留我的画面描述');await pick([imageFile('keep.png')])}
 it('preserves prompt, upload, mode and history when the selected offer disappears without selecting its replacement',async()=>{
  await composer();api.catalog.mockResolvedValue([other]);api.request.mockClear()
  await wrapper.get('[data-testid="studio-refresh-models"]').trigger('click');await flushPromises()
  expect(wrapper.get('[data-testid="studio-model-unavailable"]').text()).toBe('此模型暂不可用，请选择其他模型')
  expect(wrapper.get('[data-testid="studio-prompt"]').element).toHaveProperty('value','保留我的画面描述')
  expect(wrapper.get('[data-testid="studio-asset-success"]').text()).toContain('keep.png')
  expect(wrapper.get('[data-testid="studio-mode-video"]').attributes('aria-pressed')).toBe('true')
  expect(wrapper.find(`[data-task-id="${prepared.id}"]`).exists()).toBe(true)
  expect(wrapper.get('[data-testid="studio-model-toggle"]').text()).not.toContain('另一个模型')
  expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined()
  expect(api.request).toHaveBeenCalledTimes(1);expect(api.generate).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="studio-prompt"]').setValue('继续编辑描述')
  await wrapper.get('[data-testid="studio-assets-clear"]').trigger('click')
  expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(true)
  await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click')
  await wrapper.get('[data-offer-id="other-offer"]').trigger('click');await flushPromises()
  expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(false)
  expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeUndefined()
  expect(api.generate).not.toHaveBeenCalled();expect(api.request).toHaveBeenCalledTimes(1)
 })
 it('dismisses the old quote confirmation and blocks that quote even after selecting it from history',async()=>{
  api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-prompt"]').setValue('保留报价输入')
  api.request.mockResolvedValueOnce({contract:'account_video_v1',operation_id:prepared.id,model:prepared.model,status:'prepared',created_at:prepared.createdAt,expires_at:prepared.expiresAt,offer_id:prepared.offerId,spec:prepared.spec,sale_price:prepared.price})
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(wrapper.findComponent({name:'BaseDialog'}).props('show')).toBe(true)
  api.catalog.mockResolvedValue([other])
  await wrapper.get('[data-testid="studio-refresh-models"]').trigger('click');await flushPromises()
  expect(wrapper.findComponent({name:'BaseDialog'}).props('show')).toBe(false)
  expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false)
  expect(wrapper.get('[data-testid="studio-prompt"]').element).toHaveProperty('value','保留报价输入')
  await wrapper.get(`[data-task-id="${prepared.id}"]`).trigger('click');await flushPromises()
  expect(wrapper.get('[data-testid="studio-generate"]').attributes('disabled')).toBeDefined()
  ;(wrapper.get('[data-testid="studio-generate"]').element as HTMLButtonElement).disabled=false
  await wrapper.get('[data-testid="studio-generate"]').trigger('click');expect(api.generate).not.toHaveBeenCalled()
 })
 it('refreshes after a quote 409 and requires explicit replacement selection before a new quote',async()=>{
  await composer();api.catalog.mockResolvedValue([other]);api.request.mockRejectedValueOnce(new StudioError('offer_unavailable',409))
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(true)
  expect(api.catalog).toHaveBeenCalledTimes(2)
  expect(wrapper.get('[data-testid="studio-prompt"]').element).toHaveProperty('value','保留我的画面描述')
  expect(wrapper.find('[data-testid="studio-asset-success"]').exists()).toBe(true)
  await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click');await wrapper.get('[data-offer-id="other-offer"]').trigger('click');await flushPromises()
  const replacement={...prepared,id:'op_'+'c'.repeat(64),offerId:other.offer_id,model:other.model}
  api.request.mockResolvedValueOnce({contract:'account_video_v1',operation_id:replacement.id,model:replacement.model,status:'prepared',created_at:replacement.createdAt,expires_at:replacement.expiresAt,offer_id:replacement.offerId,spec:replacement.spec,sale_price:replacement.price})
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(api.request).toHaveBeenLastCalledWith('video','quotes',expect.objectContaining({offer_id:other.offer_id,prompt:'保留我的画面描述'}))
  expect(wrapper.findComponent({name:'BaseDialog'}).props('show')).toBe(true)
  expect(api.generate).not.toHaveBeenCalled()
 })
 it('does not label the selected model unavailable when the shared gate closes with an empty catalog',async()=>{
  wrapper=mount(StudioMediaPanel);await flushPromises();api.catalog.mockResolvedValue([]);api.request.mockResolvedValue({paid_enabled:false})
  await wrapper.get('[data-testid="studio-refresh-models"]').trigger('click');await flushPromises()
  expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="studio-gate"]').exists()).toBe(true)
  expect(wrapper.get('[data-testid="studio-generate"]').attributes('disabled')).toBeDefined()
  expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(true);expect(api.generate).not.toHaveBeenCalled()
 })
 it('keeps existing input and selection on a failed catalog refresh',async()=>{
  await composer();api.catalog.mockRejectedValueOnce(new Error('offline'))
  await wrapper.get('[data-testid="studio-refresh-models"]').trigger('click');await flushPromises()
  expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(false)
  expect(wrapper.get('[data-testid="studio-model-toggle"]').text()).toContain(offer.display_name)
  expect(wrapper.get('[data-testid="studio-prompt"]').element).toHaveProperty('value','保留我的画面描述')
  expect(wrapper.find('[data-testid="studio-asset-success"]').exists()).toBe(true);expect(api.generate).not.toHaveBeenCalled()
 })
 it('does not restore a removed historical prepared quote as generatable after remount',async()=>{
  api.catalog.mockResolvedValue([other]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="studio-generate"]').exists()).toBe(false)
  expect(wrapper.find(`[data-task-id="${prepared.id}"]`).exists()).toBe(true);expect(api.generate).not.toHaveBeenCalled()
 })
})

describe('Archive history navigation',()=>{
 it('loads mixed image and video history, filters it, and keeps creation choices explicit',async()=>{
  const image={...prepared,kind:'image' as const,id:'img_'+'h'.repeat(32),status:'completed' as const,resultCount:1}
  const video={...prepared,kind:'video' as const,id:'op_'+'h'.repeat(64),status:'completed' as const,resultCount:1}
  api.history.mockImplementation(async(kind:'image'|'video')=>kind==='image'?[image]:[video])
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-mode-history"]').trigger('click');await flushPromises()
  expect(wrapper.findAll('[data-task-id]')).toHaveLength(2)
  await wrapper.get('[data-testid="studio-kind"]').setValue('image');await flushPromises();expect(wrapper.findAll('[data-task-id]')).toHaveLength(1);expect(wrapper.find(`[data-task-id="${image.id}"]`).exists()).toBe(true)
  await wrapper.get('[data-testid="studio-kind"]').setValue('all');await flushPromises();await wrapper.get('[data-testid="studio-header-new"]').trigger('click');expect(wrapper.find('.studio-new-menu').exists()).toBe(true);expect(wrapper.findAll('.studio-new-menu [role="menuitem"]')).toHaveLength(3)
  const editChoice=wrapper.findAll('.studio-new-menu [role="menuitem"]').find(b=>b.text().includes('图生图'))!;await editChoice.trigger('click');await flushPromises();expect(wrapper.find('[data-testid="studio-prompt"]').exists()).toBe(true);expect(wrapper.find('[data-testid="studio-attachment"]').exists()).toBe(true);expect(api.generate).not.toHaveBeenCalled()
 })
})


it('retains image edit references and discards an old quote token after prepare is rejected',async()=>{
 sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',imageMode:'edit'}));api.history.mockResolvedValue([])
 const first={...offer,model:'image-one'},second={...offer,offer_id:'image-two',model:'image-two',display_name:'第二图片模型'}
 api.catalog.mockResolvedValue([first]);wrapper=mount(StudioMediaPanel);await flushPromises()
 await wrapper.get('[data-testid="studio-prompt"]').setValue('保留图生图提示词');await pick([imageFile('original.png')])
 api.catalog.mockResolvedValue([second]);api.request.mockResolvedValueOnce({quote_token:'old-quote'}).mockRejectedValueOnce(new StudioError('image_offer_unavailable',409))
 await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
 expect(wrapper.get('[data-testid="studio-mode-edit"]').attributes('aria-pressed')).toBe('true')
 expect(wrapper.get('[data-testid="studio-asset-success"]').text()).toContain('original.png')
 expect(wrapper.find('[data-testid="studio-model-unavailable"]').exists()).toBe(true)
 await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click');await wrapper.get('[data-offer-id="image-two"]').trigger('click');await flushPromises()
 api.request.mockClear();api.request.mockResolvedValueOnce({quote_token:'new-quote'}).mockRejectedValueOnce(new Error('stop after inspecting prepare'))
 await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
 expect(api.request).toHaveBeenNthCalledWith(1,'image','quotes',expect.objectContaining({offer_id:'image-two'}))
 expect(api.request).toHaveBeenNthCalledWith(2,'image','prepare',expect.objectContaining({quote_token:'new-quote',prompt:'保留图生图提示词',asset_refs:['asset_aaaaaaaa-0000-0000-0000-000000000000']}))
 expect(api.generate).not.toHaveBeenCalled()
})


it('preserves submitted uncertain task recovery when its original offer disappears',async()=>{
 sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video',id:prepared.id,attempted:[prepared.id]}));api.catalog.mockResolvedValue([{...offer,offer_id:'replacement'}])
 wrapper=mount(StudioMediaPanel);await flushPromises()
 expect(wrapper.get('[data-testid="studio-task-id"]').text()).toContain(prepared.id)
 expect(wrapper.get('[data-testid="studio-status"]').text()).toContain('结果待确认')
 expect(wrapper.find('[data-testid="studio-generate"]').exists()).toBe(false)
 expect(api.task).toHaveBeenCalled();expect(api.generate).not.toHaveBeenCalled()
})
