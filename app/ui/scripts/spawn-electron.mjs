import { spawn, execFileSync } from 'child_process'
import { createRequire } from 'module'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const uiRoot = path.resolve(__dirname, '..')

function resolveElectronExe() {
  if (process.platform === 'win32') {
    try {
      const exe = execFileSync(process.execPath, ['./scripts/patch-electron-icon.cjs'], {
        cwd: uiRoot,
        encoding: 'utf8',
      }).trim()
      if (exe && fs.existsSync(exe)) return exe
    } catch { /* fallback */ }
  }
  try {
    return require('electron')
  } catch {
    return path.join(uiRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
  }
}

const exe = resolveElectronExe()

let nativeElectron
try {
  nativeElectron = require('electron')
} catch {
  nativeElectron = path.join(uiRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
}

function spawnElectron(targetExe, isFallback = false) {
  console.log('[electron-launch] starting', targetExe, isFallback ? '(native fallback)' : '')
  const child = spawn(targetExe, ['.'], {
    cwd: uiRoot,
    env: {
      ...process.env,
      OVOLVE_PYTHON_PATH: process.env.OVOLVE_PYTHON_PATH || path.resolve(uiRoot, '../main.py'),
      OVOLVE_DEV_MODE: '1',
    },
    stdio: 'inherit',
    windowsHide: false,
  })

  const startTime = Date.now()
  child.on('error', (err) => {
    console.error('[electron-launch] spawn error:', err.message)
    if (!isFallback && targetExe !== nativeElectron) {
      console.warn('[electron-launch] falling back to native electron...')
      spawnElectron(nativeElectron, true)
    }
  })
  child.on('exit', (code) => {
    if (!isFallback && targetExe !== nativeElectron && code !== 0 && (Date.now() - startTime < 3500)) {
      console.warn('[electron-launch] patched electron crashed on boot, falling back to native electron...')
      spawnElectron(nativeElectron, true)
    } else {
      process.exit(code ?? 0)
    }
  })
  return child
}

spawnElectron(exe)
