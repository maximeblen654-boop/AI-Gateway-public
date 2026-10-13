// Compare assets used by the browser with bytes served directly by final Core.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
module.exports = function trackArtifactAssets(page) {
  assert.equal(process.env.NATIVE_WORKSPACE_ARTIFACT, 'true')
  assert.notEqual(process.env.NATIVE_WORKSPACE_DEV_SERVER, 'true')
  const pending = [], resources = new Map(), forbidden = [], unavailable = []
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.port === '4295' || /^\/(?:@vite|@id|src|node_modules|tests)\//.test(url.pathname)) forbidden.push(url.pathname)
  })
  page.on('response', response => {
    const url = new URL(response.url())
    if (url.origin !== 'http://127.0.0.1:28100' || !url.pathname.startsWith('/assets/') || !/\.(?:js|css)$/.test(url.pathname)) return
    pending.push((async () => {
      assert.equal(response.status(), 200)
      let bytes
      try { bytes = await response.body() } catch (error) {
        // Chromium can discard preload/cached bodies during document navigation.
        // Do not count these as verified; retain them and require real UI bundles below.
        if (!/No resource with given identifier|navigated away/.test(error.message)) throw error
        unavailable.push({ path: url.pathname, reason: 'Chromium body unavailable after navigation; excluded from byte verification' })
        return
      }
      const direct = await fetch('http://127.0.0.1:28180' + url.pathname)
      assert.equal(direct.status, 200)
      const digest = b => createHash('sha256').update(b).digest('hex')
      const sha256 = digest(bytes)
      assert.equal(sha256, digest(Buffer.from(await direct.arrayBuffer())), 'browser resource differs from final Core')
      resources.set(url.pathname, { path: url.pathname, bytes: bytes.length, sha256, direct_core_equal: true })
    })().then(() => null, error => error))
  })
  return async () => {
    for (const error of await Promise.all(pending)) if (error) throw error
    assert.deepEqual(forbidden, [], 'development-server assets must never be used')
    assert(resources.size >= 3, 'no production frontend bundle evidence')
    assert([...resources.keys()].some(p => /(?:VideoStudioView|MediaWorkbenchView).*\.js$/.test(p)), 'the actual workspace/admin bundle must be byte-verified')
    return { frontend_origin: 'final Core image', vite: false, browser_api_mocking: false, resources: [...resources.values()], unavailable_bodies: unavailable }
  }
}
