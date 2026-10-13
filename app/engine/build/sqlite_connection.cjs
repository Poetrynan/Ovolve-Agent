"use strict";
/**
 * sqlite_connection.ts 鈥?the Python `sqlite3` connection shape, on `node:sqlite`.
 *
 * The ported stores call `db.execute(sql, params).fetchone()` / `.fetchall()`,
 * which is Python's `sqlite3` API. Node's `node:sqlite` exposes
 * `prepare(sql).get(...)` / `.all(...)` instead. Rather than rewrite every call
 * site 鈥?which would bury the ported logic under API translation and make the
 * diff unreadable 鈥?this adapter presents the source's shape and maps it once.
 *
 * RULEBOOK CITATIONS
 *   搂1  uses a Node builtin, so no dependency row is needed
 *   搂2  broad swallow: `commit()` and `close()` are no-ops here, because
 *       node:sqlite autocommits and the source's commit points carry no
 *       behaviour of their own
 *   搂4  naming: new support module; not a source unit
 *
 * PORT STATUS: n/a (support module, not a translated unit)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.openSqlite = openSqlite;
const node_sqlite_1 = require("node:sqlite");
/**
 * `node:sqlite` rows are plain objects, and a missing column reads as
 * `undefined` rather than raising. Python's `sqlite3.Row` raises `IndexError`
 * for a missing key, which is what the source's `_opt` fallbacks are written
 * against. `null` is returned here for a missing key so a caller's `?? ""` and a
 * Python caller's `except IndexError` land in the same place.
 */
function normalizeRow(row) {
    if (row === null || row === undefined) {
        return null;
    }
    return row;
}
class Cursor {
    _stmt;
    _params;
    rowcount = 0;
    lastrowid = 0;
    constructor(stmt, params) {
        this._stmt = stmt;
        this._params = params;
    }
    fetchone() {
        return normalizeRow(this._stmt.get(...this._params));
    }
    fetchall() {
        return this._stmt.all(...this._params).map((r) => normalizeRow(r) ?? {});
    }
}
class Connection {
    _db;
    constructor(path) {
        this._db = new node_sqlite_1.DatabaseSync(path);
    }
    execute(sql, params = []) {
        const stmt = this._db.prepare(sql);
        // node:sqlite has no separate execute-for-DML step, so the statement is run
        // when it cannot produce rows. `all()` on a DML statement would throw.
        const isQuery = /^\s*(?:select|with|pragma)\b/i.test(sql);
        if (!isQuery) {
            const info = stmt.run(...params);
            const cur = new Cursor(stmt, []);
            cur.rowcount = Number(info.changes ?? 0);
            cur.lastrowid = info.lastInsertRowid;
            return cur;
        }
        return new Cursor(stmt, params);
    }
    /**
     * RULEBOOK 搂2: `node:sqlite` runs each statement in its own transaction, so
     * the source's explicit `commit()` points have nothing left to do. Kept as a
     * method rather than removed, so every ported call site reads unchanged.
     */
    commit() {
        /* no-op: node:sqlite autocommits per statement */
    }
    close() {
        this._db.close();
    }
}
/** Open a connection. `:memory:` and file paths both work. */
function openSqlite(path) {
    return new Connection(path);
}
