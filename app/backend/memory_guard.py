"""
memory_guard.py — 长期记忆写入的安全闸（Phase 4 收口 + Phase 5 §9.3 扩展）。

总指令 §9.2/§9.3/§16：秘密和一次性噪声不进入长期记忆；隐形 Unicode 不能绕过扫描；
外部内容里的指令不得成为长期记忆。所有要持久化的记忆内容在 store() 之前过这里：

* secret 形状（token=/api_key=/Bearer xxx/sk-… 等）→ 整条拒绝，不截断保留——
  截断后的半条秘密还是秘密。
* 隐形 Unicode（零宽字符、方向控制、变体选择器等）→ 剥除后放行：这类字符的
  唯一用途就是绕过扫描或欺骗阅读者，剥除不损失信息。
* prompt injection 形状（"忽略之前的指令"、"你现在是…"、"system:"）→ 整条拒绝。
  长期记忆每一轮都会被注入 prompt，一条能改写指令的记忆等于一个永久后门，
  而且它进来的路径通常是"模型从网页/工具输出里提取事实"。
* 一次性噪声（绝对临时路径、PID/端口/耗时这类瞬时数字、纯 hash）→ 拒绝。
  它们下一次就不成立了，留着只会让模型基于过期事实推理。
* 模型臆测（"可能"、"大概"、"我猜"、"应该是"）→ 拒绝。不确定的东西该留在对话里
  等确认，而不是变成一条会被反复注入的"事实"。
* sensitivity 分级：不拒绝，只贴标签（public / personal / internal），供 UI 和
  后续策略使用。分级不改变是否写入，因为"敏感"和"不该记"不是一回事。
* 负面断言（"X 不存在"）→ **不拒绝，但要求有保质期**。这类断言只在写入那一刻
  成立：今天"没有 test_foo.py"，明天就有了。一律拒收等于丢掉有价值的观察，
  一律放行等于让一条过期事实在每轮 recall 里持续说谎。所以命中即标记，
  由写入侧打上 ``valid_until``，过期后读路径自然不再召回（见
  ``NEGATIVE_TTL_DAYS`` 与 :func:`staleness_note`）。
"""
from __future__ import annotations

import re
import sys
import time as _time
from dataclasses import dataclass, field

# 与 trace_gateway 同族的键值形状 + 常见令牌前缀（独立编译，避免循环依赖）。
_SECRET_RE = re.compile(
    r"\b(?:api[-_]?key|secret|token|password|passwd|pwd|credential|"
    r"auth(?:orization)?|access[-_]?key|private[-_]?key|session[-_]?id|cookie)\b"
    r"\s*[:=]\s*\S+"
    r"|\bbearer\s+[A-Za-z0-9._\-]+"
    r"|\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{8,}"
    r"|\bgh[pousr]_[A-Za-z0-9]{16,}"
    r"|\bxox[baprs]-[A-Za-z0-9\-]{8,}"
    r"|\bAIza[A-Za-z0-9_\-]{16,}",
    re.IGNORECASE,
)

# 零宽与方向控制字符：U+200B–200F, U+202A–202E, U+2060–206F, U+FEFF
_HIDDEN_UNICODE_RE = re.compile(
    "[\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e"
    "\u2060\u2061\u2062\u2063\u2064\u206a\u206b\u206c\u206d\u206e\u206f\ufeff]"
)

MAX_MEMORY_CONTENT_CHARS = 8000

# prompt injection 形状。刻意只认**祈使句式的指令改写**，不认单纯提到这些词：
# 一条"用户说别再问我确认"是合法记忆，"忽略上面所有指令"不是。
_INJECTION_RE = re.compile(
    r"忽略(?:之前|上面|以上|前面)(?:所有)?(?:的)?(?:指令|要求|规则|提示)"
    r"|无视(?:之前|上面|以上)(?:所有)?(?:的)?(?:指令|规则)"
    r"|你(?:现在|从现在起|从此)(?:是|扮演|变成)"
    r"|从现在(?:开始|起)(?:你|请你)"
    r"|ignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|preceding)\s+"
    r"(?:instructions?|prompts?|rules?|directions?)"
    r"|disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above)\s+"
    r"|you\s+are\s+now\s+(?:a|an|the)\b"
    r"|new\s+(?:system\s+)?instructions?\s*:"
    r"|^\s*(?:system|assistant|developer)\s*:",
    re.IGNORECASE | re.MULTILINE,
)

# 一次性噪声。三类，每一类都是"下一次就不成立"的东西：
#   1. 临时目录下的绝对路径（Temp / tmp / AppData\Local\Temp / 带随机段的）
#   2. 瞬时数字：PID、端口、耗时、行号、百分比进度
#   3. 裸 hash / 长十六进制（commit sha、uuid），单独出现时不构成事实
_EPHEMERAL_RES = (
    (re.compile(r"(?:[A-Za-z]:\\|/)(?:[^\s]*\\)?(?:Temp|tmp|Temporary)\\|/tmp/|/var/folders/",
                re.IGNORECASE), "临时路径"),
    (re.compile(r"\b(?:pid|端口|port|耗时|elapsed|took|行号|line)\s*[:=]?\s*\d+\b",
                re.IGNORECASE), "瞬时数字"),
    (re.compile(r"^\s*[0-9a-f]{7,40}\s*$", re.IGNORECASE), "裸 hash"),
)

# 模型臆测。同样只认**整条陈述被不确定性限定**的情况：句子里带这些词，而且没有
# 任何"用户说/用户确认"这类归属，就不该当事实存下来。
_SPECULATION_RE = re.compile(
    r"可能是|大概是|应该是|似乎|好像|我猜|估计是|不确定|也许"
    r"|\b(?:probably|maybe|perhaps|might\s+be|i\s+(?:think|guess|assume)|"
    r"seems?\s+(?:to\s+be|like)|not\s+sure|presumably)\b",
    re.IGNORECASE,
)

# 负面断言：断言某物**不存在**。"这里没有 tests 目录"在写下那一刻是真的，
# 明天就可能不是了。这类句子一旦进长期记忆，之后每一轮 recall 都会告诉模型
# "没有 tests 目录"，模型就不去找了——一条过期事实变成了一句持续的谎。
#
# 所以它不是"拦下来"，而是"给它一个保质期"：见 NEGATIVE_TTL_DAYS。
# 不拦的理由是它常常有价值（"这个项目没有 CI"，能省下半天找配置的时间），
# 一律拒收等于把所有观察都扔掉；而不管它等于允许一条谎话永久生效。
_NEGATIVE_RE = re.compile(
    r"不存在|已删除|已移除|已下线|未找到|找不到|没有找到|查无|暂无|已无|无此"
    r"|尚未(?:提供|支持|实现)"
    r"|(?:当前|目前)没有|还(?:没|不)(?:有|存在)"
    # 裸"没有"要收（"仓库里没有 test_foo.py"是最典型的形态），但"没有意义/
    # 没有关系/没有区别"这类成语不是存在性断言，排除掉——把它们标成易腐会给
    # 一条永久事实硬塞一个保质期。
    r"|没有(?!\s*(?:意义|必要|关系|区别|问题|办法|时间|用处|影响|道理))"
    r"|\bdoes\s+not\s+exist\b|\bdo\s+not\s+exist\b|\bdoesn'?t\s+exist\b"
    r"|\bno\s+such\b|\bnot\s+found\b|\bhas\s+been\s+(?:removed|deleted)\b"
    r"|\bthere\s+(?:is|are)\s+no\b|\bno\s+longer\s+(?:exists|present|available)\b"
    r"|\bnot\s+(?:implemented|supported|available)\b",
    re.IGNORECASE,
)

#: 负面断言的保质期（天）。到期后读路径不再召回它——库里已有的 valid_until
#: 过滤就是为这件事准备的，不必再发明一套"易腐"标记。
#: 14 天是权衡：短于一次迭代周期会让它还没被用上就消失，长过一个季度它早
#: 就不是事实了。
NEGATIVE_TTL_DAYS: int = 14

#: 在这之前认为它还新鲜，召回时不加提示；之后加一句"观测于 N 天前"。
NEGATIVE_FRESH_DAYS: int = 7

#: 召回时贴的年龄提示。``staleness_note`` 决定是否出现。
_STALENESS_TEMPLATE: str = "（此结论观测于 {} 天前，可能已过期）"


def staleness_note(observed_at: float, now: float = None) -> str:
    """给一条易腐记忆生成年龄提示；还新鲜就返回空串。

    写在句子层面而不是"整条丢弃"：在保质期之内，一句"观测于 9 天前"比直接
    删掉有用——模型可以自己决定要不要去核实。
    """
    try:
        ts = float(observed_at or 0)
    except (TypeError, ValueError):
        return ""
    if ts <= 0:
        return ""
    ref = float(now if now is not None else _time.time())
    days = int(max(0.0, (ref - ts) / 86400.0))
    if days < NEGATIVE_FRESH_DAYS:
        return ""
    return _STALENESS_TEMPLATE.format(days)


# 归属标记：出现这些说明这条是"用户明确说的"，即使句子里带不确定词也放行。
# 例如"用户说他也不确定要不要上 CI"是一条真实的、值得记住的事实。
_ATTRIBUTION_RE = re.compile(
    r"用户(?:说|表示|确认|要求|指出|强调)|user\s+(?:said|confirmed|stated|asked|wants)",
    re.IGNORECASE,
)

# sensitivity 分级用的形状。不拒绝，只贴标签。
_PERSONAL_RE = re.compile(
    r"\b\d{3}-?\d{4}-?\d{4}\b"                     # 卡号/证件号形状
    r"|\b1[3-9]\d{9}\b"                            # 手机号
    r"|[\w.+-]+@[\w-]+\.[\w.]+"                    # 邮箱
    r"|身份证|护照|家庭住址|银行卡",
    re.IGNORECASE,
)
_INTERNAL_RE = re.compile(
    r"\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"
    r"|\b192\.168\.\d{1,3}\.\d{1,3}\b"
    r"|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b"
    r"|\b\w+\.(?:internal|intranet|local|corp|lan)\b"
    r"|内网|内部系统|仅限内部",
    re.IGNORECASE,
)

#: sensitivity 取值。``public`` 是默认——绝大多数记忆是"项目用 pnpm"这种。
SENSITIVITY_LEVELS = ("public", "internal", "personal")


@dataclass
class Screening:
    """一条待持久化记忆的审查结论。

    ``allowed=False`` 时 ``content`` 是空串——被拒的内容不往下传，避免调用方
    "顺手"把它写进日志或错误消息里，那等于把刚拦下来的东西又漏出去。
    """
    allowed: bool
    content: str
    reasons: list[str] = field(default_factory=list)
    sensitivity: str = "public"
    #: 命中负面断言形态。不拒收，但调用方要给它一个保质期（valid_until）——
    #: 见 :data:`NEGATIVE_TTL_DAYS`。
    negative_assertion: bool = False


def classify_sensitivity(text: str) -> str:
    """给一条记忆贴敏感度标签。``personal`` 优先于 ``internal``。

    不影响是否写入：一条"用户的邮箱是 x@y.com"是合法且有用的长期记忆，只是界面上
    该显示成敏感、导出时该被排除。把分级和拒收混在一起会导致两个结果都不对——
    要么该记的不记，要么该标的没标。
    """
    t = str(text or "")
    if _PERSONAL_RE.search(t):
        return "personal"
    if _INTERNAL_RE.search(t):
        return "internal"
    return "public"


def screen_memory_content(content: str, *, trusted: bool = False) -> Screening:
    """§9.3 的写入闸门：检查、清洗并分级一条待持久化的记忆。

    ``trusted=True`` 用于用户在设置页手写的那条——她本人打进去的字不该被
    "这句话里有'可能'"这种启发式拦下来。秘密、注入和隐形 Unicode 仍然照拦：
    那三样即使是用户自己粘进来的，进了长期记忆也一样危险（粘错了才是常见情况）。
    """
    text = str(content or "")
    reasons: list[str] = []

    if _SECRET_RE.search(text):
        return Screening(False, "", ["secret-like pattern rejected (not truncated)"])

    if _INJECTION_RE.search(text):
        return Screening(False, "", ["prompt-injection shape rejected"])

    cleaned = _HIDDEN_UNICODE_RE.sub("", text)
    stripped = len(text) - len(cleaned)
    if stripped:
        reasons.append(f"stripped {stripped} hidden-unicode char(s)")

    if len(cleaned) > MAX_MEMORY_CONTENT_CHARS:
        cleaned = cleaned[:MAX_MEMORY_CONTENT_CHARS]
        reasons.append(f"truncated to {MAX_MEMORY_CONTENT_CHARS} chars")

    if not cleaned.strip():
        return Screening(False, "", reasons + ["empty after cleaning"])

    if not trusted:
        for rx, label in _EPHEMERAL_RES:
            if rx.search(cleaned):
                return Screening(False, "", reasons + [f"ephemeral content rejected: {label}"])
        if _SPECULATION_RE.search(cleaned) and not _ATTRIBUTION_RE.search(cleaned):
            return Screening(False, "", reasons + ["speculation rejected (no attribution)"])

    # 负面断言：不拒收，只标记。放在 trusted 分支之外——标记不是拦截，用户的
    # "这里没有 CI"和模型抽出来的同样是会过期的观察，两边该一视同仁。
    negative = bool(_NEGATIVE_RE.search(cleaned))
    if negative:
        reasons.append(
            f"negative assertion: expires in {NEGATIVE_TTL_DAYS}d unless re-observed")

    return Screening(True, cleaned, reasons, classify_sensitivity(cleaned), negative)


def guard_memory_content(content: str) -> tuple[bool, str, list[str]]:
    """旧签名的薄封装，保留是因为已有调用方按三元组解包。

    默认 ``trusted=True``：这个入口原本只做秘密和隐形 Unicode 两件事，悄悄给它
    加上臆测和一次性内容的拦截会改变现有调用方的行为。想要完整闸门的走
    :func:`screen_memory_content`。
    """
    v = screen_memory_content(content, trusted=True)
    return v.allowed, v.content, v.reasons
