/**
 * Build an Ovolve-branded electron.exe in node_modules/.cache for Windows dev.
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const iconPath = path.resolve(ROOT, 'public/icon.ico')
const cacheDir = path.resolve(ROOT, 'node_modules/.cache/ovolve-electron')
const outExe = path.join(cacheDir, 'Ovolve.exe')
const markerPath = path.join(cacheDir, 'patch.json')

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
}

function writeMarker(data) {
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.writeFileSync(markerPath, JSON.stringify(data), 'utf8')
}

async function main() {
  if (process.platform !== 'win32') {
    return outExe
  }

  if (!fs.existsSync(iconPath)) {
    console.warn('[patch-electron-icon] skip: missing', iconPath)
    return null
  }

  let electronExe
  try {
    electronExe = require('electron')
  } catch {
    console.warn('[patch-electron-icon] skip: electron not installed')
    return null
  }

  function ensureElectronDependencies(electronDir, targetDir) {
    const items = fs.readdirSync(electronDir)
    for (const item of items) {
      if (item.toLowerCase() === 'electron.exe') continue
      const src = path.join(electronDir, item)
      const dst = path.join(targetDir, item)
      if (fs.existsSync(dst)) continue
      try {
        const st = fs.statSync(src)
        if (st.isDirectory()) {
          try {
            fs.symlinkSync(src, dst, 'junction')
          } catch {
            fs.cpSync(src, dst, { recursive: true })
          }
        } else {
          try {
            fs.linkSync(src, dst)
          } catch {
            fs.copyFileSync(src, dst)
          }
        }
      } catch (e) {
        console.warn(`[patch-electron-icon] dependency sync skipped for ${item}:`, e?.message)
      }
    }
  }

  const iconMtime = fs.statSync(iconPath).mtimeMs
  const srcMtime = fs.statSync(electronExe).mtimeMs
  const electronDir = path.dirname(electronExe)
  const marker = readMarker()

  if (
    marker &&
    marker.src === electronExe &&
    marker.iconMtime === iconMtime &&
    marker.srcMtime === srcMtime &&
    fs.existsSync(outExe) &&
    fs.existsSync(path.join(cacheDir, 'icudtl.dat'))
  ) {
    return outExe
  }

  const iconCopy = path.join(cacheDir, 'ovolve-app-icon.ico')
  fs.mkdirSync(cacheDir, { recursive: true })
  ensureElectronDependencies(electronDir, cacheDir)
  fs.copyFileSync(iconPath, iconCopy)
  fs.copyFileSync(electronExe, outExe)

  async function loadRcedit() {
    const candidates = [
      path.join(ROOT, 'node_modules/rcedit'),
      path.resolve(ROOT, '../../../Ovolve Agent/app/ui/node_modules/rcedit'),
    ]
    for (const mod of candidates) {
      try {
        return await import(pathToFileURL(path.join(mod, 'lib/index.js')).href)
      } catch { /* try next */ }
    }
    throw new Error('rcedit not installed (run pnpm install in app/ui)')
  }

  const { pathToFileURL } = require('url')
  const { rcedit } = await loadRcedit()
  await rcedit(outExe, {
    icon: iconCopy,
    'version-string': {
      ProductName: 'Ovolve',
      FileDescription: 'Ovolve Desktop Agent',
    },
  })

  writeMarker({ src: electronExe, iconMtime, srcMtime })
  console.log('[patch-electron-icon] built', outExe)
  return outExe
}

main()
  .then((exe) => {
    if (exe) process.stdout.write(exe)
  })
  .catch((e) => {
    console.warn('[patch-electron-icon] failed:', e?.message || e)
    process.exit(0)
  })
