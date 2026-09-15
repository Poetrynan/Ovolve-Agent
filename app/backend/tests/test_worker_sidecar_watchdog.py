"""test_worker_sidecar_watchdog.py — 测试 sidecar parent_pid 自杀守护与存活探测。"""

import os
import sys
import time
import subprocess
import pytest

from app.backend.worker_sidecar import is_parent_alive, start_parent_death_watchdog


def test_is_parent_alive_current_process():
    # 当前进程肯定存活
    my_pid = os.getpid()
    assert is_parent_alive(my_pid) is True


def test_is_parent_alive_dead_process():
    # 使用一个几乎不可能存在的超大 PID
    dead_pid = 99999999
    assert is_parent_alive(dead_pid) is False


def test_is_parent_alive_after_child_exit():
    # 启动一个短暂子进程并等待其退出
    proc = subprocess.Popen([sys.executable, "-c", "import sys; sys.exit(0)"])
    proc.wait(timeout=5.0)
    # 子进程已死，探测应返回 False
    assert is_parent_alive(proc.pid) is False


def test_sidecar_watchdog_suicide_on_parent_death():
    """测试当父进程死亡时，sidecar 子进程在 2 秒内自杀退出。"""
    # 启动一个模拟的父进程，父进程启动一个 sidecar 进程后立即退出
    cwd_path = os.path.abspath(os.getcwd())
    parent_script = f"""
import os, sys, time, subprocess
sidecar_code = '''
import os, sys, time
from app.backend.worker_sidecar import start_parent_death_watchdog
ppid = int(sys.argv[1])
start_parent_death_watchdog(parent_pid=ppid, interval_s=0.2)
while True:
    time.sleep(0.1)
'''
parent_pid = os.getpid()
env = os.environ.copy()
env['PYTHONPATH'] = r'{cwd_path}'
sidecar = subprocess.Popen(
    [sys.executable, "-c", sidecar_code, str(parent_pid)],
    cwd=r'{cwd_path}',
    env=env,
)
# 输出 sidecar 的 PID
print(f"SIDECAR_PID:{{sidecar.pid}}", flush=True)
# 父进程休眠 0.3 秒后正常退出
time.sleep(0.3)
sys.exit(0)
"""
    # 运行父进程并抓取 sidecar PID
    env = os.environ.copy()
    env["PYTHONPATH"] = cwd_path
    p = subprocess.Popen(
        [sys.executable, "-c", parent_script],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=cwd_path,
        env=env,
    )
    stdout, stderr = p.communicate(timeout=5.0)
    sidecar_pid = None
    for line in stdout.splitlines():
        if "SIDECAR_PID:" in line:
            sidecar_pid = int(line.split("SIDECAR_PID:")[1].strip())
            break

    assert sidecar_pid is not None, f"Failed to get sidecar PID from output: {stdout}, stderr: {stderr}"

    # 等待最多 2.5 秒，确认 sidecar 已经随父进程自杀退出
    start_t = time.time()
    exited = False
    while time.time() - start_t < 2.5:
        if not is_parent_alive(sidecar_pid):
            exited = True
            break
        time.sleep(0.1)

    assert exited is True, f"Sidecar process {sidecar_pid} did not exit after parent death within 2.5s"
