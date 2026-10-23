import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
export default defineConfig({ root: resolve(here, '../..'), cacheDir: process.env.STUDIO_UI_CACHE_DIR, plugins: [vue()], resolve: { alias: { '@': resolve(here, '../../src') } }, server: { hmr: process.env.NATIVE_WORKSPACE_UI === 'true' ? false : undefined, host: '127.0.0.1', port: Number(process.env.STUDIO_UI_PORT || 4295), strictPort: true } })
