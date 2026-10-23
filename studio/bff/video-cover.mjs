import { spawn } from 'node:child_process';

export const VIDEO_COVER_MAX_BYTES = 256 * 1024;
export const VIDEO_COVER_MAX_EDGE = 480;
let active = 0;
const waiting = [];

// Bound different originals as well as sharing requests for the same original.
// This is an optional derivative: a decoder failure never touches the source.
export async function decodeVideoCover({ ffmpegPath, file, fd }) {
  if (active >= 2) await new Promise(resolve => waiting.push(resolve));
  else active++;
  try {
    return await new Promise((resolve, reject) => {
      // Linux production reads the already verified open inode, avoiding path
      // replacement between checking the private original and starting FFmpeg.
      const input = process.platform === 'linux' ? '/proc/self/fd/3' : file;
      const child = spawn(ffmpegPath, ['-v', 'error', '-nostdin', '-xerror',
        '-max_alloc', '134217728', '-threads', '1', '-filter_threads', '1',
        '-protocol_whitelist', 'file,pipe', '-i', input, '-map', '0:v:0',
        '-frames:v', '1', '-an', '-sn', '-dn', '-vf',
        `scale=${VIDEO_COVER_MAX_EDGE}:${VIDEO_COVER_MAX_EDGE}:force_original_aspect_ratio=decrease`,
        '-threads', '1', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore', fd] });
      const chunks = [];
      let size = 0, failed = false;
      const stop = () => { failed = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, 15_000);
      child.stdout.on('data', chunk => {
        size += chunk.length;
        if (size > VIDEO_COVER_MAX_BYTES) stop();
        else chunks.push(chunk);
      });
      const failure = () => Object.assign(new Error('video_cover_unavailable'), { code: 'video_cover_unavailable' });
      child.once('error', () => { clearTimeout(timer); reject(failure()); });
      child.once('close', code => {
        clearTimeout(timer);
        if (failed || code !== 0 || !size) reject(failure());
        else resolve(Buffer.concat(chunks, size));
      });
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

// Validate the disposable cached JPEG without launching a second decoder.
export function validVideoCover(bytes) {
  if (bytes.length < 4 || bytes.length > VIDEO_COVER_MAX_BYTES ||
      bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false;
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return false;
    const marker = bytes[offset++], size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (size < 8) return false;
      const height = bytes.readUInt16BE(offset + 3), width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 && width <= VIDEO_COVER_MAX_EDGE && height <= VIDEO_COVER_MAX_EDGE;
    }
    if (marker === 0xda) return false;
    offset += size;
  }
  return false;
}
