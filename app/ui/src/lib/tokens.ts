// src/lib/tokens.ts
// Real BPE token counting via gpt-tokenizer (OpenAI's tiktoken, pure-JS port).
//
// • OpenAI GPT-4 / 3.5 / Claude / DeepSeek / Qwen / GLM / Moonshot → cl100k_base
//   (exact for OpenAI; a real BPE tokenizer and a very close match for the
//    others, which all use cl100k-derived vocabularies)
// • GPT-4o / o1 / o3 / o4 family                                    → o200k_base
//
// This is genuine tokenization, not a char-count heuristic. If the encoder ever
// throws (unexpected input), we fall back to a coarse char estimate so the UI
// never crashes.
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base'
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base'

export type TokenizerId = 'cl100k_base' | 'o200k_base'

/** Pick the correct tiktoken encoding for a given model id. */
export function encodingFor(modelId?: string): TokenizerId {
  const m = (modelId ?? '').toLowerCase()
  if (/gpt-4o|gpt-4\.1|^o1|^o3|^o4|-o1|-o3|-o4|omni/.test(m)) return 'o200k_base'
  return 'cl100k_base'
}

/** Whether cl100k/o200k is the model's OWN tokenizer (→ exact count). */
export function isExactFor(modelId?: string, providerKind?: string): boolean {
  if (providerKind === 'openai-compatible') {
    const m = (modelId ?? '').toLowerCase()
    // Only the real OpenAI models are byte-exact under tiktoken.
    return /gpt-|^o1|^o3|^o4|davinci|turbo/.test(m)
  }
  return false
}

// Characters counted 1 token each. Kept byte-for-byte in sync with
// `_WIDE_RE` in app/backend/token_estimate.py — the two ranges used to differ
// (this file weighted CJK at 0.6, the backend at 0.56 in one place and 1.0 in
// another), so the same conversation produced up to 1.8x different numbers
// depending on which side of the wire you asked.
const WIDE_CHAR =
  /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/

// Only reached if the BPE encoder throws. Matches the backend's canonical
// heuristic (1 token per wide char, 4 chars per token otherwise) so a fallback
// never silently disagrees with the server's own accounting.
function coarseFallback(text: string): number {
  let wide = 0
  for (const ch of text) if (WIDE_CHAR.test(ch)) wide++
  return wide + Math.ceil((text.length - wide) / 4)
}

/** Count tokens in text with the given (or default cl100k) encoding. */
export function countTokens(text: string, encoding: TokenizerId = 'cl100k_base'): number {
  if (!text) return 0
  try {
    return encoding === 'o200k_base' ? encodeO200k(text).length : encodeCl100k(text).length
  } catch {
    return coarseFallback(text)
  }
}

/** Convenience: count tokens for an arbitrary value (objects → JSON). */
export function countTokensOf(value: unknown, encoding: TokenizerId = 'cl100k_base'): number {
  if (value == null) return 0
  if (typeof value === 'string') return countTokens(value, encoding)
  try {
    return countTokens(JSON.stringify(value), encoding)
  } catch {
    return countTokens(String(value), encoding)
  }
}

// Back-compat aliases (old call sites used estimate*). These now do REAL BPE
// counting under the hood, not estimation.
export const estimateTokens = (text: string) => countTokens(text)
export const estimateTokensOf = (value: unknown) => countTokensOf(value)
