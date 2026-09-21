# app/backend/skill_vetter.py
"""
Skill Vetter — static security scanner for SKILL.md files.

Scans skill content (both the YAML frontmatter and the prose body) for
dangerous patterns before installation. Returns a severity level and a list
of findings so the UI can present a human-readable risk report.

Severity scale:
  LOW      — benign; no user-facing warning needed.
  MEDIUM   — could be risky in certain contexts; amber warning, allow proceed.
  HIGH     — actively dangerous pattern; red block with per-finding confirm.
  EXTREME  — almost certainly malicious; hard block unless user overrides twice.

Design principles:
  1. False positives are better than false negatives. We'd rather annoy a
     legitimate skill author with a MEDIUM finding than let a supply-chain
     attack sail through.
  2. Rules are static regex. No LLM call in the hot path — vetting must be
     instant and deterministic.
  3. The vetter does NOT execute any code. It is purely textual.
  4. Each rule has a human-readable `reason` in both zh and en (for the
     frontend modal).
"""

from __future__ import annotations

import math
import re
from bisect import bisect_right

from dataclasses import dataclass, field
from enum import IntEnum
from typing import List


class Severity(IntEnum):
    """Risk severity. Higher numeric = worse."""
    LOW = 1
    MEDIUM = 2
    HIGH = 3
    EXTREME = 4


@dataclass
class Finding:
    """One specific dangerous pattern detected."""
    severity: Severity
    rule_id: str
    line: int  # 1-indexed line where the match starts; 0 = whole-file match
    matched: str  # the actual text that triggered the rule (truncated)
    reason_en: str
    reason_zh: str


@dataclass
class VetResult:
    """Aggregated scan result for one skill."""
    level: Severity  # max severity across all findings
    findings: List[Finding] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "level": self.level.name,
            "findings": [
                {
                    "severity": f.severity.name,
                    "ruleId": f.rule_id,
                    "line": f.line,
                    "matched": f.matched[:120],
                    "reasonEn": f.reason_en,
                    "reasonZh": f.reason_zh,
                }
                for f in self.findings
            ],
        }


@dataclass(frozen=True)
class Rule:
    """One detection rule. `pattern` is pre-compiled at module import."""
    rule_id: str
    severity: Severity
    pattern: re.Pattern
    reason_en: str
    reason_zh: str


def _rx(p: str) -> re.Pattern:
    """Compile case-insensitive, so `CURL` and `curl` both match."""
    return re.compile(p, re.IGNORECASE)


# ─────────────────────────────────────────────────────────────────────────────
# EXTREME — near-certainly malicious. Executing remote code, decoding then
# running a payload, or obfuscating the payload so review is impossible.
# ─────────────────────────────────────────────────────────────────────────────
_EXTREME_RULES: List[Rule] = [
    Rule(
        "remote-code-exec-pipe", Severity.EXTREME,
        _rx(r"\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|k|da)?sh\b"),
        "Downloads a remote script and pipes it straight into a shell. The "
        "code that runs is whatever the server decides to serve — it can "
        "change after you review the skill.",
        "从网络下载脚本并直接管道进 shell 执行。实际运行的代码由远端服务器决定，"
        "你审查过的内容随时可能被替换。",
    ),
    Rule(
        "remote-code-exec-iex", Severity.EXTREME,
        _rx(r"(?:iex|Invoke-Expression)\s*\(?\s*(?:\(|New-Object\s+Net\.WebClient|Invoke-WebRequest|iwr)"),
        "PowerShell downloads and executes remote code in one expression "
        "(the Windows equivalent of `curl | sh`).",
        "PowerShell 一行内下载并执行远端代码（Windows 上等价于 `curl | sh`）。",
    ),
    Rule(
        "base64-decode-exec", Severity.EXTREME,
        _rx(r"base64\s+(?:-d|-D|--decode|-di)\b[^\n]{0,120}\|\s*(?:ba|z|k|da)?sh\b"
            r"|(?:ba|z|k|da)?sh\b[^\n]{0,40}<\s*\(\s*base64\s+(?:-d|--decode)"),
        "Decodes a base64 blob and executes the result. This is the standard "
        "way to hide a payload from review.",
        "解码 base64 内容后直接执行。这是隐藏恶意载荷、规避人工审查的标准手法。",
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# HIGH — actively dangerous. Credential exfiltration, destructive filesystem
# operations, or reading sensitive files.
# ─────────────────────────────────────────────────────────────────────────────
_HIGH_RULES: List[Rule] = [
    Rule(
        "read-ssh-keys", Severity.HIGH,
        _rx(r"(?:cat|less|more|type|Get-Content|head|tail|cp|scp|rsync)\b[^\n]{0,120}"
            r"(?:~|\$HOME|%USERPROFILE%)?[\\/]?\.ssh[\\/]"),
        "Reads SSH private keys. There is no legitimate reason for a skill to "
        "touch `~/.ssh` — this is credential theft.",
        "读取 SSH 私钥。技能没有任何正当理由访问 `~/.ssh`——这是凭据窃取。",
    ),
    Rule(
        "read-cloud-creds", Severity.HIGH,
        _rx(r"(?:cat|less|more|type|Get-Content|head|tail|cp|scp|rsync)\b[^\n]{0,120}"
            r"[\\/]?\.(?:aws|gcp|azure|kube)[\\/]"),
        "Reads cloud provider credentials (AWS/GCP/Azure/Kubernetes). This "
        "exfiltrates the keys to your cloud accounts.",
        "读取云服务商凭据（AWS/GCP/Azure/K8s），会导致你的云账号密钥泄露。",
    ),
    Rule(
        "exfiltrate-env", Severity.HIGH,
        _rx(r"(?:curl|wget|Invoke-WebRequest|iwr|nc|ncat)\b[^\n]{0,200}"
            r"(?:\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD|CRED)|env|printenv|\.env)"),
        "Sends environment variables or secrets over the network. Legit skills "
        "don't POST your env to a remote host.",
        "把环境变量或密钥通过网络外发。正常技能不会把你的环境变量 POST 到远端。",
    ),
    Rule(
        "destructive-rm", Severity.HIGH,
        _rx(r"\brm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b[^\n]{0,40}"
            r"(?:\s+/(?:\s|$)|\s+~|\s+\$HOME|\s+/\*|\s+--no-preserve-root)"),
        "Recursive force-delete targeting the filesystem root or home "
        "directory. One run can wipe your machine.",
        "针对文件系统根目录或主目录的递归强制删除，一次执行就能清空你的机器。",
    ),
    Rule(
        "destructive-format", Severity.HIGH,
        _rx(r"\b(?:mkfs\.\w+|dd\s+if=[^\n]{0,60}of=/dev/|format\s+[a-z]:)\b"),
        "Formats a disk or overwrites a raw device. Irreversible data loss.",
        "格式化磁盘或直写裸设备，会造成不可逆的数据丢失。",
    ),
    Rule(
        "disable-security", Severity.HIGH,
        _rx(r"(?:iptables\s+-F|ufw\s+disable|Set-MpPreference\s+-DisableRealtimeMonitoring"
            r"|defender|systemctl\s+stop\s+(?:firewalld|apparmor))"),
        "Disables a firewall or antivirus. Skills should never weaken your "
        "security posture.",
        "关闭防火墙或杀毒软件。技能绝不应削弱你的安全防护。",
    ),
]


# ─────────────────────────────────────────────────────────────────────────────
# MEDIUM — context-dependent. Privilege escalation, PATH tampering, network
# listeners, or installing arbitrary packages. Legitimate in some skills, but
# worth a heads-up.
# ─────────────────────────────────────────────────────────────────────────────
_MEDIUM_RULES: List[Rule] = [
    Rule(
        "sudo", Severity.MEDIUM,
        _rx(r"\bsudo\b|\brunas\b|Start-Process\b[^\n]{0,60}-Verb\s+RunAs"),
        "Requests elevated privileges. Review exactly what runs as admin.",
        "请求提权（管理员权限）。请仔细确认哪些操作会以管理员身份运行。",
    ),
    Rule(
        "path-tamper", Severity.MEDIUM,
        _rx(r"(?:export\s+PATH=|setx\s+PATH|\$env:PATH\s*=)"),
        "Modifies the PATH environment variable, which can shadow trusted "
        "system binaries with malicious ones.",
        "修改 PATH 环境变量，可能用恶意程序覆盖你信任的系统命令。",
    ),
    Rule(
        "net-listener", Severity.MEDIUM,
        _rx(r"\b(?:nc|ncat|netcat)\s+-[a-z]*l|socket\.socket\([^\n]{0,40}\)[^\n]{0,60}\.bind"
            r"|http\.server|python\s+-m\s+http\.server"),
        "Opens a network listener/server. Could expose your machine or "
        "receive a remote payload.",
        "打开网络监听/服务端口，可能暴露你的机器或接收远端载荷。",
    ),
    Rule(
        "arbitrary-install", Severity.MEDIUM,
        _rx(r"\b(?:pip|pip3|npm|pnpm|yarn|gem|cargo|go)\s+(?:install|add|i)\b"
            r"|apt(?:-get)?\s+install|brew\s+install|choco\s+install"),
        "Installs external packages. Verify the package names — typosquatted "
        "packages are a common attack vector.",
        "安装外部依赖包。请核对包名——仿冒/抢注包名是常见攻击手段。",
    ),
    Rule(
        "crontab-persist", Severity.MEDIUM,
        _rx(r"\bcrontab\b|schtasks\s+/create|New-ScheduledTask|systemctl\s+enable"),
        "Installs a persistent scheduled task. This lets code keep running "
        "after the skill finishes.",
        "安装持久化的定时任务，会让代码在技能结束后仍持续运行。",
    ),
    Rule(
        "obfuscation", Severity.MEDIUM,
        _rx(r"(?:\\x[0-9a-f]{2}){8,}|(?:%[0-9a-f]{2}){10,}|[A-Za-z0-9+/]{120,}={0,2}"),
        "Contains a long encoded/obfuscated blob. Cannot be reviewed by a "
        "human — treat with suspicion.",
        "包含大段编码/混淆内容，人工无法审查其真实意图，需保持警惕。",
    ),
]


_ALL_RULES: List[Rule] = _EXTREME_RULES + _HIGH_RULES + _MEDIUM_RULES


# ── 高熵串检测（正则之外的那一半）──────────────────────────────────────────
#
# 所有 _HIGH_RULES 都是"认得出的形状"：sk-…、ghp_…、Bearer …。真实泄露里最常
# 见的那一类恰好没有形状——一串自建服务的随机 token，正则一个都不认识。于是
# 门禁报告写着 secret_scan: ok，而正文里躺着一把可用的钥匙。
#
# 判据故意保守，宁漏不误报（误报会训练用户忽略这道门）：
#   长度 ≥ 24、含大小写+数字三类、每字符熵 ≥ 3.8 bits。
# 十六进制哈希（内容版本号、commit id）因为缺大写字母而被排除——那是这个项目
# 里最常见的合法长串，把它标红这道门就废了。
_ENTROPY_TOKEN = re.compile(r"[A-Za-z0-9+/_\-=]{24,}")
_ENTROPY_MIN_BITS = 3.8


def _shannon_bits_per_char(s: str) -> float:
    """Shannon entropy of one token, in bits per character."""
    if not s:
        return 0.0
    counts: dict = {}
    for ch in s:
        counts[ch] = counts.get(ch, 0) + 1
    n = float(len(s))
    return -sum((c / n) * math.log2(c / n) for c in counts.values())


def _entropy_findings(content: str, line_of) -> List[Finding]:
    out: List[Finding] = []
    seen: set = set()
    for m in _ENTROPY_TOKEN.finditer(content):
        tok = m.group(0)
        if tok in seen:
            continue
        has_lower = any(c.islower() for c in tok)
        has_upper = any(c.isupper() for c in tok)
        has_digit = any(c.isdigit() for c in tok)
        if not (has_lower and has_upper and has_digit):
            continue
        if _shannon_bits_per_char(tok) < _ENTROPY_MIN_BITS:
            continue
        seen.add(tok)
        out.append(Finding(
            severity=Severity.HIGH,
            rule_id="SECRET_HIGH_ENTROPY",
            line=line_of(m.start()),
            matched=tok[:12] + "…" + tok[-4:],  # 不回显全串：报告本身会被读、被存
            reason_en=("High-entropy mixed-case token: looks like a live "
                       "credential with no recognizable vendor prefix."),
            reason_zh=("高熵混合大小写长串：像是一把没有厂商前缀的可用凭证，"
                       "正则规则认不出这一类，但泄露后果相同。"),
        ))
    return out



def vet_skill(content: str) -> VetResult:
    """
    Scan raw skill text (frontmatter + body) and return the aggregated result.

    Empty / whitespace-only content is treated as LOW (nothing to run).
    """
    if not content or not content.strip():
        return VetResult(level=Severity.LOW, findings=[])

    # Precompute line offsets so we can map a match position → line number
    # without re-scanning for every finding.
    line_starts: List[int] = [0]
    for i, ch in enumerate(content):
        if ch == "\n":
            line_starts.append(i + 1)

    def line_of(pos: int) -> int:
        # bisect over the precomputed offsets — O(log n) per finding instead of
        # the O(n) list.index() scan a naive version would do.
        return bisect_right(line_starts, pos)

    findings: List[Finding] = []
    for rule in _ALL_RULES:
        for m in rule.pattern.finditer(content):
            findings.append(
                Finding(
                    severity=rule.severity,
                    rule_id=rule.rule_id,
                    line=line_of(m.start()),
                    matched=m.group(0).strip(),
                    reason_en=rule.reason_en,
                    reason_zh=rule.reason_zh,
                )
            )
    findings.extend(_entropy_findings(content, line_of))


    if not findings:
        return VetResult(level=Severity.LOW, findings=[])

    # Sort worst-first so the UI leads with the scariest thing.
    findings.sort(key=lambda f: (-int(f.severity), f.line))
    level = Severity(max(int(f.severity) for f in findings))
    return VetResult(level=level, findings=findings)
