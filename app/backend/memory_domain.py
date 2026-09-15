"""统一的 Memory domain adapter —— 让"记忆"只有一种形状。

## 为什么需要这一层

长期知识现在存在两张表里，各有一套词汇：

- ``memory_entries``（episodic，storage.py）：五态状态机
  ``candidate/active/stale/rejected/archived``、置信度钳在 [0.05, 0.95]、
  有 tier / importance / valid_until / last_confirmed_at。
- ``wiki_claims``（declarative，wiki_store.py）：三态
  ``active/disputed/superseded``（本次补上墓碑 ``deleted``）、置信度 [0, 1]、
  没有 tier，也没有过期时间。

两张表在同一个 ``memory.db`` 里，但对外是两套 API、两套状态名、两套删除语义
（记忆的删除是归档、可恢复；断言的删除以前是 ``DELETE``，不可恢复）。结果就是
计划里点名要避免的两种分裂：

- **"UI 能看到但 Agent 召回不到"**：断言页面把 superseded 也列出来，而
  ``render_block`` 会跳过它；用户以为改了，模型根本没看见。
- **"Agent 能用但用户不能编辑"**：``PATCH /api/memory/entries/{id}`` 只认
  content/tier/importance/tags，0013 加的 status/confidence 没有任何入口，
  于是"状态"只能由自动流程写、用户看不见也改不了。

这个模块**不新建存储**。它是一层翻译：把两种行读成同一个 ``MemoryItem``，
把状态变更翻回各自的原生调用。Router 召回、设置页、Evolution、冲突视图、
删除和过期都应该走这里，而不是各自去猜对面那张表长什么样。

## 一个刻意的取舍

统一词汇取记忆那边的五态，因为它更细。断言表达不了 ``candidate`` 和
``rejected``——它没有"待批准"，也没有一个和"归档"区分开的"这是错的"。遇到这两
个状态，:meth:`MemoryDomain.set_status` **拒绝并说明原因**，而不是悄悄映射成
最接近的那个。理由：一次静默的近似会让下一次读回来的状态和写进去的不一样，
而"我明明标成 rejected，它显示归档"比"这个操作对断言不适用"糟得多。
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

log = logging.getLogger(__name__)


def _now() -> int:
    return int(time.time())


#: 两种知识的种类标签。``entry`` 是 episodic 记忆，``claim`` 是 wiki 断言。
KIND_ENTRY = "entry"
KIND_CLAIM = "claim"
KINDS = (KIND_ENTRY, KIND_CLAIM)

#: 统一状态词汇 —— 取 ``storage.MEMORY_STATUSES``，这里显式写一遍是为了让
#: 读这个文件的人不必跳到 storage.py 才知道有哪些状态。
STATUSES = ("candidate", "active", "stale", "rejected", "archived")

#: 只有这些状态能进 prompt。和 ``storage.RECALLABLE_MEMORY_STATUSES`` 一致
#: （空串是 0013 之前的老行）。
LIVE_STATUSES = ("active",)

#: 设置页默认列出的状态。刻意包含 ``stale``：0013 之后过期的记忆不再进 prompt，
#: 如果界面也看不到它，用户就既不知道它存在、也没法把它救回来——"UI 看不到但
#: 库里还在"和"UI 能看到但召回不到"是同一个病的两面。
#: 墓碑（``rejected`` / ``archived``）默认不列，要显式筛选才出现。
UI_DEFAULT_STATUSES = ("candidate", "active", "stale", "")


#: wiki 状态 → 统一状态。``disputed`` 映射成 ``active`` 是有意的：一条有冲突的
#: 断言仍然是活的，冲突通过 ``conflicts`` 字段单独表达，而不是挤进状态里。
_CLAIM_TO_UNIFIED = {
    "active": "active",
    "disputed": "active",
    "superseded": "stale",
    "deleted": "archived",
    "": "active",
}

#: 统一状态 → wiki 侧的写入意图。不在表里的状态断言表达不了，会被拒绝。
_UNIFIED_TO_CLAIM = {
    "active": "active",
    "stale": "superseded",
    "archived": "deleted",
}


@dataclass
class MemoryItem:
    """一条长期知识，不管它底下躺在哪张表里。

    字段取两边的并集。对某一种不适用的字段留在默认值上，并且由 ``kind`` 说明
    为什么——比如断言没有 ``tier``，不是"tier 是空的"，是"断言不分层"。
    """

    kind: str                       # entry | claim
    id: str
    root: str
    content: str                    # 记忆的 content / 断言的 statement
    status: str                     # 统一词汇
    confidence: float
    importance: float = 0.5         # 断言没有这个概念，固定 0.5
    tier: str = ""                  # 断言不分层
    type: str = "fact"              # 记忆的 type / 断言固定 "claim"
    tags: List[str] = field(default_factory=list)
    source: str = ""                # 记忆的 created_by / 断言的 source
    conflicts: List[str] = field(default_factory=list)   # 对手 id
    superseded_by: str = ""
    status_reason: str = ""
    valid_until: int = 0            # 断言没有过期时间，恒为 0
    last_confirmed_at: int = 0
    created_at: int = 0
    updated_at: int = 0
    hits: int = 0
    #: 结构化三元组，只有断言有。给冲突视图用。
    subject: str = ""
    predicate: str = ""
    object: str = ""
    #: 0014 的来源。断言那边对应 evidence，形状不同但意思一样：凭什么这么说。
    sensitivity: str = "public"
    source_goal_id: str = ""
    source_event_ids: List[str] = field(default_factory=list)
    valid_from: int = 0
    #: 0016：这条候选如果被批准，这几条会被归档。空 = 它不是一个待批合并。
    #: 和 ``superseded_by`` 是同一件事的两个时态——那个是已经发生的替换。
    supersedes: List[str] = field(default_factory=list)



    @property
    def live(self) -> bool:
        """这一条现在还会进 prompt 吗。

        惰性过期在这里也要算一遍：``valid_until`` 过了但还没被 sweep 落库的行，
        状态列上仍写着 ``active``，可读路径已经跳过它了。界面必须和召回口径一致，
        否则就会出现"UI 说生效中、模型看不见"。
        """
        if self.status not in LIVE_STATUSES:
            return False
        now = _now()
        if self.valid_until and self.valid_until <= now:
            return False
        # 还没开始生效的事实（"下个季度开始改用 pnpm"）不该被当成当前事实注入。
        if self.valid_from and self.valid_from > now:
            return False
        return True


    @property
    def editable(self) -> bool:
        """用户能不能改内容。WORKING 层每轮清空，给编辑框等于骗人。"""
        return self.tier != "working"

    def to_api(self) -> Dict[str, Any]:
        """给 HTTP / UI 用的 camelCase 形状。

        这里同时给出 ``status`` 和 ``live``：前者是库里写着什么，后者是召回时
        实际算出来的结论。两个都露出来，界面才能显示"标着生效中，但已过期"
        这种状态——只给一个，用户就得靠猜。
        """
        return {
            "kind": self.kind,
            "id": self.id,
            "root": self.root,
            "content": self.content,
            "status": self.status,
            "live": self.live,
            "confidence": round(float(self.confidence), 4),
            "importance": round(float(self.importance), 4),
            "tier": self.tier,
            "type": self.type,
            "tags": list(self.tags),
            "source": self.source,
            "conflicts": list(self.conflicts),
            "supersededBy": self.superseded_by,
            "statusReason": self.status_reason,
            "validUntil": int(self.valid_until),
            "lastConfirmedAt": int(self.last_confirmed_at),
            "createdAt": int(self.created_at),
            "updatedAt": int(self.updated_at),
            "hits": int(self.hits),
            "editable": self.editable,
            "subject": self.subject,
            "predicate": self.predicate,
            "object": self.object,
            "sensitivity": self.sensitivity,
            "sourceGoalId": self.source_goal_id,
            "sourceEventIds": list(self.source_event_ids),
            "validFrom": int(self.valid_from),
            "supersedes": list(self.supersedes),
        }




def _as_float(v: Any, default: float) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f


def _as_tags(v: Any) -> List[str]:
    """tags 列存的是 JSON 数组的字符串，但历史行里也见过裸字符串和 NULL。"""
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    if not v:
        return []
    try:
        parsed = json.loads(v)
    except (ValueError, TypeError):
        return [str(v)]
    return [str(x) for x in parsed] if isinstance(parsed, list) else []


def item_from_entry(row: Dict[str, Any]) -> MemoryItem:
    """``memory_entries`` 的一行 → ``MemoryItem``。

    ``status`` 为空是 0013 之前的老行；迁移已经翻译过一遍，这里按 ``archived``
    列兜底，因为可能有别的连接在迁移之前就读出了行。
    """
    r = dict(row or {})
    status = str(r.get("status") or "")
    if not status:
        status = "archived" if int(r.get("archived") or 0) else "active"
    return MemoryItem(
        kind=KIND_ENTRY,
        id=str(r.get("id") or ""),
        root=str(r.get("root_dir") or ""),
        content=str(r.get("content") or ""),
        status=status,
        confidence=_as_float(r.get("confidence"), 0.5),
        importance=_as_float(r.get("importance"), 0.5),
        tier=str(r.get("tier") or ""),
        type=str(r.get("type") or "fact"),
        tags=_as_tags(r.get("tags")),
        source=str(r.get("created_by") or ""),
        superseded_by=str(r.get("superseded_by") or ""),
        status_reason=str(r.get("status_reason") or ""),
        valid_until=int(r.get("valid_until") or 0),
        last_confirmed_at=int(r.get("last_confirmed_at") or 0),
        created_at=int(r.get("created_at") or 0),
        updated_at=int(r.get("updated_at") or 0),
        hits=int(r.get("hits") or 0),
        sensitivity=str(r.get("sensitivity") or "public"),
        source_goal_id=str(r.get("source_goal_id") or ""),
        source_event_ids=_as_tags(r.get("source_event_ids")),
        valid_from=int(r.get("valid_from") or 0),
        conflicts=_as_tags(r.get("conflict_set")),
        supersedes=_as_tags(r.get("supersedes")),
    )





def item_from_claim(claim: Any) -> MemoryItem:
    """``WikiClaim`` → ``MemoryItem``。

    断言没有 tier / importance / valid_until，留在默认值上；``conflicts`` 是它
    与记忆最不一样的地方，也是唯一由结构（而不是文本）算出来的东西。
    """
    return MemoryItem(
        kind=KIND_CLAIM,
        id=str(getattr(claim, "id", "") or ""),
        root=str(getattr(claim, "root_dir", "") or ""),
        content=str(getattr(claim, "statement", "") or ""),
        status=_CLAIM_TO_UNIFIED.get(str(getattr(claim, "status", "") or ""), "active"),
        confidence=_as_float(getattr(claim, "confidence", None), 0.5),
        type="claim",
        source=str(getattr(claim, "source", "") or ""),
        conflicts=[str(x) for x in (getattr(claim, "contradicts", None) or [])],
        status_reason=str(getattr(claim, "status_reason", "") or ""),
        created_at=int(getattr(claim, "created_at", 0) or 0),
        updated_at=int(getattr(claim, "updated_at", 0) or 0),
        subject=str(getattr(claim, "subject", "") or ""),
        predicate=str(getattr(claim, "predicate", "") or ""),
        object=str(getattr(claim, "object", "") or ""),
        # 断言的 evidence 就是它的来源事件/记忆 id，名字不同意思相同。
        source_event_ids=[str(x) for x in (getattr(claim, "evidence", None) or [])],
    )



class MemoryDomain:
    """两张表之上的唯一入口。

    自己不建表、不写 SQL——所有写入都翻译成 ``storage`` / ``WikiStore`` 上已有的
    调用。这样"状态机在哪里校验"仍然只有一个答案（在库那一层），这一层只负责
    翻译词汇和路由，不会变成第二个规则来源。
    """

    def __init__(self, storage: Any = None, wiki: Any = None):
        self._storage = storage
        self._wiki = wiki

    # ── 依赖懒加载 ──────────────────────────────────────────────────────
    @property
    def storage(self) -> Any:
        if self._storage is None:
            from storage import get_storage
            self._storage = get_storage()
        return self._storage

    @property
    def wiki(self) -> Any:
        """复用 ``MemoryLayer`` 持有的那一个 ``WikiStore``。

        为什么不自己 new 一个：``WikiStore.__init__`` 会跑 DDL，而 ``memory.db``
        的连接是按线程缓存的；多开一个实例不会出错但会让"谁改了 schema"变成两个
        答案。拿不到 MemoryLayer（比如脚本里直接用）时才退回自己构造。
        """
        if self._wiki is None:
            try:
                from memory_layer import get_memory_layer
                self._wiki = get_memory_layer().wiki
            except Exception:
                from wiki_store import WikiStore
                self._wiki = WikiStore(self.storage)
        return self._wiki

    # ── 读 ──────────────────────────────────────────────────────────────
    def list_items(
        self,
        root: str,
        *,
        kinds: Sequence[str] = KINDS,
        statuses: Optional[Sequence[str]] = None,
        live_only: bool = False,
        query: str = "",
        limit: int = 100,
        offset: int = 0,
    ) -> Tuple[List[MemoryItem], int]:
        """一个 workspace 下的长期知识，两张表合成一个列表。

        返回 ``(这一页, 总数)``。总数是过滤之后、分页之前的数字——界面上的"共 N
        条"必须和筛选条件对得上，否则用户翻到第二页会看到空白。

        默认 ``statuses=None`` 表示"全部状态"（包括归档），因为设置页要能把误收
        的记忆找回来。召回路径应该传 ``live_only=True``，它算的是和
        ``_memory_live_sql`` 同一个口径（状态 + 惰性过期）。
        """
        want_kinds = tuple(k for k in kinds if k in KINDS) or KINDS
        items: List[MemoryItem] = []

        if KIND_ENTRY in want_kinds:
            # include_archived=True 之后在 Python 里按 statuses 过滤：这一层要能
            # 表达"只看 stale"，而 storage 只有 archived 的二元开关。
            rows = self.storage.get_memory_entries(
                root=root, include_archived=True, limit=None,
            ) or []
            items.extend(item_from_entry(r) for r in rows)

        if KIND_CLAIM in want_kinds:
            claims = self.wiki.list_claims(root, limit=100000, include_deleted=True) or []
            items.extend(item_from_claim(c) for c in claims)

        if statuses:
            allow = {str(s) for s in statuses}
            items = [it for it in items if it.status in allow]
        if live_only:
            items = [it for it in items if it.live]
        if query:
            needle = str(query).strip().casefold()
            if needle:
                candidates = [it for it in items
                              if needle in it.content.casefold()
                              or needle in (it.subject or "").casefold()]
                items = self.rank_and_deduplicate(needle, candidates, limit=len(candidates))
        else:
            # 统一排序键：最近动过的在前。两张表的时间列语义一致（秒级 epoch），
            # 所以这里不需要任何按 kind 分开的特殊处理。
            items.sort(key=lambda it: (-it.updated_at, -it.created_at, it.id))
        total = len(items)
        off = max(0, int(offset or 0))
        if limit is None or int(limit) <= 0:
            return items[off:], total
        return items[off:off + int(limit)], total

    def get(self, item_id: str) -> Optional[MemoryItem]:
        """按 id 找一条，不用调用方先知道它是记忆还是断言。

        先查记忆再查断言。两张表的 id 都是 uuid4/hex，撞车概率可以忽略；真撞了
        也是记忆优先——它是数量更多、被引用更多的那一边。
        """
        eid = str(item_id or "")
        if not eid:
            return None
        row = self.storage._db("memory").execute(
            "SELECT * FROM memory_entries WHERE id=?", (eid,)).fetchone()
        if row is not None:
            return item_from_entry(dict(row))
        claim = self.wiki.get(eid)
        return item_from_claim(claim) if claim is not None else None

    # ── 写 ──────────────────────────────────────────────────────────────
    def set_status(self, item_id: str, status: str, *, reason: str = "",
                   superseded_by: str = "") -> Tuple[bool, str]:
        """改状态。返回 ``(成功, 原因)``。

        原因是给人看的：失败时调用方要能把"为什么不行"显示出来，而不是只有一个
        False。两种失败必须分得开——"这个状态断言表达不了"是设计使然，
        "这个转移非法"是库那一层的规则。
        """
        want = str(status or "")
        if want not in STATUSES:
            return False, f"未知状态 {want!r}"
        item = self.get(item_id)
        if item is None:
            return False, "找不到这一条"
        if item.status == want:
            return True, "已经是这个状态"

        if item.kind == KIND_ENTRY:
            ok = self.storage.set_memory_status(
                item.id, want, reason=reason, superseded_by=superseded_by)
            return (True, "") if ok else (False, f"库拒绝了 {item.status} → {want}")

        native = _UNIFIED_TO_CLAIM.get(want)
        if native is None:
            return False, (f"断言没有 {want!r} 这个状态——它既没有'待批准'，也没有一个"
                           "和归档区分开的'这是错的'。不做近似映射，否则读回来的"
                           "状态会和写进去的不一样。")
        # 写之前先记下**原生**状态。统一词汇里 disputed 映射成 active（有冲突的断言
        # 仍然是活的，冲突走 conflicts 字段），所以 item.status 永远看不到 disputed。
        # 判"这是不是一次裁决"只能问断言库本身。
        was = str(getattr(self.wiki.get(item.id), "status", "") or "")
        if native == "deleted":
            ok = self.wiki.soft_delete(item.id, reason=reason or "archived")
        else:
            ok = self.wiki.set_status(item.id, native, reason=reason)
        if not ok:
            return False, f"断言库拒绝了 {item.status} → {want}"
        # 裁决要连带退役来源记忆——和 /api/wiki/resolve 一个语义。
        #
        # 「待你裁决」面板收拾一个断言冲突走的是这条路（PATCH 一个状态），而 wiki
        # 面板走 resolve_claim。同一个决定两个门，只有一个门退役来源记忆的话，用户
        # 从哪个门进去会得到不同结果：⚠冲突 消失了，可那条自由文本记忆还在被召回。
        #
        # 条件收得很紧：**只有原本处于 disputed 的断言被收掉**才连带。用户单纯整理
        # 一条不再需要的断言（active → archived）不该顺手动他的记忆。
        if was == "disputed" and want == "archived":
            self._retire_claim_sources(item.id, reason=f"claim_{want}")
        return True, ""

    def _retire_claim_sources(self, claim_id: str, *, reason: str) -> int:
        """把一个断言的 evidence 指向的记忆标成 stale。返回改动条数。

        stale 而不是 archived：裁决说的是"这条不再作为当前事实"，不是"这条从来
        不该存在"。stale 不再被召回，但用户能翻回来，而且会进
        ``list_memories_needing_review``，Dream 下一趟看得到。
        """
        claim = self.wiki.get(str(claim_id or ""))
        if claim is None:
            return 0
        n = 0
        for eid in (claim.evidence or []):
            ok, _why = self.set_status(eid, "stale", reason=reason)
            if ok:
                n += 1
        return n

    def _mark_bundle_verdict(self, proposal_id: str, verdict: str) -> None:
        """把人的裁决回写到这条提案所属的 LearningBundle。

        ``user_verdict`` 记的是"人最终怎么看这条学习"。目标侧的提案裁决一直有这一
        步（``EvolutionEngine.decide``），Dream 提出的合并却没有：台账因此只知道
        提议过什么，永远不知道它被批了还是被否了——而"人否掉了哪一类学习"恰恰是
        这本账最该回答的问题。

        两个门（``approve_merge`` / ``reject_merge``）都走这里。回写不成不是错误：
        档位 off 时提案照落，那趟本来就没有 bundle。
        """
        if not proposal_id:
            return
        try:
            from evolution import get_evolution_engine
            get_evolution_engine().store.mark_bundle_verdict_for_proposal(
                str(proposal_id), verdict)
        except Exception as e:  # noqa: BLE001
            print(f"[memory] bundle 裁决没回写：{e}")

    def adjust_confidence(self, item_id: str, delta: float, *,
                          reason: str = "") -> Tuple[float, str]:
        """把置信度挪 ``delta``，返回 ``(新值, 原因)``；新值 -1.0 表示没改成。

        两张表原本的钳制区间不一样（记忆 [0.05, 0.95]，断言 [0, 1]）。这一层统一
        用记忆那边的区间，包括断言：0 等于"确定是错的"（该走 reject/删除，而不是
        留一条置信度 0 的断言继续参与排序），1 等于"永远不会错"。
        """
        item = self.get(item_id)
        if item is None:
            return -1.0, "找不到这一条"
        if item.kind == KIND_ENTRY:
            return self.storage.adjust_memory_confidence(
                item.id, delta, reason=reason), ""
        floor = float(getattr(self.storage, "MEMORY_CONFIDENCE_FLOOR", 0.05))
        ceil = float(getattr(self.storage, "MEMORY_CONFIDENCE_CEIL", 0.95))
        target = max(floor, min(ceil, item.confidence + float(delta or 0.0)))
        return self.wiki.set_confidence(item.id, target, reason=reason), ""

    def confirm(self, item_id: str, *, delta: float = 0.05) -> Tuple[bool, str]:
        """"这条现在还成立"。

        记忆这边会刷新 ``last_confirmed_at``（新鲜度看的是最后确认时间）。断言没有
        这个列，所以只动置信度——并且如实说明，不假装刷新了一个不存在的字段。
        """
        item = self.get(item_id)
        if item is None:
            return False, "找不到这一条"
        if item.kind == KIND_ENTRY:
            ok = self.storage.confirm_memory(item.id, delta=delta)
            return (True, "") if ok else (False, "确认失败")
        new, _ = self.adjust_confidence(item.id, delta, reason="confirmed")
        if new < 0:
            return False, "确认失败"
        return True, "断言没有'最后确认时间'，只提高了置信度"

    def delete(self, item_id: str, *, reason: str = "user_deleted",
               hard: bool = False) -> Tuple[bool, str]:
        """删除 = 留墓碑。两种知识现在是同一个语义。

        ``hard=True`` 才真的抹掉，而且只有断言支持——记忆表从来没有硬删除入口，
        这里也不新开一个。
        """
        item = self.get(item_id)
        if item is None:
            return False, "找不到这一条"
        if hard:
            if item.kind != KIND_CLAIM:
                return False, "记忆没有硬删除；它的删除就是归档，可以再拿回来"
            self.wiki.delete(item.id)
            return True, "已彻底删除，不可恢复"
        return self.set_status(item.id, "archived", reason=reason)

    def resolve_claim(self, loser_id: str, winner_id: str) -> Tuple[bool, str]:
        """裁决两条互相矛盾的断言，并把输的那条的**来源记忆**一起退役。

        为什么不能只改断言：断言是记忆的结构化投影，两边各有一条自己的注入路径。
        只把 claim 标成 superseded 的话，⚠冲突 从 wiki 块里消失了，但 "我在字节
        工作" 这条 memory_entries 行还是 active，下一轮照旧被召回——用户点了"保留
        这条"，结果两条还都在，而界面上看不出任何异常。

        输的来源记忆落成 ``stale`` 而不是 ``archived``：stale 是"不再召回但还在"，
        用户改主意还能翻回来，而且它会进 ``list_memories_needing_review``，Dream
        下一趟能看见"这里有个已经裁决过的旧说法"。归档是更重的动作，留给用户自己
        在记忆列表里按。

        返回 ``(成功, 给人看的话)``。
        """
        loser = self.wiki.get(str(loser_id or ""))
        winner = self.wiki.get(str(winner_id or ""))
        if loser is None or winner is None:
            return False, "找不到这条断言"
        if loser.id == winner.id:
            return False, "保留和退役不能是同一条"

        self.wiki.supersede(loser.id, winner.id)

        # 赢的那条指向哪条记忆——记忆行的 superseded_by 必须是记忆 id，不是断言 id，
        # 否则历史追溯会跳到一张不存在的表里。找不到就留空，宁可少一条线索。
        keep = next((e for e in (winner.evidence or [])
                     if self.storage._db("memory").execute(
                         "SELECT 1 FROM memory_entries WHERE id=?", (e,)).fetchone()), "")
        retired = 0
        for eid in (loser.evidence or []):
            ok, _why = self.set_status(
                eid, "stale", reason=f"claim_superseded_by:{winner.id}",
                superseded_by=keep)
            if ok:
                retired += 1
        if retired:
            return True, f"已保留你选的那条，顺带把 {retired} 条来源记忆标成过时"
        return True, "已保留你选的那条"

    def trace(self, item_id: str) -> Dict[str, Any]:
        """一条长期知识的来龙去脉。返回 ``{"item": …, "events": [...]}``。

        §8 的审计要求落到单条上：用户指着一条记忆问"这凭什么在这儿"，答案必须能
        当场给出，而不是让人去翻 dream_runs、observations、wiki_claims 三张互不相通
        的表。这些字段一直都在（created_by / source_goal_id / source_event_ids /
        supersedes / superseded_by / conflict_set，加上 Dream 的 job 账本和演化观察），
        但没有任何一个地方把它们串成一条线——散落的证据等于没有证据。

        每个事件带 ``ts``。**拿不到可靠时间的一律 ts=0 并标 ``dated=False``**：把
        "现状"画成时间线上的一个点会凭空造出一段没发生过的历史，那比缺时间更糟。
        前端据此把它们放在"当前状态"里而不是时间轴上。

        任何一个来源查不到都跳过，只少一条线索，不让整个追溯失败。
        """
        item = self.get(item_id)
        if item is None:
            return {}
        events: List[Dict[str, Any]] = []

        def ev(ts, kind, text, **extra):
            events.append({"ts": int(ts or 0), "dated": bool(ts),
                           "kind": kind, "text": text, **extra})

        if item.kind == KIND_CLAIM:
            claim = self.wiki.get(item.id)
            if claim is not None:
                ev(claim.created_at, "created",
                   f"断言写下：{claim.subject} / {claim.predicate} = {claim.object}",
                   source=claim.source)
                for e in (claim.evidence or []):
                    ev(0, "evidence", f"证据来自记忆 {e}", ref=e)
                for c in (claim.contradicts or []):
                    ev(0, "conflict", f"与断言 {c} 互相矛盾", ref=c)
                if claim.status != "active":
                    ev(claim.updated_at, "status",
                       f"当前状态 {claim.status}"
                       + (f"：{claim.status_reason}"
                          if getattr(claim, "status_reason", "") else ""))
            return {"item": item.to_api(), "events": self._sorted(events)}

        row = dict(self.storage._db("memory").execute(
            "SELECT * FROM memory_entries WHERE id=?", (item.id,)).fetchone())

        who = {"user": "你亲手写的", "agent": "对话里自动提取的",
               "evolution": "演化环提出的", "import": "导入的"}.get(
                   str(row.get("created_by") or ""), "来源未记录")
        ev(row.get("created_at"), "created", f"写入：{who}",
           createdBy=row.get("created_by") or "")
        if row.get("source_goal_id"):
            ev(0, "source", f"来自目标 {row['source_goal_id']}",
               ref=row["source_goal_id"])
        for eid in _as_tags(row.get("source_event_ids")):
            ev(0, "source", f"依据事件 {eid}", ref=eid)

        events.extend(self._dream_trace(item.id))

        for peer in _as_tags(row.get("conflict_set")):
            ev(0, "conflict", f"与记忆 {peer} 互相矛盾（等你裁决）", ref=peer)
        for src in _as_tags(row.get("supersedes")):
            ev(0, "proposal", f"若批准，将取代记忆 {src}", ref=src)
        if row.get("superseded_by"):
            ev(0, "superseded", f"已被记忆 {row['superseded_by']} 取代",
               ref=row["superseded_by"])

        confirmed = int(row.get("last_confirmed_at") or 0)
        if confirmed and confirmed != int(row.get("created_at") or 0):
            ev(confirmed, "confirmed", "又被证实了一次（新鲜度按这个时间算）")

        status = str(row.get("status") or "active")
        if status != "active":
            ev(row.get("updated_at"), "status", f"当前状态 {status}"
               + (f"：{row['status_reason']}" if row.get("status_reason") else ""))

        claim = self.wiki.get(f"m-{item.id}")
        if claim is not None:
            ev(claim.created_at, "wiki",
               f"结构化镜像：{claim.subject} / {claim.predicate} = {claim.object}"
               f"（{claim.status}）", ref=claim.id)

        return {"item": item.to_api(), "events": self._sorted(events)}

    @staticmethod
    def _sorted(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """有时间的按时间升序排在前，没时间的（"现状"类）按原顺序垫在后面。"""
        dated = sorted((e for e in events if e["dated"]), key=lambda e: e["ts"])
        return dated + [e for e in events if not e["dated"]]

    def _dream_trace(self, eid: str) -> List[Dict[str, Any]]:
        """这条记忆是哪一趟 Dream 提出来的，以及那一趟凭什么这么判。

        两个账本靠 ``dream_runs.proposal_id`` 和 ``observations.run_id == job_id``
        对上（见 ``MemoryLayer._dream_observe``）。演化库不可用就只报 Dream 那半边。
        """
        out: List[Dict[str, Any]] = []
        try:
            run = self.storage._db("memory").execute(
                "SELECT * FROM dream_runs WHERE proposal_id=?", (eid,)).fetchone()
        except Exception:  # noqa: BLE001
            run = None
        if run is None:
            return out
        run = dict(run)
        out.append({
            "ts": int(run.get("started_at") or 0), "dated": bool(run.get("started_at")),
            "kind": "dream",
            "text": (f"由整合任务 {str(run.get('job_id'))[:8]} 提出："
                     f"{run.get('outcome') or ''}"),
            "ref": run.get("job_id") or "",
            "inputCount": int(run.get("input_count") or 0),
            "tokensUsed": int(run.get("tokens_used") or 0),
        })
        try:
            from evolution import get_evolution_engine
            for o in (get_evolution_engine().store.list_observations(limit=200) or []):
                if str(o.get("runId") or "") != str(run.get("job_id") or ""):
                    continue
                out.append({
                    "ts": int(float(o.get("createdAt") or 0)),
                    "dated": bool(o.get("createdAt")),
                    "kind": "observation",
                    "text": f"演化观察判定 {o.get('decision')}：{o.get('reason') or ''}",
                    "ref": o.get("id") or "",
                })
        except Exception as e:  # noqa: BLE001
            print(f"[memory] 观察台账没读到：{e}")
        return out

    # ── 冲突与重复 ──────────────────────────────────────────────────────
    def conflicts(self, root: str, limit: int = 50) -> List[Dict[str, Any]]:
        """需要人裁决的分歧。

        两个来源，口径一致：都只报**已经记录下来的**矛盾关系，不在这里做猜测。

        * 断言：``contradicts_json``。结构化三元组，"同一个 subject+predicate 指向
          不同 object"是可判定的。
        * 记忆：``conflict_set``。写入闸门在落盘前发现"去掉否定词后同形、极性相反"
          时写下的关系（见 ``storage.find_conflicting_memories``）。

        刻意不在读的时候再做一遍相似度扫描：一个偶尔虚报矛盾的冲突视图比没有更糟，
        用户会开始无视它。只报写入那一刻确定的事。

        返回 ``[{"claim": item, "peers": [item, ...]}]``，peers 是对手方。
        """
        out: List[Dict[str, Any]] = []
        # 记忆侧。冲突里的新行是 candidate（不算活），所以不能按 live 过滤——
        # 最需要裁决的那条正好会看不见。
        try:
            items, _ = self.list_items(
                root, kinds=(KIND_ENTRY,),
                statuses=("candidate", "active", "stale"), limit=None)
        except Exception as exc:
            log.warning("[memory_domain] conflicts: memory unavailable: %s", exc)
            items = []
        seen: set = set()
        # 已裁决的那一边不再算分歧：用户把 candidate 归档掉，就是他已经选了老的那条。
        # 关系本身留在 conflict_set 里（"这两条曾经矛盾过"是事实），但视图上不该再
        # 要求他裁决第二遍。
        unsettled = ("candidate", "active", "stale")
        for it in items:
            if not it.conflicts or it.id in seen:
                continue
            mem_peers: List[MemoryItem] = []
            for pid in it.conflicts:
                peer = self.get(str(pid))
                if peer is None or peer.status not in unsettled:
                    continue
                mem_peers.append(peer)
                seen.add(peer.id)   # 关系是对称的，同一组别报两遍

            if not mem_peers:
                continue
            seen.add(it.id)
            out.append({"claim": it, "peers": mem_peers})
            if len(out) >= int(limit):
                return out

        try:
            disputed = self.wiki.disputed(root, limit=int(limit)) or []
        except Exception as exc:
            log.warning("[memory_domain] conflicts: wiki unavailable: %s", exc)
            return out
        for claim in disputed:
            peers: List[MemoryItem] = []
            for pid in (getattr(claim, "contradicts", None) or []):
                peer = self.wiki.get(str(pid))
                if peer is None:
                    continue
                peer_item = item_from_claim(peer)
                if peer_item.live:
                    peers.append(peer_item)
            out.append({"claim": item_from_claim(claim), "peers": peers})
            if len(out) >= int(limit):
                break
        return out


    def pending_merges(self, root: str, *, limit: int = 50) -> List[Dict[str, Any]]:
        """待批的合并。返回 ``[{"proposal": item, "sources": [item, ...]}]``。

        §10.2：Dream 只能提议合并，不能直接合并。一个 candidate 带着非空的
        ``supersedes`` 就是一份提案——它自己不进召回，被它指向的那几条也一个都
        没动。批准之后才发生替换。

        只看 candidate：一条已经 active 的行如果还留着 supersedes，那是历史记录
        （批准时会清掉），不是待办。
        """
        out: List[Dict[str, Any]] = []
        try:
            items, _ = self.list_items(
                root, kinds=(KIND_ENTRY,), statuses=("candidate",), limit=None)
        except Exception as exc:
            log.warning("[memory_domain] pending_merges unavailable: %s", exc)
            return out
        for it in items:
            if not it.supersedes:
                continue
            # 只算还没被处置的素材。用户自己先把其中一条删了，那条就不该再作为
            # "批准后会被归档"列出来——它已经归档了，重复陈述一次只会让人以为
            # 提案还会再动它一下。
            sources = []
            for sid in it.supersedes:
                s = self.get(str(sid))
                if s is None or s.status in ("archived", "rejected"):
                    continue
                sources.append(s)
            if not sources:
                # 要替掉的那几条已经全都不在了。提案失去了意义，但这里只读不写——
                # 沉默地改状态会让用户看不到发生过什么。
                continue
            out.append({"proposal": it, "sources": sources})
            if len(out) >= int(limit):
                break
        return out


    def approve_merge(self, item_id: str, *, reason: str = "user_approved") -> Tuple[bool, str]:
        """批准一份合并提案：候选生效，被它替掉的那几条归档。

        顺序是有意的——先让候选生效，再归档旧的。反过来的话，中途失败会留下
        "旧的已经没了、新的还没生效"，也就是这段知识凭空消失了一会儿。宁可短暂
        地两边都在（读到重复），也不要短暂地两边都没有。
        """
        item = self.get(item_id)
        if item is None:
            return False, "找不到这一条"
        if item.kind != KIND_ENTRY:
            return False, "断言没有合并提案这个概念"
        if not item.supersedes:
            return False, "这一条不是待批的合并"
        ok, why = self.set_status(item.id, "active", reason=reason)
        if not ok:
            return False, why
        archived, failed = 0, []
        for sid in item.supersedes:
            done, msg = self.set_status(
                str(sid), "archived", reason=f"merged_into:{item.id}",
                superseded_by=item.id)
            if done:
                archived += 1
            else:
                failed.append(f"{sid}: {msg}")
        # 提案已经落地，supersedes 从"待办"变成历史，清空它才不会再出现在待批列表。
        self.storage.clear_memory_supersedes(item.id)
        self._mark_bundle_verdict(item.id, "approved")
        if failed:
            return True, f"已生效，但有 {len(failed)} 条没归档：" + "; ".join(failed)
        return True, f"已生效，归档了 {archived} 条"

    def reject_merge(self, item_id: str, *, reason: str = "user_rejected") -> Tuple[bool, str]:
        """驳回一份合并提案：候选归档，被它指向的那几条一个都不动。

        用 ``archived`` 而不是 ``rejected``：``rejected`` 是墓碑（只能再进归档），
        而用户过一阵可能想回头看看 Dream 当时想说什么。
        """
        item = self.get(item_id)
        if item is None:
            return False, "找不到这一条"
        if not item.supersedes:
            return False, "这一条不是待批的合并"
        ok, why = self.set_status(item.id, "archived", reason=reason)
        if not ok:
            return False, why
        self.storage.clear_memory_supersedes(item.id)
        self._mark_bundle_verdict(item.id, "rejected")
        return True, "已驳回，原来那几条保持不变"

    def duplicates(self, root: str, *, limit: int = 50) -> List[List[MemoryItem]]:

        """内容等价的活记忆，按组返回（每组 2 条以上）。

        归一化口径和 ``storage.find_memories_by_content`` 一致（去空白/标点、
        小写），刻意只认**等价**：模糊去重是有损的，宁可漏掉一组也不要把两条用户
        分别写下的记忆判成同一条。

        只看活的行——把归档的算进来会让"重复"永远清不完。
        """
        buckets: Dict[str, List[MemoryItem]] = {}
        items, _ = self.list_items(root, kinds=(KIND_ENTRY,), live_only=True, limit=None)
        for it in items:
            key = re.sub(r"[\s\W_]+", "", it.content.lower())
            if not key:
                continue
            buckets.setdefault(key, []).append(it)
        groups = [g for g in buckets.values() if len(g) > 1]
        # 组内最近动过的在前：用户要留哪一条，默认答案是最新的那条。
        for g in groups:
            g.sort(key=lambda it: -it.updated_at)
        groups.sort(key=lambda g: (-len(g), -g[0].updated_at))
        return groups[:max(0, int(limit))] if limit else groups

    # ── 统计与维护 ──────────────────────────────────────────────────────
    def stats(self, root: str) -> Dict[str, Any]:
        """一个 workspace 的长期知识概况，两张表用同一套状态名汇总。"""
        items, total = self.list_items(root, limit=None)
        by_status: Dict[str, int] = {s: 0 for s in STATUSES}
        by_kind: Dict[str, int] = {k: 0 for k in KINDS}
        live = 0
        expiring = 0
        now = _now()
        for it in items:
            by_status[it.status] = by_status.get(it.status, 0) + 1
            by_kind[it.kind] = by_kind.get(it.kind, 0) + 1
            if it.live:
                live += 1
            # "快过期了"取 7 天，纯粹是给界面一个提醒窗口，没有别的语义。
            if it.valid_until and now < it.valid_until <= now + 7 * 86400:
                expiring += 1
        return {
            "root": root,
            "total": total,
            "live": live,
            "expiringSoon": expiring,
            "byStatus": by_status,
            "byKind": by_kind,
            "conflicts": len(self.conflicts(root, limit=1000)),
        }

    def sweep(self, root: Optional[str] = None) -> int:
        """把过期的记忆落成 ``stale``，返回条数。

        断言没有过期时间，所以这里只扫记忆——不是漏了，是那张表没有这个概念。
        """
        return int(self.storage.sweep_expired_memories(root) or 0)

    def rank_and_deduplicate(
        self,
        query: str,
        items: List[MemoryItem],
        limit: int = 5,
        lambda_param: float = 0.7,
        halflife_days: float = 30.0,
    ) -> List[MemoryItem]:
        """对候选记忆执行时间半衰期衰减与 MMR 多样性重排序。"""
        return maximal_marginal_relevance(
            query=query,
            candidates=items,
            limit=limit,
            lambda_param=lambda_param,
            halflife_days=halflife_days,
        )

    def detect_spo_conflicts(
        self,
        root: str,
        subject: str,
        predicate: str,
        object_: str,
    ) -> List[MemoryItem]:
        """检测是否存在主体与谓词相同但客体产生矛盾的现有活跃断言/记忆。"""
        if not subject or not predicate or not object_:
            return []
        items, _ = self.list_items(root, live_only=True, limit=500)
        conflicts: List[MemoryItem] = []
        norm_s = subject.strip().lower()
        norm_p = predicate.strip().lower()
        norm_o = object_.strip().lower()
        for it in items:
            it_s = (it.subject or "").strip().lower()
            it_p = (it.predicate or "").strip().lower()
            it_o = (it.object or "").strip().lower()
            if it_s == norm_s and it_p == norm_p and it_o and it_o != norm_o:
                conflicts.append(it)
        return conflicts


def compute_time_decay_score(
    item: MemoryItem,
    halflife_days: float = 30.0,
    now: Optional[int] = None,
) -> float:
    """Calculate time-decay weighted score for a memory item.

    Decay follows exponential half-life: w(t) = 2^(-Δt / halflife_days).
    Blended with item confidence and importance:
    FinalScore = confidence * (0.6 + 0.4 * importance) * w(t).
    """
    current_ts = now if now is not None else _now()
    created_ts = item.created_at or current_ts
    delta_days = max(0.0, (current_ts - created_ts) / 86400.0)
    decay = (0.5) ** (delta_days / max(1.0, halflife_days))
    conf = max(0.05, min(1.0, item.confidence))
    imp = max(0.05, min(1.0, item.importance))
    return conf * (0.6 + 0.4 * imp) * decay


def maximal_marginal_relevance(
    query: str,
    candidates: List[MemoryItem],
    limit: int = 5,
    lambda_param: float = 0.7,
    halflife_days: float = 30.0,
) -> List[MemoryItem]:
    """Select a diverse subset of memory items using MMR algorithm.

    Args:
        query: The current turn's query/context text.
        candidates: List of candidate MemoryItem objects.
        limit: Maximum number of diverse items to select.
        lambda_param: Weight between relevance (1.0) and diversity (0.0). Default 0.7.
        halflife_days: Half-life in days for recency decay.

    Returns:
        Ranked list of up to `limit` diverse, relevant MemoryItem objects.
    """
    if not candidates or limit <= 0:
        return []
    if len(candidates) <= limit:
        return sorted(candidates, key=lambda it: -compute_time_decay_score(it, halflife_days))

    def _tokenize(text: str) -> set:
        words = re.findall(r'[\w]+', text.lower())
        return set(words)

    q_tokens = _tokenize(query)

    def _sim(tokens_a: set, tokens_b: set) -> float:
        if not tokens_a or not tokens_b:
            return 0.0
        inter = len(tokens_a & tokens_b)
        union = len(tokens_a | tokens_b)
        return inter / union if union > 0 else 0.0

    cand_tokens = [_tokenize(c.content) for c in candidates]
    relevance_scores = []
    for i, c in enumerate(candidates):
        query_sim = _sim(q_tokens, cand_tokens[i]) if q_tokens else 0.5
        decay_score = compute_time_decay_score(c, halflife_days)
        relevance_scores.append(0.5 * query_sim + 0.5 * decay_score)

    selected_indices: List[int] = []
    remaining_indices = list(range(len(candidates)))

    for _ in range(min(limit, len(candidates))):
        best_idx = -1
        best_score = -float('inf')

        for idx in remaining_indices:
            rel = relevance_scores[idx]
            if not selected_indices:
                redundancy = 0.0
            else:
                redundancy = max(_sim(cand_tokens[idx], cand_tokens[s]) for s in selected_indices)

            mmr_score = lambda_param * rel - (1.0 - lambda_param) * redundancy
            if mmr_score > best_score:
                best_score = mmr_score
                best_idx = idx

        if best_idx >= 0:
            selected_indices.append(best_idx)
            remaining_indices.remove(best_idx)
        else:
            break

    return [candidates[i] for i in selected_indices]


_domain: Optional[MemoryDomain] = None


def get_memory_domain() -> MemoryDomain:
    """进程内单例。依赖是懒加载的，所以拿它本身不会碰数据库。"""
    global _domain
    if _domain is None:
        _domain = MemoryDomain()
    return _domain
