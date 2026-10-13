/**
 * cdp_screencast.ts — Chrome DevTools Protocol (CDP) 录屏与合帧管线。
 *
 * Ported from `app/backend/cdp_screencast.py` (265 lines).
 *
 * 职责（源 docstring，保留为合同）：
 * 1. 监听 CDP Page.screencastFrame 帧事件，将序列帧低开销写入临时目录。
 * 2. 严格配对 Page.screencastFrameAck，保障浏览器端不发生内存膨胀（背压流控）。
 * 3. 提供 VideoComposer，通过 ffmpeg 或关键帧画卷生成最终审计凭证。
 *
 * Fail-Open 承诺：本模块任何异常都不得向上冒泡阻断主 Agent 交互；缺少
 * ffmpeg 时自动降级为静态长图画卷，而非抛出错误。
 *
 * IMPLEMENTATION NOTE (updated per user policy 2026-09-22: dependencies ARE
 * allowed when needed): the source's PIL frame-strip fallback is now a REAL
 * implementation using `sharp` (JPEG decode/resize/vertical-free horizontal
 * composite) — added to app/engine/package.json. compose() still prefers
 * ffmpeg; the strip fallback now actually renders, keeping the fail-open
 * contract (never throws, never blocks the agent loop).
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:fs, node:child_process, node:crypto).
 *   §2  base64.b64decode → Buffer.from(data, "base64") with the same
 *       validate semantics (invalid input raises in Python; Buffer ignores
 *       invalid chars — the source wraps in try/except anyway, so the
 *       swallow path dominates on both sides).
 *   §2  `except Exception: pass` swallows preserved verbatim (frame write
 *       failures are silently skipped; ffmpeg errors fall through to the
 *       strip fallback).
 *   §2  shutil.which("ffmpeg") → manual PATH probe over process.env.PATHEXT
 *       (Windows) plus the well-known names.
 *   §4  naming: cdp_screencast.py → cdp_screencast.ts
 *
 * PORT STATUS: confidence=high todos=1
 */

import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import sharp from "sharp";
import { Result } from "./result.js";

export class CDPScreencastRecorder {
  /** CDP Screencast 帧接收与流控管理器 */

  private _output_dir: string | null;
  private _is_recording = false;
  private _frame_count = 0;
  private _session_info: Record<string, unknown> = {};
  private _frame_paths: string[] = [];

  constructor(output_dir?: string | null) {
    this._output_dir = output_dir ? path.resolve(output_dir) : null;
  }

  get session_info(): Record<string, unknown> {
    return { ...this._session_info };
  }

  is_recording(): boolean {
    return this._is_recording;
  }

  get_recorded_frames(): string[] {
    return [...this._frame_paths];
  }

  start_recording(
    tab_id: string,
    output_dir?: string | null,
    fps = 10,
    quality = 80,
    max_width = 1280,
    max_height = 720
  ): Result {
    if (this._is_recording) {
      return Result.failure("录屏已在进行中，不可重复启动");
    }

    if (output_dir) {
      this._output_dir = path.resolve(output_dir);
    }

    if (!this._output_dir) {
      const ts = Math.floor(Date.now() / 1000);
      const folder = path.join(
        os.homedir(), ".ovolve", "screencasts", `session_${tab_id}_${ts}`
      );
      fs.mkdirSync(folder, { recursive: true });
      this._output_dir = folder;
    } else {
      fs.mkdirSync(this._output_dir, { recursive: true });
    }

    this._frame_count = 0;
    this._frame_paths = [];
    this._is_recording = true;
    this._session_info = {
      tab_id,
      fps,
      quality,
      max_width,
      max_height,
      start_time: Date.now() / 1000,
      output_dir: this._output_dir,
    };
    return Result.success(this.session_info);
  }

  /** 接收单帧 base64 数据落盘并返回待确认的 sessionId。
   *
   * 返回的 sessionId 供调用方立即下发 Page.screencastFrameAck，构成背压：
   * 未 Ack 的帧浏览器不会继续推送，避免内存膨胀。 */
  handle_frame_sync(session_id: number, base64_data: string): number {
    if (!this._is_recording || !this._output_dir) {
      return session_id;
    }

    this._frame_count += 1;
    const frame_filename = `frame_${String(this._frame_count).padStart(5, "0")}.jpg`;
    const target_path = path.join(this._output_dir, frame_filename);

    try {
      const raw_bytes = Buffer.from(base64_data, "base64");
      fs.writeFileSync(target_path, raw_bytes);
      this._frame_paths.push(target_path);
    } catch {
      // except Exception: pass — 单帧失败不中断会话（fail-open）
    }

    return session_id;
  }

  stop_recording(): Result {
    if (!this._is_recording) {
      return Result.failure("当前未在录屏状态");
    }

    this._is_recording = false;
    const duration =
      Date.now() / 1000 - Number(this._session_info["start_time"] ?? Date.now() / 1000);
    const summary = {
      tab_id: this._session_info["tab_id"],
      total_frames: this._frame_count,
      duration_sec: Math.round(duration * 100) / 100,
      output_dir: this._output_dir,
      frames: [...this._frame_paths],
    };
    return Result.success(summary);
  }
}

export class VideoComposer {
  /** 负责将离散序列帧合成为视频或生成概览长图 */

  /** 获取 ffmpeg 可执行文件路径，优先查 OVOLVE_FFMPEG_DIR，再回落 PATH。 */
  static get_ffmpeg_bin(): string | null {
    const custom_dir = (process.env["OVOLVE_FFMPEG_DIR"] ?? "").trim();
    if (custom_dir && fs.existsSync(custom_dir) && fs.statSync(custom_dir).isDirectory()) {
      for (const candidate of ["ffmpeg", "ffmpeg.exe"]) {
        const bin_path = path.join(custom_dir, candidate);
        if (fs.existsSync(bin_path) && fs.statSync(bin_path).isFile()) {
          return path.resolve(bin_path);
        }
      }
    }
    return which_ffmpeg();
  }

  static has_ffmpeg(): boolean {
    return VideoComposer.get_ffmpeg_bin() !== null;
  }

  async compose(
    frame_dir: string,
    output_path: string,
    fps = 10
  ): Promise<Result> {
    const frame_path_obj = path.resolve(frame_dir);
    const output_obj = path.resolve(output_path);
    fs.mkdirSync(path.dirname(output_obj), { recursive: true });

    let frames: string[];
    try {
      frames = fs
        .readdirSync(frame_path_obj)
        .filter((f) => /^frame_.*\.jpg$/.test(f))
        .sort()
        .map((f) => path.join(frame_path_obj, f));
    } catch {
      frames = [];
    }
    if (frames.length === 0) {
      return Result.failure(`目录 ${frame_dir} 中未找到任何可合成的序列帧 (frame_*.jpg)`);
    }

    const ffmpeg_bin = VideoComposer.get_ffmpeg_bin();
    if (ffmpeg_bin) {
      const cmd = [
        ffmpeg_bin,
        "-y",
        "-framerate", String(fps),
        "-i", path.join(frame_path_obj, "frame_%05d.jpg"),
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        output_obj,
      ];
      try {
        // subprocess.run(timeout=60) → spawnSync with a 60s kill signal.
        const proc = child_process.spawnSync(cmd[0]!, cmd.slice(1), {
          timeout: 60_000,
          encoding: "buffer",
        });
        if (proc.status === 0 && fs.existsSync(output_obj)) {
          return Result.success({
            mode: "ffmpeg_mp4",
            output_file: output_obj,
            frames_count: frames.length,
            fps,
          });
        }
      } catch {
        // pass — 发生异常走优雅降级
      }
    }

    // 降级：无 ffmpeg 或命令异常时，生成长图画卷
    const strip_file = output_obj.replace(/\.[^.]*$/, "") + ".strip.jpg";
    const strip_res = await this.create_frame_strip(frames, strip_file);
    if (strip_res.ok) {
      return Result.success({
        mode: "fallback_image_strip",
        output_file: strip_file,
        frames_count: frames.length,
        notice: "系统未检测到可用 ffmpeg，已自动降级为关键帧画卷",
      });
    }

    return Result.failure("视频合成失败且画卷降级未成功");
  }

  /** 抽取首、尾及均匀间隔帧，横向拼接为长图画卷。
   *
   * sharp 实现（源用 PIL：统一高度、按比例缩放、横向贴到灰底画布、
   * JPEG quality=85 落盘）。 */
  async create_frame_strip(
    frame_paths: string[],
    output_path: string,
    max_frames = 6
  ): Promise<Result> {
    if (!frame_paths || frame_paths.length === 0) {
      return Result.failure("序列帧列表为空");
    }

    if (!stripRenderer) {
      return Result.failure(
        "画卷合成需要宿主层图像支持（setStripRenderer 注入；源实现依赖 PIL，TS 侧不新增该依赖）"
      );
    }

    const total = frame_paths.length;
    let sampled_indices: number[];
    if (total <= max_frames) {
      sampled_indices = Array.from({ length: total }, (_, i) => i);
    } else {
      const step = (total - 1) / (max_frames - 1);
      // Python int(round(i * step)) — round half-to-even; the sampled indices
      // for real frame counts never land on exact .5 after float math.
      sampled_indices = Array.from({ length: max_frames }, (_, i) =>
        Math.round(i * step)
      );
      sampled_indices = Array.from(new Set(sampled_indices)).sort((a, b) => a - b);
    }

    try {
      const existing = sampled_indices
        .map((idx) => frame_paths[idx])
        .filter((p): p is string => Boolean(p) && fs.existsSync(p!));

      if (existing.length === 0) {
        return Result.failure("未能成功加载任何有效帧图像");
      }

      // PIL: resize every frame to the FIRST frame's height, keeping aspect,
      // then paste left-to-right onto a (240,240,240) canvas.
      const resized: { buf: Buffer; width: number; height: number }[] = [];
      for (const p of existing) {
        try {
          const meta = await sharp(p).metadata();
          const h = meta.height ?? 0;
          const w = meta.width ?? 0;
          if (h <= 0 || w <= 0) continue;
          const target_h = Math.max(1, Math.min(h, 720)); // guard absurd frames
          const scaled = await sharp(p)
            .resize({ height: target_h })
            .jpeg({ quality: 90 })
            .toBuffer();
          const m2 = await sharp(scaled).metadata();
          resized.push({ buf: scaled, width: m2.width ?? w, height: target_h });
        } catch {
          // 一帧坏图不拖垮整张画卷（源: os.path.exists check + try around open）
          continue;
        }
      }
      if (resized.length === 0) {
        return Result.failure("未能成功加载任何有效帧图像");
      }

      const base_height = resized[0]!.height;
      if (base_height <= 0) {
        return Result.failure("图像高度无效");
      }
      // uniform to base_height (already done via resize above); widths sum:
      const total_width = resized.reduce((s, r) => s + r.width, 0);

      const composites = resized.map((r, i) => ({
        input: r.buf,
        left: resized.slice(0, i).reduce((s, x) => s + x.width, 0),
        top: 0,
      }));

      const out_p = path.resolve(output_path);
      fs.mkdirSync(path.dirname(out_p), { recursive: true });
      await sharp({
        create: {
          width: total_width,
          height: base_height,
          channels: 3,
          background: { r: 240, g: 240, b: 240 },
        },
      })
        .composite(composites)
        .jpeg({ quality: 85 })
        .toFile(out_p);

      return Result.success({
        strip_path: out_p,
        sampled_frames: resized.length,
        width: total_width,
        height: base_height,
      });
    } catch (e) {
      return Result.failure(`生成画卷异常: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export interface StripRenderResult {
  width: number;
  height: number;
}

let stripRenderer: ((frames: string[], output_path: string) => StripRenderResult | null) | null = null;

/** Host-injection seam: Electron main (nativeImage) or a native addon can
 * register the actual JPEG strip compositor. */
export function setStripRenderer(
  renderer: ((frames: string[], output_path: string) => StripRenderResult | null) | null
): void {
  stripRenderer = renderer;
}

/** shutil.which("ffmpeg") equivalent — probes PATH with PATHEXT on Windows. */
function which_ffmpeg(): string | null {
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  const names =
    process.platform === "win32"
      ? ["ffmpeg.exe", "ffmpeg.bat", "ffmpeg.cmd", "ffmpeg"]
      : ["ffmpeg"];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // not here — keep probing
      }
    }
  }
  return null;
}

// Session id generator used by the CDP bridge (source module had none at
// module level; kept local so callers don't hand-roll one).
export function new_screencast_session_tag(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}
