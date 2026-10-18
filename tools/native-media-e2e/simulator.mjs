// Synthetic upstream only. No request is forwarded to another server.
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'

const root = process.env.NATIVE_EVIDENCE_ROOT || '/evidence'
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const statePath = path.join(root, 'native-supplier-state.json')
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { requests: [], image_posts: 0, video_posts: 0, tasks: {} }
const save = () => fs.writeFileSync(path.join(root, 'native-supplier-state.json'), JSON.stringify(state, null, 2))
const tlsOptions={ key: fs.readFileSync(path.join(root, 'simulator-key.pem')), cert: fs.readFileSync(path.join(root, 'simulator-cert.pem')) }
const handle=async (req, res) => {
  const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  try {
    const url = new URL(req.url, 'https://localhost:19090')
    const parts = []; let size = 0
    for await (const part of req) { size += part.length; assert(size <= 4 * 1024 * 1024); parts.push(part) }
    const bytes=Buffer.concat(parts)
    const raw = bytes.toString('utf8')
    const binary=req.method==='PUT' && /\/media\/uploads\/[^/]+\/chunks\/\d+$/.test(url.pathname)
    const body = binary ? {binary_bytes:bytes.length} : raw ? JSON.parse(raw) : {}
    const auth = req.headers.authorization === 'Bearer synthetic-native-only' ? 'bearer' : req.headers['x-goog-api-key'] === 'synthetic-native-only' ? 'gemini-key' : 'missing'
    state.requests.push({ method: req.method, path: url.pathname, auth, body }); save()
    const signedResult = req.method === 'GET' && /^\/v1\/videos\/seedance-task-\d+\/content$/.test(url.pathname) && url.searchParams.get('signature') === 'synthetic-result-only'
    if (signedResult) assert.equal(auth, 'missing', 'result download must not forward supplier credentials')
    if (auth === 'missing' && !signedResult) return reply(401, { error: 'synthetic_auth' })
    // Account-bound upload protocol is confined to this disposable simulator.
    const uploadPath=/^\/(?:v1\/)?media\/uploads(?:\/([^/]+))?(?:\/(chunks)\/(\d+)|\/(complete))?$/.exec(url.pathname)
    if(uploadPath){
      state.uploads ||= {}
      if(req.method==='POST' && !uploadPath[1]){
        assert(Number.isSafeInteger(body.size)&&body.size>0&&body.size<4*1024*1024)
        const id='synthetic-upload-'+(Object.keys(state.uploads).length+1)
        state.uploads[id]={id,size:body.size,sha256:body.sha256,chunk_size:1024*1024,chunk_count:Math.ceil(body.size/(1024*1024)),received:[],status:'uploading',chunks:{}};save();return reply(200,{id})
      }
      const u=state.uploads[uploadPath[1]];assert(u,'unknown synthetic upload')
      if(req.method==='GET')return reply(200,u)
      if(req.method==='PUT'&&uploadPath[2]==='chunks'){
        const n=Number(uploadPath[3]);assert(n>=0&&n<u.chunk_count);u.chunks[n]=bytes.toString('base64');if(!u.received.includes(n))u.received.push(n);save();return reply(200,{ok:true})
      }
      if(req.method==='POST'&&uploadPath[4]==='complete'){
        const all=Buffer.concat(Array.from({length:u.chunk_count},(_,n)=>Buffer.from(u.chunks[n]||'','base64')))
        assert.equal(all.length,u.size);assert.equal(createHash('sha256').update(all).digest('hex'),u.sha256)
        u.status='complete';u.source='https://localhost:19090/synthetic-reference/'+u.id;save();return reply(200,{status:u.status,source:u.source})
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') return reply(200, { object: 'list', data: ['gpt-image-2', 'gpt-image-1', 'grok-imagine-image', 'grok-imagine-video', 'native-openai-image', 'synthetic-compatible-video', 'synthetic-compatible-upstream', 'synthetic-seedance-video', 'synthetic-seedance-upstream', 'WAN3.0-可参考视频', 'synthetic-chat-upstream'].map(id => ({ id, object: 'model' })) })
    if (req.method === 'GET' && url.pathname === '/v1beta/models') return reply(200, { models: [{ name: 'models/gemini-3.1-flash-image', displayName: 'Synthetic Gemini Image', supportedGenerationMethods: ['generateContent'] }] })
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      assert.equal(auth, 'bearer'); assert.equal(body.model, 'synthetic-chat-upstream')
      assert.equal(body.stream, false); assert(Array.isArray(body.messages))
      return reply(200, { id:'chatcmpl-synthetic-procurement', object:'chat.completion', created:1, model:body.model, choices:[{index:0,message:{role:'assistant',content:'Isolated API route remains independent.'},finish_reason:'stop'}], usage:{prompt_tokens:7,completion_tokens:9,total_tokens:16} })
    }
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
      // Bounded fault/latency fixtures for task recovery UX; this simulator never forwards externally.
      if (body.prompt.startsWith('BATCH_FUNDS_')) {
        // Only the local simulator injects faults; never forward these requests.
        await new Promise(resolve => setTimeout(resolve, 500))
        const scenario = body.prompt.split(':')[0]
        if (scenario === 'BATCH_FUNDS_REJECT') return reply(422, { error: 'synthetic_rejected_before_generation' })
        if (scenario === 'BATCH_FUNDS_502') return reply(502, { error: 'synthetic_final_outcome_unavailable' })
        if (scenario === 'BATCH_FUNDS_DISCONNECT') return req.socket.destroy()
        if (scenario === 'BATCH_FUNDS_TIMEOUT') await new Promise(resolve => setTimeout(resolve, 25000))
        if (scenario === 'BATCH_FUNDS_LATE') await new Promise(resolve => setTimeout(resolve, 3000))
        const attempts = state.requests.filter(r => r.method === 'POST' && r.body.prompt === body.prompt).length
        if (scenario === 'BATCH_FUNDS_PARTIAL502' && attempts === 2) return reply(502, { error: 'synthetic_second_unit_502' })
        if (scenario === 'BATCH_FUNDS_PARTIAL' && attempts === 2) return reply(422, { error: 'synthetic_second_unit_rejected' })
      }
      if (body.prompt.startsWith('SYNTHETIC_UNKNOWN_502')) { res.setHeader('x-request-id', 'synthetic-studio-unknown-502'); return reply(502, { error: 'synthetic_upstream_outcome_unknown' }) }
      if (body.prompt.startsWith('SYNTHETIC_WAIT')) await new Promise(resolve => setTimeout(resolve, 15000))
      const calls = state.requests.filter(r => r.method === 'POST' && r.body.prompt === body.prompt)
      if (body.prompt.startsWith('SYNTHETIC_PARTIAL') && calls.length === 2) return reply(422, { error: 'synthetic_second_batch_rejected' })
      if(body.output_format){
        assert(['png','jpeg','webp'].includes(body.output_format),'Unsupported synthetic format')
        const fixtures=JSON.parse(fs.readFileSync(path.join(root,'synthetic-output-formats.json'),'utf8'))
        const image=fixtures[body.output_format];assert.equal(image.mime_type,'image/'+body.output_format)
        return reply(200,{data:Array.from({length:body.n},()=>({...image,output_format:body.output_format}))})
      }
      return reply(200, { data: Array.from({ length: body.n }, () => ({ b64_json: png })) })
    }
    if (req.method === 'POST' && url.pathname === '/api/v3/contents/generations/tasks') {
      state.video_posts++
      assert.equal(auth, 'bearer'); assert.equal(body.model, 'synthetic-seedance-video')
      assert(Array.isArray(body.content) && body.content.some(item => item.type === 'text'))
      const id = `seedance-task-${state.video_posts}`
      state.tasks[id] = { id, polls: 0, kind: 'seedance' }; save()
      return reply(200, { id, status: 'queued', model: body.model })
    }
    if (req.method === 'POST' && ['/v1/videos', '/v1/videos/generations'].includes(url.pathname)) {
      state.video_posts++
      assert.equal(auth, 'bearer'); assert(['grok-imagine-video', 'synthetic-compatible-video', 'WAN3.0-可参考视频'].includes(body.model))
      const id = `native-video-${state.video_posts}`
      state.tasks[id] = { id, polls: 0, kind: body.model === 'grok-imagine-video' ? 'grok' : 'compatible' }; save()
      return reply(200, { id, request_id: id, status: 'pending' })
    }
    const seedance = /^\/api\/v3\/contents\/generations\/tasks\/(seedance-task-\d+)$/.exec(url.pathname)
    if (req.method === 'GET' && seedance && state.tasks[seedance[1]]) {
      const task = state.tasks[seedance[1]]
      task.polls++; save()
      return reply(200, { id: task.id, status: 'succeeded', model: 'synthetic-seedance-video', usage: { completion_tokens: 1 }, content: { video_url: `${process.env.NATIVE_RESULT_ORIGIN || 'https://localhost:19090'}/v1/videos/${task.id}/content?signature=synthetic-result-only` } })
    }
    const match = /^\/v1\/videos\/(native-video-\d+)(\/content)?$/.exec(url.pathname)
    if (req.method === 'GET' && match && state.tasks[match[1]]) {
      const task = state.tasks[match[1]]
      if (!match[2]) { task.polls++; save(); return reply(200, { id: task.id, status: task.kind === 'grok' ? 'done' : 'completed', video: { url: `https://localhost:19090/v1/videos/${task.id}/content` } }) }
      const bytes = fs.readFileSync(path.join(root, 'synthetic-original.mp4'))
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, 'X-Video-Quality': 'original' }); return res.end(bytes)
    }
    const seedanceContent = /^\/v1\/videos\/(seedance-task-\d+)\/content$/.exec(url.pathname)
    if (req.method === 'GET' && seedanceContent && state.tasks[seedanceContent[1]]) {
      const bytes = fs.readFileSync(path.join(root, 'synthetic-original.mp4'))
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, 'X-Video-Quality': 'original' }); return res.end(bytes)
    }
    return reply(404, { error: 'synthetic_route_not_supported' })
  } catch (error) { return reply(422, { error: 'synthetic_contract', message: error.message }) }
}
https.createServer(tlsOptions,handle).listen(19090, '0.0.0.0')
if(process.env.NATIVE_IMAGE_FINALITY==='true')https.createServer(tlsOptions,handle).listen(443,'0.0.0.0')
http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(state)) }).listen(19091, '127.0.0.1')
console.log('Synthetic native media upstream listening; external forwarding disabled')
