"""tools.py - Tool registry with definition/execution separation (Pi pattern)."""
from __future__ import annotations
import asyncio
import os, re, fnmatch, time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional
from result import Result
from tool_validator import validate_args

# ── Per-domain tool timeout (seconds) ─────────────────────────────────────────
# A stuck tool must not kill the whole turn. The dispatch wraps every call in
# asyncio.wait_for; on timeout the agent loop receives a readable error result
# and can decide to retry, use a fallback, or report the failure.
#
# Values are deliberately asymmetric: read tools have no network variance so
# they're short; shell/web tools may wait on real I/O so they get more budget.
# Anything not explicitly listed falls through to DEFAULT.
TOOL_TIMEOUT_BY_DOMAIN: dict[str, int] = {
    "file": 30,
    "search": 60,
    "computer": 120,
    "browser": 90,
    "app": 60,
    "general": 60,
}
TOOL_TIMEOUT_DEFAULT = 90


def format_tool_error(message: str, suggestion: str = "", recovery: str = "") -> str:
    """错误三段式（message / suggestion / recovery）的标准文本形态。

    Result.error 是一个字符串，三段式以可读文本承载：第一段说清发生了什么，
    第二段给模型一个**具体可执行的下一步**，第三段（可选）给替代路线。写法
    纪律与工具描述的 when_to_use/when_not_to_use 同源——错误信息是模型最
    信任的教学时刻，只有症状没有出路的错误会让它原地重试同一个动作。
    """
    parts = [(message or "").strip()]
    if suggestion.strip():
        parts.append(f"下一步: {suggestion.strip()}")
    if recovery.strip():
        parts.append(f"替代路线: {recovery.strip()}")
    return "\n".join(p for p in parts if p)

#: Consecutive infrastructure failures before a tool is withheld (2.5).
#: Three, not one: a single timeout is often a slow moment, and withholding a
#: healthy tool costs the agent a capability it needed.
TOOL_FAIL_THRESHOLD = 3

#: How long a tripped tool stays withheld. Long enough that the agent is forced
#: to try another route instead of burning its whole iteration budget on the
#: same dead call, short enough that a restarted MCP server comes back on its
#: own without the user doing anything.
TOOL_BREAKER_COOLDOWN_S = 60.0



@dataclass
class ToolDef:
    name: str
    description: str
    schema: dict
    execute: Callable
    domain: str = "general"
    risk_level: str = "low"
    needs_confirmation: bool = False
    #: 可见性分组（六·UC1）。空则回落到 ``domain``。存在的理由是 MCP：所有
    #: MCP 工具的 domain 都是 "mcp"，用户装三个服务器就糊成一个大组，没法整组
    #: 折叠或整组浮出。注册时带上 ``mcp:<服务器名>`` 才能按来源分开。
    #: 只影响「模型看得见什么」，与派发和权限校验无关 —— 见 tool_catalog.py。
    group: str = ""
    #: 「什么时候用 / 什么时候别用」（第四章 工具描述三段式）。
    #:
    #: 为什么要单开两个字段而不是把话写进 ``description``：``description`` 那
    #: 一行同时被 recommender 和 tool_search 拿去做关键词打分，写厚了会稀释
    #: 重合度——一个塞满 "do not" 的长描述反而更难被搜到。所以短句留给检索，
    #: 长解释只在**发给模型的目录**里拼进去（见 ``llm_description``）。
    #:
    #: 真正要解决的问题是「一眼分不清」：`search_code` 和 `find_files`、
    #: `write_file` 和 `edit_file` 各自只有一行描述，模型经常拿 `write_file`
    #: 去改一个已存在的文件——整份覆盖掉。`when_not_to_use` 就是为这类混淆
    #: 准备的，写的时候要指名道姓地说「这种情况用另一个」。
    when_to_use: str = ""
    when_not_to_use: str = ""

    #: 这个工具跑完就结束本回合。用于「必须等用户」的工具（ask_user）：回合
    #: 结束后由前端卡片把答案作为下一回合送回来，而不是在工具里 await 用户。
    #: 详见 ask_user.py 顶部关于为什么不 await 的说明。
    halts_turn: bool = False

    # ── 执行契约（durable activity，语义见 activity_exec.py）─────────────
    #:
    #: Python 线程杀不掉——这是"任意工具都能强制停止"的根问题。分级边界：
    #: 协程工具留在事件循环（取消即真取消）；同步工具默认在 worker 线程
    #: （只能放弃，不能终止）；声明了子进程隔离的同步工具跑在独立解释器里，
    #: 父进程持句柄可杀整棵进程树。合同是**如实标注**，不是愿望清单：
    #: 标注错了比不标更坏，因为 UI 和调度器会照着它对用户说谎。
    #:
    #: execution_class: 显式覆盖。"loop" | "thread" | "subprocess"；空串 =
    #: 由 activity_exec.classify_execution 自动推导（协程→loop；其余→thread，
    #: 除非命中 requires_subprocess / manages_own_killable_child / critical）。
    execution_class: str = ""
    #: 声明此工具必须在可杀子进程中执行（文件写、外部 SDK、未知阻塞）。
    #: 解析不了函数本体（闭包/绑定方法）时自动降级线程并如实降级合同。
    requires_subprocess: bool = False
    #: shell 家族专用：execute 本体 spawn 了登记在 call_id 名下的受限子命令，
    #: 可停止性来自那个孩子。为它们再包一层子进程只会弄断输出流。
    manages_own_killable_child: bool = False
    #: 白名单：不可中断但确实验证过可安全用于 autonomous Goal 的写工具才许
    #: 认领。默认 False——默认值必须是更安全的那一边。
    autonomous_write_safe: bool = False

    #: 推导缓存（classify_execution 结果）。init=False：不属于构造签名。
    _exec_plan: Optional[dict] = field(default=None, init=False, repr=False,
                                       compare=False)

    call_count: int = 0
    last_called: float = 0.0
    #: Per-tool override. None → use domain default from TOOL_TIMEOUT_BY_DOMAIN.
    timeout_seconds: Optional[int] = None

    #: Consecutive INFRASTRUCTURE failures (timeout / raised exception). Reset by
    #: any success. See ToolRegistry.note_outcome for why a tool that merely
    #: answered "not found" does not count.
    fail_streak: int = 0
    #: Wall clock until which this tool is withheld. 0 = healthy.
    open_until: float = 0.0

    #: 能力分身元数据
    parallel_safe: bool = True
    latency_hint: str = "fast"  # "fast" | "medium" | "slow"
    output_schema: Optional[dict] = None

    def llm_description(self) -> str:
        """发给模型的完整描述：一行摘要 + 用/不用两段（第四章）。

        和 ``description`` 分开的意义是方向不同：``description`` 面向**检索**
        （关键词打分、tool_search），要短要密；这个面向**选择**（模型在 20 个
        工具里挑一个），要把边界说清楚。没填两段的工具原样返回，所以 60 个工具
        不需要一次改完。
        """
        parts = [self.description or ""]
        if self.when_to_use:
            parts.append(f"When to use: {self.when_to_use}")
        if self.when_not_to_use:
            parts.append(f"When NOT to use: {self.when_not_to_use}")
        return "\n".join(p for p in parts if p)

    def to_llm_schema(self):
        return {"name": self.name, "description": self.llm_description(),
                "inputSchema": self.schema}


class ToolRegistry:
    def __init__(self):
        self._tools = {}
        self._execution_history = []
    def register(self, tool):
        self._tools[tool.name] = tool
    def get(self, name):
        return self._tools.get(name)
    def list_tools(self, domain=None):
        if domain:
            return [t for t in self._tools.values() if t.domain == domain]
        return list(self._tools.values())
    def to_llm_schemas(self, domain=None):
        return [t.to_llm_schema() for t in self.list_tools(domain)]

    def to_openai_tools(self, domain=None, exclude=None):
        """Return tools formatted for OpenAI/Chat-Completions ``tools`` param.

        Args:
            domain: Restrict to a single sub-agent domain (file/computer/…).
            exclude: Iterable of tool names to omit — used to hide risky
                tools from remote (bot) sessions.

        Returns:
            List of ``{"type":"function","function":{name,description,parameters}}``.
            The parameters block is passed through unchanged; the registry
            already stores them as valid JSON Schema.
        """
        exclude = set(exclude or ())
        specs: list[dict] = []
        for tool in self.list_tools(domain):
            if tool.name in exclude:
                continue
            specs.append({
                "type": "function",
                "function": {
                    "name": tool.name,
                    # 三段式描述（第四章）。这里用 llm_description 而不是
                    # description：目录是模型**做选择**的地方，边界要说清楚。
                    # 涨的 token 由 tool_catalog 的裁剪抵掉 —— 两件事必须一起
                    # 做，只写厚描述不裁剪就是在 60 个工具上做加法。
                    "description": tool.llm_description(),
                    "parameters": tool.schema or {"type": "object", "properties": {}},
                },
            })
        return specs

    def timeout_for(self, tool) -> int:
        """Seconds this tool is allowed to run before the dispatch gives up."""
        if getattr(tool, "timeout_seconds", None):
            return int(tool.timeout_seconds)
        return TOOL_TIMEOUT_BY_DOMAIN.get(tool.domain, TOOL_TIMEOUT_DEFAULT)

    # ------------------------------------------------------------------
    # Circuit breaker (2.5)
    #
    # The problem it solves: every failure used to be handled the same way —
    # hand the error text back to the model and let it decide. For a wrong
    # argument that is exactly right. For a tool that is actually down (a dead
    # MCP server, a command that times out every time) it means a goal worker
    # retries the same dead call until its iteration budget is gone, and never
    # gets a nudge to try another route.
    # ------------------------------------------------------------------

    def breaker_note(self, tool, ok: bool, infrastructure: bool = False) -> None:
        """Record one outcome against a tool's health.

        Only INFRASTRUCTURE failures count — a timeout or a raised exception,
        i.e. "the tool did not get to answer". A tool that answered "old_string
        not found" or "file does not exist" is working perfectly; it is the call
        that was wrong. Counting those would withhold `edit_file` after three
        near-misses, which is a far worse bug than the one being fixed.
        """
        if ok:
            tool.fail_streak = 0
            tool.open_until = 0.0
            return
        if not infrastructure:
            return
        tool.fail_streak += 1
        if tool.fail_streak >= TOOL_FAIL_THRESHOLD:
            tool.open_until = time.time() + TOOL_BREAKER_COOLDOWN_S

    def breaker_block(self, tool) -> Optional[str]:
        """The message to return instead of calling a withheld tool, or None.

        Also closes the breaker once the cooldown has passed, so recovery needs
        no timer: the next call after the window simply goes through, and a
        success resets the streak.
        """
        if not tool.open_until:
            return None
        left = tool.open_until - time.time()
        if left <= 0:
            # Half-open: let one call through. It either succeeds (streak reset)
            # or fails again and re-arms the cooldown.
            tool.open_until = 0.0
            return None
        alternatives = [
            t.name for t in self._tools.values()
            if t.domain == tool.domain and t.name != tool.name and not t.open_until
        ][:4]
        hint = ("同类可用的工具：" + "、".join(alternatives)) if alternatives else \
            "这一类没有其他可用工具了"
        return (
            f"工具 `{tool.name}` 连续 {tool.fail_streak} 次没能执行完（超时或崩溃），"
            f"已暂停 {int(left)} 秒，这次调用没有真的发出去。"
            f"不要原样重试——换一条路达成同一个目的，或者告诉用户这一步做不了。{hint}。"
        )

    def health_snapshot(self) -> list[dict]:
        """Per-tool health, for diagnostics. Cheap enough to call on demand."""
        now = time.time()
        return [
            {"name": t.name, "domain": t.domain, "calls": t.call_count,
             "failStreak": t.fail_streak,
             "openForSeconds": max(0, int(t.open_until - now)) if t.open_until else 0}
            for t in self._tools.values()
            if t.fail_streak or t.open_until
        ]


    def execution_plan(self, tool) -> dict:
        """Derive (once per tool) the real execution class + cancel contract.

        The plan is what Pause, the scheduler and the UI quote when they tell
        a user whether "stop" means stop. Cached on the ToolDef because the
        inputs — coroutine-ness and module resolution — never change at
        runtime.
        """
        if getattr(tool, "_exec_plan", None) is None:
            import activity_exec
            tool._exec_plan = activity_exec.classify_execution(tool)
        return tool._exec_plan

    def execution_contracts(self) -> list:
        """Per-tool contract summary for honest UI / diagnostics."""
        return [
            {
                "name": t.name,
                "domain": t.domain,
                "riskLevel": t.risk_level,
                "executionClass": self.execution_plan(t)["class"],
                "cancellationContract": self.execution_plan(t)["contract"],
                "interruptible": bool(self.execution_plan(t)["interruptible"]),
            }
            for t in self._tools.values()
        ]

    async def dispatch(self, name, args, context=None):
        """Run one tool under its execution contract, returning a Result.

        Why the timeout lives here: this is the single chokepoint every tool call
        passes through, so one guard covers the builtin tools, the MCP-injected
        ones, and anything a skill registers later. Without it a tool that never
        returns — a hung subprocess, an un-timeouted HTTP call, an ``os.walk``
        over a network mount — freezes the entire turn, and the user's only
        recourse is to kill the app. With it the agent loop gets a readable
        failure and can retry, fall back, or report honestly.

        Three execution classes come through here:

        * ``loop`` — native coroutines. Cancelling the awaitable really stops
          them.
        * ``thread`` — sync callables on a worker thread. The timeout cancels
          only our WAIT; Python cannot interrupt a running thread, so the
          orphan runs on in the background. That is exactly why the contract
          field exists: tools that can be moved into a killable subprocess are
          declared as such, and tools that stay here are reported as
          non-interruptible instead of silently pretending stop works.
        * ``subprocess`` — sync callables executed in a fresh interpreter via
          activity_exec. The parent owns the process tree, so timeout/cancel
          KILLS it; a killed child's effects settle as ``unknown`` in the
          ledger rather than ``failed``, because dead ≠ didn't happen.
        """
        context = context or {}
        audit = {"tool": name, "args": args, "ts": time.time()}
        tool = self._tools.get(name)
        if not tool:
            return Result.failure(f"Tool not found: {name}")
        validated, error = validate_args(tool.schema, args)
        if error:
            return Result.failure(f"Validation failed: {error}")
        if context.get("blocked"):
            return Result.failure(context.get("block_reason", "Blocked"))
        # 2.5: a tool that has been failing to even run is withheld for a while.
        # Checked here rather than in the router so it covers sub-agents and
        # MCP-injected tools too — same reason the timeout lives here.
        withheld = self.breaker_block(tool)
        if withheld:
            return Result.failure(withheld, code="ToolCircuitOpen")

        plan = self.execution_plan(tool)
        # Autonomous-goal guard: a non-interruptible write has no place in an
        # unattended goal — Pause cannot promise it stops, so the goal would
        # keep writing files after its worker is gone. Interactive sessions
        # keep full access: the user is present and can see a stuck call.
        if context.get("goal_id") and not plan["interruptible"]:
            import activity_exec
            allowed, why = activity_exec.autonomous_goal_allows(tool, plan)
            if not allowed:
                return Result.failure(why)

        tool.call_count += 1
        tool.last_called = time.time()
        budget = self.timeout_for(tool)
        execute = tool.execute
        # Publish the call id to everything spawned underneath. Internal spawn
        # points (guarded_spawn, native_run, the git helpers) never took a
        # call_id parameter, so their children were unreachable by cancel_call:
        # Stop killed the shell tool and left those running. This is the seam —
        # one binding here beats threading a parameter through every helper.
        import executors as _executors
        _call_token = _executors.bind_call_id(str(context.get("call_id") or ""))
        try:
            if plan["class"] == "subprocess":
                # Killable boundary: blocking communicate() runs in a helper
                # thread while the REAL work happens in a child process whose
                # tree we can terminate. The internal timer kills at `budget`;
                # this wait_for is only a backstop against the runner itself
                # wedging past budget + kill grace.
                import activity_exec
                result = await asyncio.wait_for(
                    asyncio.to_thread(
                        activity_exec.run_sync_in_subprocess,
                        plan["ref"], validated, context,
                        timeout=budget,
                        call_id=str(context.get("call_id") or ""),
                        cwd=str(context.get("workspace_root")
                                or "") or None,
                    ),
                    timeout=budget + activity_exec.KILL_GRACE_SEC,
                )
            elif asyncio.iscoroutinefunction(execute):
                # Native coroutine — the timeout cancels the awaitable directly.
                result = await asyncio.wait_for(
                    execute(validated, context), timeout=budget,
                )
            else:
                # Sync callable — hand it to a worker thread so a blocking call
                # (os.walk over a slow mount, a subprocess without its own
                # timeout, a requests.get with no ceiling) does not freeze the
                # event loop and, with it, the WebSocket server. wait_for can
                # only cancel our WAIT — Python cannot interrupt a running
                # thread — so the orphan may run to completion in the
                # background. We prefer a leaked thread to a frozen session,
                # and call_count is already bumped so the leak is visible in
                # the stats instead of silent. The cancellation_contract on
                # this ToolDef says honestly whether that leak can be killed.
                outcome = await asyncio.wait_for(
                    asyncio.to_thread(execute, validated, context),
                    timeout=budget,
                )
                # Defensive: a sync tool that returns a coroutine/awaitable
                # (e.g. ``return _async_helper()``) still needs awaiting.
                if hasattr(outcome, "__await__"):
                    outcome = await asyncio.wait_for(outcome, timeout=budget)
                result = outcome
        except asyncio.TimeoutError:
            # Phrased for the MODEL, not the log: it has to decide what to do
            # next, so say what failed, how long we waited, and that a retry is
            # unlikely to behave differently.
            self.breaker_note(tool, ok=False, infrastructure=True)
            if plan["class"] == "subprocess":
                # The child was killed by now (internal timer); whatever it
                # managed to do before dying is nobody's guess.
                return Result.failure(
                    f"Tool '{name}' was killed after {budget}s in its isolated "
                    f"process. It may have PARTIALLY completed — verify the "
                    f"actual state before retrying or doing anything similar.",
                    effect_status="unknown",
                )
            return Result.failure(
                f"Tool '{name}' timed out after {budget}s and was abandoned. "
                f"The operation may still be running in the background. "
                f"Do not retry it unchanged — either narrow the arguments "
                f"(smaller path, tighter filter, lower limit) or take a "
                f"different approach."
            )
        except asyncio.CancelledError:
            # The turn itself was cancelled (user hit stop). Propagate so the
            # agent loop unwinds instead of treating it as a tool failure.
            # Deliberately NOT counted against the tool: the user stopping the
            # turn says nothing about the tool's health.
            raise
        except Exception as e:
            self.breaker_note(tool, ok=False, infrastructure=True)
            return Result.failure(f"Execution error: {e}")
        finally:
            _executors.unbind_call_id(_call_token)
        # A Result the tool chose to return — success or a domain-level "no" —
        # both mean the tool ran. Only `ok` resets the streak; a domain failure
        # leaves it untouched rather than counting toward the breaker.
        self.breaker_note(tool, ok=bool(getattr(result, "ok", False)))
        return result
    def get_execution_history(self, limit=50):
        return self._execution_history[-limit:]

def shorten_path(abs_path, ws_root=None):
    if ws_root:
        try:
            rel = os.path.relpath(abs_path, ws_root)
            if not rel.startswith(".."):
                return rel.replace(os.sep, "/")
        except (ValueError, OSError):
            pass  # fail-open: 可选增强，失败不影响主流程
    p = abs_path.replace("\\", "/")
    m = re.match(r"^[A-Za-z]:/Users/[^/]+/(.+)", p)
    if m:
        return "~/" + m.group(1)
    return re.sub(r"/Users/[^/]+/", "/[USER]/", p)

def truncate(text, max_chars=5000, suffix=None):
    """Head-Tail truncation: keep the first chunk + last chunk.

    For command outputs, the meaningful content is typically at the start
    (invocation / arguments) and the end (error messages / exit codes). A naive
    head-only cut loses exactly the information the model needs most.

    The ratio is ~60% head / ~40% tail — biased toward the head because many
    outputs are "fine everywhere" and the head is more likely to contain the
    leading context. The middle is replaced with a counter so the model knows
    how much was elided.
    """
    if not text:
        return ""
    if len(text) <= max_chars:
        return text
    head_budget = int(max_chars * 0.6)
    tail_budget = max_chars - head_budget
    omitted = len(text) - head_budget - tail_budget
    divider = f"\n\n... [已省略中间 {omitted:,} 字符] ...\n\n"
    return text[:head_budget] + divider + text[-tail_budget:]

def _load_gitignore(root):
    patterns = []
    gi = os.path.join(root, ".gitignore")
    if os.path.exists(gi):
        try:
            with open(gi, "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if line and not line.startswith("#"):
                        patterns.append(line)
        except OSError:
            pass  # fail-open: 可选增强，失败不影响主流程
    patterns.extend([".git", "__pycache__", "node_modules", ".venv", "*.pyc"])
    return patterns

def _is_ignored(path, patterns):
    bn = os.path.basename(path)
    for pat in patterns:
        if fnmatch.fnmatch(bn, pat) or path.replace("\\", "/").endswith(pat):
            return True
    return False

def _search_code_impl(args, ctx):
    pattern = args.get("pattern", "")
    path = args.get("path", ".")
    glob_f = args.get("glob")
    ic = args.get("ignore_case", False)
    limit = args.get("limit", 100)
    if not pattern:
        return Result.failure("pattern required")
    try:
        rx = re.compile(pattern, re.IGNORECASE if ic else 0)
    except re.error as e:
        return Result.failure(f"Invalid regex: {e}")
    ig = _load_gitignore(path)
    res = []
    cnt = 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if not _is_ignored(os.path.join(root, d), ig) and d not in (".git", "__pycache__", "node_modules", ".venv")]
        for fn in files:
            if _is_ignored(os.path.join(root, fn), ig):
                continue
            if glob_f and not fnmatch.fnmatch(fn, glob_f):
                continue
            fp = os.path.join(root, fn)
            try:
                with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                    for ln, line in enumerate(f, 1):
                        if rx.search(line):
                            res.append(f"{shorten_path(fp, ctx.get('workspace_root', path))}:{ln}: {line.rstrip()}")
                            cnt += 1
                            if cnt >= limit:
                                return Result.success("\n".join(res))
            except (OSError, UnicodeDecodeError):
                continue
    return Result.success("\n".join(res) if res else "No matches found.")

def _find_files_impl(args, ctx):
    pat = args.get("pattern", "*")
    path = args.get("path", ".")
    limit = args.get("limit", 100)
    ig = _load_gitignore(path)
    res = []
    cnt = 0
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if not _is_ignored(os.path.join(root, d), ig) and d not in (".git", "__pycache__", "node_modules", ".venv")]
        for fn in files:
            if not _is_ignored(os.path.join(root, fn), ig) and fnmatch.fnmatch(fn, pat):
                res.append(shorten_path(os.path.join(root, fn), ctx.get("workspace_root", path)))
                cnt += 1
                if cnt >= limit:
                    break
        if cnt >= limit:
            break
    return Result.success("\n".join(res) if res else "No files found.")

def _list_dir_impl(args, ctx):
    path = args.get("path", ".")
    limit = args.get("limit", 200)
    if not os.path.isdir(path):
        return Result.failure(f"Not a directory: {path}")
    ws = ctx.get("workspace_root", path)
    entries = []
    cnt = 0
    for item in sorted(os.listdir(path)):
        if item.startswith(".") and item not in (".", ".."):
            continue
        full = os.path.join(path, item)
        entries.append(item + "/" if os.path.isdir(full) else item)
        cnt += 1
        if cnt >= limit:
            entries.append(f"... [{limit}]")
            break
    return Result.success(f"{shorten_path(path, ws)}\n" + "\n".join(entries))

def _code_references_impl(args, ctx):
    from code_graph import execute_code_references_tool
    return execute_code_references_tool(args, ctx)

def create_builtin_tools():
    from ask_user import create_ask_user_tool
    return [
        ToolDef("code_references", "Find callers, definitions, and references of a symbol using the Code Knowledge Graph (AST).",
            {"type":"object","properties":{
                "symbol":{"type":"string","description":"The function, class, or method name to look up."},
                "include_callers":{"type":"boolean","default":True,"description":"Include caller functions and lines."},
                "depth":{"type":"integer","default":1,"description":"Graph neighborhood traversal depth (1 or 2)."}},
             "required":["symbol"]},
            _code_references_impl, domain="file", risk_level="low",
            when_to_use="You want to find all call sites, usages, or callers of a specific function or class.",
            when_not_to_use="Looking for generic text or comments inside files — use `search_code`."),
        ToolDef("search_code", "Search file CONTENTS with a regex. Respects .gitignore.",
            {"type":"object","properties":{
                "pattern":{"type":"string","description":"Python regex matched against each line's content. NOT a filename glob."},
                "path":{"type":"string","default":".","description":"Directory to search under."},
                "glob":{"type":"string","description":"Only search files whose name matches this glob, e.g. '*.py'."},
                "ignore_case":{"type":"boolean","default":False},
                "limit":{"type":"integer","default":100,"description":"Max matching lines returned; results are truncated, not ranked."}},
             "required":["pattern"]},
            _search_code_impl, domain="file", risk_level="low",
            when_to_use="You know WHAT the code says but not WHERE it lives — a function "
                        "name, an error string, a config key.",
            when_not_to_use="You know the file's name or extension but not its contents — "
                            "use `find_files`. To read one known file, use `read_text`."),
        ToolDef("find_files", "Find files by NAME using a glob pattern.",
            {"type":"object","properties":{
                "pattern":{"type":"string","default":"*","description":"Filename glob such as '*.py' or 'test_*'. NOT a regex, and it is matched against the file NAME, not its contents."},
                "path":{"type":"string","default":".","description":"Directory to search under."},
                "limit":{"type":"integer","default":100}},
             "required":[]},
            _find_files_impl, domain="file", risk_level="low",
            when_to_use="You know something about the file's name or extension and want "
                        "to locate it, or want an inventory of one file type.",
            when_not_to_use="You are looking for a string INSIDE files — use `search_code`. "
                            "To see one directory's immediate children, use `list_dir`."),
        ToolDef("list_dir", "List one directory's immediate entries. Dirs get trailing /.",
            {"type":"object","properties":{
                "path":{"type":"string","default":".","description":"The single directory to list. Not recursive."},
                "limit":{"type":"integer","default":200}},
             "required":[]},
            _list_dir_impl, domain="file", risk_level="low",
            when_to_use="Orienting yourself in an unfamiliar directory — one level, "
                        "cheap, shows what is actually there.",
            when_not_to_use="You need to search recursively or match a pattern — use "
                            "`find_files`. Hidden dot-entries are skipped, so do not use "
                            "this to check for `.env` / `.git`."),

        create_ask_user_tool(),
        ToolDef(
            "tool_search",
            "Search available tools and capabilities by task description or semantic query.",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Semantic query or task intent to search matching tools."},
                    "limit": {"type": "integer", "default": 5, "description": "Maximum number of tools to return."},
                },
                "required": ["query"],
            },
            _tool_search_impl,
            domain="general",
            risk_level="low",
            when_to_use="When looking for specialized or domain tools when the catalog is large.",
        ),
        ToolDef(
            "ask_user_question",
            "Prompt the user with a structured multi-choice decision modal card in the UI.",
            {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "The question title or decision prompt."},
                    "description": {"type": "string", "description": "Detailed explanation of the options and trade-offs."},
                    "options": {
                        "type": "array",
                        "items": {"type": "object"},
                        "description": "List of options with 'id', 'label', 'is_recommended', 'description'.",
                    },
                    "allow_multiple": {"type": "boolean", "default": False},
                },
                "required": ["title", "options"],
            },
            _ask_user_question_impl,
            domain="general",
            risk_level="low",
            when_to_use="When facing multiple valid architectural trade-offs requiring explicit user choice.",
        ),
        ToolDef(
            "chrome_devtools",
            "Bridge to Chrome DevTools Protocol (CDP) to capture console errors and network failures.",
            {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [
                            "summary",
                            "tabs",
                            "screencast_start",
                            "screencast_stop",
                            "screencast_status",
                        ],
                        "default": "summary",
                        "description": "Diagnostic action to run on Chrome.",
                    },
                    "tab_id": {
                        "type": "string",
                        "description": "Target tab id for screencast_start; defaults to the first CDP page tab.",
                    },
                    "output_dir": {
                        "type": "string",
                        "description": "Directory to persist captured screencast frames for screencast_start.",
                    },
                },
                "required": [],
            },
            _chrome_devtools_impl,
            domain="browser",
            risk_level="low",
            when_to_use="When diagnosing frontend errors, console tracebacks, or broken API requests.",
        ),
        ToolDef(
            "lsp_navigate",
            "Precise code navigation and symbol lookup (definition & references).",
            {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "Function, class, or variable symbol name to lookup."},
                    "action": {"type": "string", "enum": ["definition", "references"], "default": "definition"},
                    "workspace": {"type": "string", "default": ".", "description": "Workspace root directory."},
                },
                "required": ["symbol"],
            },
            _lsp_navigate_impl,
            domain="file",
            risk_level="low",
            when_to_use="When tracing exact function definitions or caller references across the codebase.",
        ),
        ToolDef(
            "workflow_record_start",
            "Start recording subsequent agent CUA/browser/tool actions into a repeatable workflow.",
            {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Human-readable name of the workflow."},
                    "description": {"type": "string", "description": "Optional workflow description."},
                },
                "required": ["name"],
            },
            _workflow_record_start_impl,
            domain="app",
            risk_level="low",
            when_to_use="When beginning a multi-step repetitive operation you want to capture and replay later.",
        ),
        ToolDef(
            "workflow_record_stop",
            "Stop recording the active workflow and persist it to disk.",
            {
                "type": "object",
                "properties": {
                    "save": {"type": "boolean", "default": True, "description": "Whether to persist recorded workflow to disk."},
                },
                "required": [],
            },
            _workflow_record_stop_impl,
            domain="app",
            risk_level="low",
            when_to_use="When finished executing the sequence of actions you intended to record.",
        ),
        ToolDef(
            "workflow_replay",
            "Deterministically replay a recorded workflow with bare modifier safety and drift circuit breaker.",
            {
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "ID of the saved workflow to replay."},
                    "stop_on_drift": {"type": "boolean", "default": True, "description": "Whether to halt immediately if UI target/state drifts."},
                },
                "required": ["workflow_id"],
            },
            _workflow_replay_impl,
            domain="app",
            risk_level="medium",
            when_to_use="When executing an existing captured workflow asset.",
        ),
        ToolDef(
            "workflow_list",
            "List all recorded and available workflows.",
            {
                "type": "object",
                "properties": {},
                "required": [],
            },
            _workflow_list_impl,
            domain="app",
            risk_level="low",
            when_to_use="When checking what workflows have been recorded and are available for replay.",
        ),
        ToolDef(
            "evolution_undo",
            "Undo the most recently accepted self-evolution rule or revert a specific proposal, restoring the target file from pre-change backup.",
            {
                "type": "object",
                "properties": {
                    "proposal_id": {
                        "type": "string",
                        "description": "Optional proposal ID to revert. If omitted, reverts the most recent proposal change.",
                    },
                },
                "required": [],
            },
            _evolution_undo_impl,
            domain="system",
            risk_level="medium",
            when_to_use="When an accepted evolution rule needs to be reverted or caused unexpected behavior.",
            when_not_to_use="Do not use for rolling back normal workspace source code files.",
        ),
        ToolDef(
            "workflow_schedule_create",
            "Create a recurring cron schedule for an executable or promoted workflow.",
            {
                "type": "object",
                "properties": {
                    "workflow_id": {
                        "type": "string",
                        "description": "ID of the saved workflow to schedule.",
                    },
                    "cron_expr": {
                        "type": "string",
                        "description": "Standard 5-field cron expression (e.g. '0 9 * * 1-5' or '*/15 * * * *') or macro (e.g. '@daily').",
                    },
                    "session_id": {
                        "type": "string",
                        "description": "Optional session ID context for the scheduled execution.",
                        "default": "",
                    },
                },
                "required": ["workflow_id", "cron_expr"],
            },
            _workflow_schedule_create_impl,
            domain="app",
            risk_level="medium",
            when_to_use="When scheduling an automated, recurring execution of a recorded workflow.",
        ),
        ToolDef(
            "workflow_schedule_list",
            "List all scheduled workflow jobs and their execution status.",
            {
                "type": "object",
                "properties": {
                    "enabled_only": {
                        "type": "boolean",
                        "description": "Filter to only active/enabled schedules.",
                        "default": False,
                    },
                },
                "required": [],
            },
            _workflow_schedule_list_impl,
            domain="app",
            risk_level="low",
            when_to_use="When inspecting active or configured workflow schedules.",
        ),
        ToolDef(
            "workflow_schedule_delete",
            "Cancel and remove a scheduled workflow job by its schedule ID.",
            {
                "type": "object",
                "properties": {
                    "schedule_id": {
                        "type": "string",
                        "description": "ID of the schedule to remove.",
                    },
                },
                "required": ["schedule_id"],
            },
            _workflow_schedule_delete_impl,
            domain="app",
            risk_level="medium",
            when_to_use="When deleting or cancelling an automated workflow schedule.",
        ),
    ]


def _tool_search_impl(query: str, limit: int = 5, **kwargs) -> Result:
    from tool_search import tool_search_handler
    res = tool_search_handler(query=query, limit=limit)
    revealed = [m["name"] for m in res.get("matches", []) if isinstance(m, dict) and "name" in m]
    return Result.success(res, revealed_tools=revealed)


def _ask_user_question_impl(title: str, description: str = "", options: list = None, allow_multiple: bool = False, **kwargs) -> Result:
    from ask_user_question import get_question_registry
    reg = get_question_registry()
    q = reg.create_question(title=title, description=description, options=options or [], allow_multiple=allow_multiple)
    return Result.success({
        "status": "question_created",
        "question_id": q.question_id,
        "title": q.title,
        "options": [o.label for o in q.options],
    })


def _chrome_devtools_impl(action: str = "summary", **kwargs) -> Result:
    from chrome_devtools import chrome_devtools_handler
    passthrough = {
        k: v for k, v in kwargs.items()
        if k in ("tab_id", "output_dir", "fps", "quality", "max_width", "max_height")
    }
    res = chrome_devtools_handler(action=action, **passthrough)
    return Result.success(res)


def _lsp_navigate_impl(symbol: str, action: str = "definition", workspace: str = ".", **kwargs) -> Result:
    from lsp_client import lsp_navigate_handler
    res = lsp_navigate_handler(symbol=symbol, action=action, workspace=workspace)
    return Result.success(res)


def _workflow_record_start_impl(name: str, description: str = "", **kwargs) -> Result:
    from workflow_recorder import get_workflow_recorder
    rec = get_workflow_recorder()
    wf_id = rec.start_recording(name=name, description=description)
    return Result.success({"status": "recording_started", "workflow_id": wf_id, "name": name})


def _workflow_record_stop_impl(save: bool = True, **kwargs) -> Result:
    from workflow_recorder import get_workflow_recorder
    rec = get_workflow_recorder()
    if not rec.is_recording():
        return Result.failure("No active workflow recording session")
    wf = rec.stop_recording(save=save)
    if not wf:
        return Result.failure("Failed to seal workflow recording")
    return Result.success({"status": "recording_stopped", "workflow_id": wf.id, "step_count": len(wf.steps)})


def _workflow_replay_impl(workflow_id: str, stop_on_drift: bool = True, **kwargs) -> Result:
    from workflow_recorder import load_workflow, WorkflowReplayer
    wf = load_workflow(workflow_id)
    if not wf:
        return Result.failure(f"Workflow `{workflow_id}` not found")
    replayer = WorkflowReplayer()
    try:
        from workflow_evolution import WorkflowMetricsTracker
        replayer.set_metrics_tracker(WorkflowMetricsTracker())
    except Exception:
        pass
    return replayer.replay(wf, stop_on_drift=stop_on_drift)


def _workflow_list_impl(**kwargs) -> Result:
    from workflow_recorder import list_workflows
    wfs = list_workflows()
    return Result.success({"workflows": wfs, "count": len(wfs)})


def _evolution_undo_impl(proposal_id: str = "", **kwargs) -> Result:
    from evolution_undo import undo
    ws = kwargs.get("workspace_root") or os.getcwd()
    return undo(workspace_root=ws, proposal_id=proposal_id or None)


def _workflow_schedule_create_impl(workflow_id: str, cron_expr: str, session_id: str = "", **kwargs) -> Result:
    from workflow_scheduler import get_workflow_scheduler
    scheduler = get_workflow_scheduler()
    return scheduler.create_schedule(workflow_id=workflow_id, cron_expr=cron_expr, session_id=session_id)


def _workflow_schedule_list_impl(enabled_only: bool = False, **kwargs) -> Result:
    from workflow_scheduler import get_workflow_scheduler
    scheduler = get_workflow_scheduler()
    schedules = scheduler.list_schedules(enabled_only=enabled_only)
    return Result.success({"schedules": schedules, "count": len(schedules)})


def _workflow_schedule_delete_impl(schedule_id: str, **kwargs) -> Result:
    from workflow_scheduler import get_workflow_scheduler
    scheduler = get_workflow_scheduler()
    return scheduler.delete_schedule(schedule_id=schedule_id)


_registry = None
def get_tool_registry():
    global _registry
    if _registry is None:
        _registry = ToolRegistry()
        for t in create_builtin_tools():
            _registry.register(t)
    return _registry

