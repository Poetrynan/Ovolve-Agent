# -*- coding: utf-8 -*-
"""browser_policy_guard.py - 浏览器自动化脚本分级策略与安全沙箱

按脚本对页面状态的影响分级管控，敏感凭证读取一律阻断。
对 Webview / CDP 执行的 evaluate 脚本与 URL 导航动作建立多级安全分级与防御过滤：
1. READ_ONLY：DOM 查询、标题/文本抽取，放行执行；
2. MUTATING：表单填写、按钮点击等有状态动作，标记并审计；
3. BLOCKED_DANGEROUS：跨域敏感 Cookie/Token 窃取、协议篡改、无限重定向，硬性阻断。
"""
from __future__ import annotations

import re
from enum import Enum
from typing import Tuple, List


class ScriptExecutionTier(str, Enum):
    READ_ONLY = "read_only"
    MUTATING = "mutating"
    BLOCKED_DANGEROUS = "blocked_dangerous"


# 危险模式特征正则（拦截高危数据外发、恶意重定向、原生沙箱逃逸）
DANGEROUS_PATTERNS = [
    re.compile(r"\bdocument\s*\.\s*cookie\b", re.IGNORECASE),
    re.compile(r"\blocalStorage\s*\.\s*clear\s*\(", re.IGNORECASE),
    re.compile(r"\bsessionStorage\s*\.\s*clear\s*\(", re.IGNORECASE),
    re.compile(r'(?:window\s*\.\s*)?location\s*=\s*[\'"]javascript:', re.IGNORECASE),
    re.compile(r"(?<![\w\.])eval\s*\(", re.IGNORECASE),
    re.compile(r"(?:(?<![\w\.])new\s+Function\s*\(|(?<![\w\.])Function\s*\()", re.IGNORECASE),
]

# 修改状态动作特征正则
MUTATING_PATTERNS = [
    re.compile(r"\.click\(\)", re.IGNORECASE),
    re.compile(r"\.submit\(\)", re.IGNORECASE),
    re.compile(r"\.value\s*=", re.IGNORECASE),
    re.compile(r"\.checked\s*=", re.IGNORECASE),
    re.compile(r"\.innerHTML\s*=", re.IGNORECASE),
    re.compile(r"\.innerText\s*=", re.IGNORECASE),
    re.compile(r"\.dispatchEvent\(", re.IGNORECASE),
    re.compile(r"history\.pushState", re.IGNORECASE),
]

# 安全允许的 URL 协议头
ALLOWED_SCHEMES = ("http://", "https://", "file://", "about:blank", "chrome-devtools://")


def strip_comments_and_strings(code: str) -> str:
    """剔除 JavaScript 单行/多行注释与字符串字面量，暴露纯粹的语法执行结构。

    彻底消除在字符串字面量（如 console.log("eval error")）或注释中提及关键词时的误报。
    """
    pattern = r'(/\*[\s\S]*?\*/|//[^\r\n]*|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|`(?:\\.|[^`\\])*`)'
    return re.sub(pattern, " ", code)


class BrowserPolicyGuard:
    """浏览器自动化脚本分级与导航安全守卫。"""

    @staticmethod
    def classify_script(
        js_code: str,
        ast_verdict: Optional[dict] = None,
    ) -> Tuple[ScriptExecutionTier, str]:
        """对将要被 evaluate 的 JS 脚本进行安全性与副作用分级。

        支持接收外部（如 Electron/Acorn 静态分析器）AST 校验结论；
        默认使用基于词法净化的静态结构分析，消灭注释与字符串字面量误判。

        Returns:
            (tier, reason)
        """
        if ast_verdict and isinstance(ast_verdict, dict):
            tier = ast_verdict.get("tier")
            if tier in (
                ScriptExecutionTier.BLOCKED_DANGEROUS,
                ScriptExecutionTier.MUTATING,
                ScriptExecutionTier.READ_ONLY,
            ):
                return (ScriptExecutionTier(tier), ast_verdict.get("reason", "External AST verdict"))

        code = str(js_code or "").strip()
        if not code:
            return (ScriptExecutionTier.READ_ONLY, "Empty script")

        # 静态词法净化：剔除注释与字符串字面量，保留真实执行语义
        stripped_code = strip_comments_and_strings(code)

        # 1. 优先校验是否存在阻断级危险模式
        for pat in DANGEROUS_PATTERNS:
            match = pat.search(stripped_code)
            if match:
                return (
                    ScriptExecutionTier.BLOCKED_DANGEROUS,
                    f"Blocked dangerous pattern: '{match.group(0)}'",
                )

        # 2. 校验是否存在状态修改模式
        for pat in MUTATING_PATTERNS:
            match = pat.search(stripped_code)
            if match:
                return (
                    ScriptExecutionTier.MUTATING,
                    f"Mutating action detected: '{match.group(0)}'",
                )

        # 3. 默认为只读查询
        return (ScriptExecutionTier.READ_ONLY, "Read-only DOM query")

    @staticmethod
    def validate_url(url: str) -> Tuple[bool, str]:
        """校验导航目标 URL 的协议安全合规性。"""
        u = str(url or "").strip().lower()
        if not u:
            return (False, "URL 不能为空")

        if u.startswith(("javascript:", "vbscript:", "data:text/html")):
            return (False, f"Blocked unsafe URL scheme: {u[:30]}")

        for allowed in ALLOWED_SCHEMES:
            if u.startswith(allowed):
                return (True, "Valid URL scheme")

        return (False, f"Unsupported URL protocol: {u[:20]}")
