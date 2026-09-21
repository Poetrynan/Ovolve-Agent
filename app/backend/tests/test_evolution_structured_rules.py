# -*- coding: utf-8 -*-
import os
import shutil
import tempfile
import time
from pathlib import Path

import pytest
from evolution import (
    EvolutionEngine,
    Proposal,
    consolidate_rules,
    format_rule_line,
    parse_rule_line,
)


@pytest.fixture
def clean_env():
    td = tempfile.mkdtemp(prefix="evol_struct_")
    db_dir = os.path.join(td, "db")
    ws = os.path.join(td, "workspace")
    os.makedirs(db_dir, exist_ok=True)
    os.makedirs(ws, exist_ok=True)

    agents_md = os.path.join(ws, "AGENTS.md")
    with open(agents_md, "w", encoding="utf-8") as f:
        f.write("# Project Agents\n\n## Learned Rules (evolution)\n\n")

    from evolution import EvolutionStore
    store = EvolutionStore(db_path=os.path.join(db_dir, "evolution.db"))
    engine = EvolutionEngine(workspace_root=ws, store=store)
    yield {
        "td": td,
        "ws": ws,
        "agents_md": agents_md,
        "engine": engine,
    }
    shutil.rmtree(td, ignore_errors=True)


def test_parse_rule_line():
    # 1. Fully structured
    line1 = "- [rule-1234] [hits:5] [last:2026-09-16] 抓取网页遭遇 403 时改用浏览器模式。"
    parsed1 = parse_rule_line(line1)
    assert parsed1["id"] == "rule-1234"
    assert parsed1["hits"] == 5
    assert parsed1["last"] == "2026-09-16"
    assert parsed1["content"] == "抓取网页遭遇 403 时改用浏览器模式。"

    # 2. Legacy / unstructured bullet
    line2 = "- 遇到 view_file 异常时检查路径有效性。"
    parsed2 = parse_rule_line(line2)
    assert parsed2["id"] == ""
    assert parsed2["hits"] == 1
    assert parsed2["content"] == "遇到 view_file 异常时检查路径有效性。"

    # 3. Only rule-id tag
    line3 = "- [rule_abc] 用户偏好使用 pnpm。"
    parsed3 = parse_rule_line(line3)
    assert parsed3["id"] == "rule_abc"
    assert parsed3["hits"] == 1
    assert parsed3["content"] == "用户偏好使用 pnpm。"


def test_format_rule_line():
    formatted = format_rule_line("不要使用 rm -rf", rule_id="rule-del", hits=3, last_date="2026-09-16")
    assert formatted == "- [rule-del] [hits:3] [last:2026-09-16] 不要使用 rm -rf"

    # Preserves / updates existing metadata
    reformatted = format_rule_line(formatted, hits=4, last_date="2026-09-17")
    assert reformatted == "- [rule-del] [hits:4] [last:2026-09-17] 不要使用 rm -rf"


def test_incremental_merge_in_apply(clean_env):
    engine = clean_env["engine"]
    agents_md = clean_env["agents_md"]

    # First proposal on 403 fallback
    p1 = Proposal(
        id="prop_403_v1",
        signature="sig_403",
        kind="tool_failure",
        tool_name="web_fetch",
        target_file="AGENTS.md",
        draft="- [prop_403_v1] [hits:2] [last:2026-09-10] 抓取网页遭遇 403 时改用浏览器模式。",
        rationale="测试403",
        hits=2,
        status="pending",
        created_at=time.time(),
    )
    engine.store.insert_proposal(p1)
    res1 = engine.decide(p1.id, accept=True)
    assert res1["ok"] is True

    content1 = Path(agents_md).read_text(encoding="utf-8")
    assert "- [prop_403_v1] [hits:2]" in content1

    # Second proposal on same topic later
    p2 = Proposal(
        id="prop_403_v2",
        signature="sig_403",
        kind="tool_failure",
        tool_name="web_fetch",
        target_file="AGENTS.md",
        draft="- [prop_403_v2] [hits:3] [last:2026-09-16] 抓取网页遭遇 403 时改用浏览器模式协助抓取。",
        rationale="再次发生403",
        hits=3,
        status="pending",
        created_at=time.time(),
    )
    engine.store.insert_proposal(p2)
    res2 = engine.decide(p2.id, accept=True)
    assert res2["ok"] is True

    content2 = Path(agents_md).read_text(encoding="utf-8")
    # Should not duplicate lines! Should increment hits (2 + 3 = 5) and update date
    rule_lines = [ln for ln in content2.splitlines() if ln.strip().startswith("- [")]
    assert len(rule_lines) == 1
    assert "[hits:5]" in rule_lines[0]


def test_consolidate_rules():
    section_text = (
        "- [r1] [hits:2] [last:2026-09-10] 执行 git push 前等待确认。\n"
        "- [r2] [hits:10] [last:2026-09-15] 遇到 404 死链时使用搜索引擎寻找备用链接。\n"
        "- [r3] [hits:1] [last:2026-09-01] 执行 git push 敏感操作前请示用户。\n"  # similar to r1
        "- [r4] [hits:5] [last:2026-09-12] 遇到 view_file 错误先检查路径。\n"
    )

    consolidated = consolidate_rules(section_text, max_rules=2)
    lines = consolidated.splitlines()

    # Max rules enforced
    assert len(lines) == 2
    # Highest hits rule (r2, hits=10) must be first
    assert "hits:10" in lines[0]
    assert "404" in lines[0]
