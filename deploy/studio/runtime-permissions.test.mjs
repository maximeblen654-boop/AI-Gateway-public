// Run in the BFF image with --network none --user 0 --entrypoint node.
// Root is used only to create synthetic root:0700 fixtures and perform an
// explicit local handoff. The application child always runs as uid/gid 1000.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('private root handoff, durable restart and owner isolation', {
  skip: process.platform !== 'linux' || process.getuid() !== 0,
}, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-permission-'));
  fs.chmodSync(root, 0o755);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const env = {...process.env, STUDIO_LEGACY_VIDEO_RECOVERY: 'false'};
  for (const name of ['STUDIO_ASSET_ROOT', 'STUDIO_IMAGE_DATA_ROOT', 'STUDIO_VIDEO_DATA_ROOT']) {
    env[name] = path.join(root, name);
    fs.mkdirSync(env[name], {mode: 0o700});
  }
  const child = code => spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: '/app', env, uid: 1000, gid: 1000, encoding: 'utf8', timeout: 15000,
  });
  const check = "import {checkRuntime} from './deploy/studio/check-runtime.mjs'; checkRuntime();";
  const denied = child(check);
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /private_owner_required/);
  for (const name of ['STUDIO_ASSET_ROOT', 'STUDIO_IMAGE_DATA_ROOT', 'STUDIO_VIDEO_DATA_ROOT']) {
    fs.chownSync(env[name], 1000, 1000);
    assert.equal(fs.statSync(env[name]).mode & 0o777, 0o700);
  }
  const write = child(check + `
    import {createImageTaskRuntime} from './studio/bff/image-binding.mjs';
    const session={ownerId:1,sessionProof:'synthetic'};
    const q={contract:'published_image_binding_v1',quote_token:'a'.repeat(64),spec:{count:1,images:0},sale_price:{currency:'CNY',billing_mode:'per_request',amount:'0.01'},expires_at:new Date(Date.now()+60000).toISOString()};
    const runtime=createImageTaskRuntime({rootDir:process.env.STUDIO_IMAGE_DATA_ROOT,call:async()=>({key_ref:1,payload:q})});
    await runtime.quote(session,{offer_id:'synthetic',spec:{}});
    runtime.prepare(session,{quote_token:q.quote_token,client_key:'local-only-intent',prompt:'synthetic',asset_refs:[]});
  `);
  assert.equal(write.status, 0, write.stderr);
  const read = child(check + `
    import assert from 'node:assert/strict';
    import {createImageTaskRuntime} from './studio/bff/image-binding.mjs';
    const runtime=createImageTaskRuntime({rootDir:process.env.STUDIO_IMAGE_DATA_ROOT});
    assert.equal(runtime.history({ownerId:1}).tasks.length,1);
    assert.equal(runtime.history({ownerId:2}).tasks.length,0);
    const original=runtime.history({ownerId:1}).tasks[0];
    assert.throws(()=>runtime.result({ownerId:2},original.task_id,0));
  `);
  assert.equal(read.status, 0, read.stderr);
});
