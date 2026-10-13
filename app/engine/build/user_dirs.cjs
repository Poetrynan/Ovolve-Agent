"use strict";
/**
 * user_dirs.ts 鈥?the single source of truth for Ovolve user-data paths.
 *
 * Ported from `app/backend/user_dirs.py` (33 lines).
 *
 * All user-level data lands in `~/.ovolve`. `OVOLVE_DB_DIR` overrides the
 * database directory (tests, multi-instance isolation). Every module that needs
 * a user-level path reads it from here instead of hardcoding one.
 *
 * RULEBOOK CITATIONS
 *   搂4  naming: app/backend/user_dirs.py -> app/engine/user_dirs.ts
 *   搂2  module-level mutable state: the memoised home directory is preserved,
 *       including the fact that the env var is read on every call
 *
 * PORT STATUS: confidence=high todos=0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DB_DIR_ENV = exports.BRAND_DIR = void 0;
exports.homeDir = homeDir;
exports.dbDir = dbDir;
const os = require("node:os");
const path = require("node:path");
exports.BRAND_DIR = ".ovolve";
exports.DB_DIR_ENV = "OVOLVE_DB_DIR";
/**
 * RULEBOOK 搂2 (module-level mutable state): the source memoises the resolved
 * home directory in a module global and returns the cached value on every later
 * call. Reproduced as a module-scoped binding, so a caller that mutates HOME
 * mid-process sees the same behaviour it saw before 鈥?which is that it does not.
 */
let resolvedHome = null;
/** The Ovolve user-data root (`~/.ovolve`). */
function homeDir() {
    if (resolvedHome !== null) {
        return resolvedHome;
    }
    // Bound to a local before assigning: TypeScript does not narrow a
    // module-scoped `let` to non-null across the assignment the way it narrows a
    // local, and the source's behaviour is "memoise then return the same value".
    const resolved = path.join(os.homedir(), exports.BRAND_DIR);
    resolvedHome = resolved;
    return resolved;
}
/**
 * The SQLite database directory. An explicit environment variable wins.
 *
 * Note the asymmetry with `homeDir`, preserved deliberately: the env var is
 * read on **every** call, not memoised, so a test that sets it after a previous
 * call still sees its own value.
 */
function dbDir() {
    const env = process.env[exports.DB_DIR_ENV];
    if (env) {
        return env;
    }
    return path.join(homeDir(), "db");
}
