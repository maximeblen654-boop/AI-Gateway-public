import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const MIME = new Set(['video/mp4', 'video/webm']);

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

// Original bytes and identity commit together. No automatic expiry: captured
// orders must not silently lose their only deliverable. Capacity fails closed.
export function createVideoResultStore({ rootDir, maxResultBytes = 100_000_000,
  maxStoreBytes = 2_000_000_000, ffprobePath = 'ffprobe', ffmpegPath = 'ffmpeg' } = {}) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir) ||
      !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 1 ||
      !Number.isSafeInteger(maxStoreBytes) || maxStoreBytes < maxResultBytes) {
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
  function load(identity) {
    const directory = location(identity);
    if (!fs.existsSync(directory)) return null;
    safeDirectory(directory);
    let meta;
    try { meta = JSON.parse(fileBytes(path.join(directory, 'meta.json'), 4096)); }
    catch { fail('video_result_corrupt'); }
    if (meta.version !== 1 || Object.keys(identity).some(key => meta[key] !== identity[key]) ||
        !MIME.has(meta.mimeType) || !Number.isSafeInteger(meta.size) || meta.size < 1 ||
        meta.size > maxResultBytes || !/^[a-f0-9]{64}$/.test(meta.sha256 || '')) fail('video_result_identity_mismatch');
    const bytes = fileBytes(path.join(directory, 'original.bin'), maxResultBytes);
    if (bytes.length !== meta.size || digest(bytes) !== meta.sha256) fail('video_result_corrupt');
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
      '-threads', '1', '-i', file, '-map', '0:v:0', '-threads', '1', '-f', 'null',
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
  function put(identity, { bytes, mimeType }) {
    const target = location(identity);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxResultBytes || !MIME.has(mimeType)) {
      fail('video_result_invalid_media');
    }
    const body = Buffer.from(bytes);
    const existing = load(identity);
    if (existing) {
      if (existing.mimeType !== mimeType || existing.sha256 !== digest(body)) fail('video_result_conflict');
      return existing;
    }
    if (usage() + body.length + 4096 > maxStoreBytes) fail('video_result_capacity');
    const temp = path.join(root, `.pending-${randomUUID()}`);
    fs.mkdirSync(temp, { mode: 0o700 });
    try {
      const file = path.join(temp, 'original.bin');
      writeDurable(file, body);
      validate(file, body, mimeType);
      const meta = { version: 1, ...identity, mimeType, size: body.length, sha256: digest(body),
        storedAt: new Date().toISOString() };
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
  return Object.freeze({ load, put, maxResultBytes });
}
