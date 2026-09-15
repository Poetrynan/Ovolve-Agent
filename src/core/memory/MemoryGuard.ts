/**
 * MemoryGuard.ts — Security & Hygiene Gate for Memory Storage
 *
 * Implements MemoryGuard specifications:
 * 1. Secret pattern detection (API keys, tokens, Bearer, passwords) -> rejected entirely.
 * 2. Invisible / directional Unicode stripping (U+200B-200F, U+202A-202E, U+2060-206F, U+FEFF).
 * 3. Prompt injection detection -> rejected entirely.
 * 4. Ephemeral noise filtering (temp directories, PID/port/elapsed time numbers, naked hashes).
 * 5. Speculation filtering (uncertain claims rejected unless attributed to user).
 * 6. Sensitivity classification (public, personal, internal).
 */

export const MAX_MEMORY_CONTENT_CHARS = 8000

// Secret and token patterns
export const SECRET_RE = new RegExp(
  '\\b(?:api[-_]?key|secret|token|password|passwd|pwd|credential|' +
    'auth(?:orization)?|access[-_]?key|private[-_]?key|session[-_]?id|cookie)\\b' +
    '\\s*[:=]\\s*\\S+' +
    '|\\bbearer\\s+[A-Za-z0-9._\\-]+' +
    '|\\b(?:sk|pk|rk)-[A-Za-z0-9_\\-]{8,}' +
    '|\\bgh[pousr]_[A-Za-z0-9]{16,}' +
    '|\\bxox[baprs]-[A-Za-z0-9\\-]{8,}' +
    '|\\bAIza[A-Za-z0-9_\\-]{16,}',
  'i'
)

// Zero-width and directional control characters
export const HIDDEN_UNICODE_RE = /[\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2060\u2061\u2062\u2063\u2064\u206a\u206b\u206c\u206d\u206e\u206f\ufeff]/g

// Prompt injection patterns
export const INJECTION_RE = new RegExp(
  '忽略(?:之前|上面|以上|前面)(?:所有)?(?:的)?(?:指令|要求|规则|提示)' +
    '|无视(?:之前|上面|以上)(?:所有)?(?:的)?(?:指令|规则)' +
    '|你(?:现在|从现在起|从此)(?:是|扮演|变成)' +
    '|从现在(?:开始|起)(?:你|请你)' +
    '|ignore\\s+(?:all\\s+)?(?:the\\s+)?(?:previous|prior|above|preceding)\\s+(?:instructions?|prompts?|rules?|directions?)' +
    '|disregard\\s+(?:all\\s+)?(?:the\\s+)?(?:previous|prior|above)\\s+' +
    '|you\\s+are\\s+now\\s+(?:a|an|the)\\b' +
    '|new\\s+(?:system\\s+)?instructions?\\s*:' +
    '|^\\s*(?:system|assistant|developer)\\s*:',
  'im'
)

// Ephemeral content patterns
export const EPHEMERAL_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  {
    regex: /(?:[A-Za-z]:\\|\/)(?:[^\s]*\\)?(?:Temp|tmp|Temporary)\\|\/tmp\/|\/var\/folders\//i,
    label: '临时路径',
  },
  {
    regex: /\b(?:pid|端口|port|耗时|elapsed|took|行号|line)\s*[:=]?\s*\d+\b/i,
    label: '瞬时数字',
  },
  {
    regex: /^\s*[0-9a-f]{7,40}\s*$/i,
    label: '裸 hash',
  },
]

// Model speculation patterns
export const SPECULATION_RE = new RegExp(
  '可能是|大概是|应该是|似乎|好像|我猜|估计是|不确定|也许' +
    '|\\b(?:probably|maybe|perhaps|might\\s+be|i\\s+(?:think|guess|assume)|seems?\\s+(?:to\\s+be|like)|not\\s+sure|presumably)\\b',
  'i'
)

// User attribution patterns (allows uncertainty if user stated it)
export const ATTRIBUTION_RE = new RegExp(
  '用户(?:说|表示|确认|要求|指出|强调)|user\\s+(?:said|confirmed|stated|asked|wants)',
  'i'
)

// Sensitivity classification patterns
export const PERSONAL_RE = new RegExp(
  '\\b\\d{3}-?\\d{4}-?\\d{4}\\b' + // Card/ID pattern
    '|\\b1[3-9]\\d{9}\\b' + // Mobile phone
    '|[\\w.+-]+@[\\w-]+\\.[\\w.]+' + // Email
    '|身份证|护照|家庭住址|银行卡',
  'i'
)

export const INTERNAL_RE = new RegExp(
  '\\b(?:10|127)\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b' +
    '|\\b192\\.168\\.\\d{1,3}\\.\\d{1,3}\\b' +
    '|\\b172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}\\b' +
    '|\\b\\w+\\.(?:internal|intranet|local|corp|lan)\\b' +
    '|内网|内部系统|仅限内部',
  'i'
)

export type SensitivityLevel = 'public' | 'personal' | 'internal'

export interface Screening {
  allowed: boolean
  content: string
  reasons: string[]
  sensitivity: SensitivityLevel
}

export function classifySensitivity(text: string): SensitivityLevel {
  const t = String(text || '')
  if (PERSONAL_RE.test(t)) {
    return 'personal'
  }
  if (INTERNAL_RE.test(t)) {
    return 'internal'
  }
  return 'public'
}

export function screenMemoryContent(
  content: string,
  options: { trusted?: boolean } = {}
): Screening {
  const text = String(content || '')
  const reasons: string[] = []
  const trusted = !!options.trusted

  if (SECRET_RE.test(text)) {
    return {
      allowed: false,
      content: '',
      reasons: ['secret-like pattern rejected (not truncated)'],
      sensitivity: 'public',
    }
  }

  if (INJECTION_RE.test(text)) {
    return {
      allowed: false,
      content: '',
      reasons: ['prompt-injection shape rejected'],
      sensitivity: 'public',
    }
  }

  let cleaned = text.replace(HIDDEN_UNICODE_RE, '')
  const stripped = text.length - cleaned.length
  if (stripped > 0) {
    reasons.push(`stripped ${stripped} hidden-unicode char(s)`)
  }

  if (cleaned.length > MAX_MEMORY_CONTENT_CHARS) {
    cleaned = cleaned.slice(0, MAX_MEMORY_CONTENT_CHARS)
    reasons.push(`truncated to ${MAX_MEMORY_CONTENT_CHARS} chars`)
  }

  if (!cleaned.trim()) {
    return {
      allowed: false,
      content: '',
      reasons: [...reasons, 'empty after cleaning'],
      sensitivity: 'public',
    }
  }

  if (!trusted) {
    for (const { regex, label } of EPHEMERAL_PATTERNS) {
      if (regex.test(cleaned)) {
        return {
          allowed: false,
          content: '',
          reasons: [...reasons, `ephemeral content rejected: ${label}`],
          sensitivity: 'public',
        }
      }
    }

    if (SPECULATION_RE.test(cleaned) && !ATTRIBUTION_RE.test(cleaned)) {
      return {
        allowed: false,
        content: '',
        reasons: [...reasons, 'speculation rejected (no attribution)'],
        sensitivity: 'public',
      }
    }
  }

  return {
    allowed: true,
    content: cleaned,
    reasons,
    sensitivity: classifySensitivity(cleaned),
  }
}

export function guardMemoryContent(content: string): [boolean, string, string[]] {
  const result = screenMemoryContent(content, { trusted: true })
  return [result.allowed, result.content, result.reasons]
}
