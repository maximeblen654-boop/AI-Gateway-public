// Runs only on a disposable GitHub-hosted Linux runner. No production fixtures.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { APPLICATION_SHA, locations } from './build.mjs';

const { source, out } = locations();
const report = { status: 'NOT_RUN', checks: [], http: [], actual_images: {},
  legacy_executor: 'SYNTHETIC_ISSUER_AND_HTTP_ADAPTER_NOT_PRODUCTION_BINARY',
  production_cross_version_rollback: 'NOT_RUN', supplier_generation: 'NOT_RUN',
  accounting_integration: 'NOT_RUN', persisted_images: false };
let checkpoint = 'initial';
const started = [], servers = [];
const relaySockets = new Set();
let redactValues = [];
const digest = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function docker(args, input) {
  try { return execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 240000 }).trim(); }
  catch { throw Error('docker_operation_failed_at_' + checkpoint); } // No command/env/stdout dumps.
}
function record(name) { report.checks.push({ name, result: 'PASS' }); console.log('PASS ' + name); }
async function waitHealth(url) {
  report.last_health = { url, result: 'NOT_RUN' };
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      report.last_health = { url, status: r.status }; await r.arrayBuffer(); if (r.ok) return;
    } catch (error) { report.last_health = { url, error_code: error.cause?.code || error.name }; }
    await pause(2000);
  }
  throw Error('health_deadline_' + checkpoint);
}
async function main() {
  // Nothing supplied here can address another engine or import an existing DB.
  assert(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT);
  const tmp = path.join(out, 'synthetic-state');
  fs.mkdirSync(tmp, { mode: 0o755 });
  const image = name => `phase5-candidate-${name}:${APPLICATION_SHA}`;
  for (const name of ['core', 'bridge', 'bff']) {
    const info = JSON.parse(docker(['image', 'inspect', image(name)]))[0];
    assert.equal(info.Config.Labels['org.opencontainers.image.revision'], APPLICATION_SHA);
    report.actual_images[name] = info.Id;
  }
  const password = 'Synthetic-' + randomBytes(24).toString('hex');
  const token = randomBytes(32).toString('hex'), jwt = randomBytes(32).toString('hex');
  const email = 'candidate-admin@example.test';
  redactValues = [password, token, jwt, email];
  const network = 'phase5-candidate-isolated';
  const envFile = (name, values) => {
    const file = path.join(tmp, name + '.env');
    fs.writeFileSync(file, Object.entries(values).map(([k, v]) => k + '=' + v).join('\n') + '\n', { mode: 0o600 }); return file;
  };
  const run = (name, args, reference, command = []) => {
    docker(['run', '-d', '--name', name, '--label', 'phase5.candidate.run=' + process.env.GITHUB_RUN_ID,
      ...args, reference, ...command]); started.push(name);
  };
  checkpoint = 'synthetic_dependencies';
  docker(['pull', 'postgres:18-alpine']); docker(['pull', 'redis:7-alpine']);
  report.dependencies = Object.fromEntries(['postgres:18-alpine', 'redis:7-alpine'].map(ref => {
    const x = JSON.parse(docker(['image', 'inspect', ref]))[0]; return [ref, { id: x.Id, digests: x.RepoDigests }];
  }));
  docker(['network', 'create', '--internal', network]);
  run('candidate-postgres', ['--network', network, '--env-file', envFile('postgres', {
    POSTGRES_USER: 'candidate', POSTGRES_PASSWORD: password, POSTGRES_DB: 'candidate_synthetic',
  })], 'postgres:18-alpine');
  run('candidate-redis', ['--network', network], 'redis:7-alpine', ['redis-server', '--save', '', '--appendonly', 'no']);
  for (let i = 0; i < 40; i++) {
    // initdb's temporary server accepts Unix sockets before the final TCP
    // server starts. Core uses TCP; do not start it on a socket-only success.
    try { docker(['exec', 'candidate-postgres', 'pg_isready', '-h', '127.0.0.1', '-U', 'candidate', '-d', 'candidate_synthetic']); break; }
    catch { if (i === 39) throw Error('synthetic_postgres_unavailable'); await pause(1000); }
  }
  const roots = ['core', 'image', 'video', 'assets'].map(p => path.join(tmp, p));
  execFileSync('sudo', ['install', '-d', '-m', '0700', '-o', '1000', '-g', '1000', ...roots]);
  const common = { DATABASE_HOST: 'candidate-postgres', DATABASE_PORT: '5432', DATABASE_USER: 'candidate',
    DATABASE_PASSWORD: password, DATABASE_DBNAME: 'candidate_synthetic', DATABASE_SSLMODE: 'disable',
    DATABASE_MAX_OPEN_CONNS: '8', DATABASE_MAX_IDLE_CONNS: '2', REDIS_HOST: 'candidate-redis', REDIS_PORT: '6379',
    REDIS_POOL_SIZE: '8', REDIS_MIN_IDLE_CONNS: '1', JWT_SECRET: jwt, STUDIO_BRIDGE_SERVICE_TOKEN: token };
  checkpoint = 'core_start';
  run('candidate-core', ['--network', network, '--user', '1000:1000',
    '--mount', `type=bind,src=${roots[0]},dst=/app/data`, '--env-file', envFile('core', { ...common,
      AUTO_SETUP: 'true', ADMIN_EMAIL: email, ADMIN_PASSWORD: password, SERVER_HOST: '0.0.0.0', SERVER_PORT: '8080',
      STUDIO_IMAGE_PUBLISHED_SUBMISSION: 'false', STUDIO_VIDEO_ACCOUNT_SUBMISSION: 'false',
    })], image('core'));
  // An internal-only Docker bridge may omit published-port NAT. Keep egress
  // blocked; the Linux host reaches the inspected container IP using bounded
  // loopback TCP relays instead of attaching the application to an external net.
  const coreInfo = JSON.parse(docker(['inspect', 'candidate-core']))[0];
  const ip = coreInfo.NetworkSettings.Networks[network].IPAddress;
  assert(/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$|^10\.\d+\.\d+\.\d+$|^192\.168\.\d+\.\d+$/.test(ip));
  report.runtime_transport = { internal_network: network, container_ip: ip, published_ports: coreInfo.NetworkSettings.Ports };
  for (const [hostPort, containerPort] of [[18080, 8080], [18082, 8091], [18083, 4173]]) {
    const relay = net.createServer(socket => {
      const upstream = net.connect(containerPort, ip);
      for (const connection of [socket, upstream]) {
        relaySockets.add(connection); connection.on('close', () => relaySockets.delete(connection));
        connection.on('error', () => { socket.destroy(); upstream.destroy(); });
      }
      socket.pipe(upstream); upstream.pipe(socket);
    });
    await new Promise(resolve => relay.listen(hostPort, '127.0.0.1', resolve)); servers.push(relay);
  }
  await waitHealth('http://127.0.0.1:18080/health');
  report.core_version = docker(['exec', 'candidate-core', 'sh', '-c', '/app/sub2api -version 2>&1']);
  assert(report.core_version.includes(APPLICATION_SHA.slice(0, 7)));
  report.core_binary_sha256 = docker(['exec', 'candidate-core', 'sha256sum', '/app/sub2api']).split(/\s/)[0];
  record('frozen_core_start_health_version');
  checkpoint = 'bridge_bff_start';
  run('candidate-bridge', ['--network', 'container:candidate-core', '--env-file', envFile('bridge', { ...common,
    STUDIO_BRIDGE_LISTEN_ADDR: '0.0.0.0:8091', STUDIO_IMAGE_CORE_URL: 'http://127.0.0.1:8080',
    STUDIO_IMAGE_GROUP_ID: '1', STUDIO_VIDEO_GROUP_ID: '1', STUDIO_LEGACY_VIDEO_RECOVERY: 'false',
    STUDIO_IMAGE_PUBLISHED_SUBMISSION: 'false', STUDIO_VIDEO_ACCOUNT_SUBMISSION: 'false',
  })], image('bridge'));
  await waitHealth('http://127.0.0.1:18082/health');
  run('candidate-bff', ['--network', 'container:candidate-core',
    ...['image', 'video', 'assets'].flatMap((name, i) => ['--mount', `type=bind,src=${roots[i + 1]},dst=/state/${name}`]),
    '--mount', `type=bind,src=${path.join(source, 'tools')},dst=/app/tools,readonly`,
    '--env-file', envFile('bff', { STUDIO_BRIDGE_URL: 'http://127.0.0.1:8091', STUDIO_BRIDGE_SERVICE_TOKEN: token,
      STUDIO_PUBLIC_ORIGIN: 'http://127.0.0.1:3000', STUDIO_IMAGE_BFF_HOST: '0.0.0.0', STUDIO_IMAGE_BFF_PORT: '4173',
      STUDIO_IMAGE_DATA_ROOT: '/state/image', STUDIO_VIDEO_DATA_ROOT: '/state/video', STUDIO_ASSET_ROOT: '/state/assets',
      STUDIO_IMAGE_PUBLISHED_SUBMISSION: 'false', STUDIO_VIDEO_ACCOUNT_SUBMISSION: 'false', STUDIO_LEGACY_VIDEO_RECOVERY: 'false',
    })], image('bff'));
  await waitHealth('http://127.0.0.1:18083/health');
  report.bridge_binary_sha256 = docker(['exec', 'candidate-bridge', 'sha256sum', '/app/studio-bridge']).split(/\s/)[0];
  report.bff_node = docker(['exec', 'candidate-bff', 'node', '--version']);
  report.bff_entry_sha256 = docker(['exec', 'candidate-bff', 'sha256sum', '/app/studio/bff/image-server.mjs']).split(/\s/)[0];
  assert.equal(report.bff_node, 'v24.21.0');
  assert.equal(docker(['exec', 'candidate-bff', 'id', '-u']), '1000');
  assert.equal(docker(['exec', 'candidate-bff', 'stat', '-c', '%u:%a', '/state/assets']), '1000:700');
  record('bridge_bff_actual_images_nonroot_tools_private_roots');
  if (process.env.CANDIDATE_SMOKE_SCOPE === 'startup') {
    report.status = 'PASS';
    report.scope = 'fresh anonymous digest pulls: startup, health, version, UID, private roots only';
    report.persisted_images = true;
    return;
  }
  const read = async (base, route, opts = {}) => {
    const response = await fetch(base + route, { ...opts, signal: AbortSignal.timeout(10000) });
    report.http.push({ port: new URL(base).port, method: opts.method || 'GET', path: route, status: response.status });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch {}
    return { status: response.status, body, text, cookie: response.headers.get('set-cookie') };
  };
  const core = 'http://127.0.0.1:18080', origin = 'http://127.0.0.1:3000';
  const json = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const login = async () => {
    const r = await read(core, '/api/v1/auth/login', json({ email, password }));
    assert.equal(r.status, 200); assert(r.body.data.access_token && r.body.data.refresh_token); return r.body.data;
  };
  checkpoint = 'real_login_and_legacy_fixture';
  const loginState = await login();
  // Legacy Bridge is unavailable publicly. Seed only its documented ticket record,
  // then exercise the real candidate Core's consume/verify and shipped session adapter.
  // This deliberately does NOT certify that old production executable.
  docker(['cp', 'candidate-bff:/app/studio/bff/studio-session.js', path.join(tmp, 'studio-session.cjs')]);
  const { createCoreStudioClient, createStudioSessionBridge } = createRequire(import.meta.url)(path.join(tmp, 'studio-session.cjs'));
  const legacy = createStudioSessionBridge({ core: createCoreStudioClient({ baseUrl: core, serviceToken: token }), publicOrigin: origin });
  const seedTicket = jwtValue => {
    const raw = Buffer.from(jwtValue.split('.')[1], 'base64url').toString();
    const claims = JSON.parse(raw), version = raw.match(/"token_version":(-?\d+)/)?.[1];
    assert(version && claims.sid && claims.user_id);
    const ticket = randomBytes(32).toString('base64url');
    const record = JSON.stringify({ purpose: 'video-studio', user_id: claims.user_id, session_id: claims.sid,
      token_version: 'EXACT_INTEGER', user_epoch: '', session_epoch: '', expires_at: claims.exp }).replace('"EXACT_INTEGER"', version);
    docker(['exec', '-i', 'candidate-redis', 'redis-cli', '-x', 'SET', 'studio:ticket:' + digest(ticket)], record);
    docker(['exec', 'candidate-redis', 'redis-cli', 'EXPIRE', 'studio:ticket:' + digest(ticket), '45']);
    return ticket;
  };
  const legacyServer = http.createServer(async (req, res) => {
    try {
      if (req.url === '/video.html') { res.end('synthetic legacy static sentinel'); return; }
      if (req.url !== '/studio/api/auth/session') { res.writeHead(404); res.end(); return; }
      if (req.method === 'POST') {
        let body = ''; for await (const part of req) body += part;
        const exchanged = await legacy.exchange(req, JSON.parse(body).ticket);
        res.writeHead(exchanged ? 200 : 403, exchanged ? { 'Set-Cookie': exchanged.cookie } : {}); res.end(); return;
      }
      const session = await legacy.authenticate(req);
      res.writeHead(session ? 200 : 401); res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => legacyServer.listen(18084, '127.0.0.1', resolve)); servers.push(legacyServer);
  const { createDevProxy } = await import(pathToFileURL(path.join(source, 'tools/phase5-media-e2e/dev-proxy.mjs')));
  const proxy = createDevProxy({ PHASE5_BFF_PORT: '18083', PHASE5_FRONTEND_MODE: 'embedded', PHASE5_LEGACY_BFF_PORT: '18084' });
  await new Promise(resolve => proxy.listen(3000, '127.0.0.1', resolve)); servers.push(proxy);
  const headers = { Origin: origin, 'X-Studio-Request': 'session-exchange-v1' };
  const exchangeNew = async state => {
    const ticket = await read(origin, '/api/v1/auth/studio-media-ticket', json({}, { Authorization: 'Bearer ' + state.access_token }));
    assert.equal(ticket.status, 200); assert.equal(ticket.body.data.purpose, 'image-studio');
    const r = await read(origin, '/studio-v2/api/session/exchange', json({ ticket: ticket.body.data.ticket }, headers));
    assert.equal(r.status, 200); assert.match(r.cookie, /^studio_media_session=.+; Path=\/studio-v2;/);
    const replay = await read(origin, '/studio-v2/api/session/exchange', json({ ticket: ticket.body.data.ticket }, headers));
    // An already-consumed ticket is unauthenticated (401), not a CSRF failure (403).
    assert.equal(replay.status, 401); return r.cookie.split(';')[0];
  };
  const exchangeOld = async state => {
    const r = await read(origin, '/studio/api/auth/session', json({ ticket: seedTicket(state.access_token) }, headers));
    assert.equal(r.status, 200); assert.match(r.cookie, /^studio_session=.+; Path=\/studio;/); return r.cookie.split(';')[0];
  };
  const oldCookie = await exchangeOld(loginState), newCookie = await exchangeNew(loginState);
  const session = (route, cookie) => read(origin, route, { headers: { Cookie: cookie } });
  const both = oldCookie + '; ' + newCookie;
  assert.equal((await session('/studio/api/auth/session', both)).status, 200);
  assert.equal((await session('/studio-v2/api/session', both)).status, 200);
  assert.equal((await session('/studio/api/auth/session', newCookie)).status, 401);
  assert.equal((await session('/studio-v2/api/session', oldCookie)).status, 401);
  assert.equal((await read(origin, '/studio/video.html')).text, 'synthetic legacy static sentinel');
  assert.equal((await read(origin, '/studio-v2/api-wrong')).status, 404);
  assert.equal((await read('http://127.0.0.1:18083', '/studio/api/image/tasks')).status, 404);
  assert.equal((await read(core, '/api/v1/internal/studio/sessions/verify', json({ session_proof: 'x'.repeat(43) }))).status, 401);
  const front = await read(origin, '/video-studio'); assert.equal(front.status, 200); assert(front.text.includes('<html'));
  report.served_frontend_html_sha256 = digest(front.text);
  record('real_core_login_bridge_ticket_consume_cookie_isolation_exact_proxy_paths');
  checkpoint = 'gates_asset_and_session_restart';
  for (const kind of ['image', 'video']) {
    const r = await session(`/studio-v2/api/${kind}/readiness`, newCookie);
    assert.equal(r.status, 200); assert.equal(r.body.paid_enabled, false);
  }
  assert.equal((await read(origin, '/studio-v2/api/session', { method: 'DELETE', headers: { Cookie: both, Origin: 'https://wrong.example', 'X-Studio-Request': 'image-binding-v1' } })).status, 403);
  const logout = await read(origin, '/studio-v2/api/session', { method: 'DELETE', headers: { Cookie: both, Origin: origin, 'X-Studio-Request': 'image-binding-v1' } });
  assert.equal(logout.status, 200);
  assert.equal((await session('/studio/api/auth/session', oldCookie)).status, 200);
  assert.equal((await session('/studio-v2/api/session', newCookie)).status, 401);
  const renewedCookie = await exchangeNew(loginState);
  // Generate synthetic media inside the actual BFF image, without provider access.
  docker(['exec', 'candidate-bff', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', '/tmp/candidate.png']);
  docker(['cp', 'candidate-bff:/tmp/candidate.png', path.join(tmp, 'candidate.png')]);
  const png = fs.readFileSync(path.join(tmp, 'candidate.png'));
  const upload = await read(origin, '/studio-v2/api/assets/uploads', { method: 'POST', headers: { Cookie: renewedCookie,
    Origin: origin, 'X-Studio-Request': 'asset-intake-v1', 'X-Studio-Asset-Kind': 'image', 'X-Content-SHA256': digest(png), 'Content-Type': 'image/png' }, body: png });
  assert.equal(upload.status, 201); assert(upload.body.asset_ref);
  const owner = (await session('/studio-v2/api/session', renewedCookie)).body.owner_id;
  docker(['restart', 'candidate-bff']); await waitHealth('http://127.0.0.1:18083/health');
  assert.equal((await session('/studio-v2/api/session', renewedCookie)).status, 401);
  const afterRestart = await exchangeNew(loginState);
  const inspectAsset = `const {createAssetIntake}=await import('/app/studio/bff/asset-intake.mjs');const a=createAssetIntake({rootDir:'/state/assets'});const value=a.uploadPayload(${Number(owner)},${JSON.stringify(upload.body.asset_ref)});if(value.sha256!==${JSON.stringify(digest(png))})throw Error('hash');let denied=false;try{a.uploadPayload(${Number(owner) + 100},${JSON.stringify(upload.body.asset_ref)})}catch{denied=true}if(!denied)throw Error('owner');console.log('asset_recovery_owner_hash_pass');`;
  assert.equal(docker(['exec', 'candidate-bff', 'node', '--input-type=module', '-e', inspectAsset]), 'asset_recovery_owner_hash_pass');
  record('closed_paid_gates_csrf_local_logout_private_asset_restart_hash_owner');
  checkpoint = 'website_revocation';
  assert.equal((await read(core, '/api/v1/auth/logout', json({ refresh_token: loginState.refresh_token }, { Authorization: 'Bearer ' + loginState.access_token }))).status, 200);
  assert.equal((await session('/studio-v2/api/session', afterRestart)).status, 401);
  assert.equal((await session('/studio/api/auth/session', oldCookie)).status, 401);
  const second = await login(), oldSecond = await exchangeOld(second), newSecond = await exchangeNew(second);
  assert.equal((await read(core, '/api/v1/auth/revoke-all-sessions', json({}, { Authorization: 'Bearer ' + second.access_token }))).status, 200);
  assert.equal((await session('/studio/api/auth/session', oldSecond)).status, 401);
  assert.equal((await session('/studio-v2/api/session', newSecond)).status, 401);
  record('real_core_logout_and_revoke_all_invalidate_both_generations');
  checkpoint = 'packaged_recovery_contracts';
  const contracts = docker(['exec', 'candidate-bff', 'node', '--test', '--test-concurrency=1',
    'studio/bff/image-binding.test.mjs', 'studio/bff/legacy-runtime.test.mjs', 'studio/bff/video-result-spec.test.mjs']);
  // The module-level mock supplier tests execute packaged BFF code. They are
  // distinct from the real cross-process identity checks above and from billing E2E.
  console.log(contracts);
  record('packaged_bff_synthetic_response_loss_bytes_versions_recovery_contracts');
  report.status = 'PASS';
  report.network = 'internal Docker network; application containers have no external egress';
}
try { await main(); }
catch (error) {
  report.status = 'FAIL'; report.failed_checkpoint = checkpoint;
  report.error_code = error.code || error.name;
  report.diagnostics = [];
  for (const name of started) {
    try {
      const state = JSON.parse(docker(['inspect', name]))[0].State;
      const logs = spawnSync('docker', ['logs', '--tail', '35', name], { encoding: 'utf8', timeout: 10000 });
      const raw = (logs.stdout || '') + (logs.stderr || '');
      const safe = raw.split(/\r?\n/).filter(line => !/password|secret|token|cookie|authorization|api.?key|private.?key/i.test(line))
        .map(line => redactValues.reduce((value, secret) => value.replaceAll(secret, '[REDACTED]'), line)).slice(-20);
      report.diagnostics.push({ name, running: state.Running, exit_code: state.ExitCode, oom_killed: state.OOMKilled, safe_tail: safe });
    } catch { report.diagnostics.push({ name, state: 'UNAVAILABLE' }); }
  }
  console.error('candidate_smoke_failed_at_' + checkpoint); process.exitCode = 1;
}
finally {
  for (const socket of relaySockets) socket.destroy();
  for (const server of servers) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
  // Only containers created by this script in this ephemeral hosted job. No rm,
  // prune, local engine, shared database, protected layer or production object.
  for (const name of started.reverse()) { try { docker(['stop', '--time', '5', name]); } catch {} }
  fs.writeFileSync(path.join(out, 'smoke.json'), JSON.stringify(report, null, 2));
}
