/**
 * shadow_session.ts — 主代理会话级影子工作区（staged overlay）
 *
 * Ported from `app/backend/shadow_session.py` (103 lines).
 *
 * 与 ``work_copy`` 子代理隔离共用同一套 COW overlay 语义，但 overlay 落在
 * ``<workspace>/.ovolve/shadow/session/<session_id>/overlay/``，便于本地部署用户
 * 直接查看、删除或手动合并。
 *
 * 模式（``OVOLVE_SHADOW_MODE``）：
 *   * ``off`` — 关闭影子工作区
 *   * ``validate`` — 直写工作区 + 完整校验（语法 + LSP + 项目探针）
 *   * ``staged`` — 写入 overlay，校验通过后由用户或自动策略合并到真实工作区
 *
 * RULEBOOK CITATIONS:
 * - §1 node: path builtins.
 * - §2 module-level dict → Map; dict-spread merge → object spread.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";

import { CTX_KEY, WorkCopy, discard, merge, open_at } from "./work_copy.js";
import { get_mode, shadow_enabled, shadow_staged } from "./shadow_config.js";

// RULEBOOK §4 `__init__.py` re-export rule: these names are reachable on Python's
// `shadow_session` module namespace (shadow_session.py:17-19 imports them at module
// level), and callers resolve them dynamically — router_modules/admission.ts reads
// `shadowSessionModule()["shadow_enabled"]` exactly where Python does
// `from shadow_session import shadow_enabled`. Without the re-export the lookup is
// undefined, the call raises TypeError into that module's swallow arm, and staged
// shadow injection silently stops happening.
export { CTX_KEY, WorkCopy, discard, merge, get_mode, shadow_enabled, shadow_staged };

const SESSION_SUBDIR = nodePath.join(".ovolve", "shadow", "session");
export { SESSION_SUBDIR };

const _sessions = new Map<string, WorkCopy>();

export function overlay_dir(workspace: string, session_id: string): string {
    return nodePath.join(workspace, SESSION_SUBDIR, session_id, "overlay");
}

export function session_meta_dir(workspace: string, session_id: string): string {
    return nodePath.join(workspace, SESSION_SUBDIR, session_id);
}

function _isdir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

/** Open or return the session overlay. null when shadow is off. */
export function ensure_session(session_id: string, workspace: string): WorkCopy | null {
    if (!shadow_staged() || !session_id || !workspace) return null;
    if (!_isdir(workspace)) return null;
    const existing = _sessions.get(session_id);
    if (existing) return existing;
    const ovl = overlay_dir(workspace, session_id);
    const wc = open_at(
        workspace,
        ovl,
        session_id.slice(0, 16),
        `shadow:${session_id.slice(0, 8)}`,
    );
    if (wc) _sessions.set(session_id, wc);
    return wc;
}

export function get_session(session_id: string): WorkCopy | null {
    return _sessions.get(session_id) ?? null;
}

/** Attach overlay root to tool context for staged writes. */
export function inject_context(
    session_id: string,
    workspace: string,
    context: Record<string, unknown>,
): void {
    const wc = ensure_session(session_id, workspace);
    if (wc === null) return;
    context[CTX_KEY] = wc.root;
    context["shadow_session_id"] = session_id;
    context["shadow_staged"] = true;
}

/** Merge overlay into the real workspace and tear down the session. */
export function apply_session(session_id: string): Record<string, unknown> {
    const wc = _sessions.get(session_id);
    _sessions.delete(session_id);
    if (wc === undefined) {
        return { applied: [], deleted: [], conflicts: {}, errors: [] };
    }
    const result = merge([wc]);
    discard(wc);
    return result;
}

export function discard_session(session_id: string): void {
    const wc = _sessions.get(session_id);
    _sessions.delete(session_id);
    if (wc !== undefined) discard(wc);
}

export function status(session_id: string, workspace: string): Record<string, unknown> {
    let wc = _sessions.get(session_id) ?? null;
    if (wc === null && shadow_staged()) {
        wc = ensure_session(session_id, workspace);
    }
    if (wc === null) {
        return {
            session_id,
            enabled: shadow_enabled(),
            mode: get_mode(),
            staged: false,
            changes: [],
            paths: [],
        };
    }
    const report = wc.report();
    return {
        session_id,
        enabled: shadow_enabled(),
        mode: get_mode(),
        staged: true,
        overlay_root: wc.root,
        changes: (report["changes"] as unknown[] | undefined) ?? [],
        paths: (report["paths"] as unknown[] | undefined) ?? [],
    };
}

// PORT STATUS: confidence=high todos=[0]
// DIVERGENCE(port): the source's odd `__import__("shadow_config").get_mode()`
// in status() is equivalent to a direct get_mode() call (same module, same
// function, resolved at call time in Python too) — ported as the direct call.
