"""
evolution.py — 自演化系统：从复发失败里挖出规则，做成提案交给用户审。

## 这个模块想解决什么

Agent 会把同一个错犯很多遍。同一个工具用错同一种参数、同一条路径反复被拒、
同一类命令反复超时——每一次都要用户重新纠一遍。人类同事被纠三次之后会自己记
下来，Agent 不会，因为它每回合的记忆都是重建的。

引导文件（AGENTS.md / MEMORY.md / SOUL.md）本来就是"下回合还记得"的地方。
所以路径是清楚的：**把复发的错变成引导文件里的一条规则**。

## 为什么必须是提案，不能直接写

`path_guard.READONLY_BASENAMES` 明确禁止模型直写这三个文件，这个设计是对的：
让模型能改自己的行为准则，等于让它能给自己解除约束。这里不打破那个边界——

  挖掘 → 生成草稿 → **用户显式接受** → 由系统侧写盘

系统侧写盘走直接文件 IO（和 `memory_layer._update_agents_md` 一样），刻意绕过
PathGuard。这不矛盾：PathGuard 关的是**模型**的门，不是系统的门。区别在于这条
路径上有一个人点了"接受"。

## 三条不可妥协的纪律

1. **默认关**。`MODE_OFF` 是缺省值。用户没开，整个模块一行都不跑。
   一个会自己改自己准则的系统，不该是默认行为。
2. **宁可不提，不可骚扰**。同一签名同时只能有一个未决提案；被拒过的签名进冷却；
   未决提案总数有上限。一个反复弹同样建议的系统会被用户直接关掉，那就等于没有。
3. **绝不谎报**。没落盘就不说落盘了。`decide()` 返回真实的 applied 结果，
   写盘失败就是失败，不吞。

思路借鉴同类产品的公开行为（三档频率、签名去重、受保护文件清单），实现全部原创。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import sqlite3
import time
import uuid

logger = logging.getLogger(__name__)
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional


try:
    from enum import StrEnum
except ImportError:
    class StrEnum(str, Enum):
        def __str__(self) -> str:
            return str(self.value)


class FailureKind(StrEnum):
    """P3-2/Task 2.3: 结构化失败类型枚举。"""
    TOOL_UNAVAILABLE = "tool_unavailable"
    SANDBOX_FAIL_IMMEDIATELY = "sandbox_fail_immediately"
    COMMAND_RULE_DENY = "command_rule_deny"
    MCP_RULE_DENY = "mcp_rule_deny"
    LOOP_FAULT = "loop_fault"
    USER_CORRECTION = "user_correction"
    SCHEMA_MISMATCH = "schema_mismatch"
    CONTEXT_PRESSURE = "context_pressure"

try:
    from sanitizer import PrivacySanitizer
except ImportError:
    try:
        from app.backend.sanitizer import PrivacySanitizer
    except ImportError:
        PrivacySanitizer = None

# ── 频率档位 ────────────────────────────────────────────────────────────────

MODE_OFF = "off"
MODE_CAUTIOUS = "cautious"
MODE_ACTIVE = "active"

VALID_MODES = (MODE_OFF, MODE_CAUTIOUS, MODE_ACTIVE)

#: 缺省档位。**必须是 off** —— 见模块 docstring 纪律 1。
DEFAULT_MODE = MODE_OFF


@dataclass(frozen=True)
class ModePolicy:
    """一个档位下的全部阈值。

    Attributes:
        min_hits: 同一签名至少复发这么多次才够格提案。低于此数的很可能是偶发，
            为偶发立规则会污染引导文件——而引导文件每回合都要注入，污染是有
            持续成本的。
        max_open: 未决提案总数上限。到顶就不再产生新提案，先让用户清完。
        reject_cooldown_s: 某签名被拒后，多久内不再就它提案。
    """

    min_hits: int
    max_open: int
    reject_cooldown_s: float


#: cautious 要求复发 5 次、最多 2 条未决、被拒后 30 天不再提；
#: active 放宽到 3 次 / 5 条 / 7 天。两档的差别是"多久才算够确定"，
#: 不是"要不要经用户同意"——后者两档都要。
MODE_POLICIES: dict[str, ModePolicy] = {
    MODE_CAUTIOUS: ModePolicy(min_hits=5, max_open=2, reject_cooldown_s=30 * 86400),
    MODE_ACTIVE: ModePolicy(min_hits=3, max_open=5, reject_cooldown_s=7 * 86400),
}


#: 自动挖掘的冷却间隔。失败往往成串（重试风暴），每条都跑 GROUP BY 是浪费。
MINE_THROTTLE_S: float = 60.0


# ── 允许被提案修改的目标 ────────────────────────────────────────────────────

#: 提案只能落到这几个文件。与 ``path_guard.READONLY_BASENAMES`` 故意保持一致：
#: 那份清单说"模型不能直写这些"，这份说"演化提案只能改这些"。两者合起来的意思是
#: ——这些文件只能通过"用户点了接受"这一条路被改。
#:
#: 白名单而不是黑名单：一个能往任意文件追加内容的提案系统，就是一个绕过所有写入
#: 防护的通道。
ALLOWED_TARGETS: frozenset = frozenset({"AGENTS.md", "MEMORY.md", "SOUL.md"})

#: 信号类别 → 默认落到哪个引导文件。
#: 工具用法教训进 AGENTS.md（项目/工程约定），用户偏好进 MEMORY.md。
KIND_TARGET: dict[str, str] = {
    "tool_failure": "AGENTS.md",
    "tool_denied": "AGENTS.md",
    "interrupted": "AGENTS.md",
    "user_correction": "MEMORY.md",
    # 观察层产物（Step C 落地）：任务里抽出来的事实是"用户/项目事实"，
    # 与 user_correction 同归 MEMORY.md。有了这一行，观察层的记忆提案和
    # 信号挖掘的提案共用同一条审批-写盘管线，不另开一个写入口。
    "learned_fact": "MEMORY.md",
    # 同样是一条事实，但盘上已经有一行"说同一件事、结论不同"的旧规则。批准它
    # 意味着**替换**而不是追加，所以给它单独一个 kind：UI 要能把"新增"和"改写"
    # 说清楚，用户裁决的正是"留哪一条"。
    "fact_conflict": "MEMORY.md",
    # 记忆层从"用户刚编辑的文件"里抽出的项目上下文。以前这条走裸 open(...,"w")
    # 直写 AGENTS.md、默认开启、无审批（见 memory_layer._update_agents_md 的
    # 注释）。现在并入同一条提案管线，写入口只剩一个。
    "extracted_context": "AGENTS.md",
}



#: 写进引导文件时用的小节标题。所有演化产物集中在一节里，用户一眼能看出
#: 哪些是自动来的、可以整段删掉。
EVOLUTION_HEADING = "## Learned Rules (evolution)"


# ── 错误签名归一化 ──────────────────────────────────────────────────────────

#: 归一化替换表。目标是让「同一个错」折叠成同一个签名：错误文本里的行号、
#: 路径、耗时、引号内容每次都不同，不抹掉它们的话同一个错会散成 20 个签名，
#: 复发计数永远到不了阈值，整个挖掘就是空转。
#:
#: 凭证那几条必须排在最前面。归一化的产物不只进签名——``_compose_rule`` 会把它
#: 写进草稿，用户一点「接受」就永久落到 AGENTS.md，而那个文件每回合都注入模型。
#: 也就是说一条 ``token=sk-xxx failed`` 的报错，会变成一条把密钥写在提示词里的
#: 永久规则。这个函数的注释一直声称「不塞入原文、可能泄露凭证」，但在补测试
#: 之前它其实只抹路径和数字，密钥原样穿过去了。
_NORMALIZERS: tuple[tuple[re.Pattern, str], ...] = (
    # 带标签的赋值：token= / api_key: / password= …（值到空白或引号为止）
    (re.compile(
        r"\b(?:api[-_]?key|secret|token|password|passwd|pwd|auth(?:orization)?|"
        r"access[-_]?key|private[-_]?key|session[-_]?id|cookie)\b\s*[:=]\s*[^\s'\",;]+",
        re.IGNORECASE), "<SECRET>"),
    # Authorization: Bearer xxx
    (re.compile(r"\bbearer\s+[A-Za-z0-9._\-]+", re.IGNORECASE), "<SECRET>"),
    # 常见服务商的令牌前缀，即使没有标签也要抹
    (re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{8,}"), "<SECRET>"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"), "<SECRET>"),
    (re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{8,}"), "<SECRET>"),
    (re.compile(r"\bAIza[A-Za-z0-9_\-]{16,}"), "<SECRET>"),
    # Windows 与 POSIX 绝对路径
    (re.compile(r"[A-Za-z]:\\[^\s'\"]+"), "<PATH>"),
    (re.compile(r"/(?:[\w.\-]+/)+[\w.\-]+"), "<PATH>"),
    # 引号里的内容（文件名、参数值）
    (re.compile(r"'[^']*'"), "<Q>"),
    (re.compile(r'"[^"]*"'), "<Q>"),
    # 十六进制 id / hash
    (re.compile(r"\b[0-9a-f]{8,}\b", re.IGNORECASE), "<HEX>"),
    # 纯数字（行号、耗时、字节数）
    (re.compile(r"\b\d+(?:\.\d+)?\b"), "<N>"),
    # 连续空白
    (re.compile(r"\s+"), " "),
)


def normalize_error(text: str) -> str:
    """把一条错误文本抹成可比较的形状。

    只做替换，不做截断到很短——保留结构（哪个动词、哪种失败）才能让不同类别的
    失败仍然区分得开。抹得太狠会让"文件不存在"和"权限不足"撞成同一个签名，
    那时提案会给出一条对两者都不对的规则。
    """
    if not text:
        return ""
    out = str(text)
    for pattern, repl in _NORMALIZERS:
        out = pattern.sub(repl, out)
    return out.strip().lower()[:400]


def signature_for(kind: str, tool_name: str, detail: str) -> str:
    """一条信号的稳定指纹。

    包含 kind 和 tool_name 是刻意的：同一段错误文本出现在不同工具上，教训不一样，
    不该合并计数。
    """
    basis = f"{kind}\x1f{tool_name or ''}\x1f{normalize_error(detail)}"
    return hashlib.sha256(basis.encode("utf-8", errors="ignore")).hexdigest()[:16]


# ── 存储 ────────────────────────────────────────────────────────────────────

def _db_path() -> Path:
    try:
        from user_dirs import db_dir
    except ImportError:  # pragma: no cover - packaged import shape
        from app.backend.user_dirs import db_dir
    root = Path(db_dir())
    root.mkdir(parents=True, exist_ok=True)
    return root / "evolution.db"


#: signals 表的保留期。信号只用来数复发，数完就没价值了；留太久会让一年前的
#: 一次失败还在给今天的计数投票。
SIGNAL_RETENTION_S: float = 30 * 86400

#: 单个签名最多记这么多条信号。到顶后不再插入——计数已经远超任何阈值，继续记
#: 只是在长数据库。
MAX_SIGNALS_PER_SIGNATURE: int = 50


@dataclass
class Proposal:
    """一条待审提案。"""

    id: str
    signature: str
    kind: str
    tool_name: str
    target_file: str
    draft: str
    rationale: str
    hits: int
    status: str          # pending | accepted | rejected
    created_at: float
    decided_at: float = 0.0
    applied: int = 0
    #: 被这条提案取代的旧行原文（含 "- " 前缀）。空 = 纯新增。
    supersedes: str = ""
    #: 效果回访三态（effective/improving/ineffective）。空 = 未到回访年龄
    #: （生效未满 7 天）或还没轮到回访清扫。
    effect: str = ""
    effect_reviewed_at: float = 0.0
    #: 生效前 14 天基线窗口内的复发次数；回访结论的数字依据。
    effect_baseline: int = 0
    user_title: str = ""
    user_advice: str = ""
    user_reason: str = ""
    category: str = ""

    def _infer_human_meta(self) -> tuple[str, str, str, str]:
        """为提案生成自然语言的用户标题、行为建议、业务原因与分类标签。"""
        draft_clean = re.sub(r"^[-*]\s*", "", self.draft or "").strip()
        draft_clean = re.sub(r"^\[fact\]\s*", "", draft_clean, flags=re.IGNORECASE).strip()
        # 清除 <n> 占位符
        draft_clean = re.sub(r"<n>", "", draft_clean).strip()
        
        detail = (self.rationale or "") + " " + (self.draft or "")
        tool = (self.tool_name or "").lower()
        kind = (self.kind or "").lower()

        # 1. 安全确认与高危命令拦截
        if "confirmation" in detail.lower() or "high risk" in detail.lower() or "permission" in detail.lower() or kind == "tool_denied":
            title = "敏感命令前置确认"
            advice = "执行敏感或高风险系统命令前，先向您简要说明操作意图并等待确认"
            reason = f"近期在执行 `{self.tool_name or '终端命令'}` 时触发了安全策略拦截。记住该规则后将主动请示，避免命令直接受阻。"
            cat = "safety"
            return title, advice, reason, cat

        # 2. 网络网页 403 Forbidden
        if "forbidden" in detail.lower() or "403" in detail:
            title = "网页访问权限受限处理"
            advice = "抓取网页遭遇权限拒绝 (403) 时，优先提示用户登录或改用浏览器模式"
            reason = "目标网站存在反爬防护或需要登录凭据。采纳后，Agent 将自动切换为浏览器协助，不再盲目重试。"
            cat = "browser"
            return title, advice, reason, cat

        # 3. 网络网页 404 Not Found
        if "not found" in detail.lower() or "404" in detail:
            title = "网络死链与资源未找到处理"
            advice = "遇到目标页面不存在 (404) 时，自动通过搜索引擎寻找备用有效链接"
            reason = "历史抓取的部分页面链接已失效。采纳后，遇到死链将自动执行搜索引擎检索补救。"
            cat = "network"
            return title, advice, reason, cat

        # 4. 项目事实与上下文抽取
        if kind in ("extracted_context", "learned_fact") or "saved to" in draft_clean.lower() or "directory" in draft_clean.lower():
            # 路径脱敏与相对化（防止绝对路径硬编码与日志感）
            sanitized = re.sub(r'[A-Za-z]:\\[^\\s\']+[\\/]([A-Za-z0-9_\-]+)[\\/]?', r'项目 \1/ 目录', draft_clean)
            sanitized = re.sub(r'\/[^\s\']+\/([A-Za-z0-9_\-]+)\/?', r'项目 \1/ 目录', sanitized)
            lower_s = sanitized.lower()

            if "screenshots are saved to" in lower_s:
                m = re.search(r'saved to (?:the\s+)?(.+?)(?:\s+directory)?\.?$', sanitized, re.I)
                target_dest = m.group(1).strip() if m else "项目 output/ 目录"
                title = "截图输出路径约定"
                advice = f"自动化任务与操作产生的屏幕快照统一保存至 {target_dest}"
                reason = "确保所有任务截图与执行产物集中保存在指定目录，方便您统一查阅与归档。"
            elif "output directory" in lower_s and ("created" in lower_s or "exist" in lower_s):
                title = "产物输出目录自动初始化"
                advice = "当截图或产物输出目录不存在时，由系统自动创建对应文件夹"
                reason = "防止因目标文件夹缺失导致保存异常，保障自动化执行流程平稳闭环。"
            elif "saved to" in lower_s:
                m = re.search(r'saved to (?:the\s+)?(.+?)(?:\s+directory)?\.?$', sanitized, re.I)
                dest = m.group(1).strip() if m else "指定目录"
                title = "文件生成与归档约定"
                advice = f"相关生成文件将统一保存至 {dest}"
                reason = "规范生成物存储位置，避免文件散落在工作区各处。"
            else:
                title = "项目文件与目录约定"
                advice = sanitized
                reason = "从项目代码与配置文件中识别出的固定约定，后续任务中持续生效。"
            cat = "project_context"
            return title, advice, reason, cat

        # 5. 用户纠正
        if kind == "user_correction":
            title = "用户偏好与操作习惯"
            advice = draft_clean
            reason = "根据您在对话中的明确纠正所总结的操作偏好。"
            cat = "preference"
            return title, advice, reason, cat

        # 6. 中断
        if kind == "interrupted":
            title = "耗时操作前置确认"
            advice = f"在开始 `{self.tool_name or '批量操作'}` 前先向您摘要计划并等待确认"
            reason = "近期该类操作多次在执行期间被手动中断。提前报备计划可减少无意义消耗。"
            cat = "safety"
            return title, advice, reason, cat

        # 7. 通用工具失败
        title = f"{self.tool_name or '工具'}调用优化" if self.tool_name else "操作执行优化"
        advice = draft_clean
        reason = f"近期同类操作遇到异常（{self.hits} 次）。采纳后将优化调用参数或选用备用工具。"
        cat = "general"
        return title, advice, reason, cat

    def to_dict(self) -> dict:
        title, advice, reason, cat = self._infer_human_meta()
        return {
            "id": self.id,
            "signature": self.signature,
            "kind": self.kind,
            "toolName": self.tool_name,
            "targetFile": self.target_file,
            "draft": self.draft,
            "rationale": self.rationale,
            "hits": self.hits,
            "status": self.status,
            "createdAt": self.created_at,
            "decidedAt": self.decided_at,
            "applied": bool(self.applied),
            "supersedes": self.supersedes,
            "effect": self.effect,
            "effectReviewedAt": self.effect_reviewed_at,
            "effectBaseline": self.effect_baseline,
            "userTitle": self.user_title or title,
            "userAdvice": self.user_advice or advice,
            "userReason": self.user_reason or reason,
            "category": self.category or cat,
        }



# ── 观察层（Step C）：任务终态 → 结构化证据 → 四路学习决策 ────────────────────

DECISION_MEMORY_ONLY = "MEMORY_ONLY"
DECISION_SKILL_ONLY = "SKILL_ONLY"
DECISION_BOTH = "BOTH"
DECISION_NO_OP = "NO_OP"
DECISIONS = (DECISION_MEMORY_ONLY, DECISION_SKILL_ONLY, DECISION_BOTH, DECISION_NO_OP)


@dataclass
class EvolutionObservation:
    """一次任务结束后的结构化证据包。

    只装**已经发生的证据**（经验行、验证结果、用户反馈、抽取出的事实），
    不装模型的自我评价——"我学会了"不是证据。``decision`` 由 classify_observation
    基于证据判定，判定规则是确定性表格，不是又一次模型调用。
    """

    goal_id: str = ""
    run_id: str = ""
    session_id: str = ""
    branch_id: str = ""
    episode_id: str = ""
    turn_ids: list = field(default_factory=list)          # 来源轮次 turn_id 列表
    source_event_ids: list = field(default_factory=list)  # 来源 EventStore event_id 真实事件列表 (P1-5)
    used_memory: list = field(default_factory=list)       # 引用到的记忆 id/摘要
    used_skills: list = field(default_factory=list)       # 实际用过的技能名
    skill_experiences: list = field(default_factory=list) # experience_id 列表
    validator_result: dict = field(default_factory=dict)  # 目标验证的机器结论
    user_feedback: Optional[str] = None
    new_facts: list = field(default_factory=list)         # 本次新出现的事实候选
    reusable_steps: list = field(default_factory=list)    # 成功走通的技能流程
    validated_skills: list = field(default_factory=list)  # 验证通过的技能 id（落 VALIDATES 边）
    failed_experiences: list = field(default_factory=list)# 失败经验的 failure_class
    failure_class: Optional[str] = None
    decision: str = ""                                    # 四路之一，observe() 时填
    reason: str = ""                                      # 为什么这么判，给 UI 和审计
    created_at: float = 0.0

    def to_dict(self) -> dict:
        return {
            "goalId": self.goal_id, "runId": self.run_id,
            "sessionId": self.session_id, "branchId": self.branch_id,
            "episodeId": self.episode_id,
            "turnIds": self.turn_ids,
            "sourceEventIds": self.source_event_ids,
            "usedMemory": self.used_memory, "usedSkills": self.used_skills,
            "skillExperiences": self.skill_experiences,
            "validatorResult": self.validator_result,
            "userFeedback": self.user_feedback,
            "newFacts": self.new_facts, "reusableSteps": self.reusable_steps,
            "validatedSkills": self.validated_skills,
            "failedExperiences": self.failed_experiences,
            "failureClass": self.failure_class,
            "decision": self.decision, "reason": self.reason,
            "createdAt": self.created_at,
        }


@dataclass
class SemanticReflection:
    """Reflexion 风格结构化语义反思。"""
    reflection_id: str
    goal_id: str
    root_cause: str
    alternative_strategy: str
    preventative_rule: str
    boundary: str
    outcome: str = "failure"  # failure | success
    confidence: float = 0.85
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "reflectionId": self.reflection_id,
            "goalId": self.goal_id,
            "rootCause": self.root_cause,
            "alternativeStrategy": self.alternative_strategy,
            "preventativeRule": self.preventative_rule,
            "boundary": self.boundary,
            "outcome": self.outcome,
            "confidence": self.confidence,
            "createdAt": self.created_at,
        }




#: 证据里出现这些形状就拒绝学习——把秘密固化进 MEMORY.md/Skill 等于永久泄露。
_SECRET_HINT = re.compile(
    r"\b(?:api[-_]?key|secret|token|password|passwd|credential|private[-_]?key)\b"
    r"|\b(?:sk|pk|rk)-[A-Za-z0-9_\-]{8,}"
    r"|\bbearer\s+[A-Za-z0-9._\-]+",
    re.IGNORECASE,
)


def classify_observation(obs: EvolutionObservation) -> tuple[str, str]:
    """四路决策。确定性规则表，只看证据，不看模型自述。

    | 决策 | 判据 |
    |---|---|
    | BOTH | 新事实与可复用技能流程同时出现 |
    | MEMORY_ONLY | 只有新事实（偏好/环境/约束），没有可复用流程 |
    | SKILL_ONLY | 技能流程成功走通，但没有沉淀出新事实 |
    | NO_OP | 秘密嫌疑、偶发失败、复发失败（归信号管线）、纯口头反馈、证据不足 |
    """
    blob = " | ".join(
        [*(obs.new_facts or []), *(obs.failed_experiences or []),
         obs.failure_class or "", obs.user_feedback or ""]
    )
    if _SECRET_HINT.search(blob):
        return DECISION_NO_OP, "证据疑似包含秘密/凭证：禁止固化为任何学习产物"

    has_facts = bool(obs.new_facts)
    has_skill = bool(obs.reusable_steps)
    if has_facts and has_skill:
        return (DECISION_BOTH,
                f"新事实 {len(obs.new_facts)} 条且技能流程成功 {len(obs.reusable_steps)} 个：两层需同步更新")
    if has_facts:
        return DECISION_MEMORY_ONLY, f"新增 {len(obs.new_facts)} 条事实，无可复用流程"
    if has_skill:
        return DECISION_SKILL_ONLY, f"{len(obs.reusable_steps)} 个技能流程成功可复用，无新事实"

    failures = [f for f in (obs.failed_experiences or []) if f]
    if failures:
        repeated = any(failures.count(c) >= 2 for c in set(failures))
        if repeated:
            return (DECISION_NO_OP,
                    "同类失败已复发：由信号挖掘管线按 min_hits 立案，观察层不重复立项")
        return DECISION_NO_OP, "偶发失败：一次失败不配固化成任何长期改变"
    if obs.user_feedback:
        return DECISION_NO_OP, "仅口头反馈、无可落地证据：低复用价值"
    return DECISION_NO_OP, "证据不足：没有成功经验也没有新事实"


def build_goal_observation(goal_id: str, storage, *, run_id: str = "",
                           new_facts=None) -> Optional[EvolutionObservation]:
    """从真实数据源拼一个观察：经验台账 + 目标验证结论 + 会话流里的记忆事件。

    这是"消费刚落地的经验数据"的那根管子——observation 不是凭空构造的测试
    腔，每一项都来自落盘的事实。取不到目标行返回 None（观察无从谈起）。
    """
    try:
        row = storage.get_goal(goal_id) or {}
    except Exception:  # noqa: BLE001
        row = {}
    if not row:
        return None

    exps = []
    try:
        # include_task_level=True on purpose: a task that no skill covered is
        # the single strongest signal that a skill is MISSING. Filtering those
        # rows out here is how the loop used to go blind to its own gaps.
        exps = storage.list_skill_experiences(
            goal_id=goal_id, limit=50, include_task_level=True,
        )
    except Exception:  # noqa: BLE001
        exps = []

    ok_exps = [e for e in exps if e.get("outcome") == "success"]
    failed = [e for e in exps if e.get("outcome") == "failure"]

    verdict: dict = {}
    try:
        verdict = json.loads(row.get("verification_result") or "") or {}
    except (json.JSONDecodeError, TypeError):
        verdict = {}

    facts = list(new_facts or [])
    sid = row.get("session_id") or ""
    goal_event_ids: list[str] = []
    try:
        from event_types import EventType
        for ev in storage.get_event_store().read_stream(sid):
            ev_gid = str(getattr(ev, "goal_id", "") or (ev.payload.get("goal_id") if ev.payload else "") or "")
            ev_id_str = str(getattr(ev, "id", "") or getattr(ev, "event_id", "") or "")
            if ev_gid == goal_id and ev_id_str:
                goal_event_ids.append(ev_id_str)
            if ev.event_type == EventType.MEMORY_EXTRACTED.value:
                p = ev.payload or {}
                batch = p.get("facts") or []
                if batch:
                    # memory_layer 现在按批发射：facts 是字符串列表
                    facts.extend(str(f)[:200] for f in batch if str(f).strip())
                else:
                    fact = str(p.get("text") or p.get("fact")
                               or p.get("content") or "").strip()
                    if fact:
                        facts.append(fact[:200])
    except Exception:  # noqa: BLE001
        pass  # 记忆事件缺失降级为空清单——分类会如实给出 NO_OP 而不是编造

    feedback = next((e.get("user_feedback") for e in reversed(exps)
                     if e.get("user_feedback")), None)
    return EvolutionObservation(
        goal_id=goal_id, run_id=run_id, session_id=sid,
        source_event_ids=goal_event_ids,
        used_skills=sorted({e.get("skill_id", "") for e in exps
                            if e.get("skill_id")
                            and e.get("skill_id") != storage.TASK_LEVEL_SKILL_ID}),

        skill_experiences=[e.get("experience_id") for e in exps],
        validator_result={
            "status": row.get("status"),
            "reason": verdict.get("reason"),
            "machineVerified": bool(verdict),
        },
        user_feedback=feedback,
        new_facts=facts,
        reusable_steps=[
            (f'{e.get("skill_id")}（成功 {int(e.get("steps_succeeded") or 0)} 步）'
             if e.get("skill_id") != storage.TASK_LEVEL_SKILL_ID else
             f'（本次任务无技能覆盖，自主完成 {int(e.get("steps_succeeded") or 0)} 步）')
            for e in ok_exps
        ],
        validated_skills=sorted({e.get("skill_id", "") for e in ok_exps
                                 if e.get("skill_id")
                                 and e.get("skill_id") != storage.TASK_LEVEL_SKILL_ID}),

        failed_experiences=[(e.get("failure_class") or "unspecified") for e in failed],
        failure_class=(failed[0].get("failure_class") if failed else None),
        created_at=time.time(),
    )


def record_goal_validation_edges(obs: EvolutionObservation, storage) -> int:
    """把观察里的验证证据落到关系图：goal VALIDATES skill（Step D 挂点）。

    幂等由 add_relation 的 UNIQUE 保证——同一目标反复验证同一技能只留一条
    边。失败的经验不建边：没通过验证不算 VALIDATES，这是纪律不是疏忽。
    """
    n = 0
    if not obs.goal_id:
        return 0
    for skill_id in (obs.validated_skills or []):
        storage.add_relation(
            "goal", obs.goal_id, "VALIDATES", "skill", skill_id,
            evidence=f"validator status={obs.validator_result.get('status')}",
        )
        n += 1
    return n


# ── 观察层出口（Step C 收口）：决策 → 真实待审产物 ───────────────────────────
#
# 在这段代码之前，observe() 是一个终点水槽：它把 BOTH / MEMORY_ONLY /
# SKILL_ONLY 判得很认真，然后**什么也不产生**。整条自进化链因此在这里断成
# 两半——前半段（轨迹、经验、分类）真实存在，后半段（候选、门禁、审批）也
# 真实存在，中间没有管子。用户看到的就是"AI 说它学到了，但下次还是从零开始"。
#
# 这里补的就是那根管子。三条纪律：
# 1. 只产**待审**物：MemoryProposal → pending，SkillCandidate → candidate。
#    没有任何一条路径能从这里直接写 MEMORY.md 或上线技能。
# 2. 复用既有闸门，不新开写入口：记忆走 EvolutionStore 的提案表（同一套
#    签名去重、冷却、max_open 上限），技能走 skill_lifecycle.create_candidate
#    （同一套 experience_ref 必须是成功经验的硬约束）。
# 3. 宁少不滥。一次观察最多产 MAX_FACT_PROPOSALS 条记忆提案；技能候选只在
#    "本次任务确实没有任何技能覆盖"时产一个——已有技能跑通不需要再造一个。

#: 一次观察最多产出多少条记忆提案。
#:
#: 不设上限的话，一个抽出 20 条事实的长任务会一次糊满审批队列，用户下次打开
#: 只会全部拒绝——那等于这个功能从未存在。宁可漏，不可刷。
MAX_FACT_PROPOSALS = 3

#: 自动生成的技能候选名前缀。带前缀是为了让用户在审批界面一眼分辨
#: "这是机器起草的"，也避免和人写的技能撞名。
AUTO_SKILL_PREFIX = "auto-"


def _slugify(text: str, *, limit: int = 40) -> str:
    """把一句自然语言压成可当目录名的 slug。

    非 ASCII 直接丢会让中文目标退化成空串，所以中日韩字符保留——技能目录名
    允许 Unicode，SkillLoader 按目录名读取，不做 ASCII 假设。
    """
    cleaned = re.sub(r"[^\w\u4e00-\u9fff]+", "-", str(text or "").strip().lower())
    return cleaned.strip("-")[:limit] or "task"


#: 判定"疑似冲突"的字符二元组相似度下限。0.55 是有意偏保守的一档：
#: 宁可把一条真冲突当成新增（用户还能自己在 MEMORY.md 里删旧行），也不要把
#: 两条无关事实说成冲突——那会让裁决界面开始说谎，而用户是照着它删记忆的。
CONFLICT_MIN_SIMILARITY: float = 0.55


def _bigrams(text: str) -> set:
    """字符二元组集合。

    刻意不做分词：中文没有空格，英文按词切，两套逻辑就有两种阈值行为。字符
    二元组对两种语言都给出稳定的相似度，且不引入任何依赖。
    """
    s = re.sub(r"[\s\W_]+", "", str(text or "").lower())
    return {s[i:i + 2] for i in range(len(s) - 1)} if len(s) > 1 else {s}


def _similarity(a: str, b: str) -> float:
    """Jaccard 相似度，0..1。"""
    x, y = _bigrams(a), _bigrams(b)
    if not x or not y:
        return 0.0
    return len(x & y) / len(x | y)


def find_conflicting_line(text: str, existing: list) -> str:
    """在已落盘的规则行里找"说的是同一件事但结论不同"的那一行。

    返回命中的原行（含 "- " 前缀），没有就返回空串。完全相同的行不算冲突——
    那是"已经知道了"，由调用方另行跳过。
    """
    target = str(text or "").strip()
    if not target:
        return ""
    best, best_score = "", 0.0
    for line in existing or []:
        raw = str(line or "").strip()
        body = raw.lstrip("-").strip()
        if not body or body == target:
            continue
        score = _similarity(target, body)
        if score >= CONFLICT_MIN_SIMILARITY and score > best_score:
            best, best_score = raw, score
    return best


def _existing_rules(engine, target_file: str) -> list:
    """目标文件里已落盘的 Learned Rules 行。读不到就当空。"""
    try:
        path = os.path.join(engine.workspace_root, target_file)
        if not os.path.isfile(path):
            return []
        with open(path, "r", encoding="utf-8") as f:
            _head, lines, _tail = _split_evolution_section(f.read())
        return lines
    except OSError:
        return []


def _retire_superseded_memory(p: "Proposal", workspace_root: str = "") -> int:
    """把被裁决掉的旧事实从记忆库里归档。返回归档条数。

    只在"写盘成功 + 确实替换了某一行"之后调用。失败绝不上抛：记忆库退役是这次
    裁决的后续动作，它出问题不该让已经落盘的批准看起来像失败。

    归档而不是删除——用户可能改主意，而 archived 行仍能被审计到。
    """
    body = (p.supersedes or "").lstrip("-").strip()
    if not body:
        return 0
    try:
        from storage import get_storage
        st = get_storage()
        ids = st.find_memories_by_content(workspace_root or os.getcwd(), body)
        for mid in ids:
            st.archive_memory(mid)
        if ids:
            print(f"[evolution] retired {len(ids)} superseded memory row(s)")
        return len(ids)
    except Exception as exc:  # noqa: BLE001
        print(f"[evolution] retire superseded memory failed: {exc}")
        return 0


def _propose_facts(obs: "EvolutionObservation", engine, *, storage=None, bundle_id: str = "") -> list[str]:
    """把观察里的新事实做成待审记忆提案，返回新建的 proposal id。

    去重、冷却、总量上限全部复用信号管线那套判据——一条事实的提案和一条
    复发失败的提案在用户眼里是同一种东西（"要不要把这句话写进引导文件"），
    没有理由用两套规则。
    """
    made: list[str] = []
    policy = MODE_POLICIES.get(engine.mode)
    if policy is None:
        return made  # off 档没有策略条目；查表会 KeyError，不伪造阈值

    # 已落盘的规则行读一次就够：同一次观察里最多三条事实，逐条重读文件没意义。
    existing = _existing_rules(engine, KIND_TARGET["learned_fact"])

    for fact in (obs.new_facts or [])[:MAX_FACT_PROPOSALS]:
        text = str(fact or "").strip()
        if len(text) < 8:
            continue  # 太短的"事实"没有信息量，只会污染每轮注入的上下文
        if _SECRET_HINT.search(text):
            continue  # 二道防线：classify 已拦过整包，这里按条再拦一次

        # 盘上已经有一模一样的一行 → 已经知道了
        if any(str(l or "").lstrip("-").strip() == text for l in existing):
            continue
        sig = signature_for("learned_fact", "", text)
        if engine.store.has_open_for_signature(sig):
            continue
        last_rej = engine.store.last_rejected_at(sig)
        if last_rej and (time.time() - last_rej) < policy.reject_cooldown_s:
            continue

        clash = find_conflicting_line(text, existing)
        is_over_quota = engine.store.count_open() >= policy.max_open

        p = None
        if not is_over_quota:
            p = Proposal(
                id=uuid.uuid4().hex[:12],
                signature=sig,
                kind="fact_conflict" if clash else "learned_fact",
                tool_name="",
                target_file=KIND_TARGET["learned_fact"],
                draft=f"- {text}",
                rationale=(
                    (f"疑似与已有记忆冲突，批准即替换：{clash}｜"
                     if clash else "")
                    + f"任务 {obs.goal_id or '-'} 结束时抽出的事实"
                      f"（决策 {obs.decision}：{obs.reason}）"),
                hits=1,
                status="pending",
                created_at=time.time(),
                supersedes=clash,
            )
            engine.store.insert_proposal(p)
            made.append(p.id)

        # 写入一等 LearningItem 账本（§11.2 & §13.5 & Phase 24）
        try:
            from storage import get_storage
            from event_types import EventType
            st = storage or get_storage()
            pid = p.id if p else uuid.uuid4().hex[:12]
            item_id = f"li_{pid}"
            item_status = "proposed" if not is_over_quota else "deferred"
            item_notif = "actionable" if not is_over_quota else "silent"
            defer_reason = "" if not is_over_quota else "待审配额已满，进入暂缓队列"
            branch_id = getattr(obs, "branch_id", "") or ""
            turn_list = list(obs.turn_ids or [])
            src_turn = turn_list[-1] if turn_list else ""
            ev_list = [str(e) for e in (obs.source_event_ids or []) if str(e).strip()]

            st.insert_learning_item(
                learning_item_id=item_id,
                bundle_id=bundle_id or "",
                session_id=obs.session_id or "",
                branch_id=branch_id,
                episode_id=getattr(obs, "episode_id", "") or "",
                kind="memory_fact" if not clash else "preference",
                scope="workspace",
                content=text,
                why=(p.rationale if p else f"提取事实（暂缓待审）：{text[:60]}"),
                status=item_status,
                notification_policy=item_notif,
                target_ref=p.id if p else "",
                deferred_reason=defer_reason,
                source_goal_id=obs.goal_id or "",
                source_run_id=obs.run_id or "",
                source_session_id=obs.session_id or "",
                source_event_ids=ev_list,
                source_turn_id=src_turn,
                confidence=0.9,
                evidence_summary=f"从任务 {obs.goal_id or '-'} 终态提取",
                future_effect="将在后续对话与任务中作为项目事实召回",
                idempotency_key=f"prop:{obs.session_id}:{branch_id}:{sig}",
            )

            # 发射事件
            try:
                ev_type = EventType.LEARNING_ITEM_PROPOSED.value if not is_over_quota else EventType.LEARNING_ITEM_DEFERRED.value
                st.get_event_store().append(
                    obs.session_id or "default",
                    ev_type,
                    {
                        "learning_item_id": item_id,
                        "proposal_id": p.id if p else "",
                        "kind": "memory_fact",
                        "scope": "workspace",
                        "content": text,
                        "why": (p.rationale if p else "待审配额已满，进入暂缓队列"),
                        "future_effect": "将在后续对话与任务中作为项目事实召回",
                    },
                    branch_id=branch_id or None,
                    goal_id=obs.goal_id or None,
                    run_id=obs.run_id or None,
                )
            except Exception:
                pass
        except Exception as _li_e:
            print(f"[evolution] learning item insert failed: {_li_e}")
    return made


def _propose_skill_candidate(obs: "EvolutionObservation", storage, *, bundle_id: str = "") -> Optional[str]:
    """任务成功但无技能覆盖 → 起草一个技能候选。返回候选 id 或 None。

    这是全系统第一个**自动**候选生产者。在它之前 create_candidate 只有
    HTTP handler 一个调用者，也就是"只有人手动 POST 才会有候选"——所谓
    自进化的入口从来没接上。

    刻意的保守之处：
    * 只在 TASK_LEVEL 那条成功经验存在时产出。已有技能跑通了，不需要再造
      一个同义技能；那是重复，不是学习。
    * 名字带 ``auto-`` 前缀并检查重名。撞名候选一定过不了 collision 门禁，
      与其产一个注定失败的候选去污染队列，不如不产。
    * 状态停在 ``candidate``。门禁与审批仍在下游，这里一步都不越过。
    """
    goal_id = str(obs.goal_id or "")
    if not goal_id:
        return None
    try:
        rows = storage.list_skill_experiences(
            goal_id=goal_id, skill_id=storage.TASK_LEVEL_SKILL_ID, limit=10,
        )
    except Exception:  # noqa: BLE001
        return None
    exp = next((r for r in rows if r.get("outcome") == "success"), None)
    if not exp:
        return None  # 没有"无技能覆盖且成功"的证据 → 无从孵化

    goal = {}
    try:
        goal = storage.get_goal(goal_id) or {}
    except Exception:  # noqa: BLE001
        goal = {}
    desc = str(goal.get("description") or "").strip()
    if len(desc) < 8:
        return None  # 目标描述太短，起草出来的技能没人看得懂它干什么

    name = AUTO_SKILL_PREFIX + _slugify(desc)
    try:
        if any(c.get("name") == name for c in storage.list_skill_candidates(limit=200)):
            return None  # 同名候选已在队列里等着，不重复立项
    except Exception:  # noqa: BLE001
        pass
    cand_id = _incubate(storage, exp, goal_id, desc, name)
    if cand_id:
        # 写入一等 LearningItem 账本
        try:
            from event_types import EventType
            item_id = f"li_cand_{cand_id}"
            branch_id = getattr(obs, "branch_id", "") or ""
            turn_list = list(obs.turn_ids or [])
            src_turn = turn_list[-1] if turn_list else ""
            ev_list = [str(e) for e in (obs.source_event_ids or []) if str(e).strip()]
            storage.insert_learning_item(
                learning_item_id=item_id,
                bundle_id=bundle_id or "",
                session_id=obs.session_id or "",
                branch_id=branch_id,
                episode_id=getattr(obs, "episode_id", "") or "",
                kind="skill_step",
                scope="workspace",
                content=f"技能候选：{name}",
                why=f"目标「{desc[:60]}」自主执行成功，沉淀为流程候选",
                status="staged",
                notification_policy="actionable",
                target_ref=cand_id,
                source_goal_id=goal_id,
                source_run_id=obs.run_id or "",
                source_session_id=obs.session_id or "",
                source_event_ids=ev_list,
                source_turn_id=src_turn,
                confidence=0.85,
                evidence_summary=f"基于 goal={goal_id} 成功运行孵化",
                future_effect="经审批并验证后可在类似任务中作为 Skill 调用",
                idempotency_key=f"skill:{obs.session_id}:{branch_id}:{cand_id}",
            )

            try:
                storage.get_event_store().append(
                    obs.session_id or "default",
                    EventType.LEARNING_ITEM_PROPOSED.value,
                    {
                        "learning_item_id": item_id,
                        "candidate_id": cand_id,
                        "kind": "skill_step",
                        "scope": "workspace",
                        "content": f"技能候选：{name}",
                        "why": f"目标「{desc[:60]}」自主执行成功",
                        "future_effect": "经审批并验证后可在类似任务中作为 Skill 调用",
                    },
                    branch_id=branch_id or None,
                    goal_id=goal_id or None,
                    run_id=obs.run_id or None,
                )
            except Exception:
                pass
        except Exception as _li_e:
            print(f"[evolution] skill candidate learning item insert failed: {_li_e}")
    return cand_id


def _incubate(storage, exp: dict, goal_id: str, desc: str,
              name: str) -> Optional[str]:
    """真正落一条候选。步骤来自 goal_iterations——真实跑过的轮次，不是编的。"""
    steps: list[str] = []
    try:
        for it in storage.list_goal_iterations(goal_id, limit=20):
            summary = str(it.get("verdict_reason") or it.get("evidence_digest") or "").strip()
            if summary:
                steps.append(f"第 {it.get('ordinal')} 轮：{normalize_error(summary)[:160]}")
    except Exception:  # noqa: BLE001
        steps = []
    if not steps:
        # 没有轮次记录时给一条如实的占位步骤，而不是留空让结构门禁去挡。
        # 写"待补全"是诚实的：这条候选确实需要人补步骤才配上线。
        steps = [f"待补全：本次任务成功完成，但没有留下分轮记录（goal={goal_id}）"]

    fields = {
        "name": name,
        "description": desc[:200],
        "when_to_use": f"遇到与「{desc[:80]}」同类的任务时",
        # verification 是必填门禁字段。这里如实写"人工确认"而不是塞一条
        # 假命令——假命令会让 verification_run 门禁跑出一个无意义的绿灯。
        "verification": "人工确认产出与目标描述一致（自动起草，未附机器验证命令）",
        "steps": steps,
        "risk_level": "medium",
        "known_failures": (f"来源：goal {goal_id} 的一次成功执行，"
                           f"样本量 1——尚未在第二个场景验证过"),
        "experience_ref": exp.get("experience_id") or "",
    }
    try:
        from skill_lifecycle import create_candidate
        res = create_candidate(storage, fields)
    except Exception as exc:  # noqa: BLE001
        print(f"[evolution] candidate incubation failed: {exc}")
        return None
    if not res.ok:
        print(f"[evolution] candidate rejected at creation: {res.error}")
        return None
    cand = res.value or {}
    return str(cand.get("id") or "") or None


# ── 显式自我反思生成器 (Reflexion Generator) ───────────────────────────────────

class ReflectionGenerator:
    """显式自我反思生成器与记忆检索层（Reflexion 启发）。"""

    @staticmethod
    def generate_reflection(obs: EvolutionObservation) -> Optional[SemanticReflection]:
        """从终态观察中提炼语义反思（根因、替代策略、预防规则与适用边界）。"""
        if not obs:
            return None
        
        has_failures = bool(obs.failed_experiences or obs.failure_class)
        has_success = bool(obs.reusable_steps or (obs.validator_result and obs.validator_result.get("passed")))
        
        if not has_failures and not has_success:
            return None

        # 秘密/凭证防线拦截
        blob = f"{obs.failure_class or ''} {obs.user_feedback or ''} {' '.join(obs.failed_experiences or [])}"
        if _SECRET_HINT.search(blob):
            return None

        rid = f"ref_{uuid.uuid4().hex[:8]}"
        goal_id = str(obs.goal_id or "")

        if has_failures:
            fc = str(obs.failure_class or (obs.failed_experiences[0] if obs.failed_experiences else "unknown_failure"))
            
            if "permission" in fc.lower() or "auth" in fc.lower():
                rc = "权限与只读策略拦截 (Permission Denied / Readonly Path)"
                alt = "预先检查目标路径的写权限与只读清单，切换为临时目录或请求用户审批"
                rule = "严禁对受保护目录或未知凭证路径进行盲目重试写入"
                boundary = "涉及系统核心配置或引导文件时强制走提案审批"
            elif "timeout" in fc.lower() or "latency" in fc.lower():
                rc = "子任务处理超时与算力耗尽 (Timeout / Exhaustion)"
                alt = "将长流水线拆分为具备中间 Checkpoint 的短原子步骤，并增加增量分页处理"
                rule = "单次命令与大文件读取必须设置有界超时时间与进度心跳"
                boundary = "适用于大型工程构建、全量索引扫描与网络重试"
            elif "schema" in fc.lower() or "invalid_tool" in fc.lower():
                rc = "工具入参格式错误或合约 Schema 不匹配 (Schema Validation Mismatch)"
                alt = "在工具调用前严格核对必填字段与类型定义，对复杂参数进行预校验"
                rule = "工具参数必须按照 JSON Schema 格式精确输出，禁止输出非法多余键"
                boundary = "适用于所有 Backend Tool 与 MCP 工具调用"
            elif "not_found" in fc.lower() or "enoent" in fc.lower():
                rc = "目标文件或环境依赖不存在 (Resource Not Found)"
                alt = "在操作目标资源前，先调用 find_by_name / list_dir 校验其存在性"
                rule = "假定路径存在即操作是危险的，必须先做存在性探针检查"
                boundary = "适用于工作区文件与虚拟环境依赖定位"
            else:
                rc = f"任务执行遇到异常 ({fc})"
                alt = "保留现场日志，分析异常调用栈并优先尝试最小可重现代码"
                rule = "遇到未归类异常时限制重试次数为 1，避免雪崩式重试风暴"
                boundary = "通用任务执行与未预期错误处理"

            return SemanticReflection(
                reflection_id=rid,
                goal_id=goal_id,
                root_cause=rc,
                alternative_strategy=alt,
                preventative_rule=rule,
                boundary=boundary,
                outcome="failure",
                confidence=0.85,
            )
        else:
            # 成功经验的正面沉淀
            return SemanticReflection(
                reflection_id=rid,
                goal_id=goal_id,
                root_cause="流程正常执行无异常",
                alternative_strategy="保持当前工作流的高效参数与分步验证方式",
                preventative_rule=f"在相似目标中复用此验证链: {', '.join(str(s) for s in (obs.reusable_steps or [])[:2])}",
                boundary=f"适用于 goal={goal_id} 同类任务",
                outcome="success",
                confidence=0.90,
            )

    @staticmethod
    def store_reflection_as_memory(
        reflection: SemanticReflection,
        storage,
        root_dir: str = "",
    ) -> Optional[str]:
        """将反思安全存入 SEMANTIC 向量层或 DREAMING 池（杜绝写入短期快速衰减层）。"""
        if not reflection or not storage:
            return None
        try:
            from memory_tiers import MemoryTier
            tier_val = MemoryTier.SEMANTIC.value
        except Exception:
            tier_val = "semantic"

        content = (
            f"【经验反思 | {reflection.outcome.upper()}】\n"
            f"- 根因分析: {reflection.root_cause}\n"
            f"- 替代策略: {reflection.alternative_strategy}\n"
            f"- 预防规则: {reflection.preventative_rule}\n"
            f"- 适用边界: {reflection.boundary}"
        )

        try:
            storage.save_memory_entry(
                eid=reflection.reflection_id,
                sid="evolution_reflection",
                root=root_dir or ".",
                scope="project",
                content=content,
                mem_type="reflection",
                importance=0.75,
                tags=["reflection", reflection.outcome, reflection.root_cause[:20]],
                tier=tier_val,
                confidence=reflection.confidence,
                source_goal_id=reflection.goal_id,
                status="active",
            )
            return reflection.reflection_id
        except Exception as exc:
            logger.warning(f"[evolution] save reflection memory failed: {exc}")
            return None

    @staticmethod
    def retrieve_reflections(
        storage,
        query: str = "",
        root_dir: str = "",
        limit: int = 3,
    ) -> list[dict]:
        """按相关性召回适用的历史反思经验。"""
        if not storage:
            return []
        try:
            entries = storage.get_memory_entries(
                root=root_dir or None,
                mem_type="reflection",
                include_archived=False,
                limit=limit * 2,
            )
            if not query:
                return entries[:limit]

            q_lower = query.lower()
            scored = []
            for e in entries:
                text = (e.get("content") or "").lower()
                matches = sum(1 for term in q_lower.split() if term in text)
                scored.append((matches, e))
            scored.sort(key=lambda x: x[0], reverse=True)
            return [item[1] for item in scored[:limit]]
        except Exception as exc:
            logger.warning(f"[evolution] retrieve reflections failed: {exc}")
            return []


def materialize_observation(obs: "EvolutionObservation", storage,
                           engine, *, bundle_id: str = "") -> dict:
    """观察决策 → 待审产物。这是 observe() 之后唯一的产出口。

    Returns:
        ``{"memoryProposals": [id…], "skillCandidate": id|"", "learningItems": [id…], "reason": str}``。
        什么都没产时 ``reason`` 说明为什么——"没产出"和"产出失败"必须分得开，
        否则这条链下次再断，日志里依旧看不出断在哪。
    """
    bid = bundle_id or f"bundle_{uuid.uuid4().hex[:12]}"
    out: dict = {"memoryProposals": [], "skillCandidate": "", "learningItems": [], "reason": "", "bundle_id": bid}
    if obs is None or obs.decision == DECISION_NO_OP:
        out["reason"] = f"决策 {getattr(obs, 'decision', '-')}：按判据不产出"
        return out
    if not engine.enabled():
        out["reason"] = "evolution off：不产出任何待审物"
        return out

    if obs.decision in (DECISION_MEMORY_ONLY, DECISION_BOTH):
        try:
            out["memoryProposals"] = _propose_facts(obs, engine, storage=storage, bundle_id=bid)
            out["learningItems"].extend([f"li_{pid}" for pid in out["memoryProposals"]])
        except Exception as exc:  # noqa: BLE001
            print(f"[evolution] fact proposals failed: {exc}")
    if obs.decision in (DECISION_SKILL_ONLY, DECISION_BOTH):
        try:
            cand_id = _propose_skill_candidate(obs, storage, bundle_id=bid) or ""
            out["skillCandidate"] = cand_id
            if cand_id:
                out["learningItems"].append(f"li_cand_{cand_id}")
        except Exception as exc:  # noqa: BLE001
            print(f"[evolution] skill candidate failed: {exc}")

    # 处理失败防护 (Failure Guard)
    if obs.failure_class:
        try:
            fg_id = f"li_guard_{uuid.uuid4().hex[:8]}"
            turn_list = list(obs.turn_ids or [])
            src_turn = turn_list[-1] if turn_list else ""
            ev_list = [str(e) for e in (obs.source_event_ids or []) if str(e).strip()]
            storage.insert_learning_item(
                learning_item_id=fg_id,
                bundle_id=bid,
                session_id=obs.session_id or "",
                kind="failure_guard",
                scope="workspace",
                content=f"失败防护：{obs.failure_class}",
                why=f"任务遇到失败（{obs.failure_class}），记录负向经验防线",
                status="discovered",
                notification_policy="receipt",
                source_goal_id=obs.goal_id or "",
                source_run_id=obs.run_id or "",
                source_session_id=obs.session_id or "",
                source_event_ids=ev_list,
                source_turn_id=src_turn,
                confidence=0.8,
                evidence_summary=f"来自 goal={obs.goal_id} 失败记录",
                future_effect="在相似场景中作为前置检查规则避免重复踩坑",
            )
            out["learningItems"].append(fg_id)
        except Exception as _fg_e:
            print(f"[evolution] failure guard insert failed: {_fg_e}")

    # 显式语义反思 (Reflexion Generator)
    try:
        reflection = ReflectionGenerator.generate_reflection(obs)
        if reflection:
            root_dir = ""
            try:
                if storage and hasattr(storage, "_root_dir"):
                    root_dir = storage._root_dir
            except Exception:
                pass
            ref_eid = ReflectionGenerator.store_reflection_as_memory(reflection, storage, root_dir=root_dir)
            if ref_eid:
                out["learningItems"].append(f"li_ref_{ref_eid}")
                out["reflection"] = reflection.to_dict()
    except Exception as _ref_e:
        print(f"[evolution] reflection generation/store failed: {_ref_e}")


    # Populate rich item details with individual versions for Chat & Panel (P1-2)
    item_details = []
    for lid in out.get("learningItems") or []:
        try:
            it = storage.get_learning_item(lid)
            if it:
                item_details.append({
                    "id": lid,
                    "version": it.get("version", 1),
                    "kind": it.get("kind", ""),
                    "content": it.get("content", ""),
                    "status": it.get("status", "discovered"),
                    "why": it.get("why", ""),
                    "scope": it.get("scope", "workspace"),
                })
        except Exception:
            pass
    out["learningItemDetails"] = item_details

    if not out["memoryProposals"] and not out["skillCandidate"] and not out["learningItems"]:
        out["reason"] = "判据成立但去重/冷却/上限/证据不足，本次无新增待审物"
    else:
        out["reason"] = (f"新增 {len(out['memoryProposals'])} 条记忆提案"
                         f"{'、1 个技能候选' if out['skillCandidate'] else ''}")
    return out







class EvolutionStore:
    """信号 + 提案的持久层。自带独立 SQLite，不挤 storage.py 的表集合。

    独立 DB 是刻意的：这是一个默认关闭的可选子系统，它的表不该出现在主库的
    schema 里。用户从没开过这个功能，主库就该干干净净——而且整个功能想撤掉时，
    删一个文件就够了。
    """

    def __init__(self, db_path: Optional[str] = None):
        self._conn = sqlite3.connect(str(db_path or _db_path()), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS signals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT,
                kind TEXT NOT NULL,
                signature TEXT NOT NULL,
                tool_name TEXT,
                detail TEXT,
                created_at REAL NOT NULL
            )
        """)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sig ON signals(signature, created_at)"
        )
        try:
            self._conn.execute("ALTER TABLE signals ADD COLUMN failure_kind TEXT DEFAULT ''")
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc).lower():
                raise
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS proposals (
                id TEXT PRIMARY KEY,
                signature TEXT NOT NULL,
                kind TEXT,
                tool_name TEXT,
                target_file TEXT NOT NULL,
                draft TEXT NOT NULL,
                rationale TEXT,
                hits INTEGER DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at REAL NOT NULL,
                decided_at REAL DEFAULT 0,
                applied INTEGER DEFAULT 0
            )
        """)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_prop_sig ON proposals(signature, status)"
        )
        # 被这条提案取代的那一行原文。空串 = 纯新增。
        # 冲突裁决需要它：接受一条"更新版事实"时必须**替换**旧行而不是追加，
        # 否则 MEMORY.md 里会同时留着"项目用 npm"和"项目用 pnpm"，而每轮都注入
        # 模型的正是这两行——自相矛盾的上下文比没有上下文更坏。
        try:
            self._conn.execute("ALTER TABLE proposals ADD COLUMN supersedes TEXT DEFAULT ''")
        except sqlite3.OperationalError as exc:
            if "duplicate column" not in str(exc).lower():
                raise
        # 效果回访三列：verdict（effective/improving/ineffective）、回访时间、
        # 生效前基线（同签名在 decided_at 前一窗口的复发次数）。effect='' 表示
        # 尚未回访。
        for _ddl in (
            "ALTER TABLE proposals ADD COLUMN effect TEXT DEFAULT ''",
            "ALTER TABLE proposals ADD COLUMN effect_reviewed_at REAL DEFAULT 0",
            "ALTER TABLE proposals ADD COLUMN effect_baseline INTEGER DEFAULT -1",
        ):
            try:
                self._conn.execute(_ddl)
            except sqlite3.OperationalError as exc:
                if "duplicate column" not in str(exc).lower():
                    raise
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS observations (
                id TEXT PRIMARY KEY,
                decision TEXT NOT NULL,
                goal_id TEXT DEFAULT '',
                session_id TEXT DEFAULT '',
                reason TEXT DEFAULT '',
                payload TEXT NOT NULL,
                created_at REAL NOT NULL
            )
        """)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(created_at)"
        )
        # ── LearningBundle（统一学习证据束）───────────────────────────────
        #
        # Memory proposal 和 Skill candidate 是同一条经验的两个投影——这句话
        # 之前只是口号：提案在 proposals 表、候选在 skill_candidates 表、经验
        # 在 skill_experiences 表，三者之间没有一行数据能证明"它们来自同一次
        # 任务"。每个终态目标在这里固定落一条 bundle：四路决策（含 NO_OP 的
        # "为什么没学"）、全部产物 id、共享的经验/轮次证据。审批联动由
        # decide() 回写 user_verdict，闭环到"人最终怎么看这条学习"。
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS learning_bundles (
                learning_id TEXT PRIMARY KEY,
                goal_id TEXT DEFAULT '',
                run_id TEXT DEFAULT '',
                session_id TEXT DEFAULT '',
                decision TEXT NOT NULL DEFAULT '',
                rationale TEXT DEFAULT '',
                turn_ids TEXT DEFAULT '[]',
                experience_ids TEXT DEFAULT '[]',
                memory_proposal_ids TEXT DEFAULT '[]',
                skill_candidate_id TEXT DEFAULT '',
                validator_result TEXT DEFAULT '{}',
                user_verdict TEXT DEFAULT 'pending',
                created_at REAL NOT NULL
            )
        """)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_bundle_goal"
            " ON learning_bundles(goal_id, created_at)"
        )
        # 幂等（§11.3）。同一个目标的同一次运行到达同一个终态，只能有一条
        # bundle——这件事必须由数据库保证，Python 里的"我记得刚才落过了"在
        # 进程重启、双窗口、事件重播面前一文不值。而这不是假想的风险：
        # completed 会先走 _emit_change 再走一次直接 emit，同一次完成本来
        # 就会把订阅者调用两遍。
        #
        # 加列而不是重建表：evolution.db 里已有的行没有 key，用**部分**唯一
        # 索引（WHERE bundle_key != ''）把它们排除在约束之外，老库照样能开。
        for _col in ("bundle_key", "outcome", "terminal_event_id", "learning_item_ids", "skill_candidate_ids"):
            try:
                self._conn.execute(
                    f"ALTER TABLE learning_bundles ADD COLUMN {_col} TEXT DEFAULT ''")
            except sqlite3.OperationalError:
                pass  # 列已存在
        self._conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_bundle_key"
            " ON learning_bundles(bundle_key) WHERE bundle_key != ''"
        )
        self._conn.commit()


    # ── 观察（Step C）────────────────────────────────────────────────────

    def insert_observation(self, o) -> str:
        """观察只增不改——它是对已发生事实的归档，改写历史等于伪造证据。"""
        obs_id = uuid.uuid4().hex[:12]
        d = o.to_dict()
        self._conn.execute(
            "INSERT INTO observations (id, decision, goal_id, session_id, reason,"
            " payload, created_at) VALUES (?,?,?,?,?,?,?)",
            (obs_id, d["decision"] or "UNCLASSIFIED", o.goal_id or "",
             o.session_id or "", d["reason"], json.dumps(d, ensure_ascii=False),
             float(o.created_at or time.time())),
        )
        self._conn.commit()
        return obs_id

    def list_observations(self, limit: int = 50) -> list[dict]:
        rows = self._conn.execute(
            "SELECT id, decision, goal_id, session_id, reason, payload, created_at"
            " FROM observations WHERE session_id NOT LIKE 'bench-%' AND session_id NOT LIKE 'tool-test-%' ORDER BY created_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        out = []
        for r in rows:
            try:
                payload = json.loads(r["payload"])
            except (json.JSONDecodeError, TypeError):
                payload = {}
            out.append({
                "id": r["id"], "decision": r["decision"],
                "goalId": r["goal_id"], "sessionId": r["session_id"],
                "reason": r["reason"], "createdAt": r["created_at"],
                **payload,
            })
        return out

    # ── LearningBundle ──────────────────────────────────────────────────

    #: JSON 列与 dict 键的对应，读写共用一份，避免两处漂移。
    _BUNDLE_JSON_FIELDS = {
        "turn_ids": "turnIds",
        "experience_ids": "experienceIds",
        "memory_proposal_ids": "memoryProposalIds",
    }

    def find_bundle_by_key(self, bundle_key: str) -> dict | None:
        """已经落过的那条 bundle，没有就是 None。重复 materialize 靠它返回原件。"""
        if not bundle_key:
            return None
        try:
            r = self._conn.execute(
                "SELECT * FROM learning_bundles WHERE bundle_key=?",
                (str(bundle_key),),
            ).fetchone()
        except sqlite3.OperationalError:
            return None  # 老库还没有 bundle_key 列
        return self._bundle_row_to_dict(r) if r else None

    def insert_bundle(self, *, goal_id: str = "", run_id: str = "",
                      session_id: str = "", decision: str = "",
                      rationale: str = "", turn_ids=None,
                      experience_ids=None, memory_proposal_ids=None,
                      skill_candidate_id: str = "",
                      skill_candidate_ids=None,
                      learning_item_ids=None,
                      validator_result=None, bundle_key: str = "",
                      outcome: str = "", terminal_event_id: str = "",
                      bundle_id: str = "") -> str:

        """落一条学习证据束，给了 ``bundle_key`` 就是幂等的。

        幂等在这里有三层，而且**都不靠内存**：

        1. ``learning_id`` 由 key 派生（sha256 前 16 位），所以同一次终态永远
           叫同一个名字——UI 里的链接、关系图里的边、日志里的 id 不会因为重放
           而分叉。
        2. 写之前先查：查到就原样返回旧 id，不覆盖、不追加。旧的那条才是真正
           发生过的记录，第二次调用没有任何新证据可言。
        3. 真撞上并发（两个进程同时处理同一个终态），唯一索引会抛
           IntegrityError，这里接住再查一次——数据库赢，代码认。

        不给 key 就退回旧行为（随机 id、每次一条），因为没有 key 就没有"同一
        件事"的定义，硬编一个反而会把两次真实的不同学习合成一条。
        """
        key = str(bundle_key or "")
        if key:
            prev = self.find_bundle_by_key(key)
            if prev:
                return str(prev.get("learningId") or "")
            learning_id = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
        else:
            learning_id = bundle_id or uuid.uuid4().hex[:12]
        cols = ("learning_id, goal_id, run_id, session_id, decision, rationale,"
                " turn_ids, experience_ids, memory_proposal_ids,"
                " skill_candidate_id, validator_result, user_verdict, created_at")
        vals = [
            learning_id, str(goal_id or ""), str(run_id or ""),
            str(session_id or ""), str(decision or ""),
            str(rationale or ""),
            json.dumps(list(turn_ids or []), ensure_ascii=False),
            json.dumps(list(experience_ids or []), ensure_ascii=False),
            json.dumps(list(memory_proposal_ids or []), ensure_ascii=False),
            str(skill_candidate_id or ""),
            json.dumps(validator_result or {}, ensure_ascii=False),
            "pending", float(time.time()),
        ]
        try:
            self._conn.execute(
                f"INSERT INTO learning_bundles ({cols}, bundle_key, outcome,"
                f" terminal_event_id, learning_item_ids, skill_candidate_ids)"
                f" VALUES ({','.join('?' * (len(vals) + 5))})",
                (
                    *vals,
                    key,
                    str(outcome or ""),
                    str(terminal_event_id or ""),
                    json.dumps(list(learning_item_ids or []), ensure_ascii=False),
                    json.dumps(list(skill_candidate_ids or ([skill_candidate_id] if skill_candidate_id else [])), ensure_ascii=False),
                ),
            )

        except sqlite3.IntegrityError:
            # 并发或重放：唯一索引拦住了第二条。旧件为准。
            self._conn.rollback()
            prev = self.find_bundle_by_key(key)
            return str((prev or {}).get("learningId") or learning_id)
        except sqlite3.OperationalError:
            # 老库没有新列：照旧写一条，幂等降级为"至少不崩"。
            self._conn.execute(
                f"INSERT INTO learning_bundles ({cols})"
                f" VALUES ({','.join('?' * len(vals))})", tuple(vals))
        self._conn.commit()
        return learning_id


    def _bundle_row_to_dict(self, r: sqlite3.Row) -> dict:
        d = {
            "learningId": r["learning_id"],
            "goalId": r["goal_id"],
            "runId": r["run_id"],
            "sessionId": r["session_id"],
            "decision": r["decision"],
            "rationale": r["rationale"],
            "skillCandidateId": r["skill_candidate_id"],
            "userVerdict": r["user_verdict"],
            "createdAt": r["created_at"],
        }
        # 老库（加列之前写下的行）读不到这两列，缺就当空——读路径不该因为
        # 一次没跑成的 ALTER 就整表报错。
        _have = set(r.keys())
        d["bundleKey"] = r["bundle_key"] if "bundle_key" in _have else ""
        d["outcome"] = r["outcome"] if "outcome" in _have else ""
        d["terminalEventId"] = r["terminal_event_id"] if "terminal_event_id" in _have else ""
        try:
            d["learningItemIds"] = json.loads(r["learning_item_ids"]) if "learning_item_ids" in _have and r["learning_item_ids"] else []
        except Exception:
            d["learningItemIds"] = []
        try:
            d["skillCandidateIds"] = json.loads(r["skill_candidate_ids"]) if "skill_candidate_ids" in _have and r["skill_candidate_ids"] else []
        except Exception:
            d["skillCandidateIds"] = []


        for col, key in self._BUNDLE_JSON_FIELDS.items():
            try:
                d[key] = json.loads(r[col] or "[]")
            except (json.JSONDecodeError, TypeError, KeyError, IndexError):
                d[key] = []
        try:
            d["validatorResult"] = json.loads(r["validator_result"] or "{}")
        except (json.JSONDecodeError, TypeError):
            d["validatorResult"] = {}
        return d

    def list_bundles(self, limit: int = 50) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM learning_bundles ORDER BY created_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        return [self._bundle_row_to_dict(r) for r in rows]

    def bundles_for_goal(self, goal_id: str, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM learning_bundles WHERE goal_id=?"
            " ORDER BY created_at DESC LIMIT ?",
            (str(goal_id or ""), int(limit)),
        ).fetchall()
        return [self._bundle_row_to_dict(r) for r in rows]

    def mark_bundle_verdict_for_proposal(self, proposal_id: str,
                                         verdict: str) -> bool:
        """提案被裁决后回写所属 bundle 的 user_verdict。

        一条 bundle 可能挂多条提案：第一条的裁决先到，记它；后续裁决覆盖为
        最新的人意。找不到所属 bundle 返回 False——提案可能早于 bundle 存在，
        这不是错误。
        """
        if not proposal_id:
            return False
        rows = self._conn.execute(
            "SELECT learning_id, memory_proposal_ids FROM learning_bundles"
            " ORDER BY created_at DESC LIMIT 200",
        ).fetchall()
        for r in rows:
            try:
                ids = json.loads(r["memory_proposal_ids"] or "[]")
            except (json.JSONDecodeError, TypeError):
                continue
            if proposal_id in ids:
                cur = self._conn.execute(
                    "UPDATE learning_bundles SET user_verdict=? WHERE learning_id=?",
                    (str(verdict), r["learning_id"]),
                )
                self._conn.commit()
                return cur.rowcount > 0
        return False

    # ── 信号 ────────────────────────────────────────────────────────────

    def record_signal(self, kind: str, tool_name: str, detail: str,
                      session_id: str = "", failure_kind: str = "") -> str:
        """记录一条信号，返回它的签名。

        为什么先算签名再看限流：短路要在做 IO 之前发生。同一签名一天里能收到
        上千次同错，如果每一次都写盘 + 删旧，磁盘 IO 会大到影响正常回合。
        """
        sig = signature_for(kind, tool_name, detail)
        now = time.time()

        # 限流：同签名已经超上限就不再插入。计数已经够高了，多一条对挖掘没用，
        # 却会拖慢 index。
        count = self._conn.execute(
            "SELECT COUNT(*) as c FROM signals WHERE signature=?", (sig,)
        ).fetchone()["c"]
        if count >= MAX_SIGNALS_PER_SIGNATURE:
            return sig

        try:
            self._conn.execute(
                "INSERT INTO signals (session_id, kind, signature, tool_name, detail, created_at, failure_kind) "
                "VALUES (?,?,?,?,?,?,?)",
                (session_id, kind, sig, tool_name or "", (detail or "")[:2000], now, failure_kind or ""),
            )
        except sqlite3.OperationalError:
            self._conn.execute(
                "INSERT INTO signals (session_id, kind, signature, tool_name, detail, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (session_id, kind, sig, tool_name or "", (detail or "")[:2000], now),
            )
        # 顺便过期一下老信号；不是每次都跑全表清理——概率触发 + 用索引，
        # 均摊到 O(1)。
        if count == 0:
            self._conn.execute(
                "DELETE FROM signals WHERE created_at < ?", (now - SIGNAL_RETENTION_S,),
            )
        self._conn.commit()
        return sig

    def signal_stats(self, signature: str) -> dict:
        """给一个签名的复发情况：命中次数、首次和最近一次时间。"""
        r = self._conn.execute(
            "SELECT COUNT(*) as c, MIN(created_at) as first, MAX(created_at) as last, "
            "       MAX(tool_name) as tool, MAX(kind) as kind, MAX(detail) as detail "
            "FROM signals WHERE signature=?", (signature,),
        ).fetchone()
        if not r or not r["c"]:
            return {"hits": 0, "first": 0.0, "last": 0.0,
                    "tool_name": "", "kind": "", "detail": ""}
        return {
            "hits": int(r["c"]),
            "first": float(r["first"] or 0),
            "last": float(r["last"] or 0),
            "tool_name": r["tool"] or "",
            "kind": r["kind"] or "",
            "detail": r["detail"] or "",
        }

    def hot_signatures(self, min_hits: int, limit: int = 20) -> list[dict]:
        """当前复发达标的签名列表，按热度倒序。"""
        rows = self._conn.execute(
            "SELECT signature, COUNT(*) as hits, MAX(tool_name) as tool, "
            "       MAX(kind) as kind, MAX(detail) as detail, MAX(created_at) as last "
            "FROM signals GROUP BY signature "
            "HAVING hits >= ? ORDER BY hits DESC LIMIT ?",
            (int(min_hits), int(limit)),
        ).fetchall()
        return [dict(r) for r in rows]

    # ── 提案 ────────────────────────────────────────────────────────────

    def open_proposals(self) -> list[Proposal]:
        rows = self._conn.execute(
            "SELECT * FROM proposals WHERE status='pending' ORDER BY hits DESC, created_at ASC"
        ).fetchall()
        return [self._row_to_proposal(r) for r in rows]

    def all_proposals(self, limit: int = 50) -> list[Proposal]:
        rows = self._conn.execute(
            "SELECT * FROM proposals ORDER BY created_at DESC LIMIT ?", (int(limit),),
        ).fetchall()
        return [self._row_to_proposal(r) for r in rows]

    def get_proposal(self, proposal_id: str) -> Optional[Proposal]:
        r = self._conn.execute(
            "SELECT * FROM proposals WHERE id=?", (proposal_id,)
        ).fetchone()
        return self._row_to_proposal(r) if r else None

    def has_open_for_signature(self, signature: str) -> bool:
        r = self._conn.execute(
            "SELECT 1 FROM proposals WHERE signature=? AND status='pending' LIMIT 1",
            (signature,),
        ).fetchone()
        return bool(r)

    def last_rejected_at(self, signature: str) -> float:
        r = self._conn.execute(
            "SELECT MAX(decided_at) as t FROM proposals "
            "WHERE signature=? AND status='rejected'", (signature,),
        ).fetchone()
        return float(r["t"]) if r and r["t"] else 0.0

    def count_open(self) -> int:
        r = self._conn.execute(
            "SELECT COUNT(*) as c FROM proposals WHERE status='pending'"
        ).fetchone()
        return int(r["c"]) if r else 0

    def count_by_status(self) -> dict[str, int]:
        """全量按状态计数——不受 all_proposals 的 LIMIT 影响。

        审计页的"已接受/已拒绝"计数必须是终身总数，可 all_proposals 只取最近
        50 条，用它去过滤统计会随记录增多而越报越低。这里直接在库里 GROUP BY，
        让计数与"最近 N 条"列表脱钩。
        """
        rows = self._conn.execute(
            "SELECT status, COUNT(*) as c FROM proposals GROUP BY status"
        ).fetchall()
        out = {"pending": 0, "accepted": 0, "rejected": 0, "total": 0}
        for r in rows:
            status = str(r["status"] or "")
            n = int(r["c"] or 0)
            out["total"] += n
            if status in out:
                out[status] = n
        return out

    def insert_proposal(self, p: Proposal) -> None:
        clean_draft = PrivacySanitizer.clean(p.draft or "") if PrivacySanitizer else (p.draft or "")
        clean_rat = PrivacySanitizer.clean(p.rationale or "") if PrivacySanitizer else (p.rationale or "")
        self._conn.execute(
            "INSERT INTO proposals (id, signature, kind, tool_name, target_file, "
            "draft, rationale, hits, status, created_at, supersedes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (p.id, p.signature, p.kind, p.tool_name, p.target_file,
             clean_draft, clean_rat, p.hits, p.status, p.created_at,
             p.supersedes or ""),
        )
        self._conn.commit()

    def mark_decided(self, proposal_id: str, status: str, applied: bool) -> None:
        self._conn.execute(
            "UPDATE proposals SET status=?, decided_at=?, applied=? WHERE id=?",
            (status, time.time(), 1 if applied else 0, proposal_id),
        )
        self._conn.commit()

    def update_draft(self, proposal_id: str, draft: str) -> None:
        """改写一条待审提案的 draft。

        用户在接受前编辑草案时走这里。**先落库再写盘**是刻意的顺序：历史记录必须
        显示真正被写进引导文件的那行字，而不是模型原本起草的那行。否则审计轨迹会
        和磁盘上的内容不一致，而这条轨迹是用户回头查"这规则谁批的"的唯一凭据。
        """
        self._conn.execute(
            "UPDATE proposals SET draft=? WHERE id=? AND status='pending'",
            (draft, proposal_id),
        )
        self._conn.commit()

    # ── 效果回访 ─────────────────────────────────────────────────────────

    def proposals_for_effect_review(self, min_age_s: float, limit: int = 20) -> list[Proposal]:
        """已生效且到了回访年龄、还没写过 effect 的提案。"""
        cutoff = time.time() - min_age_s
        rows = self._conn.execute(
            "SELECT * FROM proposals WHERE applied=1 AND status='accepted' "
            "AND decided_at > 0 AND decided_at <= ? AND effect='' "
            "ORDER BY decided_at ASC LIMIT ?",
            (cutoff, int(limit)),
        ).fetchall()
        return [self._row_to_proposal(r) for r in rows]

    def signal_hits_between(self, signature: str, start: float, end: float) -> int:
        """某签名在 (start, end] 窗口内的信号条数。"""
        r = self._conn.execute(
            "SELECT COUNT(*) as c FROM signals "
            "WHERE signature=? AND created_at > ? AND created_at <= ?",
            (signature, float(start), float(end)),
        ).fetchone()
        return int(r["c"]) if r else 0

    def record_effect_review(self, proposal_id: str, verdict: str,
                             baseline: int, post: int) -> None:
        self._conn.execute(
            "UPDATE proposals SET effect=?, effect_reviewed_at=?, effect_baseline=? "
            "WHERE id=?",
            (verdict, time.time(), int(baseline), proposal_id),
        )
        self._conn.commit()


    def close(self) -> None:
        """释放连接。长驻进程里用不到，但测试和"撤掉这个功能"的路径需要——
        Windows 上不关连接就删不掉库文件。"""
        try:
            self._conn.close()
        except Exception:  # noqa: BLE001
            pass  # fail-open: 已无后续动作可做；连接对象交由 GC 兜底

    def _row_to_proposal(self, r: sqlite3.Row) -> Proposal:
        # supersedes 是后加的列：老库里的行没有它，直接下标会 IndexError。
        cols = r.keys()
        return Proposal(
            id=r["id"], signature=r["signature"], kind=r["kind"] or "",
            tool_name=r["tool_name"] or "", target_file=r["target_file"],
            draft=r["draft"], rationale=r["rationale"] or "",
            hits=int(r["hits"] or 0), status=r["status"],
            created_at=float(r["created_at"] or 0),
            decided_at=float(r["decided_at"] or 0),
            applied=int(r["applied"] or 0),
            supersedes=(r["supersedes"] or "") if "supersedes" in cols else "",
            effect=(r["effect"] or "") if "effect" in cols else "",
            effect_reviewed_at=float(r["effect_reviewed_at"] or 0) if "effect_reviewed_at" in cols else 0.0,
            effect_baseline=int(r["effect_baseline"] or 0) if "effect_baseline" in cols else 0,
        )


# ── 引擎 ────────────────────────────────────────────────────────────────────

class EvolutionEngine:
    """把 store 里的信号变成提案，并在用户接受后落盘。

    对外只暴露四个动词：
    * ``record`` —— 记一条信号（下游订阅 tool_result 时调用）；
    * ``mine`` —— 扫一次热签名，产出新提案；
    * ``list_open`` / ``list_all`` —— 读；
    * ``decide`` —— 接受或拒绝一条提案。

    这个引擎自己不会主动调 ``mine``。什么时候挖由外层决定（例如每回合结束时、
    或 dreaming loop 的空闲周期）。默认关闭档位下 mine 会直接返回空列表，
    从而保证"用户没开就一行不跑"。
    """

    def __init__(self, store: Optional[EvolutionStore] = None,
                 mode: str = DEFAULT_MODE,
                 workspace_root: Optional[str] = None,
                 storage: Any = None):
        if store is None and storage is not None and hasattr(storage, "_db_dir"):
            self.store = EvolutionStore(db_path=os.path.join(storage._db_dir, "evolution.db"))
        else:
            self.store = store or EvolutionStore()
        self._mode = mode if mode in VALID_MODES else DEFAULT_MODE
        self.workspace_root = workspace_root or os.getcwd()
        self._last_mine_at: float = 0.0

    # ── 档位 ─────────────────────────────────────────────────────────────

    @property
    def mode(self) -> str:
        return self._mode

    def set_mode(self, mode: str) -> str:
        if mode not in VALID_MODES:
            raise ValueError(f"unknown mode {mode!r}; expected one of {VALID_MODES}")
        self._mode = mode
        return self._mode

    def enabled(self) -> bool:
        return self._mode != MODE_OFF

    def policy_view(self) -> dict:
        """当前档位的实际阈值，给前端如实显示用。

        存在的理由很实际：这些数字（几次算复发、最多挂几条、拒绝后冷却多久）本来
        只活在 ``MODE_POLICIES`` 里，前端只能把它们硬编码进文案。一旦这里调参，
        界面上的说明就开始撒谎，而用户是照着那句说明做决定的。所以由后端吐出真值。

        off 档没有策略条目（查表会 KeyError），返回空 dict 而不是伪造一组阈值。
        """
        policy = MODE_POLICIES.get(self._mode)
        if policy is None:
            return {}
        return {
            "minHits": policy.min_hits,
            "maxOpen": policy.max_open,
            "rejectCooldownDays": round(policy.reject_cooldown_s / 86400, 1),
        }


    # ── 记录 ─────────────────────────────────────────────────────────────

    def record(self, kind: str, tool_name: str, detail: str,
               session_id: str = "", failure_kind: Optional[str] = None) -> Optional[str]:
        """记一条信号，返回签名；档位为 off 时静默丢弃。

        丢弃前不写盘——纪律 1 的落地：off 状态下这个模块**不产生任何 IO**。
        """
        if not self.enabled():
            return None
        if not kind:
            return None
        return self.store.record_signal(kind, tool_name or "", detail or "", session_id, failure_kind=failure_kind or "")

    def observe(self, obs: EvolutionObservation) -> EvolutionObservation:
        """给一个观察定决策并归档。观察层的全部出口就这一个。

        纪律与 record() 相同：off 档零 IO。NO_OP 也照记——"为什么不学"和
        "学了什么"同样是审计要回答的问题。这里**只记录、不写入**：任何对
        Memory/Skill 的实际改动仍必须走提案-审批管线，模型说"我学会了"
        到不了 active。
        """
        if not self.enabled():
            obs.decision = DECISION_NO_OP
            obs.reason = "evolution off：未评估"
            return obs
        obs.decision, obs.reason = classify_observation(obs)
        self.store.insert_observation(obs)
        return obs

    def record_user_correction(self, turn_id: str, correction_text: str, session_id: str = "") -> Optional[str]:
        """将用户的实时打断、纠正与负反馈记录为第一等进化证据。"""
        if not self.enabled():
            return None
        return self.record(
            kind="user_correction",
            tool_name="user_intervention",
            detail=f"Turn {turn_id} user correction: {correction_text}",
            session_id=session_id,
        )

    def gepa_optimize_prompt(
        self,
        seed_prompt: str,
        seed_name: str,
        eval_cases: Sequence[dict] = (),
        failure_traces: Sequence[dict] = (),
        max_generations: int = 3,
    ) -> dict:
        """运行 GEPA 遗传帕累托进化算法优化 Prompt / SOP 规则。"""
        from gepa_evolution import GEPAEvolutionOptimizer
        optimizer = GEPAEvolutionOptimizer()
        return optimizer.run_evolution_cycle(
            seed_prompt=seed_prompt,
            seed_name=seed_name,
            eval_cases=eval_cases,
            failure_traces=failure_traces,
            max_generations=max_generations,
        )

    def emit_learning_bundle(self, obs: EvolutionObservation,
                             materialized: dict, *,
                             turn_ids=None, bundle_key: str = "",
                             outcome: str = "",
                             terminal_event_id: str = "") -> str:

        """每个终态目标固定产出一条 LearningBundle（含 NO_OP）。

        四路决策是 bundle 的**路由**，不是终点：MEMORY_ONLY 只有事实提案、
        SKILL_ONLY 只有候选、BOTH 的两类产物共享同一组 experience/turn 证据、
        NO_OP 也要留下"为什么没有学习"。这样 Memory 和 Skill 才能被证明是
        同一条经验的两个投影，而不是两个相邻功能。

        ``materialized`` 是 :func:`materialize_observation` 的返回
        （``memoryProposals`` / ``skillCandidate``）；NO_OP 传空 dict。

        ``bundle_key`` 是幂等键（见 :meth:`EvolutionStore.insert_bundle`）：给了
        就是"同一次终态只有一条"，重复调用返回原件的 id；不给就退回每次一条。
        ``outcome`` 记的是这次运行本身怎么结束的（success/failure/cancelled/
        unknown），和"学到了什么"分开——失败也要有学习记录，但不能被读成成功。
        """
        made = materialized or {}
        items_list = list(made.get("learningItems") or [])
        cand_list = [str(made.get("skillCandidate") or "")] if made.get("skillCandidate") else []
        pre_bid = str(made.get("bundle_id") or "")
        learning_id = self.store.insert_bundle(
            bundle_id=pre_bid,
            goal_id=obs.goal_id or "",
            run_id=obs.run_id or "",
            session_id=obs.session_id or "",
            decision=obs.decision or "UNCLASSIFIED",
            rationale=obs.reason or "",
            turn_ids=list(turn_ids or []),
            experience_ids=[e for e in (obs.skill_experiences or []) if e],
            memory_proposal_ids=[p for p in (made.get("memoryProposals") or []) if p],
            skill_candidate_id=str(made.get("skillCandidate") or ""),
            skill_candidate_ids=cand_list,
            learning_item_ids=items_list,
            validator_result=obs.validator_result or {},
            bundle_key=bundle_key,
            outcome=outcome,
            terminal_event_id=terminal_event_id,
        )
        try:
            from storage import get_storage
            st = get_storage()
            for li_id in items_list:
                st._db("memory").execute(
                    "UPDATE learning_items SET bundle_id=? WHERE learning_item_id=?",
                    (learning_id, li_id)
                )
            st._db("memory").commit()
        except Exception:
            pass
        return learning_id

    def observe_episode_completion(self, episode: dict) -> Optional[str]:
        """会话主题片段封存时触发的学习观察（§13.4/13.5）。

        硬隔离保证：只读取当前 session_id 内在 episode.turn_ids 范围内的事件和事实。
        """
        if not self.enabled():
            return None
        sid = str(episode.get("session_id") or "")
        eid = str(episode.get("episode_id") or "")
        if not sid:
            return None

        try:
            from storage import get_storage
            st = get_storage()
            facts = []
            matched_event_ids: list[str] = []
            try:
                from event_types import EventType
                es = st.get_event_store()
                turn_ids_set = set(str(t) for t in (episode.get("turn_ids") or []) if str(t).strip())
                bid = str(episode.get("branch_id") or "").strip()
                for ev in es.read_stream(sid):
                    # Hard session check: event must match session_id
                    if str(getattr(ev, "session_id", "") or "") != sid:
                        continue
                    # P1-6: Strict branch match for all events
                    ev_bid = str(getattr(ev, "branch_id", "") or (ev.payload.get("branch_id") if ev.payload else "") or "").strip()
                    if ev_bid != bid:
                        continue
                    if turn_ids_set:
                        # P0-5: Strict turn_id match when episode has turns
                        ev_turn = str(getattr(ev, "turn_id", "") or (ev.payload.get("turn_id") if ev.payload else "") or "")
                        if not ev_turn or ev_turn not in turn_ids_set:
                            continue
                    ev_id_str = str(getattr(ev, "id", "") or getattr(ev, "event_id", "") or "")
                    if ev_id_str:
                        matched_event_ids.append(ev_id_str)
                    if ev.event_type == EventType.MEMORY_EXTRACTED.value:
                        p = ev.payload or {}
                        batch = p.get("facts") or []
                        if batch:
                            facts.extend(str(f)[:200] for f in batch if str(f).strip())
                        else:
                            fact = str(p.get("text") or p.get("fact") or p.get("content") or "").strip()
                            if fact:
                                facts.append(fact[:200])
            except Exception as _e:
                print(f"[evolution] episode read events failed: {_e}")

            obs = EvolutionObservation(
                goal_id="",
                run_id="",
                session_id=sid,
                branch_id=bid,
                episode_id=eid,
                turn_ids=list(episode.get("turn_ids") or []),
                source_event_ids=matched_event_ids,
                used_skills=[],
                skill_experiences=[],
                validator_result={"status": "sealed", "machineVerified": False},
                user_feedback=None,
                new_facts=facts,
                reusable_steps=[],
                validated_skills=[],
                failed_experiences=[],
                failure_class=None,
                created_at=time.time(),
            )

            self.observe(obs)
            made = {}
            if obs.decision != DECISION_NO_OP:
                made = materialize_observation(obs, st, self)
                if made.get("memoryProposals"):
                    _publish_proposal_count(self)
                _publish_insight(
                    "learned",
                    obs.reason,
                    decision=obs.decision,
                    sessionId=sid,
                    episodeId=eid,
                    memoryProposals=(made.get("memoryProposals") or []),
                    skillCandidate=(made.get("skillCandidate") or ""),
                    learningItems=(made.get("learningItems") or []),
                    learningItemDetails=(made.get("learningItemDetails") or []),
                    materialized=bool(made.get("memoryProposals") or made.get("skillCandidate") or made.get("learningItems")),
                    materializeReason=(made.get("reason") or ""),
                )

            bid = str(episode.get("branch_id") or "")
            gen = episode.get("generation", 1)
            bundle_key = f"episode:{sid}:{bid}:{eid}:sealed:{gen}"
            bundle_id = self.emit_learning_bundle(
                obs, made,
                turn_ids=episode.get("turn_ids", []),
                bundle_key=bundle_key,
                outcome="sealed",
            )
            return bundle_id
        except Exception as exc:
            print(f"[evolution] observe_episode_completion failed: {exc}")
            return None



    # ── 挖掘 ─────────────────────────────────────────────────────────────

    def maybe_mine(self) -> list[Proposal]:
        """节流版 ``mine``。给信号订阅者用。

        节流的目的是让重试风暴不重复跑挖掘；但**只在真正跑完一次挖掘之后**才更新
        时间戳——否则第一次失败（此时命中还不够 min_hits，mine 会空返回）就锁住
        整个窗口，后续复发到达阈值时反而挖不出来了。这个错我第一版真犯过。
        """
        if not self.enabled():
            return []
        now = time.time()
        if (now - self._last_mine_at) < MINE_THROTTLE_S:
            return []
        made = self.mine()
        # 只有真的挖出东西才让下次冷却生效。空返回不算"跑过"。
        if made:
            self._last_mine_at = now
        return made

    def mine(self) -> list[Proposal]:
        """扫一次，返回**这次调用新产生的**提案列表。

        资格判据是保守的合取：
        - min_hits：偶发不立规则；
        - 已有未决提案就跳过：同一签名同时只能有一条待审；
        - 冷却期内跳过：被拒过的签名一段时间不再骚扰；
        - max_open 触顶就停：让用户先清完。
        """
        if not self.enabled():
            return []
        policy = MODE_POLICIES[self._mode]
        if self.store.count_open() >= policy.max_open:
            return []

        now = time.time()
        made: list[Proposal] = []
        hot = self.store.hot_signatures(min_hits=policy.min_hits, limit=20)
        for row in hot:
            sig = row["signature"]
            if self.store.has_open_for_signature(sig):
                continue
            last_rej = self.store.last_rejected_at(sig)
            if last_rej and (now - last_rej) < policy.reject_cooldown_s:
                continue
            proposal = self._draft(row)
            if proposal is None:
                continue
            self.store.insert_proposal(proposal)
            made.append(proposal)
            if self.store.count_open() >= policy.max_open:
                break
        return made

    def _draft(self, row: dict) -> Optional[Proposal]:
        """把一个热签名做成一条草稿。目标文件依 kind 决定并对照白名单。"""
        kind = (row.get("kind") or "").strip()
        target = KIND_TARGET.get(kind)
        if target not in ALLOWED_TARGETS:
            return None  # 未映射的 kind 不产出——白名单是硬约束
        tool_name = row.get("tool") or row.get("tool_name") or ""
        hits = int(row.get("hits") or 0)
        detail = (row.get("detail") or "").strip()
        rule = self._compose_rule(kind, tool_name, detail)
        clean_sum = normalize_error(detail)[:160]
        clean_sum = re.sub(r"<n>", "", clean_sum).strip()
        rationale = (
            f"触发依据：近 14 天内遇到 {hits} 次同类场景 · "
            f"来源工具: {tool_name or '系统操作'} · 摘要: {clean_sum}"
        )
        return Proposal(
            id=uuid.uuid4().hex[:12],
            signature=row["signature"],
            kind=kind,
            tool_name=tool_name,
            target_file=target,
            draft=rule,
            rationale=rationale,
            hits=hits,
            status="pending",
            created_at=time.time(),
        )

    @staticmethod
    def _compose_rule(kind: str, tool_name: str, detail: str) -> str:
        """把签名和形状转成一条可读的引导条目。

        不塞入原文——原文可能包含具体路径、错误堆栈、甚至泄露的凭证。我们只
        写「什么形状的事发生过」和「下次注意什么」，让用户自己决定要不要落。
        """
        summary = normalize_error(detail)[:160] or "(no detail)"
        summary = re.sub(r"<n>", "", summary).strip()

        if kind == "tool_failure":
            if "confirmation" in detail.lower() or "high risk" in detail.lower():
                return f"- 执行 `{tool_name}` 等高风险或敏感命令前，先向用户简要说明意图并等待确认。"
            if "forbidden" in detail.lower() or "403" in detail:
                return f"- 抓取网页遭遇权限拒绝 (403) 时，优先提示用户登录或改用浏览器模式协助抓取。"
            if "not found" in detail.lower() or "404" in detail:
                return f"- 遇到目标页面不存在 (404) 时，自动通过搜索引擎寻找备用有效链接，不再反复尝试死链。"
            return (f"- 遇到 `{tool_name}` 执行异常时（{summary}），"
                    "先检查参数有效性与前置条件，或改用等价工具。")
        if kind == "tool_denied":
            return (f"- 反复被策略拦截：`{tool_name}` — {summary}。 "
                    "不要重复尝试同一形式；换目标或先请示用户。")
        if kind == "interrupted":
            return (f"- 用户在 `{tool_name}` 期间频繁中断（{summary}）。 "
                    "开始该类操作前先摘要计划、等待确认。")
        if kind == "user_correction":
            return f"- 用户偏好：{summary}"
        return f"- {summary}"


    # ── 读接口 ───────────────────────────────────────────────────────────

    def list_open(self) -> list[dict]:
        return [p.to_dict() for p in self.store.open_proposals()]

    def list_all(self, limit: int = 50) -> list[dict]:
        return [p.to_dict() for p in self.store.all_proposals(limit=limit)]

    def counts(self) -> dict[str, int]:
        """终身状态计数。与 ``list_all`` 的 limit 无关，供 UI 显示总数。"""
        return self.store.count_by_status()


    # ── 决策 ─────────────────────────────────────────────────────────────

    def decide(self, proposal_id: str, accept: bool,
               draft_override: Optional[str] = None) -> dict:
        """接受或拒绝一条提案。

        Args:
            draft_override: 用户在接受前编辑过的草案。非空且与原文不同时，先落库
                再写盘——用户批的是他们眼睛看到的那行字，不是模型起草的原句。拒绝
                路径忽略它（拒绝就是不写，没有"写什么"可言）。

        Returns:
            ``{"ok": bool, "status": "accepted"|"rejected"|"missing",
               "applied": bool, "error": str}``。
            ``applied`` 严格反映**盘上是不是真的写进去了**——写盘失败时是 False，
            不吞不掩盖（纪律 3）。
        """
        p = self.store.get_proposal(proposal_id)
        if p is None:
            return {"ok": False, "status": "missing", "applied": False,
                    "error": "proposal not found"}
        if p.status != "pending":
            return {"ok": False, "status": p.status, "applied": bool(p.applied),
                    "error": "already decided"}

        if not accept:
            self.store.mark_decided(proposal_id, "rejected", applied=False)
            # 裁决回写所属 LearningBundle：bundle 的 user_verdict 记录的是
            # "人最终怎么看这条学习"，不是提案自身的状态字段。
            try:
                self.store.mark_bundle_verdict_for_proposal(
                    proposal_id, "rejected")
            except Exception as exc:  # noqa: BLE001
                print(f"[evolution] bundle verdict write failed: {exc}")
            return {"ok": True, "status": "rejected", "applied": False, "error": ""}

        # 接受前若带了编辑，先把它落库，让审计轨迹与磁盘一致。
        edited = (draft_override or "").strip()
        if edited and edited != p.draft.strip():
            self.store.update_draft(proposal_id, edited)
            p.draft = edited

        # 接受路径 —— 写盘
        try:
            applied = self._apply_to_guidance(p)
            err = "" if applied else "write skipped"
        except Exception as exc:  # noqa: BLE001
            applied = False
            err = f"apply failed: {exc}"

        self.store.mark_decided(proposal_id, "accepted", applied=applied)
        try:
            self.store.mark_bundle_verdict_for_proposal(proposal_id, "approved")
        except Exception as exc:  # noqa: BLE001
            print(f"[evolution] bundle verdict write failed: {exc}")

        # Phase 60 联动: 自动抽取三元组并沉淀入 GraphMemoryEngine
        if applied:
            try:
                self._extract_and_ingest_graph_triplets(p)
            except Exception as exc:  # noqa: BLE001
                print(f"[evolution] graph triplet ingestion failed: {exc}")

        # 裁决掉的旧结论也要从记忆库里退役。只改文件是不够的：召回走的是
        # memory_entries，那条"用 npm"还躺在库里，下一轮照样被注入——文件说 pnpm、
        # 记忆说 npm，而模型两边都读。
        retired = (_retire_superseded_memory(p, self.workspace_root)
                   if (applied and p.supersedes) else 0)
        # targetFile 一起回：写盘失败时 UI 要能指名道姓说"哪个文件没被改动"，
        # 而提案此刻已从待审列表消失，前端再也查不到它写向哪里。
        # 效果回访顺手跑：接受/拒绝是低频动作，此刻清扫"到期未回访"的
        # 已生效提案只是几条 SQL 计数，保证回访不无限积压。回访失败
        # 不影响本次裁决本身。
        try:
            self.review_applied_effects()
        except Exception:
            pass

        return {"ok": applied, "status": "accepted", "applied": applied,
                "error": err, "targetFile": p.target_file,
                "retiredMemories": retired}

    def _extract_and_ingest_graph_triplets(self, p: Proposal) -> int:
        """从被批准的自进化提案中提取结构化实体三元组并写入图谱记忆 (Phase 60 联动)。"""
        try:
            from memory_layer import get_graph_memory_engine
            graph_engine = get_graph_memory_engine()
        except Exception:
            return 0

        draft = (p.draft or "").strip()
        kind = (p.kind or "").lower()
        tool = (p.tool_name or "").strip()
        root = self.workspace_root or ""
        ingested = 0

        # 1. 截图/文件生成路径约定
        if "screenshot" in draft.lower() or "截图" in draft or "saved to" in draft.lower():
            m = re.search(r'(?:saved to|保存至)\s*([^\s,，。]+)', draft, re.I)
            dest = m.group(1).strip() if m else "output/"
            graph_engine.ingest_triplet(
                root_dir=root,
                subject="ScreenCapture",
                predicate="SAVED_TO",
                object_val=dest,
                subject_type="Operation",
                object_type="Path",
                confidence=0.98
            )
            ingested += 1

        # 2. 权限受限 403 处理
        if "403" in draft or "forbidden" in draft.lower() or "权限拒绝" in draft:
            graph_engine.ingest_triplet(
                root_dir=root,
                subject="WebFetch_403",
                predicate="FALLBACK_TO",
                object_val="BrowserMode",
                subject_type="ErrorEvent",
                object_type="ActionProtocol",
                confidence=0.95
            )
            ingested += 1

        # 3. 404 资源未找到处理
        if "404" in draft or "not found" in draft.lower() or "死链" in draft:
            graph_engine.ingest_triplet(
                root_dir=root,
                subject="WebFetch_404",
                predicate="FALLBACK_TO",
                object_val="SearchEngine",
                subject_type="ErrorEvent",
                object_type="ActionProtocol",
                confidence=0.95
            )
            ingested += 1

        # 4. 通用工具与约束关系
        if tool:
            subj_name = f"Tool_{tool}"
            graph_engine.ingest_triplet(
                root_dir=root,
                subject=subj_name,
                predicate="CONSTRAINED_BY",
                object_val=p.user_title or p.signature or "GeneralRule",
                subject_type="Tool",
                object_type="Rule",
                confidence=0.90
            )
            ingested += 1

        return ingested

    def review_applied_effects(self) -> list[dict]:
        """已生效提案的效果回访：同签名失败在生效后的复发 vs 生效前基线。

        三态判定：
          effective   生效后同签名零复发——规则在起作用
          improving   有复发但显著低于生效前基线——在起作用，还需要观察
          ineffective 复发未降（或生效前无基线可比且仍在复发）——规则没解决
                      它目标解决的问题，评审队列里应该被人看到这一点

        回访是纯 SQL 计数，成本可忽略；判定写回 proposals.effect，评审队列
        与审计页据此展示"这条规则到底管不管用"。
        """
        now = time.time()
        min_age_s = 7 * 86400       # 生效满 7 天才回访——太早看不出趋势
        baseline_window_s = 14 * 86400
        out: list[dict] = []
        for p in self.store.proposals_for_effect_review(min_age_s):
            decided = p.decided_at or now
            baseline = self.store.signal_hits_between(
                p.signature, decided - baseline_window_s, decided)
            post = self.store.signal_hits_between(p.signature, decided, now)
            if post <= 0:
                verdict = "effective"
            elif baseline > 0 and post < baseline:
                verdict = "improving"
            else:
                verdict = "ineffective"
            self.store.record_effect_review(p.id, verdict, baseline, post)
            out.append({"id": p.id, "signature": p.signature,
                        "verdict": verdict, "baseline": baseline, "post": post})
        return out

    # ── 写盘 ─────────────────────────────────────────────────────────────

    def _apply_to_guidance(self, p: Proposal) -> bool:
        """把已接受的 draft 写进目标文件的 Learned Rules 小节。

        绕过 PathGuard 是刻意的——PathGuard 关的是模型的门，不是系统的门。
        这条路径上有一个人点了"接受"，所以走系统写。使用 union+dedup 保证
        同一条规则不会被反复追加；``p.supersedes`` 非空时是**替换**那一行，
        因为一条改写过的事实和它的旧版本不能同时留在每轮注入的上下文里。
        """
        if p.target_file not in ALLOWED_TARGETS:
            return False
        target_path = os.path.join(self.workspace_root, p.target_file)
        existing = ""
        try:
            if os.path.isfile(target_path):
                with open(target_path, "r", encoding="utf-8") as f:
                    existing = f.read()
        except OSError:
            existing = ""

        head, section_lines, tail = _split_evolution_section(existing)
        rule = p.draft.strip()
        # 冲突提案：把旧行**原地换掉**，不是追加。位置保留是有意的——用户在
        # MEMORY.md 里按顺序读这些规则，把改写过的一条挪到末尾会打乱他的心智模型。
        old = (p.supersedes or "").strip()
        replaced = False
        if old:
            for i, line in enumerate(section_lines):
                if line.strip() == old:
                    section_lines[i] = rule
                    replaced = True
                    break
        if not replaced and rule and rule not in section_lines:
            section_lines.append(rule)

        rebuilt_section = (
            f"{EVOLUTION_HEADING}\n"
            f"<!-- auto-maintained by evolution engine; "
            f"only expanded after explicit user approval -->\n"
            + "\n".join(section_lines)
        )
        parts = [head.rstrip(), rebuilt_section, tail.lstrip()]
        rebuilt = "\n\n".join(p for p in parts if p) + "\n"

        try:
            from file_agent import atomic_write
            r = atomic_write(target_path, rebuilt)
            if not r.ok:
                return False
        except Exception:
            return False
        return True


def _split_evolution_section(text: str) -> tuple[str, list[str], str]:
    """把文件切成 (before, existing rule lines, after)。

    找不到小节时返回 (text, [], '')——调用方会追加新小节到末尾。
    """
    if not text or EVOLUTION_HEADING not in text:
        return text or "", [], ""
    idx = text.index(EVOLUTION_HEADING)
    before = text[:idx]
    rest = text[idx + len(EVOLUTION_HEADING):]
    # 下一个二级标题是小节的边界
    next_heading = re.search(r"\n##\s", rest)
    if next_heading:
        section_body = rest[:next_heading.start()]
        after = rest[next_heading.start():]
    else:
        section_body = rest
        after = ""
    lines = [
        ln.strip() for ln in section_body.splitlines()
        if ln.strip() and not ln.strip().startswith("<!--")
    ]
    return before, lines, after


# ── 进程内单例 ─────────────────────────────────────────────────────────────

_engine: Optional[EvolutionEngine] = None


def get_evolution_engine(workspace_root: Optional[str] = None) -> EvolutionEngine:
    """进程共享引擎。第一次读会用当前 workspace 建库。"""
    global _engine
    if _engine is None:
        _engine = EvolutionEngine(workspace_root=workspace_root)
    elif workspace_root and workspace_root != _engine.workspace_root:
        _engine.workspace_root = workspace_root
    return _engine


def reset_for_tests(db_path: Optional[str] = None,
                    mode: str = DEFAULT_MODE,
                    workspace_root: Optional[str] = None) -> EvolutionEngine:
    """自测用：给一个干净的临时 DB 和 workspace。"""
    global _engine, _attached_buses, _bus_ref
    _engine = EvolutionEngine(
        store=EvolutionStore(db_path=db_path),
        mode=mode,
        workspace_root=workspace_root,
    )
    _attached_buses = set()
    _bus_ref = None
    return _engine


def configure_from_config(cfg: dict, workspace_root: Optional[str] = None) -> str:
    """从 config.json 的 ``evolution.mode`` 读档位。返回生效的档位。

    读不到就是 off——缺省关，见纪律 1。非法值也是 off 而不是抛：一个坏掉的配置
    字段不该拦住整个服务启动，静默降到最安全的一档才对。
    """
    engine = get_evolution_engine(workspace_root)
    mode = str(((cfg or {}).get("evolution") or {}).get("mode") or DEFAULT_MODE)
    if mode not in VALID_MODES:
        mode = DEFAULT_MODE
    engine.set_mode(mode)
    return mode


# ── 信号采集：挂到 event bus ────────────────────────────────────────────────

#: tool_result 的 status → 信号 kind。只收 failed / denied：
#: ``completed`` 没有教训可学，``needs_confirmation`` 还没有结果。
_STATUS_TO_KIND: dict[str, str] = {
    "failed": "tool_failure",
    "denied": "tool_denied",
}

#: 已挂过的 bus（按 id）。同一个 bus 重复挂会让一次失败被记成两条，
#: 直接把复发计数翻倍、提前触发阈值。
_attached_buses: set = set()

#: 记住每个 bus 的引用，好在挖出新提案时主动广播。挂载时填，
#: ``_on_tool_result`` 用它 emit ``evolution_proposal``。
_bus_ref = None


async def _on_tool_result(event) -> None:
    """把一次失败/被拒的工具调用记成信号，并在挖出新提案时广播。

    这个订阅者必须是完全无害的：档位 off 时立即返回（不写盘），任何异常都吞掉。
    演化是可选的附加功能，它绝不该有能力弄坏一个正常的回合。

    广播 ``evolution_proposal`` 是为了让 UI 不必轮询——提案是在对话过程中被动挖
    出来的，没有推送的话用户永远不知道有东西要审，这个审核队列就等于不存在。
    """
    try:
        engine = get_evolution_engine()
        if not engine.enabled():
            return
        payload = event.payload or {}
        kind = _STATUS_TO_KIND.get(str(payload.get("status") or ""))
        if not kind:
            return
        result = payload.get("result") or {}
        detail = result.get("error") or result.get("value") or ""
        if not detail:
            return
        engine.record(
            kind,
            str(payload.get("tool_name") or ""),
            str(detail),
            str(payload.get("session_id") or ""),
        )
        made = engine.maybe_mine()
        if made and _bus_ref is not None:
            # 只发"有新的了 + 现在待审几条"，卡片内容让前端拉一次 /proposals。
            # 提案里含归一化后的 draft（可能仍有 <PATH> 之类），走已建立的 WS
            # 通道即可，但没必要把整包塞进事件负载。
            try:
                await _bus_ref.emit("evolution_proposal", {
                    "created": len(made),
                    "openCount": engine.store.count_open(),
                })
            except Exception as _e:  # noqa: BLE001
                # 观察镜像：WS 推送失败不拖垮挖掘本身，但必须留痕——
                # 静默丢掉会让"有待审提案"这件事凭空消失。
                print(f"[evolution] proposal bus emit failed: {_e}")
    except Exception as _e:  # noqa: BLE001
        # 这是后台挖掘循环的总闸：无声吞掉等于信号采集永久死亡且无人知。
        print(f"[evolution] tool_result observation loop failed: {_e}")


def _publish_insight(kind: str, detail: str, **extra) -> None:
    """把一次进化时刻推上总线（WS 桥转发为聊天界面里的轻量感知芯片）。

    学习是后台账目：只在实际学到了东西时才打扰用户——NO_OP 不发。
    没有运行中的事件循环（纯同步测试）就跳过，面板轮询仍可见。
    """
    bus = globals().get("_bus_ref")
    if bus is None:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    payload = {"kind": kind, "detail": detail, "ts": time.time(), **extra}
    asyncio.create_task(bus.emit("evolution_insight", payload))


def _publish_proposal_count(engine) -> None:
    """广播"现在待审几条"。

    观察层产出的提案必须和挖掘产出的提案走同一帧，否则侧栏那个计数只在
    "工具反复失败"时才动——用户刚跑完的任务产生了三条待确认记忆，界面上
    却一点动静都没有，等于这些提案不存在。
    """
    bus = globals().get("_bus_ref")
    if bus is None:
        return
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return  # 纯同步环境（测试）：面板轮询仍会看到
    try:
        count = engine.store.count_open()
    except Exception as exc:  # noqa: BLE001
        print(f"[evolution] open count failed: {exc}")
        return
    asyncio.create_task(bus.emit("evolution_proposal", {
        "openCount": count, "ts": time.time(),
    }))



#: Goal 终态 → 这次运行"怎么结束的"。键就是 bus 上的 status，值进 bundle 的
#: outcome 列。只有这四个是终态：stopping / paused / running 还会再变，
#: 它们不该产生学习记录，否则一次暂停就会被读成一次结论。
_TERMINAL_OUTCOME = {
    "completed": "success",
    "ovolve_failed_final": "failure",
    "cancelled": "cancelled",
    "stop_timeout": "unknown",
}

#: 有终态、但不该据此学习的那两个。取消是用户改了主意，停止超时是我们根本
#: 不知道现场停在哪一步——两者都没有"这么做是对的"这种证据，落 bundle 是为了
#: 审计（这次运行结束了、没学到东西、原因在此），不是为了产出提案。
_EVIDENCE_ONLY_OUTCOMES = {"cancelled", "unknown"}


def _bundle_key_for(goal_id: str, status: str, storage) -> str:
    """同一次运行、同一个终态的稳定标识。

    用 ``claim_epoch``（goals 表，0011 迁移）做运行代次：它每被认领一次 +1，
    是库里唯一持久、跨进程仍然成立的"第几次跑"。内存里的 run_id 不行——重启
    续跑会铸一个新的，正好在最需要幂等的那个场景下失效。
    """
    epoch = 0
    try:
        row = storage.get_goal(goal_id) or {}
        epoch = int(row.get("claim_epoch") or 0)
    except Exception:  # noqa: BLE001 — 拿不到就退化成"每个终态一条"
        epoch = 0
    return f"goal:{goal_id}|epoch:{epoch}|terminal:{status}"


def _append_terminal_event(goal_id: str, status: str, outcome: str,
                           payload: dict, bundle_key: str, storage) -> str:
    """把"这个目标结束了"写进 append-only 事件链，返回事件的 chain_hash。

    在此之前，"目标结束"只存在于 goals.status 这一个**可变**列里：跑完的一次
    运行没有留下任何不可篡改的痕迹，历史 Trace 无从查询，幂等也没有可锚定的
    事实。事件类型分四种（completed / failed / cancelled / stop_timeout），
    payload 里带上 outcome 和这次运行的 key。

    幂等键与 bundle 用同一个：同一次终态重复触发只会有一条事件，
    ``append`` 会把已存在的那条原样返回。

    失败返回 ""——记账不能拦住状态流转，但 bundle 里的 terminal_event_id 会
    因此为空，那是"没记上"的诚实表示，不是"没发生"。
    """
    try:
        from event_store import get_event_store
        from event_types import EventType
    except Exception as exc:  # noqa: BLE001
        print(f"[evolution] event store unavailable: {exc}")
        return ""
    etype = {
        "completed": EventType.GOAL_COMPLETED,
        "ovolve_failed_final": EventType.GOAL_FAILED,
        "cancelled": EventType.GOAL_CANCELLED,
        "stop_timeout": EventType.GOAL_STOP_TIMEOUT,
    }.get(status)
    if etype is None:
        return ""
    row = {}
    try:
        row = storage.get_goal(goal_id) or {}
    except Exception:  # noqa: BLE001
        row = {}
    # 事件链按 session 分链；目标没有 session 时用一条以目标命名的链，也比把
    # 它塞进别人的链里、或者因为 NOT NULL 写不进去要好。
    session_id = str(payload.get("session_id") or row.get("session_id")
                     or f"goal-{goal_id}")
    body = {
        "goal_id": goal_id, "status": status, "outcome": outcome,
        "run_key": bundle_key,
        "claim_epoch": int(row.get("claim_epoch") or 0),
        "iteration": payload.get("iteration", row.get("iteration", 0)),
        "source": str(payload.get("source") or "scheduler"),
    }
    for k in ("reason", "error", "verified"):
        if payload.get(k) is not None:
            body[k] = payload[k]
    try:
        ev = get_event_store().append(
            session_id, etype, body,
            idempotency_key=f"goal_terminal:{bundle_key}",
            goal_id=goal_id, run_id=str(payload.get("run_id") or "") or None,
            actor="system", visibility="user",
        )
        return str(getattr(ev, "chain_hash", "") or "")
    except Exception as exc:  # noqa: BLE001
        print(f"[evolution] terminal event append failed: {exc}")
        return ""


def _on_goal_state_change(payload) -> None:

    """Goal 终态 → 自动观察一条（Step C 的运行时挂点）。

    四个终态都要留记录：成功、最终失败、取消、停止超时。失败同样是证据，取消和
    停止超时至少要留下"这次没学到东西，因为……"。后台账目，任何失败都只打
    日志——绝不能让记账问题惊动正在跑目标的 worker。
    """
    try:
        p = payload or {}
        status = str(p.get("status") or "")
        outcome = _TERMINAL_OUTCOME.get(status)
        if outcome is None:
            return
        goal_id = str(p.get("goal_id") or "")
        if not goal_id:
            return
        from storage import get_storage
        # 终态事件先写。它是审计事实，不是演化功能：evolution 关掉的时候
        # "这个目标结束了"照样要留在事件链里。
        bundle_key = _bundle_key_for(goal_id, status, get_storage())
        terminal_event_id = _append_terminal_event(
            goal_id, status, outcome, p, bundle_key, get_storage())
        engine = get_evolution_engine()
        if not engine.enabled():
            return
        obs = build_goal_observation(goal_id, get_storage(),
                                     run_id=str(p.get("run_id") or ""))

        if obs is not None:
            made = {}
            if outcome in _EVIDENCE_ONLY_OUTCOMES:
                # 不 observe、不 materialize：这条运行不该进挖掘池，也不该
                # 生出提案。只把"为什么没学"写进 bundle。
                obs.decision = DECISION_NO_OP
                obs.reason = ("目标被取消，没有可复用的证据"
                              if outcome == "cancelled" else
                              "停止超时：现场停在哪一步无法确定，不据此学习")
            else:
                engine.observe(obs)
                try:
                    record_goal_validation_edges(obs, get_storage())
                except Exception as exc:  # noqa: BLE001
                    print(f"[evolution] validation edges failed: {exc}")
                if obs.decision != DECISION_NO_OP:
                    # 先产物，再广播。顺序有意义：insight 里带上真实的产物数量，
                    # 前端那句"学到了新东西"才不是空话——没产出就如实说没产出。
                    try:
                        made = materialize_observation(obs, get_storage(), engine)
                    except Exception as exc:  # noqa: BLE001
                        print(f"[evolution] materialize failed: {exc}")
                    if made.get("memoryProposals"):
                        _publish_proposal_count(engine)

                    _publish_insight(
                        "learned",
                        obs.reason,
                        decision=obs.decision,
                        sessionId=obs.session_id or "",
                        goalId=obs.goal_id,
                        skills=obs.used_skills,
                        memoryProposals=(made.get("memoryProposals") or []),
                        skillCandidate=(made.get("skillCandidate") or ""),
                        learningItems=(made.get("learningItems") or []),
                        learningItemDetails=(made.get("learningItemDetails") or []),
                        materialized=bool(made.get("memoryProposals")
                                          or made.get("skillCandidate")
                                          or made.get("learningItems")),
                        materializeReason=(made.get("reason") or ""),
                    )
            # LearningBundle：无论四路判成什么都要落一条。BOTH 的记忆提案与
            # 技能候选在这里共享同一组 experience/turn 证据；NO_OP 的"为什么
            # 没学"也是审计要回答的问题。失败只打日志——记账不能惊动 worker。
            #
            # 幂等键让重复调用变成无害：completed 这条路径本身就会把订阅者
            # 调用两次（_emit_change 一次、直接 emit 一次），事件重播和双窗口
            # 也会。第二次拿到的是同一条 bundle 的 id，不是第二条 bundle。
            try:
                turn_ids = [it.get("id") for it in
                            get_storage().list_goal_iterations(goal_id, limit=50)
                            if isinstance(it, dict) and it.get("id")]
                engine.emit_learning_bundle(
                    obs, made, turn_ids=turn_ids,
                    bundle_key=bundle_key, outcome=outcome,
                    terminal_event_id=terminal_event_id)

                # bundle 归档是后台账目，不弹 insight 打扰用户；面板轮询可见。
            except Exception as exc:  # noqa: BLE001
                print(f"[evolution] learning bundle failed: {exc}")

    except Exception as exc:  # noqa: BLE001
        print(f"[evolution] goal observation failed: {exc}")



def attach_to_bus(bus) -> bool:
    """订阅 ``tool_result`` 与 ``goal_state_change``。返回是否真的新挂上了。

    priority 用 -200，排在 WS 广播（-100）之后：UI 的实时性优先，演化记录是
    后台账目，晚一点毫无影响。
    """
    global _attached_buses, _bus_ref
    if bus is None:
        return False
    _bus_ref = bus
    key = id(bus)
    if key in _attached_buses:
        return False
    bus.on("tool_result", _on_tool_result, priority=-200)
    bus.on("goal_state_change", _on_goal_state_change, priority=-200)
    _attached_buses.add(key)
    return True
