// src/store/sessionConfigStore.ts
// ONE axis for "how much rope does the agent get this turn": Permission.
//
// There used to be a second `Mode` axis (Ask/Plan/Edit/Agent) on top of it, so
// the composer carried two dropdowns and 12 combinations. But this product IS an
// agent — "should it behave like an agent" is not a question worth asking every
// turn. Plan was the only mode carrying real intent (produce a plan, then stop),
// so it became a permission level; the rest collapsed into `auto`.
//
// PERSISTED. These fields are the user's standing preferences, not per-turn
// scratch state — the `session` in the name is historical. Losing the model
// choice on every restart was a real papercut: you'd set gpt-4o once and be back
// at "选择模型" the next morning.
//
// The dangerous half of persisting `activeModel` is that it's a plain string
// ("providerId:modelId"), NOT a foreign key. If the referenced provider or
// model disappears — user deletes it, or a future release drops a preset — a
// naive restore points the composer at a model the backend can't resolve, and
// the first message of the session fails. `reconcileActiveModel` below is the
// integrity check that prevents that.
import { create } from 'zustand'
import { useModelStore } from '@store/modelStore'

/**
 * Permission mode — the only per-turn axis.
 *
 * Mirrors `risk_control.PermissionMode` value-for-value. That module owns
 * authorization on the backend, so it owns the vocabulary here too; the old
 * `ask`/`yolo` spellings came from a second enum that no longer exists.
 * `plan` and `readonly` hard-block writes on the backend; the rest differ only
 * in whether a write needs approval. `readonly` is not offered in the composer
 * (plan supersedes it there) but survives here for sub-agents and old blobs.
 */
export type PermissionLevel = 'plan' | 'readonly' | 'confirm' | 'auto' | 'full'

export type ThoughtLevel = 'off' | 'low' | 'high' | 'max'

/** How much tool/reasoning detail the chat timeline shows. */
export type ChatDensity = 'full' | 'compact' | 'minimal'

const STORAGE_KEY = 'ovolve-session-config'


const PERMISSIONS: PermissionLevel[] = ['plan', 'readonly', 'confirm', 'auto', 'full']
const THOUGHTS: ThoughtLevel[] = ['off', 'low', 'high', 'max']
const DENSITIES: ChatDensity[] = ['full', 'compact', 'minimal']

interface Persisted {
  permission: PermissionLevel
  thoughtLevel: ThoughtLevel
  activeModel: string
  chatDensity: ChatDensity
}

const DEFAULTS: Persisted = {
  permission: 'auto',
  thoughtLevel: 'high',
  activeModel: '',
  chatDensity: 'full',
}

/**
 * Collapse a pre-merge blob onto the current axis.
 *
 * Two generations of stored shape to handle:
 * 1. `{mode, permission}` — the old read-only MODES outranked whatever permission
 *    was stored, so they must win here too. Restoring `{mode:'plan',
 *    permission:'yolo'}` as plain full access would silently hand write access to
 *    someone who had chosen planning.
 * 2. `{permission:'ask'|'yolo'}` — the pre-`risk_control` spellings. Left alone
 *    they'd fail the PERMISSIONS check and silently reset to `auto`, which would
 *    quietly *loosen* a user who had picked confirm-before-write.
 */
function migrate(p: { mode?: unknown; permission?: unknown }): PermissionLevel | null {
  if (p.mode === 'plan') return 'plan'
  if (p.mode === 'ask') return 'readonly'
  if (p.permission === 'ask') return 'confirm'
  if (p.permission === 'yolo') return 'full'
  if (p.permission === 'deny') return 'readonly'
  return null
}

/**
 * Read the blob back, validating every enum against its allowed set.
 *
 * A hand-edited or version-skewed localStorage value must never put the store
 * into a state the UI can't render — an unknown `permission` could read as *more*
 * permissive than the user intended. Anything unrecognised falls back to the
 * default rather than being trusted.
 */
function load(): Persisted {
  if (typeof localStorage === 'undefined') return { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const p = JSON.parse(raw) as Partial<Persisted> & { mode?: unknown }
    const migrated = migrate(p)
    return {
      permission:
        migrated ??
        (PERMISSIONS.includes(p.permission as PermissionLevel)
          ? (p.permission as PermissionLevel)
          : DEFAULTS.permission),
      thoughtLevel: THOUGHTS.includes(p.thoughtLevel as ThoughtLevel)
        ? (p.thoughtLevel as ThoughtLevel)
        : DEFAULTS.thoughtLevel,
      // Kept as-is here on purpose: the provider catalogue loads asynchronously
      // over IPC, so at this moment we can't tell a dead reference from one
      // whose provider simply hasn't arrived yet. reconcileActiveModel() runs
      // once the real catalogue lands.
      activeModel: typeof p.activeModel === 'string' ? p.activeModel : DEFAULTS.activeModel,
      chatDensity: DENSITIES.includes(p.chatDensity as ChatDensity)
        ? (p.chatDensity as ChatDensity)
        : DEFAULTS.chatDensity,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function save(p: Persisted): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    // Quota or private-mode failure. Preferences degrade to in-memory only,
    // which is exactly the old behaviour — never worth breaking a turn over.
  }
}

interface SessionConfigState {
  permission: PermissionLevel
  thoughtLevel: ThoughtLevel
  activeModel: string // "providerId:modelId"
  chatDensity: ChatDensity
  setPermission: (level: PermissionLevel) => void
  setThoughtLevel: (level: ThoughtLevel) => void
  setActiveModel: (model: string) => void
  setChatDensity: (density: ChatDensity) => void
}

const initial = load()

export const useSessionConfigStore = create<SessionConfigState>((set, get) => ({
  permission: initial.permission,
  thoughtLevel: initial.thoughtLevel,
  activeModel: initial.activeModel,
  chatDensity: initial.chatDensity,

  setPermission: (permission) => { set({ permission }); persist(get) },
  setThoughtLevel: (thoughtLevel) => { set({ thoughtLevel }); persist(get) },
  setActiveModel: (activeModel) => { set({ activeModel }); persist(get) },
  setChatDensity: (chatDensity) => { set({ chatDensity }); persist(get) },
}))

function persist(get: () => SessionConfigState): void {
  const { permission, thoughtLevel, activeModel, chatDensity } = get()
  save({ permission, thoughtLevel, activeModel, chatDensity })
}

/**
 * Point `activeModel` at something that actually works.
 *
 * Runs whenever the provider catalogue changes — after the initial IPC load,
 * after a save, after a delete. Three cases:
 *
 *   1. Current choice is still usable → leave it alone.
 *   2. Current choice is gone or unusable (provider deleted / disabled / key
 *      removed) → fall back to the highest-priority available model. Falling
 *      back beats clearing: the user gets a working composer instead of a
 *      "选择模型" placeholder and a failed first message.
 *   3. Nothing is set and something IS available → adopt it, so a freshly
 *      configured provider is immediately usable without an extra click.
 *
 * Uses `enabledModels()` rather than a raw `providers[pid].models[mid]` lookup
 * because "exists in the catalogue" is not the same as "can be called" — a
 * provider with no API key is present but unusable, and sending to it fails.
 */
export function reconcileActiveModel(): void {
  const { activeModel, setActiveModel } = useSessionConfigStore.getState()
  const available = useModelStore.getState().enabledModels()

  // Nothing usable is configured. This is either transient (the IPC load fires
  // `set({loading:true})` while `providers` is still the all-disabled preset
  // seed, which would otherwise wipe the remembered choice a tick before the
  // real catalogue lands) or genuine (no keys entered yet). In both cases
  // clearing gains nothing — there is no better value to point at — so hold.
  if (available.length === 0) return

  const stillGood = activeModel
    ? available.some((m) => `${m.providerId}:${m.modelId}` === activeModel)
    : false
  if (stillGood) return

  const best = available[0]
  const next = best ? `${best.providerId}:${best.modelId}` : ''
  // Don't write (and don't persist) when nothing changes — avoids a pointless
  // localStorage round-trip on every catalogue refresh.
  if (next !== activeModel) setActiveModel(next)
}

// Re-check on every catalogue mutation. Subscribing here rather than inside a
// component means the invariant holds even on screens that never render a model
// picker (e.g. the agent is driven by a Goal while the user sits on Settings).
//
// The `providers` identity check is load-bearing. Zustand notifies on EVERY
// `set()`, and `loadProviders()` starts with `set({ loading: true })` — a tick
// where `providers` is still the PRE-reload snapshot. Reconciling there could
// repoint the primary model from stale data, and anything keyed on `activeModel`
// then re-derived itself from a catalogue that was about to be replaced. That is
// how saving a provider used to blank the Model ID box in the settings form.
useModelStore.subscribe((state, prev) => {
  if (state.providers !== prev.providers) reconcileActiveModel()
})
