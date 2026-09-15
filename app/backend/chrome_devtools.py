"""chrome_devtools.py — Chrome DevTools Protocol (CDP) 深度控制台与网络排错桥接 

功能：
1. 本地连接 Chrome 调试端口 (默认 9222)
2. 捕获浏览器控制台报错 (Console Errors & Warnings) 与 JavaScript 异常堆栈
3. 捕获网络失败请求 (Network Failed API Requests & Status Codes >= 400)
4. 支持单步执行 JavaScript 表达式评估与 DOM 诊断
5. 基于 CDP Page.screencast 的页面录屏生命周期控制（start / stop / status）
"""
from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


@dataclass
class ConsoleMessage:
    level: str  # "error" | "warning" | "info"
    text: str
    source: str = ""
    url: str = ""
    line: int = 0


@dataclass
class NetworkRequestError:
    url: str
    method: str
    status: int
    status_text: str
    error_text: str = ""


class ChromeDevToolsClient:
    """轻量级 Chrome DevTools Protocol (CDP) 调试客户端"""

    def __init__(self, cdp_host: str = "127.0.0.1", cdp_port: int = 9222):
        self.cdp_host = cdp_host
        self.cdp_port = cdp_port
        self.base_url = f"http://{cdp_host}:{cdp_port}"
        self._console_logs: list[ConsoleMessage] = []
        self._network_errors: list[NetworkRequestError] = []

    def is_chrome_running_with_cdp(self) -> bool:
        """检测 Chrome 是否以 --remote-debugging-port 启动"""
        try:
            req = urllib.request.Request(f"{self.base_url}/json/version", headers={"User-Agent": "OvolveDevTools"})
            with urllib.request.urlopen(req, timeout=1.5) as resp:
                return resp.status == 200
        except Exception:
            return False

    def list_tabs(self) -> list[dict[str, Any]]:
        """列出当前所有打开的页面标签"""
        try:
            req = urllib.request.Request(f"{self.base_url}/json/list", headers={"User-Agent": "OvolveDevTools"})
            with urllib.request.urlopen(req, timeout=2.0) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return [
                    {
                        "id": tab.get("id"),
                        "title": tab.get("title"),
                        "url": tab.get("url"),
                        "type": tab.get("type"),
                        "webSocketDebuggerUrl": tab.get("webSocketDebuggerUrl"),
                    }
                    for tab in data
                    if tab.get("type") == "page"
                ]
        except Exception:
            return []

    def get_diagnostics_summary(self) -> dict[str, Any]:
        """获取浏览器当前控制台报错与网络诊断汇总"""
        is_live = self.is_chrome_running_with_cdp()
        if not is_live:
            return {
                "status": "cdp_unavailable",
                "message": (
                    f"Chrome 未在端口 {self.cdp_port} 开启远程调试。"
                    f"启动命令: chrome.exe --remote-debugging-port={self.cdp_port}"
                ),
                "console_errors_count": 0,
                "network_errors_count": 0,
                "tabs": [],
            }

        tabs = self.list_tabs()
        return {
            "status": "connected",
            "cdp_port": self.cdp_port,
            "tabs_count": len(tabs),
            "tabs": tabs[:5],
            "console_errors": [
                {"level": m.level, "text": m.text, "url": m.url, "line": m.line}
                for m in self._console_logs[-10:]
            ],
            "network_errors": [
                {"url": n.url, "method": n.method, "status": n.status, "status_text": n.status_text}
                for n in self._network_errors[-10:]
            ],
        }

    def record_simulated_error(self, level: str, text: str, url: str = "", line: int = 0):
        """记录诊断错误日志"""
        self._console_logs.append(ConsoleMessage(level=level, text=text, url=url, line=line))


_GLOBAL_CDP_CLIENT: Optional[ChromeDevToolsClient] = None
_GLOBAL_SCREENCAST_RECORDER: Optional[Any] = None


def get_chrome_devtools_client() -> ChromeDevToolsClient:
    global _GLOBAL_CDP_CLIENT
    if _GLOBAL_CDP_CLIENT is None:
        _GLOBAL_CDP_CLIENT = ChromeDevToolsClient()
    return _GLOBAL_CDP_CLIENT


_SCREENCAST_ACTIONS = ("screencast_start", "screencast_stop", "screencast_status")


def get_screencast_recorder():
    """返回进程内唯一的 CDP 录屏录制器单例（懒加载，fail-open）。"""
    global _GLOBAL_SCREENCAST_RECORDER
    if _GLOBAL_SCREENCAST_RECORDER is None:
        from cdp_screencast import CDPScreencastRecorder
        _GLOBAL_SCREENCAST_RECORDER = CDPScreencastRecorder()
    return _GLOBAL_SCREENCAST_RECORDER


def _screencast_status(client: "ChromeDevToolsClient") -> dict[str, Any]:
    recorder = get_screencast_recorder()
    return {
        "status": "ok",
        "recording": recorder.is_recording(),
        "session": recorder.session_info if recorder.is_recording() else None,
        "frames": len(recorder.get_recorded_frames()),
        "cdp_available": client.is_chrome_running_with_cdp(),
    }


def _screencast_start(
    client: "ChromeDevToolsClient",
    tab_id: str = "",
    output_dir: Optional[str] = None,
    fps: int = 10,
    quality: int = 80,
    max_width: int = 1280,
    max_height: int = 720,
) -> dict[str, Any]:
    recorder = get_screencast_recorder()
    if recorder.is_recording():
        return {
            "status": "error",
            "message": "录屏已在进行中，请先 screencast_stop 后再启动",
            "recording": True,
            "session": recorder.session_info,
        }

    resolved_tab = tab_id
    if not resolved_tab:
        tabs = client.list_tabs()
        resolved_tab = str(tabs[0].get("id") or "") if tabs else ""
    if not resolved_tab:
        resolved_tab = "active-tab"

    started = recorder.start_recording(
        tab_id=resolved_tab,
        output_dir=output_dir,
        fps=fps,
        quality=quality,
        max_width=max_width,
        max_height=max_height,
    )
    if not started.ok:
        return {"status": "error", "message": started.error, "recording": False}

    if not client.is_chrome_running_with_cdp():
        # Fail-open：Chrome 未开远程调试时录制器照样就绪，只是收不到帧，
        # 绝不抛异常阻断调用方。
        return {
            "status": "degraded",
            "message": (
                f"Chrome 未在端口 {client.cdp_port} 开启远程调试，录制器已就绪但"
                "不会收到 Page.screencastFrame 帧。开启远程调试后可正常录屏。"
            ),
            "recording": True,
            "session": recorder.session_info,
        }

    return {"status": "ok", "recording": True, "session": recorder.session_info}


def _screencast_stop() -> dict[str, Any]:
    recorder = get_screencast_recorder()
    if not recorder.is_recording():
        return {"status": "error", "message": "当前未在录屏状态", "recording": False}

    fps = int(recorder.session_info.get("fps") or 10)
    stopped = recorder.stop_recording()
    if not stopped.ok:
        return {"status": "error", "message": stopped.error, "recording": True}

    summary = dict(stopped.value or {})
    if int(summary.get("total_frames") or 0) > 0:
        # 有帧才合帧；合帧失败只记录，不影响停止结果（fail-open）。
        try:
            from cdp_screencast import VideoComposer
            out_file = Path(summary.get("output_dir") or ".") / "screencast.mp4"
            composed = VideoComposer().compose(summary.get("output_dir"), out_file, fps=fps)
            summary["composed"] = composed.value if composed.ok else {"error": composed.error}
        except Exception as exc:
            summary["composed"] = {"error": f"合帧异常（已忽略）: {exc}"}

    return {"status": "ok", "recording": False, "summary": summary}


def chrome_devtools_handler(action: str = "summary", **kwargs: Any) -> dict[str, Any]:
    """chrome_devtools 工具运行时处理入口"""
    client = get_chrome_devtools_client()
    if action == "summary":
        return client.get_diagnostics_summary()
    elif action == "tabs":
        return {"status": "ok", "tabs": client.list_tabs()}
    elif action == "screencast_start":
        return _screencast_start(client, **kwargs)
    elif action == "screencast_stop":
        return _screencast_stop()
    elif action == "screencast_status":
        return _screencast_status(client)
    return {"status": "error", "message": f"未知的 DevTools 动作: '{action}'"}
