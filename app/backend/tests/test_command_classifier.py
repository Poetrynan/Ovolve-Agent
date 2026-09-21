"""Command classifier: tier rules, install table, egress, policy layer."""
from __future__ import annotations

from command_classifier import (
    Tier,
    classify,
    make_command_guard_layer,
    reload_command_guard_config,
)
from tool_policy import PolicyAction, PolicyRequest


def _tier(cmd: str) -> str:
    return classify(cmd).tier.value


def _hits(cmd: str, rule_id: str) -> bool:
    return rule_id in classify(cmd).matched


# ── 装包判定表（CG-IR-01） ────────────────────────────────────────────────────

def test_install_subcommands_are_review():
    for cmd in ("npm install", "npm i lodash", "npm ci", "npm add x",
                "pip install requests", "pip3 install -r req.txt",
                "yarn add x", "yarn global add x", "pnpm add x",
                "uv pip install x", "uv add x", "gem install rails",
                "cargo install ripgrep", "cargo add serde",
                "go get github.com/a/b", "brew install git",
                "sudo apt install nginx", "apt-get install -y curl"):
        assert _hits(cmd, "CG-IR-01"), cmd
        assert _tier(cmd) == Tier.REVIEW.value, cmd


def test_non_install_subcommands_are_not_flagged():
    """一条只认 install/add 字面量的平正则会把 uninstall / test 一起收进来。"""
    for cmd in ("npm test", "npm run build", "npm uninstall x",
                "pip uninstall requests", "pip list", "go build ./...",
                "cargo build --release"):
        assert not _hits(cmd, "CG-IR-01"), cmd


def test_wrapped_and_quoted_installs_are_still_caught():
    for cmd in ('python -m pip install x', 'bash -c "npm install"',
                'sudo gem install rails'):
        assert _hits(cmd, "CG-IR-01"), cmd


def test_install_words_in_prose_are_not_installs():
    """`grep "npm install"` 是在读文档，不是在装包。"""
    assert not _hits('grep "npm install" README', "CG-IR-01")
    assert not _hits("cat package.json", "CG-IR-01")


def test_fetch_and_run_managers_count_as_installs():
    """npx/bunx 取包即执行——没有子命令可区分，任何调用都算。"""
    for cmd in ("npx some-pkg", "bunx tool", "uvx ruff"):
        assert _hits(cmd, "CG-IR-01"), cmd


# ── 网络出口 ─────────────────────────────────────────────────────────────────

def test_hosts_are_extracted_from_command():
    assert "api.github.com" in classify("curl https://api.github.com/x").hosts


def test_classify_survives_host_extractor_failure(monkeypatch):
    """抽取器炸了不能让整条命令静默变成"没有出口"。"""
    import command_classifier as cc

    def boom(_text):
        raise RuntimeError("extractor unavailable")

    monkeypatch.setattr(cc.cg, "extract_hosts", boom)
    v = classify("curl http://169.254.169.254/latest")
    assert "169.254.169.254" in v.hosts  # IPv4 回退仍在


# ── 策略层（COMMAND） ────────────────────────────────────────────────────────

def _ask(cmd: str, tool: str = "shell_executor"):
    req = PolicyRequest(tool_name=tool, args={"command": cmd}, context={})
    return make_command_guard_layer()(req)


def test_command_layer_ignores_non_shell_tools():
    assert _ask("rm -rf /", tool="read_file") is None


def test_command_layer_ignores_empty_command():
    assert _ask("") is None
    assert _ask("   ") is None


def test_review_commands_ask():
    d = _ask("pip install requests")
    assert d is not None
    assert d.action is PolicyAction.ASK
    assert d.label == "command-guard:review"


def test_restricted_commands_ask_by_default():
    """渐进收紧：形态规则必然有交集，第一版不直接 DENY。"""
    d = _ask("rm -rf /tmp/build")
    assert d is not None
    assert d.action is PolicyAction.ASK
    assert d.label == "command-guard:restricted"


def test_restricted_can_be_tightened_to_deny(monkeypatch):
    import command_classifier as cc

    monkeypatch.setattr(cc, "_restricted_action", lambda: "deny")
    assert _ask("rm -rf /").action is PolicyAction.DENY


def test_low_risk_commands_pass_through():
    assert _ask("npm test") is None
    assert _ask("ls -la") is None


def test_verdict_is_recorded_in_context_for_audit():
    ctx: dict = {}
    req = PolicyRequest(tool_name="shell_executor", args={"command": "pip install x"},
                        context=ctx)
    make_command_guard_layer()(req)
    assert ctx.get("_command_verdict", {}).get("tier") == "review"


def test_reload_clears_cached_action(monkeypatch):
    import command_classifier as cc

    cc._restricted_action_cache = "deny"
    monkeypatch.setattr(cc, "_DEFAULT_RESTRICTED_ACTION", "ask")
    cc._restricted_action_cache = None
    assert reload_command_guard_config() == "ask"
