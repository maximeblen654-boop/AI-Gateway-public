import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/media-workbench', testMatch: '*.spec.ts',
  timeout: 30000, retries: 0, workers: 2,
  outputDir: './test-results/media-workbench', reporter: [['list'], ['json', { outputFile: './test-results/media-workbench/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:4190', testIdAttribute: 'data-test', browserName: 'chromium', channel: process.env.MEDIA_UI_BROWSER_CHANNEL || undefined, headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js --config tests/media-workbench/vite.config.ts', url: 'http://127.0.0.1:4190/tests/media-workbench/index.html', reuseExistingServer: false }
})
