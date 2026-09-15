// Offline fallback when /api/models/resolve is unreachable.
// Composer reads backend resolve first; this is not the primary capability gate.
import type { ModelDef } from '@store/modelStore'

export interface ReasoningToggle {
  enabled: boolean
  variants: string[]
  defaultVariant: string
}

export const REASONING_TOGGLE: ReasoningToggle = {
  enabled: true,
  variants: ['off', 'low', 'high', 'max'],
  defaultVariant: 'high',
}

const REASONING_ID_HINTS = [
  'longcat',
  'o1',
  'o3',
  'o4',
  'gpt-5',
  '-thinking',
  'reasoner',
  '-r1',
  'qwq',
  'reason',
] as const

function normalizeModelKey(modelId: string): string {
  let s = (modelId || '').trim().toLowerCase()
  if (s.includes(':')) s = s.split(':').pop() ?? s
  if (s.includes('/')) s = s.split('/').pop() ?? s
  return s
}

export function looksLikeReasoningModel(modelId: string): boolean {
  const key = normalizeModelKey(modelId)
  return REASONING_ID_HINTS.some((h) => key.includes(h))
}

export function resolveReasoningToggle(
  model: ModelDef | undefined,
  modelId: string,
): ReasoningToggle | null {
  if (!model && !modelId) return null
  if (model?.reasoning?.enabled) {
    return {
      enabled: true,
      variants: model.reasoning.variants?.length ? model.reasoning.variants : REASONING_TOGGLE.variants,
      defaultVariant: model.reasoning.defaultVariant || REASONING_TOGGLE.defaultVariant,
    }
  }
  if (model?.capability?.supportsThinking === true) return REASONING_TOGGLE
  if (model?.capability?.supportsThinking === false) return null
  if (looksLikeReasoningModel(modelId)) return REASONING_TOGGLE
  return null
}
