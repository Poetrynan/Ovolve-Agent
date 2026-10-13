import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

/**
 * The backend's API token, as written by a *standalone* backend run.
 *
 * Two dev topologies exist and they get the token differently:
 *
 *   • `npm run dev` under Electron — the main process mints the token, gives it
 *     to Python via env and to the renderer via IPC. The renderer sends its own
 *     `X-Api-Token`, which passes through this proxy untouched. No file needed.
 *   • Backend started by hand + a plain browser tab on :5173 — nobody handed the
 *     browser a token, so the proxy supplies it. A standalone backend writes the
 *     secret to `app/.api_token` for exactly this case
 *     (see `api_auth.token_file_path`).
 *
 * Read lazily per request rather than once at config load: the file appears when
 * the backend starts, which is often after Vite.
 */
function devBackendPort(): number {
  const fromEnv = parseInt(process.env.OVOLVE_SERVER_PORT || '', 10)
  if (fromEnv > 0) return fromEnv

  const vitePort = parseInt(process.env.VITE_DEV_PORT || '', 10)
  if (vitePort > 0) {
    try {
      const perInstance = path.resolve(__dirname, `../.dev_ports.${vitePort}.json`)
      if (fs.existsSync(perInstance)) {
        const j = JSON.parse(fs.readFileSync(perInstance, 'utf-8'))
        if (j.backend > 0) return j.backend
      }
    } catch { /* ignore */ }
  }

  // Legacy shared files — last writer wins when multiple apps run; prefer env above.
  try {
    const p = parseInt(fs.readFileSync(path.resolve(__dirname, '../.backend_port'), 'utf-8').trim(), 10)
    if (p > 0) return p
  } catch { /* ignore */ }
  try {
    const devPorts = path.resolve(__dirname, '../.dev_ports.json')
    if (fs.existsSync(devPorts)) {
      const j = JSON.parse(fs.readFileSync(devPorts, 'utf-8'))
      if (j.backend > 0) return j.backend
    }
  } catch { /* ignore */ }
  return 8765
}

function devVitePort(): number {
  if (process.env.VITE_DEV_PORT) {
    const p = parseInt(process.env.VITE_DEV_PORT, 10)
    if (p > 0) return p
  }
  try {
    const devPorts = path.resolve(__dirname, '../.dev_ports.json')
    if (fs.existsSync(devPorts)) {
      const j = JSON.parse(fs.readFileSync(devPorts, 'utf-8'))
      if (j.vite > 0) return j.vite
    }
  } catch { /* ignore */ }
  return 5174
}

const backendTarget = () => `http://127.0.0.1:${devBackendPort()}`

function devApiToken(): string {
  try {
    return fs.readFileSync(path.resolve(__dirname, '../.api_token'), 'utf-8').trim()
  } catch {
    return ''
  }
}

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@lib': path.resolve(__dirname, './src/lib'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@store': path.resolve(__dirname, './src/store'),
      '@pages': path.resolve(__dirname, './src/pages'),
      '@apptypes': path.resolve(__dirname, './src/types'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: devVitePort(),
    strictPort: true,
    proxy: {
      '/api': {
        target: backendTarget(),
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            ;(proxy as any).options.target = backendTarget()
            if (proxyReq.getHeader('X-Api-Token')) return
            const t = devApiToken()
            if (t) proxyReq.setHeader('X-Api-Token', t)
          })
        },
      },
      '/ws': {
        target: backendTarget().replace('http', 'ws'),
        ws: true,
        configure: (proxy) => {
          proxy.on('proxyReqWs', (proxyReq) => {
            ;(proxy as any).options.target = backendTarget().replace('http', 'ws')
            if (proxyReq.getHeader('X-Api-Token')) return
            const t = devApiToken()
            if (t) proxyReq.setHeader('X-Api-Token', t)
          })
        },
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 2800,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            if (id.includes('gpt-tokenizer')) {
              if (id.includes('o200k')) return 'vendor-tokenizer-o200k'
              return 'vendor-tokenizer-cl100k'
            }
            if (id.includes('mermaid')) {
              return 'vendor-mermaid'
            }
            if (id.includes('cytoscape') || id.includes('cose-bilkent') || id.includes('layout-base')) {
              return 'vendor-cytoscape'
            }
            if (id.includes('@radix-ui') || id.includes('@dnd-kit') || id.includes('cmdk')) {
              return 'vendor-ui'
            }
            if (id.includes('react-markdown') || id.includes('remark-gfm') || id.includes('micromark') || id.includes('unist') || id.includes('vfile') || id.includes('katex') || id.includes('rehype-katex') || id.includes('remark-math') || id.includes('highlight.js') || id.includes('rehype-highlight')) {
              return 'vendor-markdown'
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons'
            }
            if (id.includes('framer-motion')) {
              return 'vendor-motion'
            }
            if (id.includes('react') || id.includes('zustand') || id.includes('i18next')) {
              return 'vendor-core'
            }
          }
        },
      },
    },
  },
})
