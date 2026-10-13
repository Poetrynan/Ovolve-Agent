/**
 * patch_engine.ts — Hunk-level unified diff apply (FastApply pattern).
 *
 * Ported from `app/backend/patch_engine.py` (138 lines).
 *
 * RULEBOOK CITATIONS:
 * - §2 dataclass → interface + factory.
 * - §1 node: builtins only.
 * - §M: CPython `str.strip()` / `str.rstrip(chars)` semantics are imported from
 *   the shared mirror layer `server/http_server_keys.js` (`py_strip`,
 *   `rstrip_chars`) — a port MUST NOT private-mirror them.
 */

import { py_strip, rstrip_chars } from "./server/http_server_keys.js";

export interface Hunk {
    old_start: number;
    new_start: number;
    lines: string[];
}

export interface PatchResult {
    ok: boolean;
    content: string;
    error: string;
    hunks_applied: number;
}

const _HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

/**
 * CPython `str.splitlines(keepends)` mirror. Line boundaries (per CPython
 * `str.splitlines`, single UTF-16 units, all in the BMP): \n \r \r\n \v \f
 * \x1c \x1d \x1e \x85 \u2028 \u2029. `\r\n` is ONE boundary, not two. A trailing
 * boundary produces no empty trailing element, and `""` splits to `[]`.
 * `str.splitlines` has no §M export, so this faithful mirror lives in the port.
 */
const _LINE_BOUNDARIES = "\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029";
function _splitlines(s: string, keepends: boolean): string[] {
    const out: string[] = [];
    let start = 0;
    let i = 0;
    while (i < s.length) {
        const ch = s[i]!;
        let blen = 0;
        if (ch === "\r" && s[i + 1] === "\n") blen = 2;
        else if (_LINE_BOUNDARIES.includes(ch)) blen = 1;
        if (blen > 0) {
            out.push(keepends ? s.slice(start, i + blen) : s.slice(start, i));
            i += blen;
            start = i;
        } else {
            i += 1;
        }
    }
    if (start < s.length) out.push(s.slice(start));
    return out;
}

function _parse_hunks(patch: string): Hunk[] {
    const hunks: Hunk[] = [];
    let current: Hunk | null = null;
    for (const raw of _splitlines(patch, false)) {
        if (raw.startsWith("diff ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("index ")) {
            continue;
        }
        const m = _HUNK_RE.exec(raw);
        if (m) {
            if (current) hunks.push(current);
            current = { old_start: parseInt(m[1]!, 10), new_start: parseInt(m[3]!, 10), lines: [] };
            continue;
        }
        if (current !== null && raw.length > 0 && " +-".includes(raw[0]!)) {
            current.lines.push(raw);
        }
    }
    if (current) hunks.push(current);
    return hunks;
}

function _strip_nl(s: string): string {
    return rstrip_chars(s, "\r\n");
}

function _norm(s: string): string {
    return _strip_nl(s).replace(/\t/g, "    ");
}

function _find_hunk_pos(lines: string[], hunk: Hunk): number | null {
    const ctx = hunk.lines.filter((ln) => " -".includes(ln[0]!)).map((ln) => _strip_nl(ln.slice(1)));
    if (ctx.length === 0) return Math.max(0, hunk.old_start - 1);
    const hint = Math.max(0, hunk.old_start - 1);
    const candidates: number[] = [];
    for (let i = Math.max(0, hint - 8); i < Math.min(lines.length, hint + 8); i++) candidates.push(i);
    for (let i = 0; i < lines.length; i++) candidates.push(i);
    const seen = new Set<number>();
    for (const pos of candidates) {
        if (seen.has(pos) || pos + ctx.length > lines.length) continue;
        seen.add(pos);
        const window = ctx.map((_, i) => _strip_nl(lines[pos + i]!));
        const normWindow = window.map(_norm);
        const normCtx = ctx.map(_norm);
        if (window.every((v, i) => v === ctx[i]) || normWindow.every((v, i) => v === normCtx[i])) {
            return pos;
        }
    }
    return null;
}

function _apply_hunk(lines: string[], hunk: Hunk): [string[] | null, string] {
    const pos = _find_hunk_pos(lines, hunk);
    if (pos === null) return [null, `context not found near line ${hunk.old_start}`];
    const out: string[] = [];
    let idx = pos;
    for (const ln of hunk.lines) {
        const kind = ln[0]!;
        const body = ln.slice(1);
        const body_nl = body + ((body.length > 0 || kind === "+") ? "\n" : "");
        if (kind === " ") {
            if (idx >= lines.length) return [null, `context extends past EOF at line ${idx + 1}`];
            if (_norm(lines[idx]!) !== _norm(body_nl)) return [null, `context mismatch at line ${idx + 1}`];
            out.push(lines[idx]!);
            idx += 1;
        } else if (kind === "-") {
            if (idx >= lines.length) return [null, `delete past EOF at line ${idx + 1}`];
            if (_norm(lines[idx]!) !== _norm(body_nl) && _strip_nl(lines[idx]!) !== _strip_nl(body)) {
                return [null, `delete mismatch at line ${idx + 1}`];
            }
            idx += 1;
        } else if (kind === "+") {
            let nl = "\n";
            if (idx < lines.length) {
                nl = lines[idx]!.endsWith("\n") ? "\n" : "";
            } else if (out.length > 0) {
                nl = out[out.length - 1]!.endsWith("\n") ? "\n" : "";
            } else if (lines.length > 0) {
                nl = lines.some((l) => l.endsWith("\n")) ? "\n" : "";
            }
            out.push(body + nl);
        }
    }
    return [[...lines.slice(0, pos), ...out, ...lines.slice(idx)], ""] as [string[], string];
}

export function apply_unified_patch(content: string, patch: string): PatchResult {
    if (!py_strip(patch)) return { ok: false, error: "empty patch", content: "", hunks_applied: 0 };
    const hunks = _parse_hunks(patch);
    if (hunks.length === 0) return { ok: false, error: "no hunks found in patch", content: "", hunks_applied: 0 };
    const had_trailing_nl = content.endsWith("\n");
    const linesWithEndings = _splitlines(content, true);
    if (content.length > 0 && !had_trailing_nl && linesWithEndings.length > 0) {
        const last = linesWithEndings[linesWithEndings.length - 1]!;
        linesWithEndings[linesWithEndings.length - 1] = rstrip_chars(last, "\n");
    }
    let applied = 0;
    for (const hunk of hunks) {
        const [result, err] = _apply_hunk(linesWithEndings, hunk);
        if (result === null) return { ok: false, error: err, content: "", hunks_applied: applied };
        linesWithEndings.length = 0;
        linesWithEndings.push(...result);
        applied += 1;
    }
    let out = linesWithEndings.join("");
    if (had_trailing_nl && out.length > 0 && !out.endsWith("\n")) {
        out += "\n";
    }
    return { ok: true, content: out, error: "", hunks_applied: applied };
}

// PORT STATUS: confidence=high todos=[0]
