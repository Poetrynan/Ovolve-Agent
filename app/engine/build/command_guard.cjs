"use strict";
/**
 * command_guard.ts 鈥?host extraction and domain-suffix matching.
 *
 * Support module, NOT a translated unit.
 *
 * `app/backend/rust_adapters/command_guard.py` is routed ABSORBED: the adapter
 * layer exists to give Python a Rust-backed path with a pure-Python fallback,
 * and after the move there is no Python left to bridge. But `path_policy` calls
 * two of its functions 鈥?`extract_hosts` and `domain_suffix_match` 鈥?so their
 * pure implementations have to exist somewhere on the TS side.
 *
 * This is that somewhere: the adapter's own fallback bodies, ported verbatim.
 * The Rust core provides the same two functions (`ovolve_core.command_guard`,
 * verified importable and working), so the FFI question is real 鈥?a TS caller
 * could reach the compiled core instead. It is not wired here because the
 * engine has no binding layer yet, and the fallback is behaviourally identical
 * by the adapter's own documentation: "Python fallback 鈥?identical semantics".
 *
 * RULEBOOK CITATIONS
 *   搂1  no new dependency; regexes come from the source
 *   搂2  regex: `re.I` -> the `i` flag; `\b` behaves the same for ASCII
 *   搂4  support module, so it carries no PORT STATUS trailer
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractHosts = extractHosts;
exports.domainSuffixMatch = domainSuffixMatch;
/** IPv4 literal pattern (mechanical: no octet range validation 鈥?same as Rust). */
const RE_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
/** Domain pattern: dot-joined labels ending in an alphabetic TLD (same as Rust). */
const RE_DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi;
/**
 * Extract hosts (IPv4 literals + domain names) from command text.
 *
 * Order of first appearance, deduplicated, lowercased. Conservative by design:
 * version-like tokens may surface as hosts 鈥?an egress false positive raises
 * REVIEW, a missed host never does.
 */
function extractHosts(text) {
    const found = [];
    for (const m of text.matchAll(new RegExp(RE_IPV4.source, "g"))) {
        found.push([m.index, m[0].toLowerCase()]);
    }
    for (const m of text.matchAll(new RegExp(RE_DOMAIN.source, "gi"))) {
        found.push([m.index, m[0].toLowerCase()]);
    }
    // RULEBOOK 搂2 (sort stability): Python sorts by start offset with a stable
    // sort, so equal offsets keep insertion order 鈥?IPv4 matches were appended
    // first. Array.prototype.sort has been stable since ES2019, so the tie order
    // is preserved here too.
    found.sort((a, b) => a[0] - b[0]);
    const hosts = [];
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
function domainSuffixMatch(host, domains) {
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
