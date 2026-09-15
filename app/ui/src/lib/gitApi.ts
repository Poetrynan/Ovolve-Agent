import { API_BASE, apiFetch } from '@lib/api'
import type { GitCommitRow, GitStatus } from '@apptypes/index'
import { useAgentStore } from '@store/agentStore'

/**
 * Session-scoped git queries: every git API call carries the current sessionId
 * so the backend resolves the correct Router (→ workspace). This is what makes
 * multi-window work: window A's panel queries A's workspace, not the primary.
 */
function sessionParam(): string {
  const sid = useAgentStore.getState().sessionId
  return sid ? `session_id=${encodeURIComponent(sid)}` : ''
}

export async function fetchGitStatus(): Promise<GitStatus> {
  const sp = sessionParam()
  const res = await apiFetch(`${API_BASE}/api/git/status${sp ? `?${sp}` : ''}`)
  if (!res.ok) throw new Error(`git status ${res.status}`)
  return res.json()
}

export async function fetchGitBranches(): Promise<{ current: string; branches: string[] }> {
  const sp = sessionParam()
  const res = await apiFetch(`${API_BASE}/api/git/branches${sp ? `?${sp}` : ''}`)
  if (!res.ok) throw new Error(`git branches ${res.status}`)
  const data = await res.json()
  return {
    current: data.current || '',
    branches: data.branches || [],
  }
}

export async function fetchGitLog(limit = 40): Promise<{
  branch: string
  commits: GitCommitRow[]
}> {
  const sp = sessionParam()
  const sep = sp ? `&${sp}` : ''
  const res = await apiFetch(`${API_BASE}/api/git/log?limit=${limit}${sep}`)
  if (!res.ok) throw new Error(`git log ${res.status}`)
  const data = await res.json()
  return {
    branch: data.branch || '',
    commits: data.commits || [],
  }
}

export async function restoreGitChanges(paths?: string[]): Promise<void> {
  const sid = useAgentStore.getState().sessionId
  const res = await apiFetch(`${API_BASE}/api/git/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirmed: true, paths: paths || [], session_id: sid }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `restore failed (${res.status})`)
  }
}

export async function checkoutBranch(branch: string): Promise<void> {
  const sid = useAgentStore.getState().sessionId
  const res = await apiFetch(`${API_BASE}/api/git/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch, session_id: sid }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `checkout failed (${res.status})`)
  }
}

/** Create from current HEAD and switch (first-version semantics). */
export async function createAndCheckoutBranch(name: string): Promise<void> {
  const sid = useAgentStore.getState().sessionId
  const res = await apiFetch(`${API_BASE}/api/git/branch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, checkout: true, session_id: sid }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `create branch failed (${res.status})`)
  }
}

/**
 * Ask the backend to draft a Conventional Commits message.
 * @param includeUnstaged describe all dirty changes, not just the index —
 *        mirrors the commit panel's "包含未暂存的更改" box.
 * @param model the composer's "providerId:modelId" pick, so the draft comes
 *        from the same model the user is chatting with (there is no separate
 *        cheap commit model in an open-source build).
 * Returns the message string on success.
 */
export async function fetchCommitMessage(includeUnstaged = false, model = ''): Promise<string> {
  const sp = sessionParam()
  const parts = [sp, includeUnstaged ? 'unstaged=1' : '',
    model ? `model=${encodeURIComponent(model)}` : ''].filter(Boolean)
  const qs = parts.length ? `?${parts.join('&')}` : ''
  const res = await apiFetch(`${API_BASE}/api/git/commit-message${qs}`)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `commit-message failed (${res.status})`)
  }
  const data = await res.json()
  // The backend returns either {message: "..."} or the whole object with title/body.
  return data.message || data.title || JSON.stringify(data)
}

export interface CommitResult {
  ok: boolean
  hash: string
  message: string
  generatedBy?: string | null
  pushed: boolean
  pushError?: string | null
}

/**
 * Commit (and optionally push) directly from the commit panel.
 * Empty `message` → backend auto-generates. Reversible via a later reset; the
 * user's explicit 提交 click is the consent, matching every git GUI.
 */
export async function commitChanges(opts: {
  message: string
  includeUnstaged: boolean
  push: boolean
  model?: string
}): Promise<CommitResult> {
  const sid = useAgentStore.getState().sessionId
  const res = await apiFetch(`${API_BASE}/api/git/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...opts, session_id: sid }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `commit failed (${res.status})`)
  }
  return res.json()
}

/** Push the current branch (the panel's standalone 推送 action). */
export async function pushBranch(): Promise<void> {
  const sid = useAgentStore.getState().sessionId
  const res = await apiFetch(`${API_BASE}/api/git/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sid }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `push failed (${res.status})`)
  }
}

export interface GitFileDiffResult {
  ok: boolean
  path: string
  diff: string
  targetContent: string
  replacementContent: string
  additions: number
  deletions: number
  isUntracked: boolean
}

/** Fetch detailed diff and before/after content for a file. */
export async function fetchGitDiff(path?: string): Promise<GitFileDiffResult> {
  const sp = sessionParam()
  const params = [sp, path ? `path=${encodeURIComponent(path)}` : ''].filter(Boolean)
  const qs = params.length ? `?${params.join('&')}` : ''
  const res = await apiFetch(`${API_BASE}/api/git/diff${qs}`)
  if (!res.ok) throw new Error(`git diff ${res.status}`)
  return res.json()
}
