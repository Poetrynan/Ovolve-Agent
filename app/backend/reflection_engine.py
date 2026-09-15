"""
reflection_engine.py — Reflexion 级显式自然语言自我反思与情景记忆引擎。

基于 NeurIPS 2023 顶会论文:
《Reflexion: Language Agents with Verbal Reinforcement Learning》

核心设计：
1. 错误感知与反思生成 (ReflectionGenerator):
   - 当工具调用失败、步骤异常或机器验收门禁 (Verification Gate) 拦截时，
     提取具体的失败上下文，即时生成结构化自然语言反思；
   - 包含四大维度：
     * root_cause (根因分析)
     * alternative_strategy (替代策略)
     * prevention_rule (前置防范规则)
     * applicability_boundary (适用边界)
2. 情景记忆持久化 (Episodic Ingestion):
   - 将反思作为 `type="reflection"` 写入 `MemoryTier.SHORT_TERM_RECALL` / `MemoryTier.SEMANTIC`，
     并附带场景标签 `["reflection", tool_name, ...]` 与 SQLite 索引；
3. 动态召回与防二次踩坑注入 (Prompt Injection):
   - 在后续用户回合或调用工具前，按语义相关性与工具名检索最高置信度的反思条目，
     注入 `<reflections>` 上下文，彻底杜绝同类错误反复出现。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple


@dataclass
class Reflection:
    """结构化自我反思实体。"""
    id: str
    scenario: str
    root_cause: str
    alternative_strategy: str
    prevention_rule: str
    applicability_boundary: str = "general"
    confidence: float = 0.85
    tags: List[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    session_id: str = ""
    source_tool: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Reflection":
        return cls(
            id=str(data.get("id") or uuid.uuid4()),
            scenario=str(data.get("scenario") or ""),
            root_cause=str(data.get("root_cause") or ""),
            alternative_strategy=str(data.get("alternative_strategy") or ""),
            prevention_rule=str(data.get("prevention_rule") or ""),
            applicability_boundary=str(data.get("applicability_boundary") or "general"),
            confidence=float(data.get("confidence") or 0.85),
            tags=list(data.get("tags") or []),
            created_at=float(data.get("created_at") or time.time()),
            session_id=str(data.get("session_id") or ""),
            source_tool=str(data.get("source_tool") or ""),
        )

    def format_for_prompt(self) -> str:
        """格式化为适合 LLM 理解的紧凑提示。"""
        tool_tag = f"[{self.source_tool}] " if self.source_tool else ""
        return (
            f"- {tool_tag}针对场景「{self.scenario}」的反思:\n"
            f"  * 根因分析: {self.root_cause}\n"
            f"  * 替代策略: {self.alternative_strategy}\n"
            f"  * 前置防范规则: {self.prevention_rule}"
        )


class ReflectionGenerator:
    """反思生成器：将执行失败转化为可落地的结构化反思。"""

    def __init__(self, llm_fn: Optional[Callable] = None) -> None:
        self._llm = llm_fn

    async def generate_from_tool_failure(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
        error_message: str,
        context: str = "",
        session_id: str = "",
    ) -> Reflection:
        """从工具调用失败生成反思。"""
        args_str = json.dumps(arguments, ensure_ascii=False)[:300]
        err_str = str(error_message)[:400]

        # 优先使用启发式快速提取，保证即使无 LLM 也能产生高质量反思
        root_cause, alt_strat, prev_rule = self._heuristic_tool_reflection(
            tool_name, arguments, err_str
        )

        # 若配置了 LLM 且属于复杂错误，可异步增强
        if self._llm and ("not found" not in err_str.lower() and "syntax" not in err_str.lower()):
            try:
                prompt = (
                    "You are the Reflexion Engine of an AI agent. An action failed. "
                    "Analyze the failure and produce a structured self-reflection.\n\n"
                    f"TOOL: {tool_name}\n"
                    f"ARGUMENTS: {args_str}\n"
                    f"ERROR: {err_str}\n"
                    f"CONTEXT: {context[:300]}\n\n"
                    "Respond with ONLY a JSON object:\n"
                    '{"root_cause": "<concise reason>", "alternative_strategy": "<what to do instead>", '
                    '"prevention_rule": "<rule to remember>", "applicability_boundary": "<boundary>"}'
                )
                res = await self._llm(prompt) if asyncio.iscoroutinefunction(self._llm) else self._llm(prompt)
                if isinstance(res, str):
                    m = re.search(r"\{.*\}", res, re.DOTALL)
                    if m:
                        data = json.loads(m.group(0))
                        root_cause = data.get("root_cause") or root_cause
                        alt_strat = data.get("alternative_strategy") or alt_strat
                        prev_rule = data.get("prevention_rule") or prev_rule
            except Exception:
                pass  # fail-open: 保留启发式提取结果

        return Reflection(
            id=str(uuid.uuid4()),
            scenario=f"调用工具 {tool_name} 执行失败",
            root_cause=root_cause,
            alternative_strategy=alt_strat,
            prevention_rule=prev_rule,
            source_tool=tool_name,
            tags=["reflection", "tool_failure", tool_name],
            session_id=session_id,
        )

    async def generate_from_gate_failure(
        self,
        unmet_criteria: List[str],
        failing_evidence: str = "",
        session_id: str = "",
    ) -> Reflection:
        """从机器验收门禁 (Verification Gate) 失败生成反思。"""
        unmet_summary = "; ".join(unmet_criteria[:3])
        return Reflection(
            id=str(uuid.uuid4()),
            scenario="机器验收门禁 (Verification Gate) 未通过",
            root_cause=f"以下验收条件未达成: {unmet_summary}",
            alternative_strategy="先针对未通过的测试用例/缺失产物进行局部修复并本地验证，全绿后再标记完成",
            prevention_rule="严禁在测试未通过时提前收工，必须先执行自测并修复报错",
            source_tool="verification_gate",
            tags=["reflection", "gate_failure", "anti_early_quit"],
            session_id=session_id,
        )

    def _heuristic_tool_reflection(
        self, tool_name: str, arguments: Dict[str, Any], error: str
    ) -> Tuple[str, str, str]:
        """针对常见工具错误模式的高精度启发式反思库。"""
        err_lower = error.lower()
        if "file not found" in err_lower or "no such file" in err_lower or "does not exist" in err_lower:
            target = arguments.get("path") or arguments.get("TargetFile") or arguments.get("file_path") or "文件"
            return (
                f"尝试操作的目标路径 `{target}` 不存在。",
                f"在操作前先调用 list_dir / find_by_name 确认文件真实路径或先创建对应目录。",
                f"任何文件读写/替换前，必须确保目标文件已存在或先初始化该文件。",
            )
        if "targetcontent" in err_lower or "not found in file" in err_lower or "replace" in err_lower:
            return (
                "replace_file_content 替换块与现有文件内容不完全匹配（包含缩进、空格或换行差异）。",
                "先使用 view_file 查看最新精确代码行与行号，再执行精准替换，避免盲目猜测。",
                "代码编辑时必须保证 targetContent 与源文件字符及缩进 100% 严格一致。",
            )
        if "permission" in err_lower or "denied" in err_lower or "policy" in err_lower:
            return (
                f"操作触发了安全策略限制或越权拦截: {error[:100]}",
                "限制在当前工作区 (workspace) 内操作，使用只读或标准沙箱工具，避免操作敏感系统文件。",
                "遵守路径边界策略，绝不越权访问上级敏感目录。",
            )
        if "timeout" in err_lower:
            return (
                f"命令/工具执行超时: {error[:100]}",
                "拆分大任务为更小的子步骤，或增加单次命令超时阈值，避免单次执行过长耗时命令。",
                "耗时构建或测试操作应控制在限定执行时长内，必要时转入后台或拆步执行。",
            )

        return (
            f"工具执行异常: {error[:150]}",
            "检查输入参数格式与前置环境依赖，调整参数后重试。",
            "调用工具前仔细阅读工具参数规范并校验必填字段。",
        )


class ReflectionStore:
    """反思存储与召回管理器：负责反思的落库、搜索与上下文注入。"""

    def __init__(self, storage=None) -> None:
        if storage is None:
            from storage import get_storage
            storage = get_storage()
        self.storage = storage

    def save_reflection(self, reflection: Reflection) -> bool:
        """将反思持久化至记忆系统。"""
        try:
            from memory_tiers import MemoryTier
            content = json.dumps(reflection.to_dict(), ensure_ascii=False)
            self.storage.save_memory_entry(
                eid=reflection.id,
                sid=reflection.session_id,
                root=getattr(self.storage, "_active_workspace", "") or "",
                scope="project",
                content=content,
                meta={"tags": reflection.tags, "source_tool": reflection.source_tool},
                mem_type="reflection",
                importance=reflection.confidence,
                tags=reflection.tags,
                tier=MemoryTier.SHORT_TERM_RECALL,
                created_by="evolution",
            )
            # Phase 60 联动: 高置信度反思自动提交至 EvolutionEngine 待审提案
            self._bridge_reflection_to_evolution(reflection)
            return True
        except Exception:
            return False

    def _bridge_reflection_to_evolution(self, reflection: Reflection) -> bool:
        """Phase 60 联动: 将高置信度反思前置防范规则自动向 EvolutionEngine 提议为自进化提案。"""
        if not reflection.prevention_rule or reflection.confidence < 0.85:
            return False
        try:
            from evolution import EvolutionEngine, Proposal
            ws = getattr(self.storage, "_active_workspace", "") or ""
            engine = EvolutionEngine(workspace_root=ws, storage=self.storage)
            
            sig = f"reflection:{reflection.source_tool or 'general'}:{reflection.scenario[:30]}"
            if engine.store.has_open_for_signature(sig):
                return False
                
            prop = Proposal(
                id=uuid.uuid4().hex[:16],
                signature=sig,
                kind="tool_failure",
                tool_name=reflection.source_tool,
                target_file="AGENTS.md",
                draft=f"- [Rule] {reflection.prevention_rule}",
                rationale=f"由 Reflexion 反思系统捕获: {reflection.root_cause}，替代策略: {reflection.alternative_strategy}",
                hits=1,
                status="pending",
                created_at=time.time(),
                user_title=f"工具 {reflection.source_tool or '操作'} 前置防范规则",
                user_advice=reflection.prevention_rule,
                user_reason=reflection.root_cause,
                category="safety"
            )
            engine.store.insert_proposal(prop)
            engine.store.close()
            return True
        except Exception:
            return False

    def retrieve_reflections(
        self, query: str = "", tool_names: Sequence[str] = (), limit: int = 4
    ) -> List[Reflection]:
        """按查询意图或相关工具召回适用的历史反思。"""
        out: List[Reflection] = []
        try:
            rows = self.storage.get_memory_entries(mem_type="reflection", limit=limit * 3)
            for r in rows:
                content = r.get("content") or ""
                try:
                    data = json.loads(content)
                    ref = Reflection.from_dict(data)
                    # 匹配工具或关键词
                    if tool_names and ref.source_tool in tool_names:
                        out.append(ref)
                    elif query and (ref.source_tool in query or any(t in query for t in ref.tags)):
                        out.append(ref)
                    else:
                        out.append(ref)
                    if len(out) >= limit:
                        break
                except Exception:
                    continue
        except Exception:
            pass
        return out[:limit]

    def format_reflection_context(
        self, query: str = "", tool_names: Sequence[str] = (), limit: int = 3
    ) -> str:
        """构建待注入 Prompt 的 <reflections> 上下文块。"""
        refs = self.retrieve_reflections(query=query, tool_names=tool_names, limit=limit)
        if not refs:
            return ""
        lines = ["<reflections>", "【历史经验与前置避坑反思 (Reflexion Memory)】:"]
        for ref in refs:
            lines.append(ref.format_for_prompt())
        lines.append("</reflections>")
        return "\n".join(lines)


# 模块单例
_generator_instance: Optional[ReflectionGenerator] = None
_store_instance: Optional[ReflectionStore] = None


def get_reflection_generator() -> ReflectionGenerator:
    global _generator_instance
    if _generator_instance is None:
        _generator_instance = ReflectionGenerator()
    return _generator_instance


def get_reflection_store() -> ReflectionStore:
    global _store_instance
    if _store_instance is None:
        _store_instance = ReflectionStore()
    return _store_instance
