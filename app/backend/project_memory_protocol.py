"""
project_memory_protocol.py — Ovolve Project Memory Protocol (v1.0).

Implements:
1. Strict 5-section standard structure for project-level MEMORY.md:
   - ## 1. 项目概览 (Overview)
   - ## 2. 当前状态 (Current Status)
   - ## 3. 稳定信息与工作约定 (Conventions & Ground Rules)
   - ## 4. 决策记录 (Decision Log: [YYYY-MM-DD] decision; reason; impact; source)
   - ## 5. 可复用经验与最佳实践 (Reusable Practices)
2. Capacity guardrails:
   - Target line cap: 200 lines
   - Token budget: 2500 tokens
3. Explicit persistence intent gating:
   - Rejects silent speculative writes when the user did not express durable intent.
"""
from __future__ import annotations

import glob
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

PROTOCOL_VERSION = "2026-09-19.ovolve-project-memory.v1"
MAX_MEMORY_LINES = 200
MAX_MEMORY_TOKENS = 2500

SECTION_TITLES = [
    "1. 项目概览",
    "2. 当前状态",
    "3. 稳定信息与工作约定",
    "4. 决策记录",
    "5. 可复用经验与最佳实践",
]

# Explicit intent regex for durable memory persistence
_INTENT_PATTERNS = [
    r"记住",
    r"存入记忆",
    r"写入记忆",
    r"保存(?:到)?记忆",
    r"保存下来",
    r"记录下来",
    r"作为(?:团队|工程)?(?:工作)?(?:规范|约定)",
    r"工作约定",
    r"更新(?:项目)?记忆",
    r"忘记",
    r"删除记忆",
    r"整理记忆",
    r"\bremember\b",
    r"\bsave\s+(?:to\s+)?memory\b",
    r"\bupdate\s+memory\b",
    r"\bkeep\s+in\s+mind\b",
]
_COMPILED_INTENTS = [re.compile(p, re.IGNORECASE) for p in _INTENT_PATTERNS]

# Inquiry phrases that shouldn't trigger persistence writes
_INQUIRY_PATTERNS = [
    r"^(?:你能|你会)?记住什么",
    r"查(?:询|看)记忆",
    r"什么是记忆",
    r"how\s+do\s+you\s+remember",
]
_COMPILED_INQUIRIES = [re.compile(p, re.IGNORECASE) for p in _INQUIRY_PATTERNS]


def is_explicit_persistence_intent(user_text: str) -> bool:
    """Check if the user prompt explicitly requested durable memory storage."""
    text = (user_text or "").strip()
    if not text:
        return False

    # Inquiries do not count as persistence requests
    for inq in _COMPILED_INQUIRIES:
        if inq.search(text):
            return False

    for pat in _COMPILED_INTENTS:
        if pat.search(text):
            return True

    return False


@dataclass
class DecisionRecord:
    date: str
    decision: str
    reason: str = ""
    impact: str = ""
    source: str = ""

    def format_line(self) -> str:
        parts = [f"[{self.date}] {self.decision}"]
        if self.reason:
            parts.append(f"原因：{self.reason}")
        if self.impact:
            parts.append(f"影响：{self.impact}")
        if self.source:
            parts.append(f"来源：{self.source}")
        return "- " + "；".join(parts)

    @classmethod
    def parse_line(cls, line: str) -> Optional[DecisionRecord]:
        raw = line.strip()
        if raw.startswith("-"):
            raw = raw[1:].strip()
        m = re.match(r"^\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$", raw)
        if not m:
            return None
        dt, body = m.group(1), m.group(2)
        chunks = [c.strip() for c in re.split(r"[；;]", body) if c.strip()]
        decision = chunks[0] if chunks else ""
        reason = ""
        impact = ""
        source = ""
        for chunk in chunks[1:]:
            if chunk.startswith("原因：") or chunk.startswith("原因:"):
                reason = chunk[3:].strip()
            elif chunk.startswith("影响：") or chunk.startswith("影响:"):
                impact = chunk[3:].strip()
            elif chunk.startswith("来源：") or chunk.startswith("来源:"):
                source = chunk[3:].strip()
            else:
                if not reason:
                    reason = chunk
                elif not impact:
                    impact = chunk
                else:
                    source = chunk
        return cls(date=dt, decision=decision, reason=reason, impact=impact, source=source)


@dataclass
class ProjectMemoryDocument:
    overview: List[str] = field(default_factory=list)
    current_status: List[str] = field(default_factory=list)
    conventions: List[str] = field(default_factory=list)
    decisions: List[DecisionRecord] = field(default_factory=list)
    practices: List[str] = field(default_factory=list)

    def to_markdown(self) -> str:
        lines: List[str] = [
            f"# 项目记忆（PROJECT MEMORY）· {PROTOCOL_VERSION}",
            "",
            "> 本文件为项目级接力摘要与工程基线规范。受 200 行 / 2500 tokens 容量红线保护。",
            "",
        ]

        sections = [
            ("## 1. 项目概览", self.overview),
            ("## 2. 当前状态", self.current_status),
            ("## 3. 稳定信息与工作约定", self.conventions),
        ]

        for heading, items in sections:
            lines.append(heading)
            if not items:
                lines.append("- （暂无）")
            else:
                for item in items:
                    clean = item.strip()
                    if not clean.startswith("-"):
                        clean = "- " + clean
                    lines.append(clean)
            lines.append("")

        lines.append("## 4. 决策记录")
        if not self.decisions:
            lines.append("- （暂无）")
        else:
            for dec in self.decisions:
                lines.append(dec.format_line())
        lines.append("")

        lines.append("## 5. 可复用经验与最佳实践")
        if not self.practices:
            lines.append("- （暂无）")
        else:
            for prac in self.practices:
                clean = prac.strip()
                if not clean.startswith("-"):
                    clean = "- " + clean
                lines.append(clean)
        lines.append("")

        return "\n".join(lines)

    @classmethod
    def parse(cls, markdown_text: str) -> ProjectMemoryDocument:
        doc = cls()
        current_sec: Optional[int] = None
        lines = markdown_text.splitlines()

        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("# ") or stripped.startswith(">"):
                continue

            if stripped.startswith("## 1.") or "项目概览" in stripped:
                current_sec = 1
                continue
            elif stripped.startswith("## 2.") or "当前状态" in stripped:
                current_sec = 2
                continue
            elif stripped.startswith("## 3.") or "稳定信息" in stripped or "工作约定" in stripped:
                current_sec = 3
                continue
            elif stripped.startswith("## 4.") or "决策记录" in stripped:
                current_sec = 4
                continue
            elif stripped.startswith("## 5.") or "可复用经验" in stripped or "最佳实践" in stripped:
                current_sec = 5
                continue
            elif stripped.startswith("##"):
                current_sec = None
                continue

            if current_sec is None or stripped == "- （暂无）":
                continue

            if current_sec == 1:
                doc.overview.append(stripped)
            elif current_sec == 2:
                doc.current_status.append(stripped)
            elif current_sec == 3:
                doc.conventions.append(stripped)
            elif current_sec == 4:
                rec = DecisionRecord.parse_line(stripped)
                if rec:
                    doc.decisions.append(rec)
                else:
                    doc.decisions.append(
                        DecisionRecord(
                            date=time.strftime("%Y-%m-%d"),
                            decision=stripped.lstrip("- ").strip(),
                        )
                    )
            elif current_sec == 5:
                doc.practices.append(stripped)

        return doc


def estimate_token_count(text: str) -> int:
    """Fast, deterministic heuristic token count estimate.
    
    Chars in CJK languages roughly translate to ~0.7-1 token, while English
    words translate to ~1.3 tokens. 2.5 characters per token is a safe benchmark.
    """
    if not text:
        return 0
    return max(1, len(text) // 2)


def validate_memory_budget(markdown_text: str) -> Dict[str, Any]:
    """Validate whether the memory markdown file complies with the capacity guardrail."""
    lines = markdown_text.splitlines()
    line_count = len(lines)
    token_count = estimate_token_count(markdown_text)

    exceeds_lines = line_count > MAX_MEMORY_LINES
    exceeds_tokens = token_count > MAX_MEMORY_TOKENS
    is_valid = not (exceeds_lines or exceeds_tokens)

    return {
        "valid": is_valid,
        "lines": line_count,
        "max_lines": MAX_MEMORY_LINES,
        "tokens": token_count,
        "max_tokens": MAX_MEMORY_TOKENS,
        "exceeds_lines": exceeds_lines,
        "exceeds_tokens": exceeds_tokens,
    }


class DualTierMemoryManager:
    """Manages the two-tier memory hierarchy:
    
    1. Top-level MEMORY.md: High-level overview, conventions, decisions, and
       hyperlinks to slice files, strictly limited to 200 lines / 2500 tokens.
    2. Slice files in .ovolve/memory/:
       - daily/daily-YYYY-MM-DD.md: Chronological activity & session log.
       - topics/topic-<topic_id>.md: Deep-dive topic slices with YAML frontmatter.
    """

    def __init__(self, workspace_root: str):
        self.workspace_root = os.path.abspath(workspace_root)
        self.memory_dir = os.path.join(self.workspace_root, ".ovolve", "memory")
        self.daily_dir = os.path.join(self.memory_dir, "daily")
        self.topics_dir = os.path.join(self.memory_dir, "topics")

    def _ensure_dirs(self) -> None:
        os.makedirs(self.daily_dir, exist_ok=True)
        os.makedirs(self.topics_dir, exist_ok=True)

    def append_daily_log(
        self,
        text: str,
        session_id: str = "",
        date_str: Optional[str] = None,
    ) -> str:
        self._ensure_dirs()
        ds = date_str or time.strftime("%Y-%m-%d")
        daily_path = os.path.join(self.daily_dir, f"daily-{ds}.md")
        
        is_new = not os.path.exists(daily_path)
        t_str = time.strftime("%H:%M:%S")
        sess_prefix = f" [session: {session_id}]" if session_id else ""
        entry = f"- [{t_str}]{sess_prefix} {text.strip()}\n"

        with open(daily_path, "a", encoding="utf-8") as f:
            if is_new:
                f.write(f"# 活动与记忆日记 ({ds})\n\n")
            f.write(entry)
            
        return daily_path

    def create_or_update_topic_slice(
        self,
        topic_id: str,
        title: str,
        content: str,
        tags: Optional[List[str]] = None,
    ) -> str:
        self._ensure_dirs()
        safe_topic = re.sub(r"[^\w\-]", "-", topic_id).strip("-").lower()
        filename = f"topic-{safe_topic}.md"
        topic_path = os.path.join(self.topics_dir, filename)

        tags_str = ", ".join(f'"{t}"' for t in (tags or []))
        updated_at = time.strftime("%Y-%m-%d %H:%M:%S")

        slice_text = (
            f"---\n"
            f"topic: {topic_id}\n"
            f"title: {title}\n"
            f"tags: [{tags_str}]\n"
            f"updated_at: \"{updated_at}\"\n"
            f"---\n\n"
            f"# {title}\n\n"
            f"{content.strip()}\n"
        )

        with open(topic_path, "w", encoding="utf-8") as f:
            f.write(slice_text)

        return topic_path

    def sync_index(self) -> str:
        import glob
        self._ensure_dirs()
        mem_file = os.path.join(self.workspace_root, "MEMORY.md")
        
        doc = ProjectMemoryDocument()
        if os.path.exists(mem_file):
            try:
                with open(mem_file, "r", encoding="utf-8") as f:
                    doc = ProjectMemoryDocument.parse(f.read())
            except Exception:
                pass

        # Scan recent daily logs (latest 7 days)
        daily_files = sorted(
            glob.glob(os.path.join(self.daily_dir, "daily-*.md")),
            reverse=True,
        )
        # Scan topic files
        topic_files = sorted(glob.glob(os.path.join(self.topics_dir, "topic-*.md")))

        # Rebuild status section with slice index links
        non_index_status = [
            item for item in doc.current_status
            if not ("daily-" in item or "topic-" in item or "记忆切片索引" in item)
        ]
        
        slice_links = ["活跃记忆切片索引与追踪："]
        for df in daily_files[:7]:
            bname = os.path.basename(df)
            rel = f".ovolve/memory/daily/{bname}"
            slice_links.append(f"日记索引: [{bname}]({rel})")

        for tf in topic_files[:15]:
            bname = os.path.basename(tf)
            rel = f".ovolve/memory/topics/{bname}"
            title = bname
            try:
                with open(tf, "r", encoding="utf-8") as f:
                    for line in f:
                        if line.startswith("title:"):
                            title = line.replace("title:", "").strip().strip('"\'')
                            break
            except Exception:
                pass
            slice_links.append(f"主题切片: [{title}]({rel})")

        doc.current_status = non_index_status + slice_links
        
        markdown_text = doc.to_markdown()
        
        # Verify budget guardrail
        budget = validate_memory_budget(markdown_text)
        if not budget["valid"]:
            lines = markdown_text.splitlines()[:MAX_MEMORY_LINES]
            markdown_text = "\n".join(lines)

        with open(mem_file, "w", encoding="utf-8") as f:
            f.write(markdown_text)

        # Mirror into .ovolve/memory/MEMORY.md
        ovolve_mem = os.path.join(self.memory_dir, "MEMORY.md")
        try:
            with open(ovolve_mem, "w", encoding="utf-8") as f:
                f.write(markdown_text)
        except Exception:
            pass

        return mem_file
