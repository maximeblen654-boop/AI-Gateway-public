// Preview-only local originals. No production registration.
let originals = []
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('message', event => { if (event.data.originals) originals = event.data.originals })
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname.includes('/studio-v2/api/image/tasks/') && url.pathname.includes('/results/')) {
    const id = url.pathname.split('/')[5]
    event.respondWith(new Response(originals[parseInt(id.slice(-2), 16) % 3] || originals[0], { headers: { 'Content-Type': 'image/svg+xml', 'Content-Disposition': 'inline' } }))
  }
})
