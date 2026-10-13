/**
 * image_extract.ts — port of app/backend/image_extract.py (unit 160, wave 7).
 *
 * SOURCE: app/backend/image_extract.py (201 lines) — digs images out of the
 * many provider response shapes (OpenAI content arrays, OpenRouter top-level
 * images, Anthropic blocks, Gemini inlineData, Responses output_image, the
 * Images API root `data` list) and squeezes content into plain text so the
 * historic `message.get("content") or ""` list-leak bug stays dead.
 *
 * RULEBOOK CITATIONS (§ numbering as in HANDOFF_V4 / RULEBOOK)
 *   §4 naming: python spellings verbatim — _as_dict, _push, _from_part,
 *     _walk_parts, normalize_content, extract, has_images.
 *   §2 dict key order: the pushed image literal is the contract —
 *     kind, data, url, mime, name.
 *   §2 str()/or-chain semantics: `str(p.get("type") or "")` wraps the WHOLE
 *     or-chain (None/""/0 all become ""), and the second .get in every
 *     `a or b` chain runs only when the first VALUE is falsy — recorded
 *     candidates in the probe pin the read order.
 *
 * QUIRKS PINNED BY THE PARITY PROBE
 *   1. _push drops an entry entirely when BOTH data and url are empty after
 *      stripping — no None-handling burden downstream.
 *   2. A data: URI in the url slot is reclassified as data (url="").
 *   3. The output_image arm's fallback keys are ("result", "b64_json", "data")
 *      and the mime chain is mime_type OR mimeType; the Anthropic arm is the
 *      REVERSE order (mimeType or mime_type) — the asymmetry is verbatim.
 *   4. The Gemini loop tries inlineData then inline_data and returns True
 *      only when a hit has data; an inline dict WITHOUT data falls through
 *      to the next key (and then to False).
 *   5. _walk_parts collects str parts verbatim and dict parts' "text" key
 *      ONLY when it is a str (isinstance, not str()); it never looks at
 *      "type": a {"type":"output_text","text":"..."} part lands in texts.
 *   6. normalize_content joins the collected texts with "\n" after filtering
 *      falsy texts (an empty-string text block is dropped from the join but
 *      a whitespace-only one survives); a tuple/int content falls to
 *      str(content) with python repr ("(1, 2)").
 *   7. extract walks BOTH "output" and "outputs"; an item whose content is
 *      not a list goes through _from_part (so a plain image item is caught).
 *   8. The Images API root arm names the image from revised_prompt truncated
 *      to 80 chars, mime pinned to "image/png" for b64_json only.
 */

// ── python-semantics helpers (house style: file-local) ───────────────────────

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    if (v instanceof Map) return "dict";
    if (typeof v === "function") return "function";
    if (typeof v === "object") {
        const ctor = (v as { constructor?: { name?: string } }).constructor;
        return ctor && ctor.name && ctor.name !== "Object" ? ctor.name : "dict";
    }
    return typeof v;
}

/** house predicate: a value that IS a python dict — plain or prototype-less. */
function isPyDict(v: unknown): boolean {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    if (v instanceof Uint8Array || v instanceof Error) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
}

function pyOr<T, U>(a: T, b: U): T | U {
    return pyTruth(a) ? a : b;
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (typeof v === "function") return true;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (isPyDict(v)) return Object.keys(v as Record<string, unknown>).length > 0;
    return true;
}

function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return pyNumStr(v);
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
    if (v instanceof Map) {
        return "{" + Array.from(v.entries()).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    if (typeof v === "object") {
        const o = v as Record<string, unknown>;
        return "{" + Object.keys(o).map((k) => pyRepr(k) + ": " + pyRepr(o[k])).join(", ") + "}";
    }
    return String(v);
}

function pyRepr(v: unknown): string {
    if (typeof v === "string") {
        const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
        const esc = v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")
            .replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        if (quote === "'") return "'" + esc.replaceAll("'", "\\'") + "'";
        return '"' + esc.replaceAll('"', '\\"') + '"';
    }
    return pyStr(v);
}

/** python float repr for `str()`: integral values render int-style. */
function pyNumStr(v: number): string {
    if (Number.isNaN(v)) return "nan";
    if (v === Infinity) return "inf";
    if (v === -Infinity) return "-inf";
    return String(v);
}

/** python str.strip() with no args: strips isspace() chars EXACTLY.
 *  NOTE: JS `\s` matches U+FEFF (BOM) and Python's str.strip() does NOT, so we
 *  enumerate the CPython isspace() set verbatim (0x09-0x0D, 0x1C-0x1F, 0x20,
 *  0x85, 0xA0, 0x1680, 0x2000-0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000)
 *  instead of leaning on `\s` — U+FEFF and U+200B are kept, 0x1C-0x1F are cut. */
function pyStrip(s: string): string {
    const WS = "[\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
    return s.replace(new RegExp("^" + WS + "+"), "").replace(new RegExp(WS + "+$"), "");
}

/** python `x[:80]` counts CODE POINTS, not UTF-16 units — Array.from splits the
 *  former so an astral char inside the window is never truncated mid-surrogate. */
function pyTrunc80(s: string): string {
    return Array.from(s).slice(0, 80).join("");
}

function asciiLower(s: string): string {
    return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

class TypeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "TypeError"; }
}

/** python AttributeError, e.g. `(7).strip()` -> 'int' object has no attribute 'strip'. */
class AttributeErrorP extends Error {
    constructor(msg: string) { super(msg); this.name = "AttributeError"; }
}

/** python `(x or "").strip()`: truthy NON-str values reach `.strip()` on the raw
 *  object and raise AttributeError exactly like CPython; falsy values become ""
 *  first and strip cleanly. `str()` is deliberately NOT inserted (that was the bug
 *  the parity probe caught on push#num_name). */
function pyStripField(x: unknown): string {
    const v = pyOr(x, "");
    if (typeof v === "string") return pyStrip(v);
    throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'strip'`);
}

/** python missing-argument TypeError. */
function pyMissing(fname: string, names: readonly string[]): TypeErrorP {
    const q = names.map((s) => `'${s}'`);
    const list = q.length === 1
        ? (q[0] as string)
        : q.length === 2
            ? `${q[0]} and ${q[1]}`
            : q.slice(0, -1).join(", ") + ", and " + q[q.length - 1];
    const plural = names.length === 1 ? "positional argument" : "positional arguments";
    return new TypeErrorP(`${fname}() missing ${names.length} required ${plural}: ${list}`);
}

type JsonDict = Record<string, unknown>;

// ── _as_dict ─────────────────────────────────────────────────────────────────

export function _as_dict(x: unknown): JsonDict {
    return isPyDict(x) ? x as JsonDict : {};
}

// ── _push ────────────────────────────────────────────────────────────────────

/** 收敛成统一形状。空数据直接丢弃。 */
export function _push(out: unknown[], data: unknown = "", url: unknown = "",
               mime: unknown = "", name: unknown = ""): void {
    // python: data = (data or "").strip(); url = (url or "").strip()  — a truthy
    // non-str reaches .strip() and raises AttributeError, so we mirror the raw
    // `.strip()` (pyStripField) rather than stringifying first.
    let d = pyStripField(data);
    let u = pyStripField(url);
    if (!d && !u) return;
    // data: URI 出现在 url 位置很常见，按数据处理而不是按远程链接处理。
    if (u.startsWith("data:")) {
        // python: data, url = url, "" — the url VALUE becomes data and the
        // original data is DISCARDED (not a swap).
        d = u;
        u = "";
    }
    out.push({
        "kind": u ? "url" : "base64",
        "data": d,
        "url": u,
        "mime": asciiLower(pyStripField(mime)),
        "name": pyStripField(name),
    });
}

// ── _from_part ───────────────────────────────────────────────────────────────

/** 尝试把单个 content 块解析成图片。返回是否命中。 */
export function _from_part(part: unknown, out: unknown[]): boolean {
    const p = _as_dict(part);
    if (Object.keys(p).length === 0 && !isPyDict(part)) return false;
    if (!pyTruth(part)) return false;
    const ptype = asciiLower(pyStr(pyOr(p["type"], "")));

    // 形状 1 / 2：OpenAI image_url
    if (ptype === "image_url" || ptype === "input_image" || ptype === "output_image") {
        const iu0 = p["image_url"];
        if (typeof iu0 === "string") {
            _push(out, "", iu0);
            return true;
        }
        const iu = _as_dict(iu0);
        if (iu["url"]) {
            _push(out, "", pyStr(iu["url"]));
            return true;
        }
        // Responses API 的 output_image 有时把 base64 放在 result / b64_json
        for (const key of ["result", "b64_json", "data"]) {
            const v = p[key];
            if (typeof v === "string" && v) {
                const mimeChain = pyOr(p["mime_type"], p["mimeType"]);
                _push(out, v, "", pyStr(mimeChain === undefined ? "" : mimeChain));
                return true;
            }
        }
        return false;
    }

    // 形状 3：Anthropic image block
    if (ptype === "image") {
        const src = _as_dict(p["source"]);
        if (src["data"]) {
            _push(out, pyStr(src["data"]), "", pyStr(src["media_type"] === undefined ? "" : src["media_type"]));
            return true;
        }
        if (src["url"]) {
            _push(out, "", pyStr(src["url"]));
            return true;
        }
        // 少数网关把 base64 直接挂在块上
        const blockData = p["data"];
        if (typeof blockData === "string" && blockData) {
            const mimeChain = pyOr(p["mimeType"], p["mime_type"]);
            _push(out, blockData, "", pyStr(mimeChain === undefined ? "" : mimeChain));
            return true;
        }
        return false;
    }

    // 形状 4：Gemini inlineData（驼峰与下划线两种都见过）
    for (const key of ["inlineData", "inline_data"]) {
        const inline = _as_dict(p[key]);
        if (inline["data"]) {
            const mimeChain = pyOr(inline["mimeType"], inline["mime_type"]);
            _push(out, pyStr(inline["data"]), "", pyStr(mimeChain === undefined ? "" : mimeChain));
            return true;
        }
    }

    return false;
}

// ── _walk_parts ──────────────────────────────────────────────────────────────

/** 遍历 content 数组，抽图片、同时把文字块收集出来。 */
export function _walk_parts(parts: unknown, out: unknown[]): string[] {
    const texts: string[] = [];
    for (const part of (pyOr(parts, []) as unknown[])) {
        if (typeof part === "string") {
            texts.push(part);
            continue;
        }
        if (_from_part(part, out)) continue;
        const p = _as_dict(part);
        // 文字块：{"type":"text","text":"..."} 或 Responses 的 output_text
        const tv = p["text"];
        if (typeof tv === "string") texts.push(tv);
    }
    return texts;
}

// ── normalize_content ────────────────────────────────────────────────────────

/** 把 content（字符串或数组）压成纯文字，顺路把图片挖进 out。 */
export function normalize_content(content: unknown, out: unknown[]): string {
    if (arguments.length < 2) {
        throw pyMissing("normalize_content", ["content", "out"].slice(arguments.length));
    }
    if (content === null || content === undefined) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return _walk_parts(content, out).filter((t) => t).join("\n");
    }
    return pyStr(content);
}

// ── extract ──────────────────────────────────────────────────────────────────

/** 从一条 assistant message（以及可选的完整响应体）里取出文字与图片。 */
export function extract(message: unknown, raw?: unknown): [string, unknown[]] {
    if (arguments.length === 0) throw pyMissing("extract", ["message"]);
    const images: unknown[] = [];
    const msg = _as_dict(message);

    const text = normalize_content(msg["content"], images);

    // 形状 2：图片单独挂在 message.images
    const extra = msg["images"];
    if (Array.isArray(extra)) {
        _walk_parts(extra, images);
    }

    // Responses API：message.output / message.content 之外还有 output 数组
    for (const containerKey of ["output", "outputs"]) {
        const container = msg[containerKey];
        if (Array.isArray(container)) {
            for (const item of container) {
                const inner = _as_dict(item)["content"];
                if (Array.isArray(inner)) {
                    _walk_parts(inner, images);
                } else {
                    _from_part(item, images);
                }
            }
        }
    }

    // 形状 6：Images API 直连 —— 图片在响应根上，不在 message 里
    const root = _as_dict(raw);
    const rootData = root["data"];
    if (Array.isArray(rootData)) {
        for (const item of rootData) {
            const d = _as_dict(item);
            if (d["b64_json"]) {
                const nm = pyOr(d["revised_prompt"], "");
                _push(images, pyStr(d["b64_json"]), "", "image/png", pyTrunc80(pyStr(nm)));
            } else if (d["url"]) {
                const nm = pyOr(d["revised_prompt"], "");
                _push(images, "", pyStr(d["url"]), "", pyTrunc80(pyStr(nm)));
            }
        }
    }

    return [text, images];
}

// ── has_images ───────────────────────────────────────────────────────────────

/** 便捷判断，避免调用方为了判空而做完整解析。 */
export function has_images(message: unknown, raw?: unknown): boolean {
    if (arguments.length === 0) throw pyMissing("has_images", ["message"]);
    return pyTruth(extract(message, raw)[1]);
}

// PORT STATUS: confidence=high todos=[0]
