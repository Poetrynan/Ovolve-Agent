"""test_context_compactor_microfold.py — 微折叠（microfold）验证（Track R3）

验证 ContextCompactor._microfold 的文档化保留规则：
  * 只清 ``msg_type == "tool_call"`` 且工具名在 FOLDABLE_TOOLS 的结果；
  * 按 token 预算（recency window）从新到旧累加，预算外的旧结果被折叠为占位符；
  * 非 tool_call 消息（system/user/assistant）原样保留。

断言：
  1. 一条 200KB 的旧工具输出被折叠后，整体 token 数大幅下降；
  2. 折叠计数 >= 1；
  3. 落在「保鲜窗口内」的近期工具结果里的哨兵行保留；
  4. 落在「窗口外」的旧工具结果里的哨兵行被折叠掉；
  5. 非 tool_call 消息里的哨兵行（start / end）原样保留。
"""
from __future__ import annotations

from context_compactor import ContextCompactor, FOLD_PLACEHOLDER

SENTINEL_KEEP = "SENTINEL_KEEP_MARKER"
SENTINEL_RECENT = "SENTINEL_RECENT_MARKER"
SENTINEL_FOLD = "SENTINEL_FOLD_MARKER"

BIG_OUTPUT = ("x" * 200_000) + "\n" + SENTINEL_FOLD + "\n"


def _build_messages():
    msgs = []
    # 非 tool_call：system / user —— 不应被折叠
    msgs.append({"role": "system", "content": "system context " + SENTINEL_KEEP})
    msgs.append({"role": "user", "content": "user start " + SENTINEL_KEEP})
    # 旧的、超大的可折叠工具结果（read_file，在 FOLDABLE_TOOLS 内）
    msgs.append({
        "msg_type": "tool_call",
        "tool_name": "read_file",
        "content": BIG_OUTPUT,
    })
    # 近期的小可折叠工具结果（在 recency 预算内 → 保留）
    msgs.append({
        "msg_type": "tool_call",
        "tool_name": "grep",
        "content": "small grep result " + SENTINEL_RECENT,
    })
    msgs.append({
        "msg_type": "tool_call",
        "tool_name": "glob",
        "content": "small glob result " + SENTINEL_RECENT,
    })
    # 非 tool_call：结尾 user / assistant —— 不应被折叠
    msgs.append({"role": "user", "content": "user end " + SENTINEL_KEEP})
    msgs.append({"role": "assistant", "content": "ok done"})
    return msgs


def _total_tokens(compactor: ContextCompactor, msgs: list) -> int:
    return sum(
        compactor.estimate_tokens(m.get("content") or "")
        for m in msgs
        if isinstance(m, dict)
    )


def _joined_content(msgs: list) -> str:
    return "\n".join((m.get("content") or "") for m in msgs if isinstance(m, dict))


def test_microfold_shrinks_tokens_and_preserves_markers():
    # 小 prune 预算，确保 200KB 旧结果必然在窗口外被折叠
    compactor = ContextCompactor(prune_window_tokens=2_000)
    msgs = _build_messages()

    before = _total_tokens(compactor, msgs)
    cleared = compactor._microfold(msgs)
    after = _total_tokens(compactor, msgs)
    joined = _joined_content(msgs)

    # 1) 确实发生了折叠
    assert cleared >= 1, "expected at least one tool output to be microfolded"

    # 2) token 数大幅下降（占位符约为几十字符，远小于 200KB）
    assert after < before, "microfold should reduce total tokens"
    assert after < before * 0.5, f"tokens should shrink substantially (before={before}, after={after})"

    # 3) 近期（窗口内）工具结果里的哨兵保留
    assert SENTINEL_RECENT in joined, "recent in-window tool output must survive"

    # 4) 窗口外旧工具结果里的哨兵被折叠掉
    assert SENTINEL_FOLD not in joined, "out-of-window old tool output must be folded away"

    # 5) 非 tool_call 消息里的 start/end 哨兵原样保留
    assert SENTINEL_KEEP in joined, "non-tool messages must be preserved"

    # 被折叠处应写入占位符
    assert any(FOLD_PLACEHOLDER in (m.get("content") or "") for m in msgs if isinstance(m, dict))


def test_microfold_does_not_touch_non_tool_messages():
    compactor = ContextCompactor(prune_window_tokens=500)
    msgs = _build_messages()
    originals = {
        id(m): m.get("content")
        for m in msgs
        if isinstance(m, dict) and m.get("msg_type") != "tool_call"
    }
    compactor._microfold(msgs)
    for m in msgs:
        if id(m) in originals:
            assert m.get("content") == originals[id(m)], "non-tool_call message must be unchanged"
