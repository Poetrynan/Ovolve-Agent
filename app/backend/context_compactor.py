"""context_compactor.py — Ovolve 上下文压缩引擎（折叠 / Fold）

# 为什么叫「折叠」而不是 compact

Compact 是别人的词。Ovolve 的心智模型是**把一叠纸折起来**：内容还在，只是
占的地方小了，而且折痕处留了标记，随时能翻回去。所以：

- 对用户：叫「折叠上下文」，摘要卡片叫「折痕」（fold marker）
- 对代码：类型仍叫 compaction（和 storage / event_bus 既有命名对齐）

# 渐进降级折叠链（4层韧性架构）

    1. LLM 摘要   —— 有模型就调模型，产出 Goal/Progress/Decisions/OpenIssues
                     四段结构（复用 memory_layer.synthesize_session）
    2. 启发式压缩 —— 无模型 / 模型超时 / 模型报错时，规则抽取关键信息
    3. 硬截断     —— 连启发式都失败（数据畸形）时，只留最近 N 轮

每一层失败都往下掉，绝不静默返回空摘要。

# 防循环（三道闸）

    · 冷却期      —— 两次折叠至少间隔 COOLDOWN_S
    · 连续上限    —— 连续自动折叠不超过 MAX_CONSECUTIVE 次
    · 增量检查    —— 上次折叠后没有新内容就不折

手动触发（用户点按钮 / 敲 /fold）可以**穿透冷却期和增量检查**，但仍受连续
上限保护 —— 用户点十次也不该把 token 全烧在摘要上。

# 微折叠 (microfold)

老的工具结果最占地方且最没用（读过的文件内容、命令输出）。微折叠只清工具
结果、不动对话，成本为零，所以在正式折叠**之前**先跑一遍，往往就够了。

# 加密

摘要落盘默认明文。打开 `encryption_enabled`（config.json 的
`compaction.encryption_enabled`）后，摘要在落库前经 `_seal` 用 CredentialCipher
加密（Fernet 优先，库缺失时退化为 base64 混淆并带 `plain:` 前缀如实标记），
回放路径（router._build_history）经 `_unseal` 解封。已落库的历史明文行无需
迁移——`_unseal` 对无前缀内容原样返回。

# 受保护区块（P0-3）

权限规则/安全策略/任务约束这类关键区块，以**结构化元数据**（消息对象上的
`stable_block` 字段或 metadata 里的同名键，见 `StableBlock`）声明「压缩时
原样保留」。压缩器按元数据判定：不解析正文文本、不依赖模型自觉、不引入
魔法标记字符串。折叠时这些区块由代码原样拼进摘要——折痕之后唯一会被
回放的东西就是摘要，放别处等于丢掉；N 轮连续压缩零丢失。

（受保护区块实现）
"""
from __future__ import annotations
import asyncio
import logging
import time
import json
from dataclasses import dataclass
import token_estimate
from typing import Optional, Callable, Awaitable
from result import Result
from event_bus import EventBus, Event, get_event_bus
from storage import get_storage

log = logging.getLogger(__name__)

#: 第 1 层 LLM 摘要的单次调用上限（秒）。超时按"模型失败"处理——立即降到
#: 启发式层，不重试。量级依据：审计重试最坏 3 次调用，90s × 3 = 270s 的
#: 折叠最坏路径仍有界（与业界压缩超时的 300s 同档），而无限等待会拖死回合。
FOLD_SUMMARY_TIMEOUT_S = 90.0


#: 工具结果里可以安全清掉的工具 —— 这些的输出是"读过就没用了"的一次性内容。
FOLDABLE_TOOLS = frozenset({
    "read_file", "write_file", "edit_file", "list_dir", "grep", "glob",
    "run_command", "bash", "web_search", "web_fetch", "semantic_search",
})

#: 工具结果被微折叠后留下的占位符。保留工具名，让模型知道"这里发生过什么"。
FOLD_PLACEHOLDER = "[内容已折叠 — 如仍需要请重新读取]"

#: 折叠后必须原样保留的附件占位行。
#:
#: 图片是这套存储模型里唯一「折了就真找不回来」的东西：真实引用只存在
#: assistant 行的 ``metadata.images`` 里，而 ``_build_history`` 从不回放
#: metadata（router.py:1160-1163 是故意的，base64 太大），正文里那句
#: ``[图片: name]`` 是它在后续轮次唯一的痕迹。这句痕迹一旦被摘要器吞掉，模型
#: 就再也不知道自己生成过图，用户说「把刚那张图改成蓝色」时它一脸茫然。
IMAGE_FOLD_PLACEHOLDER = "[图片已折叠：{name}]"

#: 占位行在摘要里的小标题。摘要（system 行）是折痕之后唯一会被回放的东西，
#: 所以要保留的引用必须落在它里面，放别处等于丢掉。
PRESERVED_SECTION_TITLE = "### 折叠时保留的附件引用"

#: 参数里不该进摘要的字段（正文/代码，又长又容易泄漏）。
REDACTED_ARG_FIELDS = frozenset({
    "content", "new_string", "old_string", "text", "body", "code", "widget_code",
})


# ---------------------------------------------------------------------------
# 受保护区块（P0-3 稳定区块保护）——结构化层级元数据路线
# ---------------------------------------------------------------------------

#: 受保护区块的语义类别注册表。类别只是归类与审计标签——保护判定走结构化
#: 元数据，不解析内容文本；未注册的类别同样受保护（fail-open 朝更安全的
#: 方向开：多保一条的成本远低于丢一条策略）。
STABLE_BLOCK_KINDS = frozenset({
    "permission_rules",    # 权限规则（允许/拒绝清单、必须确认的操作）
    "safety_policy",       # 安全策略（不可逆操作红线）
    "task_constraints",    # 任务约束（用户明确下达的硬性要求）
})

#: 折叠摘要里受保护区块段落的小标题。自有文案。
PROTECTED_BLOCK_SECTION_TITLE = "### 受保护规则区块（关键约束原文，压缩时按元数据保留）"


@dataclass(frozen=True)
class StableBlock:
    """一个「压缩时必须原样保留」的区块声明。

    挂在消息对象的结构化元数据上（不是内容里的标记文本）：压缩器读元数据
    做判定，正文怎么改写、模型自觉与否都不影响结果。这是层级元数据路线，
    与「在正文里埋魔法标记再靠解析认领」的路线刻意划清界限——标记会被
    摘要、转写、截断破坏，元数据挂在对象上不会。
    """
    kind: str = "task_constraints"
    #: 保留优先级：限预算场景下越大越关键、越晚让位。默认不限预算，
    #: 该字段只做排序与审计。
    priority: int = 0
    protected: bool = True


def _parse_stable_block(raw) -> Optional[StableBlock]:
    """把结构化元数据解析成 StableBlock；解析失败或显式关闭保护都返回 None。"""
    if isinstance(raw, StableBlock):
        return raw if raw.protected else None
    if not isinstance(raw, dict):
        return None
    if raw.get("protected") is False:
        return None
    try:
        priority = int(raw.get("priority") or 0)
    except (TypeError, ValueError):
        priority = 0
    return StableBlock(kind=str(raw.get("kind") or "task_constraints"), priority=priority)


def stable_block_of(msg) -> Optional[StableBlock]:
    """读一条消息的结构化保护元数据；没有标记返回 None。

    两个挂载点都认（同一语义、两种存放形态）：
      - 内存 dict 的顶层键 ``stable_block``（_agent_loop 原生 dict 的路径）；
      - ``metadata`` 里的 ``stable_block``（storage.get_messages 返回 JSON
        文本的路径——与图片引用 ``metadata.images`` 同一套扩展点）。
    任何解析失败都当作「没有标记」：坏数据绝不能打断折叠，也不能反过来
    把一条普通消息误判成受保护。
    """
    if msg is None:
        return None
    if isinstance(msg, dict):
        block = _parse_stable_block(msg.get("stable_block"))
        if block:
            return block
        metadata = msg.get("metadata")
    else:
        try:
            metadata = msg["metadata"]
        except (KeyError, IndexError, TypeError):
            return None
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (ValueError, TypeError):
            return None
    if isinstance(metadata, dict):
        return _parse_stable_block(metadata.get("stable_block"))
    return None


def mark_stable_block(
    msg: dict, kind: str = "task_constraints", priority: int = 0,
) -> dict:
    """给一条消息打上结构化保护元数据（就地修改并返回）。

    用法::

        history.append(mark_stable_block(
            {"role": "user", "content": rules_text},
            kind="permission_rules", priority=5))

    正文原样携带，没有任何标记文本混进内容。
    """
    if isinstance(msg, dict):
        msg["stable_block"] = {"protected": True, "kind": kind, "priority": priority}
    return msg


class FoldLimitReached(RuntimeError):
    """连续折叠次数用尽 —— 再折下去就是在烧钱，不是在省钱。"""


def _images_in_metadata(metadata) -> list:
    """从一行的 metadata 里取出图片引用列表，兼容 dict 与 JSON 字符串。

    ``storage.get_messages`` 把 metadata 作为 JSON 文本返回，而 ``_agent_loop``
    内部又是原生 dict——折叠既可能拿到前者也可能拿到后者，所以两种都要认。
    任何解析失败都当作「没有图片」，绝不让它冒泡打断折叠。
    """
    if not metadata:
        return []
    if isinstance(metadata, str):
        try:
            metadata = json.loads(metadata)
        except (ValueError, TypeError):
            return []
    if not isinstance(metadata, dict):
        return []
    imgs = metadata.get("images")
    return imgs if isinstance(imgs, list) else []


class ContextCompactor:
    """上下文折叠引擎。

    # 阈值为什么是这些数（2026-08 调研过主流产品后定的）

    | 产品 | 自动触发 | 保留缓冲 | 保留原文 | 可配置 |
    |------|---------|---------|---------|--------|
    | 同业编码代理 | ~83% | 33K (16.5%) 硬编码 | — | 支持环境变量覆盖 |
    | 同业编辑代理 | 可用窗口耗尽 | `min(20K, max_output)` | 最近 2 轮原文 | `threshold_percent` |
    | 同业滑块派 | 滑块，默认 100% | 30%（20% 输出 + 10% 安全） | — | 滑块 |

    共识是三件事，我们全都照做：

    1. **算的是"可用窗口"，不是总窗口** —— 必须给回复留 headroom，否则
       折叠动作本身都可能因为没地方放摘要而失败。这是业界方案的 33K
       buffer 的真正含义。我们用 ``reserved_tokens``。
    2. **最近几轮留原文** —— 只给摘要会丢掉正在做的事的细节。业界方案的
       ``tail_turns=2`` 是个好默认，我们同样保留最近 2 轮用户轮次原文。
    3. **阈值可配** —— 所有产品都在被用户要这个功能。我们从 config.json
       读，不硬编码。

    我们和他们不同的地方：
    · 触发线取 80%（业界常见 83%、也有按可用窗口耗尽触发的方案）—— 我们的 estimator 是
      估算不是精确计费，留 3 个点给估算误差。
    · 冷却 15s 而不是文档里的 30s —— 30s 在真实对话里长得能明显卡手。
    · 工具结果剪枝用 token 预算窗口（对齐业界方案的 40K recency window 思路），
      而不是"只留最近 1 条"。

    Args:
        max_tokens: 模型上下文总窗口。
        threshold: 触发比例，按**可用窗口**算（默认 0.80）。
        emergency_threshold: 紧急比例，越过它无视冷却期强折（默认 0.90）。
        cooldown_s: 两次自动折叠的最小间隔。
        max_consecutive: 连续折叠上限。
        reserved_tokens: 给模型回复留的 headroom。None 时自动取
            ``min(20_000, max_tokens * 0.15)`` —— 和业界方案的
            ``min(20K, max_output_tokens)`` 同量级。
        reserve_tokens_floor: 折叠后的空闲 token 地板。某层压缩做完后空闲仍
            低于它，就升级到下一层策略重压（llm-summary → engineering →
            truncate）。None 时自动取 ``min(8_000, max_tokens * 0.10)``。
        tail_turns: 折叠后仍保留原文的最近用户轮次数。
        prune_window_tokens: 工具结果保鲜窗口。窗口外的旧结果会被微折叠清掉。
    """

    def __init__(
        self,
        max_tokens: int = 80_000,
        threshold: float = 0.80,
        emergency_threshold: float = 0.90,
        cooldown_s: float = 15.0,
        max_consecutive: int = 5,
        reserved_tokens: Optional[int] = None,
        tail_turns: int = 2,
        prune_window_tokens: int = 16_000,
        reserve_tokens_floor: Optional[int] = None,
        encryption_enabled: bool = False,
    ):
        self.max_tokens = max_tokens
        self.threshold = threshold
        self.emergency_threshold = emergency_threshold
        self.cooldown_s = cooldown_s
        self.max_consecutive = max_consecutive
        # 15% 或 20K 取小 —— 对齐业界方案的 min(20K, max_output_tokens)。
        self.reserved_tokens = (
            reserved_tokens
            if reserved_tokens is not None
            else min(20_000, int(max_tokens * 0.15))
        )
        # 折叠后的空闲地板：一层折叠做完后，若剩余空闲 token 低于这个数，
        # 就升级到下一层压缩策略（llm-summary → engineering → truncate），
        # 直到满足地板或已到最底层。reserved_tokens 是"提前触发"的 headroom，
        # 这个 floor 是"折叠必须兑现"的结果保证 —— 两者互补，缺一不可：
        # 没有它，一次刚好压过阈值的折叠可能留下一条只差一点又立刻超限的
        # 上下文，下一轮马上再折，白烧一次摘要。
        self.reserve_tokens_floor = (
            reserve_tokens_floor
            if reserve_tokens_floor is not None
            else min(8_000, int(max_tokens * 0.10))
        )
        self.tail_turns = tail_turns
        self.prune_window_tokens = prune_window_tokens
        #: Which session this compactor belongs to. Set by Router (as
        #: ``self.compactor.session_id = self.session_id``); used only to look
        #: up the provider's own token count for the last turn, which is the
        #: single most trustworthy estimate we can get.
        self.session_id: str = ""
        #: 缓存谱系（Phase 33 联动）。折叠目前是就地改写、不换会话 id，
        #: 谱系根就是 session_id 本身；将来若引入「折叠换新物理会话段」
        #: 的轮换机制，只要在轮换处把新 id 写进 session_id、把原始 id 留在
        #: _lineage_root，cache_scope() 就自动把同一对话的后续轮次锚回同
        #: 一个缓存桶——provider 的 prefix cache 不因轮换而全量 miss。
        #: 见 prompt_cache_planner.resolve_cache_scope。
        self._lineage_root: str = ""
        self._fold_count: int = 0

        # 加密开关：开启后折叠摘要以密文落库（见模块 docstring「加密」节）。
        # 默认关 —— 本地单用户部署里明文 SQLite 是合理基线，加密是显式选择。
        self.encryption_enabled = bool(encryption_enabled)
        self._cipher = None
        self._cipher_warned = False

        self._read_files: set[str] = set()
        self._modified_files: set[str] = set()
        self._bus: Optional[EventBus] = None

        # ── 防循环状态 ──
        self._last_fold_at: float = 0.0
        self._consecutive: int = 0
        self._folding: bool = False
        #: 上次折叠时历史有多少条 —— 用来判断"有没有新内容"。
        self._folded_upto: int = 0

        # ── 统计（给 UI 的折叠卡片用）──
        self._total_folds: int = 0
        self._total_tokens_saved: int = 0

        #: 由 Router 注入的 LLM 摘要器：``async (messages) -> dict | None``。
        #: 保持可注入而不是直接 import，避免 compactor 依赖 router。
        self._summarizer: Optional[Callable[[list], Awaitable[Optional[dict]]]] = None

        #: 折叠前的记忆冲刷回调：``async (messages) -> int``（返回抽出的记忆条数）。
        #: 由 Router 在启动时注入，指向 memory_layer 的一个提取入口。
        #: 折叠是有损的——正文替换成摘要之后原文就没了。所以在折叠**之前**
        #: 先把里面的决策/偏好/事实抽出来落库，压缩才不再是净信息损失。
        self._memory_flush: Optional[Callable[[list], Awaitable[int]]] = None

        #: 折叠后的记忆预热回调：``async (session_id, query) -> None``。
        #: 由 Router 注入，指向 memory_layer.prefetch。折叠完成后的下一轮，
        #: 模型会带着摘要和这批预热的记忆继续——摘要保骨架，记忆补血肉。
        self._post_fold_warmup: Optional[Callable[[str, str], Awaitable[None]]] = None

        #: 软阈值：token 用量到这个数就允许在下一次机会做 memory flush，
        #: 无需等到触及折叠线。让"沉淀"跑在"折叠"前面。
        self.soft_threshold_tokens: int = 4000
        #: 硬阈值：transcript 原始字节数超过 2MB 时强制冲刷，避免磁盘也吃不消。
        self.force_flush_transcript_bytes: int = 2_000_000
        #: 上次 flush 时的消息序号，用来跳过已经沉淀过的段。
        self._flushed_upto: int = 0

    # ── 生命周期 ────────────────────────────────────────────────────────────

    def cache_scope(self) -> str:
        """本会话的缓存作用域（prompt_cache_planner 的 lineage 语义）。

        返回压缩谱系根：未轮换时即 session_id；轮换后由 _lineage_root 锚
        定原始会话。router 用它作为稳定前缀注册与缓存 key 的作用域，使
        「逻辑上同一条对话」在 provider 侧落进同一个缓存桶。
        """
        return self._lineage_root or self.session_id or ""

    def note_folded(self) -> None:
        """一次折叠落地后调用：递增谱系代数。

        当前折叠不轮换，代数只是审计信息（前端「这条对话折过几次」）；
        引入轮换后，轮换点应设置 _lineage_root = 旧 session_id，让谱系
        跨物理段延续。
        """
        self._fold_count += 1

    def mount(self, bus: EventBus = None):
        self._bus = bus or get_event_bus()
        self._bus.on("session_before_compact", self._on_compact, priority=50)

    def set_summarizer(self, fn: Callable[[list], Awaitable[Optional[dict]]]) -> None:
        """注入 LLM 摘要器（Router 启动时调用）。"""
        self._summarizer = fn

    def set_memory_flush(self, fn: Callable[[list], Awaitable[int]]) -> None:
        """注入折叠前记忆冲刷器（Router 启动时调用）。

        签名 ``async (messages) -> int``，返回沉淀成功的记忆条数。
        """
        self._memory_flush = fn

    def set_post_fold_warmup(self, fn: Callable[[str, str], Awaitable[None]]) -> None:
        """注入折叠后记忆预热器（Router 启动时调用）。

        签名 ``async (session_id, query) -> None``。折叠完成后触发，
        用当前目标作 query 预热记忆检索，让下一轮上下文既有摘要骨架
        又有相关记忆血肉。
        """
        self._post_fold_warmup = fn

    def transcript_bytes(self, messages: list) -> int:
        """transcript 的 UTF-8 原始字节数——硬阈值判断用。"""
        return sum(len((self._content_of(m) or "").encode("utf-8")) for m in messages)

    def should_flush_memory(self, messages: list) -> tuple[bool, str]:
        """折叠前要不要先冲刷记忆？返回 ``(决定, 原因码)``。

        两条独立触发线：
        - 软线：估算 token 越过 ``soft_threshold_tokens``。这是常规路径——
          在还远没到折叠线的时候就开始沉淀，让"记住"领先于"忘记"。
        - 硬线：transcript 字节数越过 ``force_flush_transcript_bytes``。
          防的是"单条消息巨大但条数很少"这种 token 估算容易看漏的形态。

        增量检查：没有新消息就不重复沉淀（否则每次折叠都把同一段抽一遍，
        既烧 LLM 又制造重复记忆）。
        """
        if self._memory_flush is None:
            return False, "no-flusher"
        if len(messages) <= self._flushed_upto:
            return False, "no-new-content"
        if self.transcript_bytes(messages) >= self.force_flush_transcript_bytes:
            return True, "force-bytes"
        if self.estimate_tokens_multi(messages) >= self.soft_threshold_tokens:
            return True, "soft-tokens"
        return False, "under-threshold"

    async def flush_memory(self, messages: list) -> int:
        """跑一次记忆冲刷。失败返回 0，绝不抛异常打断折叠。

        只把**尚未沉淀过**的那一段交给抽取器——已经落库的段再抽一次只会
        产生重复记忆，还白烧一次 LLM 调用。
        """
        if self._memory_flush is None:
            return 0
        fresh = messages[self._flushed_upto:] or messages
        try:
            count = await self._memory_flush(fresh)
        except Exception as exc:  # noqa: BLE001
            print(f"[compactor] memory flush failed: {exc}")
            return 0
        self._flushed_upto = len(messages)
        return int(count or 0)

    async def _on_compact(self, event: Event):
        """``session_before_compact`` 的订阅者——只在发布者自己不折叠时兜底。

        ``Router.fold_context`` 会先 emit 这个事件（让 memory_layer 在原文被摘要
        替换之前把决策/偏好沉淀下来），紧接着自己 ``await self.compactor.fold()``。
        两边都折，一次折叠请求就跑两遍：两次摘要模型调用、``_consecutive`` 加两次、
        库里落两条 compaction 行、``_folded_upto`` 被覆盖两次。``_folding`` 拦不住
        它——第一次的 ``finally`` 已经把标志复位，第二次进来时干干净净。

        所以由发布者用 ``folds_itself`` 声明所有权。保留这条兜底路径是为了以后
        真有别的发布者时折叠不会静默消失。
        """
        if event.payload.get("folds_itself"):
            return
        session_id = event.payload.get("session_id", "")
        messages = event.payload.get("messages", [])
        manual = bool(event.payload.get("manual"))
        if not messages:
            return
        result = await self.fold(session_id, messages, manual=manual)
        if result.ok:
            event.modify({"summary": result.value["summary"], "compacted": True})

    # ── Token 估算 ──────────────────────────────────────────────────────────

    def estimate_tokens(self, text: str) -> int:
        """中英混排的 token 估算。

        实现在 ``token_estimate.estimate_tokens``——全后端唯一一份。这里保留成
        方法只是因为调用点太多（折叠、淘汰、analytics 分段），而且 compactor 是
        大多数人查"这个数是怎么来的"时第一个打开的文件。

        注意口径变化：这里原本按中文 1.8 char/token（≈0.56 token/字）算，比真实
        分词器低估一倍多；统一后按 1 token/宽字符算。这不会改变折叠时机——
        ``estimate_tokens_multi`` 取各信号最大值，而字节信号（3 bytes / 3.5）
        早就以 ≈0.857 token/字盖住了旧的 0.56。改的是这个数自己诚实了。
        """
        return token_estimate.estimate_tokens(text)

    def estimate_tokens_multi(self, messages: list) -> int:
        """Multi-source token estimation — take the MAXIMUM of several heuristics.

        Three independent signals:
            1. Per-message char-ratio estimate (``total_tokens``) — accurate for
               text we can see, blind to the provider's real tokenizer.
            2. Provider-reported context size at the last turn
               (``storage.last_turn_context_tokens``) — what the model actually
               read, including cached prefix. Stale between turns, but honest.
            3. UTF-8 byte length ÷ 3.5 — a floor that catches multibyte content
               the char heuristic under-counts (emoji, CJK punctuation, base64).

        Why max and not average? Compaction is a "will we exceed the window"
        guard, and the two failure modes are wildly asymmetric. Under-estimate →
        skip the fold → the next call context-exceeds and the user eats an error
        they have to drive around. Over-estimate → fold one turn early, costing a
        summarization nobody notices. So any signal that says "nearly full" wins.
        """
        estimates = [self.total_tokens(messages)]
        # Provider-reported context size at the last turn — the most trustworthy
        # signal available, but only when it is in the same plausible range as the current
        # messages list. A past turn with 20 ReAct loop steps accumulates a massive billing
        # total (e.g. 400k tokens), which must NEVER poison a brand new turn's compact message list.
        try:
            from storage import get_storage
            if self.session_id:
                reported = get_storage().last_turn_context_tokens(self.session_id)
                text_est = estimates[0]
                if reported and (text_est == 0 or reported <= max(text_est * 3, 8000)):
                    estimates.append(int(reported))
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        # Byte-length divided by average bytes/token (conservative 3.5 for
        # multilingual). Only useful when the char-ratio estimate can't see
        # multi-byte characters it doesn't account for.
        raw_bytes = sum(len((self._content_of(m) or "").encode("utf-8")) for m in messages)
        if raw_bytes:
            estimates.append(int(raw_bytes / token_estimate.BYTES_PER_TOKEN))
        return max(estimates) if estimates else 0

    def total_tokens(self, messages: list) -> int:
        return sum(self.estimate_tokens(self._content_of(m)) for m in messages)

    @staticmethod
    def _content_of(msg) -> str:
        """兼容 dict 与 sqlite3.Row。"""
        if isinstance(msg, dict):
            return msg.get("content") or ""
        try:
            return msg["content"] or ""
        except (KeyError, IndexError, TypeError):
            return ""

    @staticmethod
    def _field(msg, key: str, default=None):
        if isinstance(msg, dict):
            return msg.get(key, default)
        try:
            return msg[key]
        except (KeyError, IndexError, TypeError):
            return default

    # ── 触发判断 ────────────────────────────────────────────────────────────

    @property
    def usable_tokens(self) -> int:
        """可用于对话的 token 数 —— 总窗口减去给回复保留的 headroom。

        自动折叠触发线是相对**可用窗口**算的，不是总窗口。这和业界方案
        的 33K buffer、业界方案的 ``reserved`` 是同一个道理：不能等真填满了才
        折，那时连摘要都放不下。
        """
        return max(1, self.max_tokens - self.reserved_tokens)

    def usage_ratio(self, messages: list) -> float:
        # Multi-source max is the honest number here: char-ratio can be wrong
        # (custom tokenizers, multibyte glyphs), provider counts can be stale
        # (last turn was ages ago), byte counts can be too pessimistic. Taking
        # the max means any signal saying "close to full" wins — a fold triggered
        # slightly early is cheap; one triggered late means a context-exceeded
        # error the user has to notice and drive around.
        return self.estimate_tokens_multi(messages) / self.usable_tokens

    def should_fold(self, messages: list, manual: bool = False) -> tuple[bool, str]:
        """要不要折叠？返回 ``(决定, 原因码)``，原因码方便前端/日志解释。

        手动触发穿透冷却期与增量检查，但仍受"正在折叠"和连续上限保护。
        """
        if self._folding:
            return False, "already-folding"
        if self._consecutive >= self.max_consecutive:
            return False, "max-consecutive"

        if manual:
            if len(messages) <= 2:
                return False, "too-short"
            return True, "manual"

        ratio = self.usage_ratio(messages)
        if ratio < self.threshold:
            return False, "under-threshold"
        # 越过紧急线：无视冷却期。
        if ratio < self.emergency_threshold:
            if time.time() - self._last_fold_at < self.cooldown_s:
                return False, "cooldown"
            if len(messages) <= self._folded_upto:
                return False, "no-new-content"
        return True, "auto"

    # ── 主入口 ──────────────────────────────────────────────────────────────

    #: 消息类型白名单——折叠时必须原样保留的角色/msg_type。
    #: tool_result 与 tool_use 必须配对保留，否则模型解析上下文时会报 400。
    #: 图片消息（vision input）一旦丢失就不可恢复。cancelled_op 是用户已授权的
    #: 操作记录，去掉会让模型"忘记"用户拒绝过什么，再次发起危险操作。
    WHITELIST_ROLES = frozenset({"tool_use", "tool_result"})
    WHITELIST_MSG_TYPES = frozenset({"tool_result", "cancelled_op", "image"})

    @staticmethod
    def _is_whitelisted(msg: dict) -> bool:
        """判断消息是否在折叠白名单里，不允许被摘要吞掉。"""
        # 结构化受保护区块（P0-3）：按元数据判定，与正文文本无关——
        # 权限规则/安全策略/任务约束不参与任何摘要与替换。
        if stable_block_of(msg):
            return True
        role = msg.get("role", "")
        if role in ContextCompactor.WHITELIST_ROLES:
            return True
        msg_type = msg.get("msg_type", "")
        if msg_type in ContextCompactor.WHITELIST_MSG_TYPES:
            return True
        # 图片类 content（vision multimodal 的 list-of-blocks 格式）
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "image":
                    return True
        # 本仓真正会出现的形态。上面那几个分支对应 tool_use / tool_result /
        # image 行，而 `add_message` 的三个调用点（router.py:1049/1170/1181）
        # 只写 user / assistant / interrupt_note ——也就是说折叠实际拿到的数据里
        # 只有这一条分支会命中：assistant 行把图片引用放在 metadata.images，
        # 正文里只留一句 `[图片: name]`。少了这一条，一条又长又带图的回复会被
        # replace_oversized 整段换成占位备注，图片痕迹在摘要器读到之前就没了。
        if _images_in_metadata(msg.get("metadata")):
            return True
        return False

    #: 正文里图片痕迹的形态，与 ``image_store.placeholder`` 保持一致。
    _IMAGE_TRACE_RE = r"\[图片:\s*([^\]\n]+)\]"

    def _preserved_artifacts(self, messages: list, cap: int = 30) -> list[str]:
        """把「折了就找不回来」的东西抽成确定性占位行。

        为什么不能交给摘要器：``audit_summary_quality`` 只护代码标识符（文件
        路径、函数名、常量），``[图片: 截图.png]`` 这种痕迹不在它的模式里——
        摘要器把它丢干净，审计照样通过。所以这些行必须由代码原样拼进摘要，
        一个模型都不经过。

        只处理图片是有意的：工具结果从不落库（只在单轮 ``_agent_loop`` 的内存
        列表里存在），折叠层根本拿不到，所以这里不为一种不存在的形态写保留
        逻辑——那只会变成下一处「看着像生效了」的死代码。
        """
        import re
        seen: set[str] = set()
        lines: list[str] = []

        def add(name: str) -> None:
            name = (name or "image").strip()[:120]
            if not name or name in seen:
                return
            seen.add(name)
            lines.append(IMAGE_FOLD_PLACEHOLDER.format(name=name))

        for m in messages:
            for ref in _images_in_metadata(self._field(m, "metadata")):
                if isinstance(ref, dict):
                    add(ref.get("name") or ref.get("id") or "image")
            # 正文兜底：早期的行、以及用户上传（而非模型生成）的图片只有正文痕迹。
            for hit in re.finditer(self._IMAGE_TRACE_RE, self._content_of(m)):
                add(hit.group(1))

        if len(lines) > cap:
            extra = len(lines) - cap
            lines = lines[:cap] + [f"[还有 {extra} 张图片未列出]"]
        return lines

    #: 受保护区块段落的总 token 预算，0 = 不限。保护语义默认是「100% 保留」：
    #: 一个"留一半"的保护等于没有。限预算只服务极端小窗口的场景，且总是
    #: 整块取舍——优先级低的先让位，绝不把一条规则截成半句。
    protected_block_budget_tokens: int = 0

    def _protected_block_lines(self, messages: list) -> list[str]:
        """收集受保护区块的原文，按优先级排序去重后逐条成行。

        与 ``_preserved_artifacts`` 同一个存在理由：摘要器是有损的，而权限
        规则/安全策略/任务约束丢一句就是事故。这些行由代码从**结构化元
        数据**判定后原样拼进摘要——不经过模型、不匹配正则、不依赖正文里
        有任何标记文本。限预算时按优先级整块取舍，默认不限即 100% 保留。
        """
        found: list[tuple[int, int, str, str]] = []  # (priority, 首现序, kind, content)
        seen: set[str] = set()
        for order, m in enumerate(messages):
            block = stable_block_of(m)
            if not block:
                continue
            content = (self._content_of(m) or "").strip()
            if not content or content in seen:
                continue
            seen.add(content)
            found.append((block.priority, order, block.kind, content))
        if not found:
            return []
        # 优先级高的排前（同优先级保持首现顺序）：限预算时它们先占坑。
        found.sort(key=lambda item: (-item[0], item[1]))
        lines: list[str] = []
        budget = max(0, int(getattr(self, "protected_block_budget_tokens", 0) or 0))
        used = 0
        for priority, _order, kind, content in found:
            cost = self.estimate_tokens(content)
            if budget and used + cost > budget:
                continue
            used += cost
            lines.append(f"（{kind}，优先级 {priority}）\n{content}")
        return lines

    @staticmethod
    def _find_turn_boundaries(messages: list) -> list[int]:
        """找到所有 turn 的起始 index。

        一个 turn 定义为：从一条 user 消息开始，到下一条 user 消息之前（不含）。
        折叠只允许在 turn 边界切割，避免把 tool_use/tool_result 配对断裂。
        """
        boundaries = []
        for i, m in enumerate(messages):
            if (m.get("role") == "user" and
                    m.get("msg_type", "") not in ("tool_result", "tool_use")):
                boundaries.append(i)
        return boundaries

    def _split_for_fold(self, messages: list) -> tuple[list, list]:
        """把 messages 分成 [可折叠前段, 保留尾部] 两段。

        保留尾部 = 最近 tail_turns 个 user turn 及其之后的所有消息。
        切割永远落在 turn 边界上，保证同一 turn 内 tool_use/tool_result 不被分开。
        白名单消息如果在前段里，会被提取出来追加在摘要之后。
        """
        boundaries = self._find_turn_boundaries(messages)
        if len(boundaries) <= self.tail_turns:
            # 太短了，整个都是"尾部"，不拆
            return [], messages
        cut = boundaries[-self.tail_turns]
        return messages[:cut], messages[cut:]

    async def fold(self, session_id: str, messages: list, manual: bool = False) -> Result:
        """执行一次折叠。三层降级：LLM → 启发式 → 硬截断。

        改进：
        - 折叠边界只落在 turn 之间，不会切断 tool_use/tool_result 配对
        - 白名单消息（图片/tool_result/cancelled_op）被保留在摘要之后
        - 图片引用抽成占位行拼进摘要正文，摘要器丢不掉（见 ``_preserved_artifacts``）
        """
        if not messages:
            return Result.failure("没有可折叠的内容")

        self._folding = True
        try:
            tokens_before = self.total_tokens(messages)

            # 折叠是有损的，但有些东西「损了就没了」。必须在任何变形之前抽取：
            # replace_oversized / _microfold 会就地改写 messages，抽取晚一步就
            # 可能抽到已经被换成占位备注的正文。
            preserved = self._preserved_artifacts(messages)
            # 受保护区块（P0-3）同理：在 replace_oversized / _microfold 动手
            # 之前收集，之后由代码原样拼进摘要。
            protected = self._protected_block_lines(messages)

            # ── Pre-compaction Memory Flush ──
            # 必须在生成摘要**之前**跑：摘要一旦替换原文，正文里的决策/偏好就
            # 只剩摘要里那几句概括，抽不出可检索的结构化记忆了。先沉淀再压缩，
            # 折叠才从"净损失"变成"换个地方存"。
            flushed = 0
            do_flush, flush_reason = self.should_flush_memory(messages)
            if do_flush:
                flushed = await self.flush_memory(messages)

            # 自适应折叠比 —— 决定这次要吃掉多少历史。虽然当前 summariser
            # 是把整段丢过去，比例更多是给报告和后续 chunk 切分逻辑用的信号，
            # 但记录进 report 让 UI 能显示"这次折叠强度"。
            chunk_ratio = self.compute_adaptive_chunk_ratio(messages)

            # 超大消息直接换成占位备注 —— 摘要器读它本身就要花掉半个窗口。
            oversized = self.replace_oversized(messages)

            # 先跑微折叠（清老工具结果），可能就够了 —— 但它只改内存里的副本，
            # 真正的摘要仍照常生成，两者叠加。
            self._microfold(messages)

            strategy = "engineering"
            summary: Optional[str] = None

            # ── reserve-token 地板 ──
            # 折叠是"必须兑现空闲"的承诺，不是"碰过阈值就算"。每层策略产出
            # 候选摘要后，用「摘要 + 保留尾部」的占用量判定空闲是否 >= 地板；
            # 不满足就升级下一层（LLM 摘要 → 启发式 → 硬截断，截断层内 keep
            # 逐级收缩）。摘要估算不含 preserved 拼接与折痕行，判定偏保守。
            floor = max(0, int(self.reserve_tokens_floor))

            def _meets_floor(candidate: str) -> bool:
                footprint = self.estimate_tokens(candidate) + self._tail_tokens(messages)
                return self.usable_tokens - footprint >= floor

            # 第 1 层：LLM 摘要（带质量审计 + 重试）
            MAX_AUDIT_RETRIES = 2
            if self._summarizer is not None:
                for attempt in range(1 + MAX_AUDIT_RETRIES):
                    try:
                        # 单次调用有硬上限：一个挂死不报错的连接会无限拖住
                        # 折叠（进而拖住整个回合）。超时按"模型失败"处理——
                        # 立即掉启发式，不重试（重试只会把最坏路径拉长三倍）。
                        synth = await asyncio.wait_for(
                            self._summarizer(messages), timeout=FOLD_SUMMARY_TIMEOUT_S)
                        if synth:
                            candidate = self._render_llm_summary(synth, messages)
                            ok, diag = self.audit_summary_quality(candidate, messages)
                            if ok or attempt == MAX_AUDIT_RETRIES:
                                summary = candidate
                                strategy = "llm-summary"
                                break
                            # 审计失败，重试 — 下一次调用时模型的随机性可能保留更多标识符
                            continue
                    except asyncio.TimeoutError:
                        break  # 超时不重试：掉启发式（零成本、即时）
                    except Exception:
                        # 静默吞异常曾是 P0 事故的放大器：_render_llm_summary 的
                        # NameError 在这里无痕消失，LLM 层永久降级无人知晓。
                        # 任何掉层都必须留痕。
                        log.exception("[compactor] LLM summary layer failed, degrading to heuristic")
                        break  # 掉到启发式

            # 地板未达 → 升级下一层。floor_enforced 记录"是否因地板触发过升级"，
            # 落进折叠报告，UI 与审计能区分"自然降级"和"地板强压"。
            floor_enforced = False
            if summary is not None and not _meets_floor(summary):
                summary = None
                floor_enforced = True

            # 第 2 层：启发式
            if not summary:
                try:
                    summary = self._heuristic_summary(messages)
                    strategy = "engineering"
                    if not _meets_floor(summary):
                        floor_enforced = True
                except Exception:
                    summary = None  # 掉到硬截断

            # 第 3 层：硬截断兜底 —— keep 逐级收缩，尽量把空闲顶到地板之上；
            # 到 keep=1 仍不达标就只能接受（没有更狠的层了），如实上报。
            if not summary or not _meets_floor(summary):
                for keep in (5, 3, 1):
                    candidate = self._truncate_summary(messages, keep=keep)
                    summary = candidate
                    strategy = "truncate"
                    if _meets_floor(candidate):
                        break
                if not _meets_floor(summary):
                    floor_enforced = True

            # 占位行原样拼进摘要正文——三层降级里任何一层产出的摘要都要过这一步。
            # 摘要（作为 system 行回放）是折痕之后 `_build_history` 唯一还会回放的
            # 东西：把附件引用留在别处（独立的行、metadata）等于丢掉，因为回放只
            # 认 user/assistant 正文加这份摘要。
            # 受保护区块（P0-3）放同一个位置：权限规则/安全策略/任务约束的原文
            # 必须由代码拼进摘要，一次摘要模型调用都不经过。
            if protected:
                summary = (
                    f"{summary}\n\n{PROTECTED_BLOCK_SECTION_TITLE}\n" + "\n".join(protected)
                )
            if preserved:
                summary = (
                    f"{summary}\n\n{PRESERVED_SECTION_TITLE}\n" + "\n".join(preserved)
                )

            estimated_after = self.estimate_tokens(summary)
            # 地板口径与升级决策一致："折叠后占用" = 摘要 + 保留尾部（尾部
            # 按 microfold 改写后的现状计）。报告若只算摘要，会出现"刚因
            # 地板不达标而升级，报告却说达标"的自相矛盾。
            footprint_after = estimated_after + self._tail_tokens(messages)

            sealed, encrypted = self._seal(summary)
            storage = get_storage()
            try:
                storage.add_compaction(session_id, sealed, tokens_before, estimated_after)
            except Exception:
                pass  # 落盘失败不该让折叠整体失败 —— 摘要还能返回给本轮用

            # ── 更新防循环状态 ──
            self._last_fold_at = time.time()
            self._consecutive += 1
            self._folded_upto = len(messages)
            self._total_folds += 1
            self._total_tokens_saved += max(0, tokens_before - estimated_after)

            report = {
                "summary": summary,
                "strategy": strategy,
                "tokensBefore": tokens_before,
                "estimatedTokensAfter": estimated_after,
                "compressionRatio": round(tokens_before / max(estimated_after, 1), 2),
                "encrypted": encrypted,
                "manual": manual,
                "memoryFlushed": flushed,
                "chunkRatio": chunk_ratio,
                "oversizedReplaced": oversized,
                "preservedArtifacts": len(preserved),
                "protectedBlocks": len(protected),
                # 地板审计：这次折叠是自然降级还是被地板强压过、折叠后空闲
                # 还剩多少。压缩决策可复盘 —— 这是 Ovolve 与"折叠完就忘"的
                # 实现的分界线。
                "reserveFloor": floor,
                "freeTokensAfter": max(0, self.usable_tokens - footprint_after),
                "floorMet": self.usable_tokens - footprint_after >= floor,
                "floorEnforced": floor_enforced,
            }

            # Announce it so the WS bridge can show a fold card in the timeline.
            # An auto-fold is otherwise invisible, which reads as "the agent
            # silently forgot things". Tag the frame with the owning session so
            # the fold card lands in the right window when several are open.
            if self._bus is not None:
                try:
                    frame = dict(report)
                    frame.setdefault("session_id", getattr(self, "session_id", None))
                    await self._bus.emit("context_folded", frame)
                except Exception:
                    pass  # fail-open: 可选增强，失败不影响主流程

            # 折叠后记忆预热：用当前目标作 query 触发一次 memory prefetch，
            # 让下一轮上下文既有摘要骨架又有相关记忆血肉。fire-and-forget，
            # 失败不影响折叠本身。
            if self._post_fold_warmup is not None:
                try:
                    query = self._extract_current_goal(messages) or ""
                    if query:
                        await self._post_fold_warmup(self.session_id, query)
                except Exception:
                    pass  # fail-open: 可选增强，失败不影响主流程

            return Result.success(report)
        finally:
            self._folding = False

    def note_new_turn(self) -> None:
        """一个非折叠产生的普通轮次结束时调用 —— 重置"连续折叠"计数。

        连续上限防的是"折叠→折叠→折叠"的死循环；只要中间夹了一次真实对话，
        就说明模型在正常推进，计数应清零。
        """
        self._consecutive = 0

    # ── 自适应折叠比 + 摘要质量审计 ────────────────────────────────────────

    #: 折叠比下限/上限。比例 = 这次折叠打算吃掉多少比例的历史。
    #: 下限 0.15：消息又多又碎（聊天流）时小口吃，避免一次摘要吞掉太多细节。
    #: 上限 0.40：消息又少又大（贴了整个文件）时大口吃，否则折一次省不下东西。
    CHUNK_RATIO_MIN = 0.15
    CHUNK_RATIO_MAX = 0.40

    #: 单条消息超过可用窗口的这个比例，就直接换成占位备注而不进摘要。
    #: 理由：一条占了半个窗口的消息，摘要器读它本身就要花掉半个窗口，
    #: 而它通常是"贴进来的一大坨文件/日志"——占位符 + 路径就够模型知道去哪找。
    OVERSIZED_MESSAGE_RATIO = 0.50

    OVERSIZED_PLACEHOLDER = (
        "[超大内容已折叠为备注 — 原文约 {tokens} tokens，"
        "如仍需要请重新读取来源]"
    )

    def compute_adaptive_chunk_ratio(self, messages: list) -> float:
        """依据消息的平均 token 占比动态决定这次吃掉多少历史。

        直觉：**平均单条消息越大，就该吃掉越大的比例**。

        - 100 条小消息（每条占窗口 0.5%）→ 比例压到 0.15，细水长流
        - 5 条大消息（每条占窗口 10%）→ 比例拉到 0.40，一次到位

        固定比例在这两种形态上都会错：对碎聊天太激进（丢细节），对大贴文
        太保守（折了半天没省下 token，下一轮又触发，进入折叠抖动）。
        """
        if not messages:
            return self.CHUNK_RATIO_MIN
        total = self.total_tokens(messages)
        if total <= 0:
            return self.CHUNK_RATIO_MIN
        avg_share = (total / len(messages)) / self.usable_tokens
        # avg_share 0.005 → MIN，0.10 → MAX，中间线性插值。
        lo, hi = 0.005, 0.10
        t = (avg_share - lo) / (hi - lo)
        t = max(0.0, min(1.0, t))
        ratio = self.CHUNK_RATIO_MIN + t * (self.CHUNK_RATIO_MAX - self.CHUNK_RATIO_MIN)
        return round(ratio, 3)

    def replace_oversized(self, messages: list) -> int:
        """就地把超大消息换成占位备注，返回替换条数。

        只动 dict（内存副本）；白名单消息（图片/tool_result 配对）跳过——
        它们不可替换，宁可让这一轮少省点 token。
        """
        limit = int(self.usable_tokens * self.OVERSIZED_MESSAGE_RATIO)
        replaced = 0
        for m in messages:
            if not isinstance(m, dict):
                continue
            if self._is_whitelisted(m):
                continue
            content = m.get("content")
            if not isinstance(content, str) or not content:
                continue
            cost = self.estimate_tokens(content)
            if cost < limit:
                continue
            m["content"] = self.OVERSIZED_PLACEHOLDER.format(tokens=cost)
            replaced += 1
        return replaced

    #: 摘要里必须保留的标识符形态——摘要器最容易丢的恰好就是这些：
    #: 文件路径、函数/类名、错误码、数字版本号。丢了它们的摘要读起来通顺，
    #: 但模型再也找不回"当时在改哪个文件的哪个函数"。
    _IDENT_PATTERNS = (
        r"[A-Za-z0-9_\-/\\.]+\.(?:py|ts|tsx|js|jsx|md|json|yml|yaml|toml|css|html)",
        r"\b[A-Za-z_][A-Za-z0-9_]{2,}\s*\(",       # 函数调用
        r"\b(?:class|def|function)\s+[A-Za-z_]\w*",  # 定义
        r"\b[A-Z][A-Z0-9_]{3,}\b",                  # 常量/错误码
    )

    def _key_identifiers(self, text: str, cap: int = 40) -> set[str]:
        """从文本里抽出关键标识符集合。"""
        import re
        found: set[str] = set()
        for pat in self._IDENT_PATTERNS:
            for m in re.finditer(pat, text):
                found.add(m.group(0).strip().rstrip("("))
                if len(found) >= cap:
                    return found
        return found

    def audit_summary_quality(
        self, summary: str, messages: list, min_retention: float = 0.30
    ) -> tuple[bool, dict]:
        """检查摘要有没有把关键标识符丢掉。

        判定：原文里出现 **3 次以上** 的标识符视为"重要"，这些重要标识符
        至少要有 ``min_retention`` 比例出现在摘要里。

        为什么用出现次数过滤：只出现一次的路径可能是随口一提，强求摘要保留
        它会让审计永远失败；反复出现的才是这段对话真正在围绕的东西。

        为什么阈值只要 0.30：摘要本来就该压缩，要求过高等于要求它别压。
        0.30 抓的是"整段标识符全丢"这种真故障，不是"少提了两个文件名"。

        Returns:
            ``(通过与否, 诊断信息)``。诊断给日志/前端解释为什么重试。
        """
        if not summary:
            return False, {"reason": "empty-summary"}
        source = "\n".join(self._content_of(m) for m in messages)
        if not source:
            return True, {"reason": "no-source"}

        from collections import Counter
        import re
        counts: Counter[str] = Counter()
        for pat in self._IDENT_PATTERNS:
            for m in re.finditer(pat, source):
                counts[m.group(0).strip().rstrip("(")] += 1
        important = {k for k, n in counts.items() if n >= 3}
        if not important:
            return True, {"reason": "no-important-identifiers"}

        kept = {k for k in important if k in summary}
        retention = len(kept) / len(important)
        diag = {
            "reason": "retention",
            "importantCount": len(important),
            "keptCount": len(kept),
            "retention": round(retention, 3),
            "threshold": min_retention,
            "lost": sorted(important - kept)[:10],
        }
        return retention >= min_retention, diag

    # ── 三层实现 ────────────────────────────────────────────────────────────

    def _render_llm_summary(self, synth: dict, messages: list) -> str:
        """把 synthesize_session 的四段结构渲染成折痕正文。

        messages: 当前回合消息列表，用于抽取当前目标与关键决策锚点。
        此前缺失该参数导致 927/935 行 NameError，被调用方 except 静默吞掉，
        LLM 摘要层永久降级到启发式（且每次折叠白付一次 LLM 费用）。
        """
        def sec(title: str, key: str) -> str:
            val = synth.get(key)
            if not val:
                return ""
            if isinstance(val, list):
                body = "\n".join(f"- {x}" for x in val)
            else:
                body = str(val)
            return f"### {title}\n{body}\n\n"

        parts = ["## 折痕 · 对话摘要（此前内容已折叠）\n"]
        parts.append(sec("目标", "Goal"))
        # 当前轮次目标锚定：即使摘要只写"正在做 X"，模型也需要知道"X 具体是什么"。
        # 从最近一轮用户消息取原文前 120 字，不经过 LLM，确定性拼进摘要。
        current_goal = self._extract_current_goal(messages)
        if current_goal:
            parts.append(f"### 当前目标\n{current_goal}\n\n")
        parts.append(sec("进展", "Progress"))
        parts.append(sec("关键决策", "Decisions"))
        parts.append(sec("待办 / 悬而未决", "Open Issues"))
        # 关键决策锚点：用户明确要求 / 模型确认过的决策句，代码级提取，
        # 不经过 LLM，即使摘要层降级到启发式/硬截断也保留。
        key_decisions = self._extract_key_decisions(messages)
        if key_decisions:
            parts.append("### 关键决策（锚点）\n")
            parts.extend(f"- {d}\n" for d in key_decisions[:5])
            parts.append("\n")
        if self._modified_files:
            parts.append(f"### 改动过的文件\n{', '.join(list(self._modified_files)[-20:])}\n")
        return "".join(p for p in parts if p).strip()

    def _heuristic_summary(self, messages: list) -> str:
        """规则驱动的结构化摘要（无模型时的主力）。"""
        parts = ["## 折痕 · 对话摘要（启发式）\n"]

        user_msgs = [m for m in messages if self._field(m, "role") == "user"]
        if user_msgs:
            parts.append("### 用户诉求")
            for m in user_msgs[-5:]:
                parts.append(f"- {self._content_of(m)[:200]}")
            parts.append("")

        # 当前目标锚定（同 LLM 层）
        current_goal = self._extract_current_goal(messages)
        if current_goal:
            parts.append(f"### 当前目标\n{current_goal}\n")

        # 关键决策锚点（同 LLM 层）
        key_decisions = self._extract_key_decisions(messages)
        if key_decisions:
            parts.append("### 关键决策（锚点）\n")
            parts.extend(f"- {d}\n" for d in key_decisions[:5])
            parts.append("\n")

        asst = [m for m in messages if self._field(m, "role") == "assistant"]
        if asst:
            parts.append("### 关键回复")
            for m in asst[-3:]:
                parts.append(f"- {self._content_of(m)[:300]}")
            parts.append("")

        tools = [m for m in messages if self._field(m, "msg_type") == "tool_call"]
        if tools:
            parts.append("### 工具调用")
            for m in tools[-10:]:
                parts.append(f"- {self._content_of(m)[:100]}")
            parts.append("")

        if self._read_files:
            parts.append(f"### 读过的文件\n{', '.join(list(self._read_files)[-20:])}")
        if self._modified_files:
            parts.append(f"### 改动过的文件\n{', '.join(list(self._modified_files)[-20:])}")

        return "\n".join(parts).strip()

    def _tail_tokens(self, messages: list) -> int:
        """估算折叠后仍会**原文保留**的尾部占用量。

        折叠替换的是历史前缀，最近 ``tail_turns`` 个用户轮（及它们的回复）
        原样保留。地板判定必须把这个尾巴算进"折叠后占用"，否则判定系统性
        偏乐观 —— 摘要再短，一条没折的 1 万 token 尾巴也能把空闲吃穿。
        """
        if not messages:
            return 0
        user_idx = [
            i for i, m in enumerate(messages)
            if self._field(m, "role") == "user"
        ]
        if not user_idx:
            return 0
        cut = user_idx[-self.tail_turns] if len(user_idx) >= self.tail_turns else user_idx[0]
        return self.estimate_tokens_multi(messages[cut:])

    def _truncate_summary(self, messages: list, keep: int = 5) -> str:
        """最后兜底：连启发式都炸了，只把最近几轮原样拼起来。"""
        tail = messages[-keep:]
        lines = ["## 折痕 · 仅保留最近对话（降级兜底）\n"]
        for m in tail:
            role = self._field(m, "role", "?")
            lines.append(f"**{role}**: {self._content_of(m)[:300]}")
        return "\n".join(lines).strip()

    def _microfold(self, messages: list) -> int:
        """就地清理保鲜窗口外的工具结果，返回清理条数。

        按 **token 预算** 从新到旧累加（对齐业界方案的 recency window 思路），
        预算用完之后的旧结果替换为占位符。比"只留最近 N 条"更合理：一条 3 万
        字符的文件读取和一条 20 字符的 grep 结果，占的地方差三个数量级。

        只动 dict（内存副本）；sqlite3.Row 只读，跳过。
        """
        budget = self.prune_window_tokens
        cleared = 0
        for m in reversed(messages):
            if not isinstance(m, dict):
                continue
            if stable_block_of(m):
                continue  # 受保护区块（P0-3）永不被微折叠清掉
            if m.get("msg_type") != "tool_call":
                continue
            name = (m.get("tool_name") or m.get("name") or "").lower()
            if name and name not in FOLDABLE_TOOLS:
                continue
            content = m.get("content") or ""
            if content == FOLD_PLACEHOLDER:
                continue
            cost = self.estimate_tokens(content)
            if budget - cost >= 0:
                budget -= cost  # 还在保鲜窗口内，留着
                continue
            m["content"] = FOLD_PLACEHOLDER
            cleared += 1
        return cleared

    #: 关键决策锚点的正则模式——匹配"用户明确要求/模型确认过"的句式。
    #: 这些句子一旦被摘要器丢掉，模型会"忘记"自己曾经答应过什么。
    _DECISION_PATTERNS = (
        r"(?:我|用户)决定[：:]\s*(.+)",
        r"(?:我|用户)选择[：:]\s*(.+)",
        r"(?:我|用户)要求[：:]\s*(.+)",
        r"(?:我|用户)确认[：:]\s*(.+)",
        r"(?:我|用户)说[：:]\s*(.+)",
        r"已确认[：:]\s*(.+)",
        r"已决定[：:]\s*(.+)",
        r"已选择[：:]\s*(.+)",
        r"已修复[：:]\s*(.+)",
        r"已应用[：:]\s*(.+)",
        r"已修改[：:]\s*(.+)",
        r"已创建[：:]\s*(.+)",
        r"已删除[：:]\s*(.+)",
        r"已更新[：:]\s*(.+)",
        r"已重构[：:]\s*(.+)",
        r"已实现[：:]\s*(.+)",
        r"将采用[：:]\s*(.+)",
        r"采用[：:]\s*(.+)",
    )

    def _extract_current_goal(self, messages: list) -> str:
        """从最近一轮用户消息提取当前目标（确定性，不经过 LLM）。"""
        # 找最近的非 tool_result 用户消息
        user_msgs = [m for m in reversed(messages)
                     if m.get("role") == "user"
                     and m.get("msg_type", "") not in ("tool_result", "tool_use")]
        if not user_msgs:
            return ""
        last = self._content_of(user_msgs[0])
        goal = last.strip()[:120]
        return goal

    def _extract_key_decisions(self, messages: list, cap: int = 5) -> list[str]:
        """从对话中提取关键决策作为确定性锚点（不经过 LLM）。"""
        import re
        decisions = []
        seen: set[str] = set()
        for m in messages:
            content = self._content_of(m)
            if not content or len(content) < 5:
                continue
            for pat in self._DECISION_PATTERNS:
                for match in re.finditer(pat, content):
                    decision = match.group(1).strip()[:120]
                    if decision and decision not in seen:
                        seen.add(decision)
                        decisions.append(decision)
                        if len(decisions) >= cap:
                            return decisions
        return decisions

    # ── 加密钩子 ─────────────────────────────────────────────────────────────

    def _get_cipher(self):
        """惰性取 CredentialCipher 单例语义的实例；库缺失返回 None（fail-open）。

        复用 model_registry 的凭据加密器而不是另起一套：密钥派生（PBKDF2，
        机器指纹兜底）、`enc:`/`plain:` 前缀语义、对历史明文的原样放行都在
        那里已经是审计过的实现，摘要加密没有理由长出第二种密钥体系。
        """
        if self._cipher is not None:
            return self._cipher
        try:
            from model_registry import CredentialCipher
            self._cipher = CredentialCipher()
        except Exception as exc:  # noqa: BLE001
            if not self._cipher_warned:
                self._cipher_warned = True
                print(f"[compactor] encryption requested but cipher unavailable: {exc}")
            return None
        return self._cipher

    def _seal(self, plaintext: str) -> tuple[str, bool]:
        """落盘前封装。返回 ``(入库文本, 是否已加密)``。

        关闭时逐字节直通（与历史行为一致）；开启但加密库缺失时也直通——
        折叠是主流程，加密是增强，增强挂了不能拖垮折叠，但会留一条日志。
        空摘要加密前后同形，此时如实报 False。
        """
        if not self.encryption_enabled:
            return plaintext, False
        cipher = self._get_cipher()
        if cipher is None:
            return plaintext, False
        sealed = cipher.encrypt(plaintext)
        return sealed, bool(sealed) and sealed != plaintext

    def _unseal(self, stored: str) -> str:
        """读盘后解封。对历史明文行原样放行（CredentialCipher 的无前缀语义）。"""
        if not self.encryption_enabled:
            return stored
        cipher = self._get_cipher()
        if cipher is None:
            return stored
        return cipher.decrypt(stored)

    # ── 文件追踪 & 统计 ─────────────────────────────────────────────────────

    def track_read_file(self, path: str):
        self._read_files.add(path)

    def track_modified_file(self, path: str):
        self._modified_files.add(path)

    def get_file_stats(self) -> dict:
        return {
            "readFiles": list(self._read_files),
            "modifiedFiles": list(self._modified_files),
        }

    def stats(self) -> dict:
        return {
            "totalFolds": self._total_folds,
            "totalTokensSaved": self._total_tokens_saved,
            "lastFoldAt": self._last_fold_at,
            "consecutive": self._consecutive,
        }

    # ── 回合内 overflow 预检 ────────────────────────────────────────────────

    #: 回合内预检的触发线。比 ``threshold``(0.80) 高、比紧急线低：回合内我们
    #: 只在"下一次模型调用很可能塞不下"的时候才动手，因为动手是有损的。
    inline_precheck_ratio: float = 0.85

    #: 被剪的工具结果保留多少字符（头尾各一半）。留得住报错行和调用行就够了。
    inline_trim_chars: int = 600

    #: 最近这几条工具结果不剪 —— 模型正在用它们做当前决策。
    inline_keep_recent: int = 3

    def precheck_inline(self, messages: list, overhead_tokens: int = 0) -> dict:
        """模型调用前预检：把超额的旧工具结果就地剪掉，剪不动就如实上报。

        为什么需要它：``should_fold`` 只在**用户回合开始时**跑一次，算的是
        已落库的历史。但一个回合里可以有 8 步工具调用，任何一步读到一个大
        文件、跑出一屏日志，都能把这一轮的临时 ``messages`` 顶过窗口——此时
        折叠机制根本没有机会介入，模型调用直接 400 context-exceeded，用户
        看到的是一个他没法绕开的错误。

        ``overhead_tokens`` 是本次请求里**不在 messages 里**的那部分：系统
        提示 + 工具定义 JSON。这两块加起来常有一两万 token，而它们既不参与
        ``should_fold``（那只看落库历史），过去也不参与本函数——于是"预检说
        没超"和"provider 说超了"可以同时成立。第 0 步尤其致命：那时没有工具
        结果可剪，本函数过去被 ``step > 0`` 直接跳过，等于第 0 步完全没有
        溢出保护。现在第 0 步也跑，剪不动就把 ``fits=False`` 报出去，让调用
        方在发请求**之前**决定降级还是提示。

        为什么剪而不是摘要：回合中间插一次 LLM 摘要要多花一次往返、还可能
        自己就失败，把一个"能救"的局面变成两个失败。剪旧工具结果是确定性
        的、瞬时的，而且剪掉的是**已经被模型读过并据此发起了下一步**的内容，
        信息价值最低。

        只改传入的这一份临时列表，不动已落库的原文——所以这个操作对会话历史
        是无损的，用户回看时看到的仍是完整输出。

        Returns:
            ``{"pruned", "before", "after", "overhead", "ceiling", "fits", "reason"}``
            —— ``before``/``after`` 已含 ``overhead``，即"这次请求的总量"；
            ``fits`` 为 False 表示预检结束后**仍然**超线。
        """
        overhead = max(0, int(overhead_tokens or 0))
        ceiling = int(self.usable_tokens * self.inline_precheck_ratio)
        report = {
            "pruned": 0, "before": overhead, "after": overhead,
            "overhead": overhead, "ceiling": ceiling,
            "fits": True, "reason": "under-threshold",
        }
        if not messages:
            report["fits"] = overhead <= ceiling
            if not report["fits"]:
                # 系统提示 + 工具定义自己就超线。剪工具结果救不了这个。
                report["reason"] = "overhead-alone-exceeds"
            return report

        before = self.estimate_tokens_multi(messages) + overhead
        report["before"] = report["after"] = before
        if before <= ceiling:
            return report

        # 候选：role == "tool" 的旧结果，从最老往新剪，跳过最近 N 条。
        tool_idx = [i for i, m in enumerate(messages)
                    if self._field(m, "role") == "tool"]
        prunable = tool_idx[:-self.inline_keep_recent] if self.inline_keep_recent else tool_idx
        if not prunable:
            report["reason"] = "nothing-prunable"
            report["fits"] = False
            return report

        marker = "\n…[本轮上下文超额，此条工具输出已就地剪短；完整内容仍在会话记录里]…\n"
        half = max(1, self.inline_trim_chars // 2)
        current_total = before
        for i in prunable:
            msg = messages[i]
            if not isinstance(msg, dict):
                continue
            if stable_block_of(msg):
                continue  # 受保护区块（P0-3）不做就地剪短
            text = msg.get("content") or ""
            if len(text) <= self.inline_trim_chars:
                continue
            old_tok = self.estimate_tokens(text)
            new_text = text[:half] + marker + text[-half:]
            new_tok = self.estimate_tokens(new_text)
            msg["content"] = new_text
            report["pruned"] += 1
            current_total -= max(0, old_tok - new_tok)
            # 增量判断：够了就停，别过度剪。
            if current_total <= ceiling:
                break

        report["after"] = current_total
        report["fits"] = report["after"] <= ceiling
        report["reason"] = "inline-pruned" if report["pruned"] else "nothing-oversized"
        return report

    # ── 向后兼容别名（旧调用点仍可用）──────────────────────────────────────

    def should_compact(self, messages: list) -> bool:
        ok, _ = self.should_fold(messages, manual=False)
        return ok


_compactor: Optional[ContextCompactor] = None

#: What the settings page may tune, with the constructor defaults. Everything
#: else (reserved share, tail turns, prune window) stays internal: exposing
#: eleven knobs where three matter is how settings pages stop being read.
_TUNABLE_COMPACTION_KEYS = {
    "max_tokens": int,
    "threshold": float,
    "emergency_threshold": float,
    "cooldown_s": float,
    "max_consecutive": int,
    "reserve_tokens_floor": int,
}


def compaction_kwargs_from_config() -> dict:
    """Constructor kwargs for ContextCompactor from config.json's `compaction`.

    This is what the class docstring always promised ("阈值可配 —— 我们从
    config.json 读，不硬编码") while ``get_compactor`` constructed with pure
    defaults. Values are clamped by the caller-visible contract: thresholds
    stay in (0.5, 1.0] and emergency >= threshold, so a bad hand-edit cannot
    make folding never fire or fire on every turn.
    """
    kwargs: dict = {}
    try:
        import json
        import os
        cfg_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
        with open(cfg_path, "r", encoding="utf-8") as f:
            comp = json.load(f).get("compaction") or {}
        for key, cast in _TUNABLE_COMPACTION_KEYS.items():
            if comp.get(key) is None:
                continue
            try:
                kwargs[key] = cast(comp[key])
            except (TypeError, ValueError):
                continue
    except Exception:
        return {}
    th = float(kwargs.get("threshold", 0.80))
    em = float(kwargs.get("emergency_threshold", 0.90))
    th = min(0.95, max(0.50, th))
    em = min(0.98, max(th, em))
    kwargs["threshold"] = th
    kwargs["emergency_threshold"] = em
    mt = int(kwargs.get("max_tokens", 80_000))
    if "reserve_tokens_floor" in kwargs:
        # 地板不可能超过半个窗口 —— 否则折叠永远"不达标"，层数被白白拉满。
        kwargs["reserve_tokens_floor"] = min(
            max(0, int(kwargs["reserve_tokens_floor"])), mt // 2)
    # 加密是布尔开关，单独处理：非真值一律视为关，坏手写不会炸构造函数。
    try:
        kwargs["encryption_enabled"] = bool(comp.get("encryption_enabled"))
    except Exception:
        kwargs.pop("encryption_enabled", None)
    return kwargs


def get_compactor() -> ContextCompactor:
    global _compactor
    if _compactor is None:
        _compactor = ContextCompactor(**compaction_kwargs_from_config())
    return _compactor


def estimate_tokens_multi(messages: list) -> int:
    """Module-level multi-source token estimation convenience function."""
    return get_compactor().estimate_tokens_multi(messages)

