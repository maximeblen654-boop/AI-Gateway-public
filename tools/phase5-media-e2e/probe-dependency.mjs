// Same-origin bounded probe; no credentials, proxy changes, or TLS overrides.
import https from 'node:https';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const url = 'https://registry.npmjs.org/@vue/reactivity/-/reactivity-3.5.42.tgz';
const lock = readFileSync(new URL('../../frontend/pnpm-lock.yaml', import.meta.url), 'utf8');
const expected = lock.match(/'@vue\/reactivity@3\.5\.42':\s+resolution: \{integrity: (sha512-[^}]+)\}/)?.[1];
if (!expected) throw new Error('locked package integrity missing');
const started = Date.now();
const result = await new Promise(resolve => {
  const req = https.get(url, { signal: AbortSignal.timeout(20_000) }, res => {
    const hash = createHash('sha512');
    let bytes = 0;
    res.on('data', chunk => { bytes += chunk.length; hash.update(chunk); });
    res.on('end', () => resolve({ status: res.statusCode, bytes,
      integrityMatches: `sha512-${hash.digest('base64')}` === expected }));
    res.on('error', error => resolve({ error: error.code || error.name }));
  });
  req.on('error', error => resolve({ error: error.code || error.name }));
});
console.log(JSON.stringify({ node: process.version, platform: process.platform, url,
  elapsedMs: Date.now() - started, ...result }));
if (result.status !== 200 || !result.integrityMatches) process.exitCode = 1;
