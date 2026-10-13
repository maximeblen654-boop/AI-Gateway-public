// Final embedded frontend only. Read/cancel administrator publication controls.
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { chromium, expect } = require('../../frontend/node_modules/@playwright/test')
const root = process.argv[2]
assert(root && /native-media-20261012$/.test(root.replace(/\\/g, '/')))
assert.equal(process.env.NATIVE_WORKSPACE_ARTIFACT, 'true')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const fixture = JSON.parse(fs.readFileSync(`${root}/evidence/fixture.json`, 'utf8'))
const compose = JSON.parse(fs.readFileSync(`${root}/compose.json`, 'utf8'))
const report = { source_sha: process.env.NATIVE_CANDIDATE_SOURCE_SHA, script_sha: process.env.GITHUB_SHA, checks: [], business_writes: [] }
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' })
  page.setDefaultTimeout(20000)
  const proof = require('./artifact-assets.cjs')(page)
  const w = id => page.locator(`[data-test="${id}"]`)
  page.on('request', request => {
    if (request.url().includes('/api/v1/admin/media-workbench/') && request.method() !== 'GET') report.business_writes.push({ path: new URL(request.url()).pathname, method: request.method() })
  })
  try {
    await page.addInitScript(() => { localStorage.setItem('sub2api_locale', 'zh'); localStorage.setItem('admin_guide_1_admin_v4_interactive', 'true') })
    await page.goto('http://127.0.0.1:28100/login')
    await page.getByLabel('邮箱').fill(compose.services.core.environment.ADMIN_EMAIL)
    await page.getByLabel('密码').fill(compose.services.core.environment.ADMIN_PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.waitForURL('**/dashboard')
    for (const [kind, account, model] of [['image', fixture.accounts.gemini, 'gemini-3.1-flash-image'], ['video', fixture.accounts.compatible, 'synthetic-compatible-video']]) {
      await page.goto('http://127.0.0.1:28100/admin/media')
      await w('account-search').fill(`#${account}`)
      await w(`supplier-${account}`).click()
      await expect(w('account-publication')).toContainText('包含此 Account 的所有草稿商品')
      await expect(w('account-publication')).toContainText('发布配置不会自动开启销售')
      await expect(w('publish')).toBeEnabled()
      const publication = await w('account-publication').boundingBox()
      const firstModel = await w(`model-${model}`).boundingBox()
      assert(publication.y < firstModel.y, 'publication must precede the model list')
      await w('model-search').fill('not-a-model')
      await w('publish').click()
      const dialog = page.getByRole('dialog', { name: '发布这次修改？' })
      await expect(dialog).toContainText('当前 Account')
      await expect(dialog.locator('li')).toHaveCount(2)
      await expect(w('confirm-publish')).toBeEnabled()
      await page.screenshot({ path: `${root}/evidence/native-artifact-admin-${kind}-confirmation.png`, fullPage: true })
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      await w('model-search').fill('')
      await page.screenshot({ path: `${root}/evidence/native-artifact-admin-${kind}-desktop.png`, fullPage: true })
      await w(`model-${model}`).click()
      const back = w('editor-page').getByRole('button', { name: '← 返回模型列表', exact: true }).first()
      await expect(back).toBeVisible()
      await back.click()
      await expect(w('model-page')).toBeVisible()
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(w('publish')).toBeEnabled()
      // AppLayout animates its desktop margin for 300 ms on viewport changes.
      // Check the settled layout, not the first frame of that transition.
      await expect.poll(() => page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, margin: getComputedStyle(document.querySelector('.app-layout > .relative')).marginLeft })), { timeout: 5000, message: 'settled admin mobile layout must fit 390px' }).toEqual({ width: 390, scroll: 390, margin: '0px' })
      await page.screenshot({ path: `${root}/evidence/native-artifact-admin-${kind}-mobile.png`, fullPage: true })
      await page.setViewportSize({ width: 1440, height: 1000 })
      report.checks.push({ kind, account, publish_above_models: true, account_scope_despite_search: true, confirmation_cancelled: true, navigation_preserved: true, mobile: true })
    }
    assert.deepEqual(report.business_writes, [])
    report.assets = await proof()
    report.status = 'PASS'
  } catch (error) {
    report.status = 'FAIL'; report.error = error.message
    report.layout = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, margin: getComputedStyle(document.querySelector('.app-layout > .relative')).marginLeft, wide_elements: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(e => ({ tag: e.tagName, class: e.className, width: e.getBoundingClientRect().width })) }))
    await page.screenshot({ path: `${root}/evidence/native-artifact-admin-failure.png`, fullPage: true }).catch(() => {})
    throw error
  } finally {
    fs.writeFileSync(`${root}/evidence/native-artifact-admin.json`, JSON.stringify(report, null, 2))
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
