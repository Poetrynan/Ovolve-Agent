import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const root = path.resolve(__dirname, '..')

async function runBuild() {
  console.log('[OvolveAgent] Building Electron main and preload processes...')
  
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

  // Also sync to app/ui/dist-electron for UI-cwd launch
  const uiDistElectron = path.join(root, 'app/ui/dist-electron')
  try {
    const fs = await import('node:fs')
    fs.mkdirSync(uiDistElectron, { recursive: true })
    fs.copyFileSync(path.join(root, 'dist-electron/main.js'), path.join(uiDistElectron, 'main.js'))
    fs.copyFileSync(path.join(root, 'dist-electron/preload.js'), path.join(uiDistElectron, 'preload.js'))
  } catch (_) {}

  console.log('[OvolveAgent] Electron build complete.')
}

runBuild().catch((err) => {
  console.error(err)
  process.exit(1)
})
