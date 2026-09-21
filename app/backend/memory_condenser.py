"""
memory_condenser.py — Ovolve Project Memory Condensation Engine (v1.0).

Condense shallow mementos into durable project memory:
Provides an automated and agent-callable condensation routine to keep
project-level MEMORY.md within the 200 lines / 2500 tokens budget.
"""
from __future__ import annotations

import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from project_memory_protocol import (
    DecisionRecord,
    ProjectMemoryDocument,
    MAX_MEMORY_LINES,
    MAX_MEMORY_TOKENS,
    validate_memory_budget,
)


def condense_document(
    doc: ProjectMemoryDocument,
    max_decisions: int = 15,
    max_practices: int = 10,
    max_conventions: int = 20,
) -> Tuple[ProjectMemoryDocument, Dict[str, Any]]:
    """Perform deterministic rule-based condensation on a ProjectMemoryDocument."""
    stats = {
        "original_decisions": len(doc.decisions),
        "original_conventions": len(doc.conventions),
        "original_practices": len(doc.practices),
        "pruned_decisions": 0,
        "pruned_conventions": 0,
        "pruned_practices": 0,
    }

    # 1. Deduplicate conventions (case-insensitive substring overlap)
    unique_conv: List[str] = []
    seen_conv = set()
    for c in doc.conventions:
        norm = re.sub(r"\s+", " ", c.strip().lower().lstrip("- "))
        if norm and norm not in seen_conv:
            seen_conv.add(norm)
            unique_conv.append(c)
    if len(unique_conv) > max_conventions:
        stats["pruned_conventions"] = len(unique_conv) - max_conventions
        unique_conv = unique_conv[:max_conventions]
    doc.conventions = unique_conv

    # 2. Deduplicate practices
    unique_prac: List[str] = []
    seen_prac = set()
    for p in doc.practices:
        norm = re.sub(r"\s+", " ", p.strip().lower().lstrip("- "))
        if norm and norm not in seen_prac:
            seen_prac.add(norm)
            unique_prac.append(p)
    if len(unique_prac) > max_practices:
        stats["pruned_practices"] = len(unique_prac) - max_practices
        unique_prac = unique_prac[:max_practices]
    doc.practices = unique_prac

    # 3. Compact decisions: keep most recent N, summarize older ones into consolidated milestone
    if len(doc.decisions) > max_decisions:
        stats["pruned_decisions"] = len(doc.decisions) - max_decisions
        # Sort by date if available
        sorted_dec = sorted(doc.decisions, key=lambda d: d.date)
        older = sorted_dec[:-max_decisions]
        kept = sorted_dec[-max_decisions:]

        # Create one milestone line for the older decisions
        if older:
            start_d = older[0].date
            end_d = older[-1].date
            summary_dec = DecisionRecord(
                date=f"{start_d}..{end_d}",
                decision=f"早期历史决策聚合归档（共 {len(older)} 项历史演进）",
                reason="遵循容量守护协议进行周期性浓缩",
                impact="历史细节已精简，当前工程主线保持清晰",
                source="memory_condenser",
            )
            kept.insert(0, summary_dec)
        doc.decisions = kept

    return doc, stats


def condense_memory_file(
    filepath: str,
    force: bool = False,
) -> Dict[str, Any]:
    """Inspect and condense a project MEMORY.md file if needed or forced."""
    if not os.path.isfile(filepath):
        return {"status": "error", "message": f"File not found: {filepath}"}

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            raw_text = f.read()
    except Exception as exc:
        return {"status": "error", "message": f"Read failed: {exc}"}

    budget_before = validate_memory_budget(raw_text)
    if not force and budget_before["valid"]:
        return {
            "status": "skipped",
            "message": "Memory file is within budget; no condensation required.",
            "budget": budget_before,
        }

    doc = ProjectMemoryDocument.parse(raw_text)
    doc, stats = condense_document(doc)
    new_text = doc.to_markdown()
    budget_after = validate_memory_budget(new_text)

    try:
        # Atomic write to avoid file corruption
        tmp_path = filepath + f".tmp.{int(time.time() * 1000)}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(new_text)
        os.replace(tmp_path, filepath)
    except Exception as exc:
        return {"status": "error", "message": f"Write failed: {exc}"}

    return {
        "status": "success",
        "before": budget_before,
        "after": budget_after,
        "stats": stats,
    }
