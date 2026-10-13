import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const API_TOKEN = crypto.randomBytes(32).toString('hex')
export const API_TOKEN_HEADER = 'X-Api-Token'

try {
  const tokenPath = path.resolve(__dirname, '../app/.api_token')
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  fs.writeFileSync(tokenPath, API_TOKEN, 'utf-8')
} catch (_) {}

export function apiTokenHeaders(): Record<string, string> {
  return { [API_TOKEN_HEADER]: API_TOKEN }
}
