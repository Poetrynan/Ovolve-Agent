// Ovolve Electron — local API token
// ------------------------------------------------------------------
// One secret per app launch for the Python HTTP/WS server on :8765.
//
// It lives in its own module because three places need the *same* value and a
// second `randomBytes` call would produce a token that authenticates nothing:
//   • main.ts — injects it into the Python child's environment, and answers the
//     renderer's `app:getApiToken` IPC.
//   • ipc/modelHandlers.ts — main-process POST to /api/models/providers (main is
//     the only process holding plaintext API keys, so it must call the backend
//     itself).
//   • the renderer, via IPC.
//
// Loopback keeps the API off the network; this token is what keeps it away from
// other processes on the same machine. Deliberately mirrors the 8766 control
// bridge's token so there is one pattern, not two.
// ------------------------------------------------------------------
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

/** Generated once, at module load, before the backend is spawned. */
export const API_TOKEN = crypto.randomBytes(32).toString('hex')

// In dev mode, write to app/.api_token so Vite proxy picks up the same secret
try {
  const tokenPath = path.resolve(__dirname, '../../.api_token')
  fs.writeFileSync(tokenPath, API_TOKEN, 'utf-8')
} catch (_) {}

/** Header name the backend checks (see backend/api_auth.TOKEN_HEADER). */
export const API_TOKEN_HEADER = 'X-Api-Token'

/** Ready-made header object for main-process calls into the backend. */
export function apiTokenHeaders(): Record<string, string> {
  return { [API_TOKEN_HEADER]: API_TOKEN }
}
