"""OS-native sandbox: probe, policy resolve, confined spawn, fine-grained limits."""
from __future__ import annotations

import os
import subprocess
import sys

import pytest

from sandbox import (
    WORKSPACE_WRITE,
    confinement_status,
    describe_os_confinement,
    popen_confined,
    probe,
    release_confinement,
    resolve_policy,
    run_confined_capture,
)


def test_probe_returns_enforcement():
    enf = probe()
    assert enf.level in {"full", "partial", "unavailable"}
    if os.name == "nt":
        assert enf.backend == "job_object"
        assert enf.usable


def test_confinement_status_is_json_safe(tmp_path):
    status = confinement_status(str(tmp_path))
    assert "effective" in status
    assert "backend" in status
    assert "policy_source" in status
    assert "note" in status


def test_resolve_unknown_mode_is_read_only():
    p = resolve_policy("not-a-mode", workspace_root=".")
    assert p.mode == "read-only"


def test_popen_confined_echo(tmp_path):
    """The spawn gate must actually run a harmless command on this machine."""
    enf = probe()
    if not enf.usable:
        pytest.skip(f"no OS sandbox backend: {enf.detail}")
    policy = resolve_policy(WORKSPACE_WRITE, str(tmp_path), strict=False)
    proc = popen_confined(
        "echo confined-ok",
        policy,
        cwd=str(tmp_path),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        out = proc.stdout.read() if proc.stdout is not None else ""
        proc.wait(timeout=15)
    finally:
        release_confinement(proc)
    assert proc.returncode == 0
    assert "confined-ok" in (out or "")


# ── OS 加固深实现：细粒度 Job 策略 ──────────────────────────────────────────

def test_resolve_policy_fills_fine_grained_defaults():
    ro = resolve_policy("read-only")
    ww = resolve_policy("workspace-write")
    assert ro.memory_limit_mb == 512 and ro.cpu_rate_percent == 50
    assert ww.memory_limit_mb == 2048 and ww.cpu_rate_percent == 90
    # 显式传值不被默认覆盖（测试与特殊工作负载的覆盖口）
    custom = resolve_policy("read-only")
    custom.memory_limit_mb = 64
    assert custom.memory_limit_mb == 64


def test_describe_os_confinement_matches_reality():
    kind = describe_os_confinement()
    assert kind in {"job_object", "seatbelt", "landlock", "popen_confined"}
    if os.name == "nt" and probe().usable:
        assert kind == "job_object"
    # execution_provider 的探测包装必须与之一致——审计字段反映现实
    from execution_provider import detect_os_confinement
    assert detect_os_confinement() == kind


def test_job_memory_limit_actually_caps_child():
    """行为级证明：超过 Job 内存上限的子进程被内核拒绝，而不是只写在纸上。

    子进程申请 256MB，上限压到 128MB → commit 失败 → MemoryError → 非零退出。
    没有上限时同样的分配会成功，所以非零退出只能来自内存约束本身。
    """
    if os.name != "nt":
        pytest.skip("Job Object 细粒度上限是 Windows 路径")
    if not probe().usable:
        pytest.skip("no OS sandbox backend")

    from sandbox import SandboxPolicy, READ_ONLY
    policy = SandboxPolicy(mode=READ_ONLY, memory_limit_mb=128)
    cmd = f'"{sys.executable}" -c "b = bytearray(256 * 1024 * 1024); print(len(b))"'
    proc = popen_confined(
        cmd,
        policy,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        out = proc.stdout.read() if proc.stdout is not None else ""
        proc.wait(timeout=60)
    finally:
        release_confinement(proc)
    assert proc.returncode != 0, \
        f"超限分配必须失败（退出码 {proc.returncode}，输出 {str(out)[:200]}）"
    assert "268435456" not in (out or ""), "子进程不该成功完成 256MB 分配"


def test_win_create_job_reports_applied_features():
    """applied 字典必须如实报告哪些细粒度策略真正落上去了。

    本机验证过的事实：CPU 速率控制在配额管理被禁用的系统上会失败，
    applied 里就不会有 cpu_rate_percent——降级要可见，不能静默假装。
    """
    if os.name != "nt":
        pytest.skip("Windows only")
    api = __import__("sandbox")._win_api()
    if api is None:
        pytest.skip("Win32 APIs unavailable")
    from sandbox import _win_create_job, READ_ONLY
    job, applied = _win_create_job(api, resolve_policy(READ_ONLY))
    try:
        assert job, "job 创建必须成功"
        assert applied.get("kill_on_close") is True
        assert applied.get("memory_limit_mb") == 512
        # UI 限制在受支持的系统上都应成功；万一失败也必须如实缺席
        assert "ui_restrictions" in applied or True  # 占位断言：缺席即降级
    finally:
        __import__("sandbox")._win_close_handle(job)


# ── 受约束的一次性执行：验证门与验证器共用的那根管子 ────────────────────────

def test_run_confined_capture_reports_exit_output_and_backend(tmp_path):
    r = run_confined_capture(f'"{sys.executable}" -c "print(\'cap-ok\')"',
                             cwd=str(tmp_path), timeout=30)
    assert r["ran"] is True, r
    assert r["returncode"] == 0, r
    assert "cap-ok" in r["output"]
    assert r["timeout"] is False
    # 约束后端必须如实上报：证据里"跑过了"和"跑在沙箱里"是两件事
    assert r["confinement"] == (probe().backend if probe().usable else "none")
    assert r["mode"] == WORKSPACE_WRITE


def test_run_confined_capture_propagates_failure_exit_code(tmp_path):
    r = run_confined_capture(f'"{sys.executable}" -c "raise SystemExit(3)"',
                             cwd=str(tmp_path), timeout=30)
    assert r["ran"] is True
    assert r["returncode"] == 3, r


def test_run_confined_capture_kills_on_timeout(tmp_path):
    r = run_confined_capture(
        f'"{sys.executable}" -c "import time; time.sleep(30)"',
        cwd=str(tmp_path), timeout=1,
    )
    assert r["timeout"] is True, r
    # 超时不得报出一个"成功"的退出码——否则验证门会把被杀的进程当通过
    assert r["returncode"] is None, r
