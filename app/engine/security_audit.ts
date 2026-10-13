/**
 * security_audit.ts - Security hardening self-check + red-team closed loop (pattern 05).
 *
 * Ported from `app/backend/security_audit.py` (122 lines, wave-10, unit 194).
 *
 * Loads `security/vulns.json` (the hardening checklist) and:
 *   - `self_check()`           verifies each vuln's owner module is present on disk
 *   - `red_team_closed_loop()` replays the attack examples from
 *                              `injection_patterns.json` through the output guard
 *                              and reports catch coverage
 *   - `full_report()`          combines both into one report (config + red team)
 *
 * This closes pattern 05 (5.1 vulns.json, 5.3 red-team closed loop) by binding
 * the "attack" library (pattern 06/08) to the "defense" (output_guard) and
 * measuring that the loop actually holds.
 *
 * RULEBOOK CITATIONS
 *   §2  `except (OSError, json.JSONDecodeError)` stays narrow → catch only a
 *       filesystem error or a parse error; anything else propagates.
 *   §2  `round(x, 3)` → `pyRound3` (CPython uses round-half-to-EVEN, JS
 *       `toFixed`/`Math.round` round half away from zero — they disagree on
 *       exactly representable halves).
 *   §2  `str(x)[:80]` / `[:10]` are code-point slices → `pySlice`.
 *   §2  `open(..., encoding="utf-8")` → `node:fs` readTextSync, injected through
 *       the seam so the probe never touches disk.
 *   §4  naming: app/backend/security_audit.py -> app/engine/security_audit.ts.
 *       The module-level path constants keep their source names
 *       (`SECURITY_DIR` / `VULNS_FILE` / `BACKEND_DIR`).
 *
 * DIVERGENCE(port): the three module-level path constants are derived from
 * `import.meta.url` (this module's own directory) instead of `__file__`. Both
 * mean "the directory this module lives in", so the SHAPE is identical
 * (`<dir>/security/vulns.json`); only the absolute prefix differs, which the
 * source never surfaces. Default `VULNS_FILE` therefore points at the emitted
 * tree, which has no `security/` directory — the `_load` swallow then yields
 * `checks = []`, exactly the source's behaviour for a missing file. The
 * success path is exercised through the explicit `vulns_path` argument.
 *
 * PORT STATUS: 本文件无 TODO(port)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Result } from "./result.js";
import * as _red_team_mod from "./red_team.js";
import * as _tools_mod from "./tools.js";

// ── python 语义小工具（本仓惯例：各文件自带局部实现） ─────────────────────────

/** python `len(x)` (code-point based for strings). */
function pyLen(v: unknown): number {
  if (typeof v === "string") return [...v].length;
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  if (v !== null && typeof v === "object") return Object.keys(v as object).length;
  throw new TypeError(`object of type '${typeof v}' has no len()`);
}

/** python `s[:n]` — code-point based. */
function pySlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/**
 * python `round(x, 3)` — the closest multiple of 10**-3 to the EXACT binary value
 * of `x`, ties going to the even digit.
 *
 * Not `toFixed(3)` (half-away-from-zero on the shortest repr) and not
 * `Math.round(x*1000)/1000` (the scaling multiplication introduces its own error:
 * `0.1235 * 1000` is `123.50000000000001` in IEEE-754, which would round UP where
 * CPython rounds DOWN, because the double nearest 0.1235 is
 * 0.1234999999999999980...). So the exact-enough decimal expansion is obtained
 * with `toFixed(20)` and the rounding is done on that decimal string, which is
 * what CPython's `_Py_dg_dtoa`-based implementation effectively does.
 *
 * Probe-pinned on 247/2000 = 0.1235 → 0.123 (python) and on 1/8, 2/3, 9/10.
 * Only ever called on a ratio in [0, 1], so the kept-digit integer stays small.
 */
function pyRound3(x: number): number {
  if (!Number.isFinite(x)) return x;
  const sign = x < 0 ? -1 : 1;
  const s = Math.abs(x).toFixed(20);
  const dot = s.indexOf(".");
  const ip = s.slice(0, dot);
  const fp = s.slice(dot + 1);
  const digits = (ip + fp).split("");
  const cut = ip.length + 3;
  const kept = digits.slice(0, cut);
  const tail = digits.slice(cut);
  const first = tail.length ? Number(tail[0]) : 0;
  let up = false;
  if (first > 5) {
    up = true;
  } else if (first === 5) {
    const restNonZero = tail.slice(1).some((d) => d !== "0");
    up = restNonZero || Number(kept[kept.length - 1]) % 2 === 1;
  }
  let scaled = Number(kept.join(""));
  if (up) scaled += 1;
  return (sign * scaled) / 1000;
}

/** python truthiness (`if x`, `x or y`). */
function pyTruth(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** python `dict.get(k, default)` — present-but-null returns null, not default. */
function dictGet(obj: unknown, key: string, dflt: unknown = null): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    throw new TypeError(`'${typeof obj}' object has no attribute 'get'`);
  }
  return key in (obj as object) ? (obj as Record<string, unknown>)[key] : dflt;
}

/** python `str(exc)` (message only, no type prefix). */
function excStr(e: unknown): string {
  const m = (e as { pyMsg?: string })?.pyMsg;
  if (m !== undefined) {
    return m;
  }
  return String((e as Error)?.message ?? e);
}

// ── module-level paths（源为模块级常量，语义是"本模块所在目录"） ────────────────

const _MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const SECURITY_DIR: string = path.join(_MODULE_DIR, "security");
export const VULNS_FILE: string = path.join(SECURITY_DIR, "vulns.json");
export const BACKEND_DIR: string = _MODULE_DIR;

// ── seams（宿主触点与函数级导入在这里可替换；默认值 = 真端口） ──────────────────

type AnyMod = Record<string, any>;

export const SECURITY_AUDIT_SEAMS = {
  /** python `os.path.join`。 */
  join: (...parts: string[]): string => path.join(...parts),
  /** python `os.path.isfile`（不抛，False 表示不存在/不可读）。 */
  isfile: (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  /** python `open(path, "r", encoding="utf-8")` + `f.read()`。 */
  readText: (p: string): string => fs.readFileSync(p, "utf-8"),
  /** python `json.loads`（抛出的解析错误被 `_load` 的窄吞接住）。 */
  jsonLoads: (text: string): unknown => JSON.parse(text),
  /** python `from red_team import get_red_team`。 */
  redTeamModule: (): AnyMod => _red_team_mod as unknown as AnyMod,
  /** python `from tools import ToolDef, get_tool_registry`（不在 try 里）。 */
  toolsModule: (): AnyMod => _tools_mod as unknown as AnyMod,
};

/** 探针用：整体替换 seams（对应 python 侧 monkeypatch 模块全局）。 */
export function _set_seams_for_parity(patch: Partial<typeof SECURITY_AUDIT_SEAMS>): void {
  Object.assign(SECURITY_AUDIT_SEAMS, patch);
}

/** 探针用：恢复默认实现（对应 python 侧 reload）。 */
export function _reset_seams_for_parity(): void {
  SECURITY_AUDIT_SEAMS.join = (...parts: string[]): string => path.join(...parts);
  SECURITY_AUDIT_SEAMS.isfile = (p: string): boolean => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  SECURITY_AUDIT_SEAMS.readText = (p: string): string => fs.readFileSync(p, "utf-8");
  SECURITY_AUDIT_SEAMS.jsonLoads = (text: string): unknown => JSON.parse(text);
  SECURITY_AUDIT_SEAMS.redTeamModule = (): AnyMod => _red_team_mod as unknown as AnyMod;
  SECURITY_AUDIT_SEAMS.toolsModule = (): AnyMod => _tools_mod as unknown as AnyMod;
}

// ── SecurityAuditor ──────────────────────────────────────────────────────────

/** Run the hardening checklist and the red-team closed loop. */
export class SecurityAuditor {
  checks: Record<string, unknown>[];

  constructor(vulns_path: string | null = null) {
    this.checks = [];
    this._load(vulns_path || VULNS_FILE);
  }

  _load(p: string): void {
    try {
      const text = SECURITY_AUDIT_SEAMS.readText(p);
      const data: any = SECURITY_AUDIT_SEAMS.jsonLoads(text);
      this.checks = (dictGet(data, "checks", null) || []) as Record<string, unknown>[];
    } catch (e) {
      // 源为 `except (OSError, json.JSONDecodeError)` —— 窄吞保持窄：只有
      // 「读不到」和「解析不了」退化成空清单，其它异常照旧上抛。
      if (e instanceof SyntaxError || isOsError(e)) {
        this.checks = [];
      } else {
        throw e;
      }
    }
  }

  /** Confirm every vuln's owner module is present in the backend. */
  self_check(): Record<string, any> {
    const results: Record<string, any>[] = [];
    let present = 0;
    for (const chk of this.checks) {
      const owner = dictGet(chk, "owner_module", "");
      const module_present = Boolean(owner)
        && SECURITY_AUDIT_SEAMS.isfile(SECURITY_AUDIT_SEAMS.join(BACKEND_DIR, String(owner)));
      if (module_present) {
        present += 1;
      }
      results.push({
        id: dictGet(chk, "id", null),
        title: dictGet(chk, "title", null),
        severity: dictGet(chk, "severity", null),
        category: dictGet(chk, "category", null),
        owner_module: owner,
        module_present,
      });
    }
    const total = pyLen(this.checks);
    return {
      total,
      modules_present: present,
      coverage: total ? pyRound3(present / total) : 0.0,
      checks: results,
    };
  }

  /** Fire the attack library at the live defense and report coverage.
   *
   * Delegates to `red_team.RedTeam.closed_loop` (the canonical attack↔defense
   * loop, pattern 05 §5.3) which merges the embedded default categories with
   * `injection_patterns.json` and checks each example against both the injection
   * scanner and `output_guard`.
   */
  red_team_closed_loop(): Record<string, any> {
    let loop: Record<string, any>;
    try {
      const get_red_team = SECURITY_AUDIT_SEAMS.redTeamModule()["get_red_team"] as () => any;
      loop = get_red_team().closed_loop();
    } catch (e) {
      return { total: 0, caught: 0, coverage: 0.0, error: excStr(e) };
    }
    // Normalize key name so callers see a stable ``coverage`` + ``total``.
    const missed = (dictGet(loop, "missed", null) || []) as Record<string, unknown>[];
    return {
      total: dictGet(loop, "total_attacks", 0),
      caught: dictGet(loop, "caught", 0),
      coverage: dictGet(loop, "coverage", 0.0),
      missed: missed.slice(0, 10).map((m) => pySlice(String(dictGet(m, "example", "") || ""), 80)),
    };
  }

  full_report(): Record<string, any> {
    const sc = this.self_check();
    const rt = this.red_team_closed_loop();
    return {
      self_check: sc,
      red_team_closed_loop: rt,
      healthy: sc["coverage"] >= 0.9 && rt["coverage"] >= 0.6,
    };
  }
}

/** python `isinstance(e, OSError)` — node's filesystem errors carry `code`/`errno`. */
function isOsError(e: unknown): boolean {
  if (e === null || typeof e !== "object") return false;
  const o = e as { code?: unknown; errno?: unknown; path?: unknown };
  return typeof o.code === "string" && (o.errno !== undefined || o.path !== undefined);
}

// ── 工具注册 ─────────────────────────────────────────────────────────────────

export function _security_audit_impl(_args: unknown, _ctx: unknown): Result {
  return Result.success(get_security_auditor().full_report());
}

/** Register the ``security_audit`` tool. */
export function register_tools(registry: any = null): void {
  const toolsMod: AnyMod = SECURITY_AUDIT_SEAMS.toolsModule();
  const ToolDef = toolsMod["ToolDef"] as new (...a: any[]) => any;
  const get_tool_registry = toolsMod["get_tool_registry"] as () => any;
  const reg = registry || get_tool_registry();
  reg.register(new ToolDef(
    "security_audit",
    "Run the hardening self-check + red-team closed loop; report coverage.",
    { type: "object", properties: {}, required: [] },
    _security_audit_impl,
    { domain: "computer", risk_level: "low" },
  ));
}

let _auditor: SecurityAuditor | null = null;

export function get_security_auditor(): SecurityAuditor {
  if (_auditor === null) {
    _auditor = new SecurityAuditor();
  }
  return _auditor;
}

/** 探针用：清掉进程内单例（对应 python 侧 `reload(security_audit)`）。 */
export function _reset_auditor_for_parity(): void {
  _auditor = null;
}

// 显式引用：`pyTruth` 是本地语义工具的公开面，保持与源一致的调用点可读性。
void pyTruth;
