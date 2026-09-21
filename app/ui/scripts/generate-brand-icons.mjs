/**
 * Regenerate public/icon.ico from ovolve-icon.svg (square, Ovolve-branded).
 * Run after changing ovolve-icon.svg:
 *   pnpm dlx sharp-cli -i public/ovolve-icon.svg -o public/icon-square.png resize 256 256
 *   pnpm dlx png-to-ico public/icon-square.png -o public/icon.ico
 */
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const square = path.join(root, 'public/icon-square.png')
const ico = path.join(root, 'public/icon.ico')
const svg = path.join(root, 'public/ovolve-icon.svg')

if (!fs.existsSync(svg)) {
  console.error('missing public/ovolve-icon.svg')
  process.exit(1)
}

execFileSync('pnpm', ['dlx', 'sharp-cli', '-i', svg, '-o', square, 'resize', '256', '256'], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
})
execFileSync('pnpm', ['dlx', 'png-to-ico', square, '-o', ico], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
})
fs.copyFileSync(ico, path.join(root, 'public/splash-icon.ico'))
console.log('[generate-brand-icons] wrote', ico)
