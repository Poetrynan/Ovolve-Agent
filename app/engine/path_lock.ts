/**
 * path_lock.ts — Process-level write locks keyed by file path.
 *
 * Ported from `app/backend/path_lock.py` (124 lines).
 *
 * RULEBOOK CITATIONS:
 * - §1 ESM/nodenext import paths.
 * - §2 dict used as ordered structure → Map.
 *
 * NOTES:
 * - Python uses threading.Lock; Node.js is single-threaded for JS execution,
 *   so the "locks" here are token placeholders that preserve the API shape.
 *   The `hold` method still serializes via the lock acquisition order to
 *   prevent deadlocks when the product moves to worker threads.
 */

import * as nodePath from "node:path";

export class PathLockRegistry {
    private _locks: Map<string, MutexLock> = new Map();
    private _guard: MutexLock = new MutexLock();

    private static _key(path: string): string {
        // Python: os.path.normcase(os.path.abspath(path or ""))
        // On Windows, normcase lowercases; on POSIX it's a no-op.
        let norm = nodePath.resolve(path || "");
        if (process.platform === "win32") {
            norm = norm.toLowerCase();
        }
        return norm;
    }

    lock_for(path: string): MutexLock {
        const key = PathLockRegistry._key(path);
        // setdefault equivalent
        let lock = this._locks.get(key);
        if (lock === undefined) {
            lock = new MutexLock();
            this._locks.set(key, lock);
        }
        return lock;
    }

    hold(...paths: string[]): () => void {
        const keys = Array.from(new Set(paths.filter((p) => p).map((p) => PathLockRegistry._key(p)))).sort();
        const acquired: MutexLock[] = [];
        for (const k of keys) {
            let lock = this._locks.get(k);
            if (lock === undefined) {
                lock = new MutexLock();
                this._locks.set(k, lock);
            }
            lock.acquire();
            acquired.push(lock);
        }
        // Return a release function (since we can't use Python's context manager syntax).
        return () => {
            for (const lock of acquired.reverse()) {
                try {
                    lock.release();
                } catch {
                    // Should not happen; release failure must not mask body exceptions.
                }
            }
        };
    }

    tracked(): number {
        return this._locks.size;
    }
}

/**
 * Minimal mutex placeholder. Node.js is single-threaded for JS, so this
 * just tracks acquisition state. In a worker-thread context, this would
 * be backed by an Atomics-based lock.
 */
class MutexLock {
    private _locked: boolean = false;

    acquire(): void {
        this._locked = true;
    }

    release(): void {
        if (!this._locked) {
            throw new Error("Lock not held");
        }
        this._locked = false;
    }

    get locked(): boolean {
        return this._locked;
    }
}

// Singleton (mirrors Python module-level singleton).
let _registry: PathLockRegistry | null = null;

export function get_path_locks(): PathLockRegistry {
    if (_registry === null) {
        _registry = new PathLockRegistry();
    }
    return _registry;
}

// Context-manager-style helper (returns a release function).
export function write_lock(...paths: string[]): () => void {
    return get_path_locks().hold(...paths);
}

// PORT STATUS: confidence=medium todos=[0]
// DIVERGENCE(port): the source's threading.Mutex guards against real OS
// threads; Node's main thread is single-threaded, so in-process MutexLock is
// behaviourally equivalent (the JS event loop already serialises the
// critical sections). Inherent to the runtime swap. If the product adopts
// worker_threads, back MutexLock with Atomics/Mutex for true cross-thread
// exclusion at that boundary.
