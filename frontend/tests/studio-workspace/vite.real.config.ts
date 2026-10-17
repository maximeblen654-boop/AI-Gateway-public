import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(here, '../..'),
  plugins: [vue()],
  resolve: { alias: { '@': resolve(here, '../../src') } },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.NATIVE_REAL_PORT || 4296),
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:28100',
      '/studio-v2': 'http://127.0.0.1:28100',
    },
  },
})
