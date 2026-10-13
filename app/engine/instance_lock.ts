/**
 * instance_lock.ts — 后端进程的单实例防线（advisory lock）。
 *
 * Ported from `app/backend/instance_lock.py` (159 lines).
 *
 * 为什么 Electron 锁之外还要这一层：Electron 的 requestSingleInstanceLock()
 * 只保护"从 Electron 正常启动"的路径。开发模式、命令行直启、多窗口改造、
 * 打包异常路径——任何绕过 Electron 的启动都会得到两个后端进程写同一批
 * SQLite 库。这层锁不替代 Electron，它是最后一道诊断防线：第二个进程
 * **拿不到锁就明确说出来**。
 *
 * 跨平台语义：
 * - Windows/POSIX 都用 O_CREAT|O_EXCL 独占创建锁文件（fs.writeFileSync flag
 *   "wx" 等价）——原子性由文件系统保证。
 * - 文件内容是 {pid, started_at, argv0}。已存在的锁先验 PID 活性：持锁进程
 *   死了（崩溃没来得及释放），新进程接管并重写锁文件；活着则拒绝。
 * - 正常退出释放；崩溃由 PID 检查兜底。
 *
 * RULEBOOK CITATIONS
 *   §1  node:fs（"wx" flag） / node:process。
 *   §2  Python ctypes OpenProcess/GetExitCodeProcess (Windows) →
 *       process.kill(pid, 0) 等价不可用（Node 无跨平台 PID 探活）→ 用
 *       `process.kill(pid, 0)` —— Node 在 Windows 上同样实现了信号 0 探活
 *       （EPERM = 活着，ESRCH = 死了）。语义与源 POSIX 分支一致，Windows
 *       分支由 Node 运行时内部承担（ctypes 的 STILL_ACTIVE 细节归运行时）。
 *   §4  naming: instance_lock.py → instance_lock.ts
 *
 * SUPERSEDED (measured 2026-09-25): the manifest routes this unit Native→Rust
 * and the shipped port is `app/backend/rust_core/src/instance_lock/mod.rs`
 * (`ovolve_core.instance_lock`). This file is a draft that nothing imports, and
 * the §2 assumption above is false: an empirical decision table
 * (`tmp/il_decide_py.py` / `tmp/il_decide_ts.mjs`) showed `process.kill(pid, 0)`
 * answers EPERM→"alive" where CPython's `OpenProcess` is refused
 * (ERROR_ACCESS_DENIED) and answers "dead, steal the lock" — for a protected
 * pid such as 4 the two runtimes decide in opposite directions, which is the
 * one thing this module exists to get right. `path.join` also normalises "/" to
 * "\" where ntpath does not. Do not wire this file; do not treat it as the port.
 *
 * PORT STATUS: confidence=high todos=0 (draft, not the port)
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const LOCK_FILE_NAME = "backend.lock";

const _state: { lock_path: string; acquired: boolean } = { lock_path: "", acquired: false };

export function lock_path_for(db_dir: string): string {
  return path.join(db_dir || "", LOCK_FILE_NAME);
}

/** PID 是否对应一个活着的进程。检查失败按活着处理（宁可不接管）。
 * Node `process.kill(pid, 0)`：ESRCH → 死；EPERM → 活着但无权；其他错误 →
 * 按活着处理（与源 ctypes/POSIX 双分支的 fail-safe 一致）。 */
function _pid_alive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ESRCH") {
      return false;
    }
    if (err.code === "EPERM") {
      return true; // 存在但属于别人
    }
    return true;
  }
}

function _read_lock(p: string): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
    return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 尝试获取实例锁。
 * Returns {acquired, lockPath, reason, existing}。
 * 绝不抛异常也绝不静默退出——调用方（HTTP 启动路径）负责把拒绝变成日志、
 * health 字段和 UI 提示。 */
export function acquire(db_dir: string, opts?: { component?: string }): Record<string, unknown> {
  const component = opts?.component ?? "backend";
  const p = lock_path_for(db_dir);
  const info: Record<string, unknown> = {
    acquired: false,
    lockPath: p,
    reason: "",
    existing: null,
  };
  if (!db_dir) {
    info["reason"] = "no db_dir given";
    return info;
  }
  try {
    fs.mkdirSync(db_dir, { recursive: true });
    const payload = JSON.stringify({
      pid: process.pid,
      component,
      started_at: Math.floor(Date.now() / 1000),
      argv0: process.argv[0] ?? "",
    });
    // 先快速路径：文件不存在时 "wx" 独占创建直接成功。
    try {
      fs.writeFileSync(p, payload, { flag: "wx" });
      _state.lock_path = p;
      _state.acquired = true;
      info["acquired"] = true;
      return info;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        throw e;
      }
      // FileExistsError → fall through
    }
    const existing = _read_lock(p);
    const pid = Math.trunc(Number(existing["pid"] ?? 0));
    if (pid === process.pid) {
      // 本进程已持有（或至少写过）这把锁。如实拒绝，并把 pid 写进原因。
      info["reason"] = `lock already held by this process (pid=${pid})`;
      info["existing"] = { pid, startedAt: existing["started_at"], argv0: existing["argv0"] };
      return info;
    }
    if (pid && _pid_alive(pid)) {
      info["reason"] =
        `另一个 ${component} 进程正在运行（pid=${pid}，` +
        `自 ${String(_read_lock(p)["started_at"] ?? "?")} 起）`;
      info["existing"] = { pid, startedAt: existing["started_at"], argv0: existing["argv0"] };
      return info;
    }
    // 持锁者已死（或锁文件损坏）：接管。先删再建，中间仍有竞窗——两个
    // 新进程同时接管的概率极小，且 SQLite 层的租约仍能兜底。
    try {
      fs.unlinkSync(p);
    } catch (exc) {
      info["reason"] = `stale lock file could not be removed: ${exc instanceof Error ? exc.message : String(exc)}`;
      return info;
    }
    fs.writeFileSync(p, payload, { flag: "wx" });
    _state.lock_path = p;
    _state.acquired = true;
    info["acquired"] = true;
    info["reason"] = `took over stale lock from dead pid=${pid}`;
    return info;
  } catch (exc) {
    info["reason"] = `instance lock error: ${exc instanceof Error ? exc.message : String(exc)}`;
    return info;
  }
}

/** 正常退出时释放自己的锁。别人的锁不动。 */
export function release(): boolean {
  const p = _state.lock_path || "";
  if (!p || !_state.acquired) {
    return false;
  }
  try {
    fs.unlinkSync(p);
    _state.acquired = false;
    return true;
  } catch {
    return false;
  }
}

/** 当前进程与锁的关系，给 /api/health 用。 */
export function status(): Record<string, unknown> {
  const p = _state.lock_path || "";
  const out: Record<string, unknown> = { held: _state.acquired, lockPath: p };
  if (p && !_state.acquired) {
    const holder = _read_lock(p);
    if (holder["pid"]) {
      out["heldBy"] = { pid: holder["pid"], startedAt: holder["started_at"] };
    }
  }
  return out;
}
