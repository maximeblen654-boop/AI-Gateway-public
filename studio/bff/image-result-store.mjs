import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { IMAGE_FORMATS, imageResultFormat } from './image-result-format.mjs';

const TASK_ID = /^img_[a-f0-9]{32}$/;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_RAW_BYTES = 128 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function invalid() { throw new TypeError('Invalid PNG data'); }

// Container boundaries complement decoding: tolerant JPEG decoders may ignore
// bytes after the first EOI or conceal a missing end marker.
function validateJpegContainer(data) {
  let offset = 2, scans = 0;
  while (offset < data.length) {
    if (data[offset++] !== 0xff) throw new TypeError('Invalid image data');
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === 0xd9) {
      if (!scans || offset !== data.length) throw new TypeError('Invalid image data');
      return;
    }
    if (!marker || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7 || offset + 2 > data.length) throw new TypeError('Invalid image data');
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) throw new TypeError('Invalid image data');
    offset += length;
    if (marker === 0xda) {
      scans++;
      while (offset < data.length) {
        if (data[offset] !== 0xff) { offset++; continue; }
        let next = offset + 1;
        while (data[next] === 0xff) next++;
        if (data[next] === 0 || data[next] >= 0xd0 && data[next] <= 0xd7) { offset = next + 1; continue; }
        break;
      }
    }
  }
  throw new TypeError('Invalid image data');
}

// Validate all chunk CRCs and decode the complete bounded zlib stream. Adam7
// passes have independent scanlines; each scanline must carry a legal filter.
function validatePng(data) {
  if (data.length > MAX_IMAGE_BYTES || !data.subarray(0, 8).equals(PNG_SIGNATURE)) invalid();
  let offset = 8, header, palette = false, ended = false, idatEnded = false;
  const compressed = [];
  while (offset < data.length) {
    if (offset + 12 > data.length) invalid();
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) invalid();
    const name = data.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(name) || (data[offset + 6] & 32)) invalid();
    const chunk = data.subarray(offset + 8, offset + 8 + length);
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) invalid();
    if (!header && name !== 'IHDR') invalid();
    if (name === 'IHDR') {
      if (header || length !== 13) invalid();
      const width = chunk.readUInt32BE(0), height = chunk.readUInt32BE(4);
      const depth = chunk[8], color = chunk[9];
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || width > 32768 || height > 32768 || !depths[color]?.includes(depth) || chunk[10] || chunk[11] || chunk[12] > 1) invalid();
      header = { width, height, depth, color, interlace: chunk[12] };
    } else if (name === 'PLTE') {
      if (palette || compressed.length || !length || length % 3 || length > 768 || [0, 4].includes(header.color) || (header.color === 3 && length / 3 > 2 ** header.depth)) invalid();
      palette = true;
    } else if (name === 'IDAT') {
      if (idatEnded || (header.color === 3 && !palette)) invalid();
      compressed.push(chunk);
    } else if (name === 'IEND') {
      if (length || !compressed.length || offset + 12 !== data.length) invalid();
      ended = true;
    } else if (!(data[offset + 4] & 32) || ['acTL', 'fcTL', 'fdAT'].includes(name)) invalid();
    if (compressed.length && name !== 'IDAT') idatEnded = true;
    offset += length + 12;
  }
  if (!ended) invalid();
  const { width, height, depth, color, interlace } = header;
  const bits = depth * ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color]);
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const rows = passes.map(([x,y,dx,dy]) => {
    const w = Math.max(0, Math.ceil((width-x)/dx)), h = Math.max(0, Math.ceil((height-y)/dy));
    return [Math.ceil(w * bits / 8) + 1, w ? h : 0];
  });
  const expected = rows.reduce((n, [stride, count]) => n + stride * count, 0);
  if (expected > MAX_RAW_BYTES) invalid();
  let decoded;
  const packed = Buffer.concat(compressed);
  try { decoded = inflateSync(packed, { maxOutputLength: expected, info: true }); } catch { invalid(); }
  if (decoded.buffer.length !== expected || decoded.engine.bytesWritten !== packed.length) invalid();
  let position = 0;
  for (const [stride, count] of rows) for (let row = 0; row < count; row++, position += stride) if (decoded.buffer[position] > 4) invalid();
}
function target(rootDir, ownerId, taskId, index, extension = 'png') {
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || !TASK_ID.test(taskId) ||
      !Number.isSafeInteger(index) || index < 0 || index > 9) throw new TypeError('Invalid image result identity');
  if (!['png', 'jpg', 'webp'].includes(extension)) throw new TypeError('Invalid image result format');
  return path.join(rootDir, String(ownerId), `${taskId}-${index}.${extension}`);
}
function directory(file) {
  if (!fs.lstatSync(file).isDirectory()) throw new Error('Unsafe image result directory');
}
function syncDirectory(dir) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}


export function createImageResultStore({ rootDir, retentionMs = 72 * 3600000, maxStoreBytes = 512 * 1024 * 1024, now = Date.now, exclusiveWriter = false, ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe' } = {}) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw new TypeError('Private result root is required');
  rootDir = path.resolve(rootDir);
  if (typeof exclusiveWriter !== 'boolean') throw new TypeError('Invalid exclusive writer assertion');
  if (!Number.isSafeInteger(retentionMs) || retentionMs <= 0 || !Number.isSafeInteger(maxStoreBytes) || maxStoreBytes <= 0) throw new TypeError('Invalid image retention limits');
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  directory(rootDir);
  const metadataRoot = `${rootDir}.metadata`;
  fs.mkdirSync(metadataRoot, { recursive: true, mode: 0o700 });
  directory(metadataRoot);
  // Keep the original PNG tree/v1 metadata readable by the rollback image.
  // All siblings must live on the same private persistent parent volume.
  const nativeRoot = `${rootDir}.native`, nativeMetadataRoot = `${nativeRoot}.metadata`;
  for (const dir of [nativeRoot, nativeMetadataRoot]) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); directory(dir); }
  const dataRoot = extension => extension === 'png' ? rootDir : nativeRoot;
  const metaRoot = file => path.extname(file) === '.png' ? metadataRoot : nativeMetadataRoot;
  const lock = path.join(rootDir, '.write-lock');
  const imageName = /^img_[a-f0-9]{32}-[0-9]\.(?:png|jpg|webp)$/;
  const metaName = /^img_[a-f0-9]{32}-[0-9]\.(?:png|jpg|webp)\.meta\.json$/;
  const tempName = /^img_[a-f0-9]{32}-[0-9]\.(?:png|jpg|webp)(?:\.meta\.json)?\.(?:[1-9][0-9]*|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.tmp$/;
  function runDecoder(command, args, data) {
    const result = spawnSync(command, args, { input: data, encoding: 'utf8', timeout: 5000,
      killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true });
    if (result.error || result.status !== 0 || result.stderr.trim()) throw new TypeError('Invalid image data or decoder unavailable');
    return result.stdout;
  }
  function validateImage(data, declared = {}) {
    if (!data.length || data.length > MAX_IMAGE_BYTES) throw new TypeError('Invalid image data');
    const format = imageResultFormat(data, declared);
    if (format.output_format === 'png') { validatePng(data); return format; }
    // Truncated JPEGs can be concealed by tolerant decoders. Require EOI and
    // exact WebP RIFF size before decoding; animated/multi-frame output is not
    // part of this still-image storage contract.
    if (format.output_format === 'jpeg') validateJpegContainer(data);
    if (format.output_format === 'webp' && (data.readUInt32LE(4) + 8 !== data.length ||
        (data.toString('ascii', 12, 16) === 'VP8X' && (data[20] & 2)))) throw new TypeError('Invalid image data');
    const limits = ['-max_alloc', String(MAX_RAW_BYTES), '-threads', '1', '-max_pixels', String(MAX_RAW_BYTES / 4)];
    const input = ['-f', 'image2pipe', '-i', 'pipe:0'];
    let probe;
    try { probe = JSON.parse(runDecoder(ffprobePath, ['-v', 'error', ...limits, ...input,
      '-show_entries', 'stream=width,height,codec_name', '-of', 'json'], data)); } catch { throw new TypeError('Invalid image data or decoder unavailable'); }
    const stream = probe.streams?.[0];
    if (probe.streams?.length !== 1 || stream.codec_name !== (format.output_format === 'jpeg' ? 'mjpeg' : 'webp') ||
        !Number.isSafeInteger(stream.width) || !Number.isSafeInteger(stream.height) || stream.width <= 0 || stream.height <= 0 ||
        stream.width > 32768 || stream.height > 32768 || stream.width * stream.height * 4 > MAX_RAW_BYTES) throw new TypeError('Invalid image dimensions');
    // ffprobe already checked dimensions. FFmpeg 6.1's redundant MJPEG
    // stream-info pass falsely warns that a complete JPEG has no EOI. Use
    // the explicit JPEG demuxer and skip that pass; full frame decoding,
    // allocation/pixel limits and strict warning/error rejection remain.
    const decodeInput = format.output_format === 'jpeg'
      ? ['-f', 'mjpeg', '-nofind_stream_info', '-i', 'pipe:0'] : input;
    const decoded = runDecoder(ffmpegPath, ['-v', 'warning', '-xerror', '-err_detect', 'explode', ...limits, ...decodeInput,
      '-map', '0:v:0', '-threads', '1', '-c:v', 'wrapped_avframe', '-f', 'null', '-progress', 'pipe:1', 'pipe:1'], data);
    // Decode every frame to the null sink, avoiding a rawvideo encoder (which
    // emits irrelevant bitrate warnings for valid 1x1 images). Completed
    // progress plus exactly one decoded frame is required; decoder warnings
    // and nonzero exits still reject the result.
    const frames = [...decoded.matchAll(/^frame=(\d+)\r?$/gm)];
    if (Number(frames.at(-1)?.[1]) !== 1 || !/^progress=end\r?$/m.test(decoded)) throw new TypeError('Invalid image decoded frame');
    return format;
  }
  function statIfExists(file) {
    try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function scan(allowTemps = false) {
    const files = [], temps = [], identities = new Map();
    function unique(file) {
      const identity = `${path.basename(path.dirname(file))}/${path.basename(file).replace(/\.(?:png|jpg|webp)$/, '')}`;
      if (identities.has(identity) && identities.get(identity) !== file) throw new Error('Conflicting image result formats');
      identities.set(identity, file);
    }
    for (const [scanRoot, scanMetadataRoot] of [[rootDir, metadataRoot], [nativeRoot, nativeMetadataRoot]]) {
      directory(scanRoot);
      for (const owner of fs.readdirSync(scanRoot)) {
        const dir = path.join(scanRoot, owner);
        if (owner === '.write-lock' && scanRoot === rootDir) {
          directory(dir);
          if (fs.readdirSync(dir).length) throw new Error('Unexpected image writer lock contents');
          continue;
        }
        if (!/^[1-9][0-9]*$/.test(owner)) throw new Error('Unexpected image store entry');
        directory(dir);
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name), stat = fs.lstatSync(file);
          if (!stat.isFile()) throw new Error('Unsafe image result entry');
          if (imageName.test(name) && (name.endsWith('.png') === (scanRoot === rootDir))) { unique(file); files.push(file); }
          else if (allowTemps && tempName.test(name)) temps.push(file);
          else throw new Error('Unexpected image store entry');
        }
      }
      directory(scanMetadataRoot);
      for (const owner of fs.readdirSync(scanMetadataRoot)) {
        if (!/^[1-9][0-9]*$/.test(owner)) throw new Error('Unexpected image metadata entry');
        const dir = path.join(scanMetadataRoot, owner); directory(dir);
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          if (!fs.lstatSync(file).isFile()) throw new Error('Unsafe image metadata entry');
          if (metaName.test(name) && (name.endsWith('.png.meta.json') === (scanRoot === rootDir))) {
            const image = path.join(scanRoot, owner, name.slice(0, -10)); unique(image); loadMeta(image);
          }
          else if (allowTemps && tempName.test(name)) temps.push(file);
          else throw new Error('Unexpected image metadata entry');
        }
      }
    }
    return { files, temps };
  }
  // Only startup under an external process-lifetime flock may assert this.
  if (exclusiveWriter) {
    const { temps } = scan(true);
    for (const file of temps) { fs.unlinkSync(file); syncDirectory(path.dirname(file)); }
    if (statIfExists(lock)) { fs.rmdirSync(lock); syncDirectory(rootDir); }
  }
  function atomicWrite(file, data) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const handle = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(handle, data); fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
      fs.renameSync(temporary, file); renamed = true; syncDirectory(path.dirname(file));
    } finally { if (!renamed && statIfExists(temporary)) fs.unlinkSync(temporary); }
  }
  function loadMeta(file) {
    directory(metaRoot(file));
    const metaFile = metaPath(file), ownerDir = path.dirname(metaFile);
    if (!statIfExists(ownerDir)) return null;
    directory(ownerDir);
    const stat = statIfExists(metaFile);
    if (!stat) return null;
    if (!stat.isFile() || stat.size > 1024) throw new Error('Invalid image retention metadata');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const format = meta.version === 1 ? IMAGE_FORMATS.png : meta.version === 2 ? IMAGE_FORMATS[meta.output_format] : null;
    if (!format || path.extname(file) !== `.${format.extension}` ||
        (meta.version === 2 && (meta.mime_type !== format.mime_type || meta.extension !== format.extension)) ||
        !Number.isFinite(meta.expiresAt) || !Number.isSafeInteger(meta.bytes) || meta.bytes <= 0 || meta.bytes > MAX_IMAGE_BYTES || !/^[a-f0-9]{64}$/.test(meta.sha256) || !Number.isFinite(new Date(meta.expiresAt).getTime())) throw new Error('Invalid image retention metadata');
    return meta;
  }
  const hash = data => createHash('sha256').update(data).digest('hex');
  function legacyMeta(file, stat) {
    // Only pre-existing PNG files qualify for the historical seven-day promise.
    // New JPEG/WebP writes always publish immutable metadata before bytes.
    if (path.extname(file) !== '.png' || !stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Invalid image result');
    const data = fs.readFileSync(file); validatePng(data);
    return { version: 1, expiresAt: stat.mtimeMs + 7 * 86400000, bytes: data.length, sha256: hash(data) };
  }
  function metaPath(file) { return path.join(metaRoot(file), path.basename(path.dirname(file)), `${path.basename(file)}.meta.json`); }
  function persistMeta(file, meta) {
    directory(metaRoot(file));
    const metaFile = metaPath(file), dir = path.dirname(metaFile);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); directory(dir); syncDirectory(metaRoot(file));
    atomicWrite(metaFile, JSON.stringify(meta));
  }
  function locate(ownerId, taskId, index, fallback = 'png') {
    const candidates = Object.values(IMAGE_FORMATS).map(format => target(dataRoot(format.extension), ownerId, taskId, index, format.extension));
    for (const dir of [rootDir, metadataRoot, nativeRoot, nativeMetadataRoot]) directory(dir);
    for (const file of candidates) for (const dir of [path.dirname(file), path.dirname(metaPath(file))]) if (statIfExists(dir)) directory(dir);
    const existing = candidates.filter(file => statIfExists(file) || statIfExists(metaPath(file)));
    if (existing.length > 1) throw new Error('Conflicting image result formats');
    return existing[0] || target(dataRoot(fallback), ownerId, taskId, index, fallback);
  }
  function inventory() {
    const { files } = scan();
    // Validate and migrate before deletion. Legacy promises always retain seven days.
    const entries = files.map(file => {
      const stat = fs.lstatSync(file), existing = loadMeta(file);
      return { file, stat, meta: existing || legacyMeta(file, stat), migrate: !existing };
    });
    for (const entry of entries) if (entry.migrate) persistMeta(entry.file, entry.meta);
    let bytes = 0, deleted = 0, deletedBytes = 0;
    for (const { file, stat, meta } of entries) {
      if (now() >= meta.expiresAt) { fs.unlinkSync(file); syncDirectory(path.dirname(file)); deleted++; deletedBytes += stat.size; }
      else bytes += stat.size;
    }
    return { bytes, deleted, deletedBytes };
  }
  function locked(fn) {
    directory(rootDir); fs.mkdirSync(lock, { mode: 0o700 });
    try { return fn(); } finally { fs.rmdirSync(lock); }
  }
  function cleanup() { return locked(inventory); }
  function saveBase64(ownerId, taskId, index, b64, options = {}) {
    target(rootDir, ownerId, taskId, index); // Validate identity before decoding.
    // Only the trusted Core receipt may supply this option, never image data.
    let expiresAt;
    if (options.expiresAt !== undefined) {
      expiresAt = typeof options.expiresAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(options.expiresAt) ? Date.parse(options.expiresAt) : NaN;
      if (!Number.isFinite(expiresAt) || expiresAt > now() + 72 * 3600000) throw Object.assign(new Error('Invalid image retention deadline'), { code: 'image_result_retention_invalid' });
      if (expiresAt <= now()) throw Object.assign(new Error('Image result expired'), { code: 'image_result_expired' });
    }
    if (typeof b64 !== 'string' || b64.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) || b64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(b64)) throw new TypeError('Invalid image base64');
    const data = Buffer.from(b64, 'base64');
    if (data.toString('base64') !== b64) throw new TypeError('Invalid image base64');
    const format = validateImage(data, options);
    return locked(() => {
      if (expiresAt !== undefined && expiresAt <= now()) throw Object.assign(new Error('Image result expired'), { code: 'image_result_expired' });
      const { bytes } = inventory(), file = locate(ownerId, taskId, index, format.extension), dir = path.dirname(file);
      if (path.extname(file) !== `.${format.extension}`) throw new Error('Image result already exists');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); directory(dir); syncDirectory(dataRoot(format.extension));
      let meta = loadMeta(file);
      if (meta && now() >= meta.expiresAt) throw new Error('Image result expired');
      if (meta && (meta.bytes !== data.length || meta.sha256 !== hash(data))) throw new Error('Image result already exists');
      // Existing promises are immutable, including migrated legacy seven-day
      // PNGs and interrupted publications. A later Core copy cannot change them.
      if (statIfExists(file)) {
        if (!read(ownerId, taskId, index).equals(data)) throw new Error('Image result already exists');
      } else {
        if (bytes + data.length > maxStoreBytes) throw new Error('Image result store capacity exceeded');
        if (!meta) {
          meta = { ...(format.output_format === 'png' ? { version: 1 } : { version: 2, ...format }),
            expiresAt: expiresAt ?? now() + retentionMs, bytes: data.length, sha256: hash(data) };
          // Persist the immutable promise before the image. Interrupted writes can
          // retry only identical content and cannot renew the download window.
          persistMeta(file, meta);
        }
        atomicWrite(file, data);
      }
      return { url: `/studio/api/image/tasks/${taskId}/results/${index}`, ...format };
    });
  }
  async function saveResult(ownerId, taskId, index, item, options = {}) {
    if (!item || typeof item.b64_json !== 'string') throw new TypeError('Image base64 result required; URL result storage is disabled');
    return saveBase64(ownerId, taskId, index, item.b64_json, { ...options, mime_type: item.mime_type, output_format: item.output_format });
  }
  function metadata(ownerId, taskId, index) {
    const file = locate(ownerId, taskId, index);
    directory(rootDir); directory(path.dirname(file));
    const stat = statIfExists(file);
    if (stat && (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)) throw new Error('Invalid image result');
    const meta = loadMeta(file) || (stat ? legacyMeta(file, stat) : null);
    if (!meta) { const error = new Error('Image result missing'); error.code = 'ENOENT'; throw error; }
    return { ...(meta.version === 1 ? IMAGE_FORMATS.png : IMAGE_FORMATS[meta.output_format]),
      bytes: meta.bytes, expires_at: new Date(meta.expiresAt).toISOString(), expired: now() >= meta.expiresAt, missing: !stat };
  }
  function read(ownerId, taskId, index) {
    const info = metadata(ownerId, taskId, index);
    if (info.expired) throw new Error('Image result expired');
    if (info.missing) { const error = new Error('Image result missing'); error.code = 'ENOENT'; throw error; }
    const file = locate(ownerId, taskId, index), data = fs.readFileSync(file);
    const format = imageResultFormat(data, info);
    if (format.output_format === 'png') validatePng(data);
    const meta = loadMeta(file);
    if (meta && (meta.bytes !== data.length || meta.sha256 !== hash(data))) throw new Error('Invalid image result');
    return data;
  }
  return Object.freeze({ saveBase64, saveResult, read, metadata, cleanup });
}
