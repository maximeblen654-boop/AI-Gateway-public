// Invoked by Go's loopback-only Bridge contract test. No supplier endpoint.
import assert from 'node:assert/strict';
import path from 'node:path';
import { createImageTaskRuntime, createPublishedImageClient } from '../image-binding.mjs';
import { createImageResultStore } from '../image-result-store.mjs';
const [baseUrl, rootDir] = process.argv.slice(2);
const session = { ownerId: 1, sessionProof: 'valid-proof' };
const call = createPublishedImageClient({ baseUrl, serviceToken: 's'.repeat(32) });
const results = createImageResultStore({ rootDir: path.join(rootDir, 'results') });
let runtime = createImageTaskRuntime({ rootDir: path.join(rootDir, 'journal'), call, results });
const q = await runtime.quote(session, { offer_id: 'published-offer', spec: { count: 1, images: 0 } });
const input = { quote_token: q.quote_token, client_key: 'stable-client-key', prompt: 'synthetic contract fixture', references: [] };
await assert.rejects(runtime.dispatch(session, input), /receipt GET recovery only/);
const taskID = runtime.prepare(session, input).task.task_id;
// A new process/runtime owner recovers the exact task/key without another POST.
runtime = createImageTaskRuntime({ rootDir: path.join(rootDir, 'journal'), call, results });
const task = await runtime.dispatch(session, input);
assert.equal(task.task_id, taskID);
assert.equal(task.status, 'completed');
assert.equal(task.results.length, 1);
assert.equal(runtime.result(session, taskID, 0).info.mime_type, 'image/png');
assert.throws(() => runtime.result({ ownerId: 2 }, taskID, 0));
process.stdout.write('BFF -> Bridge -> Core contract; lost POST -> original receipt GET; PASS\n');
