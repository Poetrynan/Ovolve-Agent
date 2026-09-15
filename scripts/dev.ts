import { createServer } from 'vite'
import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as string

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

let electronProcess: ChildProcess | null = null

async function start() {
  // 1. Build electron main & preload
  await build({
    entryPoints: [path.join(root, 'electron/main.ts')],
    outfile: path.join(root, 'dist-electron/main.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: ['electron', 'tree-kill'],
    sourcemap: true,
  })

  await build({
    entryPoints: [path.join(root, 'electron/preload.ts')],
    outfile: path.join(root, 'dist-electron/preload.js'),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    sourcemap: true,
  })

  // 2. Start Vite server (root = app/ui, port 5174 to avoid Ovolve conflict)
  const uiDir = path.join(root, 'app', 'ui')
  const server = await createServer({
    root: uiDir,
    configFile: path.join(root, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 5174 },
  })
  await server.listen()
  console.log('[OvolveAgent] Vite dev server running at http://localhost:5174')

  const devServerUrl = 'http://localhost:5174'

  // 3. Launch Electron (cwd = app/ui so package.json main resolves correctly)
  electronProcess = spawn(electronPath, ['.'], {
    cwd: uiDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VITE_DEV_SERVER_URL: devServerUrl,
    },
  })

  electronProcess.on('close', () => {
    server.close()
    process.exit()
  })
}

start().catch((err) => {
  console.error(err)
  process.exit(1)
})
