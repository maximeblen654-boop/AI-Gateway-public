import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const MIME = new Set(['video/mp4', 'video/webm']);
const RETENTION_MS = 48 * 3600000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const timestamp = value => typeof value === 'string' && ISO_TIME.test(value) ? Date.parse(value)
  : typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15 ? value : NaN;

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function safeDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('video_result_unsafe_path');
}
function writeDurable(file, bytes) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// New originals have one immutable 48-hour deadline. Their metadata survives
// byte cleanup so recovery cannot import the same identity with a new window.
// Historical v1/v2 originals keep their original unlimited retention promise.
export function createVideoResultStore({ rootDir, maxResultBytes = 100_000_000,
  maxStoreBytes = 2_000_000_000, ffprobePath = 'ffprobe', ffmpegPath = 'ffmpeg', now = Date.now } = {}) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir) ||
      !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1 ||
      !Number.isSafeInteger(maxStoreBytes) || maxStoreBytes < maxResultBytes || typeof now !== 'function') {
    throw new TypeError('Private video result root and bounded capacity required');
  }
  const root = path.resolve(rootDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  safeDirectory(root);

  function location(identity) {
    if (!Number.isSafeInteger(identity?.ownerId) || identity.ownerId <= 0 ||
        !id(identity.childId) || !id(identity.taskId) ||
        (identity.mode === 'account_video_v1' ? (identity.keySlotId !== undefined || !Number.isSafeInteger(identity.accountId) || identity.accountId <= 0 || !/^[a-f0-9]{64}$/.test(identity.bindingHash || '')) : (!id(identity.keySlotId) || identity.accountId !== undefined)) ||
        !/^[a-f0-9]{64}$/.test(identity.requestHash || '')) fail('video_result_invalid_identity');
    // Owner and original task identity never come from a browser request body.
    return path.join(root, digest(`${identity.ownerId}\0${identity.childId}`));
  }
  function fileBytes(file, limit) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > limit) fail('video_result_corrupt');
    return fs.readFileSync(file);
  }
  function readMeta(directory, identity) {
    safeDirectory(directory);
    let meta;
    try { meta = JSON.parse(fileBytes(path.join(directory, 'meta.json'), 4096)); }
    catch { fail('video_result_corrupt'); }
    if (!meta || ![1, 2, 3].includes(meta.version) || meta.version === 2 && (meta.mode !== 'account_video_v1' || !Object.hasOwn(meta, 'media')) ||
        identity && Object.keys(identity).some(key => meta[key] !== identity[key]) ||
        !MIME.has(meta.mimeType) || !Number.isSafeInteger(meta.size) || meta.size < 1 ||
        meta.size > maxResultBytes || !/^[a-f0-9]{64}$/.test(meta.sha256 || '')) fail('video_result_identity_mismatch');
    if (location(meta) !== directory) fail('video_result_identity_mismatch');
    if (meta.version === 3 && (typeof meta.storedAt !== 'string' || typeof meta.expiresAt !== 'string' ||
        !Number.isFinite(timestamp(meta.storedAt)) || !Number.isFinite(timestamp(meta.expiresAt)) ||
        timestamp(meta.expiresAt) <= timestamp(meta.storedAt) ||
        timestamp(meta.expiresAt) > timestamp(meta.storedAt) + RETENTION_MS)) fail('video_result_corrupt');
    return meta;
  }
  function originalStat(directory) {
    let stat;
    try { stat = fs.lstatSync(path.join(directory, 'original.bin')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('video_result_unsafe_path');
    return stat;
  }
  function metadata(identity) {
    const directory = location(identity);
    if (!fs.existsSync(directory)) return null;
    const meta = readMeta(directory, identity), stat = originalStat(directory);
    // Only v3 has a deadline. Never infer one from an old file's mtime.
    return { ...meta, policy: meta.version === 3 ? 'video_original_48h' : 'legacy_unknown',
      expired: meta.version === 3 && now() >= timestamp(meta.expiresAt),
      missing: !stat, deleted: !stat };
  }
  function has(identity) {
    const info = metadata(identity);
    return !!info && !info.expired && !info.missing;
  }
  function load(identity) {
    const meta = metadata(identity);
    if (!meta) return null;
    if (meta.expired) fail('video_result_expired');
    if (meta.missing) fail('video_result_corrupt');
    const directory = location(identity);
    const bytes = fileBytes(path.join(directory, 'original.bin'), maxResultBytes);
    if (bytes.length !== meta.size || digest(bytes) !== meta.sha256) fail('video_result_corrupt');
    // All versions were fully decoded before their atomic commit. Optional v2
    // measurements are historical diagnostics, not delivery/settlement gates.
    return { ...meta, bytes };
  }
  function command(executable, args) {
    try {
      return execFileSync(executable, args, { encoding: 'utf8', timeout: 60_000,
        maxBuffer: 128 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { fail('video_result_decode_failed'); }
  }
  function validate(file, bytes, mimeType) {
    if (mimeType === 'video/mp4' ? bytes.toString('ascii', 4, 8) !== 'ftyp'
      : !bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) fail('video_result_type_mismatch');
    let probe;
    try { probe = JSON.parse(command(ffprobePath, ['-v', 'error', '-show_entries',
      'format=format_name,duration:stream=codec_type,width,height', '-of', 'json', file])); }
    catch { fail('video_result_decode_failed'); }
    const videos = probe.streams?.filter(stream => stream.codec_type === 'video') || [];
    if (videos.length !== 1 || !Number.isFinite(Number(probe.format?.duration)) ||
        Number(probe.format.duration) <= 0 || !Number.isSafeInteger(videos[0].width) ||
        !Number.isSafeInteger(videos[0].height) || videos[0].width < 1 || videos[0].height < 1 ||
        videos[0].width > 8192 || videos[0].height > 8192 ||
        !(mimeType === 'video/mp4' ? /(?:^|,)mp4(?:,|$)/ : /(?:^|,)webm(?:,|$)/).test(probe.format.format_name)) {
      fail('video_result_invalid_media');
    }
    const progress = command(ffmpegPath, ['-v', 'error', '-xerror', '-err_detect', 'explode', '-max_alloc', '134217728',
      '-threads', '1', '-i', file, '-map', '0:v:0', '-threads', '1', '-fps_mode', 'passthrough', '-f', 'null',
      '-progress', 'pipe:1', '-']);
    if (!/^progress=end\r?$/m.test(progress) ||
        Number([...progress.matchAll(/^frame=(\d+)\r?$/gm)].at(-1)?.[1]) < 1) fail('video_result_decode_failed');
  }
  function usage() {
    let total = 0;
    for (const name of fs.readdirSync(root)) {
      // Count crashed staging against capacity; it is not a deliverable and is
      // never silently removed or confused with a committed result.
      if (!/^(?:[a-f0-9]{64}|\.pending-[a-f0-9-]{36})$/.test(name)) fail('video_result_unsafe_path');
      const dir = path.join(root, name);
      safeDirectory(dir);
      for (const entry of fs.readdirSync(dir)) {
        if (!['original.bin', 'meta.json'].includes(entry)) fail('video_result_unsafe_path');
        const stat = fs.lstatSync(path.join(dir, entry));
        if (!stat.isFile() || stat.isSymbolicLink()) fail('video_result_unsafe_path');
        total += stat.size;
      }
    }
    return total;
  }
  function put(identity, { bytes, mimeType, expiresAt, persistedAt, legacy = false } = {}) {
    const target = location(identity);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxResultBytes || !MIME.has(mimeType)) {
      fail('video_result_invalid_media');
    }
    const body = Buffer.from(bytes);
    const proof = metadata(identity);
    if(proof?.expired)fail('video_result_expired');
    // An absent file can be repaired only under the existing immutable proof.
    // A present corrupt file still fails closed in load(), never silently heals.
    if(proof?.missing){
      if(proof.mimeType!==mimeType||proof.sha256!==digest(body)||proof.size!==body.length)fail('video_result_conflict');
      if(usage()+body.length>maxStoreBytes)fail('video_result_capacity');
      const temp=path.join(root,`.pending-${randomUUID()}`);fs.mkdirSync(temp,{mode:0o700});
      try{
        const file=path.join(temp,'original.bin');writeDurable(file,body);validate(file,body,mimeType);
        if(proof.expiresAt&&now()>=timestamp(proof.expiresAt))fail('video_result_expired');
        safeDirectory(target);
        try{fs.renameSync(file,path.join(target,'original.bin'));}
        catch(error){const raced=load(identity);if(!raced||raced.sha256!==proof.sha256)throw error;}
        syncDirectory(target);return load(identity);
      }finally{if(fs.existsSync(temp)){for(const name of fs.readdirSync(temp))fs.unlinkSync(path.join(temp,name));fs.rmdirSync(temp);}}
    }
    const existing = load(identity);
    if (existing) {
      if (existing.mimeType !== mimeType || existing.sha256 !== digest(body)) fail('video_result_conflict');
      return existing;
    }
    // Only trusted Core receipts may supply these values. ISO UTC and epoch
    // milliseconds are accepted; recovery preserves both the original origin
    // and deadline instead of creating a new local window.
    if (typeof legacy !== 'boolean' || legacy && expiresAt !== undefined) fail('video_result_retention_invalid');
    const origin = persistedAt === undefined ? undefined : timestamp(persistedAt);
    if (origin !== undefined && (!Number.isFinite(origin) || origin > now())) fail('video_result_retention_invalid');
    const deadline = expiresAt === undefined ? undefined : timestamp(expiresAt);
    if (deadline !== undefined && (!Number.isFinite(deadline) || deadline > (origin ?? now()) + RETENTION_MS)) fail('video_result_retention_invalid');
    if (deadline !== undefined && deadline <= now()) fail('video_result_expired');
    if (!legacy && deadline === undefined && origin !== undefined && origin + RETENTION_MS <= now()) fail('video_result_expired');
    if (usage() + body.length + 4096 > maxStoreBytes) fail('video_result_capacity');
    const temp = path.join(root, `.pending-${randomUUID()}`);
    fs.mkdirSync(temp, { mode: 0o700 });
    try {
      const file = path.join(temp, 'original.bin');
      writeDurable(file, body);
      validate(file, body, mimeType);
      const storedAt = origin ?? now();
      if (!Number.isSafeInteger(storedAt) || !Number.isFinite(timestamp(storedAt))) fail('video_result_retention_invalid');
      if (!legacy && (deadline ?? storedAt + RETENTION_MS) <= now()) fail('video_result_expired');
      // The trusted caller explicitly marks historical orders on their first
      // local import. Upgrading or first download must not shorten that promise.
      const meta = { ...identity, version: legacy ? identity.mode === 'account_video_v1' ? 2 : 1 : 3,
        mimeType, size: body.length, sha256: digest(body), storedAt: new Date(storedAt).toISOString(),
        ...(!legacy ? { expiresAt: new Date(deadline ?? storedAt + RETENTION_MS).toISOString() } : {}), media: null };
      writeDurable(path.join(temp, 'meta.json'), Buffer.from(JSON.stringify(meta)));
      syncDirectory(temp);
      try { fs.renameSync(temp, target); }
      catch (error) {
        const raced = load(identity);
        if (!raced || raced.mimeType !== mimeType || raced.sha256 !== meta.sha256) throw error;
      }
      syncDirectory(root);
      return load(identity);
    } finally {
      if (fs.existsSync(temp)) {
        for (const name of fs.readdirSync(temp)) fs.unlinkSync(path.join(temp, name));
        fs.rmdirSync(temp);
      }
    }
  }
  let cleanupCursor = '';
  function cleanup({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Bounded video cleanup limit required');
    safeDirectory(root);
    // Pending directories may belong to another writer. Only committed result
    // identities participate, and the cursor prevents old unlimited promises
    // from starving later expiring results in repeated bounded passes.
    const names = fs.readdirSync(root).filter(name => !/^\.pending-[a-f0-9-]{36}$/.test(name)).sort();
    let start = names.findIndex(name => name > cleanupCursor);
    if (start < 0) start = 0;
    const count = Math.min(limit, names.length - start);
    const stats = { scanned: 0, deleted: 0, deletedBytes: 0, failed: 0, hasMore: start + count < names.length };
    for (let index = 0; index < count; index++) {
      const name = names[start + index];
      cleanupCursor = name;
      stats.scanned++;
      try {
        if (!/^[a-f0-9]{64}$/.test(name)) fail('video_result_unsafe_path');
        const directory = path.join(root, name), meta = readMeta(directory);
        if (meta.version !== 3 || now() < timestamp(meta.expiresAt)) continue;
        const stat = originalStat(directory);
        if (!stat) continue;
        try { fs.unlinkSync(path.join(directory, 'original.bin')); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        // Keep meta.json as the immutable expiry tombstone. Count only bytes
        // actually removed, including when a subsequent directory fsync fails.
        stats.deleted++;
        stats.deletedBytes += stat.size;
        syncDirectory(directory);
      } catch { stats.failed++; }
    }
    return stats;
  }
  return Object.freeze({ load, put, metadata, has, cleanup, maxResultBytes });
}
