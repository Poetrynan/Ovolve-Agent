/**
 * command_guard.ts — shell grading primitives (the adapter's own fallback bodies).
 *
 * Support module, NOT a translated unit.
 *
 * `app/backend/rust_adapters/command_guard.py` is routed ABSORBED: the adapter
 * layer exists to give Python a Rust-backed path with a pure-Python fallback,
 * and after the move there is no Python left to bridge. This file is where the
 * fallback bodies live on the TS side, all five of them: `extract_hosts` and
 * `domain_suffix_match` (called by `path_policy`) plus `split_segments`,
 * `tokenize` and `fetch_pipe_exec` (called by `command_classifier`).
 *
 * The Rust core provides the same functions (`ovolve_core.command_guard`,
 * verified importable and working), so the FFI question is real — a TS caller
 * could reach the compiled core instead. It is not wired here because the
 * engine has no binding layer yet, and the fallback is behaviourally identical
 * by the adapter's own documentation: "Python fallback — identical semantics".
 *
 * RULEBOOK CITATIONS
 *   §1  no new dependency; regexes come from the source
 *   §2  regex: `re.I` -> the `i` flag; `\b` behaves the same for ASCII
 *   §2  `str.split()` (no separator) splits on runs of whitespace AND drops a
 *       leading/trailing run, so it is `/\s+/` + filter(""), not `split(/\s+/)`.
 *   §2  `str.strip(chars)` is a character-set strip, not prefix/suffix removal:
 *       implemented as a two-ended char loop over TOKEN_META.
 *   §2  `str.strip()` (no chars) uses `str.isspace()`; JS `trim()` uses `\s`.
 *       They disagree on U+0085 NEL (Python: space, JS: not) — see the
 *       DIVERGENCE note on splitSegments. Not reachable from command text
 *       produced by the tools in SHELL_TOOLS.
 *   §4  support module, so it carries no PORT STATUS trailer
 */

/** IPv4 literal pattern source (mechanical: no octet range validation — same as Rust). */
const RE_IPV4_SRC = "\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b";

/** Domain pattern source: dot-joined labels ending in an alphabetic TLD (same as Rust). */
const RE_DOMAIN_SRC = "\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}\\b";

/**
 * Compile one of the adapter's sources with python's `\b` semantics.
 *
 * RULEBOOK §2: python's `\b` is unicode-aware (word = str.isalnum() or "_")
 * while JS's is [A-Za-z0-9_]. Command text here is routinely Chinese, so an
 * ASCII boundary would report hosts the python original never sees
 * (`版本1.2.3.4` : python no-match, JS match). Each `\b` is rewritten into the
 * position-equivalent lookaround pair over [\p{L}\p{N}_] and compiled with `u`.
 */
const WORD_CLASS = "[\\p{L}\\p{N}_]";
const PY_BOUNDARY = "(?:(?<=" + WORD_CLASS + ")(?!" + WORD_CLASS + ")|(?<!" + WORD_CLASS + ")(?=" + WORD_CLASS + "))";
function pyRegex(source: string, flags: string): RegExp {
    return new RegExp(source.split("\\b").join(PY_BOUNDARY), "u" + flags);
}

/** Shell metacharacters stripped from token edges (mirrors TOKEN_META in Rust). */
const TOKEN_META = "\"'`$(){}<>|;&\\";
const TOKEN_META_CHARS = new Set<string>(Array.from(TOKEN_META));

/** python `str(x)` on the scalars a caller can hand us (None -> "None"). */
function pyStr(v: unknown): string {
    if (v === null || v === undefined) return "None";
    if (typeof v === "boolean") return v ? "True" : "False";
    return String(v);
}

/** python `s.split()` — runs of whitespace, no empty leading/trailing token. */
function pySplit(s: string): string[] {
    return s.split(/\s+/).filter((t) => t.length > 0);
}

/** python `s.strip(chars)` — strip any of `chars` from both ends. */
function stripChars(s: string, chars: Set<string>): string {
    let lo = 0;
    let hi = s.length;
    while (lo < hi && chars.has(s.charAt(lo))) lo++;
    while (hi > lo && chars.has(s.charAt(hi - 1))) hi--;
    return s.slice(lo, hi);
}

/**
 * Split command text into segments by shell control operators.
 *
 * Separators: `|`, `&`, `;`, newlines (covers `||`/`&&` as repeated chars).
 * Whitespace-only segments are dropped. Redirections are NOT separators — they
 * belong to a command.
 *
 * DIVERGENCE(port, whitespace): python `str.strip()` uses `str.isspace()`, JS
 * `trim()` uses `\s`; they disagree on U+0085. Equivalence argument: segment
 * text reaches here from SHELL_TOOLS command strings, which never carry NEL,
 * and the probes pin the ASCII/Chinese space classes instead.
 */
export function splitSegments(text: string): string[] {
    // RULEBOOK §2: the python comprehension calls strip() twice (filter + map);
    // same result, so do it once here and keep the order.
    return text.split(/[|&;\n\r]/).map((seg) => seg.trim()).filter((seg) => seg.length > 0);
}

/**
 * Tokenize one command segment: whitespace split + shell meta stripping.
 *
 * `sh -c "$(curl x)"` → ["sh", "-c", "curl", "x"]. Does not lowercase.
 */
export function tokenize(segment: string): string[] {
    const tokens: string[] = [];
    for (const raw of pySplit(segment)) {
        const t = stripChars(raw, TOKEN_META_CHARS);
        if (t) tokens.push(t);
    }
    return tokens;
}

/**
 * Detect the "remote fetch then direct execute" shape inside ONE segment.
 *
 * True when the segment contains both a fetcher token and an executor token
 * (case-insensitive). Pipelines are split into separate segments by
 * splitSegments; what remains in a single segment is command substitution /
 * process substitution — exactly this shape.
 */
export function fetchPipeExec(
    segment: string,
    fetchers: ArrayLike<unknown>,
    executors: ArrayLike<unknown>,
): boolean {
    const lowered = tokenize(segment).map((t) => t.toLowerCase());
    const fetchersL = new Set<string>(Array.from(fetchers, (f) => pyStr(f).toLowerCase()));
    const executorsL = new Set<string>(Array.from(executors, (e) => pyStr(e).toLowerCase()));
    // RULEBOOK §2: `any(...) and any(...)` — python evaluates both operands
    // before `and` short-circuits on the first falsy one; keep both calls.
    const hasFetcher = lowered.some((t) => fetchersL.has(t));
    const hasExecutor = lowered.some((t) => executorsL.has(t));
    return hasFetcher && hasExecutor;
}

/**
 * Extract hosts (IPv4 literals + domain names) from command text.
 *
 * Order of first appearance, deduplicated, lowercased. Conservative by design:
 * version-like tokens may surface as hosts — an egress false positive raises
 * REVIEW, a missed host never does.
 */
export function extractHosts(text: string): string[] {
  const found: Array<[number, string]> = [];
  for (const m of text.matchAll(pyRegex(RE_IPV4_SRC, "g"))) {
    found.push([m.index as number, m[0].toLowerCase()]);
  }
  for (const m of text.matchAll(pyRegex(RE_DOMAIN_SRC, "gi"))) {
    found.push([m.index as number, m[0].toLowerCase()]);
  }
  // RULEBOOK §2 (sort stability): Python sorts by start offset with a stable
  // sort, so equal offsets keep insertion order — IPv4 matches were appended
  // first. Array.prototype.sort has been stable since ES2019, so the tie order
  // is preserved here too.
  found.sort((a, b) => a[0] - b[0]);

  const hosts: string[] = [];
  for (const [, h] of found) {
    if (!hosts.includes(h)) {
      hosts.push(h);
    }
  }
  return hosts;
}

/**
 * Match a host against domain-suffix rules (allow/deny lists).
 *
 * Returns the matched rule, or null. Full-label suffix semantics:
 * `sub.evil.com` matches rule `evil.com`; `notevil.com` does NOT.
 */
export function domainSuffixMatch(host: string, domains: Iterable<string>): string | null {
  const list = Array.from(domains);
  const h = host.trim().replace(/^\.+|\.+$/g, "").toLowerCase();
  for (const raw of list) {
    const d = String(raw).trim().replace(/^\.+|\.+$/g, "").toLowerCase();
    if (!d) {
      continue;
    }
    if (h === d || h.endsWith("." + d)) {
      return d;
    }
  }
  return null;
}
