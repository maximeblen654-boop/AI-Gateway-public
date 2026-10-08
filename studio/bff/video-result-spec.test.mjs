import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createVideoResultStore} from './video-result-store.mjs';
import {assertVideoResultSpec,decodedVideoMeasurement} from './video-result-spec.mjs';

const identity={mode:'account_video_v1',ownerId:1,childId:'av_spec',taskId:'original',accountId:7,bindingHash:'a'.repeat(64),requestHash:'b'.repeat(64)};
const expected={resolution:'320x180',aspect_ratio:'16:9',duration_seconds:2,count:1};
const media=new Map();
function syntheticVideo(size='320x180',seconds=2) {
 const key=`${size}/${seconds}`;
 if(!media.has(key))media.set(key,execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=blue:s=${size}:r=5`,'-t',String(seconds),'-an','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','frag_keyframe+empty_moov','-f','mp4','pipe:1'],{windowsHide:true,maxBuffer:1<<20}));
 return media.get(key);
}
function fixture(t){const rootDir=fs.mkdtempSync(path.join(os.tmpdir(),'video-spec-'));t.after(()=>fs.rmSync(rootDir,{recursive:true,force:true}));const make=()=>createVideoResultStore({rootDir});make.rootDir=rootDir;return make;}

test('decoded video dimensions and timeline must match the frozen spec, including after restart',async t=>{
 for(const [name,size,seconds,error] of [
  ['pixels','160x90',2,/video_result_dimensions_mismatch/],
  ['ratio','320x320',2,/video_result_aspect_mismatch/],
  ['duration','320x180',1,/video_result_duration_mismatch/],
 ])await t.test(name,t=>{
  const make=fixture(t),store=make(),bytes=syntheticVideo(size,seconds);
  assert.throws(()=>store.put(identity,{bytes,mimeType:'video/mp4'},expected),error);
  // A structurally valid but wrong original remains private evidence. It can
  // never become a capture proof merely by restarting or reopening the store.
  assert.deepEqual(store.load(identity).bytes,bytes);
  assert.throws(()=>make().load(identity,expected),error);
 });
});

test('missing frame timestamps, rotation, or changing decoded dimensions are unverifiable',()=>{
 const probe={streams:[{codec_type:'video',width:320,height:180,sample_aspect_ratio:'1:1'}],frames:[{media_type:'video',width:320,height:180,best_effort_timestamp_time:'0',duration_time:'2'}]};
 assert.doesNotThrow(()=>assertVideoResultSpec(decodedVideoMeasurement(probe,1),expected));
 for(const change of [
  p=>delete p.frames[0].best_effort_timestamp_time,
  p=>delete p.frames[0].duration_time,
  p=>p.frames[0].height=160,
  p=>p.streams[0].side_data_list=[{rotation:90}],
  p=>p.streams[0].sample_aspect_ratio='2:1',
 ]){
  const changed=structuredClone(probe);change(changed);
  assert.throws(()=>assertVideoResultSpec(decodedVideoMeasurement(changed,1),expected),/video_result_metadata_missing/);
 }
 assert.throws(()=>assertVideoResultSpec(null,expected),/video_result_metadata_missing/);
});

test('older original metadata is decoded again against the frozen order without rewriting it',t=>{
 const make=fixture(t),store=make();
 store.put(identity,{bytes:syntheticVideo('160x90'),mimeType:'video/mp4'});
 // Simulate the pre-check metadata schema, without changing original bytes.
 const digest=store.load(identity).sha256;
 const metaFile=path.join(make.rootDir,fs.readdirSync(make.rootDir)[0],'meta.json');
 const meta=JSON.parse(fs.readFileSync(metaFile));delete meta.media;meta.version=1;
 const old=JSON.stringify(meta);fs.writeFileSync(metaFile,old);
 assert.throws(()=>make().load(identity,expected),/video_result_dimensions_mismatch/);
 assert.equal(store.load(identity).sha256,digest);
 assert.equal(fs.readFileSync(metaFile,'utf8'),old);
});

test('matching decoded result is durable; unproven named resolution is not a pixel guarantee',t=>{
 const make=fixture(t),bytes=syntheticVideo(),saved=make().put(identity,{bytes,mimeType:'video/mp4'},expected);
 assert.deepEqual(make().load(identity,expected).bytes,bytes);
 assert.equal(saved.version,2,'v1 rollback readers must not treat new originals as unchecked settlement evidence');
 assert.equal(saved.media.width,320);assert.equal(saved.media.height,180);assert.equal(saved.media.durationMicros,2000000);
 assert.throws(()=>make().load(identity,{...expected,resolution:'720p'}),/video_result_resolution_unverifiable/);
 assert.throws(()=>make().load(identity,{...expected,count:2}),/video_result_spec_invalid/);
});
