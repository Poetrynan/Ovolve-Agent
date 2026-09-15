"""run_shell goes through path policy then the OS spawn gate."""
from __future__ import annotations

import os

from executors import run_shell


def test_run_shell_blocks_outside_write_without_confirm(tmp_path):
    outside = os.path.join(os.path.expanduser("~"), "ovolve-should-not-write.txt")
    r = run_shell(
        f'echo pwned > "{outside}"',
        confirm=False,
        cwd=str(tmp_path),
        workspace_root=str(tmp_path),
    )
    assert not r.ok
    assert "Refused" in (r.error or "")


def test_run_shell_workspace_write_runs(tmp_path):
    dest = tmp_path / "ok.txt"
    # PowerShell-friendly: cmd.exe `echo` quoting is what shell=True uses.
    r = run_shell(
        f'echo confined> "{dest}"',
        confirm=True,
        cwd=str(tmp_path),
        workspace_root=str(tmp_path),
        timeout=20,
    )
    assert r.ok, r.error
    assert dest.is_file()
