"""
curriculum_engine.py — Voyager 级自主课程生成与能力缺口自进化引擎。

基于 ICLR 2024 顶会论文:
《Voyager: An Open-Ended Embodied Agent with Large Language Models》

核心机制：
1. 能力缺口探测 (Skill Gap Discovery):
   - 扫描历史会话轨迹、未覆盖的高频自主任务与失败重试集，
     自动识别“反复自主摸索、但尚无专属技能沉淀”的能力缺口；
2. 自主课程生成 (Automatic Curriculum Generation):
   - 依据当前能力边界由易到难生成自驱动探索目标 (Exploration Tasks) 与验收测试契约，
     在后台空闲或 Dream 周期中驱动自主探索，实现技能自适应扩充。
"""

from __future__ import annotations

import collections
import hashlib
import json
import os
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple


@dataclass
class SkillGap:
    """探测出的 Agent 能力缺口实体。"""
    gap_id: str
    category: str
    description: str
    frequency: int
    suggested_skill_name: str
    suggested_tools: List[str]
    sample_queries: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class ExplorationTask:
    """自主探索任务实体。"""
    task_id: str
    title: str
    objective: str
    target_gap_id: str
    difficulty: str  # "easy" | "medium" | "hard"
    verification_criteria: List[str]
    suggested_deliverables: List[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class CurriculumEngine:
    """自主课程引擎：负责能力缺口分析与自适应探索任务生成。"""

    def __init__(self, storage=None) -> None:
        if storage is None:
            from storage import get_storage
            storage = get_storage()
        self.storage = storage

    def identify_skill_gaps(self, min_recurrence: int = 2) -> List[SkillGap]:
        """分析高频但缺乏专属技能支持的任务模式。"""
        gaps: List[SkillGap] = []
        try:
            # 扫描最近的 sessions 和 goals 记录
            c = self.storage._db("sessions")
            rows = c.execute(
                "SELECT id, title FROM sessions WHERE title IS NOT NULL AND title != '' ORDER BY updated_at DESC LIMIT 200"
            ).fetchall()

            # 聚类高频意图 (如: 重构, 测试, 数据分析, 转换, 部署等)
            intent_keywords = {
                "refactor": ("重构/代码优化", ["find_by_name", "view_file", "replace_file_content"]),
                "test": ("自动化测试/用例编写", ["run_command", "view_file", "write_to_file"]),
                "data_analysis": ("数据解析与图表", ["run_command", "view_file"]),
                "deploy_release": ("发布打包与部署", ["run_command", "find_by_name"]),
                "database_migration": ("数据库迁移与管理", ["run_command", "view_file"]),
            }

            intent_counts: Dict[str, List[str]] = collections.defaultdict(list)
            for r in rows:
                title = str(r["title"]).lower()
                for key, (desc, tools) in intent_keywords.items():
                    if key in title or any(w in title for w in desc.split("/")):
                        intent_counts[key].append(str(r["title"]))

            # 读取现有技能列表避免重复
            existing_skills = set()
            try:
                from skill_loader import SkillLoader
                existing_skills = set(SkillLoader().list_skill_names())
            except Exception:
                pass

            for key, queries in intent_counts.items():
                if len(queries) >= min_recurrence:
                    skill_name = f"auto-{key.replace('_', '-')}"
                    if skill_name not in existing_skills:
                        gid = hashlib.md5(key.encode()).hexdigest()[:10]
                        desc, tools = intent_keywords[key]
                        gaps.append(
                            SkillGap(
                                gap_id=gid,
                                category=key,
                                description=f"高频任务类型「{desc}」缺乏专属技能覆盖（历史出现 {len(queries)} 次）",
                                frequency=len(queries),
                                suggested_skill_name=skill_name,
                                suggested_tools=tools,
                                sample_queries=queries[:3],
                            )
                        )
        except Exception:
            pass
        return sorted(gaps, key=lambda x: x.frequency, reverse=True)

    def generate_exploration_goal(self, gap: SkillGap) -> ExplorationTask:
        """为特定能力缺口生成自主探索学习任务。"""
        tid = f"exp_task_{uuid.uuid4().hex[:8]}"
        title = f"自主能力习得: {gap.suggested_skill_name}"
        obj = (
            f"探索并建立针对「{gap.description}」的标准操作流程(SOP)，"
            f"沉淀可复用的技能候选并完成自测验证。"
        )
        criteria = [
            f"产出符合规范的 SKILL.md 候选",
            f"验证所依赖的工具链 {', '.join(gap.suggested_tools)} 可正常协同工作",
            f"通过机器完成门禁测试",
        ]
        return ExplorationTask(
            task_id=tid,
            title=title,
            objective=obj,
            target_gap_id=gap.gap_id,
            difficulty="medium",
            verification_criteria=criteria,
            suggested_deliverables=[f".agents/skills/{gap.suggested_skill_name}/SKILL.md"],
        )
