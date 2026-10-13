// electron/ipc/modelHandlers.ts
// Model provider registry persisted at configRoot/providers.json.
// SECURITY: API keys are encrypted at rest with Electron safeStorage (DPAPI / Keychain).
import { ipcMain, safeStorage } from 'electron'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import type { IPCContext } from './index'
import { DEFAULT_PROVIDER_CATALOG } from './modelCatalog'

function providersFile(root: string) {
  return path.join(root, 'providers.json')
}

const ENC_PREFIX = 'enc:v1:'

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

  const cleanModels = (models: any): Record<string, any> => {
    const out: Record<string, any> = {}
    for (const [mid, def] of Object.entries(models || {})) {
      if (DEAD_PLACEHOLDER_MODELS.has(mid)) continue
      out[mid] = def
    }
    return out
  }

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
  const onDisk: Record<string, any> = JSON.parse(JSON.stringify(providers))
  for (const p of Object.values(onDisk)) {
    const opts = (p as any)?.options
    if (opts && typeof opts.apiKey === 'string') {
      opts.apiKey = encryptKey(opts.apiKey)
    }
  }
  await fs.writeFile(providersFile(root), JSON.stringify({ provider: onDisk }, null, 2), 'utf-8')
}

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
        apiKeyLast4: key.length >= 8 ? key.slice(-4) : undefined,
      },
    }
  }
  return out
}

function probe(baseURL: string, apiKey: string, kind: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  return new Promise((resolve) => {
    let target: URL
    try {
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

export function registerModelHandlers(ctx: IPCContext) {
  ipcMain.handle('model:listProviders', async () => {
    const providers = await loadProviders(ctx.configRoot)
    return redact(providers)
  })

  ipcMain.handle('model:saveProvider', async (_e, id: string, patch: any) => {
    const providers = await loadProviders(ctx.configRoot)
    const existing = providers[id] ?? {}
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
    return { ok: true, providers: redact(providers) }
  })

  ipcMain.handle('model:deleteProvider', async (_e, id: string) => {
    const providers = await loadProviders(ctx.configRoot)
    delete providers[id]
    await saveProviders(ctx.configRoot, providers)
    return { ok: true, providers: redact(providers) }
  })

  ipcMain.handle('model:testConnection', async (_e, id: string) => {
    const providers = await loadProviders(ctx.configRoot)
    const p = providers[id]
    if (!p) return { ok: false, error: `unknown provider: ${id}` }
    return probe(p.options?.baseURL ?? '', p.options?.apiKey ?? '', p.kind ?? 'openai-compatible')
  })

  ipcMain.handle('model:revealKey', async (_e, id: string) => {
    const providers = await loadProviders(ctx.configRoot)
    const p = providers[id]
    if (!p) return { ok: false, error: `unknown provider: ${id}` }
    return { ok: true, apiKey: p.options?.apiKey ?? '' }
  })

  ipcMain.handle('model:catalog', async () => DEFAULT_PROVIDER_CATALOG)

  ipcMain.handle('model:encryptionAvailable', async () => safeStorage.isEncryptionAvailable())
}
