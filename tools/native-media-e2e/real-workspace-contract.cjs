const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium } = require('../../frontend/node_modules/@playwright/test')

const root = process.argv[2]
assert(root)
const compose = JSON.parse(fs.readFileSync(`${root}/compose.json`, 'utf8').replace(/^\uFEFF/, ''))
const base = process.env.NATIVE_WORKSPACE_BASE || 'http://127.0.0.1:4296'
const report = { base, requests: [], screenshots: [] }

;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  page.on('request', request => {
    if (request.url().includes('/studio-v2/api/')) report.requests.push({ method: request.method(), path: new URL(request.url()).pathname })
  })
  try {
    await page.goto(`${base}/login`)
    await page.getByLabel('邮箱').fill(compose.services.core.environment.ADMIN_EMAIL)
    await page.getByLabel('密码').fill(compose.services.core.environment.ADMIN_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/dashboard')
    await page.goto(`${base}/video-studio`)
    await page.getByTestId('studio-mode-history').click()
    await page.getByTestId('studio-kind').selectOption('image')
    await page.getByTestId('studio-kind').selectOption('video')
    await page.getByTestId('studio-kind').selectOption('all')
    await page.screenshot({ path: `${root}/evidence/workspace-real-1440.png`, fullPage: true })
    report.screenshots.push(`${root}/evidence/workspace-real-1440.png`)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: `${root}/evidence/workspace-real-390.png`, fullPage: true })
    report.screenshots.push(`${root}/evidence/workspace-real-390.png`)
    console.log(JSON.stringify(report.requests, null, 2))
    assert(report.requests.some(r => r.method === 'GET' && r.path.endsWith('/studio-v2/api/image/tasks')))
    assert(report.requests.some(r => r.method === 'GET' && r.path.endsWith('/studio-v2/api/video/operations')))
    assert(!report.requests.some(r => r.method === 'POST' && /\/tasks$/.test(r.path)), 'history navigation must not create a task')
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
