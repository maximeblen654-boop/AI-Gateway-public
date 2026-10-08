import { VIDEO_CONTRACT, VIDEO_PAID_ENABLED } from './video-account.mjs';
export function createVideoHandler({sessions,tasks,resolveAssets,paidEnabled=VIDEO_PAID_ENABLED}) {
  return async(req,res)=>{
    const reply=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
    try {
      const url=new URL(req.url,'http://localhost');if(url.search){reply(400,{error:'invalid_video_path'});return;}
      if(!url.pathname.startsWith('/studio-v2/api/video/')){reply(404,{error:'video_route_not_found'});return;}
      const session=await sessions.authenticate(req);if(!session){reply(401,{error:'video_session_required'});return;}
      if(!['GET','HEAD'].includes(req.method)&&(!sessions.sameOrigin(req)||req.headers['x-studio-request']!=='video-binding-v1')){reply(403,{error:'video_csrf'});return;}
      if(req.method==='GET'&&url.pathname==='/studio-v2/api/video/readiness'){reply(200,{contract:VIDEO_CONTRACT,paid_enabled:paidEnabled===true&&(await tasks.readiness(session)).paid_enabled===true});return;}
      if(req.method==='GET'&&url.pathname==='/studio-v2/api/video/catalog'){reply(200,await tasks.catalog(session));return;}
      if(req.method==='GET'&&url.pathname==='/studio-v2/api/video/operations'){reply(200,tasks.history(session));return;}
      if(req.method==='POST'&&url.pathname==='/studio-v2/api/video/prepare'){
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1<<20)throw Error('Request too large');chunks.push(chunk)}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!input||Object.keys(input).some(k=>!['offer_id','model','spec','assets'].includes(k))||typeof input.offer_id!=='string'||typeof input.model!=='string'||!input.spec||!Array.isArray(input.assets)||input.assets.some(a=>!a||Object.keys(a).some(k=>!['kind','asset_ref'].includes(k))||!['image','video','audio'].includes(a.kind)||typeof a.asset_ref!=='string'))throw Error('Invalid preparation');
        if(!resolveAssets)throw Error('asset_store_unavailable');
        const resolved=await resolveAssets(session,input.assets,input.offer_id,input.model,input.spec,{prepare:true});
        if(Array.isArray(resolved)||typeof resolved.preparationId!=='string')throw Error('account_bound_reference_upload_unavailable');
        reply(200,{contract:'studio_video_prepare_v1',preparation_id:resolved.preparationId,assets:input.assets.map(a=>({kind:a.kind,asset_ref:a.asset_ref}))});return;
      }
      if(req.method==='POST'&&url.pathname==='/studio-v2/api/video/quotes'){
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1<<20)throw Error('Request too large');chunks.push(chunk);}
        const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!input||Object.keys(input).some(k=>!['client_key','offer_id','model','prompt','duration','resolution','ratio','assets','preparation_id'].includes(k))||!Array.isArray(input.assets||[])||(input.assets||[]).some(asset=>!asset||Object.keys(asset).some(k=>!['kind','asset_ref'].includes(k))||!['image','video','audio'].includes(asset.kind)||typeof asset.asset_ref!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(asset.asset_ref)))throw Error('Invalid quote');
        if(!resolveAssets && (input.assets||[]).length)throw Error('asset_store_unavailable');
        const resolved=resolveAssets?await resolveAssets(session,input.assets||[],input.offer_id,input.model,{resolution:input.resolution,duration_seconds:input.duration,aspect_ratio:input.ratio},{preparationId:input.preparation_id}):[];
        const trustedAssets=Array.isArray(resolved)?resolved:resolved.assets;
        const preparationId=Array.isArray(resolved)?undefined:resolved.preparationId;
        reply(200,await tasks.prepare(session,{clientKey:input.client_key,offerId:input.offer_id,preparationId,request:{model:input.model,prompt:input.prompt,duration:input.duration,resolution:input.resolution,ratio:input.ratio,assets:trustedAssets}}));return;
      }
      if(req.method==='POST'&&url.pathname==='/studio-v2/api/video/tasks'){if(!paidEnabled){reply(503,{error:'account_video_paid_gate_off'});return;}let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>1024)throw Error('Request too large');chunks.push(chunk);}const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!input||Object.keys(input).length!==1||!/^op_[a-f0-9]{64}$/.test(input.operation_id))throw Error('Invalid operation');reply(200,await tasks.dispatch(session,input.operation_id));return;}
      const match=/^\/studio-v2\/api\/video\/operations\/(op_[a-f0-9]{64})(?:\/(?:children\/([0-9]{1,2})\/)?(original))?$/.exec(url.pathname);if(match&&req.method==='GET'&&!match[3]){reply(200,await tasks.recover(session,match[1]));return;}if(match&&match[3]&&['GET','HEAD'].includes(req.method)){const opened=await tasks.original(session,match[1],{method:req.method,range:req.headers.range,index:Number(match[2]||0)});res.writeHead(opened.status,Object.fromEntries(opened.response.headers));res.end(Buffer.from(await opened.response.arrayBuffer()));return;}reply(404,{error:'video_route_not_found'});
    } catch(error){if(!res.headersSent){const known=new Set(['video_quote_expired','media_request_too_large','asset_store_unavailable','account_bound_reference_upload_unavailable','account_video_preparation_missing','account_video_preparation_mismatch','reference_receipt_count_mismatch','reference_receipt_order_mismatch','unsupported_model','asset_type_mismatch','asset_not_found','asset_corrupt']);reply(known.has(error?.message)?422:409,{error:known.has(error?.message)?error.message:'video_binding_unavailable',recovery:'original task only'});}else res.end();}
  };
}
