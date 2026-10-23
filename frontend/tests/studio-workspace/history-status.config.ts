import { defineConfig } from '@playwright/test'
import { join } from 'node:path'
const outputDir=process.env.STUDIO_HISTORY_OUTPUT_DIR || '../../test-results/history-status'
export default defineConfig({
 testDir:'.',testMatch:'video-history-status.spec.ts',timeout:30000,workers:1,outputDir,
 reporter:[['list'],['json',{outputFile:join(outputDir,'results.json')}]],
 use:{baseURL:'http://127.0.0.1:4311',browserName:'chromium',channel:'chrome',headless:true,trace:'retain-on-failure'},
 webServer:{command:'node ../../node_modules/vite/bin/vite.js --config vite.config.ts --port 4311',url:'http://127.0.0.1:4311/tests/studio-workspace/index.html',reuseExistingServer:false},
})
