// Real embedded Vue + authentication + BFF/Bridge/Core acceptance. Local only.
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const base = 'http://127.0.0.1:3000';
const root = path.resolve(__dirname, '../..');
process.chdir(root);
const output = path.join(root, '.evidence/artifact-browser.json');
const hash = x => createHash('sha256').update(x).digest('hex');
const docker = (...args) => execFileSync('docker', ['--context', 'desktop-linux', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const inspect = name => JSON.parse(docker('inspect', name))[0];
const assert = (value, message) => { if (!value) throw Error(message); };
const report = { started_at: new Date().toISOString(), steps: {}, http: [], external_supplier: false, paid_dispatch: false };
const check = (name, details = {}) => { report.steps[name] = { status: 'PASS', ...details }; console.log(name, 'PASS'); };
const stats = () => JSON.parse(docker('exec', 'phase5-sim-core', 'node', '-e', "fetch('http://127.0.0.1:19091').then(r=>r.json()).then(j=>console.log(JSON.stringify({init:j.init,requests:j.requests})))"));
const coreIdentity = () => { const c = inspect('sub2api-dev'); return { image: c.Image, id: c.Id, started_at: c.State.StartedAt }; };
const png = { name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') };

async function main() {
  const { env, emails, fixture: seed } = await require('./local-identities.cjs')();
  const before = coreIdentity();
  assert(before.image === seed.expected_core_image, 'unexpected Core artifact');
  const core = inspect('sub2api-dev');
  assert(core.Config.Labels['com.docker.compose.project'] === 'phase5', 'not isolated phase5');
  report.components = { core: before, bridge_image: inspect('phase5-studio-bridge').Image,
    bridge_binary_sha256: docker('exec', 'phase5-studio-bridge', 'sha256sum', '/app/studio-bridge').trim().split(/\s+/)[0], bff_node: process.version,
    bff_source_sha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), frontend: 'embedded in Core image' };
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const contexts = [];
  let admin;
  const createdPages = [];
  const listen = p => {
    p.on('response', r => {
      const u = new URL(r.url());
      if (u.origin === base && (u.pathname.startsWith('/studio-v2/api/') || /\/auth\/(login|studio-media-ticket)$/.test(u.pathname) || u.pathname.includes('media-workbench'))) report.http.push({ method: r.request().method(), path: u.pathname, status: r.status() });
    });
  };
  async function login(email) {
    const context = await browser.newContext(); contexts.push(context);
    const p = await context.newPage(); p.setDefaultTimeout(15000); listen(p); createdPages.push(p);
    // Suppress only the optional tour, never authentication or API requests.
    await p.addInitScript(() => { for (const k of ['admin_guide_1_admin_v4_interactive', 'user_guide_2_user_v4_interactive', 'user_guide_3_user_v4_interactive']) localStorage.setItem(k, 'true'); });
    await p.goto(base + '/login');
    await p.getByLabel('邮箱').fill(email); await p.getByLabel('密码').fill(env.ADMIN_PASSWORD);
    await p.getByRole('button', { name: '登录', exact: true }).click(); await p.waitForURL('**/dashboard'); return p;
  }
  const adminApi = (method, suffix, body) => admin.evaluate(async ({ method, suffix, body }) => {
    const r = await fetch('/api/v1/admin/media-workbench/' + suffix, { method, headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token'), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  }, { method, suffix, body });
  const detail = async () => (await adminApi('GET', `accounts/${seed.account_id}`)).body.data;
  async function openModel(model) {
    await admin.goto(base + '/admin/media');
    await admin.locator(`[data-test="supplier-${seed.account_id}"]`).click();
    await admin.locator(`[data-test="model-${model}"]`).click();
  }
  async function save(pass = true) {
    const response = admin.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/draft'));
    await admin.locator('[data-test="save"]').click(); const r = await response;
    assert(r.status() === 200, 'draft HTTP ' + r.status());
    const value = (await r.json()).data.media_workbench_v1;
    assert(value.validation.status === (pass ? 'PASS' : 'FAIL'), 'unexpected validation ' + value.validation.status);
    if (pass) await expect(admin.locator('[data-test="publish"]')).toBeEnabled();
    else await expect(admin.locator('[data-test="publish"]')).toBeDisabled();
    return value;
  }
  async function publish() {
    await admin.locator('[data-test="publish"]').click();
    const response = admin.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/publish'));
    await admin.locator('[data-test="confirm-publish"]').click(); const r = await response;
    assert(r.status() === 200, 'publish HTTP ' + r.status());
    await expect(admin.locator('[data-test="confirm-publish"]')).not.toBeVisible();
    return (await detail()).media_workbench_v1.published.revision;
  }
  async function field(label, value) { await admin.getByLabel(label, { exact: true }).fill(String(value)); }
  async function panel(p, kind, model) {
    await p.goto(base + '/video-studio'); await p.getByTestId('studio-media-open').click();
    await expect(p.getByTestId('studio-kind')).toBeVisible();
    if (await p.getByTestId('studio-kind').inputValue() !== kind) await p.getByTestId('studio-kind').selectOption(kind);
    await expect(p.getByTestId('studio-offer-select').locator('option').filter({ hasText: model })).toHaveCount(1);
    await p.getByTestId('studio-offer-select').selectOption({ label: model });
    await p.getByTestId('studio-prompt').fill('Synthetic local artifact acceptance ' + randomUUID());
  }
  async function upload(p, file) {
    const response = p.waitForResponse(r => r.url().endsWith('/studio-v2/api/assets/uploads'));
    await p.getByTestId('studio-asset-input').setInputFiles(file); const r = await response;
    assert(r.status() === 201, 'asset upload HTTP ' + r.status()); return r.json();
  }
  async function quote(p, kind) {
    const endpoint = `/studio-v2/api/${kind}/${kind === 'video' ? 'quotes' : 'prepare'}`;
    const response = p.waitForResponse(r => new URL(r.url()).pathname === endpoint && r.request().method() === 'POST');
    await p.getByTestId('studio-quote').click(); const r = await response; const body = await r.json();
    assert(r.status() === 200, kind + ' request HTTP ' + r.status() + ' ' + (body.error || ''));
    await expect(p.getByTestId('studio-status')).toContainText(kind === 'video' ? 'op_' : 'img_');
    return { request: r.request().postDataJSON(), response: body };
  }
  const post = (p, route, body, kind = 'video') => p.evaluate(async ({ route, body, kind }) => {
    const r = await fetch('/studio-v2/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Request': kind + '-binding-v1' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, { route, body, kind });
  const videoBinding = id => {
    const dir = path.join('.evidence/studio-video/journal', id), j = JSON.parse(fs.readFileSync(path.join(dir, 'intent.json'))), c = j.children[0];
    const bytes = fs.readFileSync(path.join(dir, 'body-0.bin')), request = JSON.parse(bytes);
    assert(hash(bytes) === c.bodySha256 && c.bodySha256 === c.account.binding.request_hash, 'request bytes/hash mismatch');
    return { operation_id: id, quote_id: j.quoteId, request_hash: c.bodySha256, published_revision: c.account.binding.published_revision,
      model: request.model, spec: c.account.binding.spec, price: c.account.binding.offer.sale_price,
      input_fields: Object.keys(request).sort(), reference_types: request.references?.map(x => x.type) || [], inline_images: request.images?.length || 0 };
  };
  const imageBinding = id => {
    const files = fs.readdirSync('.evidence/studio-image/journal').filter(x => x.startsWith('task-'));
    const task = files.map(x => JSON.parse(fs.readFileSync(path.join('.evidence/studio-image/journal', x)))).find(x => x.task_id === id);
    assert(task, 'image task not durable');
    // The browser's quote is deliberately opaque. Read only whitelisted fields
    // from the protected Core record for local evidence; never expose its token.
    const q = JSON.parse(fs.readFileSync(path.join('deploy/data/studio-image-bindings', 'quote-' + hash(task.quote.quote_token))));
    assert(q.owner.user_id === task.owner && q.owner.api_key_id === task.keyRef, 'image Core owner mismatch');
    assert(JSON.stringify(q.binding.spec) === JSON.stringify(task.quote.spec), 'image Core spec mismatch');
    return { task_id: id, request_hash: task.requestHash, request_hash_scope: 'BFF immutable preparation, not dispatched supplier bytes',
      core_quote_id: q.id, published_revision: q.binding.published_revision,
      model: q.binding.offer.upstream_model, adapter_revision: q.binding.offer.adapter.revision, spec: task.quote.spec, price: task.quote.sale_price,
      references: task.request.references.length, private_reference_expression: task.request.references.every(x => x.startsWith('data:image/')) };
  };
  try {
    const startStats = stats();
    admin = await login(env.ADMIN_EMAIL);
    const html = await (await fetch(base + '/login')).text();
    assert(html.includes('/assets/') && !html.includes('/@vite/client'), 'not embedded frontend');
    check('real_login_embedded_frontend');
    await openModel('phase5-native-image-v1');
    const original = (await detail()).media_workbench_v1;
    fs.writeFileSync('.evidence/artifact-original-draft.json', JSON.stringify(original));
    await field('参考图片上限', 1); await field('参考素材合计上限', 1);
    await admin.locator('[data-test="price-0"]').fill('');
    const missing = await save(false); check('missing_price_publish_gate', { diagnostics: missing.validation.diagnostics.map(x => x.code) });
    await admin.locator('[data-test="price-0"]').fill('0.80');
    const imageDraft = await save();
    await openModel('phase5-native-image-v1');
    assert((await detail()).media_workbench_v1.draft.revision === imageDraft.draft.revision, 'draft refresh mismatch');
    const imageRevision = await publish(); check('image_admin_save_validate_refresh_publish', { revision: imageRevision });
    const stale = await adminApi('PUT', `accounts/${seed.account_id}/draft`, { expected_record_version: original.record_version, draft: { products: original.draft.products } });
    assert(stale.status === 409, 'stale update accepted'); check('stale_cas', { http: stale.status });
    await openModel('phase5-native-video-v1');
    await admin.locator('[data-test="wire-profile"]').selectOption('images');
    await field('参考视频上限', 0); await field('参考音频上限', 0);
    const ratioField = admin.locator('[data-field="capabilities"] label').filter({ hasText: /^比例/ }).locator('input');
    await ratioField.fill('16:9, 9:16, 1:1'); await ratioField.dispatchEvent('change');
    await field('参考图片上限', 1); await field('参考素材合计上限', 1);
    await save(); const videoRevision = await publish();
    const noRestart = coreIdentity(); assert(JSON.stringify(before) === JSON.stringify(noRestart), 'configuration required restart');
    check('video_admin_spec_hot_publish', { revision: videoRevision, no_core_restart: true });
    const customer = await login(emails[0]);
    await panel(customer, 'image', 'phase5-native-image-v1');
    const textImage = await quote(customer, 'image'); check('text_image_quote_prepare', imageBinding(textImage.response.task_id));
    await upload(customer, png); const image = await quote(customer, 'image'); check('image_reference_quote_prepare', imageBinding(image.response.task_id));
    await panel(customer, 'video', 'phase5-native-video-v1');
    await customer.getByTestId('studio-ratio').selectOption('1:1');
    const inline = await quote(customer, 'video'); check('video_inline_new_ratio_quote', videoBinding(inline.response.operation_id));
    await panel(customer, 'video', '特价2.0-需要过人脸技术-可参考过人脸素材库');
    const known = await quote(customer, 'video'); check('enabled_video_inline_image', videoBinding(known.response.operation_id));
    assert(stats().init === startStats.init, 'non-reference preview uploaded'); check('ordinary_preview_no_supplier_upload');

    await openModel('phase5-native-video-v1');
    await admin.locator('[data-test="wire-profile"]').selectOption('references');
    await field('参考视频上限', 1); await field('参考音频上限', 1); await field('参考素材合计上限', 3);
    await save(); const refRevision = await publish();
    assert(JSON.stringify(before) === JSON.stringify(coreIdentity()), 'reference configuration required restart');
    check('reference_profile_normal_ui_publish', { revision: refRevision });
    await panel(customer, 'video', 'phase5-native-video-v1');
    await upload(customer, path.join(root, '.evidence/synthetic.mp4'));
    await upload(customer, path.join(root, '.evidence/synthetic.wav'));
    const beforePrepare = stats();
    const reference = await quote(customer, 'video');
    const refBinding = videoBinding(reference.response.operation_id), afterPrepare = stats();
    assert(reference.request.preparation_id && afterPrepare.init - beforePrepare.init === 3, 'reference upload count');
    assert(refBinding.reference_types.join(',') === 'image,video,audio', 'reference order');
    check('reference_image_video_audio', { ...refBinding, upload_init_delta: afterPrepare.init - beforePrepare.init });
    await customer.reload(); await customer.getByTestId('studio-media-open').click();
    const refreshed = await quote(customer, 'video'); assert(refreshed.response.operation_id === reference.response.operation_id, 'refresh operation drift');
    check('browser_refresh_same_operation');
    // Stop only the verified BFF; all private roots are reused by start-local.
    require('./fixture-config.cjs').stopOwnedBff();
    docker('restart', 'sub2api-dev');
    for (let i = 0; i < 30; i++) { try { if ((await fetch('http://127.0.0.1:18080/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
    docker('restart', 'phase5-studio-bridge'); docker('restart', 'phase5-sim-core'); docker('restart', 'phase5-bridge-proxy');
    execFileSync(process.execPath, ['tools/phase5-media-e2e/start-local.mjs', '--embedded'], { cwd: root, windowsHide: true, stdio: 'pipe' });
    // BFF sessions are short-lived memory state. Reauthenticate through Vue;
    // persistent preparation identity is recovered only after the new session.
    await customer.reload(); await customer.getByTestId('studio-media-open').click();
    await expect(customer.getByTestId('studio-offer-select').locator('option').first()).toBeAttached();
    const restored = await post(customer, 'video/quotes', { ...reference.request, client_key: 'restart-' + randomUUID() });
    assert(restored.status === 200, 'durable preparation restore HTTP ' + restored.status);
    const restoredBinding = videoBinding(restored.body.operation_id);
    assert(restoredBinding.quote_id === refBinding.quote_id && restoredBinding.request_hash === refBinding.request_hash, 'restored quote/hash drift');
    assert(stats().init === afterPrepare.init, 'restart duplicated upload');
    check('bff_core_restart_preparation_recovery', { ...restoredBinding, upload_init_after: stats().init, same_quote: true, same_request_hash: true });
    const missingPrep = await post(customer, 'video/quotes', { ...reference.request, client_key: 'missing-' + randomUUID(), preparation_id: undefined });
    const reordered = await post(customer, 'video/quotes', { ...reference.request, client_key: 'reordered-' + randomUUID(), assets: [...reference.request.assets].reverse() });
    assert(missingPrep.status === 422 && reordered.status === 422, 'preparation negative accepted');
    const other = await login(emails[1]); await panel(other, 'video', 'phase5-native-video-v1');
    const foreign = await post(other, 'video/quotes', { ...reference.request, client_key: 'foreign-' + randomUUID() });
    assert(foreign.status >= 400 && foreign.status < 500, 'foreign assets accepted');
    const permission = await other.evaluate(async () => (await fetch('/api/v1/admin/media-workbench/suppliers', { headers: { Authorization: 'Bearer ' + localStorage.getItem('auth_token') } })).status);
    assert(permission === 403, 'customer has admin permission');
    check('negative_cases', { missing_preparation: missingPrep.status, reordered_assets: reordered.status, foreign_assets_preparation: foreign.status, admin_permission: permission });
    const videoGate = await post(customer, 'video/tasks', { operation_id: reference.request.preparation_id });
    const imageGate = await post(customer, 'image/tasks', {}, 'image');
    assert(videoGate.status === 503 && imageGate.status === 503, 'paid gate enabled');
    check('preparation_not_generation_and_paid_gates', { video: videoGate.status, image: imageGate.status });
    const imgRetry = await post(customer, 'image/prepare', image.request, 'image');
    assert(imgRetry.status === 200 && imgRetry.body.task_id === image.response.task_id, 'image restart identity drift');
    check('image_restart_original_task', imageBinding(imgRetry.body.task_id));
    await customer.getByTestId('studio-media-panel').screenshot({ path: '.evidence/artifact-reference.png' });
    const finishStats = stats(); assert(finishStats.init === afterPrepare.init, 'negative cases uploaded');
    const generated = finishStats.requests.slice(startStats.requests.length).filter(x => x.method === 'POST' && ['/v1/videos', '/v1/images/generations', '/v1/images/edits'].includes(x.path));
    assert(generated.length === 0, 'unexpected generation');
    report.mock = { init_before: startStats.init, init_after: finishStats.init, generation_requests: generated.length };
    report.finished_at = new Date().toISOString(); report.result = 'PASS';
  } catch (error) {
    report.result = 'FAIL'; report.failure = error.message.split('\n')[0];
    throw error;
  } finally {
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    await browser.close();
  }
}
main().catch(error => { console.error(error.message.split('\n')[0]); process.exitCode = 1; });
