import fs from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
export const paidControlVersion='managed-v1';
export async function effectivePaid(tasks,session,legacy,managed){
 if(!managed)return legacy===true;
 try{const state=await tasks.readiness(session);return state.control_mode===paidControlVersion&&state.paid_enabled===true;}catch{return false;}
}
export function paidControlHandler(env){
 return (req,res)=>{
  const expected=Buffer.from(env.STUDIO_BRIDGE_SERVICE_TOKEN||'');const got=Buffer.from(req.headers['x-studio-service-token']||'');
  if(req.method!=='GET'||expected.length<32||got.length!==expected.length||!timingSafeEqual(expected,got)){res.writeHead(401);res.end();return;}
  const usable=root=>{try{fs.accessSync(root,fs.constants.R_OK|fs.constants.W_OK);return fs.statSync(root).isDirectory();}catch{return false;}};
  res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
  res.end(JSON.stringify({version:env.STUDIO_PAID_CONTROL_MODE==='managed-v1'?paidControlVersion:'legacy',ready:env.STUDIO_PAID_CONTROL_MODE==='managed-v1',image_ready:usable(env.STUDIO_IMAGE_DATA_ROOT),video_ready:usable(env.STUDIO_VIDEO_DATA_ROOT),assets:usable(env.STUDIO_ASSET_ROOT)}));
 };
}
