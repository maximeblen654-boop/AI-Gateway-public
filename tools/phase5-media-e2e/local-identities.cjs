const { execFileSync } = require('node:child_process');
const { readFixture, assertFixtureCore, assertLocalSupplier } = require('./fixture-config.cjs');

module.exports = async function localIdentities(options) {
  const fixture = readFixture();
  const core = JSON.parse(execFileSync('docker', ['--context', 'desktop-linux', 'inspect', 'sub2api-dev'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  const values = assertFixtureCore(core, fixture, options);
  const env = { ADMIN_EMAIL: values.ADMIN_EMAIL, ADMIN_PASSWORD: values.ADMIN_PASSWORD };
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) throw Error('Local test administrator credentials are not configured');
  const response = await fetch('http://127.0.0.1:18080/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw Error('Local fixture login failed');
  const token = (await response.json()).data.access_token;
  const get = async route => {
    const result = await fetch('http://127.0.0.1:18080/api/v1/admin/' + route, {
      headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) throw Error('Local fixture object unavailable');
    return (await result.json()).data;
  };
  const account = await get('accounts/' + fixture.account_id);
  assertLocalSupplier(account.credentials?.base_url);
  const emails = [];
  for (const id of fixture.user_ids) {
    const user = await get('users/' + id);
    if (user.role !== 'user' || user.status !== 'active') throw Error('Expected an active local test customer');
    emails.push(user.email);
  }
  return { env, emails, fixture };
};
