/**
 * Pick free Vite + backend/bridge ports before `dev:electron`.
 * Writes app/.dev_ports.json so Vite proxy and Electron agree on targets.
 *
 * Defaults: Vite 5174 (Ovolve uses 5173), backend 8765 — each steps forward
 * when the preferred port pair is already taken by another Electron app.
 */
import net from 'net'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(__dirname, '../..')
const outPath = path.join(appRoot, '.dev_ports.json')

function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

async function pickFrom(start, step = 1) {
  for (let p = start; p < start + 200; p += step) {
    if (await isFree(p)) return p
  }
  throw new Error(`No free port from ${start}`)
}

const vite = await pickFrom(Number(process.env.VITE_DEV_PORT) || 5174)
let backend = Number(process.env.OVOLVE_SERVER_PORT) || 8765
while (!(await isFree(backend)) || !(await isFree(backend + 1))) {
  backend += 2
}

const ports = { vite, backend, bridge: backend + 1 }
fs.writeFileSync(outPath, JSON.stringify(ports, null, 2), 'utf-8')
// Per-instance mapping so multiple Electron apps (Ovolve + Ovolve) never
// clobber each other's Vite → backend proxy target.
fs.writeFileSync(
  path.join(appRoot, `.dev_ports.${vite}.json`),
  JSON.stringify(ports, null, 2),
  'utf-8',
)
console.log(`[dev-ports] vite=${vite} backend=${backend} bridge=${ports.bridge}`)
