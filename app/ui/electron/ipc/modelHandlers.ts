// electron/ipc/modelHandlers.ts
// Model provider registry. Persisted at configRoot/providers.json.
//
// SECURITY: API keys are encrypted at rest with Electron safeStorage (OS
// keychain — Keychain on macOS, DPAPI on Windows, libsecret on Linux) before
// they touch disk. See `encryptKey`/`decryptKey`. Files written by older builds
// stored the key in plaintext; those are read transparently and re-encrypted on
// the next save, so no migration step is needed.
import { ipcMain, safeStorage } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import { apiTokenHeaders } from '../apiToken'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import type { IPCContext } from './index'
import { DEFAULT_PROVIDER_CATALOG } from './modelCatalog'
import { backendBaseUrl } from '../serverPorts'

function providersFile(root: string) {
  return path.join(root, 'providers.json')
}

// Marks a value as safeStorage ciphertext (base64). The prefix is how we tell an
// encrypted key from a legacy plaintext one when reading a file back.
const ENC_PREFIX = 'enc:v1:'

/**
 * Encrypt an API key for disk. Returns the value unchanged when it is empty,
 * already encrypted, or when the OS keychain is unavailable (headless Linux,
 * locked keychain) — degrading to plaintext rather than throwing, so a save is
 * never lost. The `enc:v1:` prefix lets `decryptKey` round-trip it.
 */
function encryptKey(key: string): string {
  if (!key || key.startsWith(ENC_PREFIX)) return key
  try {
    if (!safeStorage.isEncryptionAvailable()) return key
    const buf = safeStorage.encryptString(key)
    return ENC_PREFIX + buf.toString('base64')
  } catch (e: any) {
    console.warn('[model] key encryption failed, storing plaintext:', e?.message)
    return key
  }
}

/**
 * Decrypt a stored API key. A value without the `enc:v1:` prefix is a legacy
 * plaintext key and is returned verbatim. Decryption failure (keychain moved to
 * another machine, corrupted blob) yields '' rather than a throw, so one bad
 * entry can't take down the whole provider load.
 */
function decryptKey(stored: string): string {
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored || ''
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
    return safeStorage.decryptString(buf)
  } catch (e: any) {
    console.warn('[model] key decryption failed, treating as unset:', e?.message)
    return ''
  }
}

/**
 * Model ids that an older build seeded as placeholders and that must never come
 * back. `custom-model` was a fake entry auto-added to the 自定义/中转站 provider
 * so its model list wouldn't be empty; it carried `priority: 10`, while a model
 * the user types in has no priority at all.
 *
 * That combination is poisonous. `enabledModels()` sorts by priority, so the
 * fossil out-ranked the real model the user configured, `reconcileActiveModel`
 * pointed the session at `custom:custom-model`, the Settings field re-seeded
 * itself from that active model (so the typed name appeared to be "eaten"), and
 * every request went out asking the proxy for a model called `custom-model` —
 * which no proxy has, so it 404'd and kicked off the fallback chain.
 *
 * The placeholder is gone from the preset catalogue, but installs that ran the
 * old build still have it written into providers.json, where the merge below
 * would faithfully preserve it forever. So it gets dropped on load: one-way, and
 * safe because the name was ours, never a real model at any provider.
 */
const DEAD_PLACEHOLDER_MODELS = new Set(['custom-model'])

async function loadProviders(root: string): Promise<Record<string, any>> {
  const file = providersFile(root)
  let saved: Record<string, any> = {}
  if (fsSync.existsSync(file)) {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf-8'))
      saved = raw?.provider ? raw.provider : raw
    } catch (e) {
      console.warn('[model] providers.json parse failed, using defaults:', e)
    }
  }

  /** Saved model map minus any placeholder an older build left behind. */
  const cleanModels = (models: any): Record<string, any> => {
    const out: Record<string, any> = {}
    for (const [mid, def] of Object.entries(models || {})) {
      if (DEAD_PLACEHOLDER_MODELS.has(mid)) {
        console.warn(`[model] dropping dead placeholder model "${mid}"`)
        continue
      }
      out[mid] = def
    }
    return out
  }

  // Always start with the full default catalog so all presets are present
  const merged: Record<string, any> = JSON.parse(JSON.stringify(DEFAULT_PROVIDER_CATALOG))
  for (const [id, savedP] of Object.entries(saved)) {
    const savedModels = cleanModels((savedP as any)?.models)
    if (merged[id]) {
      merged[id] = {
        ...merged[id],
        ...savedP,
        options: {
          ...merged[id].options,
          ...savedP.options,
        },
        models: {
          ...cleanModels(merged[id].models),
          ...savedModels,
        },
      }
    } else {
      merged[id] = { ...(savedP as any), models: savedModels }
    }
  }
  // Everything downstream (redact, syncToBackend, probe) expects plaintext keys
  // in memory. Decrypt here, once, so those call sites stay unchanged and a
  // legacy plaintext file keeps working (decryptKey passes it through).
  for (const p of Object.values(merged)) {
    const opts = (p as any)?.options
    if (opts && typeof opts.apiKey === 'string') {
      opts.apiKey = decryptKey(opts.apiKey)
    }
  }
  return merged
}

async function saveProviders(root: string, providers: Record<string, any>) {
  await fs.mkdir(root, { recursive: true })
  // Encrypt keys on a deep copy so the caller keeps its plaintext in-memory copy
  // (syncToBackend runs right after a save and needs the real key).
  const onDisk: Record<string, any> = JSON.parse(JSON.stringify(providers))
  for (const p of Object.values(onDisk)) {
    const opts = (p as any)?.options
    if (opts && typeof opts.apiKey === 'string') {
      opts.apiKey = encryptKey(opts.apiKey)
    }
  }
  await fs.writeFile(providersFile(root), JSON.stringify({ provider: onDisk }, null, 2), 'utf-8')
}

/** Redact API keys before handing the catalog to the renderer. */
function redact(providers: Record<string, any>) {
  const out: Record<string, any> = {}
  for (const [id, p] of Object.entries(providers)) {
    const key = p?.options?.apiKey ?? ''
    out[id] = {
      ...p,
      options: {
        ...p.options,
        apiKey: key ? `${'•'.repeat(Math.min(key.length, 20))}` : '',
        hasApiKey: !!key,
        // A 4-character fingerprint so the settings form can prove WHICH key is
        // stored instead of showing an empty box that looks like a failed save.
        // Industry-standard disclosure level; the remaining characters never
        // leave the main process.
        apiKeyLast4: key.length >= 8 ? key.slice(-4) : undefined,
      },
    }
  }
  return out
}

/** HEAD/GET the provider base URL to check reachability + auth. */
function probe(baseURL: string, apiKey: string, kind: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    let target: URL
    try {
      // Anthropic-style and OpenAI-compatible both expose a models list.
      const suffix = kind === 'anthropic' ? '/v1/models' : '/models'
      target = new URL(baseURL.replace(/\/+$/, '') + suffix)
    } catch (e: any) {
      resolve({ ok: false, error: `invalid baseURL: ${e.message}` })
      return
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) {
      if (kind === 'anthropic') {
        headers['x-api-key'] = apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
    }

    const lib = target.protocol === 'https:' ? https : http
    const req = lib.request(target, { method: 'GET', headers, timeout: 8000 }, (res) => {
      res.resume()
      const status = res.statusCode ?? 0
      resolve({ ok: status >= 200 && status < 400, status })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, error: 'timeout after 8s' })
    })
    req.on('error', (err) => resolve({ ok: false, error: err.message }))
    req.end()
  })
}


/**
 * Push the catalogue — WITH real keys — into the Python registry.
 *
 * The renderer only ever sees redacted keys, so it cannot do this sync itself;
 * main is the only process holding both the plaintext keys and a route to the
 * backend. Until this existed, providers.json was invisible to Python and a
 * model picked in the UI could not be resolved, let alone called.
 *
 * `prune` makes the payload authoritative so a deleted provider disappears
 * backend-side too. Fire-and-forget on purpose: the backend may still be
 * booting, and a failed sync must never block a settings save — the next
 * listProviders re-syncs.
 */
function syncToBackend(providers: Record<string, any>) {
  const payload: Record<string, any> = {}
  for (const [id, p] of Object.entries(providers)) {
    payload[id] = {
      name: p?.name ?? id,
      kind: p?.kind ?? 'openai-compatible',
      apiKey: p?.options?.apiKey ?? '',
      baseURL: p?.options?.baseURL ?? '',
      enabled: p?.enabled !== false,
      models: p?.models ?? {},
    }
  }
  const body = Buffer.from(JSON.stringify({ providers: payload, prune: true }), 'utf-8')
  try {
    const req = http.request(
      `${backendBaseUrl()}/api/models/providers`,
      {
        method: 'POST',
        // The backend rejects tokenless /api calls. Main holds the plaintext keys
        // and therefore has to make this call itself, so it authenticates like
        // any other client — without the header this sync silently 401s and the
        // Python registry stays empty, which looks exactly like "model not found".
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          ...apiTokenHeaders(),
        },
        timeout: 5000,
      },
      (res) => res.resume(),
    )
    req.on('timeout', () => req.destroy())
    req.on('error', (e) => console.warn('[model] backend sync failed:', e.message))
    req.end(body)
  } catch (e: any) {
    console.warn('[model] backend sync failed:', e?.message)
  }
}

export function registerModelHandlers(ctx: IPCContext) {
  ipcMain.handle('model:listProviders', async () => {
    const providers = await loadProviders(ctx.configRoot)
    // Re-sync on every read: this is also the app-startup path, so a backend
    // that restarted independently gets its registry refilled.
    syncToBackend(providers)
    return redact(providers)
  })

  ipcMain.handle('model:saveProvider', async (_e, id: string, patch: any) => {
    const providers = await loadProviders(ctx.configRoot)
    const existing = providers[id] ?? {}
    // An empty/masked apiKey means "keep the stored one".
    const incomingKey: string = patch?.options?.apiKey ?? ''
    const keepKey = !incomingKey || /^[•]+$/.test(incomingKey)
    providers[id] = {
      ...existing,
      ...patch,
      options: {
        ...existing.options,
        ...patch.options,
        apiKey: keepKey ? existing?.options?.apiKey ?? '' : incomingKey,
      },
    }
    await saveProviders(ctx.configRoot, providers)
    syncToBackend(providers)
    return { ok: true, providers: redact(providers) }
  })

  ipcMain.handle('model:deleteProvider', async (_e, id: string) => {
    const providers = await loadProviders(ctx.configRoot)
    delete providers[id]
    await saveProviders(ctx.configRoot, providers)
    syncToBackend(providers)
    return { ok: true, providers: redact(providers) }
  })

  ipcMain.handle('model:testConnection', async (_e, id: string) => {
    const providers = await loadProviders(ctx.configRoot)
    const p = providers[id]
    if (!p) return { ok: false, error: `unknown provider: ${id}` }
    return probe(p.options?.baseURL ?? '', p.options?.apiKey ?? '', p.kind ?? 'openai-compatible')
  })

  /**
   * Hand the renderer ONE provider's full key, on demand.
   *
   * `model:listProviders` deliberately never ships plaintext keys — the bulk
   * catalogue stays redacted. This is the narrow, explicit escape hatch behind
   * the 👁 reveal button: the user asked to see the key they typed so they can
   * verify or copy it, which is the standard behaviour for a local desktop tool
   * (VS Code, Postman, DBeaver all allow it). Scoped to a single id per call and
   * never logged, so the key does not end up in a crash dump or console history.
   */
  ipcMain.handle('model:revealKey', async (_e, id: string) => {
    const providers = await loadProviders(ctx.configRoot)
    const p = providers[id]
    if (!p) return { ok: false, error: `unknown provider: ${id}` }
    return { ok: true, apiKey: p.options?.apiKey ?? '' }
  })

  ipcMain.handle('model:catalog', async () => DEFAULT_PROVIDER_CATALOG)

  ipcMain.handle('model:encryptionAvailable', async () => safeStorage.isEncryptionAvailable())
}
