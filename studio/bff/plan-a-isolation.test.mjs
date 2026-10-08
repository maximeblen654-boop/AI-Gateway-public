import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createImageHandler, assertSeparateRoots, buildImageServer } from './image-server.mjs';
import { createVideoHandler } from './video-handler.mjs';
import { studioRoute, studioUpstreamPath } from '../../tools/phase5-media-e2e/dev-proxy.mjs';
const { createStudioSessionBridge } = createRequire(import.meta.url)('./studio-session.js');

test('two real HTTP cookie sessions remain isolated; local logout and website revocation', async t => {
  let revoked = false;
  const proof = 'p'.repeat(43), ticket = 't'.repeat(43);
  // Only the identity authority is synthetic. Both session implementations,
  // HTTP routing, cookie parsing, origin and CSRF checks execute normally.
  const core = { consume: async () => ({ user_id: 7, session_proof: proof }), verify: async () => revoked ? null : { user_id: 7 } };
  const old = createStudioSessionBridge({ core });
  const media = createStudioSessionBridge({ core, cookieName: 'studio_media_session', cookiePath: '/studio-v2' });
  const handler = createImageHandler({ sessions: media, tasks: {} });
  const server = http.createServer(async (req, res) => {
    if (!req.url.startsWith('/studio/')) return handler(req, res);
    if (req.url === '/studio/api/auth/session' && req.method === 'POST') {
      const result = await old.exchange(req, ticket);
      res.writeHead(result ? 200 : 403, result ? { 'Set-Cookie': result.cookie } : {}); res.end(); return;
    }
    const session = await old.authenticate(req);
    res.writeHead(session ? 200 : 401); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exchange = { method: 'POST', headers: { Origin: base, 'X-Studio-Request': 'session-exchange-v1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }) };
  const legacy = await fetch(base + '/studio/api/auth/session', exchange);
  const current = await fetch(base + '/studio-v2/api/session/exchange', exchange);
  assert.equal(legacy.status, 200); assert.equal(current.status, 200);
  assert.match(legacy.headers.get('set-cookie'), /^studio_session=.+; Path=\/studio;/);
  assert.match(current.headers.get('set-cookie'), /^studio_media_session=.+; Path=\/studio-v2;/);
  const oldCookie = legacy.headers.get('set-cookie').split(';')[0], newCookie = current.headers.get('set-cookie').split(';')[0];
  const get = (url, cookie) => fetch(base + url, { headers: { Cookie: cookie } });
  assert.equal((await get('/studio/api/auth/session', newCookie)).status, 401);
  assert.equal((await get('/studio-v2/api/session', oldCookie)).status, 401);
  const both = oldCookie + '; ' + newCookie;
  assert.equal((await get('/studio/api/auth/session', both)).status, 200);
  assert.equal((await get('/studio-v2/api/session', both)).status, 200);
  assert.equal((await get('/studio-v2/api/session', newCookie + '; ' + newCookie)).status, 401);
  assert.equal((await fetch(base + '/studio-v2/api/session', { method: 'DELETE', headers: { Cookie: both, Origin: 'https://other.example', 'X-Studio-Request': 'image-binding-v1' } })).status, 403);
  const logout = await fetch(base + '/studio-v2/api/session', { method: 'DELETE', headers: { Cookie: both, Origin: base, 'X-Studio-Request': 'image-binding-v1' } });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /^studio_media_session=; Path=\/studio-v2;/);
  assert.equal((await get('/studio/api/auth/session', both)).status, 200);
  assert.equal((await get('/studio-v2/api/session', both)).status, 401);
  const renewed = await fetch(base + '/studio-v2/api/session/exchange', exchange);
  revoked = true;
  assert.equal((await get('/studio/api/auth/session', both)).status, 401);
  assert.equal((await get('/studio-v2/api/session', renewed.headers.get('set-cookie').split(';')[0])).status, 401);
});

test('exact proxy paths and BFF prefix rejection cannot select the other generation', async t => {
  for (const p of ['/studio/video.html', '/studio/main.css', '/studio/api/image/tasks', '/studio/api/video/tasks']) assert.equal(studioRoute(p), 'legacy');
  assert.equal(studioRoute('/api/v1/auth/studio-ticket'), 'legacy-ticket');
  assert.equal(studioRoute('/api/v1/auth/studio-media-ticket?ignored=1'), 'media-ticket');
  assert.equal(studioRoute('/studio-v2/api/assets/uploads'), 'media');
  assert.equal(studioRoute('/studio-v2/api-wrong'), 'reject');
  assert.equal(studioRoute('/video-studio'), 'front');
  assert.equal(studioUpstreamPath('/studio/video.html?x=1'), '/video.html?x=1');
  assert.equal(studioUpstreamPath('/studio/assets/logo.svg'), '/assets/logo.svg');
  for(const p of ['/studio/api/auth/session', '/studio/api/image/tasks', '/studio-v2/api/assets/uploads']) assert.equal(studioUpstreamPath(p), p);
  assert.equal(studioUpstreamPath('/api/v1/auth/studio-media-ticket'), '/api/v1/auth/studio-ticket');
  const sessions = { authenticate() { throw Error('wrong prefix must not authenticate'); } };
  for (const handler of [createImageHandler({ sessions, tasks: {} }), createVideoHandler({ sessions, tasks: {} })]) {
    const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    for (const p of ['/studio/api/image/tasks', '/studio/api/video/operations', '/studio-v2/api/operations']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
      assert.equal(response.status, 404);
    }
  }
});

test('new state roots cannot overlap each other or a supplied legacy root', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-a-roots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { STUDIO_IMAGE_DATA_ROOT: path.join(root, 'image'), STUDIO_VIDEO_DATA_ROOT: path.join(root, 'video'), STUDIO_ASSET_ROOT: path.join(root, 'assets'), STUDIO_OPERATION_ROOT: path.join(root, 'legacy') };
  assert.doesNotThrow(() => assertSeparateRoots(env));
  assert.throws(() => assertSeparateRoots({ ...env, STUDIO_ASSET_ROOT: env.STUDIO_IMAGE_DATA_ROOT }), /separate/);
  assert.throws(() => assertSeparateRoots({ ...env, STUDIO_IMAGE_DATA_ROOT: path.join(env.STUDIO_OPERATION_ROOT, 'images') }), /separate/);
  assert.throws(() => buildImageServer({ ...env, STUDIO_LEGACY_VIDEO_RECOVERY: 'true' }), /legacy BFF/);
  assert.deepEqual(fs.readdirSync(root), []);
});
