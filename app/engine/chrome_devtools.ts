/**
 * chrome_devtools.ts — Chrome DevTools Protocol (CDP) 深度控制台与网络排错桥接
 *
 * Ported from `app/backend/chrome_devtools.py` (198 lines).
 *
 * 功能（源 docstring，保留为合同）：
 * 1. 本地连接 Chrome 调试端口 (默认 9222)
 * 2. 捕获浏览器控制台报错与 JS 异常堆栈
 * 3. 捕获网络失败请求 (status >= 400)
 * 4. 单步执行 JS 表达式评估与 DOM 诊断
 * 5. Page.screencast 录屏生命周期控制（start / stop / status）
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only — urllib.request → global fetch (Node 22 native);
 *       no new dependency row.
 *   §2  `except Exception: return []/False` swallows preserved verbatim —
 *       CDP probes fail-open by design (Chrome not running is a normal state,
 *       not an error).
 *   §2  module singletons (_GLOBAL_CDP_CLIENT / _GLOBAL_SCREENCAST_RECORDER)
 *       keep the same lazy semantics; the screencast recorder import is a
 *       static import here (no import-loop hazard in the engine graph).
 *   §4  naming: chrome_devtools.py → chrome_devtools.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as path from "node:path";

import { Result } from "./result.js";
import { CDPScreencastRecorder, VideoComposer } from "./cdp_screencast.js";

export interface ConsoleMessage {
  /** "error" | "warning" | "info" */
  level: string;
  text: string;
  source: string;
  url: string;
  line: number;
}

export interface NetworkRequestError {
  url: string;
  method: string;
  status: number;
  status_text: string;
  error_text: string;
}

export class ChromeDevToolsClient {
  /** 轻量级 Chrome DevTools Protocol (CDP) 调试客户端 */

  cdp_host: string;
  cdp_port: number;
  base_url: string;
  private _console_logs: ConsoleMessage[] = [];
  private _network_errors: NetworkRequestError[] = [];

  constructor(cdp_host = "127.0.0.1", cdp_port = 9222) {
    this.cdp_host = cdp_host;
    this.cdp_port = cdp_port;
    this.base_url = `http://${cdp_host}:${cdp_port}`;
  }

  /** 检测 Chrome 是否以 --remote-debugging-port 启动 */
  async is_chrome_running_with_cdp(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.base_url}/json/version`, {
        headers: { "User-Agent": "OvolveDevTools" },
        signal: AbortSignal.timeout(1500),
      });
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  /** 列出当前所有打开的页面标签 */
  async list_tabs(): Promise<Record<string, unknown>[]> {
    try {
      const resp = await fetch(`${this.base_url}/json/list`, {
        headers: { "User-Agent": "OvolveDevTools" },
        signal: AbortSignal.timeout(2000),
      });
      const data = (await resp.json()) as Array<Record<string, unknown>>;
      return data
        .filter((tab) => tab["type"] === "page")
        .map((tab) => ({
          id: tab["id"],
          title: tab["title"],
          url: tab["url"],
          type: tab["type"],
          webSocketDebuggerUrl: tab["webSocketDebuggerUrl"],
        }));
    } catch {
      return [];
    }
  }

  /** 获取浏览器当前控制台报错与网络诊断汇总 */
  async get_diagnostics_summary(): Promise<Record<string, unknown>> {
    const is_live = await this.is_chrome_running_with_cdp();
    if (!is_live) {
      return {
        status: "cdp_unavailable",
        message:
          `Chrome 未在端口 ${this.cdp_port} 开启远程调试。` +
          `启动命令: chrome.exe --remote-debugging-port=${this.cdp_port}`,
        console_errors_count: 0,
        network_errors_count: 0,
        tabs: [],
      };
    }

    const tabs = await this.list_tabs();
    return {
      status: "connected",
      cdp_port: this.cdp_port,
      tabs_count: tabs.length,
      tabs: tabs.slice(0, 5),
      console_errors: this._console_logs.slice(-10).map((m) => ({
        level: m.level, text: m.text, url: m.url, line: m.line,
      })),
      network_errors: this._network_errors.slice(-10).map((n) => ({
        url: n.url, method: n.method, status: n.status, status_text: n.status_text,
      })),
    };
  }

  /** 记录诊断错误日志 */
  record_simulated_error(level: string, text: string, url = "", line = 0): void {
    this._console_logs.push({ level, text, url, line, source: "" });
  }

  /** 记录一次网络失败请求（CDP 事件桥调用） */
  record_network_error(n: Partial<NetworkRequestError>): void {
    this._network_errors.push({
      url: n.url ?? "",
      method: n.method ?? "",
      status: n.status ?? 0,
      status_text: n.status_text ?? "",
      error_text: n.error_text ?? "",
    });
  }
}

let _GLOBAL_CDP_CLIENT: ChromeDevToolsClient | null = null;
let _GLOBAL_SCREENCAST_RECORDER: CDPScreencastRecorder | null = null;

export function get_chrome_devtools_client(): ChromeDevToolsClient {
  if (_GLOBAL_CDP_CLIENT === null) {
    _GLOBAL_CDP_CLIENT = new ChromeDevToolsClient();
  }
  return _GLOBAL_CDP_CLIENT;
}

const _SCREENCAST_ACTIONS: readonly string[] = [
  "screencast_start", "screencast_stop", "screencast_status",
];

/** 返回进程内唯一的 CDP 录屏录制器单例（懒加载，fail-open）。 */
export function get_screencast_recorder(): CDPScreencastRecorder {
  if (_GLOBAL_SCREENCAST_RECORDER === null) {
    _GLOBAL_SCREENCAST_RECORDER = new CDPScreencastRecorder();
  }
  return _GLOBAL_SCREENCAST_RECORDER;
}

async function _screencast_status(client: ChromeDevToolsClient): Promise<Record<string, unknown>> {
  const recorder = get_screencast_recorder();
  return {
    status: "ok",
    recording: recorder.is_recording(),
    session: recorder.is_recording() ? recorder.session_info : null,
    frames: recorder.get_recorded_frames().length,
    cdp_available: await client.is_chrome_running_with_cdp(),
  };
}

async function _screencast_start(
  client: ChromeDevToolsClient,
  kwargs: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const {
    tab_id = "",
    output_dir = null,
    fps = 10,
    quality = 80,
    max_width = 1280,
    max_height = 720,
  } = kwargs as {
    tab_id?: string;
    output_dir?: string | null;
    fps?: number;
    quality?: number;
    max_width?: number;
    max_height?: number;
  };
  const recorder = get_screencast_recorder();
  if (recorder.is_recording()) {
    return {
      status: "error",
      message: "录屏已在进行中，请先 screencast_stop 后再启动",
      recording: true,
      session: recorder.session_info,
    };
  }

  let resolved_tab = tab_id;
  if (!resolved_tab) {
    const tabs = await client.list_tabs();
    resolved_tab = tabs.length > 0 ? String(tabs[0]!["id"] ?? "") : "";
  }
  if (!resolved_tab) {
    resolved_tab = "active-tab";
  }

  const started = recorder.start_recording(resolved_tab, output_dir, fps, quality, max_width, max_height);
  if (!started.ok) {
    return { status: "error", message: started.error, recording: false };
  }

  if (!(await client.is_chrome_running_with_cdp())) {
    // Fail-open：Chrome 未开远程调试时录制器照样就绪，只是收不到帧，
    // 绝不抛异常阻断调用方。
    return {
      status: "degraded",
      message:
        `Chrome 未在端口 ${client.cdp_port} 开启远程调试，录制器已就绪但` +
        "不会收到 Page.screencastFrame 帧。开启远程调试后可正常录屏。",
      recording: true,
      session: recorder.session_info,
    };
  }

  return { status: "ok", recording: true, session: recorder.session_info };
}

async function _screencast_stop(): Promise<Record<string, unknown>> {
  const recorder = get_screencast_recorder();
  if (!recorder.is_recording()) {
    return { status: "error", message: "当前未在录屏状态", recording: false };
  }

  const fps = Number(recorder.session_info["fps"] ?? 10) || 10;
  const stopped = recorder.stop_recording();
  if (!stopped.ok) {
    return { status: "error", message: stopped.error, recording: true };
  }

  const summary: Record<string, unknown> = { ...(stopped.value as Record<string, unknown>) };
  if (Number(summary["total_frames"] ?? 0) > 0) {
    // 有帧才合帧；合帧失败只记录，不影响停止结果（fail-open）。
    try {
      const out_file = path.join(String(summary["output_dir"] ?? "."), "screencast.mp4");
      const composed = await new VideoComposer().compose(String(summary["output_dir"]), out_file, fps);
      summary["composed"] = composed.ok ? composed.value : { error: composed.error };
    } catch (exc) {
      summary["composed"] = { error: `合帧异常（已忽略）: ${exc instanceof Error ? exc.message : String(exc)}` };
    }
  }

  return { status: "ok", recording: false, summary };
}

/** chrome_devtools 工具运行时处理入口 */
export async function chrome_devtools_handler(
  action = "summary",
  kwargs: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const client = get_chrome_devtools_client();
  if (action === "summary") {
    return client.get_diagnostics_summary();
  } else if (action === "tabs") {
    return { status: "ok", tabs: await client.list_tabs() };
  } else if (action === "screencast_start") {
    return _screencast_start(client, kwargs);
  } else if (action === "screencast_stop") {
    return _screencast_stop();
  } else if (action === "screencast_status") {
    return _screencast_status(client);
  }
  return { status: "error", message: `未知的 DevTools 动作: '${action}'` };
}

void _SCREENCAST_ACTIONS;
void Result;
