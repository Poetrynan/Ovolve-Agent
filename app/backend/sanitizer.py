"""
sanitizer.py — 物理隐私脱敏与敏感信息清洗管道 (Phase 59 内化模块)。

从 anti-distill 技能提纯并硬内化为底层物理确定性代码：
1. 绝对盘符与私人目录脱敏:
   - C:\\Users\\...\\output -> 项目 output/ 目录 (或 output/ directory)
   - 保证写入 AGENTS.md / MEMORY.md / SQLite 数据库的内容无任何本地私有盘符或用户名泄漏。
2. API Key 与凭证物理脱敏:
   - 过滤 sk-*, ghp_*, Bearer Token, MAC 地址等敏感信息。
3. 零 Token 消耗、微秒级响应、确定性 100%。
"""
from __future__ import annotations

import os
import re
from typing import Optional


class PrivacySanitizer:
    """生产级物理隐私脱敏与路径规范化器。"""

    # 匹配各类 Windows 绝对路径 (如 C:\Users\xxx\...)
    WIN_PATH_PATTERN = re.compile(r'[A-Za-z]:\\[^\s\'"<>]+\\([A-Za-z0-9_\-]+)\\[^\s\'"<>]*', re.IGNORECASE)
    WIN_DIR_PATTERN = re.compile(r'[A-Za-z]:\\[^\s\'"<>]+\\([A-Za-z0-9_\-]+)[\\/]?', re.IGNORECASE)
    
    # 匹配 macOS / Unix /Users/xxx/... 绝对路径
    UNIX_USER_PATH_PATTERN = re.compile(r'/Users/[^/\s\'"<>]+/[^\s\'"<>]*/([A-Za-z0-9_\-]+)[\\/]?', re.IGNORECASE)

    # 匹配常见 API Key、Token 与私有凭据
    API_KEY_PATTERNS = [
        re.compile(r'sk-[a-zA-Z0-9_\-]{20,}', re.IGNORECASE),
        re.compile(r'ghp_[a-zA-Z0-9]{30,}', re.IGNORECASE),
        re.compile(r'github_pat_[a-zA-Z0-9_]{30,}', re.IGNORECASE),
        re.compile(r'Bearer\s+[a-zA-Z0-9_\-\.]{25,}', re.IGNORECASE),
        re.compile(r'([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})', re.IGNORECASE),  # MAC
    ]

    @classmethod
    def sanitize_paths(cls, text: str, workspace_root: Optional[str] = None, lang: str = "zh") -> str:
        """将绝对路径清洗为工作区相对路径或规范占位符。"""
        if not text or not isinstance(text, str):
            return text or ""

        # 1. 消除历史残留硬编码
        text = text.replace("C:\\Users\\ZhuanZ1\\Desktop\\Ovolve", "项目" if lang == "zh" else "workspace")
        text = text.replace("C:/Users/User/Desktop/Workspace", "项目" if lang == "zh" else "workspace")
        text = text.replace("d:\\Ovolve Agent", "项目" if lang == "zh" else "workspace")
        text = text.replace("D:\\Ovolve Agent", "项目" if lang == "zh" else "workspace")
        text = text.replace("D:/Example Workspace", "项目" if lang == "zh" else "workspace")

        # 2. 如果提供了 workspace_root，先精确匹配并替换 workspace_root 为相对路径
        if workspace_root:
            clean_ws = os.path.normpath(workspace_root)
            ws_regex = re.escape(clean_ws).replace(r'\\', r'[\\/]')
            text = re.sub(ws_regex, "项目根目录" if lang == "zh" else "workspace root", text, flags=re.IGNORECASE)

        # 3. 如果路径中包含特定知名目录名 (如 output, docs, dist, src, tests)
        for known_dir in ["output", "docs", "dist", "src", "tests", "temp", "build", "public"]:
            pat = re.compile(rf'[A-Za-z]:\\[^\s\'"<>]*\\{known_dir}(\\[^\s\'"<>]*)?', re.IGNORECASE)
            rep = f"项目 {known_dir}/ 目录" if lang == "zh" else f"{known_dir}/ directory"
            text = pat.sub(rep, text)

        # 4. 正则清洗一般 Windows 盘符路径
        def _win_replace(match):
            sub_dir = match.group(1)
            if lang == "zh":
                return f"项目 {sub_dir}/ 目录"
            return f"{sub_dir}/ directory"

        text = cls.WIN_DIR_PATTERN.sub(_win_replace, text)

        # 5. 正则清洗 Unix /Users 路径
        def _unix_replace(match):
            sub_dir = match.group(1)
            if lang == "zh":
                return f"项目 {sub_dir}/ 目录"
            return f"{sub_dir}/ directory"

        text = cls.UNIX_USER_PATH_PATTERN.sub(_unix_replace, text)

        return text

    @classmethod
    def sanitize_secrets(cls, text: str) -> str:
        """物理抹除所有已知的 API Token、密钥与敏感凭证。"""
        if not text or not isinstance(text, str):
            return text or ""

        for pat in cls.API_KEY_PATTERNS:
            text = pat.sub("[REDACTED_SECRET]", text)
        return text

    @classmethod
    def clean(cls, text: str, workspace_root: Optional[str] = None, lang: str = "zh", normalize_dates: bool = True) -> str:
        """一站式执行路径脱敏、凭据清洗与相对日期规范化。"""
        if not text:
            return ""
        text = cls.sanitize_paths(text, workspace_root=workspace_root, lang=lang)
        text = cls.sanitize_secrets(text)
        if normalize_dates:
            text = DateNormalizer.normalize(text, lang=lang)
        return text


class DateNormalizer:
    """生产级相对时间转绝对日期规范化器 (Phase 61 核心硬内化)。
    
    自动识别中英文相对时间表述并精确换算为绝对 ISO 日期 (YYYY-MM-DD):
    - 昨天 / yesterday -> (today - 1 day)
    - 前天 / day before yesterday -> (today - 2 days)
    - 今天 / today -> today
    - 上周 / last week -> (today - 7 days)
    - N天前 / N days ago -> (today - N days)
    - 上个月 / last month -> (today - 30 days)
    采用单遍正则联合匹配 (Single-pass Regex Union)，杜绝级联误伤与二次替换。
    """

    @classmethod
    def normalize(cls, text: str, ref_time: Optional[float] = None, lang: str = "zh") -> str:
        """将文本中的相对时间短语确定性换算为绝对 ISO 日期。"""
        if not text or not isinstance(text, str):
            return text or ""

        import datetime
        import time

        base_dt = datetime.datetime.fromtimestamp(ref_time if ref_time is not None else time.time())
        
        today_str = base_dt.strftime("%Y-%m-%d")
        yesterday_str = (base_dt - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
        day_before_str = (base_dt - datetime.timedelta(days=2)).strftime("%Y-%m-%d")
        last_week_str = (base_dt - datetime.timedelta(days=7)).strftime("%Y-%m-%d")
        last_month_str = (base_dt - datetime.timedelta(days=30)).strftime("%Y-%m-%d")

        # 构造从长到短的正则模式，使用命名捕获或单遍分发
        pattern = re.compile(
            r'(?P<en_db_yest>\bthe\s+day\s+before\s+yesterday\b)|'
            r'(?P<en_yest>\byesterday\b)|'
            r'(?P<en_today>\btoday\b)|'
            r'(?P<en_last_week>\blast\s+week\b)|'
            r'(?P<en_last_month>\blast\s+month\b)|'
            r'(?P<en_days_ago>\b(\d+)\s*days?\s*ago\b)|'
            r'(?P<en_weeks_ago>\b(\d+)\s*weeks?\s*ago\b)|'
            r'(?P<en_months_ago>\b(\d+)\s*months?\s*ago\b)|'
            r'(?P<zh_db_yest>(?<![0-9A-Za-z\-])前天(?![0-9A-Za-z\-]))|'
            r'(?P<zh_yest>(?<![0-9A-Za-z\-])昨天(?![0-9A-Za-z\-]))|'
            r'(?P<zh_today>(?<![0-9A-Za-z\-])今天(?![0-9A-Za-z\-]))|'
            r'(?P<zh_last_week>(?<![0-9A-Za-z\-])上周(?![0-9A-Za-z\-]))|'
            r'(?P<zh_last_month>(?<![0-9A-Za-z\-])上个月(?![0-9A-Za-z\-]))|'
            r'(?P<zh_days_ago>(?<![0-9A-Za-z\-])(\d+)\s*天前(?![0-9A-Za-z\-]))|'
            r'(?P<zh_weeks_ago>(?<![0-9A-Za-z\-])(\d+)\s*周前(?![0-9A-Za-z\-]))|'
            r'(?P<zh_months_ago>(?<![0-9A-Za-z\-])(\d+)\s*个月前(?![0-9A-Za-z\-]))',
            re.IGNORECASE
        )

        def _replacer(m):
            g = m.lastgroup
            val = m.group(0)
            if g == 'en_db_yest':
                return f"{day_before_str} (the day before yesterday)"
            elif g == 'en_yest':
                return f"{yesterday_str} (yesterday)"
            elif g == 'en_today':
                return f"{today_str} (today)"
            elif g == 'en_last_week':
                return f"{last_week_str} (last week)"
            elif g == 'en_last_month':
                return f"{last_month_str} (last month)"
            elif g == 'en_days_ago':
                num = int(re.search(r'\d+', val).group(0))
                dt = (base_dt - datetime.timedelta(days=num)).strftime("%Y-%m-%d")
                return f"{dt} ({num} days ago)"
            elif g == 'en_weeks_ago':
                num = int(re.search(r'\d+', val).group(0))
                dt = (base_dt - datetime.timedelta(days=num * 7)).strftime("%Y-%m-%d")
                return f"{dt} ({num} weeks ago)"
            elif g == 'en_months_ago':
                num = int(re.search(r'\d+', val).group(0))
                dt = (base_dt - datetime.timedelta(days=num * 30)).strftime("%Y-%m-%d")
                return f"{dt} ({num} months ago)"
            elif g == 'zh_db_yest':
                return f"{day_before_str} (前天)"
            elif g == 'zh_yest':
                return f"{yesterday_str} (昨天)"
            elif g == 'zh_today':
                return f"{today_str} (今天)"
            elif g == 'zh_last_week':
                return f"{last_week_str} (上周)"
            elif g == 'zh_last_month':
                return f"{last_month_str} (上个月)"
            elif g == 'zh_days_ago':
                num = int(re.search(r'\d+', val).group(0))
                dt = (base_dt - datetime.timedelta(days=num)).strftime("%Y-%m-%d")
                return f"{dt} ({num}天前)"
            elif g == 'zh_weeks_ago':
                num = int(re.search(r'\d+', val).group(0))
                dt = (base_dt - datetime.timedelta(days=num * 7)).strftime("%Y-%m-%d")
                return f"{dt} ({num}周前)"
            elif g == 'zh_months_ago':
                num = int(re.search(r'\d+', val).group(0))
                dt = (base_dt - datetime.timedelta(days=num * 30)).strftime("%Y-%m-%d")
                return f"{dt} ({num}个月前)"
            return val

        return pattern.sub(_replacer, text)


class OutputSanitizer:
    """Output sanitizer bridge for event bus and message sanitization."""
    def mount(self, bus):
        pass

    def sanitize(self, text: str, workspace_root: Optional[str] = None) -> str:
        return PrivacySanitizer.clean(text, workspace_root=workspace_root)


_global_output_sanitizer: Optional[OutputSanitizer] = None


def get_output_sanitizer() -> OutputSanitizer:
    global _global_output_sanitizer
    if _global_output_sanitizer is None:
        _global_output_sanitizer = OutputSanitizer()
    return _global_output_sanitizer


def sanitize_text(text: str, workspace_root: Optional[str] = None) -> str:
    """Convenience functional helper for text sanitization."""
    return PrivacySanitizer.clean(text, workspace_root=workspace_root)




