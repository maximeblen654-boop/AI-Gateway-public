import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createVideoResultStore} from './video-result-store.mjs';

const identity={mode:'account_video_v1',ownerId:1,childId:'av_spec',taskId:'original',accountId:7,bindingHash:'a'.repeat(64),requestHash:'b'.repeat(64)};
const media=new Map();
function syntheticVideo(size='320x180',seconds=2) {
 const key=`${size}/${seconds}`;
 if(!media.has(key))media.set(key,execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=blue:s=${size}:r=5`,'-t',String(seconds),'-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{windowsHide:true,maxBuffer:1<<20}));
 return media.get(key);
}
function fixture(t){const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'video-spec-'));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));const make=()=>createVideoResultStore({rootDir});make.rootDir=rootDir;return make;}

test('valid originals retain their bytes regardless of geometry or duration',async t=>{
 for(const [name,size,seconds] of [
  ['pixels','160x90',2],
  ['ratio','320x320',2],
  ['duration','320x180',1],
 ])await t.test(name,t=>{
  const make=fixture(t),store=make(),bytes=syntheticVideo(size,seconds);
  const saved=store.put(identity,{bytes,mimeType:'video/mp4'});
  assert.equal(saved.version,2);
  assert.deepEqual(store.load(identity).bytes,bytes);
  assert.deepEqual(make().load(identity).bytes,bytes);
  assert.equal(make().load(identity).sha256,saved.sha256);
 });
});

test('historical v1/v2 metadata and optional measurements are read without rewriting them',async t=>{
 for(const variant of ['v1','v2-unmeasured','v2-measured'])await t.test(variant,t=>{
  const make=fixture(t),bytes=syntheticVideo('160x90'),saved=make().put(identity,{bytes,mimeType:'video/mp4'});
  const metaFile=path.join(make.rootDir,fs.readdirSync(make.rootDir)[0],'meta.json');
  const meta=JSON.parse(fs.readFileSync(metaFile));
  if(variant==='v1'){delete meta.media;meta.version=1;}
  else meta.media=variant==='v2-measured'?{version:1,width:160,height:90,frames:10,durationMicros:2000000}:null;
  const old=JSON.stringify(meta);fs.writeFileSync(metaFile,old);
  assert.deepEqual(make().load(identity).bytes,bytes);assert.equal(make().load(identity).sha256,saved.sha256);
  assert.equal(fs.readFileSync(metaFile,'utf8'),old);
  for(const changed of [{...identity,accountId:9},{...identity,requestHash:'c'.repeat(64)},{...identity,bindingHash:'d'.repeat(64)}])assert.throws(()=>make().load(changed),/video_result_identity_mismatch/);
  assert.equal(make().load({...identity,ownerId:9}),null);
 });
});

test('missing, truncated, wrong-format and oversized originals remain invalid',t=>{
 const make=fixture(t),bytes=syntheticVideo();
 for(const invalid of [Buffer.alloc(0),Buffer.from('not a video'),bytes.subarray(0,60)])assert.throws(()=>make().put(identity,{bytes:invalid,mimeType:'video/mp4'}),/video_result_/);
 assert.throws(()=>make().put(identity,{bytes,mimeType:'video/webm'}),/video_result_type_mismatch/);
 const small=createVideoResultStore({rootDir:make.rootDir,maxResultBytes:bytes.length-1});
 assert.throws(()=>small.put(identity,{bytes,mimeType:'video/mp4'}),/video_result_invalid_media/);
 make().put(identity,{bytes,mimeType:'video/mp4'});
 const originalFile=path.join(make.rootDir,fs.readdirSync(make.rootDir)[0],'original.bin');
 const corrupted=Buffer.from(bytes);corrupted[corrupted.length-1]^=1;fs.writeFileSync(originalFile,corrupted);
 assert.throws(()=>make().load(identity),/video_result_corrupt/);
});
