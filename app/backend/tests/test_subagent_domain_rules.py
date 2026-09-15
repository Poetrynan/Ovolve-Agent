"""test_subagent_domain_rules.py — 测试子代理五轴域规则、MCP硬顶及结构化 failure_kind。"""

import os
import sys
import tempfile
import pytest

from app.backend.subagent_registry import (
    evaluate_domain_rules,
    SubagentDef,
    PRESETS,
)
from app.backend.evolution import FailureKind, EvolutionStore
from app.backend.gepa_evolution import ReflectiveMutator


class TestDomainRulesEvaluation:
    """测试五轴域规则评估引擎 (filesystem, network, commandRules, mcpRules, onRestrict)。"""

    def test_empty_rules_allowed(self):
        allowed, action, fkind, reason = evaluate_domain_rules({}, "write_file", {"path": "a.txt"})
        assert allowed is True
        assert action == "allow"
        assert fkind == ""

    def test_filesystem_none(self):
        rules = {"filesystem": "none", "onRestrict": "block"}
        allowed, action, fkind, reason = evaluate_domain_rules(rules, "read_text", {"path": "a.txt"})
        assert allowed is False
        assert action == "block"
        assert fkind == "command_rule_deny"
        assert "filesystem=none" in reason

        allowed2, _, _, _ = evaluate_domain_rules(rules, "write_file", {"path": "a.txt"})
        assert allowed2 is False

    def test_filesystem_readonly(self):
        rules = {"filesystem": "readOnly", "onRestrict": "block"}
        # 允许读取
        allowed_read, action, _, _ = evaluate_domain_rules(rules, "read_text", {"path": "a.txt"})
        assert allowed_read is True
        assert action == "allow"

        # 拒绝写入
        allowed_write, action, fkind, reason = evaluate_domain_rules(rules, "write_to_file", {"path": "a.txt"})
        assert allowed_write is False
        assert action == "block"
        assert fkind == "command_rule_deny"
        assert "只读权限" in reason

        # 拒绝替换内容
        allowed_replace, _, _, _ = evaluate_domain_rules(rules, "replace_file_content", {})
        assert allowed_replace is False

    def test_network_deny(self):
        rules = {"network": "deny", "onRestrict": "fallback"}
        allowed, action, fkind, reason = evaluate_domain_rules(rules, "web_search", {"query": "python"})
        assert allowed is False
        assert action == "fallback"
        assert fkind == "command_rule_deny"
        assert "network=deny" in reason

        # 非网络工具不受影响
        allowed_other, _, _, _ = evaluate_domain_rules(rules, "list_dir", {})
        assert allowed_other is True

    def test_command_rules_deny_exact_and_wildcard(self):
        rules = {
            "commandRules": {
                "deny": ["rm -rf*", "shutdown*"],
            },
            "onRestrict": "block",
        }
        # 拒绝 rm -rf
        allowed, action, fkind, reason = evaluate_domain_rules(rules, "run_command", {"CommandLine": "rm -rf /"})
        assert allowed is False
        assert action == "block"
        assert fkind == "command_rule_deny"

        # 允许常规命令
        allowed_ls, _, _, _ = evaluate_domain_rules(rules, "run_command", {"CommandLine": "ls -la"})
        assert allowed_ls is True

    def test_command_rules_shlex_whitespace_evasion(self):
        """测试多空格与制表符注入防御: rm    -rf /"""
        rules = {
            "commandRules": {
                "deny": ["rm -rf*"],
            },
        }
        allowed, action, fkind, _ = evaluate_domain_rules(
            rules, "run_command", {"command": "rm    -rf   /var/data"}
        )
        assert allowed is False
        assert fkind == "command_rule_deny"

    def test_command_rules_chained_pipeline_evasion(self):
        """测试分号与逻辑连接符管道绕过防御: git status; rm -rf /"""
        rules = {
            "commandRules": {
                "deny": ["rm*"],
            },
        }
        cmd = "git status ; rm -rf /app"
        allowed, _, fkind, _ = evaluate_domain_rules(rules, "run_command", {"CommandLine": cmd})
        assert allowed is False
        assert fkind == "command_rule_deny"

    def test_command_rules_allowlist(self):
        rules = {
            "commandRules": {
                "allow": ["pytest*", "python*"],
            },
        }
        # 允许列表中
        allowed, _, _, _ = evaluate_domain_rules(rules, "run_command", {"CommandLine": "pytest tests/"})
        assert allowed is True

        # 不在允许列表中
        allowed_curl, _, fkind, _ = evaluate_domain_rules(rules, "run_command", {"CommandLine": "curl http://test.com"})
        assert allowed_curl is False
        assert fkind == "command_rule_deny"

    def test_mcp_rules(self):
        rules = {
            "mcpRules": {
                "deny": ["mcp__db_drop*"],
                "allow": ["mcp__db_*"],
            },
        }
        # 命中 deny
        allowed_drop, _, fkind, _ = evaluate_domain_rules(rules, "mcp__db_drop_table", {})
        assert allowed_drop is False
        assert fkind == "mcp_rule_deny"

        # 命中 allow
        allowed_select, _, _, _ = evaluate_domain_rules(rules, "mcp__db_select", {})
        assert allowed_select is True

        # 未命中 allow
        allowed_other, _, fkind2, _ = evaluate_domain_rules(rules, "mcp__fs_list", {})
        assert allowed_other is False
        assert fkind2 == "mcp_rule_deny"


class TestSubagentRegistryDefaults:
    """测试内置 profile 的五轴域规则与 MCP 硬顶配置。"""

    def test_builtin_profiles_presence(self):
        assert "readonly_researcher" in PRESETS
        assert "fs_writer" in PRESETS
        assert "full_operator" in PRESETS

        researcher = PRESETS["readonly_researcher"]
        assert researcher.domain_rules.get("filesystem") == "readOnly"
        assert researcher.mcp_tool_cap == 24

        fs_writer = PRESETS["fs_writer"]
        assert fs_writer.domain_rules.get("filesystem") == "readWrite"
        assert fs_writer.domain_rules.get("network") == "deny"


class TestStructuredFailureKind:
    """测试 failure_kind 结构化枚举与 Evolution 存储/诊断。"""

    def test_evolution_store_roundtrip(self, tmp_path):
        db_file = tmp_path / "test_evo.db"
        store = EvolutionStore(str(db_file))

        # 写入带有 failure_kind 的 signal
        sig = store.record_signal(
            kind="tool_error",
            tool_name="run_command",
            detail="rm -rf was denied by domain rule",
            session_id="test_sess",
            failure_kind=FailureKind.COMMAND_RULE_DENY,
        )
        assert sig

        # 读取验证
        rows = store._conn.execute("SELECT failure_kind FROM signals WHERE signature = ?", (sig,)).fetchall()
        assert len(rows) == 1
        assert rows[0][0] == FailureKind.COMMAND_RULE_DENY

    def test_gepa_diagnosis_uses_failure_kind(self):
        # 1. command_rule_deny
        trace_cmd = {
            "failure_kind": FailureKind.COMMAND_RULE_DENY,
            "tool": "run_command",
            "error": "command rejected",
        }
        diag_cmd = ReflectiveMutator.diagnose_failure_trace(trace_cmd)
        assert diag_cmd["root_cause"] == "command_rule_deny"
        assert "命令域规则" in diag_cmd["suggested_guardrail"]

        # 2. mcp_rule_deny
        trace_mcp = {
            "failure_kind": FailureKind.MCP_RULE_DENY,
            "tool": "mcp__tool",
            "error": "mcp tool denied",
        }
        diag_mcp = ReflectiveMutator.diagnose_failure_trace(trace_mcp)
        assert diag_mcp["root_cause"] == "mcp_rule_deny"
        assert "MCP 工具域规则" in diag_mcp["suggested_guardrail"]
