import fs from 'fs'
import path from 'path'
import { spawn, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uiRoot = path.resolve(__dirname, '..')
const portsPath = path.resolve(uiRoot, '../.dev_ports.json')

if (!fs.existsSync(portsPath)) {
  console.error('[dev] Missing .dev_ports.json — run allocate-dev-ports.mjs first')
  process.exit(1)
}

const ports = JSON.parse(fs.readFileSync(portsPath, 'utf-8'))
const pythonScriptPath = path.resolve(uiRoot, '../main.py')
const env = {
  ...process.env,
  OVOLVE_SERVER_PORT: String(ports.backend),
  OVOLVE_BRIDGE_PORT: String(ports.bridge),
  VITE_DEV_PORT: String(ports.vite),
  VITE_DEV_SERVER_URL: `http://127.0.0.1:${ports.vite}`,
  OVOLVE_PYTHON_PATH: pythonScriptPath,
  OVOLVE_DEV_MODE: '1',
}

function resolveElectronExe() {
  if (process.platform === 'win32') {
    try {
      const exe = execFileSync(process.execPath, ['./scripts/patch-electron-icon.cjs'], {
        cwd: uiRoot,
        encoding: 'utf8',
      }).trim()
      if (exe && fs.existsSync(exe)) return exe
    } catch (e) {
      console.warn('[dev] Ovolve icon patch skipped:', e?.message || e)
    }
  }
  return path.join(uiRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
}

const electronExe = resolveElectronExe()

const cmd =
  `concurrently --kill-others-on-fail ` +
  `"cross-env OVOLVE_SERVER_PORT=${ports.backend} VITE_DEV_PORT=${ports.vite} npm run dev:vite" ` +
  `"npm run build:electron:watch" ` +
  `"wait-on tcp:127.0.0.1:${ports.vite} && cross-env VITE_DEV_SERVER_URL=http://127.0.0.1:${ports.vite} OVOLVE_SERVER_PORT=${ports.backend} OVOLVE_BRIDGE_PORT=${ports.bridge} OVOLVE_DEV_MODE=1 node ./scripts/spawn-electron.mjs"`

const child = spawn(cmd, { cwd: uiRoot, env, stdio: 'inherit', shell: true })
child.on('exit', (code) => process.exit(code ?? 1))
