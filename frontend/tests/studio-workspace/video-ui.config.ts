import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const outputDir=process.env.STUDIO_UI_OUTPUT_DIR || fileURLToPath(new URL('../../test-results/video-ui',import.meta.url))
export default defineConfig({
 testDir:'.',testMatch:['video-ui.spec.ts','product-offers.spec.ts','retention.spec.ts'],timeout:30000,workers:1,
 outputDir,reporter:[['list'],['json',{outputFile:join(outputDir,'results.json')}]],
 use:{baseURL:'http://127.0.0.1:4295',browserName:'chromium',channel:process.env.STUDIO_UI_BROWSER_CHANNEL || 'chrome',headless:true,trace:'retain-on-failure'},
 webServer:{command:'node ../../node_modules/vite/bin/vite.js --config vite.config.ts',url:'http://127.0.0.1:4295/tests/studio-workspace/index.html',reuseExistingServer:!process.env.CI}
})
