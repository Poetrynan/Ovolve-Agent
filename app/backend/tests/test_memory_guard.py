"""Phase 4 切片：长期记忆写路径安全闸（memory_guard）。"""
from memory_guard import guard_memory_content


def test_secret_is_rejected_wholesale():
    ok, cleaned, reasons = guard_memory_content(
        "请记住他的 api_key=sk-abcdefghijklmnopqrst 常用深色主题")
    assert not ok, "秘密形状必须整条拒收"
    assert cleaned == "", "拒收时不得留下半条内容"
    assert any("secret" in r for r in reasons)


def test_hidden_unicode_stripped_and_empty_rejected():
    # 零宽空格藏在"pnpm"中间——剥除后放行，信息无损
    ok, cleaned, reasons = guard_memory_content("项目用\u200bpnpm 管理依赖")
    assert ok and cleaned == "项目用pnpm 管理依赖"
    assert any("hidden-unicode" in r for r in reasons)

    # 方向控制符同样剥除
    ok2, c2, _ = guard_memory_content("路径是 D:\\dir\u202efile")
    assert ok2 and "\u202e" not in c2

    # 清洗后为空 → 拒收
    ok3, c3, reasons3 = guard_memory_content("\u200b\u200c\u200d")
    assert not ok3 and c3 == ""
