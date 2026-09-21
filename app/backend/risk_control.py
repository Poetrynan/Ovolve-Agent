"""
risk_control.py - Three-level risk control + two-stage confirmation.

Mounted as a 'pre_tool_use' event subscriber (not embedded in kernel).
Risk levels: low (auto) / medium (two-stage confirm) / high (block or escalate).

Permission modes: auto (default) / confirm (all need approval) / deny (read-only).

Tool risk level table (least-privilege security policy):
  Read/WebFetch = low, no confirmation
  Write/Edit/Skill/CronCreate = medium, needs confirmation
  Bash/Agent/shell_executor = high, needs confirmation
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from event_bus import EventBus, Event, EventAction, get_event_bus
# Top-level, not lazy: the enum is compared on every non-low-risk tool call. It
# is safe because permission_rules imports `storage` only inside its
# constructor, so there is no import cycle back into here.
from permission_rules import RuleBehavior
from tool_policy import (
    PolicyAction,
    PolicyDecision,
    PolicyLayer,
    PolicyRequest,
    ToolPolicyPipeline,
    make_sandbox_layer,
    make_subagent_layer,
    sandbox_layer_status,
)
# command_classifier imports tool_policy only, never risk_control, so this
# direction is cycle-free. It lives next to the tool_policy import because the
# guard layer is registered into that same pipeline.
from command_classifier import make_command_guard_layer


class RiskLevel(Enum):
    """How bad is it if this call was a mistake.

    ``CRITICAL`` is not "worse HIGH" — it is a different contract. LOW/MEDIUM/HIGH
    only say how eagerly a permission mode should auto-run something; CRITICAL
    says **nothing auto-runs this**, including 全权代理 and including a standing
    allow rule. Only an explicit per-call approval gets through.

    It exists because the un-overridable floor we already had was command-shaped:
    ``tool_hooks.destructive_command_hook`` vetoes `rm -rf /` no matter the mode,
    but it only inspects six interpreter tools' command text. A force-push or a
    hard reset arrives as its own tool with structured args, so it walked
    straight past that hook and, under 全权代理, past every other check too.
    """

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class PermissionMode(Enum):
    """How much rope the agent gets. The ONE permission axis in the product.

    Declared least → most autonomous — the same single-dial order the composer
    dropdown and the settings card use (minus ``READ_ONLY``, which is sub-agent
    only and never shown). ``PLAN`` leads because it is the only level where NO
    write happens at all; ``CONFIRM`` still writes, it just asks first. Keeping
    all three surfaces in this order means "further down = less asking" is a rule
    the user learns once.


    There used to be a second, parallel enum — ``agent_modes.PermissionLevel``
    (plan/readonly/ask/auto/yolo) — evaluated by its own gate that ran before the
    policy pipeline, using a different vocabulary for the same ideas (``ask`` vs
    ``confirm``, ``deny`` vs read-only). Two enums meant two places to reason
    about "may this write happen", which is exactly the kind of split that lets a
    guarantee quietly stop holding. They are merged here: risk_control owns
    authorization, so it owns the axis.

    ``deny`` was also a misnomer — it never rejected everything, it allowed reads.
    It is now spelled ``readonly``, with ``deny`` kept as an input alias.
    """

    PLAN = "plan"          # Read-only + "write a plan, then stop" in the prompt
    READ_ONLY = "readonly" # Read-only, no planning ask (sub-agents, legacy `deny`)
    CONFIRM = "confirm"    # Every write asks first (legacy `ask`)
    AUTO = "auto"          # Low risk passes, medium/high asks (default)
    FULL = "full"          # Nothing asks (legacy `yolo`)


#: Hard read-only modes: writes are DENIED, not asked. A granted permission or a
#: hook cannot rescue them — the pipeline short-circuits on a deny.
READ_ONLY_MODES = frozenset({PermissionMode.PLAN, PermissionMode.READ_ONLY})

#: Default when nothing says otherwise (CLI, bots, queued turns, goal scheduler).
DEFAULT_PERMISSION = PermissionMode.AUTO

#: Accepted spellings that are not the canonical value. Covers the old global
#: setting (`deny`), the old per-turn axis (`ask`/`yolo` and the writable modes
#: `edit`/`agent`/`build`), and the even older approvalPolicy triple.
_PERMISSION_ALIASES = {
    "deny": PermissionMode.READ_ONLY,
    "read_only": PermissionMode.READ_ONLY,
    "ask": PermissionMode.CONFIRM,
    "ask_every": PermissionMode.CONFIRM,
    "always": PermissionMode.CONFIRM,
    "yolo": PermissionMode.FULL,
    "never": PermissionMode.FULL,
    "full_access": PermissionMode.FULL,
    "edit": PermissionMode.AUTO,
    "agent": PermissionMode.AUTO,
    "build": PermissionMode.AUTO,
    "risky": PermissionMode.AUTO,
}


def coerce_permission(value: object) -> PermissionMode:
    """Collapse any external input to a valid mode. Never raises.

    A bad value from the frontend, a hand-edited config.json or a stale localStorage
    blob must not kill the turn — but it must not silently *widen* access either,
    so anything unrecognised lands on the default rather than on ``FULL``.
    """
    if isinstance(value, PermissionMode):
        return value
    if not value:
        return DEFAULT_PERMISSION
    raw = str(value).strip().lower()
    try:
        return PermissionMode(raw)
    except ValueError:
        return _PERMISSION_ALIASES.get(raw, DEFAULT_PERMISSION)


def is_read_only(value: object) -> bool:
    """Is this mode a hard write ban?"""
    return coerce_permission(value) in READ_ONLY_MODES


#: Human-readable names, for logs and UI receipts.
#: 展示名。**故意不用业界那套「计划模式 / 变更前确认 / 自动编辑 / 完全访问」**——
#: 那是别家产品的名词，语义还偏：「完全访问」听着像权限清单，而这一档真正的意思是
#: 「你别再问我了」。这里统一用动作短语，一律四个字，从上到下就是一根拨杆，用户不
#: 用读描述也能排出松紧。枚举值（plan/readonly/confirm/auto/full）不动 —— 那些进了
#: config.json、会话历史和工具帧，改值等于毁掉旧数据。
_PERMISSION_NAMES = {
    PermissionMode.PLAN: "只出方案",
    PermissionMode.READ_ONLY: "只看不动",
    PermissionMode.CONFIRM: "每步问我",
    PermissionMode.AUTO: "小事放手",
    PermissionMode.FULL: "全权代理",
}


def describe_permission(value: object) -> str:
    """Human-readable mode name."""
    return _PERMISSION_NAMES[coerce_permission(value)]

#: System-prompt fragment injected per mode. AUTO (the default) is empty — the
#: common case adds nothing. PLAN and READ_ONLY share a tool ban but differ in
#: INTENT, and this text is the only place that difference lives, so it is
#: specific: a vague "please only read" makes the model volunteer plans in a
#: plain read-only turn where the user only wanted an answer.
_PERMISSION_PROMPTS = {
    PermissionMode.PLAN: """## 当前档位：只出方案（不动手）


你现在**只做方案，不动手**。目标是让用户在你开工之前就能看懂、能否决。

- 可以读文件、搜代码、查历史 —— 把现状调查清楚，方案要基于真实代码而不是猜测。
- **不要**改任何文件、不要跑有副作用的命令。写操作会被系统拦下。
- 调查完给出方案，包含：
  1. **现状** —— 相关代码现在是怎么写的，你实际读到了什么
  2. **改动清单** —— 具体到文件，每个文件改什么，为什么
  3. **风险与取舍** —— 哪里可能出问题，你放弃了哪些替代方案及原因
  4. **验证方式** —— 改完怎么确认真的 work（跑哪个测试、看什么输出）
- 方案给完就停下，等用户回应。不要问"要我开始吗"然后自己接着做。
- 如果调查后发现用户的想法有问题，直接说，不要照着做一份注定失败的方案。""",

    PermissionMode.READ_ONLY: """## 当前档位：只看不动


这一轮**任何写操作都会被拦**。

- 可以读文件、搜代码、查 git 历史、看系统信息 —— 所有只读操作照常用。
- 回答问题本身，答完就停。不要顺手附一份"我可以帮你这样改"的方案 —— 用户没问。
- 如果问题必须动手验证才能回答，说明这一点，让用户放开权限。
- 结论先行。先给答案，再给支撑细节；引用具体文件和行号（`path/to/file.py:42`）。""",

    PermissionMode.CONFIRM: """## 当前档位：每步问我


每个写操作都会弹给用户确认。因此：
- 把相关的改动**合并**成一次调用，别把一个文件拆成五次小编辑轮流问。
- 动手前先一句话说清你要改什么，让用户看确认框时知道自己在批准什么。""",

    PermissionMode.FULL: """## 当前档位：全权代理


用户明确要求不再逐步确认。放手做，但底线不变：
- 不做用户没要求的重构、不加没要求的功能。
- 破坏性操作（删数据、force push、改生产配置）仍然要先说清后果再做。
- 做完必须自己验证（跑测试/构建），别声称完成却没验证过。""",
}


def prompt_block(value: object = None) -> str:
    """The system-prompt fragment for this turn's mode. Empty for AUTO."""
    return _PERMISSION_PROMPTS.get(coerce_permission(value), "")




# Tool risk level table (Standard security policy based on least-privilege matrix)
TOOL_RISK_LEVELS = {
    # Low risk - read-only, no confirmation
    "read_text": {"level": RiskLevel.LOW, "needs_approval": False},
    "read_file": {"level": RiskLevel.LOW, "needs_approval": False},
    "search_code": {"level": RiskLevel.LOW, "needs_approval": False},
    "find_files": {"level": RiskLevel.LOW, "needs_approval": False},
    "list_dir": {"level": RiskLevel.LOW, "needs_approval": False},
    "web_fetch": {"level": RiskLevel.LOW, "needs_approval": False},
    "git_status": {"level": RiskLevel.LOW, "needs_approval": False},
    "git_log": {"level": RiskLevel.LOW, "needs_approval": False},
    "git_diff": {"level": RiskLevel.LOW, "needs_approval": False},
    "git_show": {"level": RiskLevel.LOW, "needs_approval": False},
    "system_info": {"level": RiskLevel.LOW, "needs_approval": False},
    "env_get": {"level": RiskLevel.LOW, "needs_approval": False},
    "process_list": {"level": RiskLevel.LOW, "needs_approval": False},
    "network_interfaces": {"level": RiskLevel.LOW, "needs_approval": False},
    "disk_usage": {"level": RiskLevel.LOW, "needs_approval": False},
    "action_search": {"level": RiskLevel.LOW, "needs_approval": False},
    "app_list": {"level": RiskLevel.LOW, "needs_approval": False},
    "web_search": {"level": RiskLevel.LOW, "needs_approval": False},
    "semantic_search": {"level": RiskLevel.LOW, "needs_approval": False},
    "academic_search": {"level": RiskLevel.LOW, "needs_approval": False},
    "diagnose": {"level": RiskLevel.LOW, "needs_approval": False},
    "recommend": {"level": RiskLevel.LOW, "needs_approval": False},
    "red_team_scan": {"level": RiskLevel.LOW, "needs_approval": False},
    "security_audit": {"level": RiskLevel.LOW, "needs_approval": False},

    # Medium risk - file changes, schedules
    "write_file": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "edit_file": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "delete_file": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "convert_file": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "skill": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "use_skill": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "cron_create": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "git_add": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "git_commit": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "git_branch": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "git_checkout": {"level": RiskLevel.MEDIUM, "needs_approval": True},
    "git_pull": {"level": RiskLevel.MEDIUM, "needs_approval": True},

    # High risk - shell, agent dispatch
    "bash": {"level": RiskLevel.HIGH, "needs_approval": True},
    "shell_executor": {"level": RiskLevel.HIGH, "needs_approval": True},
    "python_executor": {"level": RiskLevel.HIGH, "needs_approval": True},
    "dispatch_task": {"level": RiskLevel.HIGH, "needs_approval": True},
    "git_push": {"level": RiskLevel.HIGH, "needs_approval": True},

    # Critical - irreversible / non-workspace-recoverable. Nothing auto-runs
    # these: not 全权代理, not a standing allow rule. Only a per-call yes.
    # These are the structured-arg destructive ops that walked past the
    # command-text-only destructive_command_hook.
    "git_push_force": {"level": RiskLevel.CRITICAL, "needs_approval": True},
    "git_reset_hard": {"level": RiskLevel.CRITICAL, "needs_approval": True},
    "git_clean": {"level": RiskLevel.CRITICAL, "needs_approval": True},
}


# Read-only shell command heads (Safe Command Inspector): a chained command
# is read-only only when EVERY segment starts with one of these and there is no
# redirection. Conservative by design — unknown heads are treated as mutating.
_READONLY_HEADS = {
    "ls", "dir", "pwd", "echo", "cat", "type", "head", "tail", "wc", "tree",
    "whoami", "hostname", "date", "uname", "ver", "systeminfo", "tasklist",
    "ps", "env", "printenv", "which", "where", "stat", "file", "df", "du",
    "free", "ipconfig", "ifconfig", "ping", "nslookup", "rg", "grep", "findstr",
    "wmic", "get-process", "get-service", "get-item", "get-content", "get-childitem",
    "get-command", "get-help",
}

# Two-word read-only git subcommands.
_READONLY_GIT = ("git status", "git log", "git diff", "git show", "git branch",
                 "git remote -v", "git stash list", "git blame")

# Human-friendly Chinese labels for confirmation prompts. Unknown tools fall
# back to the raw tool name so we never invent a wrong description.
_FRIENDLY_TOOL_NAMES = {
    "system_info": "查看系统信息",
    "shell_executor": "执行系统命令",
    "python_executor": "运行 Python 代码",
    "write_file": "写入文件",
    "edit_file": "编辑文件",
    "delete_file": "删除文件",
    "process_kill": "结束进程",
    "app_install": "安装应用",
    "app_uninstall": "卸载应用",
    "git_push": "推送到远程仓库",
    "git_commit": "创建 Git 提交",
    "git_add": "暂存文件变更",
    "cron_create": "创建定时任务",
    "navigate": "打开网页",
    "fill": "填写网页表单",
    "native_action_chain": "执行系统操作链",
}


def is_readonly_command(command: str) -> bool:
    """True when a shell command is a pure read (safe to auto-run).

    Any output redirection, in-place flag, or chained segment with an unknown
    head makes the whole command non-read-only.
    """
    if not command or not isinstance(command, str):
        return False
    if re.search(r"(>>?|\|\s*tee\b)", command):
        return False
    for seg in re.split(r"&&|\|\||;|\|", command):
        seg = seg.strip()
        if not seg:
            continue
        low = seg.lower()
        if any(low == g or low.startswith(g + " ") for g in _READONLY_GIT):
            continue
        head = low.split()[0]
        if head not in _READONLY_HEADS:
            return False
    return True


@dataclass
class PermissionRecord:
    """Permission grant record (session/project/global scope)."""
    tool_name: str
    scope: str = "session"  # session / project / global
    granted_at: float = 0.0
    args_hash: str = ""  # Permission is per-args, not blanket
    #: Which chat session the user approved in. A grant must never leak into a
    #: second window — empty means "any", used only by legacy callers.
    session_id: str = ""
    #: The confirmation text promises 「这次确认只对这一次有效」, so the record has
    #: to be consumed on use. A grant that silently persists would turn one
    #: click into standing permission — the exact thing per-call consent exists
    #: to prevent.
    single_use: bool = True


#: A grant older than this is treated as absent. The user approved *this* step
#: in *this* moment; if the model comes back ten minutes later the situation is
#: no longer the one they looked at.
GRANT_TTL_S: float = 900.0

#: Cap on remembered pending asks. Only the newest matters in practice; the cap
#: exists so a long session with many refused prompts cannot grow unbounded.
_MAX_PENDING = 32

#: kv namespace for the pending-ask ledger, mirroring ``ask_user``'s.
#:
#: Without it the ask was memory-only: a backend restart erased the question but
#: left the turn parked, so the user's 「同意」 landed on nothing and the only way
#: out was to retype the whole request. The persisted turn status (2.1) also
#: reads this to decide whether a reloaded session is `waiting_user`.
_PENDING_KV_NS = "risk_pending"

#: Lifetime of a persisted ask. Much shorter than ``ask_user``'s day, because a
#: confirmation AUTHORIZES an action rather than collecting an opinion: an hour
#: later, 「同意」 almost certainly refers to something else on screen.
PENDING_TTL_S: float = 3600.0


def _pending_kv_key(session_id: str) -> str:
    return f"pending:{session_id}"


@dataclass
class PendingConfirmation:
    """An ``ask`` that was shown to the user and is still unanswered.

    Recorded because the ask used to be a dead end: the router halted the turn
    with 「回复「同意」我就继续」 and nothing anywhere remembered *what* had been
    asked, so no reply could ever resume it.
    """
    call_id: str
    tool_name: str
    args: dict
    prompt: str = ""
    session_id: str = ""
    asked_at: float = 0.0


#: Short affirmatives that count as approval, and refusals that clear the ask.
#: Deliberately tiny and matched whole-string: a keyword hidden in a long
#: sentence must NOT authorize a destructive step, so anything conversational
#: falls through to "no decision" and the ask stays open.
_CONSENT_YES = {
    "同意", "确认", "确定", "可以", "可以的", "行", "好", "好的", "好吧", "没问题",
    "继续", "执行", "批准", "允许", "去吧", "来吧", "干吧", "上",
    "y", "yes", "yeah", "yep", "ok", "okay", "sure", "go", "go ahead",
    "approve", "approved", "allow", "continue", "proceed", "do it",
}
_CONSENT_NO = {
    "不", "不要", "不用", "不用了", "别", "别了", "不同意", "拒绝", "取消", "停",
    "停下", "算了", "先别", "不行",
    "n", "no", "nope", "cancel", "stop", "deny", "abort", "don't", "dont",
}

#: Approvals that ALSO mean "and stop asking me about this kind of call".
#: Checked before the plain-yes list, and kept separate rather than folded in,
#: because these leave a persistent rule behind — a much bigger commitment than
#: one 「同意」, so the phrase has to be unambiguous about wanting it.
_CONSENT_ALWAYS = {
    "以后都允许", "以后都行", "以后不用问", "以后别问", "一直允许", "都允许",
    "总是允许", "不用再问", "别再问了", "加白名单", "记住这个",
    "always", "always allow", "allow always", "don't ask again",
    "dont ask again", "remember this", "whitelist",
}

#: Trailing noise a person types without meaning anything by it.
_CONSENT_STRIP = " \t\r\n。，、！!？?~～.,;；:：」「\"'（）()【】[]"


def parse_consent(text: str) -> Optional[str]:
    """Read a chat reply as an answer to a pending confirmation.

    Returns ``"approve_always"`` / ``"approve"`` / ``"deny"`` / ``None`` (not an
    answer at all).

    Conservative on purpose. A false ``approve`` runs an operation the user was
    still thinking about, so the match is whole-string against a short list and
    refusals are checked first — 「不同意」 must never look like 「同意」.
    """
    s = (text or "").strip().strip(_CONSENT_STRIP).strip().lower()
    if not s or len(s) > 12:
        # Long replies are instructions, not answers. "同意，但先备份一下" is a
        # new request; treating it as consent would skip the backup.
        return None
    if s in _CONSENT_NO:
        return "deny"
    if s in _CONSENT_ALWAYS:
        return "approve_always"
    if s in _CONSENT_YES:
        return "approve"
    return None


#: Tools safe to run inside a read-only sandbox, derived from the risk table so
#: the two never drift apart.
_READONLY_TOOLS = {
    name for name, info in TOOL_RISK_LEVELS.items() if info["level"] == RiskLevel.LOW
}

#: Tools a subagent may never reach: further dispatch (fan-out loops) and the
#: raw shell (a subagent's prompt is model-authored, so it is lower-trust input).
_SUBAGENT_DENIED_TOOLS = {"dispatch_task", "shell_executor", "bash", "python_executor"}


class RiskController:
    """Risk control as event subscriber.

    Subscribes to 'pre_tool_use' event on the event bus. The verdict itself comes
    from a :class:`ToolPolicyPipeline` (B4) so authorization is a composable walk
    of labelled layers instead of a monolithic if/else — the last decision and
    its full audit trail are kept on ``last_result`` for the UI.
    """

    def __init__(self, mode: PermissionMode = PermissionMode.AUTO):
        self.mode = mode
        #: Whether low-risk tools skip the ask in the per-step-confirm mode.
        #: Seeded from config.json's `permissions.auto_confirm_low_risk` — the
        #: key existed forever with nothing reading it; now "每步问我" can mean
        #: literally every step when the user turns this off.
        self.auto_confirm_low_risk: bool = True
        try:
            import json as _json
            import os as _os
            _cfg_path = _os.path.join(
                _os.path.dirname(_os.path.abspath(__file__)), "..", "config.json")
            with open(_cfg_path, "r", encoding="utf-8") as _f:
                _val = (_json.load(_f).get("permissions") or {}).get("auto_confirm_low_risk")
            if _val is not None:
                self.auto_confirm_low_risk = bool(_val)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        self._permissions: list[PermissionRecord] = []
        #: call_id -> the ask the user has not answered yet. Keyed by call_id and
        #: not by tool_name: two pending writes to different files are two
        #: different questions, and answering one must not authorize the other.
        self._pending_confirmations: dict[str, PendingConfirmation] = {}
        #: Lazily-resolved storage plus the set of sessions already read back from
        #: it. Resolved late on purpose: constructing this controller must not
        #: depend on the database existing yet.
        self._storage: Any = None
        self._pending_loaded: set[str] = set()
        self._bus: Optional[EventBus] = None
        self.pipeline = ToolPolicyPipeline()
        #: Audit trail of the most recent evaluation, surfaced via get_audit_trail.
        self.last_result: Optional[Any] = None
        self._install_layers()

    def _install_layers(self) -> None:
        """Register the built-in policy layers in pipeline order.

        Only the layers this process can actually decide are registered here;
        remote/group/sender layers are contributed by their owning subsystems
        (e.g. ``bot_remote``) so each one keeps its own denylist.
        """
        self.pipeline.register(PolicyLayer.GLOBAL, self._global_risk_layer, label="risk-table")
        self.pipeline.register(
            PolicyLayer.SANDBOX, make_sandbox_layer(_READONLY_TOOLS), label="sandbox",
        )
        # The policy-pipeline SANDBOX layer is a readonly-tool flag, not the
        # OS confinement in sandbox.py. OS confinement is always on for shell
        # (popen_confined). This flag stays unset until a turn opts into
        # read-only tools; silence here used to be how a fake layer became
        # something the team believed, so we still say it out loud.
        _sandbox = sandbox_layer_status()
        if not _sandbox["effective"]:
            print(
                "[policy] SANDBOX tool-flag layer is unset (readonly-tools "
                "gate). Kernel confinement is sandbox.popen_confined, not this layer."
            )
        self.pipeline.register(

            PolicyLayer.SUBAGENT, make_subagent_layer(_SUBAGENT_DENIED_TOOLS), label="subagent",
        )
        self.pipeline.register(PolicyLayer.INHERITED, self._granted_permission_layer,
                               label="granted-permission")
        self.pipeline.register(
            PolicyLayer.COMMAND, make_command_guard_layer(), label="command-guard",
        )

    def _global_risk_layer(self, req: PolicyRequest) -> Optional[PolicyDecision]:
        """GLOBAL layer: standing rules, the CRITICAL floor, then the risk table.

        The mode is resolved per request: a per-turn override rides on the tool
        context (``context['permission']``, set by the composer) and wins over the
        process-wide default in ``self.mode``. That is how the single axis stays
        single — one layer, one decision, whether the value came from the global
        setting or this turn's dropdown.

        Evaluation order is the whole design, so it is spelled out:

        1. **A user's deny rule** — nothing outranks an explicit "never this".
        2. **Read-only modes** — 计划/只读 is this turn's deliberate choice and
           must not be unlocked by a rule the user wrote last week.
        3. **CRITICAL** — always asks, even under 全权代理. The matching allow
           rule is deliberately ignored here (see
           :meth:`_granted_permission_layer`): a standing blanket is not consent
           for an irreversible act, though a per-call approval is.
        4. **An ask rule** — the user asked to be consulted about this class.
        5. Everything else falls through to the mode + risk table as before.

        Steps 1-3 return DENY/ASK from the GLOBAL layer, which is what makes them
        un-bypassable: a DENY short-circuits the pipeline walk entirely, and the
        ASK from step 3 is protected from the one layer that could clear it.
        """
        risk = self.classify_risk(req.tool_name, req.args)
        mode = self._effective_mode(req.context)
        rule = self._match_rule(req)

        # A standing rule winning this call is the one thing the context meter
        # calls a "rule applied". Counted here rather than at each of the four
        # rule branches below because this is the single point that knows a rule
        # won at all; the analytics counter was defined but had no caller, so the
        # UI chip read a flat 0 no matter how many rules fired.
        if rule is not None:
            try:
                from token_analytics import get_token_analytics
                get_token_analytics().on_rule_applied()
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程

        if rule is not None and rule.behavior is RuleBehavior.DENY:
            return PolicyDecision(
                action=PolicyAction.DENY, layer=PolicyLayer.GLOBAL,
                label=f"rule:deny:{rule.id[:8]}",
                reason=(f"你设置过一条规则禁止这类调用（{rule.tool_name}"
                        f"{' / ' + rule.pattern if rule.pattern else ''}），已拦下。"
                        "要放开就去设置里删掉那条规则。"),
            )

        if mode in READ_ONLY_MODES and risk != RiskLevel.LOW:
            return PolicyDecision(
                action=PolicyAction.DENY, layer=PolicyLayer.GLOBAL,
                label=f"mode:{mode.value}",
                reason=self._read_only_refusal(mode, req.tool_name),
            )

        if risk is RiskLevel.CRITICAL:
            return PolicyDecision(
                action=PolicyAction.ASK, layer=PolicyLayer.GLOBAL,
                label="risk:critical",
                reason=self._critical_prompt(req.tool_name, req.args),
            )

        if rule is not None and rule.behavior is RuleBehavior.ASK:
            return PolicyDecision(
                action=PolicyAction.ASK, layer=PolicyLayer.GLOBAL,
                label=f"rule:ask:{rule.id[:8]}",
                reason=self._build_confirmation_prompt(req.tool_name, req.args, risk),
            )

        # A standing allow rule abstains rather than force-allowing: the SANDBOX
        # and SUBAGENT layers still get their say. "The user is fine with `pytest`"
        # is not "a read-only sub-agent may now run shell commands".
        if rule is not None and rule.behavior is RuleBehavior.ALLOW:
            return None

        # Reads are always fine — no mode blocks or asks a low-risk tool…
        # except "每步问我" with the safety dial turned up: when the user
        # disables auto_confirm_low_risk, the CONFIRM mode asks for low-risk
        # calls too. READ_ONLY modes still pass — they are useless without
        # reads — and FULL/AUTO never ask for low regardless.
        if risk == RiskLevel.LOW:
            if mode is PermissionMode.CONFIRM and not self.auto_confirm_low_risk:
                return PolicyDecision(
                    action=PolicyAction.ASK, layer=PolicyLayer.GLOBAL,
                    label="mode:confirm+low",
                    reason=self._build_confirmation_prompt(req.tool_name, req.args, risk),
                )
            return None

        if mode is PermissionMode.CONFIRM:
            return PolicyDecision(
                action=PolicyAction.ASK, layer=PolicyLayer.GLOBAL,
                label=f"mode:confirm+risk:{risk.value}",
                reason=self._build_confirmation_prompt(req.tool_name, req.args, risk),
            )

        if mode is PermissionMode.FULL:
            return None

        # AUTO: medium/high risk asks (low already returned above). A standing
        # allow rule turns this ask into a pass via the INHERITED layer.
        return PolicyDecision(
            action=PolicyAction.ASK, layer=PolicyLayer.GLOBAL,
            label=f"risk:{risk.value}",
            reason=self._build_confirmation_prompt(req.tool_name, req.args, risk),
        )

    @staticmethod
    def _match_rule(req: PolicyRequest):
        """The winning standing rule for this call, or None.

        Wrapped in a try because the rule store touches SQLite: a locked or
        corrupt DB must degrade to "no rules" and let the risk table decide,
        not take down every tool call in the process.
        """
        try:
            from permission_rules import get_permission_rules
            ctx = req.context or {}
            return get_permission_rules().match(
                req.tool_name, req.args or {},
                workspace_root=str(ctx.get("workspace_root", "") or ""),
                session_id=str(ctx.get("session_id", "") or ""),
            )
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _critical_prompt(tool_name: str, args: dict) -> str:
        intent = _consequence_intent(tool_name, args or {})
        return (
            f"{intent}\n"
            "这一步不可逆，而且**不受权限档位和白名单规则影响** —— 就算你开了"
            "「全权代理」，它也一定会停下来问你。想继续请明确回复「同意」；"
            "如果有更安全的做法（比如先备份、或改成不带 force 的推送），说一声我换。"
        )

    def _effective_mode(self, context: dict) -> PermissionMode:
        """This turn's mode: the per-turn override if present, else the global one."""
        override = (context or {}).get("permission")
        if override:
            return coerce_permission(override)
        return self.mode

    @staticmethod
    def _read_only_refusal(mode: PermissionMode, tool_name: str) -> str:
        """Refusal text for a hard read-only mode. With direction — a bare 'no'
        just wastes a turn."""
        if mode is PermissionMode.PLAN:
            return (
                f"当前是「只出方案」档，`{tool_name}` 会改动环境，已被拦下。\n"
                "这一档下你只能读取和分析。请把你打算怎么做写成方案交给用户 —— "
                "包括要改哪些文件、每处改什么、有什么风险、怎么验证。用户认可后会自己把"
                "权限调到「小事放手」或「全权代理」，那时你再动手。不要试图绕开这个限制。"
            )
        return (
            f"当前权限档是「只看不动」，`{tool_name}` 会改动环境，已被拦下。\n"
            "你可以继续读取和分析来回答用户的问题。如果确实需要动手，"
            "请提示用户把权限调到「每步问我」或更高。"
        )


    def _granted_permission_layer(self, req: PolicyRequest) -> Optional[PolicyDecision]:
        """INHERITED layer: an already-granted per-args permission clears an ask.

        Runs last and returns ``CLEAR``, which downgrades a prior ``ask`` back to
        allow. It can never rescue a ``deny`` — a hard deny short-circuits the
        walk before this layer is ever consulted.
        """
        if self._has_explicit_grant(req.tool_name, req.args, req.context):
            return PolicyDecision(
                action=PolicyAction.CLEAR,
                layer=PolicyLayer.INHERITED,
                label="granted",
                reason="user already approved this exact call",
            )
        return None

    def mount(self, bus: EventBus = None):
        """Register as event subscriber on the bus."""
        self._bus = bus or get_event_bus()
        self._bus.on("pre_tool_use", self._on_pre_tool_use, priority=100)

    def unmount(self):
        if self._bus:
            self._bus.off("pre_tool_use", self._on_pre_tool_use)

    def set_mode(self, mode: PermissionMode | str):
        """Set the process-wide DEFAULT mode (the one in Settings).

        Coerced rather than constructed so a legacy value from an older
        config.json (``deny``) still lands somewhere sane instead of raising.
        """
        self.mode = coerce_permission(mode)

    def set_auto_confirm_low_risk(self, enabled: bool) -> None:
        """Hot-apply the low-risk auto-confirm dial (settings page toggle)."""
        self.auto_confirm_low_risk = bool(enabled)

    def classify_risk(self, tool_name: str, args: dict = None) -> RiskLevel:
        """Classify risk level for a tool call."""
        # Pure-read shell command is LOW risk even though the
        # shell tool itself defaults to HIGH — reads never need confirmation.
        if tool_name in ("bash", "shell_executor") and args:
            cmd = args.get("command", "") or args.get("cmd", "")
            if cmd and is_readonly_command(cmd):
                return RiskLevel.LOW

        # A force push is a different operation from a push, but it arrives as
        # the same tool with a flag. Reading the flag is what keeps the CRITICAL
        # floor from depending on the model picking the `git_push_force` name.
        if tool_name in ("git_push", "git_push_force") and args:
            if args.get("force") or args.get("force_with_lease"):
                return RiskLevel.CRITICAL

        entry = TOOL_RISK_LEVELS.get(tool_name)
        if entry:
            return entry["level"]

        # Fall back to the ToolDef.risk_level registered by the owning agent.
        # Without this, every unlisted tool (e.g. system_info, which is low)
        # was incorrectly escalated to MEDIUM and forced a confirmation.
        try:
            from tools import get_tool_registry
            tool = get_tool_registry().get(tool_name)
            if tool is not None:
                level = str(getattr(tool, "risk_level", "medium") or "medium").lower()
                if level == "critical":
                    return RiskLevel.CRITICAL
                if level == "low":
                    return RiskLevel.LOW
                if level == "high":
                    return RiskLevel.HIGH
                return RiskLevel.MEDIUM
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

        # Truly unknown tools default to medium
        return RiskLevel.MEDIUM

    def needs_confirmation(self, tool_name: str, args: dict = None,
                           context: dict = None) -> bool:
        """Would this call be asked about? Answers from the SAME layer that decides.

        This used to re-implement the mode branching by hand and had already drifted
        — it returned True for a low-risk read under the old ``deny`` mode while the
        real layer let that read through. Delegating removes the second opinion.
        """
        risk = self.classify_risk(tool_name, args)
        decision = self._global_risk_layer(PolicyRequest(
            tool_name=tool_name, args=args or {}, context=context or {},
            risk_level=risk.value,
        ))
        return decision is not None and decision.action in (PolicyAction.ASK, PolicyAction.DENY)

    def _on_pre_tool_use(self, event: Event):
        """Event handler: evaluate the policy pipeline then act on the verdict.

        The pipeline replaces the old hand-written if/else tree. All layers
        (global risk table, sandbox, subagent, granted-permission) run in order
        and the strictest non-allow decision wins. The full audit trail is kept
        on ``self.last_result`` for debugging / the settings UI.
        """
        tool_name = event.payload.get("tool_name", "")
        args = event.payload.get("args", {})
        context = event.payload.get("context", {})

        risk = self.classify_risk(tool_name, args)

        request = PolicyRequest(
            tool_name=tool_name,
            args=args,
            context=context,
            risk_level=risk.value,
            provider=context.get("provider", ""),
            agent=context.get("agent_role", ""),
        )

        result = self.pipeline.evaluate(request)
        self.last_result = result

        # Confused-deputy detection (D4-b): runs AFTER the pipeline so it
        # can upgrade an ALLOW to an ASK when the signals say "this call
        # looks like a remote session reaching through a privileged tool
        # with a cross-context path". A DENY is already stronger, and an
        # existing ASK keeps its (more specific) reason. The function in
        # red_team was defined but never called — this is its call site.
        if result.action != PolicyAction.DENY:
            try:
                from red_team import get_red_team_auditor
                auditor = get_red_team_auditor()
                signals = auditor.confused_deputy_signals(tool_name, args, context)
                if signals and result.action == PolicyAction.ALLOW:
                    # In Full Auto / YOLO mode ("全权代理"), the user has explicitly authorized
                    # autonomous execution. Do not upgrade ALLOW to ASK.
                    perm = context.get("permission")
                    if perm in ("full", "yolo", "never", "full_access") or self.mode is PermissionMode.FULL:
                        pass  # 全权代理：保持 ALLOW，不升级为 ASK（控制流占位，非吞异常）
                    else:
                        sig_text = "; ".join(signals)
                        result = PolicyDecision(
                            action=PolicyAction.ASK,
                            layer=PolicyLayer.GLOBAL,
                            label="confused-deputy",
                            reason=f"Confused-deputy 检测触发，需人工确认: {sig_text}",
                        )
                        self.last_result = result
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程

        if result.action == PolicyAction.DENY:
            event.block(result.reason or "策略拦截")
            return

        if result.action == PolicyAction.ASK:
            # No grant cleared this call (the INHERITED layer would have turned
            # the ask into a CLEAR), so the user has to answer. Remember the
            # question before halting the turn — without this record the reply
            # 「同意」 has nothing to attach to and the ask is unanswerable.
            prompt = result.reason or self._build_confirmation_prompt(tool_name, args, risk)
            self.record_pending(
                call_id=event.payload.get("call_id", ""),
                tool_name=tool_name,
                args=args,
                prompt=prompt,
                session_id=event.payload.get("session_id", "") or context.get("session_id", ""),
            )
            event.ask(prompt)
            return

        # result.action == ALLOW → event stays CONTINUE

    def get_audit_trail(self) -> list[dict]:
        """Return the audit trail from the last pipeline evaluation."""
        if self.last_result is not None:
            return self.last_result.trail
        return []

    def _has_permission(self, tool_name: str, args: dict, context: dict) -> bool:
        """Check if there's a valid permission for this tool call.

        Key principle: 'Approval in one context does not extend to the next.'
        Permission is per-call, not blanket.

        Note the low-risk shortcut: kept for external callers that ask "may I run
        this?" without going through the pipeline. The INHERITED policy layer
        must NOT use it — see :meth:`_has_explicit_grant` for why.
        """
        # In auto mode, low-risk tools always pass
        risk = self.classify_risk(tool_name, args)
        if risk == RiskLevel.LOW:
            return True

        return self._has_explicit_grant(tool_name, args, context)

    def _has_explicit_grant(self, tool_name: str, args: dict, context: dict) -> bool:
        """True only when the user actually approved this exact call.

        Deliberately has no low-risk shortcut. The INHERITED layer uses this to
        emit ``CLEAR``, and "low risk" is not consent — treating it as consent
        would silently cancel the confirm-mode ask on every read.

        Non-consuming: the pipeline may evaluate a call that later fails another
        gate, and burning the grant there would make the user confirm twice for
        one operation. :meth:`consume_grant` is called by the router once the
        call is actually cleared to run.
        """
        return self._find_grant(tool_name, args, context) is not None

    def _find_grant(self, tool_name: str, args: dict, context: dict) -> Optional[PermissionRecord]:
        """Locate a live grant for this exact call, or ``None``."""
        args_hash = self._hash_args(args)
        session_id = str((context or {}).get("session_id", "") or "")
        now = time.time()
        for perm in self._permissions:
            if perm.tool_name != tool_name or perm.args_hash != args_hash:
                continue
            if perm.scope == "session":
                # A grant belongs to the window it was given in.
                if perm.session_id and session_id and perm.session_id != session_id:
                    continue
            if perm.granted_at and now - perm.granted_at > GRANT_TTL_S:
                continue
            return perm
        return None

    def has_grant(self, tool_name: str, args: dict, context: dict = None) -> bool:
        """Public, non-consuming: did the user already approve this exact call?

        The router needs this because its own mode gate answers ``ask`` for every
        write independently of the policy pipeline. Without a way to see the
        recorded approval, the gate would re-raise a question the user has
        already answered and the call could never run.
        """
        return self._has_explicit_grant(tool_name, args, context or {})

    def consume_grant(self, tool_name: str, args: dict, context: dict = None) -> bool:
        """Spend a single-use grant now that the call is cleared to execute."""
        perm = self._find_grant(tool_name, args, context or {})
        if perm is None:
            return False
        if perm.single_use:
            self._permissions = [p for p in self._permissions if p is not perm]
        return True

    def grant_permission(self, tool_name: str, args: dict, scope: str = "session",
                         session_id: str = "", single_use: bool = True):
        """Record that the user approved a specific tool call.

        Called when a pending confirmation is answered — see
        :meth:`resolve_pending`. Before that path existed this method had no
        callers at all, which left the INHERITED policy layer permanently dead:
        every ``ask`` was raised and never clearable.
        """
        self._permissions.append(PermissionRecord(
            tool_name=tool_name,
            scope=scope,
            granted_at=time.time(),
            args_hash=self._hash_args(args),
            session_id=session_id,
            single_use=single_use,
        ))

    def revoke_permission(self, tool_name: str, scope: str = "session"):
        """Revoke permissions for a tool."""
        self._permissions = [
            p for p in self._permissions
            if not (p.tool_name == tool_name and p.scope == scope)
        ]

    # ── pending-ask ledger ────────────────────────────────────────────────
    def _store(self):
        """Resolve storage on first use, never at construction time."""
        if self._storage is None:
            from storage import get_storage
            self._storage = get_storage()
        return self._storage

    def _load_pending(self, session_id: str) -> None:
        """Read one session's unanswered asks back from disk, once."""
        sid = str(session_id or "")
        if not sid or sid in self._pending_loaded:
            # A blank id can't key a ledger; loading under it would let two
            # unrelated sessions share one bucket.
            return
        self._pending_loaded.add(sid)
        try:
            rows = self._store().kv_get(_pending_kv_key(sid), ns=_PENDING_KV_NS, default=[]) or []
        except Exception:
            return  # A locked DB degrades to memory-only rather than killing the call.
        now = time.time()
        for row in rows if isinstance(rows, list) else []:
            try:
                asked_at = float(row.get("asked_at") or 0)
                if now - asked_at > PENDING_TTL_S:
                    continue
                entry = PendingConfirmation(
                    call_id=str(row["call_id"]),
                    tool_name=str(row.get("tool_name") or ""),
                    args=dict(row.get("args") or {}),
                    prompt=str(row.get("prompt") or ""),
                    session_id=sid,
                    asked_at=asked_at,
                )
            except Exception:
                continue
            if entry.tool_name:
                # setdefault: a live in-memory entry is fresher than the disk row.
                self._pending_confirmations.setdefault(entry.call_id, entry)

    def _persist_pending(self, session_id: str) -> None:
        sid = str(session_id or "")
        if not sid:
            return
        try:
            self._store().kv_set(
                _pending_kv_key(sid),
                # Only rows that actually belong to this session. `pending_for`
                # also returns blank-session legacy entries, and writing those
                # here would silently adopt them into this session on reload.
                [{"call_id": p.call_id, "tool_name": p.tool_name, "args": p.args,
                  "prompt": p.prompt, "asked_at": p.asked_at}
                 for p in self.pending_for(sid) if p.session_id == sid],
                ns=_PENDING_KV_NS,
            )
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    def record_pending(self, call_id: str, tool_name: str, args: dict,
                       prompt: str = "", session_id: str = "") -> PendingConfirmation:
        """Remember an unanswered ask so a later reply can resolve it."""
        self._load_pending(session_id)
        entry = PendingConfirmation(
            call_id=call_id or f"{tool_name}-pending",
            tool_name=tool_name,
            args=args or {},
            prompt=prompt,
            session_id=str(session_id or ""),
            asked_at=time.time(),
        )
        self._pending_confirmations[entry.call_id] = entry
        if len(self._pending_confirmations) > _MAX_PENDING:
            oldest = sorted(self._pending_confirmations.values(), key=lambda p: p.asked_at)
            for stale in oldest[: len(self._pending_confirmations) - _MAX_PENDING]:
                self._pending_confirmations.pop(stale.call_id, None)
        self._persist_pending(entry.session_id)
        return entry

    def pending_for(self, session_id: str = "") -> list[PendingConfirmation]:
        """Unanswered asks for one session, newest first."""
        sid = str(session_id or "")
        self._load_pending(sid)
        rows = [
            p for p in self._pending_confirmations.values()
            if not sid or not p.session_id or p.session_id == sid
        ]
        return sorted(rows, key=lambda p: p.asked_at, reverse=True)

    def resolve_pending(self, decision: str, session_id: str = "",
                        call_id: str = "") -> Optional[PendingConfirmation]:
        """Answer a pending ask. Returns the entry that was answered.

        ``decision`` is ``"approve"``, ``"approve_always"``, or anything else
        (treated as a refusal — fail-safe, an unparsable answer must never
        grant). Approval writes a single-use per-args grant so the model's next
        attempt at the *same* call passes; different arguments are a different
        question and ask again.

        ``approve_always`` additionally leaves a standing rule behind, so the
        next call of the same *class* never reaches the user at all. That is the
        difference between an agent that can finish a 30-file refactor and one
        that stops 30 times.
        """
        rows = self.pending_for(session_id)
        entry = None
        if call_id:
            entry = self._pending_confirmations.get(call_id)
        elif rows:
            # Newest only. Older prompts the user scrolled past are not what
            # 「同意」 refers to, and bulk-approving them would be a silent
            # escalation from one answer to many.
            entry = rows[0]
        if entry is None:
            return None

        self._pending_confirmations.pop(entry.call_id, None)
        # The answered ask leaves the ledger on disk too, so a reload doesn't
        # resurrect a question the user already resolved.
        self._persist_pending(entry.session_id or str(session_id or ""))
        if decision in ("approve", "approve_always"):
            sid = entry.session_id or str(session_id or "")
            self.grant_permission(entry.tool_name, entry.args, session_id=sid)
            if decision == "approve_always":
                self._remember_always(entry)
        return entry

    def _remember_always(self, entry: PendingConfirmation) -> bool:
        """Turn one approval into a standing allow rule. Returns whether it stuck.

        Refuses on CRITICAL: those ask *because* they are irreversible, and the
        whole point of that tier is that no blanket silences it. Saying
        「以后都允许」 to a force-push has to be a no-op, not a permanent hole.
        """
        try:
            risk = self.classify_risk(entry.tool_name, entry.args)
            if risk is RiskLevel.CRITICAL:
                return False
            from permission_rules import (
                PermissionRule, RuleBehavior, RuleScope,
                get_permission_rules, suggest_pattern,
            )
            get_permission_rules().add(PermissionRule(
                tool_name=entry.tool_name,
                pattern=suggest_pattern(entry.tool_name, entry.args),
                behavior=RuleBehavior.ALLOW,
                # Chat approval only knows the session, not the workspace root
                # (the pending entry doesn't carry it). Session scope is the
                # honest ceiling: a broader workspace/global rule is something
                # the user should set deliberately in the rules UI, not one we
                # widen on their behalf from a two-word reply.
                scope=RuleScope.SESSION,
                session_id=entry.session_id,
                source="user",
                note="用户在确认时选择「以后都允许」",
            ))
            return True
        except Exception:  # noqa: BLE001
            # A failed rule write must not also lose the one-shot grant that was
            # already recorded — the user's immediate intent still goes through.
            return False

    def _hash_args(self, args: dict) -> str:
        """Hash args to create per-call permission key."""
        import hashlib
        import json
        try:
            canonical = json.dumps(args, sort_keys=True, ensure_ascii=False)
        except (TypeError, ValueError):
            canonical = str(sorted(args.items(), key=lambda x: str(x)))
        return hashlib.md5(canonical.encode()).hexdigest()

    def _build_confirmation_prompt(self, tool_name: str, args: dict, risk: RiskLevel) -> str:
        """Build a consequence-first Chinese confirmation.

        Talk about what will happen to the user — never dump Tool/Args/Risk
        enums, and never leak raw tool names into chat prose.

        The 「以后都允许」 line is not decoration: without it the rule system is
        undiscoverable, and an unused allowlist is the same as no allowlist. The
        suggested pattern is shown verbatim so the user is agreeing to a scope
        they can actually see, rather than to the word "always".
        """
        intent = _consequence_intent(tool_name, args or {})
        consequence = _consequence_side_effect(tool_name, args or {})
        lines = [f"收到。{intent}"]
        if consequence:
            lines.append(consequence)
        lines.append("回复「同意」我就继续 —— 这次确认只对这一次有效。")
        lines.append(self._always_hint(tool_name, args or {}))
        lines.append("不想做的话直接告诉我换个做法。")
        return "\n".join(l for l in lines if l)

    @staticmethod
    def _always_hint(tool_name: str, args: dict) -> str:
        """The "and stop asking" offer, with the exact scope spelled out."""
        try:
            from permission_rules import suggest_pattern
            pattern = suggest_pattern(tool_name, args)
        except Exception:  # noqa: BLE001
            return ""
        if pattern:
            return f"回复「以后都允许」，这个会话里所有 `{pattern}` 都不再问你。"
        return "回复「以后都允许」，这个会话里同类操作都不再问你。"

    def get_risk_table(self) -> dict:
        """Export risk level table for UI display."""
        return {
            name: {"level": info["level"].value, "needs_approval": info["needs_approval"]}
            for name, info in TOOL_RISK_LEVELS.items()
        }


class RemoteSessionRiskDecorator:
    """Enforce the Bot tool denylist for remote (IM-driven) sessions.

    Mounts on ``pre_tool_use`` at a higher priority than RiskController so a
    denied tool is blocked before any confirmation flow can approve it. Without
    this the denylist in ``bot_remote.py`` is never consulted at call time and a
    remote user can reach ``shell_executor``.

    A session is remote when its context carries ``is_remote=True`` (set by
    ``BotController.handle_message``).
    """

    #: Runs before RiskController (100) so deny wins over ask/allow.
    PRIORITY: int = 200

    def __init__(self, controller: Any = None) -> None:
        """Initialize the decorator.

        Args:
            controller: BotController providing the denylist and audit sink.
                Resolved lazily when omitted to avoid an import cycle.
        """
        self._bot = controller
        self._bus: Optional[EventBus] = None

    def _bot_controller(self) -> Any:
        """Resolve the BotController lazily (bot_remote imports risk_control)."""
        if self._bot is None:
            from bot_remote import get_bot_controller
            self._bot = get_bot_controller()
        return self._bot

    def mount(self, bus: EventBus = None) -> None:
        """Register on the event bus.

        Args:
            bus: Target bus; the global bus when omitted.
        """
        self._bus = bus or get_event_bus()
        self._bus.on("pre_tool_use", self._on_pre_tool_use, priority=self.PRIORITY)

    def unmount(self) -> None:
        """Unregister from the event bus."""
        if self._bus:
            self._bus.off("pre_tool_use", self._on_pre_tool_use)

    def _on_pre_tool_use(self, event: Event) -> None:
        """Block denylisted tools in remote sessions and record an audit row."""
        context = event.payload.get("context", {}) or {}
        if not context.get("is_remote"):
            return
        tool_name = event.payload.get("tool_name", "")
        platform = context.get("platform", "")
        bot = self._bot_controller()

        if bot.is_tool_allowed(platform, tool_name):
            # Still audit what a remote session is allowed to do.
            bot.audit_operation(
                platform, context.get("user_id", ""), context.get("session_id", ""),
                tool_name, action="allow", blocked=False, reason="",
            )
            return

        reason = f"'{tool_name}' is disabled for remote sessions"
        bot.audit_operation(
            platform, context.get("user_id", ""), context.get("session_id", ""),
            tool_name, action="deny_tool", blocked=True, reason=reason,
        )
        event.block(
            f"{reason}. Run it from the desktop app if you really need it."
        )


def _consequence_intent(tool_name: str, args: dict) -> str:
    """One human sentence of intent (no tool-name leakage)."""
    path = args.get("path") or args.get("dst") or args.get("file")
    pid = args.get("pid")
    cmd = args.get("command") or args.get("cmd")
    url = args.get("url")
    if tool_name == "write_file" and path:
        return f"我会写入文件 `{path}`。"
    if tool_name == "edit_file" and path:
        return f"我会修改文件 `{path}`。"
    if tool_name == "delete_file" and path:
        return f"我会删除文件 `{path}`。"
    if tool_name == "process_kill" and pid is not None:
        return f"我会结束进程 PID {pid}。"
    if tool_name in ("shell_executor", "bash") and cmd:
        return f"我会在系统里执行这条命令：`{_short_repr(cmd, 80)}`。"
    if tool_name == "git_push":
        return "准备把当前提交推送到远程仓库。"
    if tool_name == "git_commit":
        return "准备创建一个 Git 提交。"
    if tool_name == "app_uninstall":
        return f"准备卸载应用{(' ' + str(args.get('name') or args.get('package') or '')).rstrip()}。"
    if tool_name == "navigate" and url:
        return f"准备打开网页 `{url}`。"
    if tool_name == "fill":
        return "准备在网页上填写表单字段。"
    if tool_name == "cron_create":
        return "准备创建一个定时任务。"
    friendly = _FRIENDLY_TOOL_NAMES.get(tool_name)
    if friendly:
        return f"接下来我会{friendly}。"
    return "接下来有一步操作需要你点头。"


def _consequence_side_effect(tool_name: str, args: dict) -> str:
    """One sentence of consequence / reversibility, or empty."""
    if tool_name in ("write_file", "edit_file"):
        return "这会改动已有内容；需要的话我可以先备份再写。"
    if tool_name == "delete_file":
        return "删除后通常难以恢复，请确认目标无误。"
    if tool_name == "process_kill":
        return "结束后对应窗口/服务会关掉，一般可以再打开。"
    if tool_name in ("shell_executor", "bash", "native_action_chain", "python_executor"):
        return "命令可能改变系统状态；我只会执行你批准的这一次。"
    if tool_name == "git_push":
        return "推上去之后远端会更新。"
    if tool_name in ("app_uninstall", "app_install"):
        return "这会改变本机已安装的应用。"
    if tool_name == "fill":
        return "如果涉及登录或凭据字段，请确认内容无误。"
    return ""


def _short_repr(val, max_len=50) -> str:
    """Short representation of a value for display."""
    s = repr(val)
    if len(s) > max_len:
        return s[:max_len] + "..."
    return s


# Global risk controller
_controller: Optional[RiskController] = None
_remote_decorator: Optional[RemoteSessionRiskDecorator] = None


def get_risk_controller() -> RiskController:
    global _controller
    if _controller is None:
        _controller = RiskController()
    return _controller


def get_remote_risk_decorator() -> RemoteSessionRiskDecorator:
    """Get the global RemoteSessionRiskDecorator singleton."""
    global _remote_decorator
    if _remote_decorator is None:
        _remote_decorator = RemoteSessionRiskDecorator()
    return _remote_decorator


def init_risk_controller(mode: PermissionMode | str = DEFAULT_PERMISSION) -> RiskController:
    global _controller
    # `coerce_permission`, not `PermissionMode(...)`: this reads straight out of
    # config.json, where an older install still says `deny`. Raising there would
    # take the whole backend down over a renamed enum value.
    _controller = RiskController(mode=coerce_permission(mode))
    _controller.mount()
    get_remote_risk_decorator().mount()
    return _controller
