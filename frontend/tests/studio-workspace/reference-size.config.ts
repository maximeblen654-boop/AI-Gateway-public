import { defineConfig } from '@playwright/test'
import { join } from 'node:path'
const outputDir = process.env.STUDIO_UI_OUTPUT_DIR || '../../test-results/reference-size'
export default defineConfig({
  testDir: '.', testMatch: 'reference-size.spec.ts', timeout: 30000, workers: 1,
  outputDir, reporter: [['list'], ['json', { outputFile: join(outputDir, 'results.json') }]],
  use: { baseURL: 'http://127.0.0.1:4398', browserName: 'chromium', channel: process.env.STUDIO_UI_BROWSER_CHANNEL || undefined, headless: true, trace: 'retain-on-failure' },
  webServer: { command: 'node ../../node_modules/vite/bin/vite.js --config vite.config.ts', url: 'http://127.0.0.1:4398/tests/studio-workspace/index.html', reuseExistingServer: false, env: { STUDIO_UI_PORT: '4398' } },
})
