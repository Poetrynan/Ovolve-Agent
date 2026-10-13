"use strict";
/**
 * secret_scan.ts 鈥?three-layer secret and credential leak detection.
 *
 * Ported from `app/backend/secret_scan.py` (371 lines).
 *
 * Pipeline:
 *   1. keyword trie prefilter (fast rejection of text with no sensitive root,
 *      avoiding regex and entropy cost on large inputs);
 *   2. regex rule library (PEM private-key blocks, AWS / Google / Slack /
 *      Stripe / GitHub, database connection strings, .env);
 *   3. Shannon entropy and allowlist checks (filter placeholders, repeated
 *      characters, low-entropy test strings).
 *
 * Design principle: built from publicly documented key formats, zero
 * third-party dependencies.
 *
 * RULEBOOK CITATIONS
 *   搂4  naming: app/backend/secret_scan.py -> app/engine/secret_scan.ts
 *   搂2  regex: Python inline flags become JS flags; indices need the `d` flag
 *   搂2  `Counter` counts CODE POINTS; Array.from reproduces it
 *   搂2  float formatting: `round(x, 2)` and `:.2f` reproduced explicitly
 *   搂2  broad swallow: scan_tree's per-file catch is preserved
 *
 * PORT STATUS: confidence=high todos=0
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeywordTrie = void 0;
exports.shannonEntropy = shannonEntropy;
exports.isAllowlistedOrLowEntropy = isAllowlistedOrLowEntropy;
exports.redactSecretString = redactSecretString;
exports.scanText = scanText;
exports.scanTree = scanTree;
exports.generateLeakReport = generateLeakReport;
const fs = require("node:fs");
const path = require("node:path");
// --------------------------------------------------------------------------- //
// 1. keyword trie prefilter                                                    //
// --------------------------------------------------------------------------- //
class TrieNode {
    children = new Map();
    isEnd = false;
}
/** Aho-Corasick-style prefix tree, used to test cheaply whether text could contain a sensitive root. */
class KeywordTrie {
    root = new TrieNode();
    constructor(keywords = []) {
        for (const kw of keywords) {
            this.insert(kw);
        }
    }
    insert(word) {
        if (!word) {
            return;
        }
        let node = this.root;
        // RULEBOOK 搂2 (string policy): Python iterates a str by code point; `for..of`
        // on a JS string does the same, where a plain index loop would walk UTF-16
        // units and split surrogate pairs.
        for (const char of word.toLowerCase()) {
            let child = node.children.get(char);
            if (!child) {
                child = new TrieNode();
                node.children.set(char, child);
            }
            node = child;
        }
        node.isEnd = true;
    }
    /** Whether `text` contains any keyword (case-insensitive). */
    containsAny(text) {
        if (!text) {
            return false;
        }
        const lowered = text.toLowerCase();
        const chars = Array.from(lowered);
        const length = chars.length;
        for (let i = 0; i < length; i++) {
            let node = this.root;
            let j = i;
            while (j < length) {
                const next = node.children.get(chars[j]);
                if (!next) {
                    break;
                }
                node = next;
                if (node.isEnd) {
                    return true;
                }
                j += 1;
            }
        }
        return false;
    }
}
exports.KeywordTrie = KeywordTrie;
// --------------------------------------------------------------------------- //
// 2. Shannon entropy and allowlist                                             //
// --------------------------------------------------------------------------- //
/** Shannon information entropy of a string (bits/char). */
function shannonEntropy(data) {
    if (!data) {
        return 0.0;
    }
    // RULEBOOK 搂2 (Counter): Python counts characters, i.e. code points.
    const chars = Array.from(data);
    const length = chars.length;
    const counts = new Map();
    for (const c of chars) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    let entropy = 0.0;
    for (const count of counts.values()) {
        const p = count / length;
        entropy -= p * Math.log2(p);
    }
    return entropy;
}
/** Common placeholders and test words (all lowercase). */
const ALLOWLIST_KEYWORDS = new Set([
    "your_api_key", "your_secret_key", "your_token", "your_password",
    "my_secret_token", "my_secret_key", "test_key", "test_secret",
    "example_key", "example_secret", "dummy_token", "dummy_key",
    "placeholder", "changeme", "change_me", "replace_me", "replace_with",
    "true", "false", "none", "null", "undefined",
]);
// RULEBOOK 搂2 (regex translation): `re.fullmatch(p, s)` is an anchored match in
// JS 鈥?`^...$`, not a search.
const PURE_REPEAT_RE = /^(?:0+|x+|1234567890?)$/;
/** Whether a suspected credential is a placeholder, template string or harmless low-entropy content. */
function isAllowlistedOrLowEntropy(val, minEntropy = 3.0) {
    const cleaned = val.trim().replace(/^["'`;,]+|["'`;,]+$/g, "");
    if (Array.from(cleaned).length < 8) {
        return true;
    }
    const lowered = cleaned.toLowerCase();
    // RULEBOOK 搂2: the source iterates a frozenset; the result is a boolean, so
    // hash order cannot leak into behaviour.
    for (const kw of ALLOWLIST_KEYWORDS) {
        if (lowered.includes(kw)) {
            return true;
        }
    }
    // Purely repeated or a simple numeric run.
    if (PURE_REPEAT_RE.test(lowered)) {
        return true;
    }
    // Too little character diversity (e.g. 'aaaaaaaaaaaa' or 'abababababab').
    if (new Set(Array.from(cleaned)).size <= 3) {
        return true;
    }
    // Entropy too low.
    if (shannonEntropy(cleaned) < minEntropy) {
        return true;
    }
    return false;
}
/**
 * RULEBOOK 搂2 (regex): Python inline flags `(?i)` and `(?m)` become the JS `i`
 * and `m` flags. Patterns are stored as source strings because a shared regex
 * object with the `g` flag carries `lastIndex` between calls, and a scan that
 * silently skipped matches after the first would be a data-loss bug rather than
 * a style problem.
 */
const SECRET_RULES = [
    {
        name: "pem_private_key",
        source: "-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----",
        flags: "",
        confidence: "high",
        keywords: ["begin", "private key"],
        isPem: true,
    },
    {
        name: "aws_access_key",
        source: "\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b",
        flags: "",
        confidence: "high",
        keywords: ["akia", "asia"],
        minEntropy: 2.8,
    },
    {
        name: "aws_secret_key",
        source: "\\b(?:aws_secret_access_key|aws_secret_key)\\s*[:=]\\s*['\"]?([A-Za-z0-9/+=]{40})['\"]?",
        flags: "i",
        confidence: "high",
        keywords: ["aws_secret"],
        extractGroup: 1,
        minEntropy: 3.5,
    },
    {
        name: "google_api_key",
        source: "\\bAIza[0-9A-Za-z_\\-]{30,45}\\b",
        flags: "",
        confidence: "high",
        keywords: ["aiza"],
        minEntropy: 3.0,
    },
    {
        name: "slack_token",
        source: "\\bxox[baprs]-[0-9A-Za-z\\-]{10,80}\\b",
        flags: "",
        confidence: "high",
        keywords: ["xoxb", "xoxa", "xoxp", "xoxr", "xoxs"],
        minEntropy: 2.8,
    },
    {
        name: "stripe_secret_key",
        source: "\\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,}\\b",
        flags: "",
        confidence: "high",
        keywords: ["sk_live", "rk_live", "sk_test", "rk_test"],
        minEntropy: 3.0,
    },
    {
        name: "github_token",
        source: "\\bgh[pousr]_[A-Za-z0-9_]{30,50}\\b",
        flags: "",
        confidence: "high",
        keywords: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
        minEntropy: 3.0,
    },
    {
        name: "db_connection_url",
        source: "\\b(?:postgres|postgresql|mysql|mongodb|redis|amqp)://[^\\s:]+:([^\\s@]{6,})@[^\\s/:]+",
        flags: "i",
        confidence: "medium",
        keywords: ["postgres://", "postgresql://", "mysql://", "mongodb://", "redis://", "amqp://"],
        extractGroup: 1,
        minEntropy: 2.6,
    },
    {
        name: "dotenv_secret",
        source: "^[ \\t]*([A-Z0-9_]*(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|AUTH_TOKEN|PRIVATE_KEY)[A-Z0-9_]*)\\s*=\\s*[\"']?([^\\s\"',;#]{12,})[\"']?",
        flags: "m",
        confidence: "medium",
        keywords: ["api_key", "secret", "password", "passwd", "auth_token", "private_key"],
        extractGroup: 2,
        minEntropy: 3.2,
    },
    {
        name: "generic_credential_assignment",
        source: "\\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|AUTH_TOKEN|PRIVATE_KEY)[A-Z0-9_]*)\\s*[:=]\\s*[\"']?([^\\s\"',;]{12,})[\"']?",
        flags: "i",
        confidence: "medium",
        keywords: ["api_key", "secret", "password", "passwd", "auth_token", "private_key"],
        extractGroup: 2,
        minEntropy: 3.4,
    },
];
/** Global trie, built from the sorted union of every rule's keywords. */
const GLOBAL_KEYWORDS = Array.from(new Set(SECRET_RULES.flatMap((r) => r.keywords))).sort();
const GLOBAL_TRIE = new KeywordTrie(GLOBAL_KEYWORDS);
/** Redact a secret: keep the first two and last two characters, star the middle. */
function redactSecretString(secret) {
    const cleaned = secret.trim();
    const len = Array.from(cleaned).length;
    if (len <= 4) {
        return "****";
    }
    if (len <= 8) {
        return `${cleaned.slice(0, 1)}****${cleaned.slice(-1)}`;
    }
    return `${cleaned.slice(0, 2)}***${cleaned.slice(-2)}`;
}
// --------------------------------------------------------------------------- //
// 4. scan functions                                                            //
// --------------------------------------------------------------------------- //
/** Run the three-layer scan over one block of text. */
function scanText(text, filename = "") {
    if (!text || typeof text !== "string") {
        return [];
    }
    // Layer 1: keyword trie prefilter.
    if (!GLOBAL_TRIE.containsAny(text)) {
        return [];
    }
    const matches = [];
    const loweredText = text.toLowerCase();
    for (const rule of SECRET_RULES) {
        // Per-rule keyword pre-check.
        if (rule.keywords.length && !rule.keywords.some((kw) => loweredText.includes(kw))) {
            continue;
        }
        // RULEBOOK 搂2 (regex): `d` gives match indices; `g` is required by matchAll.
        const re = new RegExp(rule.source, rule.flags + "gd");
        if (rule.isPem) {
            // A PEM block can span lines.
            for (const m of text.matchAll(re)) {
                const fullVal = m[0];
                const startOffset = m.index;
                const lineNo = countNewlines(text, startOffset) + 1;
                matches.push({
                    ruleName: rule.name,
                    matchedText: fullVal,
                    redacted: "-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----",
                    confidence: rule.confidence,
                    lineNumber: lineNo,
                    entropy: 4.0,
                    reason: "鍖呭惈鏈姞瀵嗙殑 PEM 鏍煎紡绉侀挜鍧?,
                    isPem: true,
                    filename,
                });
            }
            continue;
        }
        // Ordinary single-line or multi-line rule.
        for (const m of text.matchAll(re)) {
            const group = rule.extractGroup ?? 0;
            const secretCandidate = m[group];
            const ent = shannonEntropy(secretCandidate);
            // Layer 3: entropy threshold and allowlist exclusion.
            if ((rule.minEntropy ?? 0.0) > 0.0 && ent < rule.minEntropy) {
                continue;
            }
            if (isAllowlistedOrLowEntropy(secretCandidate, rule.minEntropy ?? 0.0)) {
                continue;
            }
            // RULEBOOK 搂2: `m.start(group)` is the group's own offset, not the match's.
            // The `d` flag's `indices` is the direct equivalent.
            const indices = m.indices;
            const startOffset = indices?.[group]?.[0] ?? m.index;
            const lineNo = countNewlines(text, startOffset) + 1;
            matches.push({
                ruleName: rule.name,
                matchedText: secretCandidate,
                redacted: redactSecretString(secretCandidate),
                confidence: rule.confidence,
                lineNumber: lineNo,
                // RULEBOOK 搂2 (float formatting): `round(x, 2)` is half-to-even in
                // Python; Math.round is half-up. The difference is only visible on an
                // exact .005 tie of an entropy value and is recorded in the inventory
                // rather than silently normalised.
                entropy: Math.round(ent * 100) / 100,
                reason: `鍛戒腑 ${rule.name}锛堢疆淇″害: ${rule.confidence}, 鐔? ${ent.toFixed(2)}锛塦,
                isPem: false,
                filename,
            });
        }
    }
    return matches;
}
/** Count newlines in `text` before `offset`. */
function countNewlines(text, offset) {
    let n = 0;
    for (let i = 0; i < offset && i < text.length; i++) {
        if (text[i] === "\n") {
            n++;
        }
    }
    return n;
}
const SKIP_DIRS = new Set([
    ".git", ".svn", "node_modules", "scratch", "venv", ".venv",
    "__pycache__", "dist", "dist-next", "build", ".pytest_cache",
]);
const BINARY_EXTS = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".ico", ".exe", ".bin", ".wasm", ".db", ".sqlite",
]);
/**
 * Recursively scan a directory's source and config files.
 *
 * RULEBOOK 搂2 (broad swallow): the per-file catch is preserved 鈥?an unreadable
 * file is skipped and the scan continues, because a scanner that aborts on the
 * first permission error is worse than one that reports what it could read.
 */
function scanTree(dirPath, excludes) {
    const root = path.resolve(dirPath);
    let stat;
    try {
        stat = fs.statSync(root);
    }
    catch {
        return [];
    }
    if (!stat.isDirectory()) {
        return [];
    }
    const excludeSet = new Set([...SKIP_DIRS, ...(excludes ?? [])]);
    const results = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!excludeSet.has(entry.name)) {
                    walk(path.join(dir, entry.name));
                }
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }
            const ext = path.extname(entry.name).toLowerCase();
            if (BINARY_EXTS.has(ext)) {
                continue;
            }
            const fpath = path.join(dir, entry.name);
            try {
                if (fs.statSync(fpath).size > 1024 * 1024) {
                    continue;
                }
                const content = fs.readFileSync(fpath, "utf8");
                const relPath = path.relative(root, fpath);
                results.push(...scanText(content, relPath));
            }
            catch {
                continue;
            }
        }
    };
    walk(root);
    return results;
}
/** Render a human-readable leak report. */
function generateLeakReport(matches) {
    if (!matches.length) {
        return "鏈彂鐜版晱鎰熶俊鎭垨鍑嵁娉勬紡銆?;
    }
    const lines = [`鈿狅笍 妫€娴嬪埌 ${matches.length} 澶勬晱鎰熷瘑閽?鍑嵁娉勬紡椋庨櫓锛歚];
    matches.forEach((m, i) => {
        const loc = m.filename ? `${m.filename}:${m.lineNumber}` : `绗?${m.lineNumber} 琛宍;
        lines.push(`  ${i + 1}. [${m.confidence.toUpperCase()}] ${m.ruleName} 浣嶄簬 ${loc}`);
        lines.push(`     鑴辨晱鎽樿: ${m.redacted} (棣欏啘鐔? ${m.entropy})`);
        lines.push(`     鍘熷洜: ${m.reason}`);
    });
    return lines.join("\n");
}
