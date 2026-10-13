/**
 * device_fingerprint.ts — Anonymous device identity + capability reporting.
 *
 * Ported from `app/backend/device_fingerprint.py` (196 lines).
 *
 * Named as a flat module rather than telemetry/device on purpose: the existing
 * telemetry is a flat module (源注释保留)。
 *
 * Privacy stance:
 * - the device id is a salted hash, not raw hardware identifiers
 * - MAC addresses, serial numbers and usernames never leave this module
 * - capability reporting is coarse (counts and rounded sizes), not exact specs
 *
 * RULEBOOK CITATIONS
 *   §1  node:crypto (sha256) / node:os。
 *   §2  uuid.getnode()（MAC 派生 node id）在 Node 无直接等价 → 以
 *     hostname + arch + homedir 组合替代原始 node 输入（同样是"稳定、匿名、
 *     不可逆"语义；salt 不变）。DIVERGENCE(port)：node id 输入随运行时切换，
 *     稳定/匿名/不可逆三性质不变。
 *   §2  shutil.disk_usage → fs.statfsSync（Node 22+）；psutil/ctypes 内存
 *       探测 → os.totalmem()（Node 内建，跨平台）；psutil 可选增强分支在
 *       Node 无对应（os.totalmem 本身零依赖且跨平台，分支合并）。
 *   §2  accelerators 的 import 探测 → require.resolve 探测（openvino/
 *       onnxruntime/paddleocr 是 Python 生态；TS 侧探测同名 npm 包不存在
 *       即 false —— 保留接口与结果形状）。DIVERGENCE(port)：探测对象随生态切换，
 *       结果形状不变。
 *   §4  naming: device_fingerprint.py → device_fingerprint.ts
 *
 * PORT STATUS: confidence=medium todos=0
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

import { Result } from "./result.js";

/** Salt keeps the derived id from being reversible to the raw node id. */
const _FINGERPRINT_SALT = Buffer.from("ovolve-device-v1", "utf-8");

/** Derive a stable, anonymous device identifier and report capabilities. */
export class DeviceFingerprint {
  _salt: Buffer;
  _cached_id: string | null;

  constructor(salt: Buffer = _FINGERPRINT_SALT) {
    this._salt = salt;
    this._cached_id = null;
  }

  // ------------------------------------------------------------------
  // Identity
  // ------------------------------------------------------------------

  /** Return a stable anonymous device id (hex, 32 chars).
   * Stable across restarts on the same machine/user, and not reversible. */
  device_id(): string {
    if (this._cached_id) {
      return this._cached_id;
    }
    // uuid.getnode() 替代：hostname + platform + arch + homedir（稳定匿名）
    let node_id = "";
    try {
      node_id = os.hostname();
    } catch {
      node_id = "unknown-host";
    }
    const raw = [
      node_id,
      os.platform(),
      os.arch(),
      os.homedir(),
    ].join("|");
    this._cached_id = crypto
      .createHash("sha256")
      .update(Buffer.concat([this._salt, Buffer.from(raw, "utf-8")]))
      .digest("hex")
      .slice(0, 32);
    return this._cached_id;
  }

  // ------------------------------------------------------------------
  // Capabilities
  // ------------------------------------------------------------------

  /** Report OS / runtime versions (no hostname, no username). */
  platform_info(): Record<string, unknown> {
    return {
      os: os.platform(),
      os_release: os.release(),
      arch: os.arch(),
      python: `node ${process.version}`, // python_version 字段名保留契约
      python_impl: "node", // python_implementation 字段名保留契约
      is_64bit: os.arch().includes("64"),
    };
  }

  /** Report coarse CPU capability. */
  cpu_info(): Record<string, unknown> {
    const cpus = os.cpus();
    return {
      logical_cores: cpus.length || 0,
      processor_family: cpus.length > 0 ? cpus[0]!.model : "unknown",
    };
  }

  /** Report total RAM in GiB, rounded. Empty dict when undetectable. */
  memory_info(): Record<string, unknown> {
    try {
      const total = os.totalmem();
      return { total_gib: Math.round((total / 1024 ** 3) * 10) / 10 };
    } catch {
      return {};
    }
  }

  /** Report disk capacity for a path, rounded to GiB. */
  disk_info(p?: string | null): Record<string, unknown> {
    const target = p || os.homedir();
    try {
      const st = fs.statfsSync(target);
      const total = Number(st.blocks) * Number(st.bsize);
      const free = Number(st.bavail) * Number(st.bsize);
      return {
        total_gib: Math.round((total / 1024 ** 3) * 10) / 10,
        free_gib: Math.round((free / 1024 ** 3) * 10) / 10,
      };
    } catch {
      return {};
    }
  }

  /** Detect which local inference accelerators are usable.
   * Detection is import-based (no device enumeration) to stay cheap. */
  accelerators(): Record<string, boolean> {
    const result: Record<string, boolean> = {
      openvino: false,
      onnxruntime: false,
      paddleocr: false,
    };
    // Python __import__ 探测 → require.resolve 探测（同名 npm 包不存在即
    // false；embedder.ts 的 onnxruntime-node 装了则 onnxruntime 为 true）
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const req = eval("require") as NodeRequire;
      try {
        req.resolve("onnxruntime-node");
        result["onnxruntime"] = true;
      } catch {
        result["onnxruntime"] = false;
      }
    } catch {
      // require unavailable (ESM-only): all false
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Aggregate
  // ------------------------------------------------------------------

  /** Build the full anonymous device report. */
  report(): Result<Record<string, unknown>> {
    try {
      const payload = {
        device_id: this.device_id(),
        platform: this.platform_info(),
        cpu: this.cpu_info(),
        memory: this.memory_info(),
        disk: this.disk_info(),
        accelerators: this.accelerators(),
      };
      return Result.success(payload);
    } catch (exc) {
      // never break startup over telemetry
      return Result.failure(`Device report failed: ${exc instanceof Error ? exc.message : String(exc)}`, {
        code: "ReportFailed",
      });
    }
  }
}

let _fingerprint: DeviceFingerprint | null = null;

/** Get the global DeviceFingerprint singleton. */
export function get_device_fingerprint(): DeviceFingerprint {
  if (_fingerprint === null) {
    _fingerprint = new DeviceFingerprint();
  }
  return _fingerprint;
}
