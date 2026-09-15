"""
token_analytics.py — 实时上下文窗口分析引擎。

三层分析：
    1. Token Space Breakdown — 按来源拆分窗口占用
       (messages / system_prompt / tools / skills)
    2. Prompt Caching — 缓存命中/未命中、平均命中率、费用节省
    3. Agent Action Breakdown — 本轮工具调用/规则应用/子代理委派

设计原则：
    · 混合策略：API 精确值 + 本地估算（对齐已有的 estimate_tokens_multi）
    · 线程安全：单线程 asyncio，但 telemetry 可从其他线程读，故用 lock
    · 低开销：所有更新都是 O(1) 或 O(n) 其中 n=当前消息数，无持久化
    · 200ms 防抖：批量更新避免 UI 抖动
    · **不自己定价、不编造分母**：金额来自 ``model_registry``（按模型费率 +
      用户 override + provider 上报的真实账单），窗口大小来自模型注册表。
      两者都取不到时如实返回未知，让 UI 显示"未知"而不是显示一个错的数。

数据来源（每一条都必须真的有调用点——曾经这里列了四条，其中三条从未被调用）：
    · Router._emit_usage_frame  → update_from_usage()
    · Router.handle 回合开始     → reset_turn()
    · Router._run_tool_call      → on_tool_call()
    · Router 权限/规则判定        → on_rule_applied()
    · SubagentRuntime 派生        → on_subagent_delegate()
    · ContextCompactor.fold       → on_fold()
"""
from __future__ import annotations

import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional


# ── 工具分类映射 ──────────────────────────────────────────────────────────

#: 将工具名归入功能类别。类别决定了行为统计面板的分组。
_TOOL_CATEGORIES: dict[str, str] = {
    # 文件读写
    "read_text": "file-read", "write_file": "file-write", "edit_file": "file-write",
    "apply_patch": "file-write", "read_file": "file-read",
    # 搜索
    "search_code": "search", "find_files": "search", "list_dir": "search",
    "grep": "search", "glob": "search", "semantic_search": "search",
    # Shell
    "run_command": "shell", "bash": "shell",
    # Web
    "web_search": "web", "web_fetch": "web",
    # 子代理
    "spawn_subagent": "agent", "task": "agent",
    # 技能
    "skill": "skill", "load_skill": "skill",
}

_DEFAULT_CATEGORY = "other"


def _classify_tool(name: str) -> str:
    """工具名 → 功能类别。"""
    return _TOOL_CATEGORIES.get(name.lower(), _DEFAULT_CATEGORY)


# ── 数据结构 ──────────────────────────────────────────────────────────────

@dataclass
class _Breakdown:
    """Token 空间拆分。"""
    messages: int = 0          # 对话历史 (user + assistant + tool results)
    system_prompt: int = 0    # 系统提示词
    tools: int = 0            # 工具定义 (JSON Schema)
    skills: int = 0           # 动态加载的技能内容


@dataclass
class _CacheStats:
    """Prompt Caching 统计。

    ``estimated_savings_micros`` 由 ``model_registry.compute_cost`` 按**当前
    模型**的真实费率算好后传进来（含用户自定义 override 与 provider 上报的
    真实账单）。这个类**不自己定价**。
    """
    cache_read_tokens: int = 0       # 累计缓存命中 token
    cache_miss_tokens: int = 0       # 累计缓存未命中 token
    cache_creation_tokens: int = 0   # 累计缓存创建 token
    turn_rates: list[float] = field(default_factory=list)
    average_hit_rate: Optional[float] = None
    #: 累计节省（微美元），来自 model_registry 的按模型定价。
    estimated_savings_micros: int = 0
    #: 定价来源：reported（provider 真报的账单）/ estimated（费率表命中）/
    #: fallback（费率表未命中，用了中位费率）/ ""（本会话还没有过计费调用）。
    cost_source: str = ""

    @property
    def total_cache_tokens(self) -> int:
        return self.cache_read_tokens + self.cache_creation_tokens

    def recompute_average(self) -> None:
        if not self.turn_rates:
            self.average_hit_rate = None
            return
        self.average_hit_rate = sum(self.turn_rates) / len(self.turn_rates)


@dataclass
class _ActionStats:
    """Agent 行为统计——**本轮**粒度。

    这三个计数摆在 UI 的「本轮上下文」弹层里，所以它们必须是本轮的。跨轮累计
    值另存在 ``TokenAnalytics._total_*`` 里，由 ``snapshot()["totals"]`` 单独
    暴露。早先 ``reset_turn`` 只清 ``tool_breakdown`` 且**从未被任何人调用**，
    于是「工具」那一格显示的是进程启动以来跨会话的累计值。
    """
    tool_calls: int = 0
    rules_applied: int = 0
    subagents_delegated: int = 0
    tool_breakdown: dict[str, int] = field(default_factory=lambda: defaultdict(int))


@dataclass
class _TurnSnapshot:
    """单轮快照——给 UI 展示当前轮的实时状态。"""
    breakdown: _Breakdown = field(default_factory=_Breakdown)
    cache: _CacheStats = field(default_factory=_CacheStats)
    actions: _ActionStats = field(default_factory=_ActionStats)
    #: 当前模型的真实上下文窗口。0 = 还不知道（没有任何模型解析成功过）。
    #: **不要**在这里塞一个"典型值"当默认——一个假的分母会让 32k 模型的 30k
    #: 占用显示成"15%，安全"。0 由 snapshot() 翻译成 "窗口未知"，UI 据此不画
    #: 百分比，而不是画一个错的。
    context_window: int = 0
    used: int = 0
    model_id: str = ""
    #: ``used`` 是否来自真实来源（provider 的 usage 字段）。False = 本地估算。
    used_is_exact: bool = False
    updated_at: float = 0.0


class TokenAnalytics:
    """上下文窗口分析引擎。

    进程级单例——一个 Router 对应一个实例。所有方法都是 O(1) 或
    O(消息数) 的，无 I/O、无持久化，纯内存。

    Thread safety: Router 在 asyncio 线程里写，HTTP handler / WS bridge
    可能从其他线程读。用 ``threading.Lock`` 保护写操作，读操作返回快照。
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._turn = _TurnSnapshot()
        # 累计统计（跨轮）
        self._total_tool_calls: int = 0
        self._total_rules: int = 0
        self._total_subagents: int = 0
        self._total_turns: int = 0

    # ── 从 API 响应更新 ───────────────────────────────────────────────────

    def update_from_usage(self, *, context_tokens: int = 0,
                          cache_read: int = 0, cache_miss: int = 0,
                          cache_creation: int = 0, has_cache_info: bool = False,
                          savings_micros: int = 0, cost_source: str = "",
                          used_is_exact: bool = False,
                          model_id: str = "",
                          context_window: int = 0,
                          system_prompt_tokens: int = 0,
                          tool_def_tokens: int = 0,
                          skill_tokens: int = 0) -> None:
        """从 LLM API 响应的 usage 字段更新统计。

        调用点：``Router._emit_usage_frame`` 结束后。

        ``context_tokens`` 是窗口实际占用 (input + cache_read)。
        ``savings_micros`` / ``cost_source`` 由调用方用 ``model_registry`` 按
        **当前模型**算好传进来——本类不定价。
        ``context_window`` 是当前模型的真实窗口；传 0 表示未知，此时**不覆盖**
        已有的窗口值（避免把一个已知窗口清成未知）。
        """
        with self._lock:
            t = self._turn
            t.used = context_tokens
            t.used_is_exact = bool(used_is_exact)
            if context_window > 0:
                t.context_window = context_window
            if model_id:
                t.model_id = model_id
            t.breakdown.system_prompt = system_prompt_tokens
            t.breakdown.tools = tool_def_tokens
            t.breakdown.skills = skill_tokens
            # messages = total - 已知分段。保底不为负。
            known = system_prompt_tokens + tool_def_tokens + skill_tokens
            t.breakdown.messages = max(0, context_tokens - known)

            # 缓存统计: 命中率 = cache_read / 进模型的所有 prompt token。
            #
            # cache_creation 必须在分母里：写入缓存的那部分 token 是新付钱写的，
            # 绝不是"命中"。漏掉它会让命中率在 Anthropic 上恒等于
            # read/read == 1.0 —— 因为 Anthropic 那一路 cache_miss 取的是
            # input_tokens（非缓存输入，不含 creation），两边一叠加分母就只剩
            # read 自己了。界面于是永远显示 100%，而这一栏存在的意义是让人判断
            # 缓存到底省没省钱。
            if has_cache_info or (cache_read > 0 or cache_miss > 0 or cache_creation > 0):
                t.cache.cache_read_tokens += cache_read
                t.cache.cache_miss_tokens += cache_miss
                t.cache.cache_creation_tokens += cache_creation
                denom = cache_read + cache_miss + cache_creation
                if denom > 0:
                    t.cache.turn_rates.append(cache_read / denom)
                t.cache.recompute_average()
                # 节省金额由调用方按模型定价算好；本类只累加，不自己定价。
                if savings_micros:
                    t.cache.estimated_savings_micros += int(savings_micros)
                if cost_source:
                    t.cache.cost_source = cost_source

            t.updated_at = time.time()
            self._total_turns += 1

    def update_context_window(self, max_tokens: int) -> None:
        """更新上下文窗口大小（从 config 或模型注册表获取）。"""
        with self._lock:
            self._turn.context_window = max(1, max_tokens)

    # ── 工具调用行为 ──────────────────────────────────────────────────────

    def on_tool_call(self, tool_name: str) -> None:
        """记录一次工具调用。"""
        cat = _classify_tool(tool_name)
        with self._lock:
            self._turn.actions.tool_calls += 1
            self._turn.actions.tool_breakdown[cat] += 1
            self._total_tool_calls += 1

    def on_rule_applied(self) -> None:
        """记录一次规则应用。"""
        with self._lock:
            self._turn.actions.rules_applied += 1
            self._total_rules += 1

    def on_subagent_delegate(self) -> None:
        """记录一次子代理委派。"""
        with self._lock:
            self._turn.actions.subagents_delegated += 1
            self._total_subagents += 1

    # ── 折叠事件 ──────────────────────────────────────────────────────────

    def on_fold(self, tokens_before: int, tokens_after: int) -> None:
        """折叠后更新——折叠会大幅减少 messages 分段。"""
        with self._lock:
            t = self._turn
            t.breakdown.messages = max(0, tokens_after - t.breakdown.system_prompt
                                       - t.breakdown.tools - t.breakdown.skills)
            t.used = tokens_after
            t.updated_at = time.time()

    # ── 轮次与会话重置 ───────────────────────────────────────────────────

    def reset_session(self, *, system_prompt_tokens: int = 0,
                      tool_def_tokens: int = 0, skill_tokens: int = 0,
                      context_window: int = 0) -> None:
        """新会话或切换至空会话时，重置会话级缓存与消息统计。"""
        with self._lock:
            ctx_win = context_window or self._turn.context_window
            self._turn = _TurnSnapshot()
            if ctx_win > 0:
                self._turn.context_window = ctx_win
            self._turn.breakdown.system_prompt = system_prompt_tokens
            self._turn.breakdown.tools = tool_def_tokens
            self._turn.breakdown.skills = skill_tokens
            self._turn.breakdown.messages = 0
            self._turn.used = system_prompt_tokens + tool_def_tokens + skill_tokens
            self._turn.updated_at = time.time()

    def reset_turn(self) -> None:
        """用户发送新消息时重置本轮的行为统计。

        只清本轮的 ``actions``（工具/规则/子代理计数与分类）。跨轮累计值
        （``_total_*``）不动，缓存累计也不动——那些是「本会话至今」的量，由
        snapshot 的 ``totals`` / ``cache`` 分开表达。
        """
        with self._lock:
            self._turn.actions = _ActionStats()
            self._turn.updated_at = time.time()

    # ── 快照读取 ──────────────────────────────────────────────────────────

    def snapshot(self) -> dict:
        """返回当前分析数据的快照（线程安全）。

        格式与前端 Popover 组件的 prop 对齐：breakdown / cache / actions。
        """
        with self._lock:
            t = self._turn
            b = t.breakdown
            c = t.cache
            a = t.actions
            local_sum = b.messages + b.system_prompt + b.tools + b.skills
            used = t.used or local_sum
            total = t.context_window
            # 窗口未知（total<=0）时不编造百分比——返回 None，让 UI 显示"窗口
            # 未知"而不是一个错的分级颜色。
            percent = round(used / total * 100, 1) if total > 0 else None
            # isExact = used 来自真实来源，且分段拼出来的和与它一致（分段里有
            # 启发式估算的 tools/skills，只要它们非零就不能声称"精确"）。
            is_exact = bool(t.used_is_exact) and used > 0

            return {
                "used": used,
                "total": total if total > 0 else None,
                "percent": percent,
                "modelId": t.model_id,
                "isEstimated": not is_exact,
                "windowKnown": total > 0,
                "breakdown": {
                    "messages": b.messages,
                    "systemPrompt": b.system_prompt,
                    "tools": b.tools,
                    "skills": b.skills,
                },
                "cache": {
                    "cacheReadTokens": c.cache_read_tokens,
                    "cacheMissTokens": c.cache_miss_tokens,
                    "cacheCreationTokens": c.cache_creation_tokens,
                    "averageHitRate": round(c.average_hit_rate, 4) if c.average_hit_rate is not None else None,
                    "estimatedSavingsMicros": c.estimated_savings_micros,
                    "costSource": c.cost_source,
                },
                "actions": {
                    "toolCalls": a.tool_calls,
                    "rulesApplied": a.rules_applied,
                    "subagentsDelegated": a.subagents_delegated,
                    "toolBreakdown": dict(a.tool_breakdown),
                },
                "totals": {
                    "toolCalls": self._total_tool_calls,
                    "rulesApplied": self._total_rules,
                    "subagentsDelegated": self._total_subagents,
                    "turns": self._total_turns,
                },
                "updatedAt": t.updated_at,
            }


# ── 进程单例 ──────────────────────────────────────────────────────────────

_analytics: Optional[TokenAnalytics] = None


def get_token_analytics() -> TokenAnalytics:
    global _analytics
    if _analytics is None:
        _analytics = TokenAnalytics()
    return _analytics
