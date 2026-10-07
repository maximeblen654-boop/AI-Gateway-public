import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function checkRuntime(env=process.env){
  if(process.platform!=='win32'&&process.getuid()===0)throw Error('studio_non_root_user_required');
  const roots=['STUDIO_ASSET_ROOT','STUDIO_IMAGE_DATA_ROOT','STUDIO_VIDEO_DATA_ROOT'];
  if(env.STUDIO_LEGACY_VIDEO_RECOVERY==='true')roots.push('STUDIO_OPERATION_ROOT');
  const seen=[];
  for(const name of roots){
    const root=env[name];
    if(!root||!path.isAbsolute(root))throw Error(`${name}_absolute_root_required`);
    const resolved=path.resolve(root);
    if(seen.some(other=>resolved===other||resolved.startsWith(other+path.sep)||other.startsWith(resolved+path.sep)))throw Error('studio_state_roots_overlap');
    seen.push(resolved);
    for(let current=resolved;;current=path.dirname(current)){
      const stat=fs.lstatSync(current);
      if(!stat.isDirectory()||stat.isSymbolicLink())throw Error(`${name}_unsafe_root`);
      if(current===resolved&&process.platform!=='win32'&&(stat.uid!==process.getuid()||(stat.mode&0o077)!==0))throw Error(`${name}_private_owner_required`);
      if(path.dirname(current)===current)break;
    }
    fs.accessSync(resolved,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);
  }
  for(const tool of ['ffmpeg','ffprobe'])execFileSync(env[`STUDIO_${tool.toUpperCase()}_PATH`]||tool,['-version'],{stdio:'ignore',timeout:5000,windowsHide:true});
  return {service:'studio-bff',node:process.versions.node,private_roots:seen.length,media_tools:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{console.log(JSON.stringify(checkRuntime()))}catch(e){console.error(e.code==='EACCES'?'studio_state_access_denied':e.code==='ENOENT'?'studio_runtime_prerequisite_missing':e.message);process.exitCode=1;}
}
