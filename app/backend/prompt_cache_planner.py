"""prompt_cache_planner.py — Prompt 缓存断点规划器

把「哪些字节稳定、哪些字节易变」的认知，变成 provider 的 cache_control
断点。目标是让 provider 的 prefix cache 尽量命中：上一轮已经算过的稳定
前缀和历史对话，这一轮不该再按全价重新计费。

## 断点布局（按收益从大到小）

1. **对话尾部断点（历史缓存，收益最大）**：长会话里每轮都要把全部历史
   重发给 provider。在倒数第 2、3 条非 system 消息上放断点，让"截至上
   一轮的完整对话"成为一段可复用缓存；最新一条消息不加断点——它后面
   没有可复用的后续，加了只会多付一次写入费。
2. **system 静态前缀断点（现有行为，保留）**：system prompt 的开头几层
   （身份、准则、工具目录、输出规则）逐轮逐字节不变，前缀处打断点让
   provider 缓存整段。调用方传入的前缀必须真的匹配消息开头，不匹配就
   什么都不做——断点放错位置会静默截断 prompt，比没有缓存更糟。
3. **system 末尾断点（可选，默认关）**：仅当 system 的整体尾部也稳定时
   才有收益。Ovolve 的 system 尾部含每轮变化的召回快照，默认不开，避免
   为一段每轮都 miss 的内容付写入费。

## 三条安全纪律（与 llm_client 现有实现一致）

- **只打给认识 wire 格式的 provider kind**：`cache_control` 是 Anthropic
  家族的字段，不认识的网关可能直接 400。白名单之外一律不打。
- **只打给确认是前缀的内容**：前缀必须真匹配消息开头，且后面还有内容。
  两者任一不满足就是"没有缓存"，绝不是"截断的 prompt"。
- **只处理字符串 content**：已经是 block 列表的消息由别人负责布局，不
  动它。

## 稳定前缀注册表（StablePrefixRegistry）

技能展开、定时任务这类"静态脚手架 + 易变尾巴"的拼接点，只有拼接者自己
知道易变尾巴从哪个字节开始。拼接时把静态脚手架注册进来，后续规划器可
以按注册的前缀精确放断点，而不是靠事后解析标记字符串——标记文本可能
出现在内容正文里，解析启发式要么缩小缓存前缀、要么把易变字节吸进缓存，
两者都会让本轮优化失效。注册表进程内 LRU，条目数和总字符数双上限，
超出后最旧条目回退到"整块缓存"策略，绝不无限增长。
"""

from __future__ import annotations

import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional, Tuple

from prompt_layers import CACHE_CLASS_STABLE, PLACEMENT_SYSTEM

#: 认识 cache_control 的 provider kind（Claude 家族；oauth 也是 Claude）。
CACHE_BREAKPOINT_KINDS = frozenset({"anthropic", "oauth"})

#: 合法的缓存 TTL 档位。空串 = ephemeral（provider 侧 5 分钟自动过期，
#: 不额外收费）；"1h" = 1 小时档（写入费翻倍，换长闲置会话的命中率）。
#: 其他值一律拒绝——乱传 TTL 是 wire 400，而 wire 400 在 llm_errors 里
#: 是 permanent，一个坏请求就能杀死整轮。
CACHE_TTLS = frozenset({"", "1h"})


def _cache_marker(ttl: str = "") -> dict:
    """按 TTL 档位构造一个 cache_control 标记。"""
    marker = {"type": "ephemeral"}
    if ttl:
        marker = {"type": "ephemeral", "ttl": ttl}
    return {"cache_control": marker}

#: 注册表条目数上限。同一进程内同时活跃的拼接点（技能 × 定时任务 ×
#: 工作区）几十个就够用了；超过后最旧的退回整块缓存。
REGISTRY_MAX_ENTRIES = 32

#: 注册表总字符数上限。条目是展开后的技能正文，光数条目不约束内存——
#: 少数大技能可以留住几十 MB。保守代理：总字符数超限先逐出最旧条目，
#: 但永远保留最新一条（活跃拼接点不该被自己的历史挤掉）。
REGISTRY_MAX_TOTAL_CHARS = 512 * 1024


@dataclass(frozen=True)
class CachePlan:
    """一次规划的产物：打标后的消息列表 + 断点落点说明。"""

    messages: list
    breakpoints: Tuple[str, ...]  # ("system_prefix" | "system_tail" | "tail:idx", ...)


class StablePrefixRegistry:
    """进程内稳定前缀注册表（LRU）。

    Thread-safe：后台任务与主循环可能并发注册/查询。
    """

    def __init__(
        self,
        max_entries: int = REGISTRY_MAX_ENTRIES,
        max_total_chars: int = REGISTRY_MAX_TOTAL_CHARS,
    ) -> None:
        self._max_entries = max_entries
        self._max_total_chars = max_total_chars
        self._entries: "OrderedDict[str, str]" = OrderedDict()
        self._total_chars = 0
        self._lock = threading.Lock()

    def register(self, key: str, prefix: str) -> None:
        """注册一个稳定前缀。同 key 重复注册会刷新为最新内容（视为更新）。"""
        prefix = prefix or ""
        if not prefix or not key:
            return
        with self._lock:
            old = self._entries.pop(key, None)
            if old is not None:
                self._total_chars -= len(old)
            self._entries[key] = prefix
            self._total_chars += len(prefix)
            self._evict_locked()

    def get(self, key: str) -> str:
        """取回注册的前缀；未注册返回空串。命中即视为最近使用。"""
        with self._lock:
            value = self._entries.pop(key, None)
            if value is None:
                return ""
            self._entries[key] = value  # move-to-end
            return value

    def longest_match(self, text: str) -> Tuple[str, str]:
        """在 text 开头找最长的已注册前缀，返回 (key, prefix)。

        拼接者没显式传 key 时，规划器用这个把消息头对回已知脚手架。
        只匹配真正的前缀——前缀必须是 text 的 startswith。
        """
        best_key, best_prefix = "", ""
        with self._lock:
            for key, prefix in self._entries.items():
                if prefix and text.startswith(prefix) and len(prefix) > len(best_prefix):
                    best_key, best_prefix = key, prefix
        return best_key, best_prefix

    def size(self) -> int:
        with self._lock:
            return len(self._entries)

    def _evict_locked(self) -> None:
        while (
            len(self._entries) > self._max_entries
            or self._total_chars > self._max_total_chars
        ) and len(self._entries) > 1:
            # 永远保留最新一条（活跃拼接点）
            oldest_key, oldest_value = next(iter(self._entries.items()))
            if len(self._entries) == 1:
                break
            del self._entries[oldest_key]
            self._total_chars -= len(oldest_value)


#: 全局单例。所有拼接点共享同一个注册表。
_registry: Optional[StablePrefixRegistry] = None
_registry_lock = threading.Lock()


def get_stable_prefix_registry() -> StablePrefixRegistry:
    """取全局稳定前缀注册表（懒初始化单例）。"""
    global _registry
    if _registry is None:
        with _registry_lock:
            if _registry is None:
                _registry = StablePrefixRegistry()
    return _registry


def _split_system_prefix(
    msgs: list, prefix: str
) -> Tuple[Optional[dict], Optional[str]]:
    """确认 system 消息是字符串内容且 prefix 真为其前缀，返回 (system, 剩余内容)。

    system 不存在 / 不是 str / 前缀不匹配 / 前缀吃满整条消息 → (None, None)。
    """
    if not msgs or msgs[0].get("role") != "system":
        return None, None
    content = msgs[0].get("content")
    if not isinstance(content, str):
        return None, None
    if not prefix or not content.startswith(prefix) or len(prefix) >= len(content):
        return None, None
    return msgs[0], content[len(prefix):]


def _apply_block_marker(msg: dict, block_index: int, ttl: str = "") -> dict:
    """给消息第 block_index 个文本块加 cache_control（复制，不原地改）。"""
    content = msg.get("content")
    if isinstance(content, str):
        blocks = [{"type": "text", "text": content}]
    elif isinstance(content, list):
        blocks = [dict(b) for b in content]
    else:
        return msg
    if block_index >= len(blocks) or block_index < -len(blocks):
        return msg
    blocks[block_index] = {**blocks[block_index], **_cache_marker(ttl)}
    return {**msg, "content": blocks}


def plan_cache_breakpoints(
    msgs: list,
    *,
    system_prefix: str = "",
    kind: str = "",
    system_tail: bool = False,
    scope: str = "",
    ttl: str = "",
) -> CachePlan:
    """规划并落地 cache_control 断点，返回打标后的消息列表。

    Args:
        msgs: 原始消息列表（不会被修改；返回新列表）。
        system_prefix: system 消息开头的稳定前缀（调用方从 prompt 分层
            计算得来）。不传或传了不匹配 → 前缀断点跳过。
        kind: provider kind。不在白名单 → 整个规划为空操作。
        system_tail: 是否在 system 末尾放断点。仅当 system 尾部也稳定时
            开启（默认关，见模块 docstring）。
        scope: 缓存作用域标识（会话/轮换根）。当前只透传进 plan 供审计，
            后续若引入会话轮换，同一条压缩谱系的会话应共用同一 scope。
        ttl: 缓存档位。空串 = 5 分钟自动过期（默认）；"1h" = 1 小时档
            （写入费翻倍）。不在 CACHE_TTLS 白名单 → 整体空操作。

    Returns:
        CachePlan(messages=打标后的新列表, breakpoints=实际落点)。
    """
    if kind.lower() not in CACHE_BREAKPOINT_KINDS:
        return CachePlan(messages=msgs, breakpoints=())
    if ttl not in CACHE_TTLS:
        return CachePlan(messages=msgs, breakpoints=())
    marker = _cache_marker(ttl)

    out = list(msgs)
    placed: list[str] = []

    # 1. system 静态前缀断点
    if system_prefix:
        _, rest = _split_system_prefix(out, system_prefix)
        if rest is not None:
            out[0] = {
                "role": "system",
                "content": [
                    {"type": "text", "text": system_prefix, **marker},
                    {"type": "text", "text": rest},
                ],
            }
            placed.append("system_prefix")

    # 2. system 末尾断点（可选）
    if system_tail and out and out[0].get("role") == "system":
        first = out[0]
        content = first.get("content")
        if isinstance(content, str):
            blocks = [{"type": "text", "text": content}]
            blocks[-1] = {**blocks[-1], **marker}
            out[0] = {**first, "content": blocks}
            placed.append("system_tail")
        elif isinstance(content, list):
            blocks = [dict(b) for b in content]
            if blocks:
                blocks[-1] = {**blocks[-1], **marker}
                out[0] = {**first, "content": blocks}
                placed.append("system_tail")

    # 3. 对话尾部断点：倒数第 2、3 条非 system 消息
    non_system_idx = [i for i, m in enumerate(out) if m.get("role") != "system"]
    if len(non_system_idx) >= 3:
        # 最末条（当前轮输入）不加断点；给它前面的两条打标，让"历史"
        # 成为可复用缓存块。
        for idx in (non_system_idx[-3], non_system_idx[-2]):
            out[idx] = _apply_block_marker(out[idx], -1, ttl=ttl)
            placed.append(f"tail:{idx}")

    return CachePlan(messages=out, breakpoints=tuple(placed))


def resolve_cache_scope(session_id: str, lineage_root: Optional[str] = None) -> str:
    """解析一条会话的缓存作用域。

    缓存 key 的作用域应该跟随"逻辑会话"而不是物理 session_id：将来若
    引入会话轮换（压缩时换新物理 id），同一对话的后续轮次必须落回同一
    缓存桶，否则每次轮换都全量 miss。当前实现是就地折叠、不轮换，
    作用域即 session_id 本身；lineage_root 参数为轮换预留——传入压缩
    谱系根 id 时用它作为作用域。
    """
    return lineage_root or session_id or ""


def resolve_effective_system_prefix(
    msgs: list,
    explicit_prefix: str = "",
) -> str:
    """Return the longest cacheable system prefix for this message list.

    Tries the caller-supplied prefix first; if it does not match the system
    message head, falls back to the global StablePrefixRegistry longest_match.
    """
    prefix = explicit_prefix or ""
    if prefix and msgs and msgs[0].get("role") == "system":
        content = msgs[0].get("content")
        if isinstance(content, str) and content.startswith(prefix):
            return prefix
    if msgs and msgs[0].get("role") == "system":
        content = msgs[0].get("content")
        if isinstance(content, str):
            _, matched = get_stable_prefix_registry().longest_match(content)
            if matched:
                return matched
    return prefix

# ---------------------------------------------------------------------------
# Section 分区对接（P0-2，）：直接消费
# 区块的 cache_class，而不是让调用方
# 手工算好一个前缀字符串再传进来。
# ---------------------------------------------------------------------------

def stable_prefix_from_sections(sections) -> str:
    """从区块序列推导稳定前缀：system 布局、开头连续 ``cache_class=="stable"`` 的正文。

    与 prompt_layers.render_and_prefix 同一条连续性纪律：断点必须落在连续
    边界上，stable 区块出现在 dynamic 之后时不回头捞——宁可少缓存一段，
    也不造出「不是前缀的前缀」。非 system 布局的区块（tool_result / suffix）
    不参与前缀计算。

    参数是鸭子类型：任何带 ``placement`` / ``cache_class`` / ``content``
    属性的对象都收，规划器不反向依赖组装器的具体类型。
    """
    parts: list[str] = []
    for section in sections or []:
        if str(getattr(section, "placement", PLACEMENT_SYSTEM)) != PLACEMENT_SYSTEM:
            continue
        if str(getattr(section, "cache_class", "")) != CACHE_CLASS_STABLE:
            break
        body = (getattr(section, "content", "") or "").strip()
        if body:
            parts.append(body)
    return "\n\n".join(parts)


def plan_section_cache_breakpoints(
    msgs: list,
    sections,
    *,
    kind: str,
    ttl: str = "",
    scope: str = "",
    system_tail: bool = False,
) -> CachePlan:
    """把分区注册表交上来的 cache_class 直接变成断点规划。

    这是规划器消费 cache_class 的入口：调用方把组装好的区块列表传进来，
    稳定前缀由区块的 cache_class 推导，再走既有的 plan_cache_breakpoints
    全套安全纪律（kind 白名单 / 前缀真实性校验 / TTL 白名单）——分区只是
    换了一种告诉规划器「哪里稳定」的方式，纪律一条没少。
    """
    return plan_cache_breakpoints(
        msgs,
        system_prefix=stable_prefix_from_sections(sections),
        kind=kind,
        system_tail=system_tail,
        scope=scope,
        ttl=ttl,
    )
