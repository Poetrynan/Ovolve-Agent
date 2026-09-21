"""C4 — Wiki declarative knowledge: structured claims with confidence & evidence.

The rest of the memory system (C1 tiers, C2 hybrid retrieval, C3 active facade)
stores *episodic* memories — free-text notes with an "importance" number. That
works for "the user asked about X yesterday" but fails at declarative facts:

- **No structure**: "prefers dark mode" and "uses dark mode on Mondays" are both
  free text, so contradictions can only be spotted by squinting.
- **No provenance**: which turn produced this belief? which file? Impossible to
  answer once it's been re-summarized into a preference blob.
- **No confidence**: everything is retrieved with equal weight regardless of
  whether it was said once in passing or reconfirmed five times.
- **No successors**: if a fact changes, the old fact stays in the pool and gets
  retrieved too, and the model has to guess which is current.

Wiki claims are the declarative counterpart. Each row is a **(subject, predicate,
object)** triple with:

- a **confidence** in 0..1,
- an **evidence** list linking back to episodic memory ids / URLs / commits,
- a **contradictions** list pointing at other claim ids that disagree,
- a **status** — ``active`` / ``superseded`` / ``disputed`` / ``deleted`` —
  driving retrieval. Only ``active`` and ``disputed`` reach the prompt.


Contradiction detection runs on insert. Two heuristics, in order:

1. **Structural conflict**: same normalized ``(subject, predicate)`` with a
   different ``object``. This is the wiki-classic case ("capital of France is
   Paris" vs "capital of France is Lyon") and does not need any NLP.
2. **Textual negation**: same subject/predicate where one statement carries a
   negation marker (``不``, ``no``, ``never``, ``no longer``, ``used to``). This
   catches "prefers tabs" following "prefers spaces" when the second is phrased
   as "no longer prefers spaces".

The check is deterministic and cheap — no LLM in the write path — because a
"wiki" that occasionally hallucinates contradictions would be actively worse
than none at all. When both claims survive, they are linked bidirectionally in
``contradictions`` and their status flips to ``disputed`` so the retrieval side
knows to flag them to the model for adjudication.

The subject/predicate index is a case-folded, whitespace-collapsed hash of the
raw strings. That makes ``"editor"`` and ``"Editor "`` collide (intended: same
attribute) without going as far as stemming or synonym expansion (which would
merge "prefers" and "preferred" too aggressively).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import sqlite3
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

log = logging.getLogger(__name__)



# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

#: Claim status. ``active`` is the default; ``superseded`` means a later claim
#: with the same subject+predicate replaces it (we keep the row for audit);
#: ``disputed`` means an active contradiction exists and neither side won yet.
STATUS_ACTIVE = "active"
STATUS_SUPERSEDED = "superseded"
STATUS_DISPUTED = "disputed"

#: 删除一条断言以前是直接 DELETE，而记忆那边的删除是归档（可撤销、留痕）。
#: 同一个"删除"按钮在两种知识上语义不同，是必须消掉的分裂：这里补一个墓碑状态，
#: 硬删除仍然保留（:meth:`WikiStore.delete`），但默认走软删除。
STATUS_DELETED = "deleted"

#: 全部合法状态。未知状态一律拒绝，不写库。
STATUSES = (STATUS_ACTIVE, STATUS_DISPUTED, STATUS_SUPERSEDED, STATUS_DELETED)

#: 还能进 prompt 的状态。disputed 也在里面——冲突要让模型看见并裁决，
#: 藏起来只会让它继续基于一半的事实推理。
LIVE_STATUSES = (STATUS_ACTIVE, STATUS_DISPUTED)


#: Negation markers used by the textual heuristic. Kept short and literal —
#: false negatives are fine (the structural check catches most conflicts) but
#: false positives here would turn every "not sure" into a contradiction.
_NEGATION_MARKERS = (
    "不", "非", "没", "无", "别",
    "no ", "not ", "never ", "no longer ", "used to ", "isn't ", "aren't ",
    "doesn't ", "don't ", "won't ", "wouldn't ", "cannot ", "can't ",
)


@dataclass
class WikiClaim:
    """A single declarative claim.

    ``subject`` + ``predicate`` form the natural key; ``object`` may be empty
    for existential claims ("user has a dog" without further attributes), in
    which case contradiction detection falls back to negation-marker matching.
    """
    id: str
    root_dir: str
    subject: str
    predicate: str
    object: str
    statement: str                             # the full human-readable form
    confidence: float                          # 0..1
    evidence: List[str] = field(default_factory=list)   # memory ids, urls, refs
    contradicts: List[str] = field(default_factory=list) # ids of conflicting claims
    status: str = STATUS_ACTIVE
    source: str = ""                           # "user" / "model" / "extraction"
    created_at: int = 0
    updated_at: int = 0
    status_reason: str = ""                     # 为什么变成现在这个状态


    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_row(cls, row: Any) -> "WikiClaim":
        """Build from a sqlite3.Row. Tolerates missing evidence/contradicts."""
        def _parse(raw: Any) -> List[str]:
            if not raw:
                return []
            if isinstance(raw, (list, tuple)):
                return [str(x) for x in raw]
            try:
                v = json.loads(raw)
                return [str(x) for x in v] if isinstance(v, list) else []
            except (json.JSONDecodeError, TypeError):
                return []

        def _opt(r: Any, key: str) -> str:
            """读一个可能还不存在的列。

            ``status_reason`` 是后加的列，而 ``_ensure_schema`` 只在构造
            ``WikiStore`` 时跑过一次；如果有别的代码路径先拿到过这张表的行，
            这里按 IndexError 兜底成空串，而不是让整个读路径炸掉。
            """
            try:
                return str(r[key] or "")
            except (IndexError, KeyError, TypeError):
                return ""

        return cls(
            id=row["id"],
            root_dir=row["root_dir"] or "",
            subject=row["subject"] or "",
            predicate=row["predicate"] or "",
            object=row["object"] or "",
            statement=row["statement"] or "",
            confidence=float(row["confidence"] or 0.0),
            evidence=_parse(row["evidence_json"]),
            contradicts=_parse(row["contradicts_json"]),
            status=row["status"] or STATUS_ACTIVE,
            source=row["source"] or "",
            created_at=int(row["created_at"] or 0),
            updated_at=int(row["updated_at"] or 0),
            status_reason=_opt(row, "status_reason"),
        )



# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

_WS = re.compile(r"\s+")

def normalize(text: str) -> str:
    """Case-fold + whitespace-collapse. Used for the subject/predicate key.

    Deliberately does *not* stem or expand synonyms — "prefers" and "preferred"
    stay distinct because merging them silently is worse than a rare missed
    conflict. If we later want fuzzy matching, layer it on top; the base key
    should stay exact.
    """
    if not text:
        return ""
    return _WS.sub(" ", text.strip().casefold())


def subject_predicate_key(subject: str, predicate: str) -> str:
    """Stable hash used as the "same attribute" grouping key."""
    payload = normalize(subject) + "\x1f" + normalize(predicate)
    return hashlib.sha1(payload.encode("utf-8", "replace")).hexdigest()[:16]


def has_negation(text: str) -> bool:
    """True when ``text`` contains any of the tracked negation markers.

    Case-insensitive for ASCII, exact for CJK (CJK negation words rarely change
    case). Only inspects the raw statement — normalizing to lowercase first
    would erase Chinese case-fold no-ops but is harmless.
    """
    if not text:
        return False
    low = text.casefold()
    return any(m in low for m in _NEGATION_MARKERS)


#: 自由文本 → SPO 三元组。故意只有**单值**谓词。
#:
#: 结构化冲突检测的判据是"同 subject+predicate、不同 object 就是矛盾"。这个判据
#: 只对单值属性成立：一个人只有一个名字，所以"我叫张三"和"我叫李四"必有一错。
#: 多值属性会让它虚报——"我喜欢咖啡"和"我喜欢茶"同 s+p 不同 object，但两句都对。
#: 所以 ``偏好`` / ``使用`` 这类**不在**表里，哪怕 ``_EXTRACT_PATTERNS`` 认得它们。
#:
#: 要加新谓词，先回答一个问题：这个属性同时有两个值是不是必然矛盾？答不上来就
#: 别加——一个偶尔虚报的冲突视图，用户会连真的一起无视。
#:
#: 每项是 ``(subject, predicate, 正则)``，正则整串匹配，第 1 组是 object。
#: 每条都留了否定位（``不`` / ``don't`` 之类）：见 :func:`triple_from_text`。
TRIPLE_PATTERNS: Tuple[Tuple[str, str, Any], ...] = tuple(
    (subj, pred, re.compile(pat, re.IGNORECASE))
    for subj, pred, pat in (
        ("用户", "名字", r"\s*my name is(?:n't| not)?\s+(.{1,40}?)\s*[.。!！]?\s*"),
        ("用户", "名字", r"\s*我(?:的名字)?(?:不|并不)?(?:就)?叫\s*(.{1,40}?)\s*[.。!！]?\s*"),
        ("用户", "工作单位", r"\s*i (?:don't |do not )?work at\s+(.{1,40}?)\s*[.。!！]?\s*"),
        ("用户", "工作单位", r"\s*我(?:不|没|没有|已经不)?在\s*(.{1,40}?)\s*工作\s*[.。!！]?\s*"),
        ("用户", "时区", r"\s*my timezone is(?:n't| not)?\s+(.{1,40}?)\s*[.。!！]?\s*"),
        ("用户", "时区", r"\s*我(?:的)?时区(?:不)?是\s*(.{1,40}?)\s*[.。!！]?\s*"),
    )
)

#: object 里出现这些就说明匹配到的只是半句话（"我叫张三，另外……"）。断言要么是
#: 完整的一句，要么不要——半句话被注入 prompt 之后没人能看出它被截断过。
_OBJECT_REJECT = re.compile(r"[，,。；;！!？?\n、]")


def triple_from_text(text: str):
    """把一句话解析成 ``(subject, predicate, object)``，认不出来就返回 ``None``。

    宁可漏，不可虚报：整串匹配、object 有长度上限、object 里不许出现句读。这三条
    加起来的效果是"我叫张三，另外顺便说一下……"整句被放过，而不是把"张三，另外顺便
    说一下……"当成用户的名字写进 wiki。

    否定式**必须**能解析出 object，而且 object 和肯定式一样（``"我不在字节工作"``
    出的是"字节"）。语句原文交给 :func:`has_negation`，同 s+p 一正一反才判成矛盾。
    要是这里把否定句直接漏掉，"我不在 X 工作"就永远不会和"我在 X 工作"对上——而这
    恰好是最该被发现的那种冲突。
    """
    s = str(text or "").strip()
    if not s:
        return None
    for subject, predicate, pat in TRIPLE_PATTERNS:
        m = pat.fullmatch(s)
        if not m:
            continue
        obj = (m.group(1) or "").strip(" \t、，,：:")
        if not obj or _OBJECT_REJECT.search(obj):
            continue
        return subject, predicate, obj
    return None


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

class WikiStore:
    """SQLite-backed store for ``WikiClaim`` rows.

    Reuses ``Storage``'s memory database connection so wiki tables live next to
    the episodic memory tables — schema evolution, backup, and workspace scoping
    all Just Work. The class does not open its own connection; a caller must
    pass the Storage in.
    """

    def __init__(self, storage: Any):
        self.storage = storage
        self._ensure_schema()

    # ── schema ─────────────────────────────────────────────────────────
    def _ensure_schema(self) -> None:
        """Idempotent DDL. Runs on every construction — cheap and lets an old
        upgrade path pick up the table without a separate migration step."""
        db = self.storage._db("memory")
        db.execute(
            "CREATE TABLE IF NOT EXISTS wiki_claims ("
            "id TEXT PRIMARY KEY, root_dir TEXT, subject TEXT, predicate TEXT, "
            "object TEXT, statement TEXT, confidence REAL DEFAULT 0.5, "
            "evidence_json TEXT DEFAULT '[]', contradicts_json TEXT DEFAULT '[]', "
            "status TEXT DEFAULT 'active', source TEXT DEFAULT '', "
            "sp_key TEXT, created_at INTEGER, updated_at INTEGER)"
        )
        # Two indexes, both essential to keep contradiction detection O(claims
        # with the same subject/predicate) instead of a full scan on every write.
        db.execute("CREATE INDEX IF NOT EXISTS idx_wiki_root ON wiki_claims(root_dir, status)")
        db.execute("CREATE INDEX IF NOT EXISTS idx_wiki_sp   ON wiki_claims(sp_key, root_dir)")
        # 后加的列。带默认值、没有约束，所以对历史行不可能失败；重复执行会抛
        # OperationalError("duplicate column")，这是预期路径而不是错误。
        try:
            db.execute("ALTER TABLE wiki_claims ADD COLUMN status_reason TEXT DEFAULT ''")
        except sqlite3.OperationalError:
            pass
        db.commit()


    # ── mutation ───────────────────────────────────────────────────────
    def add(
        self,
        *,
        root_dir: str,
        subject: str,
        predicate: str,
        object: str = "",
        statement: str = "",
        confidence: float = 0.5,
        evidence: Optional[Iterable[str]] = None,
        source: str = "user",
        claim_id: Optional[str] = None,
    ) -> Tuple[WikiClaim, List[WikiClaim]]:
        """Insert a claim and run contradiction detection.

        Returns ``(new_claim, conflicts)``. When ``conflicts`` is non-empty the
        new row is bidirectionally linked to each and *both* sides' statuses
        become ``disputed``. Caller decides what to do next — the store never
        auto-supersedes because that would silently drop a claim the user might
        have meant to keep.
        """
        confidence = max(0.0, min(1.0, float(confidence)))
        statement = statement or f"{subject} {predicate} {object}".strip()
        cid = claim_id or uuid.uuid4().hex
        now = int(time.time())
        sp_key = subject_predicate_key(subject, predicate)
        evidence_list = [str(e) for e in (evidence or [])]

        db = self.storage._db("memory")
        # Contradiction detection has to see the current state *before* we
        # insert; otherwise the new row would count itself as a peer.
        peers = self._active_peers(root_dir, sp_key, exclude_id=None)
        conflicts = self._detect_conflicts(
            new_object=object, new_statement=statement, peers=peers,
        )

        status = STATUS_DISPUTED if conflicts else STATUS_ACTIVE
        db.execute(
            "INSERT INTO wiki_claims "
            "(id, root_dir, subject, predicate, object, statement, confidence, "
            "evidence_json, contradicts_json, status, source, sp_key, "
            "created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                cid, root_dir, subject, predicate, object, statement,
                confidence,
                json.dumps(evidence_list, ensure_ascii=False),
                json.dumps([c.id for c in conflicts], ensure_ascii=False),
                status, source, sp_key, now, now,
            ),
        )
        # Link the peer side symmetrically so retrieval from either direction
        # surfaces the disagreement.
        for peer in conflicts:
            new_ids = sorted(set(peer.contradicts + [cid]))
            db.execute(
                "UPDATE wiki_claims SET contradicts_json = ?, status = ?, updated_at = ? WHERE id = ?",
                (json.dumps(new_ids, ensure_ascii=False), STATUS_DISPUTED, now, peer.id),
            )
        db.commit()

        new = WikiClaim(
            id=cid, root_dir=root_dir, subject=subject, predicate=predicate,
            object=object, statement=statement, confidence=confidence,
            evidence=evidence_list, contradicts=[c.id for c in conflicts],
            status=status, source=source, created_at=now, updated_at=now,
        )
        return new, conflicts

    def supersede(self, old_id: str, new_id: str) -> None:
        """Explicit resolution: mark ``old_id`` superseded by ``new_id``.

        The caller drives this — e.g. a UI where the user picks which of two
        disputed claims is right. We do not guess based on confidence; a
        higher-confidence wrong claim would silently silence a lower-confidence
        correct one.
        """
        db = self.storage._db("memory")
        now = int(time.time())
        db.execute(
            "UPDATE wiki_claims SET status = ?, updated_at = ? WHERE id = ?",
            (STATUS_SUPERSEDED, now, old_id),
        )
        # If both sides were disputed and only one survives, the survivor goes
        # back to active. Any *other* contradictions the survivor has stay.
        row = db.execute("SELECT * FROM wiki_claims WHERE id = ?", (new_id,)).fetchone()
        if row is not None:
            others = json.loads(row["contradicts_json"] or "[]")
            still_active = [x for x in others if x != old_id]
            active_peers = db.execute(
                "SELECT id FROM wiki_claims WHERE id IN (%s) AND status = ?"
                % (",".join("?" * len(still_active)) or "''"),
                (*still_active, STATUS_ACTIVE),
            ).fetchall() if still_active else []
            new_status = STATUS_DISPUTED if active_peers else STATUS_ACTIVE
            db.execute(
                "UPDATE wiki_claims SET contradicts_json = ?, status = ?, updated_at = ? WHERE id = ?",
                (json.dumps(still_active, ensure_ascii=False), new_status, now, new_id),
            )
        db.commit()

    def set_status(self, claim_id: str, status: str, *, reason: str = "") -> bool:
        """改一条断言的状态。非法转移会出声并拒绝，返回是否真的改了。

        为什么不是自由赋值：``disputed`` 是从 ``contradicts_json`` 推导出来的，
        直接写它等于给同一个事实造第二个来源。所以这里只接受两种意图——

        - 判为 ``superseded`` / ``deleted``：人做的决定，随时可以下。
        - 回到 ``active``：只有在没有仍然活着的矛盾对手时才允许，否则界面上会
          出现一条"没有冲突"的断言，而它的对手那边还写着和它冲突。

        想表达 ``disputed`` 就去 :meth:`add` 或 :meth:`delete`（它们会重算），
        不要在这里手写。
        """
        want = str(status or "")
        if want not in STATUSES:
            log.error("[wiki] set_status: unknown status %r for %s", want, claim_id)
            return False
        if want == STATUS_DISPUTED:
            log.error("[wiki] set_status: %s is derived from contradicts, refusing"
                      " to set it directly on %s", STATUS_DISPUTED, claim_id)
            return False
        db = self.storage._db("memory")
        row = db.execute(
            "SELECT root_dir, sp_key, status, contradicts_json FROM wiki_claims"
            " WHERE id = ?", (claim_id,)).fetchone()
        if row is None:
            log.error("[wiki] set_status: no such claim %s", claim_id)
            return False
        cur = str(row["status"] or STATUS_ACTIVE)
        if cur == want:
            return True  # 幂等
        if want == STATUS_ACTIVE:
            peers = self._active_peers(
                str(row["root_dir"] or ""), str(row["sp_key"] or ""),
                exclude_id=claim_id,
            )
            if peers:
                log.error("[wiki] refused %s → active on %s: %d live peer(s) still"
                          " contradict it — the write did NOT happen",
                          cur, claim_id, len(peers))
                return False
        db.execute(
            "UPDATE wiki_claims SET status = ?, status_reason = ?, updated_at = ?"
            " WHERE id = ?",
            (want, str(reason or ""), int(time.time()), claim_id),
        )
        db.commit()
        return True

    def set_confidence(self, claim_id: str, value: float, *, reason: str = "") -> float:
        """把一条断言的置信度设成 ``value``（钳在 [0,1]），返回新值。

        返回新值而不是 bool：调用方（用户点"更可信"）要把结果显示出来。
        ``-1.0`` 表示这条断言不存在。上层的钳制区间可能更严（记忆那边是
        [0.05, 0.95]），这里只保证不出 [0,1]，不替上层做决定。
        """
        db = self.storage._db("memory")
        row = db.execute("SELECT confidence FROM wiki_claims WHERE id = ?",
                         (claim_id,)).fetchone()
        if row is None:
            log.error("[wiki] set_confidence: no such claim %s", claim_id)
            return -1.0
        new = max(0.0, min(1.0, float(value)))
        db.execute(
            "UPDATE wiki_claims SET confidence = ?, status_reason = CASE"
            " WHEN ?<>'' THEN ? ELSE status_reason END, updated_at = ?"
            " WHERE id = ?",
            (new, str(reason or ""), str(reason or ""), int(time.time()), claim_id),
        )
        db.commit()
        return new

    def soft_delete(self, claim_id: str, *, reason: str = "user_deleted") -> bool:
        """墓碑式删除：留下这一行，但它不再进 prompt、不再参与冲突检测。

        和记忆那边的"删除即归档"对齐。真正要抹掉用 :meth:`delete`——那个是不可
        撤销的，只应该在用户明确要求"彻底删掉"时走。
        """
        ok = self.set_status(claim_id, STATUS_DELETED, reason=reason)
        if not ok:
            return False
        # 对手那边的 contradicts 要摘掉这一条，否则它会永远停在 disputed，
        # 界面上显示"有冲突"却点不出对手是谁。
        self._unlink_peers(claim_id)
        return True

    def _unlink_peers(self, claim_id: str) -> None:
        """把 ``claim_id`` 从所有对手的 contradicts 里摘掉，并重算它们的状态。"""
        db = self.storage._db("memory")
        row = db.execute(
            "SELECT contradicts_json FROM wiki_claims WHERE id = ?", (claim_id,)
        ).fetchone()
        if row is None:
            return
        try:
            peer_ids = json.loads(row["contradicts_json"] or "[]")
        except (json.JSONDecodeError, TypeError):
            peer_ids = []
        now = int(time.time())
        for pid in peer_ids:
            r = db.execute(
                "SELECT contradicts_json FROM wiki_claims WHERE id = ?", (pid,)
            ).fetchone()
            if r is None:
                continue
            try:
                cur = json.loads(r["contradicts_json"] or "[]")
            except (json.JSONDecodeError, TypeError):
                cur = []
            cur = [x for x in cur if x != claim_id]
            db.execute(
                "UPDATE wiki_claims SET contradicts_json = ?, status = ?,"
                " updated_at = ? WHERE id = ?",
                (json.dumps(cur, ensure_ascii=False),
                 STATUS_DISPUTED if cur else STATUS_ACTIVE, now, pid),
            )
        db.commit()

    def delete(self, claim_id: str) -> None:
        """Hard-delete a claim. Also removes it from peers' contradicts lists."""
        db = self.storage._db("memory")
        # Load peers first so we can update their lists after the delete.
        row = db.execute(
            "SELECT contradicts_json FROM wiki_claims WHERE id = ?", (claim_id,)
        ).fetchone()
        peer_ids: List[str] = []
        if row is not None:
            try:
                peer_ids = json.loads(row["contradicts_json"] or "[]")
            except (json.JSONDecodeError, TypeError):
                peer_ids = []
        db.execute("DELETE FROM wiki_claims WHERE id = ?", (claim_id,))
        now = int(time.time())
        for pid in peer_ids:
            r = db.execute("SELECT contradicts_json FROM wiki_claims WHERE id = ?", (pid,)).fetchone()
            if r is None:
                continue
            try:
                cur = json.loads(r["contradicts_json"] or "[]")
            except (json.JSONDecodeError, TypeError):
                cur = []
            cur = [x for x in cur if x != claim_id]
            new_status = STATUS_DISPUTED if cur else STATUS_ACTIVE
            db.execute(
                "UPDATE wiki_claims SET contradicts_json = ?, status = ?, updated_at = ? WHERE id = ?",
                (json.dumps(cur, ensure_ascii=False), new_status, now, pid),
            )
        db.commit()

    # ── queries ────────────────────────────────────────────────────────
    def get(self, claim_id: str) -> Optional[WikiClaim]:
        row = self.storage._db("memory").execute(
            "SELECT * FROM wiki_claims WHERE id = ?", (claim_id,)
        ).fetchone()
        return WikiClaim.from_row(row) if row else None

    def list_claims(
        self,
        root_dir: str,
        *,
        status: Optional[str] = None,
        subject: Optional[str] = None,
        limit: int = 200,
        include_deleted: bool = False,
    ) -> List[WikiClaim]:
        where = ["root_dir = ?"]
        params: List[Any] = [root_dir]
        if status:
            where.append("status = ?")
            params.append(status)
        elif not include_deleted:
            # 墓碑默认不出现在列表里。显式 status='deleted' 仍然能查出来，
            # 因为"我删掉的那条到底是什么"是一个合理的问题。
            where.append("COALESCE(status,'active') != ?")
            params.append(STATUS_DELETED)

        if subject:
            where.append("subject = ?")
            params.append(subject)
        rows = self.storage._db("memory").execute(
            f"SELECT * FROM wiki_claims WHERE {' AND '.join(where)} "
            "ORDER BY updated_at DESC LIMIT ?",
            (*params, int(limit)),
        ).fetchall()
        return [WikiClaim.from_row(r) for r in rows]

    def disputed(self, root_dir: str, limit: int = 50) -> List[WikiClaim]:
        """All claims currently in disputed state — feeds the UI adjudication view."""
        return self.list_claims(root_dir, status=STATUS_DISPUTED, limit=limit)

    def _active_peers(
        self, root_dir: str, sp_key: str, exclude_id: Optional[str],
    ) -> List[WikiClaim]:
        """All active or disputed claims sharing subject+predicate.

        Superseded rows are excluded — they exist only for audit and must not
        cause new contradictions to be re-flagged.
        """
        params: List[Any] = [root_dir, sp_key]
        sql = (
            "SELECT * FROM wiki_claims WHERE root_dir = ? AND sp_key = ? "
            "AND status IN ('active','disputed')"
        )
        if exclude_id:
            sql += " AND id != ?"
            params.append(exclude_id)
        rows = self.storage._db("memory").execute(sql, params).fetchall()
        return [WikiClaim.from_row(r) for r in rows]

    def _detect_conflicts(
        self,
        *,
        new_object: str,
        new_statement: str,
        peers: List[WikiClaim],
    ) -> List[WikiClaim]:
        """Two-stage contradiction check (structural → textual)."""
        conflicts: List[WikiClaim] = []
        new_obj_norm = normalize(new_object)
        new_negated = has_negation(new_statement)
        for peer in peers:
            peer_obj_norm = normalize(peer.object)
            # Structural: same s+p, different object. Empty objects are treated
            # as "not asserting an object", so `"" vs "Paris"` is NOT a conflict
            # — one side is silent on the object, not disagreeing.
            if new_obj_norm and peer_obj_norm and new_obj_norm != peer_obj_norm:
                conflicts.append(peer)
                continue
            # Textual: same s+p (and either same-or-blank object), one negated
            # and the other not.
            if new_negated != has_negation(peer.statement):
                conflicts.append(peer)
        return conflicts

    # ── rendering ──────────────────────────────────────────────────────
    def render_block(self, root_dir: str, limit: int = 20) -> str:
        """Format active claims as a compact prompt block.

        Disputed claims are rendered with an explicit ``⚠ 冲突`` marker so the
        model surfaces the disagreement rather than picking one silently.
        """
        rows = self.list_claims(root_dir, limit=limit)
        if not rows:
            return ""
        # Sort: disputed first (they need adjudication), then by confidence desc.
        rows.sort(key=lambda c: (0 if c.status == STATUS_DISPUTED else 1, -c.confidence))
        lines = ["<wiki-claims>"]
        for c in rows:
            if c.status not in LIVE_STATUSES:
                continue

            marker = "⚠冲突 " if c.status == STATUS_DISPUTED else ""
            lines.append(
                f'  <claim id="{c.id[:8]}" confidence="{c.confidence:.2f}" '
                f'status="{c.status}">{marker}{c.statement}</claim>'
            )
        lines.append("</wiki-claims>")
        return "\n".join(lines)

    def stats(self, root_dir: Optional[str] = None) -> Dict[str, int]:
        """Counts by status. UI badge fodder."""
        db = self.storage._db("memory")
        if root_dir:
            rows = db.execute(
                "SELECT status, COUNT(*) AS n FROM wiki_claims WHERE root_dir = ? GROUP BY status",
                (root_dir,),
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT status, COUNT(*) AS n FROM wiki_claims GROUP BY status",
            ).fetchall()
        out = {STATUS_ACTIVE: 0, STATUS_DISPUTED: 0, STATUS_SUPERSEDED: 0,
               STATUS_DELETED: 0}
        for r in rows:
            out[r["status"] or STATUS_ACTIVE] = int(r["n"] or 0)
        # total 不含墓碑：界面上的"共 N 条"应该是"我现在有 N 条断言"，
        # 把删掉的算进去只会让人以为删除没生效。
        out["total"] = sum(v for k, v in out.items() if k != STATUS_DELETED)
        return out
