// Synthetic upstream only. No request is forwarded to another server.
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'

const root = process.env.NATIVE_EVIDENCE_ROOT || '/evidence'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const state = { requests: [], image_posts: 0, video_posts: 0, tasks: {} }
const save = () => fs.writeFileSync(path.join(root, 'native-supplier-state.json'), JSON.stringify(state, null, 2))
https.createServer({ key: fs.readFileSync(path.join(root, 'simulator-key.pem')), cert: fs.readFileSync(path.join(root, 'simulator-cert.pem')) }, async (req, res) => {
  const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  try {
    const url = new URL(req.url, 'https://localhost:19090')
    const parts = []; let size = 0
    for await (const part of req) { size += part.length; assert(size <= 4 * 1024 * 1024); parts.push(part) }
    const raw = Buffer.concat(parts).toString('utf8')
    const body = raw ? JSON.parse(raw) : {}
    const auth = req.headers.authorization === 'Bearer synthetic-native-only' ? 'bearer' : req.headers['x-goog-api-key'] === 'synthetic-native-only' ? 'gemini-key' : 'missing'
    state.requests.push({ method: req.method, path: url.pathname, auth, body }); save()
    if (auth === 'missing') return reply(401, { error: 'synthetic_auth' })
    if (req.method === 'GET' && url.pathname === '/v1/models') return reply(200, { object: 'list', data: ['grok-imagine-image', 'grok-imagine-video', 'native-openai-image'].map(id => ({ id, object: 'model' })) })
    if (req.method === 'GET' && url.pathname === '/v1beta/models') return reply(200, { models: [{ name: 'models/gemini-3.1-flash-image', displayName: 'Synthetic Gemini Image', supportedGenerationMethods: ['generateContent'] }] })
    if (req.method === 'POST' && url.pathname.endsWith(':generateContent')) {
      state.image_posts++; save()
      assert.equal(url.pathname, '/v1beta/models/gemini-3.1-flash-image:generateContent')
      assert.equal(auth, 'gemini-key')
      assert(body.contents[0].parts.some(p => p.text))
      return reply(200, { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: png } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 9, totalTokenCount: 16 } })
    }
    if (req.method === 'POST' && ['/v1/images/generations', '/v1/images/edits'].includes(url.pathname)) {
      state.image_posts++; save()
      assert.equal(auth, 'bearer'); assert.equal(typeof body.prompt, 'string'); assert(Number.isInteger(body.n) && body.n >= 1 && body.n <= 10)
      const calls = state.requests.filter(r => r.method === 'POST' && r.body.prompt === body.prompt)
      if (body.prompt.startsWith('SYNTHETIC_PARTIAL') && calls.length === 2) return reply(422, { error: 'synthetic_second_batch_rejected' })
      return reply(200, { data: Array.from({ length: body.n }, () => ({ b64_json: png })) })
    }
    if (req.method === 'POST' && ['/v1/videos', '/v1/videos/generations'].includes(url.pathname)) {
      state.video_posts++
      assert.equal(auth, 'bearer'); assert.equal(body.model, 'grok-imagine-video')
      const id = `native-video-${state.video_posts}`
      state.tasks[id] = { id, polls: 0 }; save()
      return reply(200, { id, request_id: id, status: 'pending' })
    }
    const match = /^\/v1\/videos\/(native-video-\d+)(\/content)?$/.exec(url.pathname)
    if (req.method === 'GET' && match && state.tasks[match[1]]) {
      const task = state.tasks[match[1]]
      if (!match[2]) { task.polls++; save(); return reply(200, { id: task.id, status: 'done', video: { url: `https://localhost:19090/v1/videos/${task.id}/content` } }) }
      const bytes = fs.readFileSync(path.join(root, 'synthetic-original.mp4'))
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); return res.end(bytes)
    }
    return reply(404, { error: 'synthetic_route_not_supported' })
  } catch (error) { return reply(422, { error: 'synthetic_contract', message: error.message }) }
}).listen(19090, '0.0.0.0')
http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)) }).listen(19091, '127.0.0.1')
console.log('Synthetic native media upstream listening; external forwarding disabled')
