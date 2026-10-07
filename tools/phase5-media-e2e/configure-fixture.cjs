// Record IDs created through normal local administration; never seed a database.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { root, fixturePath, validateFixture, assertFixtureCore } = require('./fixture-config.cjs');

try {
  const ids = process.argv.slice(2).map(Number);
  if (ids.length !== 3) throw Error('Usage: node tools/phase5-media-e2e/configure-fixture.cjs ACCOUNT_ID CUSTOMER_ID OTHER_CUSTOMER_ID');
  const core = JSON.parse(execFileSync('docker', ['--context', 'desktop-linux', 'inspect', 'sub2api-dev'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  const fixture = validateFixture({ schema_version: 1, account_id: ids[0], user_ids: ids.slice(1), expected_core_image: core.Image });
  assertFixtureCore(core, fixture);
  const directory = path.join(root, '.evidence');
  fs.mkdirSync(directory, { recursive: true });
  // -n and wx preserve any existing fixture or media. All content is synthetic.
  for (const [filename, input, options] of [
    ['synthetic.mp4', 'color=c=blue:s=32x32:d=1', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']],
    ['synthetic.wav', 'sine=frequency=440:duration=1', ['-c:a', 'pcm_s16le']],
  ]) {
    const output = path.join(directory, filename);
    if (!fs.existsSync(output)) execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', input, ...options, output],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  fs.writeFileSync(fixturePath(), JSON.stringify(fixture, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Local fixture identity and synthetic media prepared; no account, Published record or credential was written.');
} catch (error) {
  console.error(error.code === 'EEXIST' ? 'Local fixture already exists; it was preserved.' :
    error.message.startsWith('Usage:') ? error.message : 'Local fixture setup failed. Check IDs, local Core identity, ffmpeg and the output path.');
  process.exitCode = 1;
}
