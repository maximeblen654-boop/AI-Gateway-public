import { CompilePlan, CompilePublishedPlan, Materialize } from '../api/video-request-builder.mjs';
import { createOperationJournal } from './operation-journal.js';
import { createVideoDelivery } from './video-delivery.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const VIDEO_CONTRACT = 'account_video_v1';
export const VIDEO_PAID_ENABLED = false;
const fail = message => { throw new Error(message); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function createAccountVideoClient({baseUrl,serviceToken,fetchImpl=fetch}) {
  const root=new URL(baseUrl);
  if (!['https:','http:'].includes(root.protocol) || root.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(root.hostname) || root.username || root.password || root.search || root.hash || typeof serviceToken!=='string'||serviceToken.length<32) fail('Invalid video Bridge');
  return async (session,method,operation,payload,keyRef) => {
    if (!['GET','POST'].includes(method)||! /^(catalog|readiness|quotes|prepare|tasks|tasks\/av_[A-Za-z0-9_-]+(?:\/(result|capture|release))?)$/.test(operation)) fail('Invalid video operation');
    const body=method==='POST'?JSON.stringify({key_ref:keyRef||0,payload}):undefined;
    if(body&&Buffer.byteLength(body)>32*1024*1024)fail('media_request_too_large');
    const response=await fetchImpl(new URL(`/api/v1/internal/studio/video/${operation}`,root),{method,redirect:'error',signal:AbortSignal.timeout(960000),
      headers:{'Content-Type':'application/json','X-Studio-Service-Token':serviceToken,'X-Studio-Session-Proof':session.sessionProof,'X-Studio-Binding-Contract':VIDEO_CONTRACT,...(keyRef?{'X-Studio-Key-Ref':String(keyRef)}:{})},
      body});
    if(!response.ok) fail('Video bridge unavailable; recover the original task');
    const chunks=[];let size=0;
    for await (const chunk of response.body) {size+=chunk.length;if(size>140_000_000)fail('Video response too large');chunks.push(chunk)}
    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // Bridge owns the transport envelope and always returns account_video_v1;
    // the operation-specific Core contract is carried in payload.
    if(value.code!==0||value.data?.contract!==VIDEO_CONTRACT||!Number.isSafeInteger(value.data.key_ref)||value.data.key_ref<=0||keyRef&&keyRef!==value.data.key_ref)fail('Video identity mismatch');
    if(operation==='prepare') {
      const payload=value.data.payload;
      if(payload?.contract!=='account_video_reference_prepare_v1' || typeof payload.preparation_id!=='string' || !payload.preparation_id || !Array.isArray(payload.receipts)) fail('Reference preparation contract mismatch');
      return {...payload,key_ref:value.data.key_ref};
    }
    return value.data;
  };
}

// Legacy is a recovery adapter only. There is deliberately no public method to
// create a new slot task; all prepare calls require a Core-issued opaque quote.
export function createAccountVideoRuntime({rootDir,call,resultStore,legacy,now=Date.now}) {
  const journal=createOperationJournal({rootDir});
  const preparationRoot=path.join(rootDir,'preparations');fs.mkdirSync(preparationRoot,{recursive:true,mode:0o700});
  const owner=session=> {if(!Number.isSafeInteger(session?.ownerId)||session.ownerId<=0)fail('Owner required');return session.ownerId};
  const preparationPath=(uid,id)=>path.join(preparationRoot,createHash('sha256').update(`${uid}:${id}`).digest('hex')+'.json');
  const readPreparation=(session,id)=>{const uid=owner(session);if(typeof id!=='string'||!id)return undefined;try{const value=JSON.parse(fs.readFileSync(preparationPath(uid,id),'utf8'));if(value.owner_id!==uid||value.preparation_id!==id)return undefined;return value;}catch{return undefined;}};
  const writePreparation=(uid,value)=>{const file=preparationPath(uid,value.preparation_id),tmp=`${file}.${randomUUID()}.tmp`;const fd=fs.openSync(tmp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file);};
  async function catalog(session){owner(session);return (await call(session,'GET','catalog')).payload;}
  async function prepareReferences(session,payload) {
    const uid=owner(session);
    const {model,...corePayload}=payload;
    const reply=await call(session,'POST','prepare',corePayload);
    if(reply?.contract!=='account_video_reference_prepare_v1' || typeof reply.preparation_id!=='string' || !reply.preparation_id || !Array.isArray(reply.receipts)) fail('Reference preparation contract mismatch');
    writePreparation(uid,{owner_id:uid,preparation_id:reply.preparation_id,offer_id:payload.offer_id,model:payload.model,spec:payload.spec,assets:(payload.assets||[]).map(a=>({asset_ref:a.asset_ref,kind:a.kind,mime_type:a.mime_type,size:a.size,sha256:a.sha256,duration_seconds:a.duration_seconds})),asset_refs:(payload.assets||[]).map(a=>a.asset_ref),result:reply});
    return reply;
  }
  function getPreparation(session,id){return readPreparation(session,id);}
  async function prepare(session,{clientKey,offerId,request,preparationId}) {
    const uid=owner(session);
    const existing=journal.getByClientKey(uid,clientKey);
    let profile=existing?.children[0]?.account.builder_profile;
    if (!existing) {
      const offers=(await catalog(session))?.offers;
      const selected=offers?.find(o=>o.offer_id===offerId && o.model===request.model);
      if (!selected) fail('unsupported_model');
      profile=selected.video_profile;
    }
    const input={...request,ownerId:String(uid)};
    const plan=profile?CompilePublishedPlan(input,profile):CompilePlan(input),wire=Materialize(plan);
    if(wire.bytes.length>24*1024*1024)fail('media_request_too_large');
    if(existing){
      const child=existing.children[0];
      if(existing.version!==2||child.account.binding.offer.offer_id!==offerId||child.bodySha256!==wire.requestHash||child.account.preparation_id!==preparationId)fail('Idempotency conflict');
      return view(existing);
    }
    const assets=request.assets||[],counts={image:0,video:0,audio:0};for(const a of assets)counts[a.type]++;
    const spec={resolution:request.resolution,duration_seconds:request.duration,aspect_ratio:request.ratio,quality:'',count:1,images:counts.image,videos:counts.video,audio:counts.audio};
    const quotePayload={offer_id:offerId,spec,request:JSON.parse(wire.bytes.toString('utf8')),...(preparationId?{preparation_id:preparationId}:{})};
    const reply=await call(session,'POST','quotes',quotePayload);
    const q=reply.payload,b=q?.binding;
    if(q?.contract!==VIDEO_CONTRACT||!digest(q.quote_token)||!digest(q.binding_hash)||b?.version!==VIDEO_CONTRACT||b.owner.user_id!==uid||b.owner.api_key_id!==reply.key_ref||b.offer.offer_id!==offerId||b.offer.site_model!==request.model||b.request_hash!==wire.requestHash||b.offer.adapter.revision!==wire.adapterRevision||b.offer.sale_price.currency!=='CNY'||Date.parse(b.expires_at)<=now())fail('Quote binding mismatch');
    const op=journal.createIntent({ownerId:uid,clientKey,quoteId:b.quote_id,capabilityRevision:b.offer.adapter.revision,currency:b.offer.sale_price.currency,
      children:[{bodyBytes:wire.bytes,account:{...q,key_ref:reply.key_ref,plan,...(profile?{builder_profile:profile}:{}),...(preparationId?{preparation_id:preparationId}:{})}}]});
    return view(op);
  }
  function get(session,id){const op=journal.getForOwner(owner(session),id);if(!op)fail('Operation not found');return op;}
  function view(op){return {operation_id:op.operationId,contract:op.version===2?VIDEO_CONTRACT:'legacy_slot',children:op.children.map(c=>({task_id:c.childId,status:c.status,...(c.account?{sale_price:c.account.binding.offer.sale_price}: {})}))};}
  function child(session,id){const op=get(session,id);if(op.version!==2)fail('Legacy task requires original recovery');return op.children[0];}
  async function current(session,c){const s=(await call(session,'GET',`tasks/${c.childId}`,undefined,c.account.key_ref)).payload;
    if(s?.contract!==VIDEO_CONTRACT||s.task_id!==c.childId||s.binding_hash!==c.account.binding_hash||s.request_hash!==c.bodySha256)fail('Recovery identity mismatch');return s;}
  async function dispatch(session,id){
    const c=child(session,id),op=get(session,id);
    journal.readChildBody(owner(session),id,0);
    const fresh=child(session,id);
    if(fresh.status==='intent'){
      // Persist before the only submission. A lost response only leads to GET.
      journal.markDispatching(owner(session),id,0);
      try {await call(session,'POST','tasks',{quote_token:c.account.quote_token,task_id:c.childId},c.account.key_ref);}catch{return {operation_id:op.operationId,status:'unknown'};}
    }
    return recover(session,id);
  }
  async function settled(session,c,action,payload){
    const p=(await call(session,'POST',`tasks/${c.childId}/${action}`,payload,c.account.key_ref)).payload;
    const status=action==='capture'?'captured':'released';
    if(p?.contract!==VIDEO_CONTRACT||p.task_id!==c.childId||p.status!==status)fail('Settlement receipt mismatch');
    return {ownerId:owner(session),childId:c.childId,status};
  }
  function delivery(session,id){
    const c=child(session,id),uid=owner(session);
    const ledger={
      async getSettlement(){const s=await current(session,c);return {ownerId:uid,childId:c.childId,status:s.status==='captured'?'captured':s.status==='released'?'released':'held'};},
      async capture({evidence}){if(!digest(evidence.resultHash)||evidence.bindingHash!==c.account.binding_hash)fail('Durable result proof required');return settled(session,c,'capture',{result_hash:evidence.resultHash});},
      async release(){return settled(session,c,'release',{});},
    };
    const supplier={
      async getTask(){const s=await current(session,c);return {task_id:s.upstream_id,status:s.status==='captured'?'completed':s.status};},
      async downloadOriginal(){const p=(await call(session,'GET',`tasks/${c.childId}/result`,undefined,c.account.key_ref)).payload;
        if(!p||typeof p.bytes_base64!=='string'||!['video/mp4','video/webm'].includes(p.mime_type))fail('Original missing');
        const bytes=Buffer.from(p.bytes_base64,'base64');return {status:200,response:new Response(bytes,{headers:{'Content-Type':p.mime_type,'Content-Length':String(bytes.length),'X-Video-Quality':'original'}})};},
    };
    return createVideoDelivery({journal,ledger,supplier,resultStore,coordinator:{inspectTask:()=>current(session,c),reconcileChild:()=>ledger.release()}});
  }
  async function recover(session,id){
    const op=get(session,id);
    if(op.version===1){if(!legacy)fail('Original slot recovery adapter unavailable');return legacy.recover(session,id);}
    const c=op.children[0],s=await current(session,c);
    if(s.upstream_id&&['dispatching','accepted'].includes(c.status))journal.markAccepted(owner(session),id,0,s.upstream_id);
    if(['completed','captured','failed'].includes(s.status)){await delivery(session,id).operation.reconcileChild(owner(session),id,0);s.status=s.status==='failed'?'released':'captured';}
    return {...view(get(session,id)),status:s.status};
  }
  async function original(session,id,options){const op=get(session,id);if(op.version===1){if(!legacy)fail('Original slot recovery adapter unavailable');return legacy.original(session,id,options)};return delivery(session,id).openOriginal(owner(session),id,0,options);}
  return {catalog,prepare,prepareReferences,getPreparation,dispatch,recover,original,history:session=>journal.listForOwner(owner(session)).items.map(view)};
}
