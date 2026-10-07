import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeVerifiedAssetReceipt } from '../api/video-request-builder.mjs';

const MAX_BYTES = 100_000_000;
const types = {
  image: new Set(['image/png', 'image/jpeg', 'image/webp']),
  video: new Set(['video/mp4', 'video/quicktime', 'video/webm']),
  audio: new Set(['audio/mpeg', 'audio/mp3', 'audio/x-m4a', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg']),
};
const assetId = /^asset_[a-f0-9-]{36}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };

function signatureMatches(bytes, mime) {
  const ascii = (start, end) => bytes.toString('ascii', start, end);
  const ftyp = ascii(4, 8) === 'ftyp';
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
  if (mime === 'video/mp4' || mime === 'video/quicktime' || mime === 'audio/mp4' || mime === 'audio/x-m4a') return ftyp;
  if (mime === 'audio/mpeg' || mime === 'audio/mp3') return ascii(0, 3) === 'ID3' ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  if (mime === 'audio/ogg') return ascii(0, 4) === 'OggS';
  return false;
}

function probeWithFfprobe(filename, ffprobePath) {
  let parsed;
  try {
    const stdout = execFileSync(ffprobePath, ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,width,height,duration', '-of', 'json', filename],
    { timeout: 20_000, maxBuffer: 128 * 1024, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    parsed = JSON.parse(stdout.toString('utf8'));
  } catch { fail('media_probe_failed'); }
  return parsed;
}

function validateProbe(probe, kind) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  if (kind === 'image') {
    if (!streams.some(s => s.codec_type === 'video' && s.width > 0 && s.height > 0)) fail('invalid_image');
    return null;
  }
  if (!streams.some(s => s.codec_type === kind)) fail('invalid_media_type');
  const duration = Number(probe?.format?.duration ?? streams.find(s => s.codec_type === kind)?.duration);
  if (!Number.isFinite(duration) || duration <= 0) fail('media_duration_unknown');
  return duration;
}

function durableFile(filename, bytes) {
  const fd = fs.openSync(filename, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function removeTemp(directory) {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
  fs.rmdirSync(directory);
}

export function createLocalAssetStore({ rootDir, ffprobePath = 'ffprobe' }) {
  if (typeof rootDir !== 'string' || !rootDir.trim()) throw new TypeError('rootDir required');
  const root = path.resolve(rootDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('invalid_asset_directory');

  function put({ ownerId, kind, mimeType, bytes, sha256 }) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !types[kind]?.has(mimeType) ||
      !(bytes instanceof Uint8Array) || bytes.byteLength < 8 || bytes.byteLength > MAX_BYTES ||
      typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) fail('invalid_asset_input');
    const body = Buffer.from(bytes);
    if (digest(body) !== sha256) fail('asset_hash_mismatch');
    if (!signatureMatches(body, mimeType)) fail('asset_type_mismatch');
    const id = `asset_${randomUUID()}`;
    const temp = path.join(root, `.pending-${randomUUID()}`);
    fs.mkdirSync(temp, { mode: 0o700 });
    try {
      durableFile(path.join(temp, 'content.bin'), body);
      const durationSeconds = validateProbe(probeWithFfprobe(path.join(temp, 'content.bin'), ffprobePath), kind);
      const meta = { version: 1, id, ownerId, kind, mimeType, size: body.length, sha256,
        durationSeconds, createdAt: new Date().toISOString() };
      durableFile(path.join(temp, 'meta.json'), Buffer.from(JSON.stringify(meta)));
      fs.renameSync(temp, path.join(root, id));
      return { assetRef: id, kind, mimeType, size: body.length, durationSeconds };
    } finally { removeTemp(temp); }
  }

  function load(ownerId, ref) {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || typeof ref !== 'string' || !assetId.test(ref)) fail('invalid_asset_ref');
    const directory = path.join(root, ref);
    if (!fs.existsSync(directory)) fail('asset_not_found');
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('asset_corrupt');
    let meta, body;
    try {
      const metaStat = fs.lstatSync(path.join(directory, 'meta.json'));
      if (!metaStat.isFile() || metaStat.isSymbolicLink() || metaStat.size > 4096) fail('asset_corrupt');
      meta = JSON.parse(fs.readFileSync(path.join(directory, 'meta.json'), 'utf8'));
      if (meta?.ownerId !== ownerId) fail('asset_not_found');
      const fileStat = fs.lstatSync(path.join(directory, 'content.bin'));
      if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > MAX_BYTES ||
        fileStat.size !== meta.size) fail('asset_corrupt');
      body = fs.readFileSync(path.join(directory, 'content.bin'));
    } catch (error) {
      if (error.message === 'asset_not_found') throw error;
      fail('asset_corrupt');
    }
    if (meta.version !== 1 || meta.id !== ref || !types[meta.kind]?.has(meta.mimeType) ||
      !Number.isSafeInteger(meta.size) || meta.size < 8 || digest(body) !== meta.sha256 ||
      !signatureMatches(body, meta.mimeType)) fail('asset_corrupt');
    const probe = probeWithFfprobe(path.join(directory, 'content.bin'), ffprobePath);
    if (validateProbe(probe, meta.kind) !== meta.durationSeconds) fail('asset_corrupt');
    const visual = probe.streams.find(stream => stream.codec_type === 'video');
    return { ...meta, bytes: body,
      width: visual?.width ?? null, height: visual?.height ?? null };
  }

  function inlineReceipt(ownerId, ref) {
    const asset = load(ownerId, ref);
    return makeVerifiedAssetReceipt({ ownerId: String(ownerId), type: asset.kind,
      mimeType: asset.mimeType, size: asset.size, bytes: asset.bytes,
      ...(asset.durationSeconds === null ? {} : { durationSeconds: asset.durationSeconds }) });
  }

  function uploadPayload(ownerId, ref) {
    const { bytes, kind, mimeType, size, sha256, durationSeconds, width, height } = load(ownerId, ref);
    return { bytes: Buffer.from(bytes), kind, mimeType, size, sha256, durationSeconds, width, height };
  }

  return Object.freeze({ put, inlineReceipt, uploadPayload });
}
