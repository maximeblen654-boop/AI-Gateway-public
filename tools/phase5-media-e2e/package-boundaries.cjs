// Exercise the real Docker context filter using synthetic files only.
// This does not build, run, publish or modify the application image.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
process.chdir(root);
const yamlRoot = fs.readdirSync('frontend/node_modules/.pnpm').find(n => /^yaml@/.test(n));
assert(yamlRoot, 'Existing frontend dependencies are required; do not install implicitly');
const YAML = require(path.join(root, 'frontend/node_modules/.pnpm', yamlRoot, 'node_modules/yaml'));
const files = YAML.parse(fs.readFileSync('.goreleaser.yaml', 'utf8')).archives.flatMap(a => a.files);
const tracked = new Set(execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split(/\r?\n/));
for (const file of files) {
  assert.equal(typeof file, 'string');
  assert(!/[*?{}[\]]/.test(file), 'Release archive must use literal file paths');
  assert(tracked.has(file) && fs.lstatSync(file).isFile(), 'Only tracked regular files may ship');
}
const excluded = [
  'backend/data/private.db', '.local-sub2api-release/state.json', '.local-newapi-baseline/state.json',
  '.local-upstream-ab/state.json', '.local-project-control/state.json', 'secrets/key.txt',
  'credentials/access.txt', 'backend/secrets/key.txt', 'backend/credentials/access.txt',
  '.evidence/private.json', 'deploy/.env', 'backend/.env.local', 'backend/config.yaml',
  'deploy/config.yaml', 'backend/config.local.yaml', 'backend/.installed',
  'deploy/data/private.db', 'deploy/postgres_data/private.db', 'deploy/redis_data/private.rdb',
];
const included = ['backend/main.go', 'deploy/config.example.yaml', 'deploy/.env.example', 'public-marker.txt'];
for (const file of excluded) assert(!files.includes(file), 'Private fixture in release archive');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'phase5-package-boundary-'));
const context = path.join(temporary, 'context'), output = path.join(temporary, 'out');
try {
  fs.mkdirSync(context);
  fs.copyFileSync('.dockerignore', path.join(context, '.dockerignore'));
  fs.writeFileSync(path.join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /\n');
  for (const file of [...excluded, ...included]) {
    const target = path.join(context, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'SYNTHETIC PUBLIC TEST MARKER ONLY\n');
  }
  execFileSync('docker', ['--context', 'desktop-linux', 'buildx', 'build', '--builder', 'desktop-linux',
    '--progress', 'plain', '--output', 'type=local,dest=' + output, context],
  { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const file of excluded) assert(!fs.existsSync(path.join(output, file)), 'Private fixture included: ' + file);
  for (const file of included) assert(fs.existsSync(path.join(output, file)), 'Public input excluded: ' + file);
  console.log(JSON.stringify({ result: 'PASS', archive_files: files.length,
    private_fixtures_excluded: excluded.length, public_inputs_retained: included.length }));
} finally {
  // Delete only this freshly-created, resolved synthetic fixture root.
  const resolved = fs.realpathSync(temporary), parent = fs.realpathSync(os.tmpdir());
  assert(path.dirname(resolved) === parent && path.basename(resolved).startsWith('phase5-package-boundary-'));
  fs.rmSync(resolved, { recursive: true });
}
