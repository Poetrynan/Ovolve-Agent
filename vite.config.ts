import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import fs from 'node:fs'

function devApiToken(): string {
  try {
    return fs.readFileSync(path.resolve(__dirname, 'app/.api_token'), 'utf-8').trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'app/ui'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'app/ui/src'),
      '@components': path.resolve(__dirname, 'app/ui/src/components'),
      '@store': path.resolve(__dirname, 'app/ui/src/store'),
      '@lib': path.resolve(__dirname, 'app/ui/src/lib'),
      '@pages': path.resolve(__dirname, 'app/ui/src/pages'),
      '@apptypes': path.resolve(__dirname, 'app/ui/src/types'),
      '@hooks': path.resolve(__dirname, 'app/ui/src/hooks'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8765',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (proxyReq.getHeader('X-Api-Token')) return
            const t = devApiToken()
            if (t) proxyReq.setHeader('X-Api-Token', t)
          })
        },
      },
      '/ws': {
        target: 'ws://127.0.0.1:8765',
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            if (proxyReq.getHeader('X-Api-Token')) return
            const t = devApiToken()
            if (t) proxyReq.setHeader('X-Api-Token', t)
          })
        },
      },
    },
  },
  build: {
    // 必须是仓库根的 dist/，不能用相对 root 的 'dist'。
    // electron/main.ts 生产分支是 loadFile(path.join(__dirname, '../dist/index.html'))，
    // __dirname 即 dist-electron/，所以它找的是 <repo>/dist/index.html；
    // 而 vite 的 root 是 app/ui，相对 outDir 会写到 app/ui/dist/，
    // 打包后主进程永远找不到入口（白屏）。这里显式指向根目录。
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})
