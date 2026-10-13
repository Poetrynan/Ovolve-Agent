"use strict";
/**
 * path_lock.ts 鈥?Process-level write locks keyed by file path.
 *
 * Ported from `app/backend/path_lock.py` (124 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂1 ESM/nodenext import paths.
 * - 搂2 dict used as ordered structure 鈫?Map.
 *
 * NOTES:
 * - Python uses threading.Lock; Node.js is single-threaded for JS execution,
 *   so the "locks" here are token placeholders that preserve the API shape.
 *   The `hold` method still serializes via the lock acquisition order to
 *   prevent deadlocks when the product moves to worker threads.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MutexLock = exports.PathLockRegistry = void 0;
exports.get_path_locks = get_path_locks;
exports.write_lock = write_lock;
const nodePath = require("node:path");
class PathLockRegistry {
    _locks = new Map();
    _guard = new MutexLock();
    static _key(path) {
        // Python: os.path.normcase(os.path.abspath(path or ""))
        // On Windows, normcase lowercases; on POSIX it's a no-op.
        let norm = nodePath.resolve(path || "");
        if (process.platform === "win32") {
            norm = norm.toLowerCase();
        }
        return norm;
    }
    lock_for(path) {
        const key = PathLockRegistry._key(path);
        // setdefault equivalent
        let lock = this._locks.get(key);
        if (lock === undefined) {
            lock = new MutexLock();
            this._locks.set(key, lock);
        }
        return lock;
    }
    hold(...paths) {
        const keys = Array.from(new Set(paths.filter((p) => p).map((p) => PathLockRegistry._key(p)))).sort();
        const acquired = [];
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
                }
                catch {
                    // Should not happen; release failure must not mask body exceptions.
                }
            }
        };
    }
    tracked() {
        return this._locks.size;
    }
}
exports.PathLockRegistry = PathLockRegistry;
/**
 * Minimal mutex placeholder. Node.js is single-threaded for JS, so this
 * just tracks acquisition state. In a worker-thread context, this would
 * be backed by an Atomics-based lock.
 */
class MutexLock {
    _locked = false;
    acquire() {
        this._locked = true;
    }
    release() {
        if (!this._locked) {
            throw new Error("Lock not held");
        }
        this._locked = false;
    }
    get locked() {
        return this._locked;
    }
}
exports.MutexLock = MutexLock;
// Singleton (mirrors Python module-level singleton).
let _registry = null;
function get_path_locks() {
    if (_registry === null) {
        _registry = new PathLockRegistry();
    }
    return _registry;
}
// Context-manager-style helper (returns a release function).
function write_lock(...paths) {
    return get_path_locks().hold(...paths);
}
// PORT STATUS: confidence=medium todos=[1]
// TODO(port): if the product adopts worker threads, back MutexLock with
// Atomics/Mutex for real cross-thread exclusion.
