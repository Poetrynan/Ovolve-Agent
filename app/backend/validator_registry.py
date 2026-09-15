"""
validator_registry.py — 可插拔但受统一 policy 管理的验证器注册表（Phase 3）。

总指令 §8.2：LLM verification 可以解释失败，但不能替代 machine verification。
本模块把"完成"的证据来源抽象为可声明的验证计划：

    {"type": "file",   "path": "dist/app.js", "must_exist": true}
    {"type": "command","command": "pytest -q", "timeout_s": 120}
    {"type": "git",    "checks": ["clean"]}
    {"type": "schema", "file": "pkg.json", "required_keys": ["name", "version"]}
    {"type": "human"}  ← 只记录待人工确认，绝不伪装成自动证据

每个验证器返回 §8.2 的统一结构；任何一条 failed/error 都让"未满足"成立。
路径安全：所有文件路径必须落在 workspace 内（realpath 包含检查），逃逸即失败——
验证器自己就是被验证的对象，不能成为绕过 path policy 的通道。
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import time
from typing import Any, Dict, List


def _result(validator_id: str, status: str, evidence: List[str] = None,
            duration_ms: float = 0, error_class: str | None = None,
            retryable: bool = False) -> Dict[str, Any]:
    return {
        "validator_id": validator_id,
        "status": status,          # passed|failed|error|timeout|skipped
        "evidence": evidence or [],
        "observed_at": time.time(),
        "duration_ms": round(duration_ms, 1),
        "error_class": error_class,
        "retryable": retryable,
    }


def _contained(workspace: str, rel: str) -> str | None:
    """把相对路径解析成 workspace 内的绝对路径；逃逸返回 None。"""
    if not workspace or not rel:
        return None
    base = os.path.realpath(workspace)
    target = os.path.realpath(os.path.join(base, rel))
    if target != base and not target.startswith(base + os.sep):
        return None
    return target


# ── 各验证器 ────────────────────────────────────────────────────────────────

def file_validator(spec: dict, workspace: str) -> Dict[str, Any]:
    vid = f"file.{spec.get('path', '?')}"
    t0 = time.time()
    path = _contained(workspace, str(spec.get("path") or ""))
    if path is None:
        return _result(vid, "error", [f"path escapes workspace: {spec.get('path')}"],
                       error_class="policy")
    if not os.path.isfile(path):
        ok = not bool(spec.get("must_exist", True))
        return _result(vid, "passed" if ok else "failed",
                       [f"{spec.get('path')} absent"], time.time() - t0)
    evidence = [f"{spec.get('path')} exists"]
    content = ""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            content = fh.read()
    except OSError as e:
        return _result(vid, "error", [str(e)], time.time() - t0,
                       error_class="io", retryable=True)
    contains = spec.get("contains")
    if contains and str(contains) not in content:
        return _result(vid, "failed", evidence + ["contains-miss"],
                       time.time() - t0)
    pattern = spec.get("matches")
    if pattern and not re.search(str(pattern), content):
        return _result(vid, "failed", evidence + ["regex-miss"],
                       time.time() - t0)
    want_hash = spec.get("sha256")
    if want_hash:
        got = hashlib.sha256(content.encode("utf-8")).hexdigest()
        if got != str(want_hash):
            return _result(vid, "failed",
                           evidence + [f"hash {got[:12]}≠{str(want_hash)[:12]}"],
                           time.time() - t0)
        evidence.append(f"sha256={got[:12]}")
    return _result(vid, "passed", evidence, time.time() - t0)


def command_validator(spec: dict, workspace: str) -> Dict[str, Any]:
    from verify_gate import is_allowed
    cmd = str(spec.get("command") or "").strip()
    vid = f"command.{cmd[:40]}"
    t0 = time.time()
    if not cmd:
        return _result(vid, "error", ["empty command"], error_class="config")
    allowed, why = is_allowed(cmd, workspace or ".")
    if not allowed:
        return _result(vid, "error", [f"policy denied: {why}"],
                       error_class="policy")
    timeout_s = min(float(spec.get("timeout_s") or 60), 300)
    expect = int(spec.get("expect_exit", 0))
    # 统一走受约束执行。以前这里是 subprocess.run(..., shell=True)：验证器
    # 规格里的命令字符串直接交给 shell，以后端全部权限跑。验证器是"证明目标
    # 达成"的那一步，它自己反而是最没有约束的一步——这个反差就是要修的东西。
    from sandbox import run_confined_capture
    res = run_confined_capture(cmd, cwd=workspace or ".", timeout=timeout_s)
    if not res.get("ran"):
        return _result(vid, "error", [str(res.get("error") or "cannot start")],
                       time.time() - t0, error_class="io", retryable=True)
    if res.get("timeout"):
        return _result(vid, "timeout", [f">{timeout_s}s"], timeout_s,
                       error_class="timeout", retryable=True)
    rc = res.get("returncode")
    ok = rc == expect
    # 约束后端写进证据：一条"通过"如果是在无约束环境里跑出来的，和在沙箱里
    # 跑出来的不是同一个事实，读证据的人必须能分辨。
    ev = [f"exit={rc} (expect {expect})",
          f"confinement={res.get('confinement')}"]
    tail = str(res.get("output") or "")[-200:].strip()
    if tail:
        ev.append("out: " + tail)
    return _result(vid, "passed" if ok else "failed", ev,
                   time.time() - t0, retryable=not ok)


def git_validator(spec: dict, workspace: str) -> Dict[str, Any]:
    vid = "git.checks"
    t0 = time.time()
    checks = spec.get("checks") or []
    evidence: List[str] = []

    def _git(*args: str) -> str:
        # Killable like every other child: a validator running against a huge
        # repo must stop when the user stops the goal.
        from executors import tracked_run
        return tracked_run(
            ["git", *args], cwd=workspace or ".", timeout=30,
            capture_output=True, text=True, errors="replace",
        ).stdout.strip()

    for c in checks:
        c = str(c)
        if c == "clean":
            dirty = _git("status", "--porcelain")
            if dirty:
                return _result(vid, "failed", evidence + [f"dirty: {dirty[:120]}"],
                               time.time() - t0)
            evidence.append("worktree clean")
        elif c.startswith("branch:"):
            want = c.split(":", 1)[1]
            cur = _git("rev-parse", "--abbrev-ref", "HEAD")
            if cur != want:
                return _result(vid, "failed",
                               evidence + [f"branch {cur}≠{want}"], time.time() - t0)
            evidence.append(f"branch={cur}")
        else:
            return _result(vid, "error", [f"unknown git check: {c}"],
                           error_class="config")
    return _result(vid, "passed", evidence or ["no checks configured"],
                   time.time() - t0)


def schema_validator(spec: dict, workspace: str) -> Dict[str, Any]:
    vid = f"schema.{spec.get('file', '?')}"
    t0 = time.time()
    path = _contained(workspace, str(spec.get("file") or ""))
    if path is None or not os.path.isfile(path):
        return _result(vid, "failed", [f"missing {spec.get('file')}"],
                       time.time() - t0)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        return _result(vid, "failed", [f"unparseable: {e}"], time.time() - t0)
    required = spec.get("required_keys") or []
    missing = [k for k in required
               if not isinstance(data, dict) or k not in data]
    if missing:
        return _result(vid, "failed", [f"missing keys: {missing}"],
                       time.time() - t0)
    return _result(vid, "passed", [f"keys ok: {required}"], time.time() - t0)


def human_validator(spec: dict, workspace: str) -> Dict[str, Any]:
    """人工确认不是自动证据：如实记 skipped，由 UI 的审批面单独呈现。"""
    return _result("human.confirmation", "skipped",
                   ["awaiting explicit user confirmation"])


# ── Factory AI 差分与行为衡具验证器 ──────────────────────────────────────────

DEFAULT_MASK_PATTERNS: tuple[tuple[re.Pattern, str], ...] = (
    # 内存堆栈指针 / 地址 (0x1234, 0x7ffeefbff5e0, 0x0000021c3b4a2b10)
    (re.compile(r"\b0x[0-9a-fA-F]{4,16}\b"), "<PTR>"),
    # ISO 8601 / RFC 3339 日期时间戳
    (re.compile(r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b"), "<TIMESTAMP>"),
    # 临时目录与平台特定随机临时文件
    (re.compile(r"(?:/tmp|/var/folders/[^\s]+|[A-Za-z]:\\[Tt]emp\\[^\s]+)"), "<TMP_PATH>"),
    # UUID / GUID 字符串
    (re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"), "<UUID>"),
)


def apply_differential_masking(text: str, custom_masks: list[str | dict] | None = None) -> str:
    """对输出文本应用掩码规则，消除非确定性噪声（指针、时间戳、临时路径）。"""
    if not text:
        return ""
    masked = text
    # 1. 默认平台噪声消除
    for pat, repl in DEFAULT_MASK_PATTERNS:
        masked = pat.sub(repl, masked)

    # 2. 自定义掩码规则支持
    for cm in (custom_masks or []):
        if isinstance(cm, str) and cm.strip():
            masked = re.sub(cm, "<CUSTOM_MASK>", masked)
        elif isinstance(cm, dict):
            p = cm.get("pattern")
            r = cm.get("replace", "<MASK>")
            if p:
                masked = re.sub(str(p), str(r), masked)

    # 3. 浮点数与多余空白归一化（保留行结构）
    lines = []
    for line in masked.splitlines():
        # 归一化浮点精度 (如 1.234000 -> 1.234)
        l_norm = re.sub(r"(\d+\.\d{3})\d+", r"\1", line)
        lines.append(l_norm.strip())
    return "\n".join(lines).strip()


def differential_validator(spec: dict, workspace: str) -> Dict[str, Any]:
    """Factory AI 掩码容差差分验证器 (Differential Validator)."""
    vid = f"diff.{spec.get('name') or spec.get('actual_file') or spec.get('command') or 'test'}"
    t0 = time.time()

    actual_content = ""
    # A. 若指定了 command，优先执行命令获取 stdout
    cmd = str(spec.get("command") or "").strip()
    if cmd:
        from verify_gate import is_allowed
        allowed, why = is_allowed(cmd, workspace or ".")
        if not allowed:
            return _result(vid, "error", [f"gate blocked command: {why}"],
                           error_class="policy")
        timeout_s = int(spec.get("timeout_s", 60))
        try:
            p = subprocess.run(
                cmd, shell=True, cwd=workspace,
                capture_output=True, text=True, timeout=timeout_s,
            )
            actual_content = p.stdout
            if p.returncode != 0 and not spec.get("allow_error"):
                return _result(vid, "failed",
                               [f"command exited with {p.returncode}",
                                f"stderr: {p.stderr[:300]}"],
                               time.time() - t0, error_class="command_failed")
        except subprocess.TimeoutExpired:
            return _result(vid, "timeout", [f"timeout after {timeout_s}s"],
                           time.time() - t0, error_class="timeout", retryable=True)
        except Exception as exc:
            return _result(vid, "error", [str(exc)], time.time() - t0,
                           error_class="exception")

    # B. 若指定了 actual_file，从文件中读取
    act_file = spec.get("actual_file")
    if act_file:
        path = _contained(workspace, str(act_file))
        if not path or not os.path.isfile(path):
            return _result(vid, "failed", [f"actual file missing: {act_file}"], time.time() - t0)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                actual_content = fh.read()
        except OSError as exc:
            return _result(vid, "error", [f"io error: {exc}"], time.time() - t0, error_class="io")

    # C. 获取预期基线 (expected 或 expected_file)
    expected_content = spec.get("expected")
    if expected_content is None and spec.get("expected_file"):
        exp_path = _contained(workspace, str(spec.get("expected_file")))
        if exp_path and os.path.isfile(exp_path):
            try:
                with open(exp_path, "r", encoding="utf-8", errors="replace") as fh:
                    expected_content = fh.read()
            except OSError as exc:
                return _result(vid, "error", [f"expected file io error: {exc}"], time.time() - t0, error_class="io")

    if expected_content is None:
        return _result(vid, "error", ["neither expected nor expected_file provided"], time.time() - t0, error_class="config")

    # D. 应用掩码差分对齐
    custom_masks = spec.get("masks")
    norm_actual = apply_differential_masking(str(actual_content), custom_masks)
    norm_expected = apply_differential_masking(str(expected_content), custom_masks)

    if norm_actual == norm_expected:
        return _result(vid, "passed", ["masked output strictly matches golden baseline"], time.time() - t0)

    # 提取首处不一致片段作为 evidence
    act_lines = norm_actual.splitlines()
    exp_lines = norm_expected.splitlines()
    diff_snippet = []
    for i in range(min(len(act_lines), len(exp_lines))):
        if act_lines[i] != exp_lines[i]:
            diff_snippet.append(f"Line {i+1} mismatch:\n  - act: {act_lines[i][:100]}\n  + exp: {exp_lines[i][:100]}")
            if len(diff_snippet) >= 3:
                break
    if len(act_lines) != len(exp_lines):
        diff_snippet.append(f"Line count diff: act={len(act_lines)} lines, exp={len(exp_lines)} lines")

    return _result(vid, "failed", diff_snippet or ["differential content mismatch"], time.time() - t0)


def instrument_validator(spec: dict, workspace: str) -> Dict[str, Any]:
    """综合行为衡具验证器：加权聚合运行一组用例，按阈值判定总体达标率。"""
    vid = f"instrument.{spec.get('name', 'suite')}"
    t0 = time.time()
    cases = spec.get("cases") or []
    if not cases:
        return _result(vid, "passed", ["no behavioral cases specified"], time.time() - t0)

    threshold = float(spec.get("threshold", 0.90))
    passed_weight = 0.0
    total_weight = 0.0
    failed_details = []

    for c in cases:
        weight = float(c.get("weight", 1.0))
        total_weight += weight
        res = differential_validator(c, workspace)
        if res.get("status") == "passed":
            passed_weight += weight
        else:
            failed_details.append(f"Case '{c.get('id', '?')}' failed: {res.get('evidence', [''])[0]}")

    score = passed_weight / total_weight if total_weight > 0 else 1.0
    status = "passed" if score >= (threshold - 1e-6) else "failed"
    evidence = [f"Behavioral score: {score:.2%} (threshold: {threshold:.2%}, passed: {passed_weight}/{total_weight})"]
    if failed_details:
        evidence.extend(failed_details[:5])

    return _result(vid, status, evidence, time.time() - t0)


_VALIDATORS = {
    "file": file_validator,
    "command": command_validator,
    "git": git_validator,
    "schema": schema_validator,
    "human": human_validator,
    "diff": differential_validator,
    "differential": differential_validator,
    "instrument": instrument_validator,
}


# ── 计划执行 ────────────────────────────────────────────────────────────────

def run_verification_plan(plan: list, workspace: str) -> tuple[list, bool]:
    """执行一份验证计划。返回 (结果列表, 是否全绿)。未知类型记 error，
    不静默跳过——没验证过的不能算通过。"""
    results = []
    for i, entry in enumerate(plan or []):
        vtype = str((entry or {}).get("type") or "").strip().lower()
        fn = _VALIDATORS.get(vtype)
        if fn is None:
            results.append(_result(
                f"plan[{i}]", "error",
                [f"unknown validator type: {vtype!r}"], error_class="config"))
            continue
        try:
            results.append(fn(entry, workspace))
        except Exception as e:  # noqa: BLE001
            results.append(_result(f"plan[{i}].{vtype}", "error",
                                    [repr(e)[:200]], error_class="exception"))
    all_ok = bool(results) and all(r["status"] == "passed" for r in results)
    return results, all_ok

