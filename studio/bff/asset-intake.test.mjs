import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAssetIntake } from './asset-intake.mjs';
import { createImageHandler } from './image-server.mjs';
import { createHash } from 'node:crypto';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');

test('local asset store persists, verifies and isolates opaque refs across restart', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-assets-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sha256=createHash('sha256').update(png).digest('hex');
  const first=createAssetIntake({rootDir:root});
  const saved=await first.save({ownerId:7,kind:'image',mimeType:'image/png',sha256,bytes:png});
  assert.match(saved.assetRef,/^asset_[a-f0-9-]{36}$/);
  const restarted=createAssetIntake({rootDir:root});
  const receipt=restarted.inlineReceipt(7,saved.assetRef);
  assert.equal(receipt.ownerId,'7');assert.equal(receipt.type,'image');assert.equal(receipt.size,png.length);
  assert.throws(()=>restarted.inlineReceipt(8,saved.assetRef),/asset_not_found/);
  assert.throws(()=>restarted.inlineReceipt(7,'asset_00000000-0000-0000-0000-000000000000'),/asset_not_found/);
});

test('asset store rejects digest and media type mismatches before persistence', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-assets-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const intake=createAssetIntake({rootDir:root});
  const badHash='0'.repeat(64);
  await assert.rejects(()=>intake.save({ownerId:7,kind:'image',mimeType:'image/png',sha256:badHash,bytes:png}),/asset_hash_mismatch/);
  await assert.rejects(()=>intake.save({ownerId:7,kind:'video',mimeType:'video/mp4',sha256:createHash('sha256').update(png).digest('hex'),bytes:png}),/asset_type_mismatch/);
  assert.deepEqual(await fs.readdir(root),[]);
});

test('asset upload route performs real HTTP intake with session ownership and restart readback', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-assets-http-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const intake=createAssetIntake({rootDir:root});
  const sessions={authenticate:async request=>request.headers.cookie==='u7'?{ownerId:7}:null,sameOrigin:request=>request.headers.origin==='https://studio.example'};
  const tasks={};
  const server=(await import('node:http')).createServer(createImageHandler({sessions,tasks,assetIntake:intake}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/studio/api/assets/uploads`;
  const sha256=createHash('sha256').update(png).digest('hex');
  const headers={Cookie:'u7',Origin:'https://studio.example','X-Studio-Request':'asset-intake-v1','X-Studio-Asset-Kind':'image','X-Content-SHA256':sha256,'Content-Type':'image/png'};
  const response=await fetch(url,{method:'POST',headers,body:png});
  assert.equal(response.status,201);
  const receipt=await response.json();
  assert.match(receipt.asset_ref,/^asset_[a-f0-9-]{36}$/);
  const restarted=createAssetIntake({rootDir:root});
  assert.equal(restarted.inlineReceipt(7,receipt.asset_ref).size,png.length);
  const forbidden=await fetch(url,{method:'POST',headers:{...headers,Cookie:'u8'},body:png});
  assert.equal(forbidden.status,401);
});

test('image prepare accepts only private refs and never dispatches', async t=>{
 const http=await import('node:http');let prepares=0;
 const server=http.createServer(createImageHandler({sessions:{authenticate:async()=>({ownerId:7}),sameOrigin:()=>true},tasks:{prepare:(s,input)=>{prepares++;assert.deepEqual(input.asset_refs,[]);return {task:{task_id:'local'}}},view:t=>t,dispatch:()=>assert.fail('must not dispatch')}}));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=body=>fetch(`http://127.0.0.1:${server.address().port}/studio/api/image/prepare`,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Request':'image-binding-v1'},body:JSON.stringify(body)});
 assert.equal((await post({references:['https://untrusted.invalid/reference']})).status,409);assert.equal(prepares,0);
 assert.equal((await post({asset_refs:[]})).status,200);assert.equal(prepares,1);
});
