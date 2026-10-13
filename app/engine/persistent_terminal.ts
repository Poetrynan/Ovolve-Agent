/**
 * persistent_terminal.ts — 源：app/backend/persistent_terminal.py（171 行）。
 * 单元 199 / wave-9 #1/15，manifest.tsv 第 199 行 target=TS。
 *
 * 职责：
 * 1. 为每个会话维护一个常驻的持久化 Shell 进程（Windows 下为 PowerShell，POSIX 下为 Bash）；
 * 2. 跨步骤、跨 Turn 保持工作目录（cd）、环境变量（$env:KEY=VAL）和虚拟环境激活状态；
 * 3. 基于唯一 Marker 锚定与严格的退出码（Exit Code）捕获，彻底避免无状态子进程的“每步重新初始化”顽疾；
 * 4. 提供超时安全守卫与异常自动重置。
 *
 * ── 接缝（RULEBOOK §2 红线5：探针把外部触碰换成内存假件，绝不真实 spawn 进程）──
 * PT_SEAMS:
 *   - platform: () => process.platform
 *   - realpath: (p: string) => path.resolve(p)
 *   - spawn: (cmd: string[], opts: any) => IPersistentProcess
 *   - time: () => Date.now() / 1000
 *   - uuidHex: () => randomUUID().replace(/-/g, "")
 *
 * DIVERGENCE(port):
 *   1. Python 源码使用 loop.run_in_executor(None, _sync_run) 在单独线程中阻塞执行
 *      proc.stdout.readline()；TS / Node.js 异步模型下没有同步阻塞管道读，
 *      execute 自身直接为 async 函数并在事件循环中非阻塞 await 读取输出行，
 *      让出事件循环，避免占用线程池工作线程。
 *   2. sys.platform == "win32" 映射为 process.platform === "win32"（经接缝注入）。
 */

import * as path from "node:path";
import * as child_process from "node:child_process";
import { randomUUID } from "node:crypto";

/* ── 接口与抽象 ── */

export interface IPersistentProcess {
  poll(): number | null | undefined;
  stdin: {
    write(chunk: string): boolean | void;
    flush?(): void;
    close(): void;
  } | null;
  stdout: {
    readline(): Promise<string> | string;
  } | null;
  terminate(): void;
}

/* ── 接缝 ── */

export interface PersistentTerminalSeams {
  platform: () => string;
  realpath: (p: string) => string;
  spawn: (cmd: string[], opts: any) => IPersistentProcess | null;
  time: () => number;
  uuidHex: () => string;
}

function defaultSpawn(cmd: string[], opts: any): IPersistentProcess | null {
  try {
    const prog = cmd[0] || (process.platform === "win32" ? "powershell.exe" : "/bin/bash");
    const cp: any = child_process.spawn(prog, cmd.slice(1), {
      cwd: opts?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let buffer = "";
    let lineQueue: string[] = [];
    let resolveLine: ((line: string) => void) | null = null;
    let closed = false;

    const pushLine = (line: string) => {
      if (resolveLine) {
        const r = resolveLine;
        resolveLine = null;
        r(line);
      } else {
        lineQueue.push(line);
      }
    };

    const handleChunk = (chunk: Buffer | string) => {
      buffer += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx + 1);
        buffer = buffer.slice(idx + 1);
        pushLine(line);
      }
    };

    cp.stdout?.on("data", handleChunk);
    cp.stderr?.on("data", handleChunk);

    cp.on("close", () => {
      closed = true;
      if (buffer.length > 0) {
        pushLine(buffer);
        buffer = "";
      }
      if (resolveLine) {
        const r = resolveLine;
        resolveLine = null;
        r("");
      }
    });

    const procObj: IPersistentProcess = {
      poll() {
        return cp.exitCode !== null ? cp.exitCode : undefined;
      },
      stdin: cp.stdin
        ? {
            write(chunk: string) {
              return cp.stdin.write(chunk);
            },
            flush() {},
            close() {
              cp.stdin.end();
            },
          }
        : null,
      stdout: {
        async readline(): Promise<string> {
          if (lineQueue.length > 0) {
            return lineQueue.shift()!;
          }
          if (closed) {
            return "";
          }
          return new Promise<string>((res) => {
            resolveLine = res;
          });
        },
      },
      terminate() {
        try {
          cp.kill();
        } catch {}
      },
    };
    return procObj;
  } catch {
    return null;
  }
}

export const PT_SEAMS: PersistentTerminalSeams = {
  platform: () => process.platform,
  realpath: (p: string) => path.resolve(p),
  spawn: defaultSpawn,
  time: () => Date.now() / 1000,
  uuidHex: () => randomUUID().replace(/-/g, ""),
};

export function _set_seams_for_parity(overrides: Partial<PersistentTerminalSeams>): void {
  Object.assign(PT_SEAMS, overrides);
}

export function _reset_seams(): void {
  PT_SEAMS.platform = () => process.platform;
  PT_SEAMS.realpath = (p: string) => path.resolve(p);
  PT_SEAMS.spawn = defaultSpawn;
  PT_SEAMS.time = () => Date.now() / 1000;
  PT_SEAMS.uuidHex = () => randomUUID().replace(/-/g, "");
}

/* ── Python 语义辅助函数 ── */

function pyStrip(s: string): string {
  return s.replace(/^[\s\r\n\t\v\f]+|[\s\r\n\t\v\f]+$/g, "");
}

function pyTimeoutStr(t: number): string {
  if (t === 60.0 || (Number.isInteger(t) && t === 60)) {
    return "60.0";
  }
  return String(t);
}

/* ── 异步锁 ── */

class AsyncLock {
  private _locked = false;
  private _waiting: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this._waiting.push(resolve);
    });
  }

  release(): void {
    if (this._waiting.length > 0) {
      const next = this._waiting.shift()!;
      next();
    } else {
      this._locked = false;
    }
  }
}

/* ── 单个会话的持久化 Shell 交互实例 ── */

export class PersistentShellSession {
  public session_id: string;
  public workspace_root: string;
  public is_windows: boolean;
  public proc: IPersistentProcess | null = null;
  private _lock: AsyncLock;

  constructor(session_id: string, workspace_root: string = ".") {
    this.session_id = session_id;
    this.workspace_root = PT_SEAMS.realpath(workspace_root || ".");
    this.is_windows = PT_SEAMS.platform() === "win32";
    this.proc = null;
    this._lock = new AsyncLock();
    this._start_shell();
  }

  public _start_shell(): void {
    if (this.proc !== null) {
      this._close_shell();
    }

    let cmd: string[];
    if (this.is_windows) {
      cmd = ["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"];
    } else {
      cmd = ["/bin/bash", "--norc"];
    }

    try {
      this.proc = PT_SEAMS.spawn(cmd, {
        cwd: this.workspace_root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "stdout",
        text: true,
        encoding: "utf-8",
        errors: "replace",
        bufsize: 1,
      });
    } catch {
      this.proc = null;
    }
  }

  public _close_shell(): void {
    if (this.proc) {
      try {
        this.proc.stdin?.close();
      } catch {}
      try {
        this.proc.terminate();
      } catch {}
      this.proc = null;
    }
  }

  public async execute(command: string, timeout_seconds: number = 60.0): Promise<[number, string]> {
    await this._lock.acquire();
    try {
      if (!this.proc || this.proc.poll() !== undefined && this.proc.poll() !== null) {
        this._start_shell();
      }

      if (!this.proc || !this.proc.stdin) {
        return [-1, "Error: Failed to spawn persistent shell"];
      }

      const marker_id = PT_SEAMS.uuidHex().slice(0, 12);
      const start_marker = `__OVOLVE_START_${marker_id}__`;
      const end_marker_prefix = `__OVOLVE_END_${marker_id}__`;

      let wrapped_script: string;
      if (this.is_windows) {
        wrapped_script =
          `Write-Output '${start_marker}'\n` +
          `${command}\n` +
          `$__mb_exit = if ($?) { 0 } else { 1 }\n` +
          `Write-Output '${end_marker_prefix}':$__mb_exit\n`;
      } else {
        wrapped_script =
          `echo '${start_marker}'\n` +
          `${command}\n` +
          `__mb_exit=$?\n` +
          `echo '${end_marker_prefix}':$__mb_exit\n`;
      }

      try {
        this.proc.stdin.write(wrapped_script);
        this.proc.stdin.flush?.();

        const captured_lines: string[] = [];
        let started = false;
        let exit_code = 0;
        const start_time = PT_SEAMS.time();

        while (true) {
          if (PT_SEAMS.time() - start_time > timeout_seconds) {
            this._start_shell();
            return [-1, `Command timed out after ${pyTimeoutStr(timeout_seconds)}s (shell reset)`];
          }

          const line = await this.proc.stdout?.readline();
          if (line === null || line === undefined || line === "") {
            break;
          }

          const stripped = pyStrip(line);
          if (!started) {
            if (stripped.includes(start_marker)) {
              started = true;
            }
            continue;
          }

          if (stripped.includes(end_marker_prefix)) {
            const escaped = end_marker_prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(`${escaped}:(\\d+)`);
            const match = re.exec(stripped);
            if (match && match[1]) {
              exit_code = parseInt(match[1], 10);
            }
            break;
          }

          captured_lines.push(line);
        }

        return [exit_code, captured_lines.join("")];
      } catch (e: any) {
        this._start_shell();
        return [-1, `Execution failed: ${e?.message ?? String(e)}`];
      }
    } finally {
      this._lock.release();
    }
  }
}

/* ── 持久化终端会话池 ── */

export class PersistentTerminalManager {
  private _sessions: Map<string, PersistentShellSession>;

  constructor() {
    this._sessions = new Map<string, PersistentShellSession>();
  }

  public get_or_create(session_id: string, workspace_root: string = "."): PersistentShellSession {
    let sess = this._sessions.get(session_id);
    if (!sess) {
      sess = new PersistentShellSession(session_id, workspace_root);
      this._sessions.set(session_id, sess);
    }
    return sess;
  }

  public close(session_id: string): void {
    const sess = this._sessions.get(session_id);
    if (sess) {
      this._sessions.delete(session_id);
      sess._close_shell();
    }
  }

  public close_all(): void {
    const all = Array.from(this._sessions.values());
    for (const s of all) {
      s._close_shell();
    }
    this._sessions.clear();
  }
}

/* ── 全局单例 ── */

const _terminal_manager = new PersistentTerminalManager();

export function get_terminal_manager(): PersistentTerminalManager {
  return _terminal_manager;
}

// PORT STATUS: 本文件无 TODO(port)。
