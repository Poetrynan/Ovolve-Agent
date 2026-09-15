"""
app_agent.py - Application & Native Computer Use Sub-Agent (Matrix / Specialist Architecture).

Industrial-grade desktop GUI automation adhering to Anthropic & Operator Computer Use standards:
- Native Win32 SendInput & GDI high-precision capture (via native_desktop.py)
- High-DPI physical-to-logical coordinate scaling & multi-monitor support
- Unicode-native direct typing (zero IME / Chinese input method interference)
- Bezier human-like smooth mouse trajectories & failsafe interrupt detection
"""
from __future__ import annotations
import os
import platform
import subprocess
from typing import Optional, Dict, Any
from result import Result, try_result
from event_bus import get_event_bus
from executors import BlockedCommandError, guarded_spawn, shell_word
from telemetry import get_telemetry, SpanName
from tools import ToolDef, get_tool_registry
from native_desktop import get_native_desktop, DesktopMetrics


class AppAgent:
    DOMAIN = "app"

    def __init__(self, workspace: str = None):
        self.workspace = workspace or os.getcwd()
        self.bus = get_event_bus()
        self.telemetry = get_telemetry()
        self.tools = get_tool_registry()
        self.desktop = get_native_desktop()
        self._register_tools()

    def _register_tools(self):
        for td in self._build_tool_defs():
            self.tools.register(td)

    def _build_tool_defs(self):
        return [
            # ─── Standard Computer Use Toolset ──────────────────────────────
            ToolDef(
                "computer_screenshot",
                "Computer Use: Capture high-resolution desktop screenshot with DPI awareness and Base64 output.",
                {
                    "type": "object",
                    "properties": {
                        "roi": {
                            "type": "array",
                            "items": {"type": "integer"},
                            "description": "Optional Region of Interest: [x, y, width, height] in screen pixels.",
                        },
                        "save_path": {
                            "type": "string",
                            "description": "Optional file path to save PNG/JPEG on disk.",
                        },
                        "quality": {
                            "type": "integer",
                            "default": 80,
                            "description": "JPEG compression quality (1-100).",
                        },
                    },
                    "required": [],
                },
                _computer_screenshot,
                domain=self.DOMAIN,
                risk_level="low",
                when_to_use="Computer Use, desktop screenshot, screen capture, visual perception of user's desktop, app UI layout, or verifying whether a click/action took effect.",
                when_not_to_use="When reading file contents directly or executing command line tools.",
            ),
            ToolDef(
                "computer_click",
                "Computer Use: Click mouse at coordinate (x, y) with high-DPI awareness.",
                {
                    "type": "object",
                    "properties": {
                        "x": {"type": "integer", "description": "Screen X coordinate."},
                        "y": {"type": "integer", "description": "Screen Y coordinate."},
                        "button": {
                            "type": "string",
                            "enum": ["left", "right", "middle"],
                            "default": "left",
                            "description": "Mouse button to click.",
                        },
                        "clicks": {
                            "type": "integer",
                            "default": 1,
                            "description": "Number of clicks (1 for single, 2 for double click).",
                        },
                    },
                    "required": ["x", "y"],
                },
                _computer_click,
                domain=self.DOMAIN,
                risk_level="medium",
                when_to_use="Computer Use, clicking mouse on buttons, icons, links, menu items, or focusing inputs on desktop.",
                when_not_to_use="Guessing coordinates without first calling computer_screenshot to visually confirm element location.",
            ),
            ToolDef(
                "computer_move_cursor",
                "Computer Use: Move mouse cursor smoothly to target coordinates.",
                {
                    "type": "object",
                    "properties": {
                        "x": {"type": "integer", "description": "Target screen X coordinate."},
                        "y": {"type": "integer", "description": "Target screen Y coordinate."},
                        "smooth": {
                            "type": "boolean",
                            "default": True,
                            "description": "Use smooth Bezier motion path.",
                        },
                    },
                    "required": ["x", "y"],
                },
                _computer_move_cursor,
                domain=self.DOMAIN,
                risk_level="low",
                when_to_use="Computer Use, moving mouse, hovering over UI elements to trigger tooltips, dropdowns, or previewing mouse path.",
                when_not_to_use="When immediately clicking; computer_click handles smooth movement automatically.",
            ),
            ToolDef(
                "computer_type",
                "Computer Use: Type text via native Unicode keyboard injection (immune to IME interference, supports Chinese & Emoji).",
                {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string", "description": "Text string to type into focused control."},
                        "delay_ms": {
                            "type": "integer",
                            "default": 10,
                            "description": "Delay in milliseconds between characters.",
                        },
                    },
                    "required": ["text"],
                },
                _computer_type,
                domain=self.DOMAIN,
                risk_level="medium",
                when_to_use="Computer Use, keyboard typing, entering text, search queries, code, or messages into currently focused inputs.",
                when_not_to_use="Sending shortcuts (use computer_press_key instead).",
            ),
            ToolDef(
                "computer_press_key",
                "Computer Use: Press hotkey combination or special keyboard key.",
                {
                    "type": "object",
                    "properties": {
                        "key": {
                            "type": "string",
                            "description": "Key or combo, e.g. 'enter', 'ctrl+s', 'win+r', 'alt+tab', 'escape', 'backspace', 'f5'.",
                        },
                    },
                    "required": ["key"],
                },
                _computer_press_key,
                domain=self.DOMAIN,
                risk_level="medium",
                when_to_use="Computer Use, triggering application shortcuts (save, find, run), pressing Enter, Tab, Escape, Win+R, hotkeys.",
                when_not_to_use="Typing long text paragraphs (use computer_type instead).",
            ),
            ToolDef(
                "computer_drag",
                "Computer Use: Drag mouse from start coordinate to end coordinate.",
                {
                    "type": "object",
                    "properties": {
                        "start_x": {"type": "integer", "description": "Starting X."},
                        "start_y": {"type": "integer", "description": "Starting Y."},
                        "end_x": {"type": "integer", "description": "Target X."},
                        "end_y": {"type": "integer", "description": "Target Y."},
                        "duration": {
                            "type": "number",
                            "default": 0.5,
                            "description": "Duration of drag motion in seconds.",
                        },
                    },
                    "required": ["start_x", "start_y", "end_x", "end_y"],
                },
                _computer_drag,
                domain=self.DOMAIN,
                risk_level="medium",
                when_to_use="Computer Use, mouse drag, selecting text ranges, moving window sliders, dragging canvas items.",
                when_not_to_use="Single click actions.",
            ),
            ToolDef(
                "computer_scroll",
                "Computer Use: Scroll mouse wheel vertically.",
                {
                    "type": "object",
                    "properties": {
                        "clicks": {
                            "type": "integer",
                            "description": "Number of scroll notches (positive = scroll up, negative = scroll down).",
                        },
                        "x": {"type": "integer", "description": "Optional X coordinate to hover before scrolling."},
                        "y": {"type": "integer", "description": "Optional Y coordinate to hover before scrolling."},
                    },
                    "required": ["clicks"],
                },
                _computer_scroll,
                domain=self.DOMAIN,
                risk_level="low",
                when_to_use="Computer Use, scrolling mouse wheel on pages, windows, documents, tables or long lists.",
                when_not_to_use="Navigating directly to an element that is already in view.",
            ),

            # ─── OS App Lifecycle Management ─────────────────────────────────
            ToolDef(
                "app_list",
                "List installed apps.",
                {
                    "type": "object",
                    "properties": {
                        "filter": {
                            "type": "string",
                            "description": "Case-insensitive substring to narrow the list. Omit to get everything.",
                        }
                    },
                    "required": [],
                },
                _app_list,
                domain=self.DOMAIN,
                risk_level="low",
                when_to_use="Confirming an app's exact installed name before launching or operating it.",
                when_not_to_use="A general audit of what the user has installed.",
            ),
            ToolDef(
                "app_launch",
                "Launch app by name or path.",
                {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Installed app name or executable path (e.g. 'notepad', 'calc', 'chrome').",
                        },
                        "args": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Command-line arguments, if the app takes any.",
                        },
                    },
                    "required": ["name"],
                },
                _app_launch,
                domain=self.DOMAIN,
                risk_level="medium",
                when_to_use="Opening an app the task needs, or that the user asked to open.",
                when_not_to_use="Checking whether it is already running.",
            ),
            ToolDef(
                "app_close",
                "Close or quit running app.",
                {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Running app name or executable (e.g. 'notepad').",
                        }
                    },
                    "required": ["name"],
                },
                _app_close,
                domain=self.DOMAIN,
                risk_level="medium",
                when_to_use="The user asked to close it, or you launched it for a step that is now done.",
                when_not_to_use="Force-terminating system-critical services.",
            ),
            ToolDef(
                "app_focus",
                "Bring app window to foreground.",
                {
                    "type": "object",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Already-running app name to focus.",
                        }
                    },
                    "required": ["name"],
                },
                _app_focus,
                domain=self.DOMAIN,
                risk_level="low",
                when_to_use="Before clicking or typing, ensuring input reaches the intended window.",
                when_not_to_use="Starting an app — that is app_launch.",
            ),

            # Backward compatibility aliases
            ToolDef(
                "ui_screenshot",
                "Capture screen screenshot (compatibility alias for computer_screenshot).",
                {"type": "object", "properties": {"output_path": {"type": "string"}}, "required": []},
                _ui_screenshot_compat,
                domain=self.DOMAIN,
                risk_level="low",
                when_to_use="Older sessions/skills that still call this name to look at the screen.",
                when_not_to_use="Anything new — call computer_screenshot directly.",
            ),
            ToolDef(
                "ui_automation",
                "UI automation (compatibility alias for computer actions).",
                {
                    "type": "object",
                    "properties": {
                        "action": {
                            "type": "string",
                            "enum": ["click", "type", "key", "wait", "scroll", "drag"],
                            "description": "Which computer-use action to run: click, type, key, wait, scroll, or drag.",
                        },
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "text": {"type": "string"},
                        "duration": {"type": "number", "default": 1},
                        "button": {"type": "string", "default": "left"},
                    },
                    "required": ["action"],
                },
                _ui_auto_compat,
                domain=self.DOMAIN,
                risk_level="medium",
                when_to_use="Older sessions/skills driving mouse/keyboard through this legacy name.",
                when_not_to_use="Anything new — use computer_click / computer_type / computer_key directly; acting on the wrong window is easy to do and hard to undo.",
            ),

            # ─── Long-Term Memory & User Preference Management ──────────────
            ToolDef(
                "memory_add",
                "Save user identity, preference, name, habit, or important facts into permanent long-term memory. Call this immediately when user says '记住我叫...', '以后称呼我为...', '我喜欢...', '记住...'.",
                {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "The exact fact, preference, or rule to store into long-term memory."},
                        "type": {"type": "string", "enum": ["preference", "fact", "rule"], "default": "preference"},
                    },
                    "required": ["content"],
                },
                _memory_add_tool,
                domain="memory",
                risk_level="low",
                when_to_use="When user explicitly asks to remember something for future conversations or states their name/identity/preference.",
                when_not_to_use="Temporary session scratchpad data.",
            ),
            ToolDef(
                "memory_search",
                "Search user long-term memories and preferences.",
                {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Keywords or question to search memory."},
                    },
                    "required": ["query"],
                },
                _memory_search_tool,
                domain="memory",
                risk_level="low",
                when_to_use="Looking up past user preferences, personal details, or persistent rules.",
                when_not_to_use="Searching codebase files (use grep_search or find_files).",
            ),
        ]

    async def handle(self, tool_name, args, context=None):
        context = context or {}
        context.setdefault("workspace_root", self.workspace)
        span = self.telemetry.start_span(SpanName.TOOL_CALL, tool_name=tool_name, agent_name="app_agent")
        try:
            result = await self.tools.dispatch(tool_name, args, context)
            if not result.ok:
                span.set_error(result.error)
            return result
        finally:
            self.telemetry.end_span(span)


# ─── Computer Use Tool Implementations ───────────────────────────────────────

def _computer_screenshot(args: dict, ctx: dict) -> Result:
    try:
        engine = get_native_desktop()
        roi = args.get("roi")
        if roi and len(roi) == 4:
            roi_tuple = (int(roi[0]), int(roi[1]), int(roi[2]), int(roi[3]))
        else:
            roi_tuple = None

        quality = int(args.get("quality", 80))
        res = engine.capture_screen(roi=roi_tuple, quality=quality)

        save_path = args.get("save_path")
        if save_path:
            # If path is relative, place in workspace
            if not os.path.isabs(save_path):
                save_path = os.path.join(ctx.get("workspace_root", os.getcwd()), save_path)
            os.makedirs(os.path.dirname(os.path.abspath(save_path)), exist_ok=True)
            res["image"].save(save_path)
            saved_msg = f", saved to {save_path}"
        else:
            saved_msg = ""

        return Result.success({
            "width": res["width"],
            "height": res["height"],
            "scale_factor": res["scale_factor"],
            "data_uri": res["data_uri"],
            "summary": f"Captured desktop screenshot ({res['width']}x{res['height']} @ {res['scale_factor']}x DPI{saved_msg})",
        })
    except Exception as e:
        return Result.failure(f"Screenshot capture failed: {e}")


def _computer_click(args: dict, ctx: dict) -> Result:
    try:
        engine = get_native_desktop()
        x = int(args.get("x", 0))
        y = int(args.get("y", 0))
        button = str(args.get("button", "left"))
        clicks = int(args.get("clicks", 1))

        engine.click(x=x, y=y, button=button, clicks=clicks)
        return Result.success(f"Clicked ({x}, {y}) [button={button}, clicks={clicks}]")
    except Exception as e:
        return Result.failure(f"Click failed: {e}")


def _computer_move_cursor(args: dict, ctx: dict) -> Result:
    try:
        engine = get_native_desktop()
        x = int(args.get("x", 0))
        y = int(args.get("y", 0))
        smooth = bool(args.get("smooth", True))

        engine.move_cursor(x=x, y=y, smooth=smooth)
        return Result.success(f"Moved cursor to ({x}, {y})")
    except Exception as e:
        return Result.failure(f"Cursor move failed: {e}")


def _computer_type(args: dict, ctx: dict) -> Result:
    try:
        engine = get_native_desktop()
        text = str(args.get("text", ""))
        delay_ms = float(args.get("delay_ms", 10))

        engine.type_unicode(text, delay_per_char=delay_ms / 1000.0)
        return Result.success(f"Typed {len(text)} characters: {text[:40]}{'...' if len(text) > 40 else ''}")
    except Exception as e:
        return Result.failure(f"Type failed: {e}")


def _computer_press_key(args: dict, ctx: dict) -> Result:
    try:
        engine = get_native_desktop()
        key = str(args.get("key", ""))

        engine.press_key(key)
        return Result.success(f"Pressed hotkey: {key}")
    except Exception as e:
        return Result.failure(f"Press key failed: {e}")


def _computer_drag(args: dict, ctx: dict) -> Result:
    try:
        engine = get_native_desktop()
        sx = int(args.get("start_x", 0))
        sy = int(args.get("start_y", 0))
        ex = int(args.get("end_x", 0))
        ey = int(args.get("end_y", 0))
        duration = float(args.get("duration", 0.5))

        engine.drag(sx, sy, ex, ey, duration=duration)
        return Result.success(f"Dragged from ({sx}, {sy}) to ({ex}, {ey})")
    except Exception as e:
        return Result.failure(f"Drag failed: {e}")


def _computer_scroll(args: dict, ctx: dict) -> Result:
    try:
        engine = get_native_desktop()
        clicks = int(args.get("clicks", 0))
        x = args.get("x")
        y = args.get("y")
        x_val = int(x) if x is not None else None
        y_val = int(y) if y is not None else None

        engine.scroll(clicks, x=x_val, y=y_val)
        return Result.success(f"Scrolled {clicks} units")
    except Exception as e:
        return Result.failure(f"Scroll failed: {e}")


# ─── OS App Lifecycle Implementations ────────────────────────────────────────

def _safe_app_name(args):
    try:
        return shell_word(args.get("name", ""), label="应用名"), None
    except BlockedCommandError as e:
        return "", Result.failure(str(e))


def _app_list(args, ctx):
    filt = args.get("filter", "")
    if platform.system() == "Darwin":
        cmd = 'ls /Applications/ 2>/dev/null; ls ~/Applications/ 2>/dev/null'
    elif platform.system() == "Windows":
        cmd = 'powershell "Get-StartApps | Format-Table -AutoSize"'
    else:
        cmd = 'ls /usr/share/applications/*.desktop 2>/dev/null | xargs -I{} basename {} .desktop'
    r = try_result(lambda: guarded_spawn(cmd, timeout=5).stdout)
    if not r.ok:
        return Result.failure(f"Failed: {r.error}")
    lines = [l.strip() for l in r.value.split("\n") if l.strip()]
    if filt:
        lines = [l for l in lines if filt.lower() in l.lower()]
    return Result.success("\n".join(lines[:30]))


def _app_launch(args, ctx):
    name, err = _safe_app_name(args)
    if err is not None:
        return err
    if platform.system() == "Darwin":
        cmd = f'open -a "{name}"'
    elif platform.system() == "Windows":
        cmd = f'powershell "Start-Process \'{name}\'"'
    else:
        cmd = f'xdg-open "{name}" 2>/dev/null || gtk-launch "{name}" 2>/dev/null'
    r = try_result(lambda: guarded_spawn(cmd, timeout=5))
    return Result.success(f"Launched: {name}") if r.ok else Result.failure(f"Launch failed: {r.error}")


def _app_close(args, ctx):
    name, err = _safe_app_name(args)
    if err is not None:
        return err
    if platform.system() == "Darwin":
        cmd = f'osascript -e \'tell application "{name}" to quit\''
    elif platform.system() == "Windows":
        cmd = f'taskkill /im "{name}.exe" /f'
    else:
        cmd = f'pkill -f "{name}"'
    r = try_result(lambda: guarded_spawn(cmd, timeout=5))
    return Result.success(f"Closed: {name}") if r.ok else Result.failure(f"Close failed: {r.error}")


def _app_focus(args, ctx):
    name, err = _safe_app_name(args)
    if err is not None:
        return err
    if platform.system() == "Darwin":
        cmd = f'osascript -e \'tell application "{name}" to activate\''
    elif platform.system() == "Windows":
        cmd = f'powershell "Start-Process \'{name}\'"'
    else:
        return Result.failure("Focus not supported on Linux")
    r = try_result(lambda: guarded_spawn(cmd, timeout=5))
    return Result.success(f"Focused: {name}") if r.ok else Result.failure(f"Focus failed: {r.error}")


# ─── Backward Compatibility Wrappers ─────────────────────────────────────────

def _ui_screenshot_compat(args, ctx):
    res = _computer_screenshot({"save_path": args.get("output_path", "screenshot.png")}, ctx)
    if res.ok:
        return Result.success(f"Screenshot saved: {args.get('output_path', 'screenshot.png')}")
    return res


def _ui_auto_compat(args, ctx):
    action = args.get("action", "")
    if action == "click":
        return _computer_click({"x": args.get("x", 0), "y": args.get("y", 0), "button": args.get("button", "left")}, ctx)
    elif action == "type":
        return _computer_type({"text": args.get("text", "")}, ctx)
    elif action == "key":
        return _computer_press_key({"key": args.get("text", "")}, ctx)
    elif action == "scroll":
        return _computer_scroll({"clicks": args.get("text", 5), "x": args.get("x"), "y": args.get("y")}, ctx)
    elif action == "drag":
        return _computer_drag({
            "start_x": 0, "start_y": 0, "end_x": args.get("x", 0), "end_y": args.get("y", 0),
            "duration": args.get("duration", 1),
        }, ctx)
    return Result.failure(f"Unsupported action: {action}")


# ─── Long-Term Memory Tool Handlers ──────────────────────────────────────────

def _memory_add_tool(args, ctx):
    content = (args.get("content") or "").strip()
    if not content:
        return Result.failure("content 不能为空")
    try:
        from memory_layer import get_memory_layer, Memory, MemoryScope
        workspace_root = ctx.get("workspace_root") or os.getcwd()
        memory = get_memory_layer()
        mem = Memory(
            content=content,
            mem_type=args.get("type", "preference"),
            scope=MemoryScope.WORKSPACE,
            importance=0.95,
            session_id=ctx.get("session_id", "main"),
            root_dir=workspace_root,
        )
        res = memory.store(mem)
        # Also append to MEMORY.md if available
        try:
            mem_file = os.path.join(workspace_root, "MEMORY.md")
            line = f"- {content}\n"
            if os.path.exists(mem_file):
                with open(mem_file, "r", encoding="utf-8", errors="replace") as f:
                    existing = f.read()
            else:
                existing = ""
            if content not in existing:
                with open(mem_file, "a", encoding="utf-8") as f:
                    if existing and not existing.endswith("\n"):
                        f.write("\n")
                    f.write(line)
        except Exception:
            pass
        return Result.success(f"已成功永久写入长期记忆与 MEMORY.md: {content}")
    except Exception as e:
        return Result.failure(f"写入记忆失败: {e}")


def _memory_search_tool(args, ctx):
    query = (args.get("query") or "").strip()
    if not query:
        return Result.failure("query 不能为空")
    try:
        from memory_mcp_server import memory_search
        res = memory_search(query=query, limit=args.get("limit", 5))
        return Result.success(str(res))
    except Exception as e:
        return Result.failure(f"搜索记忆失败: {e}")



_agent: Optional[AppAgent] = None

def get_app_agent(workspace: str = None) -> AppAgent:
    global _agent
    if _agent is None:
        _agent = AppAgent(workspace)
    return _agent
