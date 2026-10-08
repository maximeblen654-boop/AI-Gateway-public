// Non-secret identity for an explicitly provisioned, local-only test environment.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const fixturePath = () => process.env.PHASE5_FIXTURE_MANIFEST || path.join(root, '.evidence/local-fixture.json');

function validateFixture(value) {
  assert(value && typeof value === 'object', 'Local fixture manifest is required');
  assert.deepEqual(Object.keys(value).filter(k=>k!=='mock_submission').sort(), ['account_id', 'expected_core_image', 'schema_version', 'user_ids']);
  if(value.mock_submission!==undefined)assert.equal(value.mock_submission,true);
  assert.equal(value.schema_version, 1, 'Unsupported local fixture version');
  assert(/^sha256:[a-f0-9]{64}$/.test(value.expected_core_image), 'Expected an immutable local Core image ID');
  assert(Number.isSafeInteger(value.account_id) && value.account_id > 0, 'Expected a test Account ID');
  assert(Array.isArray(value.user_ids) && value.user_ids.length === 2, 'Expected two test customer IDs');
  assert(value.user_ids.every(id => Number.isSafeInteger(id) && id > 0), 'Invalid test customer ID');
  assert.equal(new Set(value.user_ids).size, 2, 'Test customers must be distinct');
  return value;
}

function readFixture() {
  let value;
  try { value = JSON.parse(fs.readFileSync(fixturePath(), 'utf8')); }
  catch { throw Error('Create a local fixture with configure-fixture.cjs before running this optional browser harness'); }
  return validateFixture(value);
}

function assertFixtureCore(core, fixture, {mockSubmission=false}={}) {
  validateFixture(fixture);
  assert(core?.State?.Running && core.Config?.Labels?.['com.docker.compose.project'] === 'phase5', 'Expected a running, isolated phase5 Core');
  assert.equal(core.Image, fixture.expected_core_image, 'Core image differs from the explicit local fixture');
  const env = Object.fromEntries((core.Config.Env || []).map(value => {
    const index = value.indexOf('=');
    return [value.slice(0, index), value.slice(index + 1)];
  }));
  for (const key of ['STUDIO_VIDEO_ACCOUNT_SUBMISSION', 'STUDIO_VIDEO_REAL_SUBMISSION', 'STUDIO_IMAGE_REAL_SUBMISSION']) {
    if(key==='STUDIO_VIDEO_ACCOUNT_SUBMISSION' && mockSubmission && fixture.mock_submission===true)continue;
    assert(env[key] !== 'true', 'Real submission must remain disabled in the local fixture');
  }
  return env;
}

function assertLocalSupplier(value) {
  let url;
  try { url = new URL(value); } catch { throw Error('The test Account must use the local protocol simulator'); }
  assert(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
    ['127.0.0.1', '[::1]', 'localhost', 'host.docker.internal'].includes(url.hostname) && url.port === '19090',
  'The test Account must use the local protocol simulator on port 19090');
}

function ownsBffCommandLine(commandLine, checkout = root) {
  const normalize = value => value.replace(/\\/g, '/').toLowerCase();
  const expected = normalize(path.join(checkout, 'studio/bff/image-server.mjs'));
  const arguments_ = String(commandLine || '').match(/"[^"]*"|[^\s]+/g) || [];
  return arguments_.some(value => normalize(value.replace(/^"|"$/g, '')) === expected);
}

function stopOwnedBff() {
  const { execFileSync } = require('node:child_process');
  const powershell = script => execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const details = JSON.parse(powershell("$taskPid=(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8093 -State Listen -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess); Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskPid) | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress"));
    assert(Number.isSafeInteger(details.ProcessId) && details.ProcessId > 0);
    assert(ownsBffCommandLine(details.CommandLine), 'BFF belongs to another checkout');
    assert.equal(details.ExecutablePath.toLowerCase(), process.execPath.toLowerCase(), 'BFF uses another executable');
    const expected = details.CommandLine.replace(/'/g, "''");
    // Check identity again in the stopping process; never stop an arbitrary listener.
    powershell(`$taskProcess=Get-CimInstance Win32_Process -Filter 'ProcessId=${details.ProcessId}'; if (!$taskProcess -or $taskProcess.CommandLine -cne '${expected}') { throw 'BFF identity changed' }; Stop-Process -Id ${details.ProcessId} -ErrorAction Stop`);
  } catch { throw Error('BFF stop refused or failed; check this checkout\'s explicit local service identity'); }
}

module.exports = { root, fixturePath, validateFixture, readFixture, assertFixtureCore, assertLocalSupplier, ownsBffCommandLine, stopOwnedBff };
