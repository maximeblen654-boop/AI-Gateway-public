import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

export const IMAGE_BINDING_CONTRACT = 'published_image_binding_v1';
export const IMAGE_PAID_ENABLED = false; // Default; only trusted server configuration may opt in.
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const taskPattern = /^img_[a-f0-9]{32}$/;
function syncDir(root) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(root, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function write(file, value, exclusive = false) {
  const target = exclusive ? file : `${file}.${randomBytes(16).toString('hex')}.tmp`;
  const fd = fs.openSync(target, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!exclusive) fs.renameSync(target, file);
  syncDir(path.dirname(file));
}
function privateDirectory(root) {
  if (!path.isAbsolute(root)) throw new Error('Private image journal root required');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory()) throw new Error('Unsafe image journal root');
  for(let parent=path.dirname(root);;parent=path.dirname(parent)) {syncDir(parent);if(path.dirname(parent)===parent)break;}
}

export function createPublishedImageClient({ baseUrl, serviceToken, fetchImpl = fetch }) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || typeof serviceToken !== 'string' || serviceToken.length < 32 ||
    base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname))) throw new Error('Private image bridge required');
  return async (session, method, operation, payload, keyRef = 0) => {
    if (!Number.isSafeInteger(session?.ownerId) || session.ownerId <= 0 || typeof session.sessionProof !== 'string') throw new Error('Image session required');
    const headers = { 'Content-Type':'application/json', 'X-Studio-Service-Token':serviceToken,
      'X-Studio-Session-Proof':session.sessionProof, 'X-Studio-Binding-Contract':IMAGE_BINDING_CONTRACT };
    if (keyRef) headers['X-Studio-Key-Ref'] = String(keyRef);
    const response = await fetchImpl(new URL(`/api/v1/internal/studio/image/${operation}`,base), {
      method, headers, ...(method === 'POST' ? { body:JSON.stringify({ key_ref:keyRef,payload }) } : {}),
      redirect:'error', signal:AbortSignal.timeout(960000),
    });
    if (!response.ok) throw new Error('Image bridge unavailable; receipt GET recovery only');
    const reader = response.body.getReader(), chunks=[];
    let size=0;
    for (;;) { const {done,value}=await reader.read(); if(done)break;size+=value.byteLength;
      if(size>32*1024*1024) {await reader.cancel();throw new Error('Image bridge response too large');} chunks.push(value); }
    const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(reply.code!==0 || reply.data?.contract!==IMAGE_BINDING_CONTRACT || !Number.isSafeInteger(reply.data.key_ref) || reply.data.key_ref<=0 || keyRef && reply.data.key_ref!==keyRef) throw new Error('Image binding contract mismatch');
    return reply.data;
  };
}

// Owner-scoped durable journal and permanent .sync-dispatch marker. Browser
// inputs never supply account identity, customer key identity or sale amounts.
export function createImageTaskRuntime({ rootDir, call, results, assetResolver, now = Date.now }) {
  privateDirectory(rootDir);
  const location = (kind,identity) => path.join(rootDir,`${kind}-${hash(identity)}.json`);
  function read(kind,identity) { const file=location(kind,identity);if(!fs.lstatSync(file).isFile())throw new Error('Unsafe journal entry');return JSON.parse(fs.readFileSync(file,'utf8')); }
  function owner(session) {if(!Number.isSafeInteger(session?.ownerId)||session.ownerId<=0)throw new Error('Image owner required');return session.ownerId;}
  async function catalog(session) {return (await call(session,'GET','catalog')).payload;}
  async function readiness(session) {return (await call(session,'GET','readiness')).payload;}
  async function quote(session,input) {
    const id=owner(session);
    if(!input || Object.keys(input).some(k=>!['offer_id','spec'].includes(k)))throw new Error('Invalid quote input');
    const reply=await call(session,'POST','quotes',input);
    const q=reply.payload;
    if(q?.contract!==IMAGE_BINDING_CONTRACT || !/^[a-f0-9]{64}$/.test(q.quote_token||'') || !Number.isInteger(q.spec?.count) || q.spec.count<1 || q.spec.count>10 || !Number.isInteger(q.spec?.images) || q.spec.images<0 || q.spec.images>16 || q.sale_price?.currency!=='CNY' || q.sale_price.billing_mode!=='per_request' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(q.sale_price.amount) || !Number.isFinite(Date.parse(q.expires_at)) || Date.parse(q.expires_at)<=now())throw new Error('Invalid Published quote response');
    write(location('quote',[id,q.quote_token]),{...q,keyRef:reply.key_ref,owner:id},true);
    return q;
  }
  function prepare(session,input) {
    const id=owner(session);
    if(!input || Object.keys(input).some(k=>!['quote_token','client_key','prompt','references','asset_refs'].includes(k)) || !/^[A-Za-z0-9._:-]{8,200}$/.test(input.client_key||'') || typeof input.prompt!=='string' || !input.prompt.trim() ||
      (!Array.isArray(input.references) && !Array.isArray(input.asset_refs)) || (Array.isArray(input.references)&&Array.isArray(input.asset_refs)) ||
      (Array.isArray(input.references)&&input.references.some(x=>typeof x!=='string')) || (Array.isArray(input.asset_refs)&&input.asset_refs.some(x=>typeof x!=='string'))) throw new Error('Invalid image task request');
    const references=Array.isArray(input.asset_refs)?(input.asset_refs.length===0?[]:assetResolver?assetResolver(session,input.asset_refs):(()=>{throw new Error('asset_store_unavailable')})()):input.references;
    if(!Array.isArray(references)||references.some(x=>typeof x!=='string')) throw new Error('Invalid resolved image references');
    const identity=[id,input.client_key],fingerprint=hash({quote_token:input.quote_token,client_key:input.client_key,prompt:input.prompt,references});
    try {const old=read('task',identity);if(old.owner!==id || old.requestHash!==fingerprint)throw new Error('Image task binding conflict');return {task:old,identity,first:false};}
    catch(error) {if(error.code!=='ENOENT')throw error;}
    const q=read('quote',[id,input.quote_token]);
    if(q.owner!==id || now()>=Date.parse(q.expires_at) || references.length!==q.spec.images)throw new Error('Image quote expired or reference mismatch');
    const task={contract:IMAGE_BINDING_CONTRACT,owner:id,keyRef:q.keyRef,task_id:`img_${randomBytes(16).toString('hex')}`,created_at:new Date(now()).toISOString(),requestHash:fingerprint,
      quote:q,request:{task_id:'',quote_token:input.quote_token,prompt:input.prompt,references},status:'prepared',results:[]};
    task.request.task_id=task.task_id;
    write(location('task',identity),task,true);
    write(location('identity',[id,task.task_id]),identity,true);
    return {task,identity,first:true};
  }
  function get(session,taskID) {
    const id=owner(session);if(!taskPattern.test(taskID))throw new Error('Invalid image task identity');
    const identity=read('identity',[id,taskID]),task=read('task',identity);
    const fingerprint=hash({quote_token:task.request.quote_token,client_key:identity[1],prompt:task.request.prompt,references:task.request.references});
    if(task.owner!==id || task.task_id!==taskID || task.contract!==IMAGE_BINDING_CONTRACT || task.requestHash!==fingerprint)throw new Error('Image owner/binding mismatch');
    return {task,identity};
  }
  async function recover(session,taskID) {
    const {task,identity}=get(session,taskID);
    const receipt=(await call(session,'GET',`tasks/${taskID}`,undefined,task.keyRef)).payload;
    if(receipt?.contract!==IMAGE_BINDING_CONTRACT || receipt.task_id!==taskID)throw new Error('Receipt identity mismatch');
    if(!['unknown','persisted','completed'].includes(receipt.status) || !['pending','billing_unknown','billed'].includes(receipt.billing_state))throw new Error('Receipt state mismatch');
    if(receipt.status==='completed' && receipt.billing_state==='billed' && receipt.result_available) {
      const payload=(await call(session,'GET',`tasks/${taskID}/result`,undefined,task.keyRef)).payload;
      if(!Array.isArray(payload?.data) || payload.data.length!==task.quote.spec.count)throw new Error('Result count mismatch');
      const saved=[];
      for(let i=0;i<payload.data.length;i++)saved.push(await results.saveResult(task.owner,taskID,i,payload.data[i]));
      task.results=saved;task.status='completed';write(location('task',identity),task);
    } else if(task.status!=='completed') {
      // A concurrent recovery may have completed while this GET was in flight.
      const latest=read('task',identity);
      if(latest.status==='completed')return view(latest);
      task.status=receipt.status==='persisted'?'billing_pending':'unknown';write(location('task',identity),task);
    }
    return view(task);
  }
  async function dispatch(session,input) {
    const {task,identity}=prepare(session,input);
    const marker=`${location('task',identity)}.sync-dispatch`;
    let first=false;
    try {write(marker,{contract:IMAGE_BINDING_CONTRACT,requestHash:task.requestHash},true);first=true;} catch(e){if(e.code!=='EEXIST')throw e;}
    if(first) {
      // No retry even on throw or missing response; recovery only issues GET.
      task.status='unknown';write(location('task',identity),task);
      await call(session,'POST','tasks',task.request,task.keyRef);
    }
    return recover(session,task.task_id);
  }
  function view(task) {return {contract:task.contract,task_id:task.task_id,created_at:task.created_at,status:task.status,results:task.results};}
  function history(session) {
    const id=owner(session),items=[];
    for(const file of fs.readdirSync(rootDir)) {
      if(!/^task-[a-f0-9]{64}\.json$/.test(file))continue;
      const entry=path.join(rootDir,file);if(!fs.lstatSync(entry).isFile())throw new Error('Unsafe journal entry');
      const task=JSON.parse(fs.readFileSync(entry,'utf8'));
      if(task.owner!==id)continue;
      const verified=get(session,task.task_id).task;
      items.push(view(verified));
    }
    return {contract:IMAGE_BINDING_CONTRACT,tasks:items.sort((a,b)=>(b.created_at||'').localeCompare(a.created_at||'')||a.task_id.localeCompare(b.task_id))};
  }
  function result(session,taskID,index) {const {task}=get(session,taskID);if(task.status!=='completed'||index<0||index>=task.quote.spec.count)throw new Error('Image result unavailable');return {data:results.read(task.owner,taskID,index),info:results.metadata(task.owner,taskID,index)};}
  return {catalog,readiness,quote,prepare,dispatch,recover,result,history,view};
}
