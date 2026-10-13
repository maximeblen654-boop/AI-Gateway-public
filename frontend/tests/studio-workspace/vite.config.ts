import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
export default defineConfig({ root: resolve(__dirname, '../..'), plugins: [vue()], resolve: { alias: { '@': resolve(__dirname, '../../src') } }, server: { hmr: process.env.NATIVE_WORKSPACE_UI === 'true' ? false : undefined, host: '127.0.0.1', port: 4295, strictPort: true } })
