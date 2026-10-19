import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { createVideoResultStore } from './video-result-store.mjs';

const TTL = 48 * 3600000;
const BASE = Date.parse('2026-10-19T00:00:00.000Z');
const identity = { mode: 'account_video_v1', ownerId: 1, childId: 'retention', taskId: 'original',
  accountId: 7, bindingHash: 'a'.repeat(64), requestHash: 'b'.repeat(64) };
let original;
function video() {
  return original ||= execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=5',
    '-t', '4', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p',
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 20 });
}
function fixture(t, options = {}) {
  const tempRoot = process.env.VIDEO_STORE_TEST_ROOT || os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(tempRoot, 'video-retention-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let clock = BASE;
  return { rootDir, now: value => { clock = value; },
    make: () => createVideoResultStore({ rootDir, now: () => clock, ...options }),
    files: () => {
      const directory = path.join(rootDir, fs.readdirSync(rootDir).find(name => /^[a-f0-9]{64}$/.test(name)));
      return { directory, meta: path.join(directory, 'meta.json'), original: path.join(directory, 'original.bin') };
    } };
}
const put = (store, who = identity, options = {}) => store.put(who, { bytes: video(), mimeType: 'video/mp4', ...options });

test('v3 uses one fixed 48-hour promise; exact boundary rejects reads before cleanup and after restart', t => {
  const f = fixture(t), store = f.make(), saved = put(store);
  assert.equal(saved.version, 3);
  assert.equal(saved.policy, 'video_original_48h');
  assert.equal(saved.storedAt, new Date(BASE).toISOString());
  assert.equal(saved.expiresAt, new Date(BASE + TTL).toISOString());
  f.now(BASE + TTL - 1);
  assert.equal(store.has(identity), true);
  assert.deepEqual(store.load(identity).bytes, video());
  assert.equal(put(f.make()).expiresAt, saved.expiresAt);
  f.now(BASE + TTL);
  assert.equal(store.has(identity), false);
  assert.equal(store.metadata(identity).expired, true);
  assert.equal(store.metadata(identity).missing, false);
  assert.throws(() => store.load(identity), /video_result_expired/);
  assert.throws(() => put(f.make()), /video_result_expired/);
  const metaBefore = fs.readFileSync(f.files().meta, 'utf8');
  assert.deepEqual(store.cleanup(), { scanned: 1, deleted: 1, deletedBytes: video().length, failed: 0, hasMore: false });
  assert.equal(fs.existsSync(f.files().original), false);
  assert.equal(fs.readFileSync(f.files().meta, 'utf8'), metaBefore);
  const restarted = f.make(), info = restarted.metadata(identity);
  assert.equal(info.expired, true);
  assert.equal(info.deleted, true);
  assert.equal(info.sha256, saved.sha256);
  assert.equal(info.taskId, identity.taskId);
  assert.throws(() => restarted.load(identity), /video_result_expired/);
  assert.throws(() => put(restarted, identity, { expiresAt: BASE + 2 * TTL }), /video_result_expired/);
  assert.equal(restarted.cleanup().deletedBytes, 0);
  assert.deepEqual(fs.readdirSync(f.rootDir), [path.basename(f.files().directory)]);
});

test('trusted Core deadline supports ISO or epoch milliseconds and is never renewed', async t => {
  for (const kind of ['ISO', 'milliseconds']) await t.test(kind, t => {
    const f = fixture(t), store = f.make(), deadline = BASE + 3600000;
    const saved = put(store, identity, { expiresAt: kind === 'ISO' ? new Date(deadline).toISOString() : deadline });
    assert.equal(saved.expiresAt, new Date(deadline).toISOString());
    f.now(BASE + 1000);
    assert.equal(put(f.make(), identity, { expiresAt: BASE + TTL }).expiresAt, saved.expiresAt);
    f.now(deadline);
    assert.throws(() => f.make().load(identity), /video_result_expired/);
  });
});

test('invalid, expired or overlong trusted deadlines do not publish new originals', t => {
  const f = fixture(t), store = f.make();
  for (const expiresAt of [null, 'soon', NaN, Infinity, BASE + TTL + 1, new Date(BASE + TTL + 1).toISOString()]) {
    assert.throws(() => put(store, identity, { expiresAt }), /video_result_retention_invalid/);
  }
  for (const expiresAt of [BASE, BASE - 1, new Date(BASE - 1).toISOString()]) {
    assert.throws(() => put(store, identity, { expiresAt }), /video_result_expired/);
  }
  assert.equal(store.load(identity), null);
  assert.equal(store.metadata(identity), null);
  assert.equal(store.has(identity), false);
  assert.deepEqual(fs.readdirSync(f.rootDir), []);
});

test('Core persistence one day ago preserves the same origin and deadline during recovery copying', t => {
  const f = fixture(t), origin = BASE - TTL / 2, deadline = origin + TTL, store = f.make();
  const saved = put(store, identity, { persistedAt: new Date(origin).toISOString(), expiresAt: new Date(deadline).toISOString() });
  assert.equal(saved.storedAt, new Date(origin).toISOString());
  assert.equal(saved.expiresAt, new Date(deadline).toISOString());
  assert.equal(Date.parse(saved.expiresAt) - Date.parse(saved.storedAt), TTL);
  f.now(BASE + 1000);
  assert.equal(put(f.make(), identity, { persistedAt: BASE, expiresAt: BASE + TTL }).storedAt, saved.storedAt);
  assert.equal(f.make().metadata(identity).expiresAt, saved.expiresAt);
  const numeric = put(store, { ...identity, childId: 'numeric_origin' }, { persistedAt: origin });
  assert.equal(numeric.storedAt, saved.storedAt);
  assert.equal(numeric.expiresAt, saved.expiresAt);
  for (const persistedAt of [null, 'yesterday', NaN, BASE + 1001, new Date(BASE + 1001).toISOString()]) {
    assert.throws(() => put(store, { ...identity, childId: 'invalid_origin' }, { persistedAt }), /video_result_retention_invalid/);
  }
  assert.throws(() => put(store, { ...identity, childId: 'overlong_origin' }, { persistedAt: origin, expiresAt: deadline + 1 }), /video_result_retention_invalid/);
  assert.throws(() => put(store, { ...identity, childId: 'expired_origin' }, { persistedAt: BASE - TTL }), /video_result_expired/);
  f.now(deadline);
  assert.throws(() => f.make().load(identity), /video_result_expired/);
  assert.throws(() => put(f.make(), identity, { persistedAt: BASE, expiresAt: BASE + TTL }), /video_result_expired/);
});

test('metadata and has inspect only metadata and file stat, without loading complete originals', t => {
  const f = fixture(t), store = f.make(); put(store);
  const read = fs.readFileSync;
  fs.readFileSync = function(file, ...args) {
    if (String(file).endsWith('original.bin')) throw new Error('original bytes must not be read');
    return read.call(this, file, ...args);
  };
  try {
    assert.equal(store.metadata(identity).size, video().length);
    assert.equal(store.has(identity), true);
    assert.throws(() => store.load(identity), /original bytes must not be read/);
  } finally { fs.readFileSync = read; }
});

test('cleanup failure retains bytes for a later bounded retry and reports only actual release', t => {
  const f = fixture(t), store = f.make(); put(store); f.now(BASE + TTL);
  const unlink = fs.unlinkSync;
  fs.unlinkSync = function(file) {
    if (String(file) === f.files().original) throw Object.assign(new Error('synthetic permission error'), { code: 'EACCES' });
    return unlink.call(this, file);
  };
  try {
    assert.deepEqual(store.cleanup({ limit: 1 }), { scanned: 1, deleted: 0, deletedBytes: 0, failed: 1, hasMore: false });
    assert.equal(fs.existsSync(f.files().original), true);
  } finally { fs.unlinkSync = unlink; }
  assert.deepEqual(f.make().cleanup({ limit: 1 }), { scanned: 1, deleted: 1, deletedBytes: video().length, failed: 0, hasMore: false });
  assert.equal(f.make().cleanup().deleted, 0);
  assert.equal(f.make().metadata(identity).expired, true);
});

test('bounded cleanup rotates across identities, keeps tombstones, and leaves pending staging alone', t => {
  const f = fixture(t), store = f.make();
  for (let index = 0; index < 3; index++) put(store, { ...identity, childId: `bounded_${index}` });
  const pending = path.join(f.rootDir, '.pending-00000000-0000-0000-0000-000000000000');
  fs.mkdirSync(pending); fs.writeFileSync(path.join(pending, 'original.bin'), 'pending');
  f.now(BASE + TTL);
  let deleted = 0, released = 0;
  for (let index = 0; index < 3; index++) {
    const stats = store.cleanup({ limit: 1 });
    assert.equal(stats.scanned, 1); assert.equal(stats.failed, 0); assert.equal(stats.hasMore, index < 2);
    deleted += stats.deleted; released += stats.deletedBytes;
  }
  assert.equal(deleted, 3); assert.equal(released, 3 * video().length);
  assert.equal(fs.readFileSync(path.join(pending, 'original.bin'), 'utf8'), 'pending');
  assert.equal(store.cleanup({ limit: 3 }).deleted, 0);
  for (const limit of [0, -1, 1001, 1.5]) assert.throws(() => store.cleanup({ limit }), /Bounded/);
});

test('historical v1/v2 originals have no inferred expiry and remain byte-for-byte unchanged', async t => {
  for (const version of [1, 2]) await t.test(`v${version}`, t => {
    const f = fixture(t), store = f.make(); put(store);
    const file = f.files().meta, meta = JSON.parse(fs.readFileSync(file));
    meta.version = version; delete meta.expiresAt;
    if (version === 1) delete meta.media;
    else meta.media = { version: 1, width: 160, height: 90, durationMicros: 4000000 };
    const historical = JSON.stringify(meta); fs.writeFileSync(file, historical);
    f.now(BASE + 100 * TTL);
    assert.equal(store.metadata(identity).expired, false);
    assert.equal(store.metadata(identity).policy, 'legacy_unknown');
    assert.equal(store.has(identity), true);
    assert.deepEqual(f.make().load(identity).bytes, video());
    assert.equal(put(f.make()).version, version);
    assert.deepEqual(store.cleanup(), { scanned: 1, deleted: 0, deletedBytes: 0, failed: 0, hasMore: false });
    assert.equal(fs.readFileSync(file, 'utf8'), historical);
    assert.equal(fs.existsSync(f.files().original), true);
  });
});

test('deleted bytes leave capacity available while the immutable identity remains protected', t => {
  const f = fixture(t, { maxResultBytes: video().length, maxStoreBytes: 2 * video().length + 4096 }), store = f.make();
  put(store);
  const second = { ...identity, childId: 'capacity_second' };
  assert.throws(() => put(store, second), /video_result_capacity/);
  f.now(BASE + TTL);
  assert.equal(store.cleanup().deletedBytes, video().length);
  assert.ok(put(store, second));
  assert.throws(() => store.load({ ...identity, taskId: 'different' }), /video_result_identity_mismatch/);
  assert.throws(() => put(store), /video_result_expired/);
});

test('invalid v3 promises fail closed and cleanup never removes unverified bytes', t => {
  const f = fixture(t), store = f.make(); put(store);
  const file = f.files().meta, meta = JSON.parse(fs.readFileSync(file));
  meta.expiresAt = new Date(BASE + 2 * TTL).toISOString(); fs.writeFileSync(file, JSON.stringify(meta));
  f.now(BASE + 3 * TTL);
  assert.throws(() => store.load(identity), /video_result_corrupt/);
  assert.deepEqual(store.cleanup(), { scanned: 1, deleted: 0, deletedBytes: 0, failed: 1, hasMore: false });
  assert.equal(fs.existsSync(f.files().original), true);
});

test('legacy key-slot identities also write v3 without changing binding validation', t => {
  const f = fixture(t), store = f.make();
  const who = { ownerId: 1, childId: 'legacy_slot', taskId: 'upstream', keySlotId: 'slot1', requestHash: 'c'.repeat(64) };
  assert.equal(put(store, who).version, 3);
  assert.deepEqual(store.load(who).bytes, video());
  assert.throws(() => store.metadata({ ...who, keySlotId: 'slot2' }), /video_result_identity_mismatch/);
});

test('trusted legacy import preserves unlimited retention without changing existing v3 deadlines', t => {
  const f = fixture(t), store = f.make();
  const historical = put(store, identity, { legacy: true });
  assert.equal(historical.version, 2);
  assert.equal(historical.expiresAt, undefined);
  const modern = { ...identity, childId: 'modern' }, saved = put(store, modern);
  assert.equal(put(store, modern, { legacy: true }).expiresAt, saved.expiresAt);
  assert.throws(() => put(store, { ...identity, childId: 'ambiguous' }, { legacy: true, expiresAt: BASE + TTL }), /video_result_retention_invalid/);
  f.now(BASE + 2 * TTL);
  assert.equal(store.has(identity), true);
  assert.deepEqual(store.load(identity).bytes, video());
  assert.throws(() => put(store, modern, { legacy: true }), /video_result_expired/);
  assert.equal(store.cleanup().deleted, 1);
  assert.equal(f.make().metadata(identity).expired, false);
});

test('concurrent processes publish one immutable deadline and recovery cannot renew it', async t => {
  const f = fixture(t), gate = new SharedArrayBuffer(4), workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  const source = `const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { createVideoResultStore } = await import(workerData.module);
      const store = createVideoResultStore({ rootDir: workerData.rootDir, now: () => workerData.now });
      parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(workerData.gate), 0, 0);
      const saved = store.put(workerData.identity, { bytes: Buffer.from(workerData.bytes, 'base64'), mimeType: 'video/mp4' });
      parentPort.postMessage({storedAt:saved.storedAt,expiresAt:saved.expiresAt,sha256:saved.sha256});
    })().catch(error => { throw error; });`;
  const ready = [], done = [];
  for (const now of [BASE, BASE + 5000]) {
    const worker = new Worker(source, { eval: true, workerData: { rootDir: f.rootDir,
      module: new URL('./video-result-store.mjs', import.meta.url).href, identity, bytes: video().toString('base64'), now, gate } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => { worker.on('error', reject); worker.once('message', resolve); }));
    done.push(new Promise((resolve, reject) => { worker.on('error', reject); worker.on('message', message => { if (!message.ready) resolve(message); }); }));
  }
  await Promise.all(ready);
  Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
  const saved = await Promise.all(done);
  assert.deepEqual(saved[0], saved[1]);
  assert.ok([BASE, BASE + 5000].includes(Date.parse(saved[0].storedAt)));
  assert.equal(Date.parse(saved[0].expiresAt) - Date.parse(saved[0].storedAt), TTL);
  assert.equal(fs.readdirSync(f.rootDir).length, 1);
  f.now(BASE + TTL + 5000);
  assert.equal(f.make().cleanup().deleted, 1);
  assert.throws(() => put(f.make()), /video_result_expired/);
});
