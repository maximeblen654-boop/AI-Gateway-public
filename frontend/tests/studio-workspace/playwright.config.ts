import { defineConfig, devices } from '@playwright/test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: here,
  testMatch: 'workspace.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4295',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node ../../node_modules/vite/bin/vite.js --config vite.config.ts',
    url: 'http://127.0.0.1:4295/tests/studio-workspace/index.html',
    reuseExistingServer: false,
    timeout: 30_000,
  },
})
