import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createVideoResultStore } from './video-result-store.mjs';
import { validVideoCover, VIDEO_COVER_MAX_BYTES } from './video-cover.mjs';

const identity = { mode: 'account_video_v1', ownerId: 1, childId: 'cover-test', taskId: 'original',
  accountId: 7, bindingHash: 'a'.repeat(64), requestHash: 'b'.repeat(64) };
const BASE = Date.parse('2026-10-24T00:00:00Z'), TTL = 48 * 3600000;
let original;
function video() {
  return original ||= execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=5',
    '-t', '1', '-an', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p',
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1'], { windowsHide: true, maxBuffer: 1 << 20 });
}
function fixture(t) {
  const tempRoot = process.env.VIDEO_STORE_TEST_ROOT || os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true });
  const rootDir = fs.mkdtempSync(path.join(tempRoot, 'video-cover-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  let clock = BASE;
  const make = options => createVideoResultStore({ rootDir, now: () => clock, ...options });
  const store = make();
  const saved = store.put(identity, { bytes: video(), mimeType: 'video/mp4' });
  const directory = path.join(rootDir, fs.readdirSync(rootDir)[0]);
  return { store, saved, rootDir, directory, make, now: value => { clock = value; },
    meta: path.join(directory, 'meta.json'), original: path.join(directory, 'original.bin'),
    sidecar: path.join(directory, `cover-v1-${saved.sha256}.jpg`) };
}

test('a real small JPEG is generated asynchronously once, persists across restart and never rewrites original/meta', async t => {
  const f = fixture(t), meta = fs.readFileSync(f.meta), originalStat = fs.statSync(f.original);
  const rename = fs.renameSync, read = fs.readFileSync;
  let published = 0, eventLoopRan = false;
  fs.renameSync = (from, to) => { if (String(to) === f.sidecar) published++; return rename(from, to); };
  fs.readFileSync = (file, ...args) => {
    assert.notEqual(String(file), f.original, 'cover never synchronously reads complete original');
    return read(file, ...args);
  };
  let results;
  try {
    const pending = Promise.all([f.store.cover(identity), f.make().cover(identity), f.store.cover(identity)]);
    setImmediate(() => { eventLoopRan = true; });
    results = await pending;
    assert.equal(eventLoopRan, true);
    assert.equal(published, 1, 'requests across store instances share generation');
    const cached = await f.make({ ffmpegPath: 'missing-cover-decoder' }).cover(identity);
    assert.deepEqual(cached.bytes, results[0].bytes, 'restart uses sidecar without decoder');
  } finally { fs.renameSync = rename; fs.readFileSync = read; }
  const cover = results[0];
  assert.equal(validVideoCover(cover.bytes), true);
  assert.ok(cover.bytes.length < VIDEO_COVER_MAX_BYTES);
  assert.equal(cover.expiresAt, f.saved.expiresAt);
  for (const result of results) assert.deepEqual(result.bytes, cover.bytes);
  assert.deepEqual(fs.readFileSync(f.meta), meta);
  assert.deepEqual(f.store.load(identity).bytes, video());
  assert.equal(fs.statSync(f.original).mtimeMs, originalStat.mtimeMs);
  assert.ok(f.store.put({ ...identity, childId: 'next-original' }, { bytes: video(), mimeType: 'video/mp4' }), 'sidecar is accepted by capacity scan');
  t.diagnostic(JSON.stringify({ originalBytes: video().length, coverBytes: cover.bytes.length,
    maxEdge: 480, published, cacheHitWithoutDecoder: true }));
});

test('cover source identity and ownership fail closed without modifying saved files', async t => {
  const f = fixture(t);
  await f.store.cover(identity);
  for (const changed of [{ ownerId: 2 }, { childId: '../escape' }, { accountId: 8 },
    { taskId: 'different' }, { bindingHash: 'f'.repeat(64) }, { requestHash: 'f'.repeat(64) }]) {
    await assert.rejects(f.store.cover({ ...identity, ...changed }));
  }
  assert.deepEqual(f.store.load(identity).bytes, video());
  fs.unlinkSync(f.original);
  await assert.rejects(f.store.cover(identity), /video_cover_unavailable/);
  assert.equal(fs.existsSync(f.sidecar), true, 'orphan cannot be served');
});

test('expiry denies cached covers at the exact boundary; cleanup removes derivatives with original and keeps tombstone', async t => {
  const f = fixture(t), cover = await f.store.cover(identity), meta = fs.readFileSync(f.meta);
  f.now(BASE + TTL - 1);
  assert.deepEqual((await f.make().cover(identity)).bytes, cover.bytes);
  f.now(BASE + TTL);
  await assert.rejects(f.store.cover(identity), /video_result_expired/);
  const stats = f.store.cleanup();
  assert.equal(stats.deleted, 1);
  assert.equal(stats.deletedBytes, video().length + cover.bytes.length);
  assert.equal(stats.failed, 0);
  assert.deepEqual(fs.readdirSync(f.directory), ['meta.json']);
  assert.deepEqual(fs.readFileSync(f.meta), meta);
  await assert.rejects(f.make().cover(identity), /video_result_expired/);
});

test('historical v1/v2 Account originals generate lazily without changing original retention', async t => {
  for (const version of [1, 2]) await t.test(`v${version}`, async t => {
    const f = fixture(t), meta = JSON.parse(fs.readFileSync(f.meta));
    meta.version = version; delete meta.expiresAt;
    if (version === 1) delete meta.media;
    const old = JSON.stringify(meta); fs.writeFileSync(f.meta, old);
    f.now(BASE + 100 * TTL);
    assert.equal(validVideoCover((await f.store.cover(identity)).bytes), true);
    assert.equal(fs.readFileSync(f.meta, 'utf8'), old);
    assert.equal(f.store.cleanup().deletedBytes, 0);
  });
});

test('missing decoder, corrupt sidecar, corrupt source and capacity failure leave original delivery available', async t => {
  const f = fixture(t), meta = fs.readFileSync(f.meta);
  await assert.rejects(f.make({ ffmpegPath: 'missing-cover-decoder' }).cover(identity), /video_cover_unavailable/);
  assert.deepEqual(f.store.load(identity).bytes, video());
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['meta.json', 'original.bin']);
  const bounded = f.make({ maxResultBytes: video().length, maxStoreBytes: video().length + meta.length });
  await assert.rejects(bounded.cover(identity), /video_cover_unavailable/);
  assert.deepEqual(bounded.load(identity).bytes, video());
  const good = await f.store.cover(identity);
  fs.writeFileSync(f.sidecar, 'incomplete-jpeg');
  assert.deepEqual((await f.store.cover(identity)).bytes, good.bytes);
  fs.unlinkSync(f.sidecar);
  const broken = Buffer.from(video()); broken[broken.length - 1] ^= 1; fs.writeFileSync(f.original, broken);
  await assert.rejects(f.store.cover(identity), /video_cover_unavailable/);
  assert.equal(fs.existsSync(f.sidecar), false, 'corrupt source cannot publish a derivative');
  assert.deepEqual(fs.readFileSync(f.meta), meta);
});

test('source symlinks cannot expose another file when file symlinks are supported', async t => {
  const f = fixture(t), external = path.join(f.rootDir, 'other.bin');
  fs.writeFileSync(external, video()); fs.unlinkSync(f.original);
  try { fs.symlinkSync(external, f.original, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('symlink creation unavailable'); return; } throw error; }
  await assert.rejects(f.store.cover(identity), /video_result_unsafe_path/);
  assert.deepEqual(fs.readFileSync(external), video());
});

test('root, result directory, source and cover symlink guards fail closed before reading their bytes', async t => {
  const f = fixture(t); await f.store.cover(identity);
  const lstat = fs.lstatSync, read = fs.readFileSync;
  for (const target of [f.rootDir, f.directory, f.original, f.sidecar]) {
    let forbiddenRead = false;
    fs.lstatSync = (file, ...args) => {
      const stat = lstat(file, ...args);
      if (String(file) !== target) return stat;
      const link = Object.create(stat); link.isSymbolicLink = () => true; return link;
    };
    fs.readFileSync = (file, ...args) => {
      if (String(file) === target) forbiddenRead = true;
      return read(file, ...args);
    };
    try { await assert.rejects(f.store.cover(identity)); assert.equal(forbiddenRead, false); }
    finally { fs.lstatSync = lstat; fs.readFileSync = read; }
  }
  assert.deepEqual(f.store.load(identity).bytes, video());
});

test('expiry while an asynchronous cold cover is pending cannot publish or return a fresh cover', async t => {
  const f = fixture(t), pending = f.store.cover(identity);
  setImmediate(() => { f.now(BASE + TTL); });
  await assert.rejects(pending, /video_result_expired/);
  assert.equal(fs.existsSync(f.sidecar), false);
  assert.equal(fs.existsSync(f.original), true);
  assert.equal(f.store.metadata(identity).expired, true);
});

test('cover JPEG validation rejects truncated or oversized derivatives', () => {
  assert.equal(validVideoCover(Buffer.from('ffd8ffd9', 'hex')), false);
  assert.equal(validVideoCover(Buffer.from('not-jpeg')), false);
  assert.equal(validVideoCover(Buffer.alloc(VIDEO_COVER_MAX_BYTES + 1)), false);
});
