import http from 'node:http';

const forward = targetPort => http.createServer((req, res) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: req.url,
    method: req.method, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('proxy unavailable'); } });
  req.pipe(upstream);
});

// Local artifact acceptance serves the embedded frontend from the same Core.
const front = forward(process.env.PHASE5_FRONTEND_MODE === 'embedded' ? 18080 : 3001), bff = forward(8093), bridge = forward(18082);
http.createServer((req, res) => {
  (req.url === '/api/v1/auth/studio-ticket' ? bridge : req.url.startsWith('/studio') ? bff : front)
    .emit('request', req, res);
}).listen(3000, '127.0.0.1');
