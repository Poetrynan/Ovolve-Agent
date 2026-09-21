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
"""
from __future__ import annotations

import re
import sys
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

    return Screening(True, cleaned, reasons, classify_sensitivity(cleaned))


def guard_memory_content(content: str) -> tuple[bool, str, list[str]]:
    """旧签名的薄封装，保留是因为已有调用方按三元组解包。

    默认 ``trusted=True``：这个入口原本只做秘密和隐形 Unicode 两件事，悄悄给它
    加上臆测和一次性内容的拦截会改变现有调用方的行为。想要完整闸门的走
    :func:`screen_memory_content`。
    """
    v = screen_memory_content(content, trusted=True)
    return v.allowed, v.content, v.reasons
