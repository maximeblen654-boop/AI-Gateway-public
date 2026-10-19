import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createImageResultStore } from './image-result-store.mjs';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const id='img_'+'a'.repeat(32);

test('new results expire at 72 hours and cleanup retains the immutable deadline proof',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'image-retention-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const base=Date.parse('2026-01-01T00:00:00.000Z');
 const store=createImageResultStore({rootDir:root,now:()=>base});
 store.saveBase64(1,id,0,png);
 assert.equal(store.metadata(1,id,0).expires_at,'2026-01-04T00:00:00.000Z');
 const later=createImageResultStore({rootDir:root,now:()=>base+72*3600000+1});
 assert.deepEqual(later.cleanup(),{bytes:0,deleted:1,deletedBytes:Buffer.from(png,'base64').length,failed:0,retried:0});
 assert.equal(fs.existsSync(path.join(root,'1',`${id}-0.png`)),false);
 assert.equal(fs.existsSync(path.join(`${root}.metadata`,'1',`${id}-0.png.meta.json`)),true);
 assert.throws(()=>later.saveBase64(1,id,0,png),/expired/i);
 assert.equal(later.hasTaskData(1,id),false);
});

test('legacy png keeps its original seven-day promise before physical cleanup',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'image-legacy-retention-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'1',`${id}-0.png`);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,Buffer.from(png,'base64'));
 const base=Date.parse('2026-01-10T00:00:00.000Z');fs.utimesSync(file,new Date(base-6*86400000),new Date(base-6*86400000));
 const store=createImageResultStore({rootDir:root,now:()=>base});
 assert.equal(store.cleanup().deleted,0);
 const late=createImageResultStore({rootDir:root,now:()=>base+2*86400000});
 assert.equal(late.cleanup().deleted,1);
 assert.equal(fs.existsSync(file),false);
});
