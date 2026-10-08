const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateFixture, assertFixtureCore, assertLocalSupplier, ownsBffCommandLine } = require('./fixture-config.cjs');
const fixture = () => ({ schema_version: 1, account_id: 101, user_ids: [201, 202], expected_core_image: 'sha256:' + 'a'.repeat(64) });
const core = () => ({ Image: fixture().expected_core_image, State: { Running: true }, Config: { Labels: { 'com.docker.compose.project': 'phase5' }, Env: [] } });

test('local fixture binds an explicit immutable image and distinct user identities', () => {
  assert.deepEqual(validateFixture(fixture()), fixture());
  assert.deepEqual(assertFixtureCore(core(), fixture()), {});
  for (const patch of [{ expected_core_image: 'latest' }, { user_ids: [201, 201] }, { account_id: -1 }, { token: 'synthetic' }, { schema_version: 2 }]) {
    assert.throws(() => validateFixture({ ...fixture(), ...patch }));
  }
});

test('wrong or stopped Core, another project and enabled submission fail closed', () => {
  const variants = [core(), core(), core(), core()];
  variants[0].Image = 'sha256:' + 'b'.repeat(64);
  variants[1].State.Running = false;
  variants[2].Config.Labels['com.docker.compose.project'] = 'another-project';
  variants[3].Config.Env = ['STUDIO_VIDEO_ACCOUNT_SUBMISSION=true'];
  for (const value of variants) assert.throws(() => assertFixtureCore(value, fixture()));
});

test('only the local simulator endpoint is accepted', () => {
  for (const host of ['127.0.0.1', '[::1]', 'localhost', 'host.docker.internal']) assert.doesNotThrow(() => assertLocalSupplier(`https://${host}:19090/v1`));
  for (const value of ['https://supplier.example.test:19090', 'https://127.0.0.1', 'https://user:synthetic@localhost:19090', 'file:///tmp/test']) assert.throws(() => assertLocalSupplier(value));
});

test('controlled mock video requires both an explicit fixture and caller opt-in; legacy gates stay closed',()=>{
 const c=core(),f={...fixture(),mock_submission:true};c.Config.Env=['STUDIO_VIDEO_ACCOUNT_SUBMISSION=true'];
 assert.throws(()=>assertFixtureCore(c,f));assert.throws(()=>assertFixtureCore(c,fixture(),{mockSubmission:true}));
 assert.doesNotThrow(()=>assertFixtureCore(c,f,{mockSubmission:true}));
 c.Config.Env.push('STUDIO_VIDEO_REAL_SUBMISSION=true');assert.throws(()=>assertFixtureCore(c,f,{mockSubmission:true}));
});

test('BFF ownership accepts Windows separators and spaces but rejects another checkout or similar script', () => {
  const checkout = 'D:/local fixture';
  assert.equal(ownsBffCommandLine('"D:\\nodejs\\node.exe" "D:\\local fixture\\studio\\bff\\image-server.mjs"', checkout), true);
  assert.equal(ownsBffCommandLine('node "D:/local fixture/studio/bff/image-server.mjs"', checkout), true);
  assert.equal(ownsBffCommandLine('node "D:/other fixture/studio/bff/image-server.mjs"', checkout), false);
  assert.equal(ownsBffCommandLine('node "D:/local fixture/studio/bff/image-server.mjs.bak"', checkout), false);
  assert.equal(ownsBffCommandLine('node studio/bff/image-server.mjs', checkout), false);
});
