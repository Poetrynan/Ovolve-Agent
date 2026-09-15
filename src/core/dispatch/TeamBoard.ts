/**
 * TeamBoard.ts — DAG Task Orchestration, Atomic TaskLeases & Cascade Failure Propagation
 *
 * Implements:
 * 1. Atomic TaskLeases (`team_leases`) with TTL expiration and ownership validation.
 * 2. DAG dependency resolution (`canRun`, `getRunnableTasks`).
 * 3. Cascade failure handling (`cascadeFailures`) blocking downstream dependent tasks.
 * 4. Reviewer gating (`setReview`) for independent quality verification.
 */

import { roleSpec, checkResultContract, RoleSpec } from './RolePresets'

export interface TaskLeaseRecord {
  taskId: string
  owner: string
  acquiredAt: number
  expiresAt: number
}

export interface TeamBoardTask {
  taskId: string
  role: string
  spec: RoleSpec
  status: 'pending' | 'leased' | 'delivered' | 'rejected' | 'failed' | 'blocked'
  leaseOwner: string
  result: any
  contractProblems: string[]
  reviewStatus: 'none' | 'approved' | 'changes_requested' | 'rejected'
  reviewNote: string
  dependsOn: string[]
  createdAt: number
  updatedAt: number
}

export interface TeamBoardTaskView {
  taskId: string
  role: string
  status: string
  leaseOwner: string
  result: any
  contractProblems: string[]
  reviewStatus: string
  reviewNote: string
  dependsOn: string[]
  toolsCount: number
}

/**
 * In-memory fallback lease store for environments without direct SQLite driver.
 */
class MemoryLeaseStore {
  private leases: Map<string, TaskLeaseRecord> = new Map()

  public acquire(taskId: string, owner: string, ttlSeconds: number = 900): boolean {
    const now = Math.floor(Date.now() / 1000)
    const existing = this.leases.get(taskId)

    if (!existing || existing.expiresAt < now || existing.owner === owner) {
      this.leases.set(taskId, {
        taskId,
        owner,
        acquiredAt: now,
        expiresAt: now + ttlSeconds,
      })
      return true
    }

    return false
  }

  public release(taskId: string, owner: string): boolean {
    const existing = this.leases.get(taskId)
    if (existing && existing.owner === owner) {
      this.leases.delete(taskId)
      return true
    }
    return false
  }

  public get(taskId: string): TaskLeaseRecord | undefined {
    return this.leases.get(taskId)
  }

  public clear(): void {
    this.leases.clear()
  }
}

export const defaultLeaseStore = new MemoryLeaseStore()

/**
 * SQL DDL for team_leases table
 */
export const TEAM_LEASES_DDL = `
CREATE TABLE IF NOT EXISTS team_leases (
    task_id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    acquired_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
`

/**
 * Atomically acquires a task lease in SQLite or in-memory fallback.
 */
export function acquireLease(
  storageOrDb: any,
  taskId: string,
  owner: string,
  ttlSeconds: number = 900,
): boolean {
  const now = Math.floor(Date.now() / 1000)

  if (storageOrDb && typeof storageOrDb.execute === 'function') {
    try {
      storageOrDb.execute(TEAM_LEASES_DDL)
      const res = storageOrDb.execute(
        `INSERT INTO team_leases (task_id, owner, acquired_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           owner=excluded.owner, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
         WHERE team_leases.owner=? OR team_leases.expires_at < ?`,
        [taskId, owner, now, now + ttlSeconds, owner, now],
      )
      return (res?.changes ?? (res?.rowcount ?? 1)) > 0
    } catch {
      // Fall back to memory lease store on DB error
      return defaultLeaseStore.acquire(taskId, owner, ttlSeconds)
    }
  }

  if (storageOrDb && typeof storageOrDb.prepare === 'function') {
    try {
      storageOrDb.prepare(TEAM_LEASES_DDL).run()
      const info = storageOrDb
        .prepare(
          `INSERT INTO team_leases (task_id, owner, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             owner=excluded.owner, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
           WHERE team_leases.owner=? OR team_leases.expires_at < ?`,
        )
        .run(taskId, owner, now, now + ttlSeconds, owner, now)
      return info.changes > 0
    } catch {
      return defaultLeaseStore.acquire(taskId, owner, ttlSeconds)
    }
  }

  return defaultLeaseStore.acquire(taskId, owner, ttlSeconds)
}

/**
 * Atomically releases a task lease held by the owner.
 */
export function releaseLease(storageOrDb: any, taskId: string, owner: string): boolean {
  if (storageOrDb && typeof storageOrDb.execute === 'function') {
    try {
      const res = storageOrDb.execute('DELETE FROM team_leases WHERE task_id=? AND owner=?', [
        taskId,
        owner,
      ])
      return (res?.changes ?? (res?.rowcount ?? 1)) > 0
    } catch {
      return defaultLeaseStore.release(taskId, owner)
    }
  }

  if (storageOrDb && typeof storageOrDb.prepare === 'function') {
    try {
      const info = storageOrDb
        .prepare('DELETE FROM team_leases WHERE task_id=? AND owner=?')
        .run(taskId, owner)
      return info.changes > 0
    } catch {
      return defaultLeaseStore.release(taskId, owner)
    }
  }

  return defaultLeaseStore.release(taskId, owner)
}

export class TeamBoard {
  public parentRunId: string
  public storage: any
  private _tasks: Map<string, TeamBoardTask> = new Map()

  constructor(storage: any = null, parentRunId: string = 'default') {
    this.storage = storage
    this.parentRunId = parentRunId
  }

  /**
   * Adds a task to the team board with DAG dependency declarations.
   */
  public addTask(
    taskId: string,
    role: string,
    options?: {
      dependsOn?: string[]
      overrides?: Partial<RoleSpec>
    },
  ): TeamBoardTask {
    const spec = roleSpec(role, options?.overrides)
    const now = Date.now()

    const task: TeamBoardTask = {
      taskId,
      role,
      spec,
      status: 'pending',
      leaseOwner: '',
      result: null,
      contractProblems: [],
      reviewStatus: 'none',
      reviewNote: '',
      dependsOn: options?.dependsOn ? [...options.dependsOn] : [],
      createdAt: now,
      updatedAt: now,
    }

    this._tasks.set(taskId, task)
    return task
  }

  /**
   * Retrieves a task by ID.
   */
  public getTask(taskId: string): TeamBoardTask | undefined {
    return this._tasks.get(taskId)
  }

  /**
   * Checks whether all prerequisite tasks for the given task have successfully delivered.
   */
  public canRun(taskId: string): boolean {
    const task = this._tasks.get(taskId)
    if (!task || task.status !== 'pending') {
      return false
    }

    for (const depId of task.dependsOn) {
      const depTask = this._tasks.get(depId)
      if (!depTask || depTask.status !== 'delivered' || depTask.reviewStatus === 'rejected') {
        return false
      }
    }

    return true
  }

  /**
   * Returns all pending task IDs whose prerequisites are fully satisfied.
   */
  public getRunnableTasks(): string[] {
    const runnable: string[] = []
    for (const [taskId] of this._tasks.entries()) {
      if (this.canRun(taskId)) {
        runnable.push(taskId)
      }
    }
    return runnable
  }

  /**
   * Cascade failure propagation:
   * If any upstream dependency fails, is rejected, or is blocked,
   * all downstream pending tasks are automatically transitioned to 'blocked'.
   * Repeats until fixed point to handle multi-hop chains.
   */
  public cascadeFailures(): number {
    let totalBlocked = 0
    let changed = true

    while (changed) {
      changed = false
      for (const [, task] of this._tasks.entries()) {
        if (task.status !== 'pending') {
          continue
        }

        for (const depId of task.dependsOn) {
          const depTask = this._tasks.get(depId)
          if (
            depTask &&
            (depTask.status === 'rejected' ||
              depTask.status === 'failed' ||
              depTask.status === 'blocked' ||
              depTask.reviewStatus === 'rejected')
          ) {
            task.status = 'blocked'
            task.contractProblems = [`prerequisite task '${depId}' ${depTask.status}`]
            task.updatedAt = Date.now()
            totalBlocked += 1
            changed = true
            break
          }
        }
      }
    }

    return totalBlocked
  }

  /**
   * Atomically claims a task for a designated worker.
   */
  public claim(taskId: string, worker: string, ttlSeconds: number = 900): boolean {
    const task = this._tasks.get(taskId)
    if (!task) {
      return false
    }

    const leaseKey = `${this.parentRunId}:${taskId}`
    const ok = acquireLease(this.storage, leaseKey, worker, ttlSeconds)
    if (ok) {
      task.status = 'leased'
      task.leaseOwner = worker
      task.updatedAt = Date.now()
    }
    return ok
  }

  /**
   * Delivers a task outcome, validating ResultContract and lease ownership.
   */
  public deliver(
    taskId: string,
    worker: string,
    payload: any,
  ): { ok: boolean; problems: string[] } {
    const task = this._tasks.get(taskId)
    if (!task) {
      return { ok: false, problems: [`unknown task: ${taskId}`] }
    }

    if (task.leaseOwner !== worker) {
      return {
        ok: false,
        problems: [`not lease holder: '${worker}' vs '${task.leaseOwner}'`],
      }
    }

    const { ok, problems } = checkResultContract(payload, task.spec.result_schema)
    task.updatedAt = Date.now()

    if (ok) {
      task.status = 'delivered'
      task.result = payload
      task.contractProblems = []
    } else {
      task.status = 'rejected'
      task.contractProblems = problems
    }

    return { ok, problems }
  }

  /**
   * Sets reviewer verdict for a delivered task.
   */
  public setReview(
    taskId: string,
    verdict: 'approved' | 'changes_requested' | 'rejected',
    note: string = '',
  ): boolean {
    const task = this._tasks.get(taskId)
    if (!task || task.status !== 'delivered') {
      return false
    }

    if (!['approved', 'changes_requested', 'rejected'].includes(verdict)) {
      throw new Error(`unknown review verdict: ${verdict}`)
    }

    task.reviewStatus = verdict
    task.reviewNote = String(note || '').slice(0, 300)
    task.updatedAt = Date.now()

    if (verdict === 'rejected') {
      task.status = 'rejected'
    }

    return true
  }

  /**
   * Returns a snapshot view of all tasks in the team board.
   */
  public view(): TeamBoardTaskView[] {
    return Array.from(this._tasks.values()).map((t) => ({
      taskId: t.taskId,
      role: t.role,
      status: t.status,
      leaseOwner: t.leaseOwner,
      result: t.result,
      contractProblems: [...t.contractProblems],
      reviewStatus: t.reviewStatus,
      reviewNote: t.reviewNote,
      dependsOn: [...t.dependsOn],
      toolsCount: t.spec.tools.length,
    }))
  }
}
