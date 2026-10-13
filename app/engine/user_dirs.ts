/**
 * user_dirs.ts — the single source of truth for Ovolve user-data paths.
 *
 * Ported from `app/backend/user_dirs.py` (33 lines).
 *
 * All user-level data lands in `~/.ovolve`. `OVOLVE_DB_DIR` overrides the
 * database directory (tests, multi-instance isolation). Every module that needs
 * a user-level path reads it from here instead of hardcoding one.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/user_dirs.py -> app/engine/user_dirs.ts
 *   §2  module-level mutable state: the memoised home directory is preserved,
 *       including the fact that the env var is read on every call
 *
 * §DIVERGENCE 1 (resolved in this file, backfill re-gate u-bf1): the batch-era
 *   port computed `path.join(os.homedir(), BRAND_DIR)`. Measured against the
 *   source on this deployment (tmp/user_dirs_measure_py.out.txt,
 *   tmp/user_dirs_measure2_py.out.txt, tmp/user_dirs_measure_diff.txt) that
 *   diverged in 11 of 24 home shapes, because
 *     - `os.homedir()` falls back to the OS profile where CPython's
 *       `Path.home()` raises RuntimeError, and it answers for `USERPROFILE=""`
 *       / `USERPROFILE="D:"` where libuv raises ENOENT; and
 *     - `path.join()` collapses `.`/`..` segments that `PureWindowsPath` keeps
 *       verbatim (`D:\a\..\home\.ovolve` is what the source really returns).
 *   The port therefore transcribes the two standard libraries the source
 *   actually uses — `ntpath.expanduser`/`ntpath.splitroot`/`ntpath.join` and
 *   `pathlib.PurePath._parse_path`/`._format_parsed_parts`/`__truediv__` —
 *   bug for bug, and memoises the same `_raw_paths` list a `Path` object would
 *   carry. Like `server/http_server_s3.ts` §2 only the Windows flavour is
 *   reproduced: on this deployment `Path.home()` resolves through `ntpath`, and
 *   `os.homedir()` is deliberately not consulted at all.
 *
 * PORT STATUS: confidence=high todos=0
 */

/** `ntpath.sep` / the two separator classes `ntpath.join` tests against. */
const SEP = "\\";
const SEPS = "\\/";
const COLON_SEPS = ":\\/";
/** `ntpath.unc_prefix` — `\\?\UNC\` makes the server/share start at offset 8. */
const UNC_PREFIX = "\\\\?\\UNC\\";

/** Python-side `RuntimeError`, whose `name` both probes record verbatim. */
class RuntimeErrorP extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "RuntimeError";
  }
}

export const BRAND_DIR = ".ovolve";
export const DB_DIR_ENV = "OVOLVE_DB_DIR";

/** `p.replace(altsep, sep)`: every `/` becomes `\` (ntpath's `normp`). */
function normSep(p: string): string {
  return p.split("/").join(SEP);
}

/**
 * `ntpath.splitroot` (3.13 Lib/ntpath.py, str branch) — returns
 * `[drive, root, tail]`. Note the two UNC early exits return the **caller's**
 * string as the drive (mirroring `return p, empty, empty`), so a `\\srv` shape
 * with no share keeps its separators untouched.
 */
function ntpSplitroot(p: string): [string, string, string] {
  const normp = normSep(p);
  if (normp.slice(0, 1) === SEP) {
    if (normp.slice(1, 2) === SEP) {
      const start = normp.slice(0, 8).toUpperCase() === UNC_PREFIX ? 8 : 2;
      const index = normp.indexOf(SEP, start);
      if (index === -1) return [p, "", ""];
      const index2 = normp.indexOf(SEP, index + 1);
      if (index2 === -1) return [p, "", ""];
      return [p.slice(0, index2), p.slice(index2, index2 + 1), p.slice(index2 + 1)];
    }
    // Relative path with root, e.g. \Windows
    return ["", p.slice(0, 1), p.slice(1)];
  } else if (normp.slice(1, 2) === ":") {
    if (normp.slice(2, 3) === SEP) return [p.slice(0, 2), p.slice(2, 3), p.slice(3)];
    // Relative path with drive, e.g. X:Windows
    return [p.slice(0, 2), "", p.slice(2)];
  }
  return ["", "", p];
}

/**
 * `ntpath.join` (3.13 Lib/ntpath.py) over **all** segments in one pass, exactly
 * as `pathlib.PurePath._raw_path` calls `parser.join(*self._raw_paths)`. An
 * absolute segment discards everything before it; a drive-relative first
 * segment (`D:`) is glued to the next one without a separator.
 */
function ntpJoin(path: string, ...rest: string[]): string {
  const split0 = ntpSplitroot(path);
  let resultDrive = split0[0];
  let resultRoot = split0[1];
  let resultPath = split0[2];
  for (const p of rest) {
    const next = ntpSplitroot(p);
    const pDrive = next[0];
    const pRoot = next[1];
    const pPath = next[2];
    if (pRoot) {
      // Second path is absolute
      if (pDrive || !resultDrive) resultDrive = pDrive;
      resultRoot = pRoot;
      resultPath = pPath;
      continue;
    } else if (pDrive && pDrive !== resultDrive) {
      if (pDrive.toLowerCase() !== resultDrive.toLowerCase()) {
        // Different drives => ignore the first path entirely
        resultDrive = pDrive;
        resultRoot = pRoot;
        resultPath = pPath;
        continue;
      }
      // Same drive in different case
      resultDrive = pDrive;
    }
    // Second path is relative to the first
    if (resultPath && !SEPS.includes(resultPath.slice(-1))) resultPath = resultPath + SEP;
    resultPath = resultPath + pPath;
  }
  // add separator between UNC and non-absolute path
  if (resultPath && !resultRoot && resultDrive && !COLON_SEPS.includes(resultDrive.slice(-1))) {
    return resultDrive + SEP + resultPath;
  }
  return resultDrive + resultRoot + resultPath;
}

/** `pathlib.PurePath._parse_path`, Windows flavour: altsep, UNC root, `.` drop. */
function parsePath(raw: string): [string, string, string[]] {
  if (!raw) return ["", "", []];
  const path = normSep(raw);
  const split = ntpSplitroot(path);
  const drv = split[0];
  let root = split[1];
  const rel = split[2];
  if (!root && drv.startsWith(SEP) && !drv.endsWith(SEP)) {
    const drvParts = drv.split(SEP);
    const third = drvParts[2] ?? "";
    // e.g. //server/share  (and the `\\?\UNC\server\share` form, len 6)
    if (drvParts.length === 4 && !"?.".includes(third)) root = SEP;
    else if (drvParts.length === 6) root = SEP;
  }
  const tail: string[] = [];
  for (const x of rel.split(SEP)) {
    if (x && x !== ".") tail.push(x);
  }
  return [drv, root, tail];
}

/**
 * `pathlib.PurePath._format_parsed_parts`. The middle branch is what makes a
 * relative path whose first segment looks like a drive (`D:foo`) keep its `.`
 * anchor instead of turning into a drive-relative path.
 */
function formatParsedParts(drv: string, root: string, tail: string[]): string {
  if (drv || root) return drv + root + tail.join(SEP);
  if (tail.length > 0 && ntpSplitroot(tail[0] ?? "")[0]) return ["."].concat(tail).join(SEP);
  return tail.join(SEP);
}

/** `str(PureWindowsPath(*rawPaths))` — join the raw parts, reparse, format. */
function pathStrOfRawPaths(rawPaths: string[]): string {
  const raw = rawPaths.length === 0 ? "" : rawPaths.length === 1 ? rawPaths[0] ?? "" : ntpJoin(rawPaths[0] ?? "", ...rawPaths.slice(1));
  const parsed = parsePath(raw);
  return formatParsedParts(parsed[0], parsed[1], parsed[2]) || ".";
}

/**
 * `ntpath.expanduser("~")`: `USERPROFILE` wins **when the key exists at all**
 * (an empty value is still a value), otherwise `HOMEDRIVE`+`HOMEPATH`, and when
 * neither key exists the tilde comes back untouched — which is what
 * `pathlib.PurePath.expanduser` turns into `RuntimeError`. `$HOME` is never
 * consulted on Windows, and this port does not consult it either.
 */
function ntpExpanduserTilde(): string {
  if ("USERPROFILE" in process.env) return process.env["USERPROFILE"] ?? "";
  if (!("HOMEPATH" in process.env)) return "~";
  return ntpJoin(process.env["HOMEDRIVE"] ?? "", process.env["HOMEPATH"] ?? "");
}

/**
 * `Path.home()` as the raw-path list its `Path` object carries, i.e.
 * `[str(Path.home())]` — the *unformatted* `''` for `USERPROFILE=""`, because
 * `_from_parsed_string` stores the formatted string (which may be empty) and
 * only `__str__` substitutes `.`.
 */
function homeRawPaths(): string[] {
  const homedir = ntpExpanduserTilde();
  if (homedir.slice(0, 1) === "~") {
    throw new RuntimeErrorP("Could not determine home directory.");
  }
  const parsed = parsePath(homedir);
  return [formatParsedParts(parsed[0], parsed[1], parsed[2])];
}

/**
 * RULEBOOK §2 (module-level mutable state): the source memoises the resolved
 * home directory in a module global and returns the cached value on every later
 * call. Reproduced as the memoised `Path`'s own `_raw_paths` list, so a caller
 * that mutates the environment mid-process sees exactly what it saw before —
 * which is that it does not.
 */
let resolvedHome: string[] | null = null;

/**
 * The memoised `Path.home() / BRAND_DIR`, as the raw-part list that object
 * carries.  Both entry points go through here, exactly like the source: `db_dir`
 * calls `home_dir()`, so a first call to EITHER one fills the cache — a caller
 * that moves the profile afterwards still gets the profile the first call saw.
 */
function homeRawParts(): string[] {
  if (resolvedHome === null) {
    resolvedHome = [...homeRawPaths(), BRAND_DIR];
  }
  return resolvedHome;
}

/** The Ovolve user-data root (`~/.ovolve`), as the source's `str()` of it. */
export function homeDir(): string {
  return pathStrOfRawPaths(homeRawParts());
}

/**
 * The SQLite database directory. An explicit environment variable wins.
 *
 * Note the asymmetry with `homeDir`, preserved deliberately: the env var is
 * read on **every** call, not memoised, so a test that sets it after a previous
 * call still sees its own value. The fallback is `str(home_dir() / "db")`, whose
 * `home_dir()` call is what fills the memo above.
 */
export function dbDir(): string {
  const env = process.env[DB_DIR_ENV];
  if (env) {
    return env;
  }
  return pathStrOfRawPaths([...homeRawParts(), "db"]);
}

// PORT STATUS: 本文件无 TODO(port)。
