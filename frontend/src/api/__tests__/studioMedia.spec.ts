import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const client=vi.hoisted(()=>({get:vi.fn(),post:vi.fn()}))
vi.mock('../client',()=>({apiClient:client,buildGatewayUrl:(v:string)=>v}))
import { ensureStudioSession, studioRequest, studioTaskView, studioResultUrl, studioErrorMessage, StudioError } from '../studioMedia'
beforeEach(()=>{vi.clearAllMocks();localStorage.clear()})
afterEach(()=>vi.unstubAllGlobals())
it('switching website accounts replaces an earlier Studio session through a real ticket exchange',async()=>{
 client.get.mockResolvedValue({data:{id:2}});client.post.mockResolvedValue({data:{ticket:'synthetic-ticket'}})
 const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({owner_id:1}))).mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2})));vi.stubGlobal('fetch',fetch)
 expect(await ensureStudioSession()).toEqual({owner_id:2});expect(client.post).toHaveBeenCalledWith('/auth/studio-ticket');expect(fetch.mock.calls[1][0]).toBe('/studio/api/session/exchange')
})
it('result URLs come from validated task identity, never a supplier URL in the response',()=>{
 const v={contract:'published_image_binding_v1',task_id:'img_'+'a'.repeat(32),status:'completed',spec:{count:1},sale_price:{amount:'1.25',currency:'CNY',billing_mode:'per_request'},results:[{url:'https://untrusted.invalid'}]}
 const task=studioTaskView('image',v);expect(studioResultUrl(task)).toBe(`/studio/api/image/tasks/${v.task_id}/results/0`);expect(()=>studioTaskView('image',{...v,task_id:'https://untrusted.invalid'})).toThrow();expect(()=>studioTaskView('image',{...v,sale_price:{amount:'NaN'}})).toThrow()
})
it('upstream error details are not displayed',()=>{
 expect(studioErrorMessage(new StudioError('synthetic-secret-response',503))).not.toContain('synthetic-secret-response');expect(studioErrorMessage(new StudioError('image_quote_expired',409))).toContain('报价已失效')
})
it('an in-flight session for a previous website identity cannot send a new business request',async()=>{
 localStorage.setItem('auth_token','synthetic-user-a');client.get.mockResolvedValueOnce({data:{id:1}}).mockResolvedValueOnce({data:{id:2}})
 let finish!:(v:Response)=>void
 const fetch=vi.fn().mockImplementationOnce(()=>new Promise<Response>(r=>{finish=r})).mockResolvedValueOnce(new Response(JSON.stringify({owner_id:2}))).mockResolvedValueOnce(new Response(JSON.stringify({offers:[]})));vi.stubGlobal('fetch',fetch)
 const old=studioRequest('image','catalog');const rejected=expect(old).rejects.toThrow('studio_session_changed');await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1))
 localStorage.setItem('auth_token','synthetic-user-b');const current=studioRequest('image','catalog');finish(new Response(JSON.stringify({owner_id:1})))
 await rejected;expect(await current).toEqual({offers:[]});expect(fetch.mock.calls.filter(c=>String(c[0]).endsWith('/catalog'))).toHaveLength(1);expect(client.get).toHaveBeenCalledTimes(2)
})
it('valid blocked and pending Core states remain recoverable without presenting success',()=>{
 for(const status of ['reserve_pending','recovery_blocked'])expect(studioTaskView('video',{contract:'account_video_v1',operation_id:'op_'+'a'.repeat(64),status,spec:{count:1},sale_price:{amount:'0.80',currency:'CNY',billing_mode:'per_request'}}).resultCount).toBe(0)
})
