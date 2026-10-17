const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium } = require('../../frontend/node_modules/@playwright/test')

const root = process.argv[2]
assert(root)
const compose = JSON.parse(fs.readFileSync(`${root}/compose.json`, 'utf8').replace(/^\uFEFF/, ''))
const base = process.env.NATIVE_HISTORY_BASE || 'http://127.0.0.1:28180'

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  const requests = []
  page.on('request', request => {
    if (request.url().includes('/studio-v2/api/')) requests.push({ method: request.method(), path: new URL(request.url()).pathname })
  })
  try {
    await page.goto(`${base}/login`)
    await page.getByLabel('邮箱').fill(compose.services.core.environment.ADMIN_EMAIL)
    await page.getByLabel('密码').fill(compose.services.core.environment.ADMIN_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/dashboard')
    await page.goto(`${base}/video-studio`)
    await page.waitForTimeout(1500)
    const result = await page.evaluate(async () => {
      const image = await fetch('/studio-v2/api/image/tasks', { credentials: 'same-origin' })
      const video = await fetch('/studio-v2/api/video/operations', { credentials: 'same-origin' })
      const imageBody = await image.json()
      const videoBody = await video.json()
      return { imageStatus: image.status, videoStatus: video.status, imageBody, videoBody }
    })
    assert.equal(result.imageStatus, 200)
    assert.equal(result.videoStatus, 200)
    assert(Array.isArray(result.imageBody.tasks), 'image tasks contract must be an array')
    assert(Array.isArray(result.videoBody), 'video operations contract must be an array')
    assert(requests.some(request => request.method === 'GET' && request.path.endsWith('/studio-v2/api/image/tasks')))
    assert(requests.some(request => request.method === 'GET' && request.path.endsWith('/studio-v2/api/video/operations')))
    assert(!requests.some(request => request.method === 'POST' && /\/tasks$/.test(request.path)), 'history read must not submit a paid task')
    console.log(JSON.stringify({ base, imageCount: result.imageBody.tasks.length, videoCount: result.videoBody.length, requests }, null, 2))
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
