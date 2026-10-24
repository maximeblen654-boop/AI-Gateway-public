import { test, expect, type Page } from '@playwright/test'
import { fileURLToPath } from 'node:url'

const imageFile = fileURLToPath(new URL('./retention-cover.jpg', import.meta.url))

async function open(page: Page, scenario = 'empty') {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort())
  await page.goto('/tests/studio-workspace/index.html?scenario=' + scenario)
  await expect(page.getByTestId('studio-mode-text')).toBeEnabled()
}
async function noGeneration(page: Page) {
  const submitted = await page.evaluate(() => (window as any).studioFixture.calls.filter((call: any) => call.method === 'POST' && call.path.endsWith('/tasks')))
  expect(submitted).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
}
async function refreshCatalog(page: Page) {
  await page.getByTestId('studio-refresh-models').click()
  await expect(page.getByTestId('studio-refresh-models')).toBeEnabled()
}

for (const width of [1440, 390]) {
  test(`mode changes clear obsolete asset notices at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await open(page)
    await page.getByTestId('studio-mode-edit').click()
    await page.getByTestId('studio-asset-input').setInputFiles(imageFile)
    await expect(page.getByTestId('studio-asset-success')).toHaveCount(1)
    await expect(page.getByText('素材已私有保存，顺序如上。', { exact: true })).toBeVisible()
    await page.getByTestId('studio-mode-text').click()
    await expect(page.getByText('已切换为文生图，当前输入不再使用参考素材。', { exact: true })).toBeVisible()
    await expect(page.getByTestId('studio-asset-input')).toHaveCount(0)
    await page.getByTestId('studio-mode-video').click()
    await expect(page.getByTestId('studio-mode-video')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('studio-model-toggle')).toContainText('映像 · 视频')
    await expect(page.locator('.studio-notice')).toHaveCount(0)
    await expect(page.getByTestId('studio-asset-success')).toHaveCount(0)
    await page.screenshot({ path: info.outputPath(`mode-switch-${width}.png`), fullPage: true, animations: 'disabled' })
    await noGeneration(page)
  })

  test(`video navigation wins after selecting image history at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await open(page, 'mixed')
    await page.getByTestId('studio-mode-video').click()
    await expect(page.getByTestId('studio-model-toggle')).toContainText('映像 · 视频')
    await page.getByTestId('studio-mode-history').click()
    await page.locator('[data-task-id^="img_"]').first().click()
    await expect(page.getByTestId('studio-task')).toBeVisible()
    await page.getByTestId('studio-mode-video').click()
    await expect(page.getByTestId('studio-mode-video')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('studio-mode-text')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('studio-task')).toHaveCount(0)
    await expect(page.getByTestId('studio-model-toggle')).toContainText('映像 · 视频')
    await expect(page.getByTestId('studio-duration')).toContainText('5 秒')
    await expect(page.getByTestId('studio-count')).toHaveCount(0)
    await expect(page.locator('[data-task-id^="img_"]')).toHaveCount(0)
    await expect(page.locator('[data-task-id^="op_"]')).toHaveCount(1)
    await page.screenshot({ path: info.outputPath(`history-to-video-${width}.png`), fullPage: true, animations: 'disabled' })
    await noGeneration(page)
  })

  test(`catalog load and refresh warnings disappear after recovery at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await open(page)
    await page.evaluate(() => {
      const original = window.fetch
      let failNext = true
      Object.assign(window, { failNextCatalog: () => { failNext = true } })
      window.fetch = async (input, init) => {
        if (String(input).endsWith('/video/catalog') && failNext) {
          failNext = false
          return new Response(JSON.stringify({ error: 'synthetic_catalog_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } })
        }
        return original(input, init)
      }
    })
    await page.getByTestId('studio-mode-video').click()
    await expect(page.getByText('目录或生成服务暂不可用，仍可查询原任务和已保存结果。', { exact: true })).toBeVisible()
    await refreshCatalog(page)
    await expect(page.locator('.studio-notice')).toHaveCount(0)
    await expect(page.getByTestId('studio-model-toggle')).toContainText('映像 · 视频')
    await page.getByTestId('studio-prompt').fill('保留目录刷新期间的创作输入')
    await page.evaluate(() => (window as any).failNextCatalog())
    await refreshCatalog(page)
    await expect(page.getByText('模型目录暂时无法刷新，保留当前输入与已有结果。', { exact: true })).toBeVisible()
    await refreshCatalog(page)
    await expect(page.locator('.studio-notice')).toHaveCount(0)
    await expect(page.getByTestId('studio-prompt')).toHaveValue('保留目录刷新期间的创作输入')
    await expect(page.getByTestId('studio-quote')).toBeEnabled()
    await page.screenshot({ path: info.outputPath(`catalog-recovered-${width}.png`), fullPage: true, animations: 'disabled' })
    await noGeneration(page)
  })

  test(`returned catalog permits new quotes but keeps old quote invalid at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await open(page)
    await page.getByTestId('studio-prompt').fill('目录恢复后重新获取报价')
    await page.getByTestId('studio-quote').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: '返回修改' }).click()
    await page.evaluate(() => {
      const original = window.fetch
      let removed = true
      Object.assign(window, { restoreCatalog: () => { removed = false } })
      window.fetch = async (input, init) => {
        const response = await original(input, init)
        if (String(input).endsWith('/image/catalog') && removed) return new Response(JSON.stringify({ offers: [] }), { headers: { 'Content-Type': 'application/json' } })
        return response
      }
    })
    await refreshCatalog(page)
    await expect(page.getByTestId('studio-model-unavailable')).toBeVisible()
    await expect(page.getByTestId('studio-quote')).toBeDisabled()
    await page.evaluate(() => (window as any).restoreCatalog())
    await refreshCatalog(page)
    await expect(page.getByTestId('studio-model-unavailable')).toHaveCount(0)
    await expect(page.getByTestId('studio-model-toggle')).toContainText('GPT Image 2')
    await expect(page.getByTestId('studio-quote')).toBeEnabled()
    await page.screenshot({ path: info.outputPath(`offer-returned-${width}.png`), fullPage: true, animations: 'disabled' })
    await page.getByTestId('studio-mode-history').click()
    await page.locator('[data-task-id^="img_"]').first().click()
    await expect(page.getByTestId('studio-model-unavailable')).toBeVisible()
    await expect(page.getByTestId('studio-generate')).toBeDisabled()
    await page.getByTestId('studio-new').click()
    await expect(page.getByTestId('studio-quote')).toBeEnabled()
    await noGeneration(page)
  })
}
