import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/workbench-procurement',
  testMatch: '*.spec.ts',
  timeout: 35000,
  retries: 0,
  workers: 1,
  outputDir: './test-results/workbench-procurement',
  reporter: [['list'], ['json', { outputFile: './test-results/workbench-procurement/results.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4194',
    testIdAttribute: 'data-test',
    browserName: 'chromium',
    channel: process.env.MEDIA_UI_BROWSER_CHANNEL || (process.platform === 'win32' ? 'chrome' : undefined),
    headless: true,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --config tests/workbench-procurement/vite.config.ts',
    url: 'http://127.0.0.1:4194/tests/workbench-procurement/index.html',
    reuseExistingServer: false
  }
})
