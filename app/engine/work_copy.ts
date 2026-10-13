/**
 * work_copy.ts — per-subagent write isolation (UA3).
 *
 * Ported from `app/backend/work_copy.py` (423 lines).
 *
 * ## The problem this fixes
 *
 * `path_lock.ts` already stops two sub-agents from *clobbering* each other: same
 * file, serialized writes, no lost bytes. What it cannot do is stop them from
 * producing changes that are individually fine and jointly broken — A renames a
 * function's parameters, B in another file still calls it the old way, both
 * write successfully, both report success, and the thing that's wrong is the
 * *sum*.
 *
 * ## The shape: a copy-on-write overlay, not a copy of the workspace
 *
 * - **reads and searches go straight to the real workspace** — unchanged.
 * - **writes land in a private overlay directory**, mirroring the workspace
 *   layout. A file is seeded from the real one the first time it's edited, so
 *   `edit_file`'s read→replace→write still sees the true pre-image.
 *
 * Deletes need a tombstone in a manifest at the overlay root — an overlay that
 * holds nothing is indistinguishable from "untouched". Merge is the parent's
 * job, only for sub-agents that succeeded; conflicting files are left to the
 * parent rather than silently picking a winner.
 *
 * RULEBOOK CITATIONS:
 * - §1 node: fs/path/crypto/os builtins.
 * - §2 dataclass → class; shutil.copy2 → copyFileSync (see DIVERGENCE below);
 *   os.walk → recursive readdir; set iteration emitted through `sort()` where
 *   the source sorts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";

import { write_lock } from "./path_lock.js";

/**
 * Kill switch. Off means every sub-agent writes straight to the workspace, i.e.
 * exactly the behaviour before this module existed.
 */
export const WORK_COPY_ENABLED = true;

/** The ctx key a redirected tool looks for. Absent → no redirection at all. */
export const CTX_KEY = "work_copy_root";

/** Manifest filename inside an overlay (also the "this is an overlay" marker). */
export const MANIFEST = ".ovolve-workcopy.json";

/** Don't seed absurdly large files into an overlay. */
export const MAX_SEED_BYTES = 8 * 1024 * 1024;

function _overlay_root(): string {
    const root = nodePath.join(os.tmpdir(), "ovolve-workcopies");
    fs.mkdirSync(root, { recursive: true });
    return root;
}

/** os.path.normcase(normpath(abspath(p))) — Windows folds case, POSIX does not. */
function _norm(p: string): string {
    const n = nodePath.normalize(nodePath.resolve(p));
    return process.platform === "win32" ? n.toLowerCase() : n;
}

export interface ChangeRow {
    rel: string;
    kind: string;
    bytes: number;
}

/** One sub-agent's private overlay over the real workspace. */
export class WorkCopy {
    id: string;
    root: string;
    source_root: string;
    label: string;
    kind = "overlay";
    /** Workspace-relative paths the sub-agent asked to delete. */
    deleted: Set<string>;

    constructor(opts: {
        id: string;
        root: string;
        source_root: string;
        label?: string;
    }) {
        this.id = opts.id;
        this.root = opts.root;
        this.source_root = opts.source_root;
        this.label = opts.label ?? "";
        this.deleted = new Set();
    }

    cleanup(): void {
        discard(this);
    }

    // ── path mapping ─────────────────────────────────────────────────────

    /** Workspace-relative form of a real path, or null if it's outside. */
    rel(real_path: string): string | null {
        let r = nodePath.relative(_norm(this.source_root), _norm(real_path));
        if (r === "") r = ".";
        // Python raises ValueError for a cross-drive path (different root).
        if (nodePath.isAbsolute(r)) return null;
        if (r === "." || r.startsWith(".." + nodePath.sep) || r === "..") return null;
        return r.replaceAll("\\", "/");
    }

    overlay_path(real_path: string): string | null {
        const r = this.rel(real_path);
        if (r === null) return null;
        return nodePath.join(this.root, ...r.split("/"));
    }

    // ── write-side operations ────────────────────────────────────────────

    /**
     * Overlay path for a write, seeded from the real file when needed.
     * `seed=true` is what makes `edit_file` correct inside an overlay: it does
     * read→replace→write, and without the pre-image the read would fail.
     */
    prepare(real_path: string, seed = true): string | null {
        const dest = this.overlay_path(real_path);
        if (dest === null) return null;
        fs.mkdirSync(nodePath.dirname(dest), { recursive: true });
        if (seed && !fs.existsSync(dest) && _isfile(real_path)) {
            try {
                if (_filesize(real_path) <= MAX_SEED_BYTES) {
                    fs.copyFileSync(real_path, dest);
                }
            } catch {
                /* a failed seed degrades to "write from scratch", not a crash */
            }
        }
        // A path that was tombstoned and is now being written again is alive.
        const r = this.rel(real_path);
        if (r !== null) this.deleted.delete(r);
        return dest;
    }

    /** Record "the sub-agent deleted this". Returns whether it was recorded. */
    tombstone(real_path: string): boolean {
        const r = this.rel(real_path);
        if (r === null) return false;
        this.deleted.add(r);
        // Drop any overlay copy: keeping it would make the merge see both a new
        // version AND a delete for the same path.
        const dest = this.overlay_path(real_path);
        if (dest !== null && fs.existsSync(dest)) {
            try {
                if (_isfile(dest)) fs.rmSync(dest);
                else fs.rmSync(dest, { recursive: true, force: true });
            } catch {
                /* fail-open: 可选增强，失败不影响主流程 */
            }
        }
        this.save();
        return true;
    }

    save(): void {
        try {
            fs.writeFileSync(
                nodePath.join(this.root, MANIFEST),
                JSON.stringify({
                    id: this.id,
                    label: this.label,
                    sourceRoot: this.source_root,
                    deleted: [...this.deleted].sort(),
                }),
                "utf-8",
            );
        } catch {
            /* fail-open: 可选增强，失败不影响主流程 */
        }
    }

    // ── read-side: what did this sub-agent actually change? ──────────────

    /** Every change this overlay holds, as `{rel, kind, bytes}` rows. */
    changes(): ChangeRow[] {
        const rows: ChangeRow[] = [];
        for (const full of _walk_files(this.root)) {
            if (_norm(full) === _norm(nodePath.join(this.root, MANIFEST))) continue;
            const rel = nodePath
                .relative(this.root, full)
                .replaceAll("\\", "/");
            let size = 0;
            try {
                size = fs.statSync(full).size;
            } catch {
                size = 0;
            }
            rows.push({ rel, kind: "write", bytes: size });
        }
        for (const rel of [...this.deleted].sort()) {
            rows.push({ rel, kind: "delete", bytes: 0 });
        }
        rows.sort((a, b) =>
            a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
        );
        return rows;
    }

    /** Summary for the parent: which paths, how many, and where they live. */
    report(): Record<string, unknown> {
        const rows = this.changes();
        return {
            id: this.id,
            label: this.label,
            root: this.root,
            changes: rows,
            paths: rows.map((r) => r.rel),
        };
    }
}

/**
 * Live overlays by root path, so a tool call holding only the ctx string can
 * find the object that knows the tombstones. Removed by `discard`.
 */
const _live = new Map<string, WorkCopy>();

function _walk_files(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop() as string;
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = nodePath.join(dir, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.isFile()) out.push(full);
        }
    }
    return out;
}

function _isfile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

function _isdir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function _filesize(p: string): number {
    try {
        return fs.statSync(p).size;
    } catch {
        return 0;
    }
}

/**
 * Open a fresh overlay over `source_root`. null when isolation is off or the
 * source isn't a usable directory (the caller then writes directly — the
 * pre-UA3 behaviour, still correct, just not isolated).
 */
export function create(source_root: string, label = ""): WorkCopy | null {
    if (!WORK_COPY_ENABLED || !source_root || !_isdir(source_root)) return null;
    const wc_id = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
    let root: string;
    try {
        root = fs.mkdtempSync(nodePath.join(_overlay_root(), `wc-${wc_id}-`));
    } catch {
        return null;
    }
    return _register(source_root, root, wc_id, label);
}

/**
 * Open an overlay at a caller-chosen path (shadow workspace sessions). Unlike
 * `create`, the overlay lives under the workspace so local deploys can inspect
 * or delete staged changes on disk.
 */
export function open_at(
    source_root: string,
    overlay_root: string,
    wc_id = "",
    label = "",
): WorkCopy | null {
    if (!WORK_COPY_ENABLED || !source_root || !_isdir(source_root)) return null;
    const root = nodePath.resolve(overlay_root);
    try {
        fs.mkdirSync(root, { recursive: true });
    } catch {
        return null;
    }
    return _register(source_root, root, wc_id || crypto.randomUUID().replaceAll("-", "").slice(0, 8), label);
}

function _register(source_root: string, root: string, wc_id: string, label: string): WorkCopy {
    const wc = new WorkCopy({ id: wc_id, root, source_root: nodePath.resolve(source_root), label });
    wc.save();
    _live.set(_norm(root), wc);
    return wc;
}

/** The overlay this tool call should write into, if any. */
export function for_ctx(ctx: unknown): WorkCopy | null {
    if (ctx === null || typeof ctx !== "object" || Array.isArray(ctx)) return null;
    const root = (ctx as Record<string, unknown>)[CTX_KEY];
    if (!root) return null;
    return _live.get(_norm(String(root))) ?? null;
}

/**
 * Map a real path to its overlay location. Unchanged when not isolated.
 * Deliberately total and silent: every mutating file tool calls this, and the
 * main agent (no overlay in ctx) must get exactly the path it passed in.
 */
export function redirect_write(p: string, ctx: unknown, seed = true): string {
    const wc = for_ctx(ctx);
    if (wc === null) return p;
    return wc.prepare(p, seed) ?? p;
}

/**
 * Record a delete against the overlay. False when not isolated (delete for
 * real). Callers must NOT touch the real file when this returns true.
 */
export function record_delete(p: string, ctx: unknown): boolean {
    const wc = for_ctx(ctx);
    if (wc === null) return false;
    return wc.tombstone(p);
}

/** Throw the overlay away. Used for failed sub-agents and after a merge. */
export function discard(wc: WorkCopy | null): void {
    if (wc === null) return;
    _live.delete(_norm(wc.root));
    try {
        fs.rmSync(wc.root, { recursive: true, force: true });
    } catch {
        /* mirror shutil.rmtree(ignore_errors=True) */
    }
}

/**
 * Workspace-relative paths that more than one overlay touched. File-level
 * granularity on purpose — resolving region-level conflicts needs a real
 * three-way merge, and getting it wrong silently produces the broken sum this
 * module exists to catch.
 */
export function find_conflicts(copies: WorkCopy[]): Record<string, string[]> {
    const seen = new Map<string, string[]>();
    for (const wc of copies) {
        const rels = new Set(wc.changes().map((r) => r.rel));
        for (const rel of rels) {
            const who = seen.get(rel);
            if (who) who.push(wc.label || wc.id);
            else seen.set(rel, [wc.label || wc.id]);
        }
    }
    const out: Record<string, string[]> = {};
    for (const [rel, who] of seen) {
        if (who.length > 1) out[rel] = who;
    }
    return out;
}

/**
 * Apply every non-conflicting change from `copies` to the real workspace.
 * Only pass overlays whose sub-agent SUCCEEDED — this function does not know
 * that and will happily apply a half-finished attempt.
 *
 * Returns `{applied, deleted, conflicts, errors}`. Nothing throws: a merge that
 * partly fails still has to report what did land.
 */
export function merge(copies: WorkCopy[]): Record<string, unknown> {
    const conflicts = find_conflicts(copies);
    const applied: string[] = [];
    const deleted: string[] = [];
    const errors: { path: string; by: string; error: string }[] = [];

    for (const wc of copies) {
        for (const row of wc.changes()) {
            const rel = row.rel;
            if (rel in conflicts) continue;
            const real = nodePath.join(wc.source_root, ...rel.split("/"));
            const release = write_lock(real);
            try {
                // Same lock the file tools take, so a merge can't race a write
                // the parent agent is doing on its own.
                if (row.kind === "delete") {
                    if (_isfile(real)) fs.rmSync(real);
                    else if (_isdir(real)) fs.rmdirSync(real);
                    deleted.push(rel);
                } else {
                    fs.mkdirSync(nodePath.dirname(real) || wc.source_root, { recursive: true });
                    fs.copyFileSync(nodePath.join(wc.root, ...rel.split("/")), real);
                    applied.push(rel);
                }
            } catch (exc) {
                errors.push({ path: rel, by: wc.label || wc.id, error: String(exc) });
            } finally {
                release();
            }
        }
    }

    return { applied, deleted, conflicts, errors };
}

/** One short paragraph for the parent agent's tool result. */
export function describe_merge(result: Record<string, unknown>): string {
    const bits: string[] = [];
    const applied = (result["applied"] as string[] | undefined) ?? [];
    const deleted = (result["deleted"] as string[] | undefined) ?? [];
    const conflicts = (result["conflicts"] as Record<string, string[]> | undefined) ?? {};
    const errors = (result["errors"] as { path: string; by: string; error: string }[] | undefined) ?? [];
    const n = applied.length + deleted.length;
    if (n) bits.push(`已合并 ${n} 个文件改动`);
    const conflictKeys = Object.keys(conflicts).sort();
    if (conflictKeys.length) {
        const detail = conflictKeys
            .map((p) => `${p}（${(conflicts[p] as string[]).join("、")}）`)
            .join("; ");
        bits.push(
            `有 ${conflictKeys.length} 个文件被多个子代理同时改了，都没有合并，需要你自己决定：${detail}`,
        );
    }
    for (const e of errors) {
        bits.push(`合并 ${e["path"]} 失败：${e["error"]}`);
    }
    return bits.join(" ");
}

// ── F4: merge 状态机────────────────────────────
// merge 枚举 {SAFE_MERGE=2, MERGE_WITH_CONFLICTS=3} 一等暴露给 UI。

export const MERGE_STATUS_EMPTY = "empty";
export const MERGE_STATUS_SAFE = "safe_merge";
export const MERGE_STATUS_CONFLICTS = "merge_with_conflicts";
export const MERGE_STATUS_FAILED = "merge_back_failed";

/** F4: 将 merge 结果判定为结构化状态。 */
export function describe_merge_status(result: Record<string, unknown>): string {
    const applied = (result["applied"] as unknown[] | undefined) ?? [];
    const deleted = (result["deleted"] as unknown[] | undefined) ?? [];
    const conflicts = (result["conflicts"] as Record<string, unknown> | undefined) ?? {};
    const errors = (result["errors"] as unknown[] | undefined) ?? [];

    // 判定优先级：errors > conflicts > safe > empty
    if (errors.length && applied.length === 0) return MERGE_STATUS_FAILED;
    if (Object.keys(conflicts).length) return MERGE_STATUS_CONFLICTS;
    if (applied.length || deleted.length) return MERGE_STATUS_SAFE;
    return MERGE_STATUS_EMPTY;
}

// PORT STATUS: confidence=high todos=[0]
// DIVERGENCE(port): shutil.copy2 copies bytes and restores mtime; Node's
// fs.copyFileSync copies bytes only. Nothing in this module (or its merge/
// validation consumers) reads file times, so no behaviour differs. Inherent to
// the runtime swap; revisit only if a future feature keys off mtimes.
