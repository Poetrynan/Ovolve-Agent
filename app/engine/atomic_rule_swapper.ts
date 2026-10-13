/**
 * atomic_rule_swapper.ts — OS-level atomic file replacement & snapshot rollback.
 *
 * Ported from `app/backend/atomic_rule_swapper.py` (131 lines, Module 3).
 *
 * Provides:
 * 1. True atomic replacement via rename on the same filesystem/device.
 * 2. fsync persistence guarantees before rename.
 * 3. Automatic pre-swap snapshotting to .ovolve/snapshots/ with undo tokens.
 * 4. Instant 1-step rollback capabilities.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:fs, node:crypto for uuid).
 *   §2  os.fsync → fs.fsyncSync on an open fd; os.replace → fs.renameSync
 *       (POSIX rename semantics; on Windows Node maps it to MoveFileEx with
 *       REPLACE_EXISTING, matching os.replace's contract).
 *   §2  `except OSError: pass` swallows preserved verbatim (tmp cleanup is
 *       best-effort in the source too).
 *   §2  the in-memory _undo_registry is process-local state (source uses a
 *       plain dict; the Map here has the same semantics — no persistence in
 *       either implementation).
 *   §2  text-mode write (CPython-proven fixes, this unit):
 *       `open(tmp_file, "w", encoding=enc)` uses newline=None (every "\n" is
 *       written as os.linesep, CRLF on Windows) and applies the named codec.
 *       Node's writeSync does neither faithfully: it never translates newlines,
 *       and it silently falls back to UTF-8 for a Python codec name it does not
 *       spell the same way (e.g. "latin-1"). The str branch now translates every
 *       "\n" -> "\r\n" AND encodes via encodeText() to reproduce the exact bytes
 *       CPython wrote. Oracle: tmp/atrs_oracle_facts.json
 *       (wa_str_nl=610d0a62, wa_str_crlf=610d0d0a62, wa_str_only_nl=0d0a0d0a,
 *        wa_latin1_cafe=636166e9). The bytes branch is verbatim and untouched.
 *   §4  naming: atomic_rule_swapper.py → atomic_rule_swapper.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface SwapResult {
  success: boolean;
  target_path: string;
  snapshot_path: string | null;
  undo_token: string | null;
  error: string | null;
}

/**
 * Encode a str the way CPython's `open(path, "w", encoding=enc).write(text)`
 * does, and return the exact bytes. Node's `fs.writeSync(fd, str, pos, enc)`
 * silently coerces an encoding name it does not recognise (e.g. Python's
 * "latin-1", which Node spells "latin1") to UTF-8, so a hyphenated Python codec
 * name would write the WRONG bytes. We normalise the name ourselves and encode
 * explicitly, reproducing CPython's per-codec range errors for names it has:
 *   * ascii    : CPython raises UnicodeEncodeError above U+007F
 *   * latin-1  : CPython raises UnicodeEncodeError above U+00FF
 *   * utf-8 / utf-16-le : encode directly (utf-16-le has no BOM in CPython)
 * An unknown codec name raises (CPython LookupError: unknown encoding), which
 * the caller's try/catch turns into SwapResult(success=false), just like Python.
 * CPython oracle (tmp/atrs_oracle_facts.json): wa_latin1_cafe "caf"+"\u00e9" ->
 * 636166e9 (single-byte 0xE9), NOT the UTF-8 c3a9c3a9 Node would emit.
 */
function encodeText(text: string, encoding: string): Buffer {
  const key = String(encoding).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (key === "utf8") return Buffer.from(text, "utf8");
  if (key === "utf16le" || key === "ucs2" || key === "utf16") {
    return Buffer.from(text, "utf16le");
  }
  if (key === "latin1" || key === "iso88591" || key === "88591" || key === "cp819" || key === "binary") {
    const buf = Buffer.alloc(text.length);
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (cp > 0xff) {
        throw new Error("UnicodeEncodeError: 'latin-1' can't encode character");
      }
      buf[i] = cp;
    }
    return buf;
  }
  if (key === "ascii" || key === "usascii" || key === "646") {
    const buf = Buffer.alloc(text.length);
    for (let i = 0; i < text.length; i++) {
      const cp = text.charCodeAt(i);
      if (cp > 0x7f) {
        throw new Error("UnicodeEncodeError: 'ascii' codec can't encode character");
      }
      buf[i] = cp;
    }
    return buf;
  }
  throw new Error("unknown encoding: " + encoding);
}

export class AtomicRuleSwapper {
  /** Safely updates persistent rule files using OS-level atomic swaps. */
  snapshot_dir: string;
  private _undo_registry = new Map<
    string,
    { target: string; snapshot: string }
  >();

  constructor(snapshot_dir?: string | null) {
    this.snapshot_dir = snapshot_dir
      ? path.resolve(snapshot_dir)
      : path.resolve(".ovolve", "snapshots");
  }

  /**
   * Atomically replaces target_path with content, taking a snapshot if existing.
   */
  write_atomic(
    target_path: string,
    content: string | Buffer,
    opts: {
      encoding?: BufferEncoding;
      create_snapshot?: boolean;
    } = {}
  ): SwapResult {
    const { encoding = "utf-8", create_snapshot = true } = opts;
    const target = path.resolve(target_path);
    let tmp_file: string | null = null;
    let snapshot_path: string | null = null;
    let undo_token: string | null = null;

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });

      // Create snapshot if file exists
      if (fs.existsSync(target) && create_snapshot) {
        fs.mkdirSync(this.snapshot_dir, { recursive: true });
        const token = `undo_${Date.now()}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
        const snap_name = `${Math.floor(Date.now() / 1000)}_${crypto
          .randomUUID()
          .replace(/-/g, "")
          .slice(0, 6)}_${path.basename(target)}`;
        const snap_file = path.join(this.snapshot_dir, snap_name);
        fs.copyFileSync(target, snap_file);
        // shutil.copy2 preserves metadata; Node's copyFileSync copies
        // contents (mode travels with the file on both POSIX and Windows).
        snapshot_path = snap_file;
        undo_token = token;
        this._undo_registry.set(token, { target, snapshot: snap_file });
      }

      // Write to temporary file in the same directory (ensures same
      // filesystem mount) — os.getpid() equivalent via process.pid.
      const tmp_name = `${path.basename(target)}.tmp.${process.pid}.${crypto
        .randomUUID()
        .replace(/-/g, "")
        .slice(0, 6)}`;
      tmp_file = path.join(path.dirname(target), tmp_name);

      if (typeof content === "string") {
        // CPython-faithful text write. Two divergences Node would otherwise hit:
        //  (a) newline translation: `open(..., "w", newline=None)` writes every
        //      "\n" as os.linesep ("\r\n" on Windows), so an existing CRLF
        //      becomes CR + CRLF; Node's writeSync never translates.
        //  (b) codec name: Python's hyphenated names ("latin-1") are not Node
        //      encoding aliases and Node silently falls back to UTF-8.
        // Both are fixed by translating newlines then encoding EXPLICITLY via
        // encodeText. Oracle (tmp/atrs_oracle_facts.json): wa_str_nl "a\nb" ->
        // 610d0a62, wa_str_crlf "a\r\nb" -> 610d0d0a62, wa_str_only_nl "\n\n" ->
        // 0d0a0d0a, wa_latin1_cafe "caf\u00e9" -> 636166e9; bytes stay verbatim.
        const translated = content.replace(/\n/g, "\r\n");
        const fd = fs.openSync(tmp_file, "w");
        try {
          fs.writeSync(fd, encodeText(translated, encoding));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } else {
        const fd = fs.openSync(tmp_file, "w");
        try {
          fs.writeSync(fd, content);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }

      // Atomic rename / replace
      fs.renameSync(tmp_file, target);
      tmp_file = null; // Replaced successfully

      return {
        success: true,
        target_path: target,
        snapshot_path,
        undo_token,
        error: null,
      };
    } catch (exc) {
      if (tmp_file !== null && fs.existsSync(tmp_file)) {
        try {
          fs.unlinkSync(tmp_file);
        } catch {
          // except OSError: pass — cleanup is best-effort
        }
      }
      return {
        success: false,
        target_path: target,
        snapshot_path: null,
        undo_token: null,
        error: exc instanceof Error ? exc.message : String(exc),
      };
    }
  }

  /** Restores a previous version using the undo token. */
  rollback(undo_token: string): boolean {
    const entry = this._undo_registry.get(undo_token);
    if (!entry) {
      return false;
    }

    const { target, snapshot } = entry;

    if (!fs.existsSync(snapshot)) {
      return false;
    }

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp_restore = path.join(
        path.dirname(target),
        `${path.basename(target)}.restore.${crypto
          .randomUUID()
          .replace(/-/g, "")
          .slice(0, 6)}`
      );
      fs.copyFileSync(snapshot, tmp_restore);
      fs.renameSync(tmp_restore, target);
      return true;
    } catch {
      // except Exception: return False
      return false;
    }
  }
}
