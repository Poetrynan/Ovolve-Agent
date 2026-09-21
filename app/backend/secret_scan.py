# -*- coding: utf-8 -*-
"""
secret_scan.py — 三层密钥与凭据泄漏防护引擎 (P3-1)。

管线架构：
  1. 关键词 Trie 树预筛（高速过滤无敏感词文本，避免大文本正则与熵计算开销）；
  2. 正则规则库（覆盖 PEM 私钥块、AWS/Google/Slack/Stripe/GitHub、数据库连接串、.env）；
  3. Shannon 熵与 Allowlist 防误报校验（过滤占位符、连续字符与低熵测试串）。

设计原则：基于公开通用密钥格式特征实现，零第三方依赖。
"""
from __future__ import annotations

import math
import os
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Sequence


# --------------------------------------------------------------------------- #
# 1. 关键词 Trie 树预筛                                                        #
# --------------------------------------------------------------------------- #

class TrieNode:
    __slots__ = ("children", "is_end")

    def __init__(self) -> None:
        self.children: dict[str, TrieNode] = {}
        self.is_end: bool = False


class KeywordTrie:
    """Aho-Corasick 风格前缀树预筛器，用于高速检查文本中是否可能含有敏感词根。"""

    def __init__(self, keywords: Sequence[str] = ()) -> None:
        self.root = TrieNode()
        for kw in keywords:
            self.insert(kw)

    def insert(self, word: str) -> None:
        if not word:
            return
        node = self.root
        for char in word.lower():
            if char not in node.children:
                node.children[char] = TrieNode()
            node = node.children[char]
        node.is_end = True

    def contains_any(self, text: str) -> bool:
        """检查 text 中是否包含任一关键词（大小写不敏感）。"""
        if not text:
            return False
        lowered = text.lower()
        length = len(lowered)
        for i in range(length):
            node = self.root
            j = i
            while j < length and lowered[j] in node.children:
                node = node.children[lowered[j]]
                if node.is_end:
                    return True
                j += 1
        return False


# --------------------------------------------------------------------------- #
# 2. Shannon 熵与 Allowlist 校验                                              #
# --------------------------------------------------------------------------- #

def shannon_entropy(data: str) -> float:
    """计算字符串的香农信息熵（bit/char）。"""
    if not data:
        return 0.0
    length = len(data)
    counts = Counter(data)
    entropy = 0.0
    for count in counts.values():
        p = count / length
        entropy -= p * math.log2(p)
    return entropy


#: 常见占位符与测试词白名单（全小写）
_ALLOWLIST_KEYWORDS = frozenset({
    "your_api_key", "your_secret_key", "your_token", "your_password",
    "my_secret_token", "my_secret_key", "test_key", "test_secret",
    "example_key", "example_secret", "dummy_token", "dummy_key",
    "placeholder", "changeme", "change_me", "replace_me", "replace_with",
    "true", "false", "none", "null", "undefined",
})


def is_allowlisted_or_low_entropy(val: str, min_entropy: float = 3.0) -> bool:
    """判断疑似凭据是否属于占位符、模板串或低熵无害内容。"""
    cleaned = val.strip().strip("\"'`;,")
    if len(cleaned) < 8:
        return True

    lowered = cleaned.lower()
    for kw in _ALLOWLIST_KEYWORDS:
        if kw in lowered:
            return True

    # 纯重复或纯数字简单序列
    if re.fullmatch(r"(?:0+|x+|1234567890?)", lowered):
        return True

    # 字符多样性过低 (如 'aaaaaaaaaaaa' 或 'abababababab')
    if len(set(cleaned)) <= 3:
        return True

    # 香农熵过低
    ent = shannon_entropy(cleaned)
    if ent < min_entropy:
        return True

    return False


# --------------------------------------------------------------------------- #
# 3. 规则库与数据结构                                                          #
# --------------------------------------------------------------------------- #

@dataclass
class SecretMatch:
    rule_name: str
    matched_text: str
    redacted: str
    confidence: str          # "high" | "medium"
    line_number: int
    entropy: float
    reason: str
    is_pem: bool = False
    filename: str = ""


@dataclass
class SecretRule:
    name: str
    pattern: re.Pattern
    confidence: str          # "high" | "medium"
    keywords: list[str]
    is_pem: bool = False
    min_entropy: float = 0.0
    extract_group: int = 0   # 0 表示提取完整匹配，>0 表示提取特定捕获组用于熵校验


_SECRET_RULES: list[SecretRule] = [
    SecretRule(
        name="pem_private_key",
        pattern=re.compile(
            r"-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----"
        ),
        confidence="high",
        keywords=["begin", "private key"],
        is_pem=True,
    ),
    SecretRule(
        name="aws_access_key",
        pattern=re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
        confidence="high",
        keywords=["akia", "asia"],
        min_entropy=2.8,
    ),
    SecretRule(
        name="aws_secret_key",
        pattern=re.compile(r"(?i)\b(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*['\"]?([A-Za-z0-9/+=]{40})['\"]?"),
        confidence="high",
        keywords=["aws_secret"],
        extract_group=1,
        min_entropy=3.5,
    ),
    SecretRule(
        name="google_api_key",
        pattern=re.compile(r"\bAIza[0-9A-Za-z_\-]{30,45}\b"),
        confidence="high",
        keywords=["aiza"],
        min_entropy=3.0,
    ),
    SecretRule(
        name="slack_token",
        pattern=re.compile(r"\bxox[baprs]-[0-9A-Za-z\-]{10,80}\b"),
        confidence="high",
        keywords=["xoxb", "xoxa", "xoxp", "xoxr", "xoxs"],
        min_entropy=2.8,
    ),
    SecretRule(
        name="stripe_secret_key",
        pattern=re.compile(r"\b(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{24,}\b"),
        confidence="high",
        keywords=["sk_live", "rk_live", "sk_test", "rk_test"],
        min_entropy=3.0,
    ),
    SecretRule(
        name="github_token",
        pattern=re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{30,50}\b"),
        confidence="high",
        keywords=["ghp_", "gho_", "ghu_", "ghs_", "ghr_"],
        min_entropy=3.0,
    ),
    SecretRule(
        name="db_connection_url",
        pattern=re.compile(
            r"(?i)\b(?:postgres|postgresql|mysql|mongodb|redis|amqp):\/\/[^\s:]+:([^\s@]{6,})@[^\s\/:]+"
        ),
        confidence="medium",
        keywords=["postgres://", "postgresql://", "mysql://", "mongodb://", "redis://", "amqp://"],
        extract_group=1,
        min_entropy=2.6,
    ),
    SecretRule(
        name="dotenv_secret",
        pattern=re.compile(
            r"(?m)^[ \t]*([A-Z0-9_]*(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|AUTH_TOKEN|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*[\"']?([^\s\"',;#]{12,})[\"']?"
        ),
        confidence="medium",
        keywords=["api_key", "secret", "password", "passwd", "auth_token", "private_key"],
        extract_group=2,
        min_entropy=3.2,
    ),
    SecretRule(
        name="generic_credential_assignment",
        pattern=re.compile(
            r"(?i)\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|AUTH_TOKEN|PRIVATE_KEY)[A-Z0-9_]*)\s*[:=]\s*[\"']?([^\s\"',;]{12,})[\"']?"
        ),
        confidence="medium",
        keywords=["api_key", "secret", "password", "passwd", "auth_token", "private_key"],
        extract_group=2,
        min_entropy=3.4,
    ),
]

# 构建全局 Trie
_GLOBAL_KEYWORDS: set[str] = set()
for r in _SECRET_RULES:
    _GLOBAL_KEYWORDS.update(r.keywords)
_GLOBAL_TRIE = KeywordTrie(sorted(_GLOBAL_KEYWORDS))


def redact_secret_string(secret: str) -> str:
    """脱敏敏感词：保留前2后2字符，中间替换为星号。"""
    cleaned = secret.strip()
    if len(cleaned) <= 4:
        return "****"
    if len(cleaned) <= 8:
        return f"{cleaned[:1]}****{cleaned[-1:]}"
    return f"{cleaned[:2]}***{cleaned[-2:]}"


# --------------------------------------------------------------------------- #
# 4. 扫描函数                                                                 #
# --------------------------------------------------------------------------- #

def scan_text(text: str, filename: str = "") -> list[SecretMatch]:
    """对单段文本执行三层扫描检测。"""
    if not text or not isinstance(text, str):
        return []

    # 第一层：关键词 Trie 树预筛
    if not _GLOBAL_TRIE.contains_any(text):
        return []

    matches: list[SecretMatch] = []

    for rule in _SECRET_RULES:
        # 单规则关键词快速预判
        if rule.keywords and not any(kw in text.lower() for kw in rule.keywords):
            continue

        if rule.is_pem:
            # PEM 块可能是多行的
            for m in rule.pattern.finditer(text):
                full_val = m.group(0)
                start_offset = m.start()
                # 计算所在行号
                line_no = text[:start_offset].count("\n") + 1
                matches.append(SecretMatch(
                    rule_name=rule.name,
                    matched_text=full_val,
                    redacted="-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----",
                    confidence=rule.confidence,
                    line_number=line_no,
                    entropy=4.0,
                    reason="包含未加密的 PEM 格式私钥块",
                    is_pem=True,
                    filename=filename,
                ))
            continue

        # 普通单行或跨行规则
        for m in rule.pattern.finditer(text):
            secret_candidate = m.group(rule.extract_group) if rule.extract_group else m.group(0)
            ent = shannon_entropy(secret_candidate)

            # 第三层：熵阈值与白名单排除
            if rule.min_entropy > 0.0 and ent < rule.min_entropy:
                continue
            if is_allowlisted_or_low_entropy(secret_candidate, min_entropy=rule.min_entropy):
                continue

            start_offset = m.start(rule.extract_group) if rule.extract_group else m.start()
            line_no = text[:start_offset].count("\n") + 1
            matches.append(SecretMatch(
                rule_name=rule.name,
                matched_text=secret_candidate,
                redacted=redact_secret_string(secret_candidate),
                confidence=rule.confidence,
                line_number=line_no,
                entropy=round(ent, 2),
                reason=f"命中 {rule.name}（置信度: {rule.confidence}, 熵: {ent:.2f}）",
                is_pem=False,
                filename=filename,
            ))

    return matches


_SKIP_DIRS = frozenset({
    ".git", ".svn", "node_modules", "scratch", "venv", ".venv",
    "__pycache__", "dist", "dist-next", "build", ".pytest_cache"
})


def scan_tree(dir_path: str | Path, excludes: Optional[Sequence[str]] = None) -> list[SecretMatch]:
    """递归扫描目录下的源代码与配置文件（单文件上限 1MB，跳过版本控制与缓存目录）。"""
    root = Path(dir_path).resolve()
    if not root.is_dir():
        return []

    exclude_set = set(_SKIP_DIRS)
    if excludes:
        exclude_set.update(excludes)

    results: list[SecretMatch] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in exclude_set]
        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext in (".png", ".jpg", ".jpeg", ".gif", ".ico", ".exe", ".bin", ".wasm", ".db", ".sqlite"):
                continue
            fpath = os.path.join(dirpath, fname)
            try:
                stat = os.stat(fpath)
                if stat.st_size > 1024 * 1024:  # 超过 1MB 跳过
                    continue
                with open(fpath, "r", encoding="utf-8", errors="ignore") as fh:
                    content = fh.read()
                rel_path = os.path.relpath(fpath, root)
                file_matches = scan_text(content, filename=rel_path)
                results.extend(file_matches)
            except Exception:
                continue

    return results


def generate_leak_report(matches: list[SecretMatch]) -> str:
    """生成人类可读的敏感信息泄漏审计报告。"""
    if not matches:
        return "未发现敏感信息或凭据泄漏。"
    lines = [f"⚠️ 检测到 {len(matches)} 处敏感密钥/凭据泄漏风险："]
    for i, m in enumerate(matches, 1):
        loc = f"{m.filename}:{m.line_number}" if m.filename else f"第 {m.line_number} 行"
        lines.append(f"  {i}. [{m.confidence.upper()}] {m.rule_name} 位于 {loc}")
        lines.append(f"     脱敏摘要: {m.redacted} (香农熵: {m.entropy})")
        lines.append(f"     原因: {m.reason}")
    return "\n".join(lines)
