"use strict";
/**
 * patch_engine.ts 鈥?Hunk-level unified diff apply (FastApply pattern).
 *
 * Ported from `app/backend/patch_engine.py` (138 lines).
 *
 * RULEBOOK CITATIONS:
 * - 搂2 dataclass 鈫?interface + factory.
 * - 搂1 node: builtins only.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.apply_unified_patch = apply_unified_patch;
const _HUNK_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;
function _parse_hunks(patch) {
    const hunks = [];
    let current = null;
    for (const raw of patch.split("\n")) {
        if (raw.startsWith("diff ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("index ")) {
            continue;
        }
        const m = _HUNK_RE.exec(raw);
        if (m) {
            if (current)
                hunks.push(current);
            current = { old_start: parseInt(m[1], 10), new_start: parseInt(m[3], 10), lines: [] };
            continue;
        }
        if (current !== null && raw.length > 0 && " +-".includes(raw[0])) {
            current.lines.push(raw);
        }
    }
    if (current)
        hunks.push(current);
    return hunks;
}
function _strip_nl(s) {
    return s.replace(/\r?\n$/, "");
}
function _norm(s) {
    return _strip_nl(s).replace(/\t/g, "    ");
}
function _find_hunk_pos(lines, hunk) {
    const ctx = hunk.lines.filter((ln) => " -".includes(ln[0])).map((ln) => _strip_nl(ln.slice(1)));
    if (ctx.length === 0)
        return Math.max(0, hunk.old_start - 1);
    const hint = Math.max(0, hunk.old_start - 1);
    const candidates = [];
    for (let i = Math.max(0, hint - 8); i < Math.min(lines.length, hint + 8); i++)
        candidates.push(i);
    for (let i = 0; i < lines.length; i++)
        candidates.push(i);
    const seen = new Set();
    for (const pos of candidates) {
        if (seen.has(pos) || pos + ctx.length > lines.length)
            continue;
        seen.add(pos);
        const window = ctx.map((_, i) => _strip_nl(lines[pos + i]));
        const normWindow = window.map(_norm);
        const normCtx = ctx.map(_norm);
        if (window.every((v, i) => v === ctx[i]) || normWindow.every((v, i) => v === normCtx[i])) {
            return pos;
        }
    }
    return null;
}
function _apply_hunk(lines, hunk) {
    const pos = _find_hunk_pos(lines, hunk);
    if (pos === null)
        return [null, `context not found near line ${hunk.old_start}`];
    const out = [];
    let idx = pos;
    for (const ln of hunk.lines) {
        const kind = ln[0];
        const body = ln.slice(1);
        const body_nl = body + ((body.length > 0 || kind === "+") ? "\n" : "");
        if (kind === " ") {
            if (idx >= lines.length)
                return [null, `context extends past EOF at line ${idx + 1}`];
            if (_norm(lines[idx]) !== _norm(body_nl))
                return [null, `context mismatch at line ${idx + 1}`];
            out.push(lines[idx]);
            idx += 1;
        }
        else if (kind === "-") {
            if (idx >= lines.length)
                return [null, `delete past EOF at line ${idx + 1}`];
            if (_norm(lines[idx]) !== _norm(body_nl) && _strip_nl(lines[idx]) !== _strip_nl(body)) {
                return [null, `delete mismatch at line ${idx + 1}`];
            }
            idx += 1;
        }
        else if (kind === "+") {
            let nl = "\n";
            if (idx < lines.length) {
                nl = lines[idx].endsWith("\n") ? "\n" : "";
            }
            else if (out.length > 0) {
                nl = out[out.length - 1].endsWith("\n") ? "\n" : "";
            }
            else if (lines.length > 0) {
                nl = lines.some((l) => l.endsWith("\n")) ? "\n" : "";
            }
            out.push(body + nl);
        }
    }
    return [[...lines.slice(0, pos), ...out, ...lines.slice(idx)], ""];
}
function apply_unified_patch(content, patch) {
    if (!patch.trim())
        return { ok: false, error: "empty patch", content: "", hunks_applied: 0 };
    const hunks = _parse_hunks(patch);
    if (hunks.length === 0)
        return { ok: false, error: "no hunks found in patch", content: "", hunks_applied: 0 };
    const had_trailing_nl = content.endsWith("\n");
    let lines = content.split("\n");
    const reconstructed = lines.join("\n");
    // Re-split preserving line endings like Python's splitlines(keepends=True).
    const parts = [];
    let rest = content;
    while (rest.length > 0) {
        const nlIdx = rest.indexOf("\n");
        if (nlIdx === -1) {
            parts.push(rest.length > 0 ? rest : "");
            break;
        }
        parts.push(rest.slice(0, nlIdx + 1));
        rest = rest.slice(nlIdx + 1);
    }
    const linesWithEndings = parts.filter((p, i, arr) => !(i === arr.length - 1 && p === ""));
    if (content.length > 0 && !had_trailing_nl && linesWithEndings.length > 0) {
        const last = linesWithEndings[linesWithEndings.length - 1];
        linesWithEndings[linesWithEndings.length - 1] = last.replace(/\n$/, "");
    }
    let applied = 0;
    for (const hunk of hunks) {
        const [result, err] = _apply_hunk(linesWithEndings, hunk);
        if (result === null)
            return { ok: false, error: err, content: "", hunks_applied: applied };
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
