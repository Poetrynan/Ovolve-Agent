"""
tool_hooks.py - Pre / Post / OnAbort three-stage tool hooks (B5).

Fixes two classes of incident:
  1. Blind destructive calls (``rm -rf``, force push) reaching the shell.
  2. Secrets pulled into the context window by a tool's own output — once an
     API key lands in the transcript it is replayed to the provider on every
     subsequent turn.

Three stages wrap every tool call:
  * **pre**   — runs after policy authorization, before dispatch. May veto
                (``HookOutcome.veto``) or rewrite args (``replace_args``).
  * **post**  — runs on the tool result *before* it enters the context. Used to
                redact secrets and clamp oversized output.
  * **abort** — runs when the call is cancelled/stopped mid-flight, so the
                transcript records a coherent terminal state instead of a
                dangling tool_use with no tool_result.

Declarative contract: a hook registers with a tool-name pattern (glob) and a
stage; the registry is the single place the router consults. This mirrors the
``contracts.agentToolResultMiddleware`` shape — a hook is a pure function of
(tool, args/result, context) returning an outcome, never an ad-hoc callback
reaching into router internals.
"""

from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

from danger_classifier import (
    classify_tool_call,
    payload_of,
    get_denial_cache,
    DENY,
    CONFIRM,
)


class HookStage(str, Enum):
    PRE = "pre"
    POST = "post"
    ABORT = "abort"


@dataclass
class HookOutcome:
    """What a hook wants to happen next.

    Attributes:
        blocked: Veto the call (pre stage only). ``reason`` explains why.
        reason: Human-readable explanation, surfaced to the model and the user.
        replace_args: New args dict to use instead of the original (pre stage).
        replace_content: Replacement result text (post stage).
        redactions: Count of secrets scrubbed, for the audit trail.
        label: Which hook produced this outcome.
    """

    blocked: bool = False
    reason: str = ""
    replace_args: Optional[dict] = None
    replace_content: Optional[str] = None
    redactions: int = 0
    label: str = ""

    @staticmethod
    def veto(reason: str, label: str = "") -> "HookOutcome":
        return HookOutcome(blocked=True, reason=reason, label=label)

    @staticmethod
    def rewrite(args: dict, reason: str = "", label: str = "") -> "HookOutcome":
        return HookOutcome(replace_args=args, reason=reason, label=label)

    @staticmethod
    def sanitize(content: str, redactions: int = 0, label: str = "") -> "HookOutcome":
        return HookOutcome(replace_content=content, redactions=redactions, label=label)


#: A hook is ``(tool_name, payload, context) -> HookOutcome | None``.
#: ``payload`` is the args dict for pre/abort and the result text for post.
HookFn = Callable[[str, Any, dict], Optional[HookOutcome]]


@dataclass
class _Registration:
    pattern: str
    fn: HookFn
    label: str
    priority: int = 0


# --------------------------------------------------------------------------- #
# Secret redaction                                                            #
# --------------------------------------------------------------------------- #

#: Patterns for credentials that must never reach the context window. Ordered
#: most-specific first so a provider-shaped key is labelled precisely rather
#: than caught by the generic assignment rule.
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern], ...] = (
    ("openai-key", re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}\b")),
    ("anthropic-key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{16,}\b")),
    ("github-token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}\b")),
    ("slack-token", re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{10,}\b")),
    ("google-key", re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}\b")),
    ("aws-access-key", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("bearer-token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{20,}")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b")),
    ("private-key", re.compile(
        r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END"
        r" (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    # Generic `KEY=value` / `"token": "value"` assignments in env dumps & JSON.
    ("credential-assignment", re.compile(
        r"(?i)\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL)"
        r"[A-Z0-9_]*)\s*[:=]\s*[\"']?([^\s\"',}]{8,})")),
)

#: Placeholder keeps the shape of the output intact so the model still sees that
#: a value existed — it just can't read (or leak) it.
_REDACTED = "[已脱敏]"


def redact_secrets(text: str) -> tuple[str, int, list[str]]:
    """Scrub credentials from tool output.

    Returns:
        ``(cleaned_text, count, kinds)`` — kinds lists the pattern names hit, so
        the audit trail can say *what* was redacted without echoing the value.
    """
    if not text or not isinstance(text, str):
        return text, 0, []

    total = 0
    kinds: list[str] = []
    cleaned = text

    for name, pattern in _SECRET_PATTERNS:
        if name == "credential-assignment":
            # Preserve the key name, redact only the value.
            def _sub(m: re.Match) -> str:
                return f"{m.group(1)}={_REDACTED}"
            cleaned, n = pattern.subn(_sub, cleaned)
        else:
            cleaned, n = pattern.subn(_REDACTED, cleaned)
        if n:
            total += n
            kinds.append(name)

    return cleaned, total, kinds


def secret_redaction_hook(tool_name: str, payload: Any, context: dict) -> Optional[HookOutcome]:
    """POST hook: strip credentials from a tool result before it enters context."""
    if not isinstance(payload, str):
        return None
    cleaned, count, kinds = redact_secrets(payload)
    if not count:
        return None
    return HookOutcome.sanitize(
        cleaned,
        redactions=count,
        label="secret-redaction:" + ",".join(kinds),
    )


# --------------------------------------------------------------------------- #
# Tool-result anti-injection (prompt injection via tool output)               #
# --------------------------------------------------------------------------- #

#: Tier A — tags that essentially never occur in legitimate source, config or
#: command output, so any occurrence is treated as an injection attempt and
#: neutralized wherever it appears.
_INJECTION_TAG_STRICT = re.compile(
    r"<\s*/?\s*("
    r"tool_call|tool_calls|tool_result|tool_results|tool_use"
    r"|function_call|function_calls|function_result|function_results"
    r"|system-reminder|system_reminder|system_prompt|systemprompt"
    r"|antml:\w+"
    r"|\|?im_start\|?|\|?im_end\|?|\|?endoftext\|?|\|?eot_id\|?"
    r"|\|?start_header_id\|?|\|?end_header_id\|?"
    r")(?:\s[^>]*)?\s*/?>",
    re.IGNORECASE,
)

#: Tier B — ordinary English words that are ALSO prompt-framing tags. These do
#: appear in real XML/HTML (an Android manifest, a Spring config, a docs page),
#: so blanket-neutralizing them would corrupt files the model was asked to read.
#: We only rewrite them in the shape an injection actually takes: the tag alone
#: on its own line, which is how a payload fakes a turn boundary.
_INJECTION_TAG_LOOSE = re.compile(
    r"^[ \t]*(<\s*/?\s*(?:system|assistant|user|human|instructions?"
    r"|important_instructions)(?:\s[^>]*)?\s*/?>)[ \t]*$",
    re.IGNORECASE | re.MULTILINE,
)

#: Replacing the angle brackets with full-width lookalikes keeps the text
#: readable for the user (and greppable in the transcript) while making it inert
#: as markup — no content is lost, which matters because a tool result is often
#: the only copy of what a command printed.
_LT_FULL = "\uff1c"  # ＜
_GT_FULL = "\uff1e"  # ＞


def _neutralize_tag(text: str) -> str:
    """Swap the outer ``<``/``>`` of one tag for full-width variants."""
    return _LT_FULL + text[1:-1] + _GT_FULL


def sanitize_injection_tags(text: str) -> tuple[str, int]:
    """Neutralize prompt-framing tags smuggled in through tool output.

    Returns:
        ``(cleaned_text, count)`` — ``count`` is how many tags were rewritten,
        so the audit trail can report the hit without echoing the payload.
    """
    if not text or not isinstance(text, str):
        return text, 0
    cleaned, strict_hits = _INJECTION_TAG_STRICT.subn(
        lambda m: _neutralize_tag(m.group(0)), text,
    )
    cleaned, loose_hits = _INJECTION_TAG_LOOSE.subn(
        lambda m: m.group(0).replace(m.group(1), _neutralize_tag(m.group(1))),
        cleaned,
    )
    return cleaned, strict_hits + loose_hits


def anti_injection_hook(tool_name: str, payload: Any, context: dict) -> Optional[HookOutcome]:
    """POST hook: defang control tags in a tool result before it enters context.

    Tool output is untrusted input. A file the model was asked to read, a web
    page it fetched, or a command's stdout can all carry text shaped like a turn
    boundary or a tool call — and once that lands in the transcript the model may
    obey it as if it came from us. Rewriting the brackets breaks the framing
    without deleting the evidence.
    """
    if not isinstance(payload, str):
        return None
    cleaned, count = sanitize_injection_tags(payload)
    if not count:
        return None
    return HookOutcome.sanitize(
        cleaned,
        redactions=count,
        label=f"anti-injection:{count}",
    )


# --------------------------------------------------------------------------- #
# Destructive command guard                                                   #
# --------------------------------------------------------------------------- #

#: Shell shapes that are catastrophic and effectively never intended. These are
#: vetoed outright rather than escalated to a confirmation — a user clicking
#: "同意" on `rm -rf /` is not informed consent.
_CATASTROPHIC = (
    (re.compile(r"\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|"
                r"\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*f[a-zA-Z]*[rR]"),
     "递归强制删除"),
    (re.compile(r"(?i)\b(?:format|mkfs(?:\.\w+)?)\b\s+(?:/dev/|[a-zA-Z]:)"), "格式化磁盘"),
    (re.compile(r"(?i)\bdd\s+.*\bof=/dev/"), "裸写块设备"),
    (re.compile(r"(?i)\bRemove-Item\b.*-Recurse.*-Force"), "递归强制删除"),
    (re.compile(r"(?i):\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:"), "fork 炸弹"),
    (re.compile(r"(?i)\bchmod\s+(-R\s+)?777\s+/\s*$"), "根目录权限放开"),
    (re.compile(r"(?i)\b(?:drop\s+database|truncate\s+table)\b"), "删库/清表"),
)

#: Filesystem roots that must never be the target of a recursive delete.
_ROOT_TARGETS = re.compile(
    r"(?:\s|^)(?:/|/\*|~|~/|~/\*|/home/?\*?|/usr/?\*?|/etc/?\*?|/var/?\*?|"
    r"[A-Za-z]:\\?\*?|[A-Za-z]:\\\*)(?:\s|$)"
)


def destructive_command_hook(tool_name: str, payload: Any, context: dict) -> Optional[HookOutcome]:
    """PRE hook: veto catastrophic shell commands before they ever run.

    Two-layer defence:
    1. Legacy ``_CATASTROPHIC`` table — fast POSIX regex only, kept for backward
       compat and zero-import-cost detection of the most obvious patterns.
    2. ``danger_classifier`` — cross-interpreter (Python/JS/SQL/PowerShell/CMD)
       pattern tables + denial cache. Runs when layer-1 didn't fire.
    """
    if tool_name not in ("bash", "shell_executor", "python_executor",
                         "native_action_chain", "node_executor", "sql_executor"):
        return None
    args = payload if isinstance(payload, dict) else {}
    cmd = str(args.get("command") or args.get("cmd") or args.get("code") or "")
    if not cmd:
        return None

    # ── Layer 1: legacy quick table (kept intact) ──
    for pattern, what in _CATASTROPHIC:
        if pattern.search(cmd):
            # A recursive delete scoped inside the workspace is normal work;
            # only veto when it reaches a filesystem root or home directory.
            if what == "递归强制删除" and not _ROOT_TARGETS.search(cmd):
                continue
            return HookOutcome.veto(
                f"这条命令属于「{what}」，我不会执行——它的破坏是不可逆的，"
                "确认弹窗也兜不住。要做类似的事，请把目标缩小到具体路径再说一次。",
                label=f"destructive:{what}",
            )

    # ── Layer 2: cross-interpreter classifier + denial cache ──
    cache = get_denial_cache()
    key_text = payload_of(tool_name, args)

    # 命中缓存 → 直接返回上次的理由，省掉重复弹窗
    cached = cache.check(tool_name, key_text)
    if cached is not None:
        return HookOutcome.veto(
            f"已拒绝过相同请求（{cached.what}）。同一命令不会重试，请换一种做法。",
            label=f"denial-cache:{cached.pattern}",
        )

    verdict = classify_tool_call(tool_name, args)
    if verdict.blocked:
        cache.remember(tool_name, key_text, verdict)
        return HookOutcome.veto(
            f"这条命令属于「{verdict.what}」（{verdict.interpreter}），"
            f"我不会执行——破坏不可逆。缩小目标范围或换一种方式。",
            label=f"danger-classify:{verdict.pattern}",
        )
    # confirm 级别：返回 None 让 risk_control 走正常确认流程（tool_hooks 层
    # 只管 deny；confirm 交给已有的 RiskController）。
    return None


def write_content_guard_hook(tool_name: str, payload: Any, context: dict) -> Optional[HookOutcome]:
    """PRE hook: 按写入目标 + 写入内容判定是否放行。

    补的是一个真实缺口：``shell_executor`` 里的 ``rm -rf /`` 会被拦，但
    ``write_file`` 写一个内容就是 ``rm -rf /`` 的 ``.sh``、再 chmod 执行，
    整条链路上没有任何一环看过那段内容。写入本身可逆（有快照），但**写入
    脚本 + 之后执行**这条组合不是——所以在写的时候就把 deny 级内容拦住。

    只 veto deny 档。confirm 档（写 .ps1、写 /etc/、内容里有 shell=True）
    交给 RiskController 的确认流程，这里不重复打扰。
    """
    if tool_name not in ("write_file", "edit_file"):
        return None
    args = payload if isinstance(payload, dict) else {}

    cache = get_denial_cache()
    key_text = payload_of(tool_name, args)
    cached = cache.check(tool_name, key_text)
    if cached is not None and cached.level == DENY:
        return HookOutcome.veto(
            f"已拒绝过相同写入（{cached.what}）。同一内容不会重试，请换一种做法。",
            label=f"denial-cache:{cached.pattern}",
        )

    verdict = classify_tool_call(tool_name, args)
    if verdict.blocked:
        cache.remember(tool_name, key_text, verdict)
        return HookOutcome.veto(
            f"这次写入的内容属于「{verdict.what}」，我不会落盘——"
            f"写下来再执行和直接执行是同一件事。请改掉这段内容再来。",
            label=f"write-guard:{verdict.pattern}",
        )
    return None


def full_scope_delivery_hook(tool_name: str, payload: Any, context: dict) -> Optional[HookOutcome]:
    """PRE hook: 物理全量交付门禁 (Phase 61 核心硬内化)。

    检测代码写入参数中是否含有偷懒占位符 (如 // TODO: implement later, /* rest of code */)。
    若命中，物理拦截并拒绝落盘，要求提供 100% 完整代码。
    """
    if tool_name not in ("write_file", "edit_file", "write_to_file", "replace_file_content"):
        return None
    args = payload if isinstance(payload, dict) else {}

    code_snippets = [
        args.get("CodeContent", ""),
        args.get("ReplacementContent", ""),
        args.get("content", ""),
        args.get("code", ""),
    ]

    try:
        from output_guard import FullScopeDeliveryGuard
        for snippet in code_snippets:
            if snippet and isinstance(snippet, str):
                has_lazy, matched = FullScopeDeliveryGuard.inspect_code(snippet)
                if has_lazy:
                    return HookOutcome.veto(
                        f"代码中检测到偷工减料占位符「{matched}」。"
                        f"本系统强制执行全量交付（Full-Scope Delivery）质量门禁，严禁提交半成品代码，请提供 100% 完整可运行的代码！",
                        label=f"full-scope-guard:{matched}",
                    )
    except Exception:
        pass
    return None


def secret_leak_guard_hook(tool_name: str, payload: Any, context: dict) -> Optional[HookOutcome]:
    """PRE hook: 密钥泄漏防护闸门 (P3-1)。

    1. git push 拦截：扫描 git diff --cached，发现高置信凭据即刻否决并输出可读报告。
    2. 写入类工具拦截：PEM 私钥块与高置信凭据一律强制 veto 阻止落盘。
    """
    args = payload if isinstance(payload, dict) else {}

    # 1. 检查 git push
    is_git_push = False
    if tool_name == "git_push":
        is_git_push = True
    elif tool_name in ("run_command", "shell_executor", "terminal", "bash", "shell", "exec"):
        cmd = str(args.get("command") or args.get("cmd") or args.get("CommandLine") or "")
        if re.search(r"\bgit\s+(?:-[^\s]+\s+)*push\b", cmd):
            is_git_push = True

    if is_git_push:
        try:
            import subprocess
            from secret_scan import scan_text, generate_leak_report
            cwd = context.get("cwd") or args.get("Cwd") or os.getcwd()
            proc = subprocess.run(
                ["git", "diff", "--cached"],
                cwd=str(cwd), capture_output=True, text=True,
                encoding="utf-8", errors="replace", timeout=10,
            )
            cached_diff = proc.stdout or ""
            if cached_diff:
                matches = scan_text(cached_diff)
                high_matches = [m for m in matches if m.confidence == "high"]
                if high_matches:
                    report = generate_leak_report(high_matches)
                    return HookOutcome.veto(
                        f"检测到待推送的代码（git diff --cached）中包含高危私钥或凭据泄漏风险：\n{report}\n"
                        f"已被安全闸门物理拦截！请撤销提交或清理敏感信息后再试。",
                        label="secret-leak-guard:git-push",
                    )
        except Exception:
            pass

    # 2. 检查写入类工具
    if tool_name in ("write_file", "edit_file", "write_to_file", "replace_file_content"):
        code_snippets = [
            args.get("CodeContent", ""),
            args.get("ReplacementContent", ""),
            args.get("content", ""),
            args.get("new_string", ""),
            args.get("code", ""),
        ]
        try:
            from secret_scan import scan_text
            for snippet in code_snippets:
                if snippet and isinstance(snippet, str):
                    matches = scan_text(snippet)
                    high_matches = [m for m in matches if m.confidence == "high" or m.is_pem]
                    if high_matches:
                        top = high_matches[0]
                        return HookOutcome.veto(
                            f"写入内容检测到高风险私钥/凭据（{top.rule_name}），已强制拦截阻止落盘！\n"
                            f"详情: {top.reason} (行号: {top.line_number})",
                            label=f"secret-leak-guard:{top.rule_name}",
                        )
        except Exception:
            pass

    return None


# --------------------------------------------------------------------------- #
# Registry                                                                    #
# --------------------------------------------------------------------------- #

class ToolHookRegistry:
    """Declarative registry of pre / post / abort hooks keyed by tool pattern.

    Hooks are matched with :func:`fnmatch.fnmatch` so ``"*"`` covers every tool
    and ``"git_*"`` covers a family. Within a stage, higher priority runs first.
    A hook that raises is logged into the trail and skipped — a broken hook must
    never take down a tool call.
    """

    def __init__(self, install_builtins: bool = True) -> None:
        self._hooks: dict[HookStage, list[_Registration]] = {
            HookStage.PRE: [], HookStage.POST: [], HookStage.ABORT: [],
        }
        if install_builtins:
            self.register(HookStage.POST, "*", secret_redaction_hook,
                          label="secret-redaction", priority=100)
            # Anti-injection runs at lower priority than redaction so secrets
            # are scrubbed first; both are independent single-pass rewrites.
            self.register(HookStage.POST, "*", anti_injection_hook,
                          label="anti-injection", priority=90)
            self.register(HookStage.PRE, "*", destructive_command_hook,
                          label="destructive-guard", priority=100)
            # P3-1: Secret leak guard runs at high priority before writes and git pushes
            self.register(HookStage.PRE, "*", secret_leak_guard_hook,
                          label="secret-leak-guard", priority=98)
            # Write-content guard runs alongside; matches only write_file/edit_file
            # internally so the "*" pattern is cheap for other tools.
            self.register(HookStage.PRE, "*", write_content_guard_hook,
                          label="write-content-guard", priority=95)
            # Full-scope delivery gate: blocks lazy TODO and unfinished placeholders
            self.register(HookStage.PRE, "*", full_scope_delivery_hook,
                          label="full-scope-guard", priority=92)


    def register(self, stage: HookStage | str, pattern: str, fn: HookFn,
                 label: str = "", priority: int = 0) -> None:
        """Attach a hook to a stage for tools matching ``pattern``."""
        stage = HookStage(stage)
        self._hooks[stage].append(
            _Registration(pattern=pattern, fn=fn, label=label or getattr(fn, "__name__", "hook"),
                          priority=priority)
        )
        self._hooks[stage].sort(key=lambda r: -r.priority)

    def unregister(self, stage: HookStage | str, fn: HookFn) -> None:
        stage = HookStage(stage)
        self._hooks[stage] = [r for r in self._hooks[stage] if r.fn is not fn]

    def clear(self, stage: Optional[HookStage | str] = None) -> None:
        if stage is None:
            for key in self._hooks:
                self._hooks[key] = []
        else:
            self._hooks[HookStage(stage)] = []

    def _matching(self, stage: HookStage, tool_name: str) -> list[_Registration]:
        return [r for r in self._hooks[stage] if fnmatch.fnmatch(tool_name, r.pattern)]

    def run_pre(self, tool_name: str, args: dict, context: dict) -> dict:
        """Run PRE hooks.

        Returns:
            ``{"blocked": bool, "reason": str, "args": dict, "trail": list}`` —
            ``args`` is the possibly-rewritten argument dict to dispatch with.
        """
        current = args
        trail: list[dict] = []
        for reg in self._matching(HookStage.PRE, tool_name):
            outcome = self._safe_call(reg, tool_name, current, context, trail)
            if outcome is None:
                continue
            trail.append({"stage": "pre", "label": outcome.label or reg.label,
                          "blocked": outcome.blocked, "reason": outcome.reason})
            if outcome.blocked:
                return {"blocked": True, "reason": outcome.reason,
                        "args": current, "trail": trail}
            if outcome.replace_args is not None:
                current = outcome.replace_args
        return {"blocked": False, "reason": "", "args": current, "trail": trail}

    def run_post(self, tool_name: str, content: str, context: dict) -> dict:
        """Run POST hooks on the result text before it enters the context.

        Returns:
            ``{"content": str, "redactions": int, "trail": list}``.
        """
        current = content
        redactions = 0
        trail: list[dict] = []
        for reg in self._matching(HookStage.POST, tool_name):
            outcome = self._safe_call(reg, tool_name, current, context, trail)
            if outcome is None:
                continue
            trail.append({"stage": "post", "label": outcome.label or reg.label,
                          "redactions": outcome.redactions})
            if outcome.replace_content is not None:
                current = outcome.replace_content
            redactions += outcome.redactions
        return {"content": current, "redactions": redactions, "trail": trail}

    def run_abort(self, tool_name: str, args: dict, context: dict) -> dict:
        """Run ABORT hooks when a call is cancelled mid-flight.

        Returns:
            ``{"notes": list[str], "trail": list}`` — notes are recovery hints
            worth putting in the transcript so the next turn knows what state
            the interrupted tool left behind.
        """
        notes: list[str] = []
        trail: list[dict] = []
        for reg in self._matching(HookStage.ABORT, tool_name):
            outcome = self._safe_call(reg, tool_name, args, context, trail)
            if outcome is None:
                continue
            trail.append({"stage": "abort", "label": outcome.label or reg.label,
                          "reason": outcome.reason})
            if outcome.reason:
                notes.append(outcome.reason)
        return {"notes": notes, "trail": trail}

    def _safe_call(self, reg: _Registration, tool_name: str, payload: Any,
                   context: dict, trail: list[dict]) -> Optional[HookOutcome]:
        """Call a hook, converting any exception into a logged skip."""
        try:
            return reg.fn(tool_name, payload, context)
        except Exception as exc:
            trail.append({"stage": "error", "label": reg.label, "reason": str(exc)})
            return None

    def describe(self) -> dict:
        """Export the registry for the settings UI / audit view."""
        return {
            stage.value: [
                {"pattern": r.pattern, "label": r.label, "priority": r.priority}
                for r in regs
            ]
            for stage, regs in self._hooks.items()
        }


# Global registry singleton
_registry: Optional[ToolHookRegistry] = None


def get_tool_hooks() -> ToolHookRegistry:
    """Get the process-wide hook registry (built-ins installed on first use)."""
    global _registry
    if _registry is None:
        _registry = ToolHookRegistry()
    return _registry


def reset_tool_hooks() -> ToolHookRegistry:
    """Rebuild the registry from scratch (tests)."""
    global _registry
    _registry = ToolHookRegistry()
    return _registry
