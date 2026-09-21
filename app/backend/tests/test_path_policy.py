"""Path-policy engine: YAML load, glob matching, command intents."""
from __future__ import annotations

import os
import textwrap

import pytest

from path_policy import (
    PathPolicyError,
    extract_intents,
    load_policy,
    load_simple_yaml,
)


def test_yaml_subset_nested_and_list():
    doc = load_simple_yaml(textwrap.dedent("""
        filesystem:
          workspace: rw
          .git: ro
          ~/.ssh: none
        network:
          default: allow
          block:
            - 169.254.169.254/32
            - 169.254.0.0/16
    """))
    assert doc["filesystem"]["workspace"] == "rw"
    assert doc["filesystem"][".git"] == "ro"
    assert doc["network"]["default"] == "allow"
    assert doc["network"]["block"] == ["169.254.169.254/32", "169.254.0.0/16"]


def test_windows_drive_key_splits_on_last_colon():
    doc = load_simple_yaml('filesystem:\n  C:/Windows: ro\n')
    assert doc["filesystem"]["C:/Windows"] == "ro"


def test_write_redirection_outside_workspace_denied(tmp_path):
    ws = str(tmp_path)
    policy = load_policy(ws)
    outside = os.path.join(os.path.expanduser("~"), "ovolve-policy-should-deny.txt")
    with pytest.raises(PathPolicyError):
        policy.assert_allowed(f'echo pwned > "{outside}"', cwd=ws)


def test_write_inside_workspace_allowed(tmp_path):
    ws = str(tmp_path)
    policy = load_policy(ws)
    policy.assert_allowed(f'echo ok > "{os.path.join(ws, "out.txt")}"', cwd=ws)


def test_guiding_file_write_denied(tmp_path):
    ws = str(tmp_path)
    policy = load_policy(ws)
    with pytest.raises(PathPolicyError, match="guiding file"):
        policy.assert_allowed(f'echo x > "{os.path.join(ws, "AGENTS.md")}"', cwd=ws)


def test_ssh_dir_is_none(tmp_path):
    ws = str(tmp_path)
    policy = load_policy(ws)
    ssh = os.path.join(os.path.expanduser("~"), ".ssh", "id_rsa")
    with pytest.raises(PathPolicyError, match="none"):
        policy.assert_allowed(f'type "{ssh}"', cwd=ws)


def test_metadata_ip_blocked(tmp_path):
    ws = str(tmp_path)
    policy = load_policy(ws)
    with pytest.raises(PathPolicyError, match="169.254"):
        policy.assert_allowed("curl http://169.254.169.254/latest/meta-data/", cwd=ws)


def test_git_log_is_read_not_write(tmp_path):
    ws = str(tmp_path)
    intents = extract_intents("git log src/main.py", cwd=ws)
    assert all(i.access == "read" for i in intents)


def test_git_add_is_write(tmp_path):
    ws = str(tmp_path)
    intents = extract_intents("git add src/main.py", cwd=ws)
    assert any(i.access == "write" for i in intents)


def test_workspace_yaml_overrides_git_to_ro(tmp_path):
    ws = tmp_path
    (ws / "sandbox-policy.yaml").write_text(
        "filesystem:\n  workspace: rw\n  .git: ro\n", encoding="utf-8",
    )
    policy = load_policy(str(ws))
    git_head = ws / ".git" / "HEAD"
    git_head.parent.mkdir()
    git_head.write_text("ref: refs/heads/main", encoding="utf-8")
    with pytest.raises(PathPolicyError, match="read-only"):
        policy.assert_allowed(f'echo x > "{git_head}"', cwd=str(ws))


def test_read_only_mode_blocks_workspace_write(tmp_path):
    ws = str(tmp_path)
    policy = load_policy(ws, mode="read-only")
    with pytest.raises(PathPolicyError):
        policy.assert_allowed(f'echo x > "{os.path.join(ws, "a.txt")}"', cwd=ws)


def test_echo_without_paths_is_allowed(tmp_path):
    load_policy(str(tmp_path)).assert_allowed("echo hello", cwd=str(tmp_path))


def test_quote_comparison_operators_not_treated_as_redirections(tmp_path):
    ws = str(tmp_path)
    policy = load_policy(ws)
    # Python code containing > must not be treated as writing to drive a: or m:
    policy.assert_allowed('python -c "if x > a: pass"', cwd=ws)
    policy.assert_allowed("python -c 'if x > m: pass'", cwd=ws)
    policy.assert_allowed('python -c "a = [x for x in range(10) if x > 0]"', cwd=ws)


def test_dev_null_redirection_allowed(tmp_path):
    ws = str(tmp_path)
    policy = load_policy(ws)
    policy.assert_allowed("python test.py 2> /dev/null", cwd=ws)


def test_root_tmp_scratch_paths_allowed(tmp_path):
    ws = str(tmp_path)
    policy = load_policy(ws)
    assert policy.check_path("c:/tmp/sequence_search.py", "write").allowed
    assert policy.check_path("/tmp/scratch.py", "write").allowed

