import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import StudioMediaPanel from '../StudioMediaPanel.vue'
import StudioSpecPicker from '../StudioSpecPicker.vue'
import { StudioError, type StudioTask } from '@/api/studioMedia'
import type { StudioAssetReceipt } from '@/api/studioAssets'

const api = vi.hoisted(() => ({ session:vi.fn(), catalog:vi.fn(), request:vi.fn(), history:vi.fn(), task:vi.fn(), generate:vi.fn(), upload:vi.fn(), recover:vi.fn() }))
vi.mock('@/api/studioMedia', async original => ({ ...await original<typeof import('@/api/studioMedia')>(), ensureStudioSession:api.session, studioCatalog:api.catalog, studioRequest:api.request, studioQuoteSequence: (action: (request: import('@/api/studioMedia').StudioQuoteRequest) => Promise<unknown>) => action(api.request), studioHistory:api.history, studioTask:api.task, studioGenerate:api.generate, uploadStudioAsset:api.upload, recoverStudioMediaRead:api.recover }))
const prepared:StudioTask={id:'op_'+'a'.repeat(64),kind:'video',status:'prepared',createdAt:'2026-01-01',expiresAt:'2099-01-01',offerId:'offer',model:'synthetic-video',spec:{resolution:'720p',duration_seconds:5,count:1},price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},resultCount:0}
const offer={offer_id:'offer',model:'synthetic-video',display_name:'合成视频模型',upstream_model:'synthetic-video',spec:{resolution:['720p'],duration_seconds:[5],aspect_ratio:['16:9'],count:{min:1,max:1},references:{image:{min:0,max:1},video:{min:0,max:0},audio:{min:0,max:0},total_max:1}}}
let wrapper:ReturnType<typeof mount>
async function quantityChoices() { if(wrapper.get('[data-testid="studio-count"]').attributes('aria-expanded') !== 'true') await wrapper.get('[data-testid="studio-count"]').trigger('click'); return wrapper.findAll('#studio-count-menu [data-value]') }
async function chooseQuantity(value: number) { await quantityChoices(); await wrapper.get(`#studio-count-menu [data-value="${value}"]`).trigger('click') }
beforeEach(()=>{vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({x:200,y:500,width:200,height:40,top:500,bottom:540,left:200,right:400,toJSON:()=>({})});vi.clearAllMocks();sessionStorage.clear();sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video'}));if(typeof URL.createObjectURL!=='function')Object.defineProperty(URL,'createObjectURL',{configurable:true,value:vi.fn(()=>`blob:studio-asset`)});if(typeof URL.revokeObjectURL!=='function')Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:vi.fn()});api.session.mockResolvedValue({owner_id:1});api.recover.mockResolvedValue(undefined);api.catalog.mockResolvedValue([offer]);api.history.mockResolvedValue([prepared]);api.request.mockResolvedValue({paid_enabled:true});api.task.mockImplementation(async t=>t);api.upload.mockImplementation(async (file:File,kind:string)=>({asset_ref:`asset_${'a'.repeat(8)}-0000-0000-0000-000000000000`,kind,mime_type:file.type,size:file.size,duration_seconds:null}))})
afterEach(()=>{wrapper?.unmount();document.body.innerHTML='';vi.restoreAllMocks();vi.useRealTimers()})

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

 it('rejects an excessive batch before allocating previews or uploading',async()=>{
  api.catalog.mockResolvedValue([withImageReferences(1)]);api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel);await flushPromises()
  const input=wrapper.get('[data-testid="studio-asset-input"]'),first=imageFile('first.png');Object.defineProperty(input.element,'files',{value:[first],configurable:true});await input.trigger('change');await flushPromises()
  const second=imageFile('second.png');Object.defineProperty(input.element,'files',{value:[second],configurable:true});await input.trigger('change');await flushPromises()
  expect(api.upload).toHaveBeenCalledTimes(1);expect(wrapper.find('[data-testid="studio-asset-failure"]').exists()).toBe(false);expect(wrapper.text()).toContain('素材数量上限');expect(wrapper.findAll('[data-testid="studio-asset-success"]')).toHaveLength(1)
 })

 it('uploads 30 permitted assets with at most three concurrent requests and rejects 31',async()=>{
  api.catalog.mockResolvedValue([withImageReferences(30)]);api.history.mockResolvedValue([])
  const pending=Array.from({length:30},()=>deferred<StudioAssetReceipt>())
  pending.forEach(item=>api.upload.mockReturnValueOnce(item.promise))
  wrapper=mount(StudioMediaPanel);await flushPromises()
  const files=Array.from({length:30},(_,i)=>imageFile(`${i}.png`))
  await pick([...files,imageFile('extra.png')]);expect(api.upload).not.toHaveBeenCalled();expect(wrapper.text()).toContain('素材数量上限')
  await pick(files);expect(api.upload).toHaveBeenCalledTimes(3)
  for(let i=0;i<30;i++){pending[i]!.resolve(receipt(files[i]!));await flushPromises();expect(api.upload.mock.calls.length).toBeLessThanOrEqual(Math.min(30,i+4))}
  expect(api.upload).toHaveBeenCalledTimes(30);expect(wrapper.findAll('[data-testid="studio-asset-success"]')).toHaveLength(30);expect(api.generate).not.toHaveBeenCalled()
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
 it('clears video original loading once its metadata has loaded',async()=>{
  const task:StudioTask={...prepared,status:'completed',resultCount:1}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video',id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.find('.studio-result-loading').exists()).toBe(true);await wrapper.get('video').trigger('loadedmetadata');expect(wrapper.find('.studio-result-loading').exists()).toBe(false)
 })
 it.each(['image','video'] as const)('shows the real %s deadline and keeps expired originals out of history, players, downloads and export',async kind=>{
  const task:StudioTask={...prepared,kind,id:(kind==='image'?'img_':'op_')+'c'.repeat(kind==='image'?32:64),status:'completed',resultCount:2,billingState:'billed',settledPrice:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},resultRetention:{persistedAt:'2026-10-19T00:00:00Z',expiresAt:'2099-01-01T00:00:00Z',expired:true,policy:kind==='image'?'image_original_72h':'video_original_48h'}}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind,id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.get('[data-testid="studio-result-retention"]').text()).toContain('原片已到期');expect(wrapper.get('[data-testid="studio-result-retention"]').text()).toContain('2099')
  expect(wrapper.get('[data-testid="studio-result-retention"]').text()).toContain('任务与结算记录保留')
  expect(wrapper.findAll('.studio-results figure')).toHaveLength(2);expect(wrapper.findAll('img,video,[data-testid="studio-download"],.image-export')).toHaveLength(0)
  expect(wrapper.get('[data-testid="studio-status"]').text()).toContain('生成完成');expect(wrapper.get(`[data-task-id="${task.id}"]`).text()).toContain('已保存 2')
  if(kind==='image')expect(wrapper.get('[data-testid="studio-settlement"]').text()).toContain('0.80 CNY')
  expect(api.generate).not.toHaveBeenCalled()
 })
 it('expires loaded media on the existing clock without changing generation or financial state',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
  const task:StudioTask={...prepared,kind:'image',id:'img_'+'d'.repeat(32),status:'partial',resultCount:2,expectedCount:3,deliveredCount:2,failedCount:1,billingState:'billed',resultRetention:{persistedAt:'2026-10-16T00:00:01Z',expiresAt:'2026-10-19T00:00:01Z',expired:false,policy:'image_original_72h'}}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.findAll('[data-testid="studio-result-image"]')).toHaveLength(2);expect(wrapper.findAll('[data-testid="studio-download"]')).toHaveLength(2);expect(wrapper.findAll('.image-export')).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1000)
  expect(wrapper.findAll('img,video,[data-testid="studio-download"],.image-export')).toHaveLength(0);expect(wrapper.get('[data-testid="studio-result-retention"]').text()).toContain('原片已到期')
  expect(wrapper.get('[data-testid="studio-status"]').text()).toBe('部分完成');expect(wrapper.get('[data-testid="studio-partial-counts"]').text()).toContain('已交付 2');expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['download','export'] as const)('blocks %s clicked at the deadline before the next clock tick',async action=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
  const task:StudioTask={...prepared,kind:'image',id:'img_'+'e'.repeat(32),status:'completed',resultCount:1,resultRetention:{persistedAt:'2026-10-16T00:00:00.500Z',expiresAt:'2026-10-19T00:00:00.500Z',expired:false,policy:'image_original_72h'}}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('must not read expired original'))
  try{vi.setSystemTime(new Date('2026-10-19T00:00:00.500Z'));const target=wrapper.get(action==='download'?'[data-testid="studio-download"]':'.image-export button');const click=new MouseEvent('click',{bubbles:true,cancelable:true});target.element.dispatchEvent(click);await flushPromises();expect(click.defaultPrevented).toBe(true);expect(fetch).not.toHaveBeenCalled();expect(wrapper.find('[data-testid="studio-download"]').exists()).toBe(false)}finally{fetch.mockRestore()}
 })
 it('uses a historical seven-day image deadline without shortening it to the new policy',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-19T00:00:00Z'))
  const task:StudioTask={...prepared,kind:'image',id:'img_'+'b'.repeat(32),status:'completed',resultCount:1,expiresAt:'2000-01-01',resultRetention:{persistedAt:'2026-10-14T00:00:00Z',expiresAt:'2026-10-21T00:00:00Z',expired:false,policy:'image_legacy_7d'}}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.get('[data-testid="studio-result-retention"]').text()).toContain('历史7天保留');expect(wrapper.get('[data-testid="studio-result-retention"]').text()).toContain('2026/10/21');expect(wrapper.find('[data-testid="studio-download"]').exists()).toBe(true);expect(wrapper.text()).not.toContain('报价已失效')
 })
 it.each(['missing','legacy_unknown','pending'] as const)('leaves %s retention unknown and keeps the original task identity and state',async scenario=>{
  const task:StudioTask={...prepared,status:scenario==='pending'?'unknown':'completed',resultCount:scenario==='pending'?0:1,expiresAt:'2000-01-01',...(scenario==='legacy_unknown'?{resultRetention:{persistedAt:null,expiresAt:null,expired:false,policy:'legacy_unknown' as const}}:{})}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video',id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.get('[data-testid="studio-result-retention"]').text()).toBe('原片保留期限：服务端未提供具体到期时间。');expect(wrapper.get('[data-testid="studio-task-id"]').text()).toContain(task.id)
  expect(wrapper.find('[data-testid="studio-download"]').exists()).toBe(scenario!=='pending');expect(wrapper.get('[data-testid="studio-status"]').text()).toContain(scenario==='pending'?'结果待确认':'生成完成');expect(api.generate).not.toHaveBeenCalled()
 })
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
 async function setup(){sessionStorage.clear();api.history.mockResolvedValue([]);api.catalog.mockResolvedValue([{...offer,display_name:'图片商品',spec:{...offer.spec,duration_seconds:[],count:{min:1,max:10}}}]);wrapper=mount(StudioMediaPanel,{attachTo:document.body});await flushPromises()}
 it('starts with text-to-image, a bounded quantity and no attachment button',async()=>{await setup();expect(wrapper.get('[data-testid="studio-mode-text"]').attributes('aria-pressed')).toBe('true');expect(wrapper.find('[data-testid="studio-attachment"]').exists()).toBe(false);expect(wrapper.get('[data-testid="studio-quote"]').text()).toContain('获取报价');expect(await quantityChoices()).toHaveLength(10);expect(wrapper.findAll('svg.studio-mark')).toHaveLength(2)})
 it('requires a reference for edit while preserving independent output count',async()=>{await setup();await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await chooseQuantity(5);await wrapper.get('[data-testid="studio-prompt"]').setValue('change background');expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined();await pick([imageFile()]);api.request.mockClear();api.request.mockRejectedValueOnce(new Error('inspect'));await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises();expect(api.request).toHaveBeenCalledWith('image','quotes',expect.objectContaining({spec:expect.objectContaining({count:5,images:1})}));expect(api.generate).not.toHaveBeenCalled()})
 it('switching explicitly to text removes references but preserves prompt and output count',async()=>{await setup();await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await chooseQuantity(5);await wrapper.get('[data-testid="studio-prompt"]').setValue('keep this prompt');await pick([imageFile()]);await wrapper.get('[data-testid="studio-mode-text"]').trigger('click');expect(wrapper.find('[data-testid="studio-attachment"]').exists()).toBe(false);expect(wrapper.find('[data-testid="studio-asset-success"]').exists()).toBe(false);expect((wrapper.get('[data-testid="studio-prompt"]').element as HTMLTextAreaElement).value).toBe('keep this prompt');expect(wrapper.get('[data-testid="studio-count"]').text()).toContain('5 张');api.request.mockClear();api.request.mockRejectedValueOnce(new Error('inspect'));await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises();expect(api.request).toHaveBeenCalledWith('image','quotes',expect.objectContaining({spec:expect.objectContaining({count:5,images:0})}));expect(api.generate).not.toHaveBeenCalled()})
 it('keeps model selection within offered reference capabilities',async()=>{sessionStorage.clear();api.history.mockResolvedValue([]);api.catalog.mockResolvedValue([{...offer,offer_id:'text-only',spec:{...offer.spec,references:{...offer.spec.references,image:{min:0,max:0},total_max:0}}},{...offer,offer_id:'edit-required',spec:{...offer.spec,references:{...offer.spec.references,image:{min:1,max:2},total_max:2}}}]);wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click');expect(wrapper.findAll('#studio-offer [data-offer-id]').map(o=>o.attributes('data-offer-id'))).toEqual(['text-only']);await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click');expect(wrapper.findAll('#studio-offer [data-offer-id]').map(o=>o.attributes('data-offer-id'))).toEqual(['edit-required']);expect(api.generate).not.toHaveBeenCalled()})
 it('shows saved works without locking a new visit to a completed task',async()=>{sessionStorage.clear();api.history.mockResolvedValue([{...prepared,kind:'image',status:'completed',resultCount:1}]);wrapper=mount(StudioMediaPanel);await flushPromises();expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false);expect(wrapper.findAll('[data-task-id]')).toHaveLength(1);expect(api.task).not.toHaveBeenCalled()})
  it('opens a completed history card without querying Core again',async()=>{sessionStorage.clear();const task={...prepared,kind:'image' as const,status:'completed',billingState:'billed',resultCount:1};api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get(`[data-task-id="${task.id}"]`).trigger('click');await flushPromises();expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(true);expect(api.task).not.toHaveBeenCalled()})
 it('opens and closes the ratio selector using Escape and restores focus',async()=>{await setup();await wrapper.get('[data-testid="studio-ratio-toggle"]').trigger('click');expect(wrapper.find('#studio-ratio-menu').exists()).toBe(true);await wrapper.get('#studio-ratio-menu button').trigger('keydown',{key:'Escape'});await flushPromises();expect(wrapper.get('[data-testid="studio-ratio-toggle"]').attributes('aria-expanded')).toBe('false');expect(document.activeElement).toBe(wrapper.get('[data-testid="studio-ratio-toggle"]').element)})
 it('keeps unavailable originals separate from completed billing and retries only a read',async()=>{sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',id:prepared.id}));api.history.mockResolvedValue([{...prepared,kind:'image',status:'completed',resultCount:1}]);wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-result-image"]').trigger('error');expect(wrapper.find('[data-testid="studio-download"]').exists()).toBe(true);expect(wrapper.text()).toContain('原片加载失败，请重试');const oldImage=wrapper.get('[data-testid="studio-result-image"]').element;await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises();expect(wrapper.get('[data-testid="studio-result-image"]').element).not.toBe(oldImage);await wrapper.get('[data-testid="studio-result-image"]').trigger('load');expect(wrapper.get('[data-testid="studio-download"]').exists()).toBe(true);expect(api.generate).not.toHaveBeenCalled()})
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
  expect(wrapper.text()).toContain('生成失败，未收费');expect(wrapper.get('[data-testid="studio-http-failure"]').text()).toContain('未完成的图片不会收费');expect(wrapper.text()).not.toContain('供应商已退款')
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


describe('Published native output format',()=>{
 async function setup(formats?:string[]){sessionStorage.clear();api.history.mockResolvedValue([]);api.catalog.mockResolvedValue([{...offer,spec:{...offer.spec,output_formats:formats}}]);wrapper=mount(StudioMediaPanel);await flushPromises()}
 async function chooseFormat(value:string){await wrapper.get('[data-testid="studio-output-format"]').trigger('click');await wrapper.get(`#studio-output-format-menu [data-value="${value}"]`).trigger('click')}
 async function inspectQuote(){await wrapper.get('[data-testid="studio-prompt"]').setValue('A picture');api.request.mockClear();api.request.mockRejectedValueOnce(new Error('stop after quote'));await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises();expect(api.generate).not.toHaveBeenCalled();return api.request.mock.calls[0]?.[2].spec}
 it('does not expose or submit an undeclared format',async()=>{await setup();expect(wrapper.find('[data-testid="studio-output-format"]').exists()).toBe(false);expect(await inspectQuote()).not.toHaveProperty('output_format')})
 it('defaults to auto and omits the field, including after returning to auto',async()=>{await setup(['png','jpeg','webp']);expect(wrapper.get('[data-testid="studio-output-format"]').text()).toContain('由模型决定');expect(await inspectQuote()).not.toHaveProperty('output_format');await chooseFormat('png');await chooseFormat('auto');expect(await inspectQuote()).not.toHaveProperty('output_format')})
 it.each(['png','jpeg','webp'])('binds explicitly selected %s into the frozen quote request',async format=>{await setup(['png','jpeg','webp']);await chooseFormat(format);expect(await inspectQuote()).toMatchObject({output_format:format});if(format==='jpeg')expect(wrapper.get('[data-testid="studio-output-format"]').text()).toContain('JPEG')})
 it('preserves edit references alongside the format',async()=>{await setup(['webp']);await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await pick([imageFile()]);await chooseFormat('webp');expect(await inspectQuote()).toMatchObject({output_format:'webp',images:1})})
 it('resets a format when selecting an incompatible model',async()=>{await setup(['png','webp']);await chooseFormat('webp');api.catalog.mockResolvedValue([{...offer,spec:{...offer.spec,output_formats:['png','webp']}},{...offer,offer_id:'other',spec:{...offer.spec,output_formats:['jpeg']}}]);await wrapper.get('[data-testid="studio-refresh-models"]').trigger('click');await flushPromises();await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click');await wrapper.get('[data-offer-id="other"]').trigger('click');expect(wrapper.get('[data-testid="studio-output-format"]').text()).toContain('由模型决定');expect(await inspectQuote()).not.toHaveProperty('output_format')})
 it('resets removed catalog capability and never exposes the selector for video',async()=>{await setup(['webp']);await chooseFormat('webp');api.catalog.mockResolvedValue([{...offer,spec:{...offer.spec,output_formats:['png']}}]);await wrapper.get('[data-testid="studio-refresh-models"]').trigger('click');await flushPromises();expect(wrapper.get('[data-testid="studio-output-format"]').text()).toContain('由模型决定');await wrapper.get('[data-testid="studio-mode-video"]').trigger('click');await flushPromises();expect(wrapper.find('[data-testid="studio-output-format"]').exists()).toBe(false)})
})


it('keeps published edit ratios visible before reference upload without enabling generation',async()=>{
 sessionStorage.clear();api.history.mockResolvedValue([])
 api.catalog.mockResolvedValue([{...offer,product_scope:'edit-product',spec:{...offer.spec,duration_seconds:[],aspect_ratio:['7:5','3:5'],references:{...offer.spec.references,image:{min:1,max:2},total_max:2}}}])
 wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await flushPromises()
 await wrapper.get('[data-testid="studio-ratio-toggle"]').trigger('click');await wrapper.get('[data-ratio="3:5"]').trigger('click')
 expect(wrapper.get('[data-testid="studio-ratio-toggle"]').text()).toContain('3:5')
 await wrapper.get('[data-testid="studio-prompt"]').setValue('Reference required')
 expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined()
 expect(api.generate).not.toHaveBeenCalled()
})
it('published ratio picker changes only the exact same-product offer, preserves specifications and waits for explicit quote',async()=>{
 sessionStorage.clear();api.history.mockResolvedValue([])
 const sibling=(id:string,ratio:string)=>({...offer,offer_id:id,product_scope:'published-product',spec:{...offer.spec,duration_seconds:[],resolution:['2K','4K'],aspect_ratio:[ratio],quality:['high'],count:{min:1,max:3},output_formats:['png']}})
 api.catalog.mockResolvedValue([sibling('portrait','9:16'),sibling('custom','7:5'),sibling('wide','16:9')])
 wrapper=mount(StudioMediaPanel);await flushPromises()
 await wrapper.get('[data-testid="studio-resolution"]').trigger('click');await wrapper.get('#studio-resolution-menu [data-value="4K"]').trigger('click')
 await chooseQuantity(2)
 await wrapper.get('[data-testid="studio-output-format"]').trigger('click');await wrapper.get('#studio-output-format-menu [data-value="png"]').trigger('click')
 await wrapper.get('[data-testid="studio-prompt"]').setValue('Preserve my draft')
 api.request.mockClear();await wrapper.get('[data-testid="studio-ratio-toggle"]').trigger('click');await wrapper.get('[data-ratio="7:5"]').trigger('click');await flushPromises()
 expect(api.request).not.toHaveBeenCalled();expect(api.generate).not.toHaveBeenCalled()
 expect(wrapper.get('[data-testid="studio-resolution"]').text()).toContain('4K');expect(wrapper.get('[data-testid="studio-count"]').text()).toContain('2 张');expect(wrapper.get('[data-testid="studio-output-format"]').text()).toContain('PNG')
 api.request.mockRejectedValueOnce(new Error('inspect only'));await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
 expect(api.request).toHaveBeenCalledWith('image','quotes',expect.objectContaining({offer_id:'custom',spec:expect.objectContaining({aspect_ratio:'7:5',resolution:'4K',count:2,quality:'high',output_format:'png'})}));expect(api.generate).not.toHaveBeenCalled()
})
it('waits for catalog provisioning before readiness while history remains independent',async()=>{
 const pending=deferred<typeof offer[]>();api.catalog.mockReturnValueOnce(pending.promise);api.history.mockResolvedValue([])
 wrapper=mount(StudioMediaPanel);await flushPromises()
 expect(api.history).toHaveBeenCalledWith('video');expect(api.request).not.toHaveBeenCalled()
 pending.resolve([offer]);await flushPromises()
 expect(api.request).toHaveBeenCalledWith('video','readiness');expect(wrapper.text()).not.toContain('当前生成服务未开放')
})
it('reads readiness after failed catalog and retains independently fetched history',async()=>{
 const pending=deferred<typeof offer[]>();api.catalog.mockReturnValueOnce(pending.promise)
 api.history.mockResolvedValue([{...prepared,status:'completed',billingState:'billed'}])
 wrapper=mount(StudioMediaPanel);await flushPromises();expect(api.request).not.toHaveBeenCalled()
 pending.reject(new Error('catalog unavailable'));await flushPromises()
 expect(api.request).toHaveBeenCalledWith('video','readiness');expect(wrapper.text()).toContain('目录或生成服务暂不可用')
 expect(wrapper.text()).toContain('synthetic-video');expect(api.generate).not.toHaveBeenCalled()
})


describe('One product entry with independent specification Offers',()=>{
 async function chooseSpec(id:string,value:string){await wrapper.get(`[data-testid="${id}"]`).trigger('click');await wrapper.get(`#${id}-menu [data-value="${value}"]`).trigger('click');await flushPromises()}
 it.each(['paste','drop'])('accepts the first %s image through an edit sibling while preserving the text-mode specifications',async(input)=>{
  sessionStorage.clear();api.history.mockResolvedValue([])
  const text={...offer,offer_id:'text-only',product_scope:'image-reference-product',spec:{...offer.spec,duration_seconds:[],resolution:['2K','4K'],aspect_ratio:['1:1','3:4'],quality:['standard','high'],output_formats:['png','webp'],count:{min:1,max:2},references:{...offer.spec.references,image:{min:0,max:0},total_max:0}}}
  const edit={...text,offer_id:'edit-sibling',spec:{...text.spec,references:{...text.spec.references,image:{min:1,max:2},total_max:2}}}
  api.catalog.mockResolvedValue([text,edit]);wrapper=mount(StudioMediaPanel,{attachTo:document.body});await flushPromises()
  await chooseSpec('studio-resolution','4K');await chooseSpec('studio-quality','high');await chooseQuantity(2)
  await wrapper.get('[data-testid="studio-ratio-toggle"]').trigger('click');await wrapper.get('[data-ratio="3:4"]').trigger('click');await chooseSpec('studio-output-format','webp')
  await wrapper.get('[data-testid="studio-prompt"]').setValue('Keep this text and every specification');api.request.mockClear()
  const file=imageFile('first-reference.png')
  if(input==='paste')pasteAt(document.body,{items:[{kind:'file',type:'image/png',getAsFile:()=>file}]})
  else await wrapper.get('.studio-composer').trigger('drop',{dataTransfer:{files:[file]}})
  await flushPromises()
  expect(wrapper.get('[data-testid="studio-mode-edit"]').attributes('aria-pressed')).toBe('true')
  expect(wrapper.findAll('[data-testid="studio-asset-success"]')).toHaveLength(1);expect(api.upload).toHaveBeenCalledTimes(1)
  expect(wrapper.get('[data-testid="studio-prompt"]').element).toHaveProperty('value','Keep this text and every specification')
  expect(wrapper.get('[data-testid="studio-output-format"]').text()).toContain('WebP')
  expect(api.request).not.toHaveBeenCalled();expect(api.generate).not.toHaveBeenCalled()
  api.request.mockRejectedValueOnce(new Error('inspect quote only'));await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(api.request).toHaveBeenCalledWith('image','quotes',expect.objectContaining({offer_id:'edit-sibling',spec:expect.objectContaining({images:1,resolution:'4K',aspect_ratio:'3:4',quality:'high',count:2,output_format:'webp'})}))
 })
 it('keeps text mode and input when same-named edit candidates belong to another product, model or specification',async()=>{
  sessionStorage.clear();api.history.mockResolvedValue([])
  const text={...offer,offer_id:'text-only',product_scope:'selected-image-product',spec:{...offer.spec,duration_seconds:[],references:{...offer.spec.references,image:{min:0,max:0},total_max:0}}}
  const edit={...text,offer_id:'edit',spec:{...text.spec,references:{...text.spec.references,image:{min:1,max:2},total_max:2}}}
  api.catalog.mockResolvedValue([text,{...edit,offer_id:'other-product',product_scope:'other-product'},{...edit,offer_id:'other-model',model:'other-model'},{...edit,offer_id:'other-spec',spec:{...edit.spec,resolution:['1080p']}}])
  wrapper=mount(StudioMediaPanel,{attachTo:document.body});await flushPromises();await wrapper.get('[data-testid="studio-prompt"]').setValue('Preserve rejected input');api.request.mockClear()
  pasteAt(document.body,{items:[{kind:'file',type:'image/png',getAsFile:()=>imageFile()}]});await flushPromises()
  expect(wrapper.get('[data-testid="studio-mode-text"]').attributes('aria-pressed')).toBe('true')
  expect(wrapper.get('[data-testid="studio-prompt"]').element).toHaveProperty('value','Preserve rejected input')
  expect(wrapper.get('[data-testid="studio-resolution"]').text()).toContain('720p')
  expect(wrapper.find('[data-testid="studio-assets"]').exists()).toBe(false);expect(api.upload).not.toHaveBeenCalled();expect(api.request).not.toHaveBeenCalled();expect(api.generate).not.toHaveBeenCalled()
  expect(wrapper.text()).toContain('当前规格不支持这些素材')
 })
 it.each([['image','image'],['video','image'],['video','video']] as const)('switches the exact %s Offer and quote price after adding a second %s reference',async(mediaKind,referenceKind)=>{
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:mediaKind,imageMode:mediaKind==='image'?'edit':'text'}));api.history.mockResolvedValue([])
  const variants=[1,2].map(n=>({...offer,offer_id:`reference-${n}`,product_scope:`${mediaKind}-references-product`,spec:{...offer.spec,...(mediaKind==='image'?{duration_seconds:[]}:{}),references:{image:{min:0,max:0},video:{min:0,max:0},audio:{min:0,max:0},[referenceKind]:{min:n,max:n},total_max:n}}}))
  api.catalog.mockResolvedValue(variants);wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-prompt"]').setValue('Keep my selected specifications')
  for(const n of [1,2]){
   api.request.mockClear()
   await pick([referenceKind==='image'?imageFile(`reference-${n}.png`):new File(['12345678'],`reference-${n}.mp4`,{type:'video/mp4'})])
   expect(wrapper.findAll('[data-testid="studio-asset-success"]')).toHaveLength(n)
   expect(api.request).not.toHaveBeenCalled();expect(api.generate).not.toHaveBeenCalled()
   const raw={contract:mediaKind==='image'?'published_image_binding_v1':'account_video_v1',[mediaKind==='image'?'task_id':'operation_id']:(mediaKind==='image'?'img_':'op_')+String(n).repeat(mediaKind==='image'?32:64),status:'prepared',created_at:'2026-10-19',expires_at:'2099-01-01',offer_id:`reference-${n}`,model:offer.model,spec:{resolution:'720p',aspect_ratio:'16:9',count:1,...(mediaKind==='video'?{duration_seconds:5}:{})},sale_price:{amount:String(n),currency:'CNY',billing_mode:'per_request'},quantity:1}
   if(mediaKind==='image')api.request.mockResolvedValueOnce({quote_token:`quote-${n}`}).mockResolvedValueOnce(raw)
   else api.request.mockResolvedValueOnce(raw)
   expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeUndefined()
   await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
   expect(api.request).toHaveBeenCalledWith(mediaKind,'quotes',expect.objectContaining({offer_id:`reference-${n}`,...(mediaKind==='image'?{spec:expect.objectContaining({images:n,resolution:'720p',aspect_ratio:'16:9',count:1})}:{duration:5,resolution:'720p',ratio:'16:9',assets:expect.arrayContaining([expect.objectContaining({kind:referenceKind})])})}))
   expect(wrapper.get('[data-testid="studio-price"]').text()).toContain(`${n} CNY`)
   expect(api.generate).not.toHaveBeenCalled()
   if(n===1){await wrapper.get('[data-testid="studio-new"]').trigger('click');if(mediaKind==='image')await wrapper.get('[data-testid="studio-mode-edit"]').trigger('click');await flushPromises()}
  }
 })
 it('rejects extra inputs when only a same-named other product or a different specification permits them',async()=>{
  api.history.mockResolvedValue([])
  const first={...offer,product_scope:'selected-product'}
  const other={...withImageReferences(2),offer_id:'other-product',product_scope:'other-product'}
  const incompatible={...withImageReferences(2),offer_id:'other-resolution',product_scope:'selected-product',spec:{...withImageReferences(2).spec,resolution:['1080p']}}
  api.catalog.mockResolvedValue([first,other,incompatible]);wrapper=mount(StudioMediaPanel);await flushPromises()
  await pick([imageFile('first.png')]);await pick([imageFile('second.png')])
  expect(api.upload).toHaveBeenCalledTimes(1);expect(wrapper.findAll('[data-testid="studio-asset-success"]')).toHaveLength(1)
  expect(wrapper.get('[data-testid="studio-resolution"]').text()).toContain('720p')
  expect(wrapper.text()).toContain('当前规格不支持这些素材');expect(api.generate).not.toHaveBeenCalled()
 })
 it('shows one video entry for three durations and quotes the exact Offer, price and duration',async()=>{
  api.history.mockResolvedValue([])
  const variants=[5,10,15].map(seconds=>({...offer,offer_id:`duration-${seconds}`,product_scope:'video-account44-product-revision',spec:{...offer.spec,duration_seconds:[seconds]}}))
  api.catalog.mockResolvedValue(variants);wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click')
  expect(wrapper.findAll('.picker-choice')).toHaveLength(1)
  expect(wrapper.find('.picker-choice small').exists()).toBe(false)
  await wrapper.get('.picker-choice').trigger('click');await wrapper.get('[data-testid="studio-prompt"]').setValue('Synthetic video')
  for(const seconds of [10,15,5]){
   await chooseSpec('studio-duration',String(seconds));api.request.mockClear();api.generate.mockClear()
   api.request.mockResolvedValueOnce({contract:'account_video_v1',operation_id:'op_'+'b'.repeat(64),status:'intent',created_at:'2026-10-19',expires_at:'2099-01-01',offer_id:`duration-${seconds}`,model:offer.model,spec:{resolution:'720p',aspect_ratio:'16:9',duration_seconds:seconds,count:1},sale_price:{amount:String(seconds),currency:'CNY',billing_mode:'per_request'},quantity:1})
   await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
   expect(api.request).toHaveBeenCalledWith('video','quotes',expect.objectContaining({offer_id:`duration-${seconds}`,duration:seconds,resolution:'720p',ratio:'16:9'}))
   expect(wrapper.get('[data-testid="studio-price"]').text()).toContain(`${seconds} CNY`)
   expect(api.generate).not.toHaveBeenCalled();await wrapper.get('[data-testid="studio-new"]').trigger('click');await flushPromises()
  }
 })
 it('allows changing dependent dimensions without quoting an invented intermediate combination',async()=>{
  api.history.mockResolvedValue([])
  api.catalog.mockResolvedValue([{...offer,offer_id:'small',product_scope:'video-p',spec:{...offer.spec,resolution:['720p'],duration_seconds:[5]}},{...offer,offer_id:'large',product_scope:'video-p',spec:{...offer.spec,resolution:['1080p'],duration_seconds:[10]}}])
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-prompt"]').setValue('Dependent specifications')
  await chooseSpec('studio-resolution','1080p')
  expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined()
  expect(wrapper.text()).toContain('当前规格组合不可售')
  await chooseSpec('studio-duration','10');expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeUndefined()
  api.request.mockClear();api.request.mockRejectedValueOnce(new Error('inspect only'))
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(api.request).toHaveBeenCalledWith('video','quotes',expect.objectContaining({offer_id:'large',duration:10,resolution:'1080p'}));expect(api.generate).not.toHaveBeenCalled()
 })
 it('aggregates image Offers and switches resolution, keeping same-named other products separate',async()=>{
  sessionStorage.clear();api.history.mockResolvedValue([])
  const item=(id:string,res:string,scope:string)=>({...offer,offer_id:id,product_scope:scope,spec:{...offer.spec,duration_seconds:[],resolution:[res]}})
  api.catalog.mockResolvedValue([item('2k','2K','image-product-a'),item('4k','4K','image-product-a'),item('other','4K','image-product-b')])
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-model-toggle"]').trigger('click')
  expect(wrapper.findAll('.picker-choice')).toHaveLength(2);await wrapper.get('[data-offer-id="2k"]').trigger('click')
  await chooseSpec('studio-resolution','4K');await wrapper.get('[data-testid="studio-prompt"]').setValue('Synthetic image');api.request.mockClear();api.request.mockRejectedValueOnce(new Error('inspect quote only'))
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(api.request).toHaveBeenCalledWith('image','quotes',expect.objectContaining({offer_id:'4k',spec:expect.objectContaining({resolution:'4K'})}));expect(api.generate).not.toHaveBeenCalled()
 })
})


describe('Image2Pro provider attachment preparation', () => {
 it.each(['image','audio','video'] as const)('binds %s preparation to the exact offer before quoting and never generates', async referenceKind => {
  const refs={image:{min:0,max:1},audio:{min:0,max:1},video:{min:0,max:1},total_max:3}
  api.catalog.mockResolvedValue([{...offer,input_mode:'image2pro',spec:{...offer.spec,references:refs}}]);api.history.mockResolvedValue([])
  api.request.mockImplementation(async (_kind:string,path:string) => {
   if(path==='readiness')return {paid_enabled:true}
   if(path==='prepare')return {preparation_id:'isolated-image2pro-preparation'}
   if(path==='quotes')throw new Error('Stop after inspecting the quoted request')
   throw new Error('Unexpected request')
  })
  wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-prompt"]').setValue('Synthetic provider quotation')
  const mime={image:'image/png',audio:'audio/mpeg',video:'video/mp4'}[referenceKind]
  await pick([new File(['synthetic reference'],`reference.${referenceKind==='image'?'png':referenceKind==='audio'?'mp3':'mp4'}`,{type:mime})])
  api.request.mockClear()
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(api.request.mock.calls.map(call=>call[1])).toEqual(['prepare','quotes'])
  expect(api.request.mock.calls[0]![2]).toMatchObject({offer_id:'offer',model:'synthetic-video',assets:[{kind:referenceKind}]})
  expect(api.request.mock.calls[1]![2]).toMatchObject({offer_id:'offer',model:'synthetic-video',preparation_id:'isolated-image2pro-preparation',assets:[{kind:referenceKind}]})
  expect(api.generate).not.toHaveBeenCalled()
 })
 it('does not create an attachment preparation for a text-only Image2Pro quote', async () => {
  api.catalog.mockResolvedValue([{...offer,input_mode:'image2pro'}]);api.history.mockResolvedValue([])
  api.request.mockImplementation(async (_kind:string,path:string)=>{if(path==='readiness')return {paid_enabled:true};throw new Error('Stop after quotation')})
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-prompt"]').setValue('Text only')
  api.request.mockClear();await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(api.request.mock.calls.map(call=>call[1])).toEqual(['quotes'])
  expect(api.request.mock.calls[0]![2]).not.toHaveProperty('preparation_id');expect(api.generate).not.toHaveBeenCalled()
 })
})

describe('Video history covers and leaving the workspace',()=>{
 it('shares the image failure artwork for terminal video failures and keeps receipt text outside the cover',async()=>{
  const failed:StudioTask={...prepared,status:'released',billingState:'pending'}
  api.history.mockResolvedValue([failed]);wrapper=mount(StudioMediaPanel);await flushPromises()
  const card=wrapper.get(`[data-task-id="${failed.id}"]`)
  expect(card.get('[data-testid="studio-failed-cover"]').attributes('src')).toContain('studio-image-failed-whale.png')
  expect(card.get('[data-testid="studio-failed-cover"]').attributes('alt')).toBe('生成失败')
  expect(card.get('.studio-work-preview').text()).toBe('')
  expect(card.get('.studio-work-state').text()).toBe('生成失败，费用已释放')
  expect(card.find('[data-testid="studio-history-retention"]').exists()).toBe(false)
  await card.trigger('click');expect(wrapper.get('[data-testid="studio-task-failure"]').text()).toContain('费用已释放')
  expect(wrapper.find('[data-testid="studio-result-retention"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="studio-results"]').exists()).toBe(false);expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['unknown','processing','billing_pending','recovery_blocked'])('does not mark %s as a failed generation',async status=>{
  api.history.mockResolvedValue([{...prepared,status}]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.find('[data-testid="studio-failed-cover"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="studio-task-failure"]').exists()).toBe(false)
  expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['.studio-dashboard','.studio-brand-mark','.studio-header h1 a'])('requires confirmation for the dashboard link %s and cancel preserves the workspace',async selector=>{
  wrapper=mount(StudioMediaPanel,{attachTo:document.body});await flushPromises()
  const link=wrapper.get(selector);const click=new MouseEvent('click',{bubbles:true,cancelable:true});link.element.dispatchEvent(click);await flushPromises()
  expect(click.defaultPrevented).toBe(true)
  const dialog=document.querySelector('[role="dialog"]')!;expect(dialog.textContent).toContain('确认返回控制台吗？')
  expect(dialog.querySelector('[data-testid="studio-confirm-dashboard"]')?.getAttribute('href')).toBe('/dashboard')
  ;(dialog.querySelector('[data-testid="studio-stay"]') as HTMLButtonElement).click();await flushPromises()
  await vi.waitFor(()=>expect(document.querySelector('[role="dialog"]')).toBeNull());expect(wrapper.get('[data-testid="studio-task-id"]').text()).toContain(prepared.id)
  expect(api.generate).not.toHaveBeenCalled()
 })
})


it('explains that an unconfirmed video quote locks the price without freezing the balance',async()=>{
 wrapper=mount(StudioMediaPanel);await flushPromises()
 expect(wrapper.get('[data-testid="studio-status"]').text()).toContain('报价已锁定')
 expect(wrapper.text()).not.toContain('报价已冻结')
 expect(api.generate).not.toHaveBeenCalled()
})

describe('Generation effort cover',()=>{
 it.each(['image','video'] as const)('shows the approved cover only while %s is processing, and restores the delivered cover',async kind=>{
  const task:StudioTask={...prepared,kind,id:kind==='image'?'img_'+'8'.repeat(32):'op_'+'8'.repeat(64),status:'processing',spec:{count:1,resolution:kind==='image'?'1K':'720p',aspect_ratio:'16:9'},resultCount:0}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind,id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  const card=wrapper.get('[data-task-id="'+task.id+'"]')
  expect(card.get('[data-testid="studio-generating-cover"]').attributes('alt')).toBe('在努力啦...')
  expect(card.get('[data-testid="studio-generating-cover"]').attributes('src')).toContain('studio-generating-effort.png')
  expect(card.find('[data-testid="studio-failed-cover"]').exists()).toBe(false)
  api.task.mockResolvedValue({...task,status:'completed',resultCount:1})
  await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises()
  expect(card.find('[data-testid="studio-generating-cover"]').exists()).toBe(false)
  expect(wrapper.find(kind==='image'?'[data-testid="studio-result-image"]':'[data-testid="studio-result-video"]').exists()).toBe(true)
  expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['image','video'] as const)('keeps %s unknown, queued, failed, released, and billing states distinct',async kind=>{
  const states=['prepared','unknown','queued','failed','released','billing_pending','reserve_pending','recovery_blocked']
  const tasks=states.map((status,i)=>({...prepared,kind,id:(kind==='image'?'img_':'op_')+(i+1).toString(16).padStart(kind==='image'?32:64,'0'),status,resultCount:0}))
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind,view:'compose'}));api.history.mockResolvedValue(tasks);wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-mode-history"]').trigger('click');await flushPromises()
  expect(wrapper.findAll('[data-task-id]')).toHaveLength(states.length)
  expect(wrapper.find('[data-testid="studio-generating-cover"]').exists()).toBe(false)
  expect(api.generate).not.toHaveBeenCalled()
 })
})


describe('Illustrated task state covers',()=>{
 it.each([
  ['failed','not_charged','未收费'],['failed','billed','费用已结算'],
  ['failed','pending','费用状态待确认'],['released','pending','费用已释放']
 ])('shows image failure artwork for %s/%s with the actual receipt outside',async(status,billingState,receipt)=>{
  const task:StudioTask={...prepared,kind:'image',id:'img_'+'9'.repeat(32),status,billingState}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  if(wrapper.find('[data-testid="studio-failed-toggle"]').exists())await wrapper.get('[data-testid="studio-failed-toggle"]').trigger('click')
  const card=wrapper.get('[data-task-id="'+task.id+'"]')
  expect(card.get('[data-testid="studio-image-failed-cover"]').attributes('src')).toContain('studio-image-failed-whale.png')
  expect(card.find('[data-testid="studio-failed-cover"]').exists()).toBe(false)
  expect(card.get('.studio-work-preview').text()).toBe('')
  expect(card.get('.studio-work-state').text()).toContain(receipt)
  expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['image','video'] as const)('uses the shared pending-quote artwork for %s without submitting generation',async kind=>{
  const task:StudioTask={...prepared,kind,id:(kind==='image'?'img_':'op_')+'7'.repeat(kind==='image'?32:64)}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind,id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  const card=wrapper.get('[data-task-id="'+task.id+'"]')
  expect(card.get('[data-testid="studio-quote-ready-cover"]').attributes('src')).toContain('studio-quote-ready-whale.png')
  expect(card.find('[data-testid="studio-generating-cover"]').exists()).toBe(false)
  await card.trigger('click');await flushPromises()
  expect(wrapper.get('[data-testid="studio-generate"]').text()).toContain('确认报价并生成')
  expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['image','video'] as const)('removes the %s waiting artwork when a quote expires on the existing clock',async kind=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-23T08:00:00Z'))
  const task:StudioTask={...prepared,kind,expiresAt:'2026-10-23T08:00:01Z',id:(kind==='image'?'img_':'op_')+'6'.repeat(kind==='image'?32:64)}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind,id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  const card=wrapper.get('[data-task-id="'+task.id+'"]')
  expect(card.find('[data-testid="studio-quote-ready-cover"]').exists()).toBe(true)
  await vi.advanceTimersByTimeAsync(1000)
  expect(card.find('[data-testid="studio-quote-ready-cover"]').exists()).toBe(false)
  expect(card.get('[data-testid="studio-quote-expired-cover"]').attributes('src')).toContain('studio-quote-expired-whale.png')
  expect(card.find('.studio-work-placeholder').exists()).toBe(false)
  expect(wrapper.get('[data-testid="studio-status"]').text()).toBe('报价已失效')
  expect(wrapper.get('[data-testid="studio-price"]').text()).toContain('本次报价')
  expect(wrapper.get('.studio-task-heading').text()).not.toContain('已冻结')
  expect(wrapper.get('[data-testid="studio-new"]').text()).toBe('重新报价')
  const generate=wrapper.get('[data-testid="studio-generate"]');(generate.element as HTMLButtonElement).disabled=false;await generate.trigger('click')
  expect(api.generate).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="studio-new"]').trigger('click');await flushPromises()
  expect(wrapper.find('[data-testid="studio-generate"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="studio-quote"]').exists()).toBe(true)
  expect(card.get('.studio-work-state').text()).toBe('报价已失效')
  expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['image','video'] as const)('treats a %s quote with an invalid expiry as expired without submission',async kind=>{
  const task:StudioTask={...prepared,kind,expiresAt:'invalid',id:(kind==='image'?'img_':'op_')+'7'.repeat(kind==='image'?32:64)}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind,id:task.id}));api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  expect(wrapper.get('[data-testid="studio-status"]').text()).toBe('报价已失效')
  expect(wrapper.get('[data-testid="studio-quote-expired-cover"]').attributes('alt')).toBe('报价已失效，请重新报价')
  expect(wrapper.find('[data-testid="studio-quote-ready-cover"]').exists()).toBe(false)
  expect(wrapper.get('[data-testid="studio-generate"]').attributes('disabled')).toBeDefined()
  expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['image','video'] as const)('expires an already open %s confirmation without POST',async kind=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-23T08:00:00Z'))
  const task:StudioTask={...prepared,kind,expiresAt:'2026-10-23T08:00:01Z',id:(kind==='image'?'img_':'op_')+'5'.repeat(kind==='image'?32:64)}
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind,view:'compose'}));api.history.mockResolvedValue([]);wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-prompt"]').setValue('retain input')
  const raw={contract:kind==='image'?'published_image_binding_v1':'account_video_v1',[kind==='image'?'task_id':'operation_id']:task.id,model:task.model,status:'prepared',created_at:task.createdAt,expires_at:task.expiresAt,offer_id:task.offerId,spec:task.spec,sale_price:task.price}
  if(kind==='image')api.request.mockResolvedValueOnce({quote_token:'quote_test'}).mockResolvedValueOnce(raw)
  else api.request.mockResolvedValueOnce(raw)
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  const dialog=wrapper.findAllComponents({name:'BaseDialog'}).find(d=>d.props('show'))!
  expect(dialog.props('title')).toBe('确认本次生成')
  await vi.advanceTimersByTimeAsync(1000)
  expect(dialog.props('title')).toBe('报价已失效')
  expect(document.body.textContent).toContain('报价已失效，尚未生成。请重新获取报价后确认。')
  const confirm=document.querySelector<HTMLButtonElement>('[data-testid="studio-confirm-generate"]')!;expect(confirm.disabled).toBe(true);confirm.disabled=false;confirm.click();await flushPromises()
  expect(api.generate).not.toHaveBeenCalled()
  const requestCount=api.request.mock.calls.length
  await wrapper.get('[data-testid="studio-new"]').trigger('click');await flushPromises()
  expect(wrapper.get('[data-testid="studio-prompt"]').element).toHaveProperty('value','retain input')
  expect(api.generate).not.toHaveBeenCalled();expect(api.request.mock.calls.length).toBe(requestCount)
 })
 it('does not submit after actual deadline before the next sampled clock tick',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-23T08:00:00Z'))
  const task={...prepared,expiresAt:'2026-10-23T08:00:00.500Z'};api.history.mockResolvedValue([task]);wrapper=mount(StudioMediaPanel);await flushPromises()
  await vi.advanceTimersByTimeAsync(600)
  const button=wrapper.get('[data-testid="studio-generate"]');await button.trigger('click');await flushPromises()
  expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['image','video'] as const)('does not label %s uncertain, queued, or billing states as quote-ready or failed',async kind=>{
  const tasks=['unknown','queued','billing_pending','reserve_pending','recovery_blocked','partial'].map((status,i)=>({...prepared,kind,id:(kind==='image'?'img_':'op_')+String(i+20).padStart(kind==='image'?32:64,'0'),status,resultCount:status==='partial'?1:0}))
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind,view:'compose'}));api.history.mockResolvedValue(tasks);wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-mode-history"]').trigger('click');await flushPromises()
  expect(wrapper.findAll('[data-task-id]')).toHaveLength(tasks.length)
  expect(wrapper.find('[data-testid="studio-quote-ready-cover"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="studio-image-failed-cover"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="studio-failed-cover"]').exists()).toBe(false)
  expect(api.generate).not.toHaveBeenCalled()
 })
})

describe('Video read recovery',()=>{
 async function completedVideo(){sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video',id:prepared.id}));api.history.mockResolvedValue([{...prepared,status:'completed',resultCount:1,billingState:'billed'}]);wrapper=mount(StudioMediaPanel);await flushPromises()}
 it('loads small gallery covers separately from the selected original video',async()=>{
  await completedVideo()
  expect(wrapper.getComponent({name:'StudioVideoCover'}).props('src')).toMatch(/\/cover$/)
  expect(wrapper.get('[data-testid="studio-result-video"]').attributes('src')).toMatch(/\/original$/)
 })
 it('recovers once automatically, then offers manual retry while retaining original download',async()=>{
  await completedVideo();const first=wrapper.get('[data-testid="studio-result-video"]').element
  await wrapper.get('[data-testid="studio-result-video"]').trigger('error');await flushPromises()
  expect(api.recover).toHaveBeenCalledTimes(1);expect(wrapper.get('[data-testid="studio-result-video"]').element).not.toBe(first)
  await wrapper.get('[data-testid="studio-result-video"]').trigger('error');await flushPromises()
  expect(api.recover).toHaveBeenCalledTimes(1);expect(wrapper.text()).toContain('原片加载失败，请重试');expect(wrapper.text()).not.toContain('可能已过期')
  expect(wrapper.find('[data-testid="studio-download"]').exists()).toBe(true)
  await wrapper.get('[data-testid="studio-result-retry-1"]').trigger('click');await flushPromises()
  expect(api.recover).toHaveBeenCalledTimes(2)
  await wrapper.get('[data-testid="studio-result-video"]').trigger('loadedmetadata');expect(wrapper.text()).not.toContain('原片加载失败')
  expect(api.generate).not.toHaveBeenCalled();expect(api.task).not.toHaveBeenCalled()
 })
 it('marks only authoritative expiry as expired while preserving completed billing',async()=>{
  api.recover.mockRejectedValueOnce(new StudioError('result_expired',410));await completedVideo()
  await wrapper.get('[data-testid="studio-result-video"]').trigger('error');await flushPromises()
  expect(wrapper.text()).toContain('原片已到期');expect(wrapper.find('[data-testid="studio-result-video"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="studio-download"]').exists()).toBe(false);expect(wrapper.get('[data-testid="studio-status"]').text()).toContain('生成完成')
  expect(api.generate).not.toHaveBeenCalled()
 })
 it('ignores a late successful session repair after the user leaves the task',async()=>{
  const repair=deferred<void>();api.recover.mockReturnValueOnce(repair.promise);await completedVideo()
  await wrapper.get('[data-testid="studio-result-video"]').trigger('error')
  await wrapper.get('[data-testid="studio-new"]').trigger('click');repair.resolve();await flushPromises()
  expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false);expect(api.generate).not.toHaveBeenCalled()
 })
})
 it('keeps a new read retryable while an old session repair finishes after querying the task',async()=>{
  const repair=deferred<void>();api.recover.mockReturnValueOnce(repair.promise)
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video',id:prepared.id}));api.history.mockResolvedValue([{...prepared,status:'completed',resultCount:1}]);wrapper=mount(StudioMediaPanel);await flushPromises()
  await wrapper.get('[data-testid="studio-result-video"]').trigger('error')
  await wrapper.get('[data-testid="studio-refresh"]').trigger('click');await flushPromises()
  await wrapper.get('[data-testid="studio-result-video"]').trigger('error');repair.resolve();await flushPromises()
  expect(wrapper.find('.studio-result-loading').exists()).toBe(false)
  expect(wrapper.find('[data-testid="studio-result-retry-1"]').exists()).toBe(true)
  await wrapper.get('[data-testid="studio-result-retry-1"]').trigger('click');await flushPromises()
  expect(api.recover).toHaveBeenCalledTimes(2);expect(api.generate).not.toHaveBeenCalled()
 })

describe('Integrated reference tray and history UX',()=>{
 it('keeps two distinct images in selection order after out-of-order uploads and a collapsed tray',async()=>{
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'image',imageMode:'edit'}));api.catalog.mockResolvedValue([withImageReferences(3)]);api.history.mockResolvedValue([])
  const first=deferred<StudioAssetReceipt>(),second=deferred<StudioAssetReceipt>();api.upload.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-prompt"]').setValue('Use both references')
  const files=[imageFile('first.png'),imageFile('second.png')];await pick(files)
  const a={...receipt(files[0]!),asset_ref:'asset_11111111-0000-0000-0000-000000000000'},b={...receipt(files[1]!),asset_ref:'asset_22222222-0000-0000-0000-000000000000'}
  await wrapper.get('[data-testid="studio-assets-toggle"]').trigger('click');expect(wrapper.get('[data-testid="studio-assets-toggle"]').attributes('aria-expanded')).toBe('false');expect(wrapper.get('[data-testid="studio-assets"]').isVisible()).toBe(false)
  second.resolve(b);await flushPromises();expect(wrapper.get('[data-testid="studio-asset-summary"]').text()).toContain('1 项上传中');expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined()
  first.resolve(a);await flushPromises();expect(wrapper.get('[data-testid="studio-asset-summary"]').text()).toContain('图片 2 张');expect(wrapper.get('[data-testid="studio-asset-limits"]').text()).toContain('最多 3 张')
  api.request.mockClear();api.request.mockResolvedValueOnce({quote_token:'quote-two-images'}).mockRejectedValueOnce(new Error('synthetic prepare stop'))
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(api.request).toHaveBeenCalledWith('image','quotes',expect.objectContaining({spec:expect.objectContaining({images:2})}))
  expect(api.request).toHaveBeenCalledWith('image','prepare',expect.objectContaining({asset_refs:[a.asset_ref,b.asset_ref]}));expect(api.generate).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="studio-assets-toggle"]').trigger('click');expect(wrapper.findAll('[data-testid="studio-asset-success"]')).toHaveLength(2)
 })
 it('keeps a collapsed upload failure visible and blocks quotes until the failed item is removed',async()=>{
  api.catalog.mockResolvedValue([withImageReferences(3)]);api.history.mockResolvedValue([]);const pending=deferred<StudioAssetReceipt>();api.upload.mockReturnValueOnce(pending.promise)
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-prompt"]').setValue('Describe video');await pick([imageFile()]);await wrapper.get('[data-testid="studio-assets-toggle"]').trigger('click');pending.reject(new Error('asset_upload_failed'));await flushPromises()
  expect(wrapper.get('[data-testid="studio-asset-summary"]').text()).toContain('1 项上传失败');expect(wrapper.get('[data-testid="studio-asset-feedback"]').isVisible()).toBe(true);expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeDefined()
  api.request.mockClear();(wrapper.get('[data-testid="studio-quote"]').element as HTMLButtonElement).disabled=false;await wrapper.get('[data-testid="studio-quote"]').trigger('click');expect(api.request).not.toHaveBeenCalled()
  await wrapper.get('[data-testid="studio-assets-toggle"]').trigger('click');await wrapper.get('[data-testid="studio-asset-failure"] button').trigger('click');expect(wrapper.find('[data-testid="studio-assets-toggle"]').exists()).toBe(false);expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeUndefined()
 })
 it('prepares mixed references in order, respects total limit and pauses hidden video and audio',async()=>{
  const mixed={...offer,input_mode:'references',spec:{...offer.spec,references:{image:{min:0,max:2},video:{min:0,max:1},audio:{min:0,max:1},total_max:3}}};api.catalog.mockResolvedValue([mixed]);api.history.mockResolvedValue([])
  api.upload.mockImplementation(async(file:File,kind:StudioAssetReceipt['kind'])=>({...receipt(file),kind,asset_ref:`asset_${kind}-ordered`}))
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-prompt"]').setValue('Images and motion with music')
  const files=[imageFile(),new File(['12345678'],'motion.mp4',{type:'video/mp4'}),new File(['12345678'],'music.wav',{type:'audio/wav'})];await pick(files)
  expect(wrapper.get('[data-testid="studio-asset-video"]').attributes('src')).toMatch(/^blob:/);expect(wrapper.get('[data-testid="studio-asset-audio"]').attributes('src')).toMatch(/^blob:/)
  const pause=vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});await wrapper.get('[data-testid="studio-assets-toggle"]').trigger('click');expect(pause).toHaveBeenCalledTimes(2)
  await pick([imageFile('over-total.png')]);expect(api.upload).toHaveBeenCalledTimes(3);expect(wrapper.get('[data-testid="studio-asset-feedback"]').text()).toContain('素材数量上限')
  api.request.mockClear();api.request.mockResolvedValueOnce({preparation_id:'synthetic-preparation'}).mockRejectedValueOnce(new Error('synthetic quote stop'))
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  const expected=files.map(file=>({kind:file.type.split('/')[0],asset_ref:`asset_${file.type.split('/')[0]}-ordered`}))
  expect(api.request).toHaveBeenCalledWith('video','prepare',expect.objectContaining({spec:expect.objectContaining({images:1,videos:1,audio:1}),assets:expected}));expect(api.request).toHaveBeenCalledWith('video','quotes',expect.objectContaining({assets:expected,preparation_id:'synthetic-preparation'}));expect(api.generate).not.toHaveBeenCalled()
 })
 it('retains history search and status when returning from a task detail',async()=>{
  const completed={...prepared,id:'op_'+'c'.repeat(64),model:'Completed model',status:'completed',resultCount:1},failed={...prepared,id:'op_'+'d'.repeat(64),model:'Failed model',offerId:'removed-offer',status:'failed',billingState:'not_charged'};api.history.mockResolvedValue([completed,failed]);sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind:'video',view:'compose'}))
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-mode-history"]').trigger('click');await flushPromises();await wrapper.get('[data-testid="studio-history-status"]').setValue('failed');await wrapper.get('[data-testid="studio-history-search"]').setValue('Failed');expect(wrapper.findAll('[data-task-id]')).toHaveLength(1)
  await wrapper.get(`[data-task-id="${failed.id}"]`).trigger('click');await wrapper.get('.studio-back').trigger('click');expect(wrapper.find('[data-testid="studio-task"]').exists()).toBe(false);expect((wrapper.get('[data-testid="studio-history-search"]').element as HTMLInputElement).value).toBe('Failed');expect((wrapper.get('[data-testid="studio-history-status"]').element as HTMLSelectElement).value).toBe('failed');expect(wrapper.findAll('[data-task-id]')).toHaveLength(1)
 })
})


describe('Quote transition progress',()=>{
 beforeEach(()=>{api.request.mockReset().mockResolvedValue({paid_enabled:true});api.history.mockReset().mockResolvedValue([])})
 it.each(['image','video'] as const)('opens progress immediately for %s and reveals only the returned price',async kind=>{
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind}));api.history.mockResolvedValue([])
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-prompt"]').setValue('Synthetic quotation')
  const pending=deferred<unknown>();api.request.mockClear()
  api.request.mockImplementation(async (_kind:string,operation:string)=>operation==='quotes'&&kind==='image'?{quote_token:'synthetic-quote'}:pending.promise)
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises()
  expect(document.body.querySelector('[data-testid="studio-quote-progress"]')).not.toBeNull()
  expect(document.body.textContent).toContain('正在获取报价')
  expect(document.body.querySelector('[data-testid="studio-confirm-generate"]')).toBeNull()
  expect(document.body.textContent).not.toContain('尚未冻结余额')
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');expect(api.request).toHaveBeenCalledTimes(kind==='image'?2:1)
  pending.resolve({contract:kind==='image'?'published_image_binding_v1':'account_video_v1',[kind==='image'?'task_id':'operation_id']:(kind==='image'?'img_':'op_')+'c'.repeat(kind==='image'?32:64),status:'prepared',model:'synthetic-video',offer_id:'offer',spec:{count:1},sale_price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'},expires_at:'2099-01-01'})
  await flushPromises()
  expect(document.body.querySelector('[data-testid="studio-quote-progress"]')).toBeNull()
  expect(document.body.textContent).toContain('确认本次生成');expect(document.body.textContent).toContain('0.80')
  expect(document.body.textContent).toContain('尚未冻结余额')
  expect((document.body.querySelector('[data-testid="studio-confirm-generate"]') as HTMLButtonElement).disabled).toBe(false)
  expect(api.generate).not.toHaveBeenCalled()
 })
 it.each(['image','video'] as const)('closes %s progress on failure and preserves editable input',async kind=>{
  sessionStorage.setItem('studio-media-view-1',JSON.stringify({kind}));api.history.mockResolvedValue([])
  wrapper=mount(StudioMediaPanel);await flushPromises();await wrapper.get('[data-testid="studio-prompt"]').setValue('Keep this prompt')
  const pending=deferred<unknown>(),history=deferred<StudioTask[]>();api.request.mockImplementation(()=>pending.promise);api.history.mockReturnValueOnce(history.promise)
  await wrapper.get('[data-testid="studio-quote"]').trigger('click');await flushPromises();pending.reject(new Error('quote unavailable'));await flushPromises()
  await vi.waitFor(()=>expect(wrapper.findAllComponents({name:'BaseDialog'})[0]!.props('show')).toBe(false))
  expect(wrapper.findAllComponents({name:'BaseDialog'})[0]!.props('title')).not.toBe('正在获取报价')
  expect((wrapper.get('[data-testid="studio-prompt"]').element as HTMLTextAreaElement).value).toBe('Keep this prompt')
  history.resolve([]);await flushPromises()
  expect(wrapper.get('[data-testid="studio-quote"]').attributes('disabled')).toBeUndefined();expect(api.generate).not.toHaveBeenCalled()
 })
})
