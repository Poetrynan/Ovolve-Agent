r"""gui_action_classifier.py - GUI/浏览器动作分级器：工具+参数 → 级别 + 风险旗标。

## 解决什么

COMMAND 层回答的是"这段 shell 文本多危险"；Computer Use / Browser 类工具没有
命令文本，危险藏在**动作语义**里：同样是 `click`，点空白处和点「确认支付」
天差地别；同样是 `fill`，填搜索框和填密码框是两回事。本模块补上这一维，
作为策略管道的第二个人工检查面（与 COMMAND 层同挂 COMMAND 管道段，先到先裁）。

## 级别模型（三档，动作语义解耦于权限档位）

    HANDOFF    移交人类——这类动作**就不该由代理执行**（解验证码、绕安全提示）。
               对应管道 DENY：驳回并在理由里告诉模型"让用户亲手做"。
    CONFIRM    当场必确认——删除类点击、凭证输入、页面代码执行、金融动作。
               同样映射 DENY（复用 RESTRICTED 的"单次人工批准"语义：
               一次批准只对本次生效， blanket 预批准无法自动放行）。
    AWARE      知情确认——提交/发布/安装类。映射 ASK：走正常审批条，
               用户选"以后都允许"即为持久预批准（预批准可解的类别）。
    OK         无文本证据——弃权（裸 click/scroll/screenshot 不抬级：
               单次点击本身无语义，靠工具级风险表兜底）。

## 证据原则

只看**参数文本里的机械证据**（selector/value/text/url/key 的关键词与正则），
不做页面理解。误报（把「提交订单」当普通提交）代价是一次多余的确认；
漏报（把支付确认当普通点击）代价不可接受——所以规则表向"宁可多问"倾斜。
每条规则带 why，和 command_classifier 同一份纪律。

**中英混排的边界规则**（实测踩坑）：`\b` 词边界对中文无效——`\w` 默认包含汉字，
「发布文章」里"发布"后跟"文"，`\b发布\b` 永远不中。因此约定：ASCII 词进正则
（保留 \b 防止 install 误中 uninstall 类），CJK 词一律走 keywords 子串匹配
（中文词无空格分隔，子串就是正确的"词边界"语义）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from tool_policy import PolicyAction, PolicyDecision, PolicyLayer, PolicyRequest


class Tier(str, Enum):
    """GUI 动作的语义定级。OK 不产生裁决；AWARE→ASK；CONFIRM/HANDOFF→DENY。"""

    OK = "ok"
    AWARE = "aware"
    CONFIRM = "confirm"
    HANDOFF = "handoff"


#: 风险旗标（与级别正交：填密码框同时带 sensitive-data + form-input 两个旗标）
FLAG_SENSITIVE_DATA = "sensitive-data"
FLAG_DESTRUCTIVE = "gui-destructive"
FLAG_THIRD_PARTY = "third-party-communication"
FLAG_FINANCIAL = "financial-action"
FLAG_ACCOUNT = "account-management"
FLAG_INSTALL = "software-install"
FLAG_PAGE_CODE_EXEC = "page-code-exec"
FLAG_CAPTCHA = "captcha"
FLAG_SAFETY_BYPASS = "safety-bypass"
FLAG_SYSTEM_SETTINGS = "system-settings"


@dataclass
class Rule:
    """一条动作分级规则 = 适用工具 + 证据形态 + 级别 + 理由。"""

    rule_id: str
    flag: str
    tier: Tier
    # None = 适用于全部 GUI 工具；否则只查这些工具的参数
    tools: Optional[frozenset] = None
    # 只扫描这些参数键的值（None = 扫描全部字符串参数拼接）
    arg_keys: Optional[tuple[str, ...]] = None
    keywords: tuple[str, ...] = ()
    regex: Optional[re.Pattern] = None
    why: str = ""
    # 工具级全匹配：该工具的任何调用都命中（如 evaluate——在页面里执行任意
    # JS 这个行为本身就是风险，与内容无关）。与 keywords/regex 互斥使用。
    match_all: bool = False

    def hit(self, tool: str, texts: list[str]) -> bool:
        if self.tools is not None and tool not in self.tools:
            return False
        if self.match_all and not self.keywords and self.regex is None:
            return True
        joined = "\n".join(texts).lower()
        for kw in self.keywords:
            if kw in joined:
                return True
        if self.regex is not None and self.regex.search(joined):
            return True
        return False


# ── HANDOFF：代理就不该做，驳回并移交 ─────────────────────────────────────────
_H = Tier.HANDOFF

_HANDOFF_RULES: tuple[Rule, ...] = (
    Rule("GA-CAP-01", FLAG_CAPTCHA, _H,
         keywords=("captcha", "recaptcha", "hcaptcha", "验证码", "人机验证"),
         why="解验证码违背人机验证的存在目的，且多数服务条款明确禁止自动化求解"),
    Rule("GA-SB-01", FLAG_SAFETY_BYPASS, _H,
         keywords=("绕过", "不安全", "继续访问"),
         regex=re.compile(
             r"\b(bypass|proceed (anyway|link)|unsafe|interstitial|"
             r"accept.?risk|ignore.?warning)\b"),
         why="绕过浏览器/系统安全提示（HTTPS 警告、风险拦截页）属于安全屏障类动作，必须由用户亲手决策"),
)

# ── CONFIRM：可以做，但每次都要当场单独确认（单次批准语义） ───────────────────
_C = Tier.CONFIRM

_CONFIRM_RULES: tuple[Rule, ...] = (
    Rule("GA-EX-01", FLAG_PAGE_CODE_EXEC, _C,
         tools=frozenset({"evaluate"}),
         match_all=True,
         why="在页面里执行任意 JS——能绕过 UI 层的一切确认直接改状态，必须单独确认"),
    Rule("GA-CR-01", FLAG_SENSITIVE_DATA, _C,
         arg_keys=("value", "text"),
         regex=re.compile(
             r"^(.{0,4}(password|passwd|pwd|passwort|密码|口令)|"
             r"(?<!\d)\d{6}\s*$|"
             r"(api[_-]?key|secret|token|credential|私钥|访问令牌))"),
         why="检测到凭证形态的输入（密码/6位OTP/密钥令牌）——输入即传输，泄露不可撤回"),
    Rule("GA-CR-02", FLAG_SENSITIVE_DATA, _C,
         arg_keys=("selector",),
         keywords=("password", "passwd", "pwd", "otp", "密码", "口令", "验证码输入"),
         why="目标是密码/OTP 类输入框——字段语义即敏感，无论填什么内容"),
    Rule("GA-FI-01", FLAG_FINANCIAL, _C,
         keywords=("支付", "付款", "确认订单", "提交订单"),
         regex=re.compile(
             r"\b(place[-\s]?order|confirm[-\s]?payment|pay[-\s]?now|checkout|"
             r"complete[-\s]?purchase)\b"),
         why="金融交易确认动作——误触的代价是真金白银"),
    Rule("GA-DL-01", FLAG_DESTRUCTIVE, _C,
         keywords=("永久删除", "清空", "格式化", "注销账号", "delete account"),
         regex=re.compile(r"\b(delete|permanently remove|empty trash|format)\b"),
         why="GUI 上的删除/注销类动作——对话框挡不住误触，删除通常不可撤回"),
    Rule("GA-ST-01", FLAG_SYSTEM_SETTINGS, _C,
         tools=frozenset({"app_launch"}),
         arg_keys=("name",),
         keywords=("regedit", "secpol", "gpedit", "control", "services.msc",
                   "组策略", "服务管理"),
         why="直接拉起系统配置/注册表/策略编辑器——改坏系统状态 recovery 成本极高"),
)

# ── AWARE：知情确认即可，用户可以选"以后都允许"做持久预批准 ──────────────────
_A = Tier.AWARE

_AWARE_RULES: tuple[Rule, ...] = (
    Rule("GA-CM-01", FLAG_THIRD_PARTY, _A,
         keywords=("发布", "发送", "提交", "回复", "上传"),
         regex=re.compile(r"\b(post|publish|send|tweet|reply|submit form)\b"),
         why="对外发布/提交类动作——内容一旦离开本机就进入第三方管辖"),
    Rule("GA-AC-01", FLAG_ACCOUNT, _A,
         keywords=("注册", "创建账号", "授权"),
         regex=re.compile(
             r"\b(create[-\s]?account|sign[-\s]?up|register|"
             r"grant[-\s]?(access|permission))\b"),
         why="账号创建/授权动作建立持久关系，事后清理成本高"),
    Rule("GA-IN-01", FLAG_INSTALL, _A,
         keywords=("安装", "添加扩展", "添加插件"),
         regex=re.compile(r"\b(install|add extension|add.?ons|setup\.exe)\b"),
         why="安装软件/扩展建立持久的本机信任关系"),
)


_ALL_RULES: tuple[Rule, ...] = _HANDOFF_RULES + _CONFIRM_RULES + _AWARE_RULES


@dataclass
class GUIActionVerdict:
    """一次动作分级的完整产物。to_dict 的键与 CommandVerdict 对齐，
    前端审批条按同一形状渲染"安全检查发现"。"""

    tier: Tier
    flags: list[str] = field(default_factory=list)
    matched: list[str] = field(default_factory=list)   # rule ids
    hosts: list[str] = field(default_factory=list)     # 未用，形状对齐
    segments: int = 0                                  # 未用，形状对齐
    reasons: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "tier": self.tier.value,
            "flags": self.flags,
            "matched": self.matched,
            "hosts": self.hosts,
            "segments": self.segments,
            "reasons": self.reasons,
        }

    @property
    def is_handoff(self) -> bool:
        return self.tier is Tier.HANDOFF

    @property
    def needs_confirm(self) -> bool:
        return self.tier is Tier.CONFIRM

    @property
    def needs_awareness(self) -> bool:
        return self.tier is Tier.AWARE


#: GUI/浏览器动作类工具全集（与 tool_catalog 的 CORE_TOOL_NAMES 对应子集）
GUI_TOOLS = frozenset({
    # Computer Use（桌面）
    "computer_screenshot", "computer_click", "computer_move_cursor",
    "computer_type", "computer_press_key", "computer_scroll", "computer_drag",
    "app_launch", "window_focus",
    # Browser（浏览器）
    "navigate", "snapshot", "click", "fill", "evaluate",
})

#: 纯观察类动作——永远弃权（截图/快照/滚动/移动光标不改变任何状态）
_OBSERVATION_TOOLS = frozenset({
    "computer_screenshot", "computer_move_cursor", "computer_scroll",
    "snapshot", "navigate", "window_focus",
})


def _arg_texts(tool: str, args: dict, rule: Rule) -> list[str]:
    """按规则声明的参数键收集证据文本；未声明则收集全部字符串值。"""
    if rule.arg_keys is not None:
        vals = [args.get(k) for k in rule.arg_keys]
        return [v for v in vals if isinstance(v, str) and v.strip()]
    out: list[str] = []
    for v in args.values():
        if isinstance(v, str) and v.strip():
            out.append(v)
        elif isinstance(v, list):
            out.extend(x for x in v if isinstance(x, str) and x.strip())
    return out


def classify_action(tool: str, args: dict) -> GUIActionVerdict:
    """对一个 GUI/浏览器动作做完整分级。纯函数；畸形输入→OK 空旗标。"""
    verdict = GUIActionVerdict(tier=Tier.OK)
    if tool not in GUI_TOOLS or not isinstance(args, dict):
        return verdict
    if tool in _OBSERVATION_TOOLS:
        return verdict  # 纯观察动作不抬级——看一眼不改变世界

    for rule in _ALL_RULES:
        try:
            texts = _arg_texts(tool, args, rule)
            if rule.hit(tool, texts):
                if rule.flag not in verdict.flags:
                    verdict.flags.append(rule.flag)
                verdict.matched.append(rule.rule_id)
                if rule.why:
                    verdict.reasons.append(rule.why)
                if rule.tier is Tier.HANDOFF:
                    verdict.tier = Tier.HANDOFF
                elif rule.tier is Tier.CONFIRM and verdict.tier is not Tier.HANDOFF:
                    verdict.tier = Tier.CONFIRM
                elif rule.tier is Tier.AWARE and verdict.tier is Tier.OK:
                    verdict.tier = Tier.AWARE
        except Exception:
            continue  # 单条规则坏了不拖垮整体——宁缺勿崩
    return verdict


# ── 策略管道层 ────────────────────────────────────────────────────────────────

#: 分级结果在 request.context 里的缓存键——与命令分级共用同一个前端展示通道
#: （两类工具互斥，不存在覆盖）。WS 桥把它作为 commandGuard 透传给审批条。
_CONTEXT_VERDICT_KEY = "_command_verdict"


def make_gui_action_guard_layer() -> object:
    """GUI 动作层：语义分级 → HANDOFF/CONFIRM→DENY、AWARE→ASK。

    与命令分级同挂 COMMAND 管道段（同层多 callable 按注册序执行、最严者胜）。
    弃权（OK）不写 verdict——纯观察动作不该在审批条上出现"安全检查发现"。
    """
    def _layer(req: PolicyRequest) -> Optional[PolicyDecision]:
        if req.tool_name not in GUI_TOOLS:
            return None
        verdict = classify_action(req.tool_name, req.args or {})
        if verdict.tier is Tier.OK:
            return None
        try:
            req.context[_CONTEXT_VERDICT_KEY] = verdict.to_dict()
        except Exception:
            pass  # context 不可写只丢审计，不影响裁决

        if verdict.is_handoff:
            return PolicyDecision(
                action=PolicyAction.DENY,
                layer=PolicyLayer.COMMAND,
                label="action-guard:handoff",
                reason="这类动作需要用户亲手执行（" +
                       "；".join(verdict.reasons[:3]) + "）",
            )
        if verdict.needs_confirm:
            return PolicyDecision(
                action=PolicyAction.DENY,
                layer=PolicyLayer.COMMAND,
                label="action-guard:confirm",
                reason="每次执行都需要当场单独确认，预批准不适用（" +
                       "；".join(verdict.reasons[:3]) + "）",
            )
        return PolicyDecision(
            action=PolicyAction.ASK,
            layer=PolicyLayer.COMMAND,
            label="action-guard:aware",
            reason="动作需要知情确认（" +
                   "；".join(verdict.reasons[:3]) + "）",
        )
    return _layer


def last_verdict(context: Optional[dict]) -> Optional[dict]:
    """从工具上下文里取回本次动作分级（审计/展示用）。"""
    if not isinstance(context, dict):
        return None
    v = context.get(_CONTEXT_VERDICT_KEY)
    return v if isinstance(v, dict) else None


# ═══════════════════════════════════════════════════════════════════════════════
# 确认政策分类学（Confirmation Taxonomy）—— U2 第一阶段
#
# 本文件前半回答"这个动作裸看有多危险"（classify_action：按动作语义分级）；
# 本节回答"这个动作踩到了哪个雷区"（场景标签）。同样是 click，点「永久删除」
# 必弹窗、点「发布动态」可预批准——裸档看不见雷区，场景地板补上这一维。
#
# 两条正交的轴：
#   · confirmation_class —— 动作粗分类（handoff / always_confirm /
#     pre_approval / standard，词表见 CONFIRMATION_CLASSES）；
#   · scenario_tags —— 参数语料命中的雷区标签（SCENARIO_TAGS，固定 9 类）。
#
# 合成定律（本节最核心的不变式，测试以哨兵用例参数化锁死）：
#     最终档 = escalate_tiers(场景地板, 裸档)
#
# 反注入纪律：预批准的发言权只属于用户本人（见 PRE_APPROVAL_SOURCES）。
# ═══════════════════════════════════════════════════════════════════════════════

#: 场景标签全集。顺序即契约：detect_scenario_tags 的输出严格按此序排列，
#: 消费方可以直接 == 比较而无需重排。
SCENARIO_TAGS: tuple[str, ...] = (
    "deletion",                # 删除/清空/格式化——不可撤回的破坏
    "credential",              # 密码/密钥/令牌——输入即传输，泄露不可撤回
    "finance",                 # 支付/订单/转账——真金白银
    "third_party_comm",        # 发送/发布/上传——内容离开本机进入第三方管辖
    "system_security",         # 防火墙/注册表/组策略——改坏系统恢复成本极高
    "captcha",                 # 验证码——代理就不该碰（与裸档 HANDOFF 同源）
    "software_install",        # 安装——建立持久的本机信任关系
    "sensitive_transmission",  # 身份证/银行卡等敏感数据外发——泄露不可撤回
    "medical",                 # 医疗健康——误操作的代价是健康本身
)


@dataclass(frozen=True)
class ScenarioRule:
    r"""一条场景判定规则 = 场景标签 + ASCII 正则 + CJK 关键词。

    沿用本文件顶部的中英混排边界纪律：ASCII 词进正则（保留 \b 词边界，
    挡住 install 误中 uninstall 这类前缀纠缠），CJK 词一律子串匹配
    （中文无空格分词，子串就是正确的"词边界"）。
    """

    tag: str
    pattern: Optional[re.Pattern] = None   # 在小写化语料上匹配的 ASCII 词
    cjk: tuple[str, ...] = ()              # CJK 关键词子串


# 场景判定规则表（与 SCENARIO_TAGS 同序排布）。设计取向与本文件一致：
# 规则向"宁可多问"倾斜——误报的代价是一次多余的确认，漏报的代价不可接受。
_SCENARIO_RULES: tuple[ScenarioRule, ...] = (
    ScenarioRule(
        "deletion",
        pattern=re.compile(
            r"\b(delete|deleted|deleting|deletion|remove|removed|erase|wipe|purge|"
            r"trash|uninstall|format|empty (the )?(trash|recycle[ -]?bin))\b"),
        cjk=("删除", "删掉", "清空", "清除", "抹掉", "格式化", "注销", "销毁", "卸载"),
    ),
    ScenarioRule(
        "credential",
        pattern=re.compile(
            r"\b(password|passwd|pwd|passphrase|passcode|api[-_ ]?key|apikey|secret|"
            r"token|credential|private[ -]?key|access[ -]?key|login|log[ -]?in|"
            r"sign[ -]?in|signin|otp|2fa|two[ -]?factor)\b"),
        cjk=("密码", "口令", "密钥", "私钥", "令牌", "凭证", "登录"),
    ),
    ScenarioRule(
        "finance",
        pattern=re.compile(
            r"\b(pay(ment|s|ing)?|paid|paypal|checkout|check[ -]?out|purchase|"
            r"billing|invoice|refund|bank(ing)?|bank[ -]?transfer|wire[ -]?transfer|"
            r"place[ -]?order|confirm[ -]?order|subscription)\b"),
        cjk=("支付", "付款", "转账", "汇款", "结账", "下单", "订单", "退款", "充值",
             "提现", "结算", "收银"),
    ),
    ScenarioRule(
        "third_party_comm",
        pattern=re.compile(
            r"\b(send|sent|post|posted|posting|publish|share|shared|reply|forward|"
            r"upload|tweet|comment|email|message|submit)\b"),
        cjk=("发送", "发布", "提交", "回复", "转发", "分享", "上传", "评论", "发帖",
             "私信", "推送"),
    ),
    ScenarioRule(
        "system_security",
        pattern=re.compile(
            r"\b(firewall|registry|regedit|gpedit|secpol|uac|defender|antivirus|"
            r"administrator|group[ -]?policy|system[ -]?settings|hosts[ -]?file)\b"),
        cjk=("防火墙", "注册表", "组策略", "系统设置", "系统配置", "安全设置",
             "管理员", "杀毒", "安全中心"),
    ),
    ScenarioRule(
        "captcha",
        pattern=re.compile(
            r"\b(captcha|recaptcha|hcaptcha|turnstile|human[ -]?verification|"
            r"are[ -]?you[ -]?human|verify[ -]?human|not[ -]?a[ -]?robot)\b"),
        cjk=("验证码", "人机验证", "滑块验证", "拖动滑块", "拼图验证"),
    ),
    ScenarioRule(
        "software_install",
        pattern=re.compile(
            r"\b(install(ing|er|ed|s)?|setup(\.exe)?|\.msi|add[ -]?ons?|"
            r"add (a |an |the )?(extension|plugin)|browser[ -]?extension)\b"),
        cjk=("安装", "添加扩展", "添加插件"),
    ),
    ScenarioRule(
        "sensitive_transmission",
        pattern=re.compile(
            r"\b(ssn|social[ -]?security|passport|id[ -]?card|credit[ -]?card|"
            r"debit[ -]?card|bank[ -]?account|personal[ -]?(data|info|information)|"
            r"pii|confidential)\b"),
        cjk=("身份证", "银行卡", "社保号", "护照", "个人信息", "隐私", "敏感信息",
             "证件号"),
    ),
    ScenarioRule(
        "medical",
        pattern=re.compile(
            r"\b(medical|medication|diagnos(is|e)|prescription|patient|symptoms?|"
            r"clinic|clinical|hospital|doctor|health[ -]?record)\b"),
        cjk=("医疗", "病历", "处方", "诊断", "就诊", "挂号", "用药", "药方", "症状",
             "患者"),
    ),
)

_SCENARIO_RULE_MAP: dict = {r.tag: r for r in _SCENARIO_RULES}

# 导入期自检：规则表与标签全集一一对应——漏一条规则等于漏一类雷。
assert set(_SCENARIO_RULE_MAP) == set(SCENARIO_TAGS), (
    "场景规则表与 SCENARIO_TAGS 必须一一对应")


#: 语料规模护栏——畸形/超大输入不至于把正则拖成 DoS。截断是确定性的
#: （按参数出现顺序），同输入恒同输出。
_MAX_TEXTS = 256
_MAX_CORPUS_CHARS = 20000


def _walk_texts(node, out: list) -> None:
    """深度优先收集语料文本。

    收：字符串值 + 字符串键（键名本身即证据，如 {"password": ...} 的
    "password"）；递归下钻 dict / list / tuple。
    跳：以 '_' 开头的键视为内部缓存（如 _command_verdict）整枝剪掉——
    分级产物里的理由文本自带雷区词（"删除通常不可撤回"），回灌语料会造成
    自我证实级联；非字符串标量（数字/布尔/None）不是文本证据，不进语料。
    set 不遍历——迭代顺序不确定，与纯函数纪律冲突。
    """
    if len(out) >= _MAX_TEXTS:
        return
    if isinstance(node, str):
        if node.strip():
            out.append(node)
    elif isinstance(node, dict):
        for k, v in node.items():
            if isinstance(k, str):
                if k.startswith("_"):
                    continue
                if len(out) < _MAX_TEXTS:
                    out.append(k)
            _walk_texts(v, out)
    elif isinstance(node, (list, tuple)):
        for item in node:
            _walk_texts(item, out)


def detect_scenario_tags(tool, params, ctx=None) -> tuple[str, ...]:
    """场景判定器：从动作参数上下文里识别雷区标签。确定性纯函数、零网络。

    语料 = 工具名 + params + ctx 里的一切文本（递归下钻 dict/list，收集与
    跳过纪律见 _walk_texts）。ASCII 正则与 CJK 子串双轨匹配，与本文件既有
    规则表同一套边界纪律。

    命中按 SCENARIO_TAGS 固定顺序返回；无一命中返回空元组。畸形输入
    （None / 非字典 / 空语料）一律空元组——判定器只会弃权，不会崩，不瞎猜。
    """
    texts: list = []
    if isinstance(tool, str) and tool.strip():
        texts.append(tool)
    _walk_texts(params, texts)
    if ctx is not None:
        _walk_texts(ctx, texts)
    if not texts:
        return ()
    corpus = "\n".join(texts)[:_MAX_CORPUS_CHARS].lower()
    hits: list = []
    for tag in SCENARIO_TAGS:
        rule = _SCENARIO_RULE_MAP.get(tag)
        if rule is None:
            continue
        if rule.pattern is not None and rule.pattern.search(corpus):
            hits.append(tag)
            continue
        if any(kw in corpus for kw in rule.cjk):
            hits.append(tag)
    return tuple(hits)


# ── 政策分组：哪些雷区预批准买不动，哪些可以 ──────────────────────────────────

#: 必弹组——命中即恒 CONFIRM，预批准买不动（单次人工批准仍可放行当次）。
ALWAYS_CONFIRM_SCENARIOS: frozenset = frozenset({
    "deletion", "finance", "captcha", "software_install", "medical",
    "system_security",
})

#: 预批准可解组——用户做过持久授权后从 CONFIRM 降为 AWARE。
PRE_APPROVAL_SCENARIOS: frozenset = frozenset({
    "credential", "sensitive_transmission", "third_party_comm",
})

#: 场景 → 地板档位显式映射表。值为二元组 (未预批准地板, 预批准后地板)：
#:   · 必弹组（ALWAYS_CONFIRM_SCENARIOS）两列恒 CONFIRM——预批准买不动；
#:   · 预批准可解组（PRE_APPROVAL_SCENARIOS）批准后降为 AWARE。
#: 地板只抬不压：合成时与裸档走 escalate_tiers 取高。
SCENARIO_TIER_TABLE: dict = {
    "deletion":               (Tier.CONFIRM, Tier.CONFIRM),
    "credential":             (Tier.CONFIRM, Tier.AWARE),
    "finance":                (Tier.CONFIRM, Tier.CONFIRM),
    "third_party_comm":       (Tier.CONFIRM, Tier.AWARE),
    "system_security":        (Tier.CONFIRM, Tier.CONFIRM),
    "captcha":                (Tier.CONFIRM, Tier.CONFIRM),
    "software_install":       (Tier.CONFIRM, Tier.CONFIRM),
    "sensitive_transmission": (Tier.CONFIRM, Tier.AWARE),
    "medical":                (Tier.CONFIRM, Tier.CONFIRM),
}

# 导入期自检：分组与映射表不得漂移（改表必先改组，反之亦然）。
assert not (ALWAYS_CONFIRM_SCENARIOS & PRE_APPROVAL_SCENARIOS)
assert ALWAYS_CONFIRM_SCENARIOS | PRE_APPROVAL_SCENARIOS == set(SCENARIO_TAGS)
for _tag in SCENARIO_TAGS:
    _expected = ((Tier.CONFIRM, Tier.AWARE) if _tag in PRE_APPROVAL_SCENARIOS
                 else (Tier.CONFIRM, Tier.CONFIRM))
    assert SCENARIO_TIER_TABLE[_tag] == _expected, _tag
del _tag, _expected


# ── 档位算术与最终裁决 ────────────────────────────────────────────────────────

_TIER_STRENGTH: dict = {
    Tier.OK: 0,
    Tier.AWARE: 1,
    Tier.CONFIRM: 2,
    Tier.HANDOFF: 3,
}


def _coerce_tier(value) -> Optional[Tier]:
    """把任意输入安全折算为 Tier；认不出返回 None（宁可弃权不瞎猜）。"""
    if isinstance(value, Tier):
        return value
    if isinstance(value, str):
        try:
            return Tier(value.strip().lower())
        except ValueError:
            return None
    return None


def escalate_tiers(a, b) -> Tier:
    """两档取高：OK < AWARE < CONFIRM < HANDOFF。

    合成定律的算子——场景地板与裸档谁高听谁的。畸形输入（None/未知词）
    按 OK 处理：地板语义认低不认高，坏输入既不会被放宽成高档，也不会崩。
    """
    ta = _coerce_tier(a)
    if ta is None:
        ta = Tier.OK
    tb = _coerce_tier(b)
    if tb is None:
        tb = Tier.OK
    return ta if _TIER_STRENGTH[ta] >= _TIER_STRENGTH[tb] else tb


#: confirmation_class 词表——动作粗分类。上游映射约定（与裸档同构）：
#: Tier.OK→standard、Tier.AWARE→pre_approval、Tier.CONFIRM→always_confirm、
#: Tier.HANDOFF→handoff。
CONFIRMATION_CLASSES: frozenset = frozenset({
    "handoff", "always_confirm", "pre_approval", "standard",
})


def resolve_confirmation_tier(confirmation_class, scenario_tags,
                              pre_approved=False) -> Tier:
    """确认档位裁决：粗分类 × 场景标签 × 预批准 → 最终档。

    三条硬规则按序裁定，先命中先赢：
      1. handoff → 恒 HANDOFF。预批准对"就不该由代理做"的事无发言权。
      2. always_confirm 类，或命中必弹场景（ALWAYS_CONFIRM_SCENARIOS）→
         恒 CONFIRM。"以后都允许"买不动这类雷区，单次批准只解当次。
      3. pre_approval 类，或命中可预批准场景（PRE_APPROVAL_SCENARIOS）→
         已预批准 AWARE、未批准 CONFIRM。
    standard 且无标签 → OK（地板不生效：裸动作不因本节凭空抬级）。

    合成定律：本函数恒等于
        escalate_tiers(场景地板(tags, pre_approved), 裸档(class, pre_approved))
    ——测试以参数化哨兵锁死该等价：实现可以换，定律不能换。

    防御式容错：class 做 strip/lower 归一化，未知类按 standard；标签里的
    未知词直接忽略（不认识的地板不抬级）；scenario_tags 接受任意可迭代
    （含单个字符串，顺序无关）；None/畸形输入不抛异常。
    """
    cls = str(confirmation_class or "standard").strip().lower() or "standard"
    if cls not in CONFIRMATION_CLASSES:
        cls = "standard"
    if isinstance(scenario_tags, str):
        tags: tuple = (scenario_tags,)
    elif scenario_tags is None:
        tags = ()
    else:
        try:
            tags = tuple(scenario_tags)
        except TypeError:
            tags = ()
    pre = bool(pre_approved)

    # 硬规则一：handoff 恒 HANDOFF——预批准无权触碰
    if cls == "handoff":
        return Tier.HANDOFF
    # 硬规则二：必弹类/必弹场景恒 CONFIRM——预批准买不动
    if cls == "always_confirm" or any(t in ALWAYS_CONFIRM_SCENARIOS for t in tags):
        return Tier.CONFIRM
    # 硬规则三：可预批准类/场景——批准降为知情，未批准当场确认
    if cls == "pre_approval" or any(t in PRE_APPROVAL_SCENARIOS for t in tags):
        return Tier.AWARE if pre else Tier.CONFIRM
    # standard 且无标签：地板不生效
    return Tier.OK


# ── 反注入：预批准来源白名单 ──────────────────────────────────────────────────

#: 预批准证据的白名单——只有"用户亲口说"的两个通道：
#:   · user_first_message：用户会话首条消息里的持久授权（如"以后都允许"）；
#:   · confirm_card：用户在确认卡片上亲手点下的选项。
#: 白名单之外的一切（tool_result / web_content / page_text……）都不是授权。
#: 【纪律】工具结果、网页正文里出现的"请确认 / 我批准"字样**永不**计入——
#: 那是世界对代理说的话，不是用户对代理说的话；把页面文本当授权，
#: 等于让任意网页替用户按按钮。
PRE_APPROVAL_SOURCES = frozenset({"user_first_message", "confirm_card"})


def is_pre_approval_source(source) -> bool:
    """判定授权来源是否可信（在白名单内）。

    只有 PRE_APPROVAL_SOURCES 中的两个用户侧通道返回 True；其余——尤其
    tool_result / web_content 等机器侧来源——一律 False。
    【反注入纪律】工具结果/网页内容里的『请确认/我批准』永不计入：
    预批准的发言权只属于用户本人。
    畸形输入（None / 非字符串）一律 False——宁可不认，不可误认。
    """
    if not isinstance(source, str):
        return False
    return source.strip().lower() in PRE_APPROVAL_SOURCES
