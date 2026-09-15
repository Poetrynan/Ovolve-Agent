"""
computer_agent.py - Computer sub-agent (Specialist Architecture).

MAC address redaction and system metric telemetry.
"""
from __future__ import annotations
import os, time, platform, subprocess, shutil, re
from typing import Optional
from result import Result, try_result
from event_bus import get_event_bus
from telemetry import get_telemetry, SpanName
from tools import ToolDef, get_tool_registry
from executors import (
    BlockedCommandError, guarded_spawn, run_shell, run_python, shell_word,
)
from sanitizer import sanitize_text


def _redact(text: str, ctx: dict) -> str:
    """Strip MAC addresses + machine-specific absolute paths (pattern 02 §6).

    Applied at the tool-impl layer so identifiers never reach the model, not
    just the final user-facing output.
    """
    return sanitize_text(text, workspace_root=(ctx or {}).get("workspace_root"))


class ComputerAgent:
    DOMAIN = "computer"

    def __init__(self, workspace: str = None):
        self.workspace = workspace or os.getcwd()
        self.bus = get_event_bus()
        self.telemetry = get_telemetry()
        self.tools = get_tool_registry()
        self._register_tools()

    def _register_tools(self):
        for td in self._build_tool_defs():
            self.tools.register(td)

    def _build_tool_defs(self):
        return [
            ToolDef("shell_executor", "Run one shell command in the workspace (high risk).",
                {"type":"object","properties":{
                    "command":{"type":"string","description":"A single command line. The host shell is used (PowerShell on Windows), so '&&' is not portable — prefer one command per call."},
                    "timeout":{"type":"integer","default":30,"description":"Seconds before the command is killed. Raise it for builds and test suites."},
                    "cwd":{"type":"string","description":"Directory to run in. Defaults to the workspace root, so avoid 'cd' inside the command."}},
                 "required":["command"]},
                _shell_impl, domain=self.DOMAIN, risk_level="high",
                manages_own_killable_child=True,
                when_to_use="Running builds, tests, linters, package managers, or any CLI "
                            "the task genuinely needs.",
                when_not_to_use="Anything a dedicated tool already does — reading "
                                "(`read_text`), searching (`search_code`), listing "
                                "(`list_dir`), editing (`edit_file`), git (`git_*`). Those "
                                "are safer and reviewable. Never use this to delete or "
                                "overwrite files in bulk."),
            ToolDef("python_executor", "Run a Python snippet (sandbox/native).",
                {"type":"object","properties":{
                    "code":{"type":"string","description":"Python source. Runs as a fresh program — nothing persists between calls, so include every import and definition it needs."},
                    "mode":{"type":"string","default":"sandbox","description":"'sandbox' is restricted and preferred; 'native' has full host access and should be a deliberate choice."},
                    "timeout":{"type":"integer","default":30}},
                 "required":["code"]},
                _python_impl, domain=self.DOMAIN, risk_level="high",
                when_to_use="A calculation or data transformation that is genuinely easier "
                            "in Python than a shell one-liner.",
                when_not_to_use="Running the project's own code or tests — use "
                                "`shell_executor` so it runs the way the user runs it. Do "
                                "not read or write project files with this either; the "
                                "file tools leave a reviewable trail, this does not."),
            ToolDef("process_list", "List running processes.",
                {"type":"object","properties":{
                    "limit":{"type":"integer","default":20,"description":"How many to return, ordered by resource use. A full process table is hundreds of rows of context you will not read."}},
                 "required":[]},
                _proc_list_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="Finding out whether something is already running before you start "
                            "a second copy — a dev server on a port, a hung test run — or "
                            "locating a PID the user asked you to deal with.",
                when_not_to_use="As a general 'what is this machine doing' sweep. The output "
                                "names every process the user has open, which is a lot of "
                                "unrelated personal detail in exchange for very little."),
            ToolDef("process_kill", "Kill process by PID.",
                {"type":"object","properties":{
                    "pid":{"type":"integer","description":"Confirm with `process_list` immediately before killing. PIDs are recycled, and a stale one from earlier in the turn may now belong to something else entirely."}},
                 "required":["pid"]},
                _proc_kill_impl, domain=self.DOMAIN, risk_level="high",
                when_to_use="The user asked you to stop a specific process, or a process you "
                            "yourself started is stuck and has to go.",
                when_not_to_use="Anything you did not start and were not asked about. There is "
                                "no undo: unsaved work in that process is gone, and an "
                                "editor, a database or a system service can all be killed by "
                                "the same call. Never kill by guessing at a name."),
            ToolDef("system_info", "Get system info.",
                {"type":"object","properties":{},"required":[]},
                _sysinfo_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="When a decision genuinely turns on the platform — which shell "
                            "syntax to write, which package manager exists, whether a path "
                            "separator matters.",
                when_not_to_use="Out of habit at the start of a task. The OS is usually already "
                                "stated in your context, and asking again costs a step."),
            ToolDef("env_get", "Get env var.",
                {"type":"object","properties":{
                    "name":{"type":"string","description":"Exact variable name, case-sensitive on Unix."}},
                 "required":["name"]},
                _envget_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="Checking that a variable a build or script depends on is actually "
                            "set, or reading a non-secret value like PATH or NODE_ENV.",
                when_not_to_use="Fishing for credentials. Values of API keys, tokens and "
                                "passwords must not be read back into the conversation — "
                                "refer to them by name and report only whether they are set."),
            ToolDef("env_set", "Set env var.",
                {"type":"object","properties":{
                    "name":{"type":"string","description":"Variable name."},
                    "value":{"type":"string","description":"New value. Overwrites silently if the variable already exists."}},
                 "required":["name","value"]},
                _envset_impl, domain=self.DOMAIN, risk_level="medium",
                when_to_use="Setting something a command you are about to run needs, when the "
                            "user asked for that configuration.",
                when_not_to_use="Working around a failure you have not diagnosed. This affects "
                                "the agent's own environment, NOT the user's shell profile, "
                                "so it does not persist the way they will expect — if they "
                                "want it permanent, edit the config file and say so."),
            ToolDef("disk_usage", "Disk usage.",
                {"type":"object","properties":{
                    "path":{"type":"string","default":".","description":"Any path on the volume you care about; the figures are per-volume, not per-directory."}},
                 "required":[]},
                _disk_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="A write, build or install failed and 'no space left' is a "
                            "plausible cause, or the user asked how much room is left.",
                when_not_to_use="Finding what is taking up space — this reports the volume "
                                "total, not a per-directory breakdown."),
            ToolDef("network_interfaces", "Network interfaces.",
                {"type":"object","properties":{},"required":[]},
                _netif_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="Diagnosing local connectivity, or finding the LAN address to bind "
                            "a dev server to so another device can reach it.",
                when_not_to_use="Checking whether the internet works — that needs an actual "
                                "request. Interfaces can be up on a network that goes "
                                "nowhere. Output includes MAC and IP addresses, so do not "
                                "quote it wholesale."),
            ToolDef("native_action_chain", "Execute multiple commands in sequence.",
                {"type":"object","properties":{
                    "commands":{"type":"array","items":{"type":"string"},"description":"Commands in order. Each is a separate invocation, so a 'cd' in one does NOT carry into the next."},
                    "stop_on_error":{"type":"boolean","default":True,"description":"Leave this True. Setting it False keeps going after a failure, which turns one broken step into a half-applied sequence nobody can unwind."}},
                 "required":["commands"]},
                _chain_impl, domain=self.DOMAIN, risk_level="high",
                manages_own_killable_child=True,
                when_to_use="A fixed sequence where you already know every command up front and "
                            "no step's output changes the next — the usual case is a "
                            "documented install or setup recipe.",
                when_not_to_use="Anything where you need to look at the output before deciding. "
                                "Chaining blind is how a bad assumption gets executed five "
                                "times instead of once; `shell_executor` one command at a "
                                "time is slower and much easier to stop."),
            ToolDef("action_search", "Search system settings/apps.",
                {"type":"object","properties":{
                    "query":{"type":"string","description":"What the user is looking for, in their words — 'bluetooth', 'display resolution'."}},
                 "required":["query"]},
                _search_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="Locating an OS settings pane or an installed application by name "
                            "before acting on it.",
                when_not_to_use="Searching the web (`standard_search`) or the workspace "
                                "(`search_code`). This only looks at the local machine's "
                                "settings and app index, and it finds things — it does not "
                                "open or change them."),
            ToolDef("cua_action", "Run one CUA action (navigate/click/click_text/click_element/fill/scroll/hover/drag/keypress/screenshot/element_info/element_tree/window_list/wait) with a mandatory post-action screenshot and local OCR summary.",
                {"type":"object","properties":{
                    "action":{"type":"string","enum":[
                        "navigate","click","click_text","click_element","fill","scroll",
                        "hover","drag","keypress","screenshot","element_info",
                        "element_tree","window_list","wait"],
                        "description":"Which CUA action to run. Side-effect actions automatically capture a screenshot and OCR summary afterwards, so the next decision can read what the screen shows now."},
                    "url":{"type":"string","description":"navigate: http(s) URL to open in the default browser."},
                    "x":{"type":"integer","description":"click/hover/scroll/fill/element_info: screen X coordinate."},
                    "y":{"type":"integer","description":"click/hover/scroll/fill/element_info: screen Y coordinate."},
                    "button":{"type":"string","enum":["left","right","middle"],"default":"left","description":"click: mouse button."},
                    "clicks":{"type":"integer","default":1,"description":"click: 1 single, 2 double."},
                    "text":{"type":"string","description":"fill: text to type into the focused control."},
                    "delay_ms":{"type":"integer","default":10,"description":"fill: per-character delay in ms."},
                    "key":{"type":"string","description":"keypress: key or combo, e.g. 'enter', 'ctrl+s', 'alt+f4'."},
                    "start_x":{"type":"integer","description":"drag: starting X."},
                    "start_y":{"type":"integer","description":"drag: starting Y."},
                    "end_x":{"type":"integer","description":"drag: ending X."},
                    "end_y":{"type":"integer","description":"drag: ending Y."},
                    "duration":{"type":"number","default":0.5,"description":"drag: motion duration in seconds."},
                    "roi":{"type":"array","items":{"type":"integer"},"description":"screenshot/element_info: optional region [x, y, width, height]."},
                    "save_path":{"type":"string","description":"screenshot/element_info: optional file path for the capture."},
                    "limit":{"type":"integer","default":20,"description":"element_info: max OCR elements returned."},
                    "seconds":{"type":"number","default":1,"description":"wait: plain sleep duration (no for_text)."},
                    "for_text":{"type":"string","description":"wait: poll screen OCR until this text appears (then stop early)."},
                    "timeout":{"type":"number","default":10,"description":"wait: ceiling for the for_text poll loop."},
                    "observe_midway":{"type":"boolean","default":False,"description":"drag: pause at the midpoint and screenshot-observe during the drag (only when the engine exposes step primitives; degrades honestly otherwise)."},
                    "expect_text":{"type":"string","description":"element_info: text you expect to see; delivery_hint=deliverable is set only when it really appears in this round's OCR lines."},
                    "target_ref":{"type":"string","description":"Which target to act on (U4 unified Target protocol). desktop:0 = the whole desktop (default) | tab:{session_id}/{tab_id} = a browser tab inside a task session | app:{pid} = a local process window."},
                    "hwnd":{"type":"integer","description":"element_tree/click_element: target window handle. Get it from window_list first — that is the only place a hwnd comes from."},
                    "title":{"type":"string","description":"window_list: keep only windows whose title contains this text (case-insensitive)."},
                    "name":{"type":"string","description":"element_tree: keep only elements whose Name contains this text (case-insensitive)."},
                    "control_type":{"type":"string","description":"element_tree/click_element target: exact control type, e.g. 'Button', 'Edit', 'ListItem', 'Text'."},
                    "automation_id":{"type":"string","description":"element_tree/click_element target: exact AutomationId, e.g. 'UpButton'. The most stable locator when the UI is not localized."},
                    "target":{"type":"object","description":"click_element: semantic locator. It resolves to the element's centre, then goes through the same click pipeline as the plain click action — prefer this over guessing coordinates on icon-only or self-drawn controls.",
                        "properties":{
                            "name":{"type":"string","description":"Substring of the element Name (case-insensitive)."},
                            "control_type":{"type":"string","description":"Exact control type."},
                            "automation_id":{"type":"string","description":"Exact AutomationId."},
                            "index":{"type":"integer","default":1,"description":"1-based ordinal when several elements match."}}},
                    "dpi_scale":{"type":"number","default":1.0,"description":"element_tree/click_element: physical-to-logical scale factor for the returned/clicked centre. Pass the same value you use for screenshot coordinates."},
                    "offset_x":{"type":"integer","default":0,"description":"click_element: nudge the resolved centre on X before clicking."},
                    "offset_y":{"type":"integer","default":0,"description":"click_element: nudge the resolved centre on Y before clicking."}},
                 "required":["action"]},
                _cua_action_impl, domain=self.DOMAIN, risk_level="medium",
                when_to_use="Acting on the desktop through the closed perception loop: every "
                            "side-effect action comes back with a screenshot path and an OCR "
                            "text summary of what the screen shows now, so you can verify a "
                            "click landed or a page loaded without a separate screenshot call.",
                when_not_to_use="File, shell, git and process work — the dedicated tools are "
                                "safer and reviewable. For app lifecycle (launch/close/focus) "
                                "the app domain tools are more precise. Credential-shaped "
                                "input (passwords, OTP) and captcha/safety-bypass targets are "
                                "refused here by design."),
        ]

    async def handle(self, tool_name, args, context=None):
        context = context or {}
        context.setdefault("workspace_root", self.workspace)
        span = self.telemetry.start_span(SpanName.TOOL_CALL, tool_name=tool_name, agent_name="computer_agent")
        try:
            result = await self.tools.dispatch(tool_name, args, context)
            if not result.ok:
                span.set_error(result.error)
            return result
        finally:
            self.telemetry.end_span(span)


def _preprocess_shell_command(command: str, cwd: str = None) -> tuple[str, list[str]]:
    """Rewrite Linux shell idioms like heredocs (`cat << 'EOF' > file`, `python << 'EOF'`)
    on Windows into native commands. Returns (translated_cmd, temp_files_to_clean).
    """
    created_files = []
    work_dir = cwd or os.getcwd()

    # Replace python3 with python on Windows
    if os.name == "nt":
        command = re.sub(r"\bpython3\b", "python", command)

    # Match cat << 'EOF' > filename ... EOF
    cat_heredoc_pat = re.compile(
        r"cat\s+<<\s*['\"]?(\w+)['\"]?\s*>\s*([^\n\r]+)\r?\n(.*?)\r?\n\1",
        re.DOTALL
    )
    def _replace_cat(match):
        tag, filename, content = match.group(1), match.group(2).strip().strip("'\""), match.group(3)
        target_path = os.path.join(work_dir, filename) if not os.path.isabs(filename) else filename
        try:
            os.makedirs(os.path.dirname(os.path.abspath(target_path)), exist_ok=True)
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(content)
            return f"echo [created {filename}]"
        except Exception:
            return match.group(0)

    command = cat_heredoc_pat.sub(_replace_cat, command)

    # Match python(3) << 'EOF' ... EOF
    py_heredoc_pat = re.compile(
        r"(?:python|python3)\s*(?:-)?\s*<<\s*['\"]?(\w+)['\"]?\r?\n(.*?)\r?\n\1",
        re.DOTALL
    )
    def _replace_py(match):
        tag, content = match.group(1), match.group(2)
        import uuid
        tmp_id = uuid.uuid4().hex[:8]
        tmp_filename = f"_run_tmp_{tmp_id}.py"
        target_path = os.path.join(work_dir, tmp_filename)
        try:
            with open(target_path, "w", encoding="utf-8") as f:
                f.write(content)
            created_files.append(target_path)
            return f'python "{target_path}"'
        except Exception:
            return match.group(0)

    command = py_heredoc_pat.sub(_replace_py, command)

    return command, created_files


def _shell_impl(args, ctx):
    raw_cmd = args.get("command", "")
    cwd = args.get("cwd", ctx.get("workspace_root"))
    command, tmp_files = _preprocess_shell_command(raw_cmd, cwd=cwd)
    confirm = ctx.get("confirmed", False) or ctx.get("permission") == "full" or ctx.get("benchmark", False)
    try:
        r = run_shell(
            command,
            timeout=args.get("timeout", 30),
            cwd=cwd,
            confirm=confirm,
            call_id=str(ctx.get("call_id", "") or ""),
            line_filter=lambda s: _redact(s, ctx),
            workspace_root=ctx.get("workspace_root"),
            sandbox_mode=ctx.get("sandbox_mode") or "workspace-write",
        )
        if r.ok and isinstance(r.value, str):
            return Result.success(_redact(r.value, ctx), **(r.meta or {}))
        return r
    finally:
        for f in tmp_files:
            try:
                if os.path.exists(f):
                    os.unlink(f)
            except Exception:
                pass

def _python_impl(args, ctx):
    confirm = ctx.get("confirmed", False) or ctx.get("permission") == "full" or ctx.get("benchmark", False)
    return run_python(args.get("code",""), mode=args.get("mode","sandbox"),
                      timeout=args.get("timeout",30), confirm=confirm)

def _proc_list_impl(args, ctx):
    # 数字参数强制转型再拼串：模型给的 limit 可能是 "20; shutdown /s"。
    try:
        limit = max(1, min(200, int(args.get("limit", 20))))
    except (TypeError, ValueError):
        return Result.failure("limit 必须是数字")
    if platform.system() == "Windows":
        cmd = f'powershell "Get-Process | Sort-Object CPU -Descending | Select-Object -First {limit} Id,ProcessName,CPU | Format-Table -AutoSize"'
    else:
        cmd = f"ps aux --sort=-%cpu | head -{limit+1}"
    r = try_result(lambda: guarded_spawn(cmd, timeout=10).stdout)
    return Result.success(r.value.strip()) if r.ok else Result.failure(f"Failed: {r.error}")

def _proc_kill_impl(args, ctx):
    try:
        pid = int(args.get("pid", 0))
    except (TypeError, ValueError):
        return Result.failure("Invalid PID")
    if pid <= 0:
        return Result.failure("Invalid PID")
    # Safety: list first, then kill (never wildcard)
    if not ctx.get("confirmed", False):
        return Result.failure("Process kill requires confirmation — list first, then confirm with PID")
    cmd = f"taskkill /PID {pid} /F" if platform.system() == "Windows" else f"kill -9 {pid}"
    r = try_result(lambda: guarded_spawn(cmd, timeout=5))
    return Result.success(f"Process {pid} terminated.") if r.ok else Result.failure(f"Kill failed: {r.error}")

def _sysinfo_impl(args, ctx):
    info = {"platform": platform.system(), "release": platform.release(), "machine": platform.machine(),
            "processor": platform.processor(), "python": platform.python_version(), "hostname": platform.node()}
    try:
        import psutil
        mem = psutil.virtual_memory()
        info["memory_total"] = f"{mem.total/(1024**3):.1f} GB"
        info["memory_available"] = f"{mem.available/(1024**3):.1f} GB"
        info["cpu_percent"] = f"{psutil.cpu_percent(interval=0.5)}%"
    except ImportError:
        pass  # fail-open: 可选增强，失败不影响主流程
    return Result.success(info)

def _envget_impl(args, ctx):
    name = args.get("name", "")
    val = os.environ.get(name)
    if val is None:
        return Result.failure(f"Not set: {name}")
    if any(s in name.upper() for s in ("KEY","TOKEN","SECRET","PASSWORD","CREDENTIAL","API")):
        return Result.success(f"{name}=***[masked]")
    return Result.success(f"{name}={val}")

def _envset_impl(args, ctx):
    os.environ[args.get("name","")] = args.get("value","")
    return Result.success("Set for current session.")

def _disk_impl(args, ctx):
    r = try_result(lambda: shutil.disk_usage(args.get("path",".")))
    if not r.ok:
        return Result.failure(f"Failed: {r.error}")
    du = r.value
    return Result.success({"total": f"{du.total/(1024**3):.1f} GB", "used": f"{du.used/(1024**3):.1f} GB",
                           "free": f"{du.free/(1024**3):.1f} GB", "percent": f"{du.used/du.total*100:.1f}%"})

def _netif_impl(args, ctx):
    """Network interfaces — MAC addresses redacted (pattern 02 §6)."""
    try:
        import psutil
        addrs = {}
        for name, snics in psutil.net_if_addrs().items():
            lst = []
            for s in snics:
                # Only show IP addresses, never MAC
                if s.family.name in ("AF_INET", "AF_INET6"):
                    lst.append(f"{s.family.name}: {s.address}")
                elif s.family.name in ("AF_LINK", "AF_PACKET"):
                    # MAC address — redact it
                    lst.append(f"{s.family.name}: [MAC-REDACTED]")
            if lst:
                addrs[name] = lst
        return Result.success(addrs)
    except ImportError:
        import socket
        return Result.success({"hostname": socket.gethostname()})

def _chain_impl(args, ctx):
    commands = args.get("commands", [])
    stop_on_error = args.get("stop_on_error", True)
    confirm = ctx.get("confirmed", False)
    # 整条链共用一个 call_id：它在界面上是一张卡片，输出也该汇到同一个窗口。
    call_id = str(ctx.get("call_id", "") or "")
    results = []
    for i, cmd in enumerate(commands):
        r = run_shell(
            cmd, timeout=30, cwd=ctx.get("workspace_root"), confirm=confirm,
            call_id=call_id, line_filter=lambda s: _redact(s, ctx),
            workspace_root=ctx.get("workspace_root"),
            sandbox_mode=ctx.get("sandbox_mode") or "workspace-write",
        )
        if r.ok:
            results.append(f"[{i+1}] OK: {cmd}\n{r.value}")
        else:
            results.append(f"[{i+1}] FAIL: {cmd}\n{r.error}")
            if stop_on_error:
                break
    return Result.success(_redact("\n\n".join(results), ctx))

def _search_impl(args, ctx):
    try:
        query = shell_word(args.get("query", ""), label="搜索词")
    except BlockedCommandError as e:
        return Result.failure(str(e))
    if platform.system() == "Darwin":
        cmd = f'mdfind "{query}" 2>/dev/null | head -20'
    elif platform.system() == "Windows":
        cmd = f'powershell "Get-StartApps | Where-Object {{$_.Name -like \'*{query}*\'}} | Format-Table"'
    else:
        cmd = f'find /usr/share/applications -name "*.desktop" -exec grep -l -i "{query}" {{}} \\; 2>/dev/null | head -10'
    r = try_result(lambda: guarded_spawn(cmd, timeout=10).stdout)
    return Result.success(_redact(r.value.strip(), ctx)) if r.ok else Result.failure(f"Search failed: {r.error}")



def _cua_action_impl(args, ctx):
    # CUA 动作层入口。动作语义（captcha/密码框/
    # 支付按钮……）由 cua_actions 复用 gui_action_classifier 分级路由，这里只做
    # 薄转发——权限决策全部留在既有体系里，本函数不新增任何判定。
    from cua_actions import get_cua_executor
    action = str(args.get("action", "")).strip()
    params = {k: v for k, v in args.items() if k != "action"}
    r = get_cua_executor().execute(action, params, ctx)
    if r.ok:
        return Result.success(r.to_dict())
    return Result.failure(r.error, action=r.action, elapsed_ms=r.elapsed_ms)


_agent: Optional[ComputerAgent] = None
def get_computer_agent(workspace: str = None) -> ComputerAgent:
    global _agent
    if _agent is None:
        _agent = ComputerAgent(workspace)
    return _agent
