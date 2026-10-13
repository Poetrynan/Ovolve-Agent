import { writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../dist-electron')
const publicDir = path.resolve(__dirname, '../public')

mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2))

// Copy icons directly into dist-electron so main.js can always load them locally
for (const icon of ['icon.ico', 'icon.png', 'splash-icon.ico', 'splash-icon.png']) {
  const src = path.join(publicDir, icon)
  if (existsSync(src)) {
    copyFileSync(src, path.join(outDir, icon))
  }
}

console.log('[postbuild] wrote dist-electron/package.json & copied icon assets')

