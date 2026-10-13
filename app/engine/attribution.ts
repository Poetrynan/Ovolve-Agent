/**
 * attribution.ts — Attribution facts read from a capability's own files.
 *
 * Ported from `app/backend/attribution.py` (131 lines).
 *
 * A skill or plugin usually states its licence in its own metadata. When it
 * does not, the copyright line in a bundled LICENSE or NOTICE file is the
 * next best evidence, and it has the useful property of travelling with the
 * artifact: it cannot fall out of date the way a hand-maintained table can.
 *
 * This module only reports what a file actually says. It never guesses a
 * holder and never fills in a licence that is not evidenced somewhere on disk.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:fs).
 *   §2  Python `re` → JS RegExp. The copyright pattern's INPUT is not BMP-only
 *       (a LICENSE file can carry astral holder names), so the regex MUST be
 *       built with the `u` flag for `[^\r\n]{2,120}` to bound by code points as
 *       Python does, and `\p{Nd}` (not ASCII `\d`) to match Python's
 *       Unicode-aware `\d` in the year group (see attri backfill fixes below).
 *       Global RegExps are constructed per call — a shared `g`-flagged RegExp
 *       carries lastIndex across calls (HANDOFF §6.2).
 *   §2  `except OSError: continue` preserved verbatim (unreadable file → try
 *       the next candidate name).
 *   §4  naming: attribution.py → attribution.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Files that conventionally carry licence or copyright terms, most specific
 * first so a real LICENSE wins over a NOTICE that merely summarises. */
const _LICENSE_FILES: readonly string[] = [
  "LICENSE", "LICENSE.md", "LICENSE.txt", "LICENSE.rst",
  "LICENCE", "LICENCE.md", "LICENCE.txt",
  "COPYING", "COPYING.md", "COPYING.txt",
  "NOTICE", "NOTICE.md", "NOTICE.txt",
];

/** Ordered: the first match wins. Apache is checked before MIT because an
 * Apache text also contains permissive wording. */
const _LICENSE_HINTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Apache-2.0", ["apache license", "licensed under the apache"]],
  ["GPL-3.0", ["gnu general public license"]],
  ["MPL-2.0", ["mozilla public license"]],
  ["BSD-3-Clause", ["redistribution and use in source and binary forms"]],
  // Python 源里的 needle 是 "and/or"——正则元字符在 re.sub 上下文里没有，
  // 这里是字面 substring 匹配（`needle in head`），逐字保留。
  ["ISC", ["permission to use, copy, modify, and/or distribute"]],
  ["MIT", ["permission is hereby granted, free of charge", "mit license"]],
];

function makeCopyrightRe(): RegExp {
  // Python:
  //   copyright\s*(?:\(c\)|©?)?\s*
  //   (?:\d{4}\s*(?:[-–,]\s*\d{4}\s*)?)?
  //   (?P<holder>[^\r\n]{2,120})
  // The source's char class contains a bare © (mojibake-proofed as U+00A9
  // copyright sign); `\(c\)|©?` — the alternation with an OPTIONAL © makes
  // that group always matchable, so it is equivalent to `(?:\(c\)|©)?`.
  // BACKFILL FIX (attri, proven vs CPython 3.13): the `u` flag makes the
  // `[^\r\n]{2,120}` holder bound count CODE POINTS (as Python re does), and
  // `\p{Nd}` (not ASCII `\d`) matches Python's Unicode-aware `\d` for the year
  // group. Without these the holder truncates astral names at 120 UTF-16 units
  // and non-ASCII year digits (e.g. Arabic-Indic ٢٠٢٤) leak into the holder.
  return /copyright\s*(?:\(c\)|©)?\s*(?:\p{Nd}{4}\s*(?:[-–,]\s*\p{Nd}{4}\s*)?)?(?<holder>[^\r\n]{2,120})/giu;
}

/** Trailing punctuation and connective words that trail a real holder name. */
const _TRAILING = /[\s.,;:]+$|(?:\s+(?:and|&|\.)\s*)+$/i;

/** Return the text of the first licence-like file in `directory`.
 *
 * Returns an empty string when there is no such file, so callers can treat a
 * missing file and an unreadable one the same way. */
export function read_license_file(directory: string): string {
  if (!directory || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    return "";
  }
  for (const name of _LICENSE_FILES) {
    const p = path.join(directory, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      try {
        // Python reads 200_000 CHARS (code points) of a utf-8-decoded stream.
        // BACKFILL FIX (attri, proven vs CPython 3.13): `text.slice(0, 200_000)`
        // cut 200_000 UTF-16 UNITS, which for astral content returns fewer
        // characters than CPython. Slice by code point to match `fp.read`.
        const text = fs.readFileSync(p, "utf-8");
        return Array.from(text).slice(0, 200_000).join("");
      } catch {
        // except OSError: continue
        continue;
      }
    }
  }
  return "";
}

/** Extract the first copyright holder named in `text`.
 *
 * Only the holder is returned, not the year: the year belongs to the release
 * that carried it and goes stale, while the holder does not. */
export function sniff_copyright(text: string): string {
  if (!text) {
    return "";
  }
  for (const match of text.matchAll(makeCopyrightRe())) {
    let holder = (match.groups?.["holder"] ?? "").trim();
    holder = holder.replace(_TRAILING, "").trim();
    // "All rights reserved" and similar boilerplate is not a holder.
    if (!holder || holder.length < 3) {
      continue;
    }
    if (holder.toLowerCase().startsWith("all rights")) {
      continue;
    }
    // 只按**精确匹配**跳过样板词。用 startswith 会误伤——"Notice Only Ltd"
    // 这种把样板词当公司名的合法版权人会被整条略掉（真踩过）。
    if (["reserved", "notice", "copyright", "license"].includes(holder.toLowerCase())) {
      continue;
    }
    return holder;
  }
  return "";
}

/** Name the licence whose wording appears in `text`, else `""`.
 *
 * Returns an empty string rather than a guess when the wording is absent, so
 * an unknown licence reads as unknown instead of as MIT. */
export function infer_license(text: string): string {
  if (!text) {
    return "";
  }
  // Python `text[:4000].lower()` — SLICE first (code points), THEN lowercase.
  // BACKFILL FIX (attri, proven vs CPython 3.13): the previous order
  // (lower-then-slice) shifted the 4000 boundary whenever lowercasing changed
  // string length, so a licence hint straddling the boundary could be seen by
  // one runtime and not the other. Slice by code point first, then lowercase.
  const head = Array.from(text).slice(0, 4000).join("").toLowerCase();
  for (const [name, needles] of _LICENSE_HINTS) {
    for (const needle of needles) {
      if (head.includes(needle)) {
        return name;
      }
    }
  }
  return "";
}

export interface Attribution {
  license: string;
  author: string;
  copyright: string;
  upstream: string;
  /** Whether the licence came from the artifact itself rather than from
   * declared metadata, so a reader can tell how confident it is. */
  licenseFromFile: boolean;
}

/** Resolve attribution for one capability directory.
 *
 * Declared metadata wins; a licence file on disk is only consulted for the
 * fields the metadata left empty. Nothing is invented: a field with no
 * evidence stays empty. */
export function attribution_from(
  directory: string,
  declared_license = "",
  declared_author = "",
  declared_upstream = ""
): Attribution {
  // Python `str(declared_x or "")` uses TRUTHINESS, so 0/False/"" /None all
  // collapse to "". BACKFILL FIX (attri, proven vs CPython 3.13): `?? ""`
  // (nullish) kept `0`/`false` as the literal strings "0"/"false", which then
  // won the `||` fill and invented a licence/author with no on-disk evidence.
  // `|| ""` reproduces Python's `or` falsy-to-empty behaviour exactly.
  const dl = String(declared_license || "").trim();
  const da = String(declared_author || "").trim();
  const du = String(declared_upstream || "").trim();

  const text = read_license_file(directory);
  return {
    license: dl || infer_license(text),
    author: da || sniff_copyright(text),
    copyright: text ? sniff_copyright(text) : "",
    upstream: du,
    licenseFromFile: Boolean(text) && !dl,
  };
}
