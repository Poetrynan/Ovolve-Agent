import net from 'net'
import fs from 'fs'
import path from 'path'

export interface ServerPorts {
  backend: number
  bridge: number
}

function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => {
      srv.close(() => resolve(true))
    })
    srv.listen(port, host)
  })
}

/** Pick the first consecutive free pair: backend on P, bridge on P+1. */
export async function pickServerPorts(preferredBackend = 8765): Promise<ServerPorts> {
  const envBackend = parseInt(process.env.OVOLVE_SERVER_PORT || '', 10)
  const envBridge = parseInt(process.env.OVOLVE_BRIDGE_PORT || '', 10)
  if (envBackend > 0 && envBridge > 0) {
    return { backend: envBackend, bridge: envBridge }
  }
  if (envBackend > 0) {
    return { backend: envBackend, bridge: envBackend + 1 }
  }

  for (let p = preferredBackend; p < 9000; p += 2) {
    if ((await isPortFree(p)) && (await isPortFree(p + 1))) {
      return { backend: p, bridge: p + 1 }
    }
  }
  throw new Error('No free localhost port pair for backend/bridge (8765–8999)')
}

/** Persist backend port for the Vite dev proxy (read lazily in vite.config.ts). */
export function writeDevBackendPort(backendPort: number, vitePort?: number): void {
  try {
    const appRoot = path.resolve(__dirname, '../..')
    fs.writeFileSync(path.join(appRoot, '.backend_port'), String(backendPort), 'utf-8')
    if (vitePort && vitePort > 0) {
      fs.writeFileSync(
        path.join(appRoot, `.dev_ports.${vitePort}.json`),
        JSON.stringify({ vite: vitePort, backend: backendPort, bridge: backendPort + 1 }, null, 2),
        'utf-8',
      )
    }
  } catch {
    /* dev-only convenience file */
  }
}

export function getBackendPort(): number {
  const fromEnv = parseInt(process.env.OVOLVE_SERVER_PORT || '', 10)
  return fromEnv > 0 ? fromEnv : 8765
}

export function backendBaseUrl(): string {
  return `http://127.0.0.1:${getBackendPort()}`
}
