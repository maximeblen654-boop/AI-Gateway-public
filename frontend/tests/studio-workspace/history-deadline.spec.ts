import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const base = Date.parse('2026-10-19T00:00:00Z'), hour = 3600000, ttl = 72 * hour
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

// Actual BFF journal/store/HTTP handler, synthetic Core and owner; no supplier network.
async function localBff() {
  const { createImageTaskRuntime, IMAGE_BINDING_CONTRACT: contract } = await import(new URL('../../../studio/bff/image-binding.mjs', import.meta.url).href)
  const { createImageResultStore } = await import(new URL('../../../studio/bff/image-result-store.mjs', import.meta.url).href)
  const { createImageHandler } = await import(new URL('../../../studio/bff/image-server.mjs', import.meta.url).href)
  const temp = fileURLToPath(new URL('../../../.codex-tmp/history-deadline-fix-20261019/tmp/', import.meta.url))
  fs.mkdirSync(temp, { recursive: true })
  const root = fs.mkdtempSync(path.join(temp, 'browser-'))
  let clock = base, generationPosts = 0, receiptGets = 0, resultGets = 0
  const session = { ownerId: 9001, sessionProof: 'synthetic-local-session' }
  const result_retention = () => ({ policy: 'image_original_72h', persisted_at: new Date(base + hour).toISOString(), expires_at: new Date(base + hour + ttl).toISOString(), expired: clock >= base + hour + ttl })
  const call = async (_session: unknown, method: string, operation: string) => {
    if (operation === 'quotes') return { key_ref: 2, payload: { contract, quote_token: 'a'.repeat(64), spec: { resolution: '2K', aspect_ratio: '1:1', count: 1, images: 0 }, sale_price: { amount: '0.01', currency: 'CNY', billing_mode: 'per_request' }, expires_at: new Date(base + 120000).toISOString() } }
    if (method === 'POST') { generationPosts++; clock = base + hour; return { payload: {} } }
    if (operation.endsWith('/result')) { resultGets++; return { payload: { data: [{ b64_json: png }] } } }
    receiptGets++
    return { payload: { contract, task_id: operation.slice(6), status: 'completed', billing_state: 'billed', result_available: !result_retention().expired, result_retention: result_retention() } }
  }
  const store = createImageResultStore({ rootDir: path.join(root, 'originals'), now: () => clock })
  const tasks = createImageTaskRuntime({ rootDir: path.join(root, 'journal'), call, results: store, now: () => clock })
  await tasks.quote(session, { offer_id: 'image-standard', spec: { count: 1, images: 0 } })
  const task = await tasks.dispatch(session, { quote_token: 'a'.repeat(64), client_key: 'history-delay-browser', prompt: 'synthetic fixture', references: [] })
  const server = http.createServer(createImageHandler({ sessions: { authenticate: async () => session }, tasks }))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}`, task,
    set: (value: number) => { clock = value },
    counts: () => ({ generationPosts, receiptGets, resultGets }),
    close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); fs.rmSync(root, { recursive: true }) },
  }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) test(`delayed original stays in real BFF history until its deadline ${viewport.width}`, async ({ page, request }, info) => {
  const bff = await localBff()
  try {
    bff.set(base + ttl)
    const settledCounts = bff.counts(), methods: string[] = []
    await page.setViewportSize(viewport)
    await page.clock.setFixedTime(new Date(base + ttl))
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
    await page.route('**/studio-v2/api/image/tasks**', async route => {
      methods.push(route.request().method())
      if (route.request().method() !== 'GET') { await route.abort(); return }
      const response = await route.fetch({ url: bff.url + new URL(route.request().url()).pathname })
      await route.fulfill({ response })
    })
    await page.goto('/tests/studio-workspace/index.html?scenario=history-deadline-real-bff')
    await page.getByTestId('studio-mode-history').click()
    const card = page.locator(`[data-task-id="${bff.task.task_id}"]`)
    await expect(card).toBeVisible()
    await card.click()
    await expect(page.getByTestId('studio-task-id')).toContainText(bff.task.task_id)
    await expect(page.getByTestId('studio-download')).toHaveCount(1)
    await expect(page.getByTestId('studio-result-image')).toHaveJSProperty('complete', true)
    await expect(page.getByTestId('studio-result-retention')).toContainText('2026/10/22')
    await page.getByTestId('studio-result-retention').scrollIntoViewIfNeeded()
    await page.screenshot({ path: info.outputPath(`history-live-${viewport.width}.png`) })

    bff.set(base + hour + ttl - 1)
    const download = await request.get(`${bff.url}/studio-v2/api/image/tasks/${bff.task.task_id}/results/0`)
    expect(download.status()).toBe(200)
    expect(await download.body()).toEqual(Buffer.from(png, 'base64'))
    expect((await (await request.get(`${bff.url}/studio-v2/api/image/tasks`)).json()).tasks).toHaveLength(1)

    bff.set(base + hour + ttl)
    await page.clock.setFixedTime(new Date(base + hour + ttl))
    await expect(page.getByTestId('studio-result-retention')).toContainText('原片已到期')
    await expect(page.getByTestId('studio-download')).toHaveCount(0)
    expect((await request.get(`${bff.url}/studio-v2/api/image/tasks/${bff.task.task_id}/results/0`)).status()).toBe(410)
    await page.getByRole('button', { name: '刷新记录', exact: true }).click()
    await expect(card).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`history-expired-${viewport.width}.png`) })
    expect(bff.counts()).toEqual(settledCounts)
    expect(methods.length).toBeGreaterThan(0)
    expect(methods.every(method => method === 'GET')).toBe(true)
    expect(await page.evaluate(() => (window as any).studioFixture.calls.filter((call: any) => call.method === 'POST'))).toHaveLength(0)
  } finally { await bff.close() }
})
