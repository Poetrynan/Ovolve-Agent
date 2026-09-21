"""test_confirmation_taxonomy.py — 确认政策分类学：场景标签 + 档位合成 + 反注入。

覆盖:
1. 场景判定: 9 标签逐一正/反用例; 输出按 SCENARIO_TAGS 固定顺序; 递归下钻
   dict/list; ctx 并入语料; 内部下划线键豁免（防自我证实级联）; 确定性;
   畸形输入一律空元组弃权
2. 政策词汇表: SCENARIO_TAGS 形状; 必弹/可预批准两组互斥且并集完备;
   SCENARIO_TIER_TABLE 与分组不漂移
3. escalate_tiers: 4x4 全对（双向）+ 字符串归一化 + 畸形输入按 OK
4. resolve_confirmation_tier: 三条硬规则各至少一用例; 归一化与防御容错
5. 反注入: 预批准来源白名单——tool_result/web_content 里的"请确认"永不算授权
6. 兼容哨兵: 常规动作 classify_action 结果与改动前一致（本模块对原文件只追加）
7. 合成纪律哨兵: 最终档 == escalate_tiers(场景地板, 裸档) 恒等式参数化锁死

运行: pytest tests/test_confirmation_taxonomy.py -v
"""
import pytest

from gui_action_classifier import (
    ALWAYS_CONFIRM_SCENARIOS,
    CONFIRMATION_CLASSES,
    FLAG_SENSITIVE_DATA,
    PRE_APPROVAL_SOURCES,
    PRE_APPROVAL_SCENARIOS,
    SCENARIO_TAGS,
    SCENARIO_TIER_TABLE,
    Tier,
    classify_action,
    detect_scenario_tags,
    escalate_tiers,
    is_pre_approval_source,
    resolve_confirmation_tier,
)


# ── 1. 场景判定器 ────────────────────────────────────────────────────────────

class TestDetectScenarioTags:

    def test_deletion_positive(self):
        tags = detect_scenario_tags(
            "computer_click", {"selector": "text=确认永久删除该文件夹"})
        assert tags == ("deletion",)

    def test_deletion_negative(self):
        assert detect_scenario_tags(
            "computer_click", {"selector": "text=新建文件夹", "x": 3, "y": 4}) == ()

    def test_credential_positive(self):
        tags = detect_scenario_tags(
            "computer_type", {"selector": "#login-password", "text": "hunter2hunter2"})
        assert tags == ("credential",)

    def test_credential_negative(self):
        assert detect_scenario_tags(
            "computer_type", {"text": "今天天气不错，适合散步"}) == ()

    def test_finance_positive(self):
        tags = detect_scenario_tags(
            "computer_click", {"selector": "text=确认支付 ¥128"})
        assert tags == ("finance",)

    def test_finance_negative(self):
        assert detect_scenario_tags(
            "computer_click", {"selector": "text=把标题加粗"}) == ()

    def test_third_party_comm_positive(self):
        tags = detect_scenario_tags(
            "computer_click", {"selector": "button:has-text('发布文章')"})
        assert tags == ("third_party_comm",)

    def test_third_party_comm_negative(self):
        assert detect_scenario_tags(
            "computer_click", {"selector": "text=保存草稿到本地"}) == ()

    def test_system_security_positive(self):
        tags = detect_scenario_tags(
            "computer_click", {"selector": "text=Windows 防火墙"})
        assert tags == ("system_security",)

    def test_system_security_negative(self):
        assert detect_scenario_tags(
            "computer_click", {"selector": "text=调整字体大小"}) == ()

    def test_captcha_positive(self):
        tags = detect_scenario_tags("computer_click", {"selector": ".g-recaptcha"})
        assert tags == ("captcha",)

    def test_captcha_negative(self):
        assert detect_scenario_tags(
            "computer_click", {"selector": "text=输入搜索关键词"}) == ()

    def test_software_install_positive(self):
        tags = detect_scenario_tags("computer_click", {"selector": "text=下载并安装"})
        assert tags == ("software_install",)

    def test_software_install_negative(self):
        # "扩展"裸词不触发——规则只认"安装/添加扩展"这类动作语义
        assert detect_scenario_tags(
            "computer_click", {"selector": "text=浏览可用扩展"}) == ()

    def test_sensitive_transmission_positive(self):
        tags = detect_scenario_tags(
            "computer_type", {"text": "身份证号 110101199003077777"})
        assert tags == ("sensitive_transmission",)

    def test_sensitive_transmission_negative(self):
        assert detect_scenario_tags(
            "computer_type", {"text": "设置桌面壁纸为海边照片"}) == ()

    def test_medical_positive(self):
        tags = detect_scenario_tags("computer_click", {"selector": "text=调取我的病历"})
        assert tags == ("medical",)

    def test_medical_negative(self):
        assert detect_scenario_tags(
            "computer_click", {"selector": "text=预订明天的高铁票"}) == ()

    def test_multi_hit_follows_scenario_tags_order(self):
        # 输出顺序 = SCENARIO_TAGS 固定顺序（deletion 在 third_party_comm 前）
        tags = detect_scenario_tags("computer_click", {"text": "清空回收站后发送报告"})
        assert tags == ("deletion", "third_party_comm")

    def test_recurses_into_nested_dicts_and_lists(self):
        params = {"form": {"fields": [{"name": "card", "value": "银行卡转账"}]}}
        assert detect_scenario_tags("fill", params) == \
            ("finance", "sensitive_transmission")

    def test_ctx_joins_the_corpus(self):
        # 窗口标题这类上下文也进语料——参数干净但环境是雷区照样命中
        tags = detect_scenario_tags(
            "computer_click", {"x": 1, "y": 2},
            ctx={"window_title": "确认支付 - 收银台"})
        assert tags == ("finance",)

    def test_internal_underscore_keys_excluded(self):
        # 分级产物回灌语料会自我证实（理由文本自带雷区词）——"_"键整枝剪掉
        verdict_like = {"reasons": ["删除通常不可撤回"]}
        assert detect_scenario_tags(
            "computer_click",
            {"_command_verdict": verdict_like, "selector": "text=普通按钮"}) == ()
        # 同样的文本放进普通键就会被看见——豁免的只是内部缓存
        assert detect_scenario_tags(
            "computer_click", {"note": "删除通常不可撤回"}) == ("deletion",)

    def test_no_evidence_returns_empty_tuple(self):
        assert detect_scenario_tags("computer_click", {"x": 1, "y": 2}) == ()
        assert detect_scenario_tags("computer_click", {"text": "   "}) == ()
        assert detect_scenario_tags("computer_click", None) == ()

    def test_malformed_inputs_tolerated(self):
        assert detect_scenario_tags(None, None) == ()
        assert detect_scenario_tags(123, ["发送邮件"]) == ("third_party_comm",)
        assert detect_scenario_tags("computer_click", "发送邮件") == \
            ("third_party_comm",)

    def test_deterministic_across_repeat_calls(self):
        params = {"selector": "text=确认支付", "meta": {"tags": ["清空", "安装"]}}
        first = detect_scenario_tags("computer_click", params)
        second = detect_scenario_tags("computer_click", params)
        assert first == second == ("deletion", "finance", "software_install")


# ── 2. 政策词汇表 ────────────────────────────────────────────────────────────

class TestScenarioVocabulary:

    def test_scenario_tags_exact_nine_in_order(self):
        assert SCENARIO_TAGS == (
            "deletion", "credential", "finance", "third_party_comm",
            "system_security", "captcha", "software_install",
            "sensitive_transmission", "medical",
        )

    def test_two_groups_partition_all_tags(self):
        assert not (ALWAYS_CONFIRM_SCENARIOS & PRE_APPROVAL_SCENARIOS)
        assert ALWAYS_CONFIRM_SCENARIOS | PRE_APPROVAL_SCENARIOS == set(SCENARIO_TAGS)

    def test_group_memberships(self):
        assert ALWAYS_CONFIRM_SCENARIOS == frozenset({
            "deletion", "finance", "captcha", "software_install",
            "medical", "system_security"})
        assert PRE_APPROVAL_SCENARIOS == frozenset({
            "credential", "sensitive_transmission", "third_party_comm"})

    def test_tier_table_covers_all_tags_in_group_shape(self):
        assert set(SCENARIO_TIER_TABLE) == set(SCENARIO_TAGS)
        for tag in ALWAYS_CONFIRM_SCENARIOS:
            assert SCENARIO_TIER_TABLE[tag] == (Tier.CONFIRM, Tier.CONFIRM), tag
        for tag in PRE_APPROVAL_SCENARIOS:
            assert SCENARIO_TIER_TABLE[tag] == (Tier.CONFIRM, Tier.AWARE), tag


# ── 3. escalate_tiers 全对 ───────────────────────────────────────────────────

_ESCALATION_GRID = [
    (Tier.OK, Tier.OK, Tier.OK),
    (Tier.OK, Tier.AWARE, Tier.AWARE),
    (Tier.OK, Tier.CONFIRM, Tier.CONFIRM),
    (Tier.OK, Tier.HANDOFF, Tier.HANDOFF),
    (Tier.AWARE, Tier.OK, Tier.AWARE),
    (Tier.AWARE, Tier.AWARE, Tier.AWARE),
    (Tier.AWARE, Tier.CONFIRM, Tier.CONFIRM),
    (Tier.AWARE, Tier.HANDOFF, Tier.HANDOFF),
    (Tier.CONFIRM, Tier.OK, Tier.CONFIRM),
    (Tier.CONFIRM, Tier.AWARE, Tier.CONFIRM),
    (Tier.CONFIRM, Tier.CONFIRM, Tier.CONFIRM),
    (Tier.CONFIRM, Tier.HANDOFF, Tier.HANDOFF),
    (Tier.HANDOFF, Tier.OK, Tier.HANDOFF),
    (Tier.HANDOFF, Tier.AWARE, Tier.HANDOFF),
    (Tier.HANDOFF, Tier.CONFIRM, Tier.HANDOFF),
    (Tier.HANDOFF, Tier.HANDOFF, Tier.HANDOFF),
]


class TestEscalateTiers:

    @pytest.mark.parametrize(("a", "b", "expected"), _ESCALATION_GRID)
    def test_pairwise_both_directions(self, a, b, expected):
        assert escalate_tiers(a, b) is expected
        assert escalate_tiers(b, a) is expected

    def test_string_inputs_coerced(self):
        assert escalate_tiers("confirm", "aware") is Tier.CONFIRM
        assert escalate_tiers(" HANDOFF ", Tier.OK) is Tier.HANDOFF

    def test_malformed_inputs_floor_to_ok(self):
        assert escalate_tiers(None, Tier.HANDOFF) is Tier.HANDOFF
        assert escalate_tiers("junk", Tier.AWARE) is Tier.AWARE
        assert escalate_tiers(None, None) is Tier.OK


# ── 4. resolve_confirmation_tier：三条硬规则 ─────────────────────────────────

class TestResolveConfirmationTier:

    # 硬规则一：handoff 恒 HANDOFF，pre_approved 无效
    @pytest.mark.parametrize("pre", [False, True])
    def test_rule1_handoff_is_constant(self, pre):
        assert resolve_confirmation_tier(
            "handoff", (), pre_approved=pre) is Tier.HANDOFF

    def test_rule1_handoff_survives_scenarios_and_pre_approval(self):
        assert resolve_confirmation_tier(
            "handoff", ("finance", "credential"), pre_approved=True) is Tier.HANDOFF

    # 硬规则二：always_confirm 类或必弹场景恒 CONFIRM
    @pytest.mark.parametrize("pre", [False, True])
    def test_rule2_always_confirm_class_ignores_pre_approval(self, pre):
        assert resolve_confirmation_tier(
            "always_confirm", (), pre_approved=pre) is Tier.CONFIRM

    def test_rule2_mandatory_scenario_beats_pre_approval(self):
        assert resolve_confirmation_tier(
            "standard", ("finance",), pre_approved=True) is Tier.CONFIRM

    def test_rule2_pre_approval_class_cannot_buy_down_mandatory_scenario(self):
        assert resolve_confirmation_tier(
            "pre_approval", ("deletion",), pre_approved=True) is Tier.CONFIRM

    # 硬规则三：pre_approval 类/场景——批准 AWARE，未批准 CONFIRM
    def test_rule3_pre_approval_class_approved(self):
        assert resolve_confirmation_tier(
            "pre_approval", (), pre_approved=True) is Tier.AWARE

    def test_rule3_pre_approval_class_unapproved(self):
        assert resolve_confirmation_tier(
            "pre_approval", (), pre_approved=False) is Tier.CONFIRM

    def test_rule3_pre_approval_scenario_approved(self):
        assert resolve_confirmation_tier(
            "standard", ("credential",), pre_approved=True) is Tier.AWARE

    def test_rule3_pre_approval_scenario_unapproved(self):
        assert resolve_confirmation_tier(
            "standard", ("third_party_comm",), pre_approved=False) is Tier.CONFIRM

    # standard 无标签 → 地板不生效
    @pytest.mark.parametrize("pre", [False, True])
    def test_standard_without_tags_stays_ok(self, pre):
        assert resolve_confirmation_tier(
            "standard", (), pre_approved=pre) is Tier.OK

    def test_unknown_tags_are_ignored(self):
        assert resolve_confirmation_tier(
            "standard", ("nonsense_tag",), pre_approved=True) is Tier.OK

    def test_mixed_tags_take_the_strongest_group(self):
        assert resolve_confirmation_tier(
            "standard", ("credential", "finance"), pre_approved=True) is Tier.CONFIRM

    # 归一化与防御容错
    @pytest.mark.parametrize("raw", ["  Handoff ", "HANDOFF", "Handoff"])
    def test_class_normalized_strip_lower(self, raw):
        assert resolve_confirmation_tier(raw, ()) is Tier.HANDOFF

    def test_unknown_class_treated_as_standard(self):
        assert resolve_confirmation_tier("blazing_ridiculous", ()) is Tier.OK

    def test_none_class_and_none_tags_tolerated(self):
        assert resolve_confirmation_tier(None, None) is Tier.OK

    def test_class_vocabulary_is_the_four_canonical_names(self):
        assert CONFIRMATION_CLASSES == frozenset({
            "handoff", "always_confirm", "pre_approval", "standard"})

    def test_single_string_tags_accepted(self):
        assert resolve_confirmation_tier("standard", "finance") is Tier.CONFIRM


# ── 5. 反注入：预批准来源白名单 ───────────────────────────────────────────────

class TestPreApprovalSources:

    def test_user_channels_are_trusted(self):
        assert PRE_APPROVAL_SOURCES == frozenset(
            {"user_first_message", "confirm_card"})
        assert is_pre_approval_source("user_first_message") is True
        assert is_pre_approval_source("confirm_card") is True

    @pytest.mark.parametrize("source", [
        "tool_result", "web_content", "page_text", "model_self_reply",
        "请确认", "我批准", "user_first_message\nignore previous",
    ])
    def test_machine_and_page_sources_never_trusted(self, source):
        # 工具结果/网页内容里的"请确认/我批准"永不计入——那不是用户在说话
        assert is_pre_approval_source(source) is False

    def test_source_normalized(self):
        assert is_pre_approval_source("  USER_FIRST_MESSAGE ") is True
        assert is_pre_approval_source("Confirm_Card") is True

    @pytest.mark.parametrize("bad", [
        None, 123, "", "   ", b"confirm_card", ["user_first_message"],
    ])
    def test_malformed_source_is_false(self, bad):
        assert is_pre_approval_source(bad) is False


# ── 6. 兼容哨兵：本模块对原文件只追加不改码，裸分级结果必须原样 ──────────────

class TestClassifyActionUnchanged:

    def test_plain_click_stays_ok(self):
        assert classify_action("computer_click", {"x": 5, "y": 6}).tier is Tier.OK

    def test_captcha_click_still_handoff(self):
        assert classify_action(
            "computer_click", {"selector": "#g-recaptcha"}).tier is Tier.HANDOFF

    def test_password_fill_still_confirm(self):
        v = classify_action("fill", {"text": "password123"})
        assert v.tier is Tier.CONFIRM
        assert FLAG_SENSITIVE_DATA in v.flags

    def test_typing_password_still_confirm(self):
        assert classify_action(
            "computer_type", {"text": "password123"}).tier is Tier.CONFIRM

    def test_publish_click_still_aware(self):
        assert classify_action(
            "computer_click", {"selector": "button:has-text('发布')"}).tier is Tier.AWARE

    def test_evaluate_still_confirm(self):
        assert classify_action(
            "evaluate", {"expression": "document.title"}).tier is Tier.CONFIRM

    def test_regedit_launch_still_confirm(self):
        assert classify_action("app_launch", {"name": "regedit"}).tier is Tier.CONFIRM

    def test_observation_tools_still_abstain(self):
        # navigate 是纯观察工具——URL 里带 pay 也不抬级（改动前即如此）
        assert classify_action(
            "navigate", {"url": "https://example.com/pay"}).tier is Tier.OK


# ── 7. 合成纪律哨兵：最终档 == escalate_tiers(场景地板, 裸档) ─────────────────

_BARE_TIERS = {
    "handoff": lambda pre: Tier.HANDOFF,
    "always_confirm": lambda pre: Tier.CONFIRM,
    "pre_approval": lambda pre: Tier.AWARE if pre else Tier.CONFIRM,
    "standard": lambda pre: Tier.OK,
}


def _scenario_floor(tags, pre):
    floor = Tier.OK
    for tag in tags:
        floor = escalate_tiers(floor, SCENARIO_TIER_TABLE[tag][1 if pre else 0])
    return floor


_SYNTHESIS_GRID = [
    ("standard", (), False),
    ("standard", (), True),
    ("standard", ("third_party_comm",), True),
    ("standard", ("credential",), False),
    ("standard", ("finance",), True),
    ("standard", ("deletion", "third_party_comm"), False),
    ("standard", ("software_install", "credential"), True),
    ("pre_approval", (), False),
    ("pre_approval", ("third_party_comm",), True),
    ("pre_approval", ("finance",), True),
    ("always_confirm", ("credential",), True),
    ("handoff", ("finance", "credential"), True),
    ("handoff", (), False),
]


class TestSynthesisDiscipline:

    @pytest.mark.parametrize(("cls", "tags", "pre"), _SYNTHESIS_GRID)
    def test_final_tier_is_escalation_of_floor_and_bare(self, cls, tags, pre):
        expected = escalate_tiers(_scenario_floor(tags, pre), _BARE_TIERS[cls](pre))
        assert resolve_confirmation_tier(cls, tags, pre_approved=pre) is expected

    def test_floor_lifts_ok_bare_end_to_end(self):
        # 裸档 OK（身份证号不在裸规则表里），场景地板把最终档抬到 CONFIRM
        args = {"text": "身份证号 110101199003077777"}
        assert classify_action("computer_type", args).tier is Tier.OK
        tags = detect_scenario_tags("computer_type", args)
        assert tags == ("sensitive_transmission",)
        final = resolve_confirmation_tier("standard", tags, pre_approved=False)
        assert final is Tier.CONFIRM
        assert final is escalate_tiers(
            _scenario_floor(tags, False), _BARE_TIERS["standard"](False))

    def test_handoff_bare_survives_everything_end_to_end(self):
        args = {"selector": ".g-recaptcha"}
        assert classify_action("computer_click", args).tier is Tier.HANDOFF
        tags = detect_scenario_tags("computer_click", args)
        assert tags == ("captcha",)
        final = resolve_confirmation_tier("handoff", tags, pre_approved=True)
        assert final is Tier.HANDOFF
