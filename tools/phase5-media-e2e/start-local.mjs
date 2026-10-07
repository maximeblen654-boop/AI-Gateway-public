import { execFileSync, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fixtureConfig from './fixture-config.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const embedded = process.argv.includes('--embedded');
const syntheticContract = process.argv.includes('--synthetic-contract');
const requiredContainers = [
  'sub2api-dev',
  'sub2api-postgres-dev',
  'sub2api-redis-dev',
  'phase5-studio-bridge',
  'phase5-bridge-proxy',
];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = port => new Promise(resolve => {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => { socket.destroy(); resolve(false); });
});
const waitForPort = async (port, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await listen(port)) return true;
    await sleep(250);
  }
  return false;
};
const start = (command, args, cwd, env) => {
  const child = spawn(command, args, { cwd, env, detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
};
const docker = (...args) => execFileSync('docker', ['--context', 'desktop-linux', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const inspect = name => JSON.parse(docker('inspect', name))[0];
const commandLineForPort = port => {
  const script = "$p=(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess); if ($p) { (Get-CimInstance Win32_Process -Filter \"ProcessId=$p\").CommandLine }".replace('%PORT%', String(port));
  try { return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return ''; }
};
const assert = (condition, reason) => { if (!condition) throw new Error(reason); };
const safeError = error => String(error?.message || error).replace(/[\r\n]+/g, ' ').replace(/(TOKEN|SECRET|PASSWORD|KEY)=\S+/gi, '$1=[redacted]').slice(0, 240);

const assertContainer = (name, container) => {
  assert(container?.State?.Running === true, `required container is not running: ${name}`);
  if (name === 'sub2api-dev' || name === 'sub2api-postgres-dev' || name === 'sub2api-redis-dev') {
    assert(container.Config?.Labels?.['com.docker.compose.project'] === 'phase5', `unexpected compose project for ${name}`);
  }
};
const assertJsonHealth = async (url, label, predicate) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
  assert(response.ok, `${label} health returned HTTP ${response.status}`);
  const body = await response.json();
  assert(predicate(body), `${label} health response did not match phase5 instance`);
};

async function main() {
  const fixture = fixtureConfig.readFixture();
  const context = docker('context', 'show').trim();
  assert(context === 'desktop-linux', `unexpected Docker context: ${context || 'none'}`);
  for (const name of requiredContainers) assertContainer(name, inspect(name));
  fixtureConfig.assertFixtureCore(inspect('sub2api-dev'), fixture);
  const bridge = inspect('phase5-studio-bridge');
  // This existing local fixture shares Core's namespace to preserve the
  // Bridge's loopback-only HTTP rule. A Core recreate must rebind the fixture.
  assert(bridge.HostConfig.NetworkMode === `container:${inspect('sub2api-dev').Id}`, 'Bridge is attached to a retired Core network namespace');
  assert(await waitForPort(18082), 'Bridge port 18082 is not reachable');
  await assertJsonHealth('http://127.0.0.1:18082/health', 'Bridge', body => body?.code === 0 && body?.data?.status === 'ok');
  await assertJsonHealth('http://127.0.0.1:18080/health', 'Core', body => body?.status === 'ok' || body?.data?.status === 'ok');

  const coreEnv = Object.fromEntries((inspect('sub2api-dev').Config?.Env || []).map(value => {
    const index = value.indexOf('=');
    return [value.slice(0, index), value.slice(index + 1)];
  }));
  const bffEnv = {
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    STUDIO_IMAGE_DATA_ROOT: path.join(root, '.evidence', 'studio-image'),
    STUDIO_VIDEO_DATA_ROOT: path.join(root, '.evidence', 'studio-video'),
    STUDIO_ASSET_ROOT: path.join(root, '.evidence', 'studio-assets'),
    STUDIO_PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
    STUDIO_BRIDGE_URL: 'http://127.0.0.1:18082',
    STUDIO_BRIDGE_SERVICE_TOKEN: coreEnv.STUDIO_BRIDGE_SERVICE_TOKEN,
    STUDIO_IMAGE_BFF_PORT: '8093',
    STUDIO_VIDEO_ACCOUNT_SUBMISSION: 'false',
  };
  if (coreEnv.STUDIO_FFPROBE_PATH) bffEnv.STUDIO_FFPROBE_PATH = coreEnv.STUDIO_FFPROBE_PATH;
  assert(bffEnv.STUDIO_BRIDGE_SERVICE_TOKEN, 'required Bridge service token is not configured');

  const bffScript = path.join(root, 'studio/bff/image-server.mjs');
  const bffArgs = [...(syntheticContract ? ['--import', path.join(root, 'tools/phase5-media-e2e/register-contract.mjs')] : []), bffScript];
  if (!(await listen(8093))) start(process.execPath, bffArgs, root, bffEnv);
  const viteScript = path.join(root, 'frontend/node_modules/vite/bin/vite.js');
  if (!embedded && !(await listen(3001))) start(process.execPath, [viteScript, '--host', '127.0.0.1', '--port', '3001'], path.join(root, 'frontend'), {
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
  });
  const proxyArgs = [path.join(root, 'tools', 'phase5-media-e2e', 'dev-proxy.mjs'), ...(embedded ? ['--embedded'] : [])];
  if (!(await listen(3000))) start(process.execPath, proxyArgs, root, {
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SystemRoot: process.env.SystemRoot,
    PHASE5_FRONTEND_MODE: embedded ? 'embedded' : 'development',
  });
  for (const [port, marker] of [[8093, bffScript], ...(!embedded ? [[3001, viteScript]] : []), [3000, proxyArgs[0]]]) {
    assert(await waitForPort(port), `required local service did not listen on ${port}`);
    const commandLine = commandLineForPort(port);
    assert(commandLine.toLowerCase().includes(marker.toLowerCase()), `port ${port} is not owned by the expected phase5 service`);
    if (port === 8093) assert(commandLine.includes('register-contract.mjs') === syntheticContract, 'existing BFF contract mode differs; restart only that BFF');
    if (port === 3000) assert(commandLine.includes('--embedded') === embedded, 'existing local proxy frontend mode differs; restart only that proxy');
  }
  console.log(`phase5 local startup verified: Vue=${embedded ? 'Core embedded' : '3001'} proxy=3000 BFF=8093 Bridge=18082 Core=18080`);
}

main().catch(error => {
  console.error(`phase5 startup failed: ${safeError(error)}`);
  process.exitCode = 1;
});
