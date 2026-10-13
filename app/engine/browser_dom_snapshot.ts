/**
 * browser_dom_snapshot.ts — Browser DOM snapshot and stable element ref protocol.
 *
 * Ported from `app/backend/browser_dom_snapshot.py` (194 lines).
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/browser_dom_snapshot.py -> app/engine/browser_dom_snapshot.ts
 *   §2  DOM_SNAPSHOT_JS is the python runtime VALUE of the triple-quoted
 *       literal (python `\\` -> `\` already applied); the dual probe pins it
 *       to byte equality, so the injected browser script cannot drift.
 *   §2  render_compact keeps every present-but-null nuance: "ref": None
 *       prints as "[None]" (python str(None)), "tag": None with a truthy
 *       role raises an uncaught AttributeError ('NoneType' object has no
 *       attribute 'lower'), "enabled": None -> "disabled"; evaluation ORDER
 *       inside the role gate (role.lower() before tag.lower()).
 *   §2  latent truncation bug replicated: rendered[:max_chars-35] with
 *       max_chars < 35 slices with a NEGATIVE stop (drops chars from the
 *       tail), not an error; slicing and length are codepoint-based.
 *   §2  register iterates `elements` directly — None raises TypeError
 *       'NoneType' object is not iterable; a str item raises AttributeError
 *       'str' object has no attribute 'get' (both uncaught by design).
 *   §2  resolve/get_element mirror `dict.get(tab_id, {}).get(ref)`: missing
 *       tab or ref -> None, and the ephemeral {} is not cached.
 *   §2  `aria != text` is python STRUCTURAL inequality (lists/dicts compare
 *       by value) — pyNeq reproduces it; `==` on scalars keeps identity.
 *   DIVERGENCE(port): python dicts → insertion-ordered Map stores (register
 *       returns the SAME live map the source returns as its live dict;
 *       aliasing preserved). One equivalence-class gap: python hashes
 *       True==1 and 5.0==5 so those refs collide as dict keys, while Map
 *       SameValueZero keeps them distinct — unreachable in practice since
 *       DOM refs are always 'eN' strings from the injected script.
 *
 * Stable element references (refs) for token-economic browser interaction.
 */

/** 浏览器侧注入脚本：提取可见交互元素为轻量文本表示（与 .py 逐字节同值）。 */
export const DOM_SNAPSHOT_JS = `(() => {
  const MAX_ELEMENTS = 120;
  const interactiveSelectors = 'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(document.querySelectorAll(interactiveSelectors));
  const results = [];

  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function getCssSelector(el) {
    if (el.id) {
      return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'));
    }
    const name = el.getAttribute('name');
    const tag = el.tagName.toLowerCase();
    if (name && (tag === 'input' || tag === 'textarea' || tag === 'select')) {
      return tag + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
    }
    const parts = [];
    let curr = el;
    while (curr && curr.nodeType === 1 && curr !== document.body && curr !== document.documentElement) {
      let selector = curr.tagName.toLowerCase();
      if (curr.id) {
        parts.unshift('#' + (window.CSS && CSS.escape ? CSS.escape(curr.id) : curr.id.replace(/[^a-zA-Z0-9_-]/g, '\\\\$&')));
        break;
      }
      let sibling = curr;
      let nth = 1;
      while (sibling = sibling.previousElementSibling) {
        if (sibling.tagName === curr.tagName) nth++;
      }
      selector += ':nth-of-type(' + nth + ')';
      parts.unshift(selector);
      curr = curr.parentElement;
    }
    return parts.join(' > ');
  }

  let count = 0;
  for (const el of nodes) {
    if (count >= MAX_ELEMENTS) break;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'svg') continue;
    if (!isVisible(el)) continue;

    count++;
    const ref = 'e' + count;
    const role = el.getAttribute('role') || '';
    let text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
    const placeholder = (el.getAttribute('placeholder') || '').slice(0, 40);
    const ariaLabel = (el.getAttribute('aria-label') || '').slice(0, 40);
    const val = (el.value !== undefined && el.value !== null ? String(el.value) : '').slice(0, 30);
    const rect = el.getBoundingClientRect();
    const enabled = !el.disabled && !el.getAttribute('aria-disabled');
    const selector = getCssSelector(el);

    results.push({
      ref: ref,
      tag: tag,
      role: role,
      text: text,
      placeholder: placeholder,
      ariaLabel: ariaLabel,
      value: val,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      enabled: Boolean(enabled),
      selector: selector,
    });
  }
  return results;
})()`;

// ---------------------------------------------------------------------------
// python-semantics helpers (file-local, same idioms as sibling ports)
// ---------------------------------------------------------------------------

class AttributeErrorP extends Error {
    constructor(msg: string) {
        super(`AttributeError: ${msg}`);
        this.name = "AttributeError";
    }
}
class TypeErrorP extends Error {
    constructor(msg: string) {
        super(`TypeError: ${msg}`);
        this.name = "TypeError";
    }
}

function pyTypeName(v: unknown): string {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "string") return "str";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (Array.isArray(v)) return "list";
    return "dict";
}

function pyTruth(v: unknown): boolean {
    if (v === null || v === undefined) return false;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return true;
}

/** python str()：True/False/None 拼写、数值字面量；容器 str()==repr()。 */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") return v;
    return pyRepr(v);
}

/** python repr()（f-string 里 list/dict 走的正是 repr）。 */
function pyRepr(v: unknown): string {
    if (typeof v === "string") {
        const q = v.includes("'") && !v.includes('"') ? '"' : "'";
        let esc = v.replaceAll("\\", "\\\\").replaceAll(q, "\\" + q);
        esc = esc.replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\t", "\\t");
        return q + esc + q;
    }
    if (Array.isArray(v)) {
        return "[" + v.map(pyRepr).join(", ") + "]";
    }
    if (isPyDict(v)) {
        return "{" + Object.entries(v).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
    }
    return pyStr(v);
}

function isPyDict(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function pyLower(v: unknown): string {
    if (typeof v === "string") {
        return v.toLowerCase();
    }
    throw new AttributeErrorP(`'${pyTypeName(v)}' object has no attribute 'lower'`);
}

/** python `for x in obj` iteration semantics for JSON-ish values. */
function iterPy(v: unknown): unknown[] {
    if (Array.isArray(v)) {
        return v;
    }
    if (typeof v === "string") {
        return Array.from(v);
    }
    if (isPyDict(v)) {
        return Object.keys(v);
    }
    throw new TypeErrorP(`'${pyTypeName(v)}' object is not iterable`);
}

/** python len()：码点数。 */
function pyLen(s: string): number {
    return Array.from(s).length;
}

/** python a != b：容器按值比较（list/dict 结构相等），标量按恒等。 */
function pyNeq(a: unknown, b: unknown): boolean {
    if (a === b) {
        return false;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return true;
        return a.some((x, i) => pyNeq(x, b[i]));
    }
    if (isPyDict(a) && isPyDict(b)) {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        if (ka.length !== kb.length) return true;
        return ka.some((k) => !(k in b) || pyNeq(a[k], (b as JsonDict)[k]));
    }
    return true;
}

/** python s[:end]，end 可为负（len+end 语义）。 */
function pySliceEnd(s: string, end: number): string {
    const arr = Array.from(s);
    const stop = end < 0 ? Math.max(arr.length + end, 0) : Math.min(end, arr.length);
    return arr.slice(0, stop).join("");
}

// ---------------------------------------------------------------------------
// RefRegistry
// ---------------------------------------------------------------------------

type JsonDict = Record<string, unknown>;

/** python dict 键的 hashability：list/dict 作键当场抛 TypeError（与源同点位）。 */
function assertHashable(v: unknown): void {
    if (Array.isArray(v) || isPyDict(v)) {
        throw new TypeErrorP(`unhashable type: '${pyTypeName(v)}'`);
    }
}

/** Manages mappings from stable element refs ('e12') to CSS selectors per tab. */
export class RefRegistry {
    private _tabs: Map<string, Map<unknown, unknown>> = new Map();
    private _meta: Map<string, Map<unknown, JsonDict>> = new Map();

    /** Register elements for a tab and record ref -> selector mappings.
     *  Returns the SAME live map the source returns as its live dict.
     *  Keys/values stay RAW (python dict semantics: int 5 and str "5" are
     *  different keys; unhashable refs raise like python dict assignment). */
    register(tabId: string, elements: unknown): Map<unknown, unknown> {
        const tabMap = new Map<unknown, unknown>();
        const metaMap = new Map<unknown, JsonDict>();
        for (const el of iterPy(elements)) {
            if (!isPyDict(el)) {
                throw new AttributeErrorP(`'${pyTypeName(el)}' object has no attribute 'get'`);
            }
            const ref = el["ref"] !== undefined ? el["ref"] : null;
            const selector = el["selector"] !== undefined ? el["selector"] : null;
            if (pyTruth(ref) && pyTruth(selector)) {
                assertHashable(ref);
                tabMap.set(ref, selector);
                metaMap.set(ref, el);
            }
        }
        this._tabs.set(tabId, tabMap);
        this._meta.set(tabId, metaMap);
        return tabMap;
    }

    /** Resolve an element ref to its CSS selector for a given tab. */
    resolve(tabId: string, ref: unknown): unknown {
        assertHashable(ref);
        return this._tabs.get(tabId)?.get(ref) ?? null;
    }

    /** Retrieve cached element metadata for an element ref. */
    getElement(tabId: string, ref: unknown): JsonDict | null {
        assertHashable(ref);
        return this._meta.get(tabId)?.get(ref) ?? null;
    }

    /** Invalidate all element refs for a tab (called upon navigation/reload). */
    invalidate(tabId: string): void {
        this._tabs.delete(tabId);
        this._meta.delete(tabId);
    }

    /** Clear all registered tab refs. */
    clear(): void {
        this._tabs.clear();
        this._meta.clear();
    }

    /** test hooks: insertion-ordered [key, value] entry pairs mirroring the
     *  python dict iteration order (plain JSON objects would reorder integer-
     *  like keys; the product-side Maps preserve order natively). */
    tabsEntries(): [string, [unknown, unknown][]][] {
        return Array.from(this._tabs, ([tab, m]) => [tab, Array.from(m)] as [string, [unknown, unknown][]]);
    }

    metaEntries(): [string, [unknown, JsonDict][]][] {
        return Array.from(this._meta, ([tab, m]) => [tab, Array.from(m)] as [string, [unknown, JsonDict][]]);
    }
}

const _sharedRefRegistry = new RefRegistry();

/** Access the global singleton RefRegistry. */
export function getRefRegistry(): RefRegistry {
    return _sharedRefRegistry;
}

/** Format interactive elements into a concise token-economic text representation.
 *
 * Example line:
 * [e1] button "Submit" (enabled)
 */
export function renderCompact(elements: unknown, maxChars: number = 4000): string {
    if (!pyTruth(elements)) {
        return "(No interactive elements found on page)";
    }

    const lines: string[] = [];
    for (const rawEl of iterPy(elements)) {
        if (!isPyDict(rawEl)) {
            throw new AttributeErrorP(`'${pyTypeName(rawEl)}' object has no attribute 'get'`);
        }
        const el = rawEl;
        const ref = "ref" in el ? el["ref"] : "e?";
        const tag = "tag" in el ? el["tag"] : "";
        const role = "role" in el ? el["role"] : "";
        const text = "text" in el ? el["text"] : "";
        const placeholder = "placeholder" in el ? el["placeholder"] : "";
        const aria = "ariaLabel" in el ? el["ariaLabel"] : "";
        const val = "value" in el ? el["value"] : "";
        const enabled = "enabled" in el ? el["enabled"] : true;
        const status = pyTruth(enabled) ? "enabled" : "disabled";

        let tagDesc: unknown = tag;
        // Object.create(null): python dict.get() never hits prototype-chain
        // members like "constructor".
        const redundantRoles: Record<string, string> = Object.assign(Object.create(null), {
            a: "link",
            button: "button",
            select: "combobox",
            textarea: "textbox",
        });
        // 求值顺序与源一致：role.lower() 先于 tag.lower()
        const roleLower = pyTruth(role) ? pyLower(role) : "";
        if (pyTruth(role) && roleLower !== pyLower(tag) && (redundantRoles[pyLower(tag)] ?? null) !== roleLower) {
            tagDesc = pyStr(tag) + ` [role=${pyStr(role)}]`;
        }

        const details: string[] = [];
        if (pyTruth(text)) {
            details.push(`"${pyStr(text)}"`);
        }
        if (pyTruth(placeholder)) {
            details.push(`placeholder="${pyStr(placeholder)}"`);
        }
        if (pyTruth(aria) && pyNeq(aria, text)) {
            details.push(`aria="${pyStr(aria)}"`);
        }
        if (pyTruth(val)) {
            details.push(`value="${pyStr(val)}"`);
        }

        const detailStr = details.join(" ");
        lines.push(
            `[${pyStr(ref)}] ${pyStr(tagDesc)}` +
                (detailStr ? ` ${detailStr}` : "") +
                ` (${status})`,
        );
    }

    let rendered = lines.join("\n");
    if (pyLen(rendered) > maxChars) {
        rendered = pySliceEnd(rendered, maxChars - 35) + "\n...(remaining elements truncated)";
    }
    return rendered;
}

// PORT STATUS: confidence=high todos=[0]
