/**
 * skill_integrity.ts — 技能供应链完整性锁（skills.lock）。
 *
 * Ported from `app/backend/skill_integrity.py` (169 lines).
 *
 * 已有的防线都守在安装前（skill_vetter 静态扫描、skill_lifecycle 四道门）。
 * 但一个技能通过审批落盘之后，SKILL.md 就只是用户盘上的一个普通文件——被
 * 恶意软件改写、被同步盘覆盖、被手滑编辑，运行时毫无感知。skills.lock 补
 * 的是安装后这一段：把每个已装技能的 sha256 记下来，装载时重算比对。
 *
 * 语义（与源注释一致，保留为合同）：
 * - 谁会被锁：走 skill_lifecycle.approve 安装的技能。discover 扫到的本机
 *   技能不自动上锁——用户手改自己的技能是预期行为。
 * - 比对不符：载入但打高优警告（默认），不硬拒——可用性优先。
 * - 锁文件：<db_dir>/skills.lock（JSON）。损坏/缺失按"无锁"处理，绝不因为
 *   锁文件本身的问题拦住技能加载。
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:crypto sha256, node:fs, user_dirs.ts).
 *   §2  `except OSError: continue/pass` swallows preserved verbatim（读不到
 *       的文件不进快照；锁写失败大声打印但不抛）。
 *   §2  json.dump(..., indent=1, sort_keys=True) — pyJsonIndent + 键排序；
 *       锁文件不是字节级契约（自产自销），但保持同形以便人工 diff。
 *   §2  os.walk 的 sorted(names) 排序保留（决定截断时哪些文件进快照——
 *       行为差异可观察）。
 *   §4  naming: skill_integrity.py → skill_integrity.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { dbDir } from "./user_dirs.js";
import { pyJsonIndent } from "./storage/storage_funcs.js";

/** 单个技能目录里参与哈希的文件上限与单文件大小上限——技能是小文件集合，
 * 超过这个规模的东西不该被静默吞进哈希（也防住符号链接循环式的意外）。 */
const _MAX_FILES_PER_SKILL = 200;
const _MAX_FILE_BYTES = 2_000_000;

/** 跳过的文件名模式：审批快照与编辑器残渣不是技能内容。用子串匹配而不是
 * endswith——快照带时间戳后缀（SKILL.md.bak-1735...），按后缀比对会漏。 */
const _SKIP_SUBSTRINGS: readonly string[] = [".bak", ".tmp", ".swp"];

function _lock_path(): string {
  return path.join(dbDir(), "skills.lock");
}

function _file_sha256(p: string): string {
  const h = crypto.createHash("sha256");
  // 分块读：技能正文再小也是按块的稳妥读法，8KB 对 2MB 上限足够。
  const fd = fs.openSync(p, "r");
  try {
    const buf = Buffer.alloc(8192);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest("hex");
}

export interface SkillDirSnapshot {
  files: Record<string, string>;
  [k: string]: unknown;
}

/** 对一个技能目录做完整性快照：SKILL.md + 全部附属文件的 sha256。
 *
 * 返回 `{"files": {相对路径: sha256}}`。目录不存在返回空表——调用方
 * （写锁处）应把"空快照"视为错误而不是静默写一条空锁。 */
export function hash_skill_dir(skill_dir: string): SkillDirSnapshot {
  const files: Record<string, string> = {};
  if (!fs.existsSync(skill_dir) || !fs.statSync(skill_dir).isDirectory()) {
    return { files };
  }
  let count = 0;
  const stack: string[] = [skill_dir];
  outer: while (stack.length > 0) {
    const root = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      // OSError on a subdir -> os.walk just yields nothing for it
      continue;
    }
    // os.walk yields names in os.scandir order; the source sorts per dir.
    const names = entries
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
    for (const n of names) {
      if (_SKIP_SUBSTRINGS.some((s) => n.includes(s))) {
        continue;
      }
      const full = path.join(root, n);
      const rel = path.relative(skill_dir, full).split("\\").join("/");
      try {
        if (fs.statSync(full).size > _MAX_FILE_BYTES) {
          continue;
        }
        files[rel] = _file_sha256(full);
      } catch {
        // 读不到的文件不进快照，也不让整个快照失败
        continue;
      }
      count += 1;
      if (count >= _MAX_FILES_PER_SKILL) {
        break outer;
      }
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        stack.push(path.join(root, e.name));
      }
    }
  }
  return { files };
}

/** 读锁文件。任何损坏都按"无锁"处理（返回空 dict）。 */
export function read_lock(): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(_lock_path(), "utf-8")) as unknown;
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  } catch {
    // (OSError, ValueError) -> {}
    return {};
  }
}

function _write_lock(data: Record<string, unknown>): void {
  const p = _lock_path();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  // json.dump(data, ensure_ascii=False, indent=1, sort_keys=True)
  const sorted = sortKeysDeep(data);
  fs.writeFileSync(tmp, pyJsonIndent(sorted), "utf-8");
  fs.renameSync(tmp, p);
}

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** 安装/重锁时记录一个技能的哈希基线。返回写入的条目。 */
export function write_lock_entry(name: string, skill_dir: string): SkillDirSnapshot & { lockedAt?: number } {
  const entry = hash_skill_dir(skill_dir) as SkillDirSnapshot & { lockedAt?: number };
  if (Object.keys(entry.files).length === 0) {
    return entry; // 空快照（目录不存在）不写锁
  }
  entry["lockedAt"] = Date.now() / 1000;
  const data = read_lock();
  data[name] = entry;
  try {
    _write_lock(data);
  } catch (e) {
    console.log(`[skills] lock write failed for '${name}': ${e}`);
  }
  return entry;
}

export function remove_lock_entry(name: string): void {
  const data = read_lock();
  if (name in data) {
    delete data[name];
    try {
      _write_lock(data);
    } catch (e) {
      console.log(`[skills] lock remove failed for '${name}': ${e}`);
    }
  }
}

export interface IntegrityReport {
  ok: boolean;
  missing: string[];
  changed: Record<string, string>;
}

/** 装载时校验。返回 null = 无锁记录（不评价）；否则返回核验报告。
 *
 * 报告形状：`{"ok": bool, "missing": [相对路径], "changed": {路径: 现哈希}}`。
 * 多出来的新文件不报——附加文件不改变已审批内容的行为面，报了只会
 * 训练用户忽略警告。 */
export function verify_skill_dir(
  name: string,
  skill_dir: string
): IntegrityReport | null {
  const data = read_lock();
  const entry = data[name];
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const files = (entry as { files?: Record<string, string> })["files"];
  if (!files || Object.keys(files).length === 0) {
    return null;
  }
  const expected: Record<string, string> = files;
  const current = hash_skill_dir(skill_dir).files;
  const missing = Object.keys(expected).filter((rel) => !(rel in current));
  const changed: Record<string, string> = {};
  for (const rel of Object.keys(expected)) {
    if (rel in current && current[rel] !== expected[rel]) {
      changed[rel] = current[rel]!;
    }
  }
  return { ok: missing.length === 0 && Object.keys(changed).length === 0, missing, changed };
}
