# -*- coding: utf-8 -*-
"""workflow_evolution.py — 工作流自进化提炼为 Agent 技能引擎 (Gap D Phase 2).

核心链路：
1. WorkflowMetricsTracker: 记录工作流多次回放成功率与漂移率，筛选稳定正样本。
2. WorkflowSlotExtractor: 参数槽位化引擎，将硬编码字面量抽取为通用占位符与 JSON Schema。
3. WorkflowSkillPromoter: 将合格工作流直接编译为符合规范的 SKILL.md，并动态热挂载至 SkillLoader。
4. GEPA 联动: 当物化后的技能执行失败时，通过遗传反思算法调整槽位规则或提示词。

Fail-Open 承诺：所有对外入口返回 Result，任何内部异常都不得阻断主 Agent 交互。
"""
from __future__ import annotations

import copy
import json
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from result import Result
from workflow_recorder import Workflow, WorkflowStep


@dataclass
class WorkflowExecutionMetrics:
    workflow_id: str
    total_runs: int = 0
    success_runs: int = 0
    drift_runs: int = 0
    last_run_timestamp: float = field(default_factory=time.time)
    avg_latency_ms: float = 0.0
    is_promotion_candidate: bool = False
    consecutive_failures: int = 0
    is_degraded: bool = False

    @property
    def success_rate(self) -> float:
        return self.success_runs / self.total_runs if self.total_runs > 0 else 0.0

    @property
    def drift_rate(self) -> float:
        return self.drift_runs / self.total_runs if self.total_runs > 0 else 0.0


class WorkflowMetricsTracker:
    """跟踪工作流执行表现与晋升候选资格"""

    def __init__(self):
        self._metrics: Dict[str, WorkflowExecutionMetrics] = {}

    def record_run(
        self,
        workflow_id: str,
        success: bool,
        drift: bool = False,
        latency_ms: float = 0.0,
    ) -> WorkflowExecutionMetrics:
        if workflow_id not in self._metrics:
            self._metrics[workflow_id] = WorkflowExecutionMetrics(workflow_id=workflow_id)

        m = self._metrics[workflow_id]
        m.total_runs += 1

        if success and not drift:
            m.success_runs += 1
            m.consecutive_failures = 0
            if m.is_degraded:
                m.is_degraded = False
                self._recover_skill(workflow_id)
        else:
            m.consecutive_failures += 1
            if drift:
                m.drift_runs += 1
            if m.consecutive_failures >= 3 and not m.is_degraded:
                m.is_degraded = True
                self._degrade_skill(workflow_id)

        m.last_run_timestamp = time.time()
        # 平滑平均延迟
        if m.avg_latency_ms == 0.0:
            m.avg_latency_ms = latency_ms
        else:
            m.avg_latency_ms = (m.avg_latency_ms * (m.total_runs - 1) + latency_ms) / m.total_runs

        # 晋升资格判定：成功 >= 3 次且漂移率 <= 0
        m.is_promotion_candidate = (m.success_runs >= 3 and m.drift_rate <= 0.0 and not m.is_degraded)
        return m

    @staticmethod
    def _degrade_skill(workflow_id: str) -> bool:
        """连续失败或漂移达到阈值时，自动将技能置为 DISABLED 状态（fail-open）。"""
        try:
            from skill_loader import get_skill_loader
            loader = get_skill_loader()
            clean_id = re.sub(r"[^a-zA-Z0-9_-]", "-", workflow_id.lower())
            for name in [f"wf-{clean_id}", workflow_id, clean_id]:
                entry = loader.get_skill(name)
                if entry:
                    loader.disable_skill(name)
                    return True
        except Exception:
            pass
        return False

    @staticmethod
    def _recover_skill(workflow_id: str) -> bool:
        """测试或回放干净成功后，自动将之前降级的技能恢复为 IMPORTED 状态（fail-open）。"""
        try:
            from skill_loader import get_skill_loader, SkillStatus
            loader = get_skill_loader()
            clean_id = re.sub(r"[^a-zA-Z0-9_-]", "-", workflow_id.lower())
            for name in [f"wf-{clean_id}", workflow_id, clean_id]:
                entry = loader.get_skill(name)
                if entry and entry.status == SkillStatus.DISABLED:
                    loader.enable_skill(name)
                    return True
        except Exception:
            pass
        return False

    def get_metrics(self, workflow_id: str) -> Optional[WorkflowExecutionMetrics]:
        return self._metrics.get(workflow_id)

    def get_promotion_candidates(
        self, min_success: int = 3, max_drift_rate: float = 0.0
    ) -> List[str]:
        candidates = []
        for wf_id, m in self._metrics.items():
            if m.success_runs >= min_success and m.drift_rate <= max_drift_rate:
                candidates.append(wf_id)
        return candidates


@dataclass
class ExtractedSlot:
    slot_name: str
    data_type: str
    original_value: Any
    description: str = ""


class WorkflowSlotExtractor:
    """从具体工作流步骤中自动泛化出变量槽位 (Slots) 与参数 Schema"""

    URL_PATTERN = re.compile(r"^https?://[^\s]+$")
    PATH_PATTERN = re.compile(r"^[a-zA-Z]:[/\\]|^\.?/[^\s]+")

    def extract_slots(
        self, workflow: Workflow
    ) -> Tuple[Workflow, List[ExtractedSlot], Dict[str, Any]]:
        parameterized_wf = copy.deepcopy(workflow)
        extracted_slots: List[ExtractedSlot] = []
        schema_props: Dict[str, Any] = {}
        required_props: List[str] = []

        slot_counter = 0

        for step in parameterized_wf.steps:
            for key, val in list(step.params.items()):
                if not isinstance(val, str):
                    continue

                slot_name = None
                slot_type = "string"
                slot_desc = ""

                if self.URL_PATTERN.match(val):
                    slot_name = "target_url" if "url" in key.lower() else f"url_slot_{slot_counter}"
                    slot_desc = "目标操作网页 URL"
                elif self.PATH_PATTERN.match(val):
                    slot_name = "file_path" if "path" in key.lower() else f"path_slot_{slot_counter}"
                    slot_desc = "目标文件或输出路径"
                elif key.lower() in ("query", "keyword", "search"):
                    slot_name = f"{key}_slot_{slot_counter}"
                    slot_desc = f"搜索关键字或查询参数 ({key})"

                if slot_name:
                    slot_counter += 1
                    # 避免重复重命名
                    existing = next((s for s in extracted_slots if s.original_value == val), None)
                    if existing:
                        step.params[key] = f"{{{{{existing.slot_name}}}}}"
                    else:
                        extracted_slots.append(ExtractedSlot(
                            slot_name=slot_name,
                            data_type=slot_type,
                            original_value=val,
                            description=slot_desc,
                        ))
                        schema_props[slot_name] = {
                            "type": slot_type,
                            "description": slot_desc,
                            "default": val,
                        }
                        required_props.append(slot_name)
                        step.params[key] = f"{{{{{slot_name}}}}}"

        json_schema = {
            "type": "object",
            "properties": schema_props,
            "required": required_props,
        }
        return parameterized_wf, extracted_slots, json_schema


def _render_description_value(desc: str) -> str:
    """把描述渲染成 frontmatter 里安全的纯标量。

    默认是裸写（``description: 中文描述``），因为技能目录的解析器同时也
    认带引号的标量；只有以 YAML 结构字符开头的描述才加引号，避免被误判
    成块标量 / 注释 / 序列。
    """
    if not desc:
        return '""'
    if desc[0] in (">", "|", "#", "-", "[", "{", "&", "*", "!", "%", "@", "`", '"', "'"):
        return json.dumps(desc, ensure_ascii=False)
    return desc


def validate_skill_structure(skill_md_content: str) -> Result:
    """Gate 1: SKILL.md 结构合规性与 Agent 可读性校验。"""
    if not skill_md_content.startswith("---"):
        return Result.failure("Gate 1: SKILL.md 缺少开头的 YAML frontmatter 分隔符 (---)")
    parts = skill_md_content.split("---", 2)
    if len(parts) < 3:
        return Result.failure("Gate 1: SKILL.md 缺少闭合的 YAML frontmatter 分隔符")

    fm_text = parts[1].strip()
    fm = {}
    for line in fm_text.splitlines():
        line = line.strip()
        if ":" in line:
            k, v = line.split(":", 1)
            fm[k.strip()] = v.strip()

    name = fm.get("name", "").strip()
    if not name:
        return Result.failure("Gate 1: SKILL.md frontmatter 缺少必需的 name 字段")
    if not re.match(r"^[a-zA-Z0-9_-]+$", name):
        return Result.failure(f"Gate 1: 技能名称 '{name}' 包含非法字符，必须为字母、数字、下划线或连字符")

    desc = fm.get("description", "").strip()
    if not desc or desc in ('""', "''"):
        return Result.failure("Gate 1: SKILL.md frontmatter 缺少有效的 description 描述")

    body = parts[2].strip()
    if not body:
        return Result.failure("Gate 1: SKILL.md 正文内容为空，Agent 无法阅读指导")
    if not (body.startswith("#") or "##" in body):
        return Result.failure("Gate 1: SKILL.md 正文缺少标准 Markdown 标题结构")

    return Result.success({"name": name, "description": desc})


def run_skill_trial(
    parameterized_wf: Workflow,
    slots: list,
    trial_runner: Optional[Callable[[Workflow, list], Result]] = None,
) -> Result:
    """Gate 2: 沙盒试运行 (trial)。以样例槽位值执行试运行，确保工作流步骤可被正确解析与调度。"""
    if not parameterized_wf.steps:
        return Result.failure("Gate 2: 工作流无任何执行步骤，trial 无法运行")

    if trial_runner is not None:
        try:
            res = trial_runner(parameterized_wf, slots)
            if not res.ok:
                return Result.failure(f"Gate 2 trial 试运行失败: {res.error}")
            return res
        except Exception as exc:
            return Result.failure(f"Gate 2 trial 试运行异常: {exc}")

    # 默认试运行静态与插值校验
    slot_names = {s.slot_name for s in slots}
    for step in parameterized_wf.steps:
        if not step.tool_name or not step.tool_name.strip():
            return Result.failure(f"Gate 2: 步骤 {step.step_index} 缺少合法的 tool_name")
        params_str = json.dumps(step.params, ensure_ascii=False)
        # 验证所有插值槽位名均在 slots 清单内
        for placeholder in re.findall(r"\{\{([a-zA-Z0-9_]+)\}\}", params_str):
            if placeholder not in slot_names:
                return Result.failure(f"Gate 2: 步骤 {step.step_index} 引用了未定义的槽位 '{placeholder}'")

    return Result.success({"trial": "passed", "steps_verified": len(parameterized_wf.steps)})


class WorkflowSkillPromoter:
    """将正样本工作流编译为标准 SKILL.md 实体包并激活（经三道门安全审查）。"""

    def __init__(self, slot_extractor: Optional[WorkflowSlotExtractor] = None):
        self.slot_extractor = slot_extractor or WorkflowSlotExtractor()

    def promote_to_skill(
        self,
        workflow: Workflow,
        skills_root: Optional[Path | str] = None,
        hot_mount: bool = True,
        trial_runner: Optional[Callable[[Workflow, list], Result]] = None,
        skip_trial: bool = False,
    ) -> Result:
        if not workflow.steps:
            return Result.failure("无法将无步骤的空工作流晋级为技能")

        parameterized_wf, slots, schema = self.slot_extractor.extract_slots(workflow)

        # Gate 2 试运行先行校验 (沙盒试跑)
        if not skip_trial:
            trial_res = run_skill_trial(parameterized_wf, slots, trial_runner=trial_runner)
            if not trial_res.ok:
                return trial_res

        if skills_root:
            root_dir = Path(skills_root)
        else:
            root_dir = Path.home() / ".ovolve" / "skills"
        root_dir.mkdir(parents=True, exist_ok=True)

        clean_id = re.sub(r"[^a-zA-Z0-9_-]", "-", workflow.id.lower())
        skill_folder_name = f"wf-{clean_id}"
        target_dir = root_dir / skill_folder_name

        # Gate 3: 幂等性与版本演进判定
        version = "1.0.0"
        is_update = False
        skill_md_path = target_dir / "SKILL.md"
        if target_dir.exists() and skill_md_path.exists():
            is_update = True
            try:
                old_text = skill_md_path.read_text(encoding="utf-8")
                m = re.search(r"version:\s*([0-9]+)\.([0-9]+)\.([0-9]+)", old_text)
                if m:
                    maj, mnr, patch = int(m.group(1)), int(m.group(2)), int(m.group(3))
                    version = f"{maj}.{mnr}.{patch + 1}"
            except Exception:
                version = "1.0.1"

        target_dir.mkdir(parents=True, exist_ok=True)

        desc = workflow.description.strip() or f"自动执行工作流: {workflow.name}"
        desc = desc.replace("\n", " ")[:1000]

        # 组装标准 SKILL.md
        frontmatter = [
            "---",
            f"name: {skill_folder_name}",
            f"description: {_render_description_value(desc)}",
            f"version: {version}",
            "user-invocable: true",
            "disable-model-invocation: false",
            "include-in-runtime-registry: true",
            "include-in-available-skills-prompt: true",
            "---",
            "",
            f"# {workflow.name}",
            "",
            desc,
            "",
            "## 参数配置 (Slots)",
            "```json",
            json.dumps(schema, ensure_ascii=False, indent=2),
            "```",
            "",
            "## 执行步骤",
        ]
        for step in parameterized_wf.steps:
            frontmatter.append(f"- **Step {step.step_index + 1}**: `{step.tool_name}` -> {json.dumps(step.params, ensure_ascii=False)}")

        rendered_skill_md = "\n".join(frontmatter)

        # Gate 1: SKILL.md 结构校验与 Agent 可读性
        gate1_res = validate_skill_structure(rendered_skill_md)
        if not gate1_res.ok:
            return gate1_res

        with open(skill_md_path, "w", encoding="utf-8") as f:
            f.write(rendered_skill_md)

        # 同时存盘参数化后的 workflow 原型
        wf_json_path = target_dir / "workflow.json"
        with open(wf_json_path, "w", encoding="utf-8") as f:
            json.dump(parameterized_wf.to_dict(), f, ensure_ascii=False, indent=2)

        # Gate 3: 幂等热挂载 (热载入至 SkillLoader 运行时)
        mount_status = "skipped"
        if hot_mount:
            mount_status = self._hot_mount(str(target_dir), skill_folder_name)

        return Result.success({
            "status": "updated" if is_update else "promoted",
            "skill_name": skill_folder_name,
            "skill_dir": str(target_dir),
            "skill_md": str(skill_md_path),
            "slots_count": len(slots),
            "version": version,
            "is_update": is_update,
            "hot_mount": mount_status,
        })

    @staticmethod
    def _hot_mount(skill_dir: str, skill_name: str) -> str:
        """把刚物化的技能热挂载进运行时 SkillLoader（fail-open & 幂等）。"""
        try:
            from skill_loader import TrustLevel, get_skill_loader
            res = get_skill_loader().import_skill(skill_dir, TrustLevel.OWN)
            return "mounted" if res.ok else f"degraded: {res.error}"
        except Exception as exc:
            return f"degraded: {exc}"


class WorkflowEvolutionBridge:
    """工作流 ↔ GEPA 自进化桥接器。

    职责是把"回放失败"这条信号翻译成 GEPA 能消化的基因候选：
    先以工作流步骤为种子构造父代基因，再把失败轨迹交给反思变异器，
    拿到带新增防线/步骤补丁的子代，供后续重放验证。
    """

    def __init__(
        self,
        tracker: Optional[WorkflowMetricsTracker] = None,
        promoter: Optional[WorkflowSkillPromoter] = None,
    ):
        self.tracker = tracker or WorkflowMetricsTracker()
        self.promoter = promoter or WorkflowSkillPromoter()
        self._mutator: Optional[Any] = None

    def _get_mutator(self) -> Any:
        if self._mutator is None:
            from gepa_evolution import ReflectiveMutator
            self._mutator = ReflectiveMutator()
        return self._mutator

    @staticmethod
    def _seed_candidate(workflow: Workflow) -> Any:
        """用工作流步骤构造父代基因（generation 0）。"""
        from gepa_evolution import GenomeCandidate
        steps = [
            f"调用 `{s.tool_name}`，参数 {json.dumps(s.params, ensure_ascii=False)}"
            for s in workflow.steps
        ]
        prompt = f"工作流技能：{workflow.name}"
        if workflow.description:
            prompt += f"\n{workflow.description}"
        return GenomeCandidate(
            candidate_id=f"wf_{workflow.id}",
            generation=0,
            name=workflow.name or workflow.id,
            prompt_content=prompt,
            preconditions=f"由工作流 {workflow.id} 自动提炼",
            steps=steps,
            guardrails=[],
            mutation_type="seed",
        )

    def reflect_on_failure(self, workflow: Workflow, failure: Result) -> Result:
        """把一次失败回放转成反思后的基因候选。"""
        try:
            meta = failure.meta or {}
            failed_index = meta.get("failed_step")
            step = None
            if isinstance(failed_index, int) and 0 <= failed_index < len(workflow.steps):
                step = workflow.steps[failed_index]

            trace = {
                "tool": step.tool_name if step else (workflow.steps[0].tool_name if workflow.steps else "workflow_replay"),
                "name": workflow.name,
                "error": failure.error or "",
                "args": step.params if step else {},
            }

            diagnosis = self._get_mutator().diagnose_failure_trace(trace)
            parent = self._seed_candidate(workflow)
            mutated = self._get_mutator().mutate_prompt(parent, [trace], generation=1)

            payload = mutated.to_dict()
            payload["diagnosis"] = diagnosis
            return Result.success(payload)
        except Exception as exc:
            return Result.failure(f"GEPA 反思桥接失败（已 fail-open）: {exc}")

    def promote_if_ready(
        self,
        workflow: Workflow,
        skills_root: Optional[Path | str] = None,
        min_success: int = 3,
    ) -> Result:
        """账本达标（成功 >= min_success 且零漂移）时才物化为技能。"""
        metrics = self.tracker.get_metrics(workflow.id)
        if metrics is None:
            return Result.failure(f"工作流 {workflow.id} 尚无回放记录")
        if not (metrics.success_runs >= min_success and metrics.drift_rate <= 0.0):
            return Result.failure(
                f"工作流 {workflow.id} 未达晋升门槛：成功 {metrics.success_runs} 次，"
                f"漂移率 {metrics.drift_rate:.2f}"
            )
        return self.promoter.promote_to_skill(workflow, skills_root=skills_root)
