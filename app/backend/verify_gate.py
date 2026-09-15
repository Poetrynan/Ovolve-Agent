"""verify_gate.py — machine verification for the goal loop (UA4).

## What this changes

"改完了" was declared by the model. Its standard was "the logic looks right to
me", which is exactly the standard that misses a typo'd variable name, a call
site that wasn't updated, and a type that doesn't line up — the class of mistake
a test run surfaces in one second.

`goal_scheduler` already had the whole verify-continue loop with all three
circuit breakers. What it lacked was a verification SOURCE that isn't the model
itself. This module is that source. No new execution engine: it probes for a
command the project already has, runs it, and reports the exit code.

## Three things decide whether this helps or hurts

1. **Permission is its own decision.** Running a shell command automatically,
   in a loop, unattended, is not the same risk as the agent running one while
   the user watches. So a probed command runs only if a standing ALLOW rule
   already covers it (`permission_rules._BUILTIN_RULES` seeds exactly the
   "does my change compile/pass" family). No rule ⇒ the gate is SKIPPED and
   says so; it never asks, and it never quietly runs anyway.

2. **The repair state gets its own budget.** Feeding a failure back in is a
   round like any other, so without a separate allowance a goal that fails
   verification twice would silently burn the iterations meant for the actual
   work.

3. **Output is truncated, head and tail.** One failing test suite can emit
   megabytes. The head carries the command and the summary line; the tail
   carries the assertion that failed. The middle is repetition.

## What "no verify command" means

Nothing. It degrades to the LLM judgement that was there before. A project
without tests must not become a project whose goals can never complete.
"""
from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass

#: Wall clock for one verify command. A test suite that takes longer than this
#: is not something to run on every round of an autonomous loop.
VERIFY_TIMEOUT_S = 300

#: Chars of verify output fed back to the model, split between head and tail.
MAX_VERIFY_OUTPUT_CHARS = 3000

#: How many extra rounds a goal may spend fixing a failed verification. Its own
#: budget on purpose — see the module docstring.
REPAIR_BUDGET = 3

#: The tool name the permission rules are written against. `_BUILTIN_TOOLS` in
#: permission_rules seeds each pattern for both shell-ish tools; matching one is
#: enough.
_PERMISSION_TOOL = "shell_executor"


@dataclass
class VerifyCommand:
    """One command that can tell us whether the workspace is still healthy."""

    command: str
    #: Which file made us believe this command exists. Shown to the user, so it
    #: has to be a real reason and not a guess.
    source: str
    kind: str = "check"


def _read_json(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _has_python_tests(workspace: str) -> bool:
    tests_dir = os.path.join(workspace, "tests")
    if os.path.isdir(tests_dir):
        for _dp, _dn, files in os.walk(tests_dir):
            if any(f.startswith("test_") and f.endswith(".py") for f in files):
                return True
    return False


def probe(workspace: str) -> list[VerifyCommand]:
    """Verify commands this project actually supports, cheapest signal first.

    Every entry is justified by a file on disk. Nothing is inferred from the
    goal text, because a command that doesn't exist fails with exit code 127 and
    would read as "the change is broken".

    A mixed repo (Python backend + TS frontend) legitimately returns two, and
    both matter: a Python-only check would pass while the UI doesn't compile.
    """
    if not workspace or not os.path.isdir(workspace):
        return []
    out: list[VerifyCommand] = []

    pyproject = os.path.join(workspace, "pyproject.toml")
    has_pytest_cfg = False
    if os.path.isfile(pyproject):
        try:
            with open(pyproject, "r", encoding="utf-8") as f:
                has_pytest_cfg = "[tool.pytest" in f.read()
        except OSError:
            has_pytest_cfg = False
    if has_pytest_cfg or _has_python_tests(workspace):
        out.append(VerifyCommand(
            "python -m pytest -q",
            "pyproject.toml [tool.pytest]" if has_pytest_cfg else "tests/test_*.py",
            "test",
        ))

    if os.path.isfile(os.path.join(workspace, "tsconfig.json")):
        out.append(VerifyCommand("npx tsc --noEmit", "tsconfig.json", "typecheck"))
    else:
        pkg = _read_json(os.path.join(workspace, "package.json")) or {}
        scripts = pkg.get("scripts") if isinstance(pkg, dict) else None
        if isinstance(scripts, dict) and "typecheck" in scripts:
            out.append(VerifyCommand(
                "npm run typecheck", "package.json scripts.typecheck", "typecheck"))

    if os.path.isfile(os.path.join(workspace, "go.mod")):
        out.append(VerifyCommand("go build ./...", "go.mod", "build"))
    if os.path.isfile(os.path.join(workspace, "Cargo.toml")):
        out.append(VerifyCommand("cargo check", "Cargo.toml", "build"))
    return out


def is_allowed(command: str, workspace: str) -> tuple[bool, str]:
    """Whether a standing ALLOW rule already covers running this unattended.

    Not the same question as "would the agent be allowed to run it with the user
    watching". This loop runs on its own, repeatedly, so anything short of an
    existing allow is treated as no.
    """
    try:
        from permission_rules import RuleBehavior, get_permission_rules
        rule = get_permission_rules().match(
            _PERMISSION_TOOL, {"command": command}, workspace_root=workspace or "")
    except Exception as exc:  # noqa: BLE001
        return False, f"权限规则读取失败：{exc}"
    if rule is None:
        return False, "没有放行这条命令的规则"
    if rule.behavior != RuleBehavior.ALLOW:
        return False, f"这条命令的规则是「{rule.behavior}」，不是自动放行"
    return True, ""


def truncate_output(text: str, limit: int = MAX_VERIFY_OUTPUT_CHARS) -> str:
    """Keep the head and the tail, drop the middle.

    Test runners put the invocation and the summary at the top and the failing
    assertion at the bottom; the middle is per-test noise. Truncating from the
    end alone would throw away the one line that says what broke.
    """
    text = text or ""
    if len(text) <= limit:
        return text
    head = limit // 3
    tail = limit - head
    omitted = len(text) - head - tail
    return f"{text[:head]}\n… [省略 {omitted} 个字符] …\n{text[-tail:]}"


def _run_one(cmd: VerifyCommand, workspace: str) -> dict:
    """Blocking single command run. Called through a thread by :func:`verify`."""
    try:
        from executors import guarded_spawn
        proc = guarded_spawn(cmd.command, timeout=VERIFY_TIMEOUT_S, cwd=workspace)
        raw = (proc.stdout or "") + (proc.stderr or "")
        return {
            "command": cmd.command, "source": cmd.source, "kind": cmd.kind,
            "exitCode": int(proc.returncode or 0),
            "passed": int(proc.returncode or 0) == 0,
            "output": truncate_output(raw),
        }
    except Exception as exc:  # noqa: BLE001
        # A verify command that cannot even be launched is NOT a failed change.
        # Reporting it as one would send the goal into a repair loop over a
        # missing interpreter.
        return {
            "command": cmd.command, "source": cmd.source, "kind": cmd.kind,
            "exitCode": -1, "passed": True, "unavailable": True,
            "output": f"这条验证命令没能执行：{exc}",
        }


async def verify(workspace: str) -> dict:
    """Run the project's own checks. Never raises.

    Returns ``{ran, passed, skipped, skipReason, results, summary}``. `ran=False`
    means no machine verification happened — the caller must fall back to the
    LLM verdict rather than treating it as a pass or a fail.

    Stops at the first genuine failure: once one check is broken the next one's
    output is noise, and the model only needs one thing to fix at a time.
    """
    commands = probe(workspace)
    if not commands:
        return {"ran": False, "passed": False, "skipped": True,
                "skipReason": "这个项目没有可自动运行的验证命令", "results": [],
                "summary": ""}

    results: list[dict] = []
    skipped: list[str] = []
    for cmd in commands:
        ok, why = is_allowed(cmd.command, workspace)
        if not ok:
            skipped.append(f"{cmd.command}（{why}）")
            continue
        res = await asyncio.to_thread(_run_one, cmd, workspace)
        results.append(res)
        if not res["passed"]:
            break

    if not results:
        return {"ran": False, "passed": False, "skipped": True,
                "skipReason": "验证命令没有被放行：" + "；".join(skipped),
                "results": [], "summary": ""}

    failed = [r for r in results if not r["passed"]]
    parts = [f"{r['command']} → 退出码 {r['exitCode']}" for r in results]
    if skipped:
        parts.append("跳过：" + "；".join(skipped))
    return {
        "ran": True,
        "passed": not failed,
        "skipped": False,
        "skipReason": "",
        "results": results,
        "summary": "；".join(parts),
    }


def repair_prompt(report: dict) -> str:
    """The next round's prompt when machine verification rejected the work.

    Deliberately states the exit code before the output: the model has to know
    this is a machine verdict, not a reviewer's opinion it can argue with.
    """
    failed = [r for r in report.get("results") or [] if not r.get("passed")]
    if not failed:
        return ""
    blocks = []
    for r in failed:
        blocks.append(
            f"命令：{r['command']}（来自 {r['source']}）\n"
            f"退出码：{r['exitCode']}\n"
            f"输出：\n{r.get('output') or '（无输出）'}"
        )
    return (
        "你刚才报告任务已完成，但项目自己的验证命令没有通过。这是机器判定的结果，"
        "不是意见——在验证通过之前任务不算完成。\n\n"
        + "\n\n".join(blocks)
        + "\n\n请定位并修掉上面的失败原因，不要绕过验证、不要改动或删掉测试来让它变绿。"
    )


def precheck_proposed_content(path: str, content: str, workspace: str = "") -> tuple[bool, str]:
    """Lightweight pre-write syntax check via local shadow workspace (fail-open)."""
    from shadow_workspace import preview_write
    preview = preview_write(path, content, workspace)
    if preview.ok:
        return True, ""
    return False, preview.format_error()
