// src/store/composerContextStore.ts
// State for the composer's "add context" features: attachments + inserted
// @-mentions, mirroring the attachment/mention model of mature
// agent composers.
import { create } from 'zustand'

export type UploadState = 'queued' | 'uploading' | 'ready' | 'failed'

export interface Attachment {
  id: string
  fileName: string
  path?: string
  mime: string
  bytes: number
  /** data: URI for image previews. */
  previewUri?: string
  state: UploadState
  progress?: number
  error?: string
}

export type MentionKind = 'file' | 'dir' | 'git_diff' | 'skill' | 'session' | 'subagent'

/**
 * Kinds the backend resolver can actually turn into content (UB2), i.e. the ones
 * that belong on the structured `contextRefs` channel. Everything else is a chip
 * with no resolver behind it yet and stays a text hint in the prompt.
 *
 * Kept here rather than in the composer so the list has exactly one home — a
 * new resolver kind is added to the backend and to this line, and both the
 * picker and the send path pick it up.
 */
export const RESOLVABLE_MENTION_KINDS: readonly MentionKind[] = ['file', 'dir', 'git_diff']

/**
 * One reference sent to the backend for actual RESOLUTION (UB2).
 *
 * Distinct from `Mention` on purpose: a Mention is a UI chip (it has an `id` for
 * React keys and a display `label`), while a ContextRef is the wire contract —
 * only what the resolver needs. Keeping them separate is what lets a chip exist
 * for something the backend has no resolver for yet (a skill, a subagent)
 * without inventing a fake ref kind for it.
 *
 * `kind` is a plain string rather than a union of the four MentionKinds because
 * the resolver also understands `dir` and `git_diff`, which no picker produces
 * yet — narrowing here would block those before they are built.
 */
export interface ContextRef {
  kind: string
  ref: string
  label: string
}

export interface Mention {
  id: string
  kind: MentionKind
  label: string
  /** File path, skill id, etc. */
  ref: string
}

interface ComposerContextState {
  attachments: Attachment[]
  mentions: Mention[]
  addAttachment: (a: Attachment) => void
  updateAttachment: (id: string, patch: Partial<Attachment>) => void
  removeAttachment: (id: string) => void
  addMention: (m: Mention) => void
  removeMention: (id: string) => void
  clear: () => void
}

export const useComposerContextStore = create<ComposerContextState>((set) => ({
  attachments: [],
  mentions: [],
  addAttachment: (a) => set((s) => ({ attachments: [...s.attachments, a] })),
  updateAttachment: (id, patch) =>
    set((s) => ({
      attachments: s.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    })),
  removeAttachment: (id) =>
    set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  addMention: (m) =>
    // Dedupe on kind+ref, not ref alone: the same path is a legitimate `file`
    // AND `dir` reference, and the git-diff chips carry refs like '' (working
    // tree) that would otherwise collide with each other.
    set((s) =>
      s.mentions.some((x) => x.ref === m.ref && x.kind === m.kind)
        ? s
        : { mentions: [...s.mentions, m] }),
  removeMention: (id) => set((s) => ({ mentions: s.mentions.filter((m) => m.id !== id) })),
  clear: () => set({ attachments: [], mentions: [] }),
}))
