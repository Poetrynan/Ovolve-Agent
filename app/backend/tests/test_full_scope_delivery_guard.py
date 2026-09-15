# -*- coding: utf-8 -*-
"""
test_full_scope_delivery_guard.py — 单元测试：物理全量交付与占位符门禁 (Phase 61)。
"""
from output_guard import FullScopeDeliveryGuard
from tool_hooks import get_tool_hooks, HookStage


def test_full_scope_delivery_guard_detection():
    # 正常完整代码 -> 放行
    clean_code = '''
def add(a, b):
    """Add two numbers."""
    return a + b
'''
    is_lazy, _ = FullScopeDeliveryGuard.inspect_code(clean_code)
    assert is_lazy is False

    # 偷懒占位符 1: // TODO: implement later
    lazy_1 = '''
def process_data(data):
    // TODO: implement later
    return True
'''
    is_lazy, matched = FullScopeDeliveryGuard.inspect_code(lazy_1)
    assert is_lazy is True
    assert "TODO" in matched

    # 偷懒占位符 2: /* rest of code here */
    lazy_2 = '''
class Service:
    def init(self):
        pass
    /* rest of code here */
'''
    is_lazy, matched = FullScopeDeliveryGuard.inspect_code(lazy_2)
    assert is_lazy is True
    assert "rest of code" in matched

    # 偷懒占位符 3: // ... rest unchanged ...
    lazy_3 = '''
function update() {
    // ... rest unchanged ...
}
'''
    is_lazy, matched = FullScopeDeliveryGuard.inspect_code(lazy_3)
    assert is_lazy is True


def test_tool_hook_integration_blocks_lazy_write():
    hooks = get_tool_hooks()

    # 1. 尝试写入偷懒代码到 write_to_file
    lazy_payload = {
        "TargetFile": "d:/test.py",
        "CodeContent": "def foo():\n    # TODO: implement later\n    pass"
    }
    result = hooks.run_pre("write_to_file", lazy_payload, {})
    assert result["blocked"] is True
    assert "全量交付" in result["reason"] or "TODO" in result["reason"]

    # 2. 写入干净全量代码 -> 放行
    clean_payload = {
        "TargetFile": "d:/test.py",
        "CodeContent": "def foo():\n    return 42"
    }
    result_clean = hooks.run_pre("write_to_file", clean_payload, {})
    assert result_clean["blocked"] is False
