import http from 'node:http';
import { pathToFileURL } from 'node:url';

const forward = targetPort => http.createServer((req, res) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: req.url,
    method: req.method, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) { res.writeHead(502); res.end('proxy unavailable'); } });
  req.pipe(upstream);
});

export function studioRoute(raw) {
  const pathname = raw.split('?')[0];
  if (pathname === '/api/v1/auth/studio-media-ticket') return 'media-ticket';
  if (pathname === '/api/v1/auth/studio-ticket') return 'legacy-ticket';
  if (pathname.startsWith('/studio-v2/api/')) return 'media';
  if (pathname.startsWith('/studio/')) return 'legacy';
  if (pathname === '/studio-v2' || pathname.startsWith('/studio-v2/')) return 'reject';
  return 'front';
}

export function studioUpstreamPath(raw) {
  const route = studioRoute(raw);
  if (route === 'media-ticket') return raw.replace('/api/v1/auth/studio-media-ticket', '/api/v1/auth/studio-ticket');
  // Legacy static files are root-relative, while its API keeps /studio/api/.
  if (route === 'legacy' && !raw.split('?')[0].startsWith('/studio/api/')) return raw.slice('/studio'.length);
  return raw;
}

export function createDevProxy(env = process.env) {
  const bffPort = Number(env.PHASE5_BFF_PORT || 8093);
  if (![8093, 18083].includes(bffPort)) throw Error('Expected an existing local Studio BFF port');
  const optional = value => {
    if (!value) return undefined;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local legacy port');
    return forward(port);
  };
  const targets = {
    front: forward(env.PHASE5_FRONTEND_MODE === 'embedded' ? 18080 : 3001),
    media: forward(bffPort),
    'media-ticket': forward(18082),
    legacy: optional(env.PHASE5_LEGACY_BFF_PORT),
    'legacy-ticket': optional(env.PHASE5_LEGACY_BRIDGE_PORT),
  };
  return http.createServer((req, res) => {
    const route = studioRoute(req.url);
    if (route === 'reject') { res.writeHead(404); res.end(); return; }
    if (!targets[route]) { res.writeHead(503); res.end('legacy local entry not configured'); return; }
    // Only the new public ticket name is rewritten to the new Bridge contract.
    // Business paths retain their versioned prefix all the way into the BFF.
    req.url = studioUpstreamPath(req.url);
    targets[route].emit('request', req, res);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createDevProxy().listen(3000, '127.0.0.1');
}
