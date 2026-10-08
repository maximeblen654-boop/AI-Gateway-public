import http from 'node:http';
import {createAccountVideoClient,createAccountVideoRuntime} from './video-account.mjs';
import {createVideoResultStore} from './video-result-store.mjs';
import {createVideoHandler} from './video-handler.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createImageResultStore } from './image-result-store.mjs';
import { createPublishedImageClient, createImageTaskRuntime, IMAGE_BINDING_CONTRACT, IMAGE_PAID_ENABLED } from './image-binding.mjs';
import { createAssetIntake, assetIntakeContract } from './asset-intake.mjs';
import { createVideoAssetResolver } from './video-assets.mjs';
import {legacyRecoveryFromEnvironment} from './video-legacy-recovery.mjs';
const {createCoreStudioClient,createStudioSessionBridge}=createRequire(import.meta.url)('./studio-session.js');

async function jsonBody(request) {
  let bytes=0;const chunks=[];
  for await (const chunk of request) {bytes+=chunk.length;if(bytes>1<<20)throw new Error('Image request too large');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createImageHandler({ sessions, tasks, assetIntake, paidEnabled=IMAGE_PAID_ENABLED }) {
  return async (req,res) => {
    function reply(status,body) {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));}
    try {
      const url=new URL(req.url,'http://localhost');
      if(url.search) {reply(400,{error:'invalid_image_path'});return;}
      if(req.method==='GET'&&url.pathname==='/health'){reply(200,{service:'studio-bff',contract:IMAGE_BINDING_CONTRACT,node:process.versions.node});return;}
      if(req.method==='POST' && url.pathname==='/studio/api/session/exchange') {
        const body=await jsonBody(req);
        const exchange=await sessions.exchange(req,body.ticket);
        if(!exchange) {reply(401,{error:'invalid_studio_ticket'});return;}
        res.setHeader('Set-Cookie',exchange.cookie);reply(200,{owner_id:exchange.ownerId});return;
      }
      const session=await sessions.authenticate(req);
      if(!session) {reply(401,{error:'image_session_required'});return;}
      const requestContract = url.pathname==='/studio/api/assets/uploads' ? 'asset-intake-v1' : 'image-binding-v1';
      if(req.method!=='GET' && (!sessions.sameOrigin(req) || req.headers['x-studio-request']!==requestContract)) {reply(403,{error:'image_csrf'});return;}
      if(req.method==='DELETE' && url.pathname==='/studio/api/session') {res.setHeader('Set-Cookie',sessions.clear(req));reply(200,{ok:true});return;}
      if(req.method==='GET' && url.pathname==='/studio/api/session') {reply(200,{owner_id:session.ownerId});return;}
      if(req.method==='GET' && url.pathname==='/studio/api/assets/readiness') {reply(200,{contract:assetIntakeContract,enabled:Boolean(assetIntake)});return;}
      if(req.method==='POST' && url.pathname==='/studio/api/assets/uploads') {
        if (!assetIntake) { reply(503,{error:'asset_store_unavailable',uploaded:false,supplier_request_sent:false}); return; }
        if (!sessions.sameOrigin(req) || req.headers['x-studio-request']!=='asset-intake-v1') {
          reply(403,{error:'asset_csrf'}); return;
        }
        const kind=req.headers['x-studio-asset-kind'];
        const mimeType=req.headers['content-type'];
        const sha256=req.headers['x-content-sha256'];
        if(!['image','video','audio'].includes(kind) || typeof mimeType!=='string' ||
          !/^(image|video|audio)\/[a-z0-9.+-]+$/.test(mimeType) || !mimeType.startsWith(`${kind}/`) ||
          typeof sha256!=='string' || !/^[a-f0-9]{64}$/.test(sha256)) {
          reply(400,{error:'invalid_asset_headers'}); return;
        }
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>assetIntakeContract.maxBytes){reply(413,{error:'asset_too_large'});return;}chunks.push(chunk);}
        if(size<8){reply(422,{error:'asset_unusable'});return;}
        try {
          const saved=await assetIntake.save({ownerId:session.ownerId,kind,mimeType,sha256,bytes:Buffer.concat(chunks,size)});
          if(!saved || typeof saved.assetRef!=='string' || saved.kind!==kind || saved.mimeType!==mimeType || saved.size!==size) throw new Error('invalid_asset_receipt');
          reply(201,{asset_ref:saved.assetRef,kind,mime_type:saved.mimeType,size:saved.size,duration_seconds:saved.durationSeconds});
        } catch(error) {
          const invalid=new Set(['invalid_asset_input','asset_hash_mismatch','asset_type_mismatch','media_probe_failed','invalid_image','invalid_media_type','media_duration_unknown']);
          reply(invalid.has(error?.message)?422:503,{error:invalid.has(error?.message)?'asset_unusable':'asset_store_unavailable',uploaded:false,supplier_request_sent:false});
        }
        return;
      }
      if(req.method==='GET' && url.pathname==='/studio/api/image/readiness') {
        const enabled=paidEnabled===true && (await tasks.readiness(session)).paid_enabled===true;
        reply(200,{contract:IMAGE_BINDING_CONTRACT,paid_enabled:enabled});return;
      }
      if(req.method==='GET' && url.pathname==='/studio/api/image/catalog') {reply(200,await tasks.catalog(session));return;}
      if(req.method==='GET' && url.pathname==='/studio/api/image/tasks') {reply(200,tasks.history(session));return;}
      if(req.method==='POST' && url.pathname==='/studio/api/image/quotes') {reply(200,await tasks.quote(session,await jsonBody(req)));return;}
      if(req.method==='POST' && url.pathname==='/studio/api/image/prepare') {
        const input=await jsonBody(req);
        if(!input || !Array.isArray(input.asset_refs) || Object.hasOwn(input,'references'))throw Error('Private asset refs required');
        reply(200,tasks.view(tasks.prepare(session,input).task));return;
      }
      if(req.method==='POST' && url.pathname==='/studio/api/image/tasks') {
        if(paidEnabled!==true){reply(503,{error:'published_image_paid_gate_off'});return;}
        const input=await jsonBody(req);
        const stored=input&&Object.keys(input).length===1&&/^img_[a-f0-9]{32}$/.test(input.task_id);
        if(!stored&&(!input || !Array.isArray(input.asset_refs) || Object.hasOwn(input,'references')))throw Error('Private asset refs required');
        reply(200,await tasks.dispatch(session,input));return;
      }
      const match=/^\/studio\/api\/image\/tasks\/(img_[a-f0-9]{32})(?:\/results\/([0-9]))?$/.exec(url.pathname);
      if(req.method==='GET' && match) {
        if(match[2]===undefined) {reply(200,await tasks.recover(session,match[1]));return;}
        const result=tasks.result(session,match[1],Number(match[2]));
        res.writeHead(200,{'Content-Type':result.info.mime_type,'Content-Length':result.data.length,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':`attachment; filename="${match[1]}-${match[2]}.${result.info.extension}"`});res.end(result.data);return;
      }
      reply(404,{error:'image_route_not_found'});
    } catch(error) {if(!res.headersSent)reply(409,{error:error?.message==='image_quote_expired'?'image_quote_expired':'image_binding_unavailable',recovery:'GET original task only'});else res.end();}
  };
}

export function buildImageServer(env=process.env, {legacyVideo}={}) {
  legacyVideo ??= legacyRecoveryFromEnvironment(env);
  const root=env.STUDIO_IMAGE_DATA_ROOT;
  if(!root || !path.isAbsolute(root) || !env.STUDIO_PUBLIC_ORIGIN)throw new Error('Private root and public origin required');
  const common={baseUrl:env.STUDIO_BRIDGE_URL,serviceToken:env.STUDIO_BRIDGE_SERVICE_TOKEN};
  const sessions=createStudioSessionBridge({core:createCoreStudioClient(common),publicOrigin:env.STUDIO_PUBLIC_ORIGIN,secureCookies:env.STUDIO_PUBLIC_ORIGIN.startsWith('https:')});
  const assetRoot=env.STUDIO_ASSET_ROOT;
  if(assetRoot && !path.isAbsolute(assetRoot))throw new Error('Private asset root required');
  const assetIntake=assetRoot?createAssetIntake({rootDir:assetRoot,ffprobePath:env.STUDIO_FFPROBE_PATH||'ffprobe'}):undefined;
  const imageAssetResolver=assetIntake?(session,refs)=>refs.map(ref=>{const a=assetIntake.uploadPayload(session.ownerId,ref);if(a.kind!=='image')throw Error('image_reference_required');return `data:${a.mimeType};base64,${Buffer.from(a.bytes).toString('base64')}`}):undefined;
  const tasks=createImageTaskRuntime({rootDir:path.join(root,'journal'),call:createPublishedImageClient(common),results:createImageResultStore({rootDir:path.join(root,'results')}),assetResolver:imageAssetResolver});
  const imageHandler=createImageHandler({sessions,tasks,assetIntake,paidEnabled:env.STUDIO_IMAGE_PUBLISHED_SUBMISSION==='true'});
  if(!env.STUDIO_VIDEO_DATA_ROOT)return http.createServer(imageHandler);
  if(!path.isAbsolute(env.STUDIO_VIDEO_DATA_ROOT))throw new Error('Private video root required');
  const videoTasks=createAccountVideoRuntime({rootDir:path.join(env.STUDIO_VIDEO_DATA_ROOT,'journal'),call:createAccountVideoClient(common),resultStore:createVideoResultStore({rootDir:path.join(env.STUDIO_VIDEO_DATA_ROOT,'results')}),legacy:legacyVideo});
  const resolveAssets=createVideoAssetResolver({intake:assetIntake,tasks:videoTasks});
  const videoHandler=createVideoHandler({sessions,tasks:videoTasks,resolveAssets,paidEnabled:env.STUDIO_VIDEO_ACCOUNT_SUBMISSION==='true'});
  return http.createServer((req,res)=>{
    return req.url.startsWith('/studio/api/video/')||req.url.startsWith('/studio/api/operations')?videoHandler(req,res):imageHandler(req,res);
  });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const server=buildImageServer();server.listen(Number(process.env.STUDIO_IMAGE_BFF_PORT||8092),process.env.STUDIO_IMAGE_BFF_HOST||'127.0.0.1');
}
