"""snapshot_store.py — pre-mutation file snapshots + rollback.

Every mutating file tool (write_file / edit_file / delete_file / move_file /
copy_file) captures the *pre-image* of the target(s) here right before dispatch.
Rollback then walks those snapshots in reverse and puts the workspace back into
the shape it had before a chosen checkpoint.

Design notes:

- One SQLite DB (``~/.ovolve/db/snapshots.db``) keyed by ``(session_id, seq)``.
  ``seq`` is the ``session_messages.seq`` value of the current user turn, so
  "roll back the chat to seq N" and "roll back files after seq N" share one
  monotonically-increasing handle.

- Content is stored inline as BLOB. Fine for typical source files; a gate on
  ``MAX_SNAPSHOT_BYTES`` skips huge binaries rather than blowing the DB up.

- ``kind`` records what we saw before the mutation:
    - ``file``: file existed → content is its bytes.
    - ``missing``: file did NOT exist → rollback deletes any file placed there.
    - ``dir``: target was a directory (delete_file on empty dir) — we record it
      so rollback recreates the empty dir.
    - ``skip``: file was too large; we noted the intent but can't restore.

- Rollback is best-effort and idempotent. It reports what it did per path.

- Rollback FOLDS the range it consumed (``archived=1`` + a shared ``fold_id``)
  instead of deleting it (UB1). ``seq`` is therefore a checkpoint key, not a
  one-shot truncation cursor: the timeline can still describe a branch the user
  walked back over, and going back stops being a cliff you can't see over.

"""
from __future__ import annotations
import difflib
import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Optional, Any

MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024  # 2 MiB — plenty for source, cheap to store


def _db_path() -> Path:
    try:
        from user_dirs import db_dir
    except ImportError:  # pragma: no cover - packaged import shape
        from app.backend.user_dirs import db_dir
    root = Path(db_dir())
    root.mkdir(parents=True, exist_ok=True)
    return root / "snapshots.db"


class SnapshotStore:
    def __init__(self, db_path: Optional[str] = None):
        self._conn = sqlite3.connect(str(db_path or _db_path()), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                tool_name TEXT,
                call_id TEXT,
                path TEXT NOT NULL,
                kind TEXT NOT NULL,           -- 'file' | 'missing' | 'dir' | 'skip'
                content BLOB,
                created_at INTEGER
            )
        """)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_snap_session_seq ON snapshots(session_id, seq)"
        )
        # ── UB1 checkpoint-tree columns ──────────────────────────────────
        # These turn `seq` from a truncation cursor into a checkpoint key, and
        # turn rollback from a destructive DELETE into an archival copy.
        #
        #  - archived: a rolled-back / discarded row is NOT deleted, it is folded
        #    away. 0 = live (part of the active timeline), 1 = folded. The whole
        #    point of UB1: history becomes a map you can walk back over, not a
        #    one-way cliff.
        #  - fold_id: groups the rows that were folded together in one rollback,
        #    so a fold can be described ("3 files, 2 turns") and, with UA1, lifted
        #    out into a sibling branch.
        #  - label: a user-named checkpoint. Empty means a system auto-point.
        self._safe_add_column("archived", "INTEGER DEFAULT 0")
        self._safe_add_column("fold_id", "TEXT DEFAULT ''")
        self._safe_add_column("label", "TEXT DEFAULT ''")
        self._safe_add_column("turn_id", "TEXT DEFAULT ''")
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS turn_snapshots (
                turn_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at REAL NOT NULL,
                finished_at REAL DEFAULT 0,
                head_commit TEXT DEFAULT '',
                metadata TEXT DEFAULT '{}'
            )
        """)
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_turn_snap_sess ON turn_snapshots(session_id, started_at)"
        )
        self._conn.commit()

    def _safe_add_column(self, col: str, decl: str) -> None:
        """Add a column if the DB predates it. Bare try/except is the idiom for
        SQLite's missing ADD COLUMN IF NOT EXISTS — a second run just raises
        'duplicate column' and we swallow it."""
        try:
            self._conn.execute(f"ALTER TABLE snapshots ADD COLUMN {col} {decl}")
        except sqlite3.OperationalError:
            pass  # fail-open: 可选增强，失败不影响主流程


    # ---- capture --------------------------------------------------------

    def capture(self, session_id: str, seq: int, tool_name: str,
                call_id: str, paths: list[str], turn_id: str = "") -> dict:
        """Snapshot the current state of every path in ``paths``.

        Still silent on error — a broken snapshot must never block the tool call
        itself — but no longer silent to the CALLER. It returns what it actually
        managed to store, because "we tried to snapshot" and "we hold a
        pre-image you can restore" are different facts and the UI badge was
        showing the first while claiming the second: a 3 GB file skipped by the
        size cap still got a green "reversible" badge.

        Returns:
            ``{captured, skipped, failed, recoverable}`` — the first three are
            path lists, ``recoverable`` is True only when there was at least one
            path AND every one of them landed as a restorable row. A partial
            capture is reported as NOT recoverable: undoing half a move leaves
            the workspace in a state the user did not ask for.
        """
        now = int(time.time())
        captured: list[str] = []
        skipped: list[str] = []
        failed: list[str] = []
        for raw in paths:
            if not raw:
                continue
            path = os.path.abspath(raw)
            try:
                if not os.path.exists(path):
                    # No pre-image needed: rollback deletes what the call created.
                    self._insert(session_id, seq, tool_name, call_id, path, "missing", None, now, turn_id=turn_id)
                    captured.append(path)
                    continue
                if os.path.isdir(path):
                    self._insert(session_id, seq, tool_name, call_id, path, "dir", None, now, turn_id=turn_id)
                    captured.append(path)
                    continue
                try:
                    size = os.path.getsize(path)
                except OSError:
                    size = MAX_SNAPSHOT_BYTES + 1
                if size > MAX_SNAPSHOT_BYTES:
                    # Intent recorded, content NOT — this is the case that must
                    # not be advertised as reversible.
                    self._insert(session_id, seq, tool_name, call_id, path, "skip", None, now, turn_id=turn_id)
                    skipped.append(path)
                    continue
                with open(path, "rb") as f:
                    blob = f.read()
                self._insert(session_id, seq, tool_name, call_id, path, "file", blob, now, turn_id=turn_id)
                captured.append(path)
            except Exception:
                # Swallow — snapshotting is best-effort. Do not raise into the
                # tool pipeline. But do report it, so the caller stops claiming
                # this step can be undone.
                failed.append(path)
                continue
        return {
            "captured": captured,
            "skipped": skipped,
            "failed": failed,
            "recoverable": bool(captured) and not skipped and not failed,
        }

    def _insert(self, session_id, seq, tool_name, call_id, path, kind, content, ts, turn_id: str = ""):
        self._conn.execute(
            "INSERT INTO snapshots (session_id, seq, tool_name, call_id, path, kind, content, created_at, turn_id) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (session_id, int(seq), tool_name, call_id, path, kind, content, ts, str(turn_id or "")),
        )
        self._conn.commit()

    # ── 回合级快照视图 (Task 2.7 / P3-4) ──────────────────────────────────

    def turn_start(self, session_id: str, turn_id: str, metadata: Optional[dict] = None) -> dict:
        """记录回合开始，捕获当前 git head（fail-open）。"""
        now = time.time()
        head_commit = ""
        try:
            import subprocess
            res = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                timeout=2,
            )
            if res.returncode == 0:
                head_commit = res.stdout.strip()
        except Exception:
            pass

        meta_json = json.dumps(metadata or {}, ensure_ascii=False)
        self._conn.execute(
            "INSERT OR REPLACE INTO turn_snapshots "
            "(turn_id, session_id, status, started_at, finished_at, head_commit, metadata) "
            "VALUES (?, ?, 'in_progress', ?, 0, ?, ?)",
            (turn_id, session_id, now, head_commit, meta_json),
        )
        self._conn.commit()
        return {
            "turn_id": turn_id,
            "session_id": session_id,
            "status": "in_progress",
            "started_at": now,
            "head_commit": head_commit,
        }

    def turn_finish(self, session_id: str, turn_id: str, metadata: Optional[dict] = None) -> dict:
        """固化回合结束状态。"""
        now = time.time()
        if metadata:
            meta_json = json.dumps(metadata, ensure_ascii=False)
            self._conn.execute(
                "UPDATE turn_snapshots SET status='finished', finished_at=?, metadata=? "
                "WHERE turn_id=?",
                (now, meta_json, turn_id),
            )
        else:
            self._conn.execute(
                "UPDATE turn_snapshots SET status='finished', finished_at=? "
                "WHERE turn_id=?",
                (now, turn_id),
            )
        self._conn.commit()
        return {
            "turn_id": turn_id,
            "session_id": session_id,
            "status": "finished",
            "finished_at": now,
        }

    def get_turn_diffs(self, turn_id: str) -> list[dict]:
        """输出回合级文件变更 diff 统计（与 git diff --numstat 抽样口径一致）。"""
        rows = self._conn.execute(
            "SELECT path, kind, content, created_at FROM snapshots "
            "WHERE turn_id=? ORDER BY id ASC",
            (turn_id,),
        ).fetchall()

        if not rows:
            turn_row = self._conn.execute(
                "SELECT session_id, started_at, finished_at FROM turn_snapshots WHERE turn_id=?",
                (turn_id,),
            ).fetchone()
            if turn_row:
                sid = turn_row["session_id"]
                st = turn_row["started_at"]
                et = turn_row["finished_at"] or (time.time() + 10)
                rows = self._conn.execute(
                    "SELECT path, kind, content, created_at FROM snapshots "
                    "WHERE session_id=? AND created_at>=? AND created_at<=? ORDER BY id ASC",
                    (sid, int(st), int(et) + 1),
                ).fetchall()

        # 按路径汇总首次预镜像 (pre-image)
        pre_images: dict[str, tuple[str, Optional[bytes]]] = {}
        for r in rows:
            p = r["path"]
            if p not in pre_images:
                pre_images[p] = (r["kind"], r["content"])

        diffs = []
        for path, (kind, pre_content) in pre_images.items():
            exists_now = os.path.exists(path)
            now_content = b""
            if exists_now and os.path.isfile(path):
                try:
                    with open(path, "rb") as f:
                        now_content = f.read()
                except Exception:
                    pass

            if kind == "missing":
                if exists_now:
                    lines = now_content.decode("utf-8", errors="replace").splitlines()
                    diffs.append({
                        "path": path,
                        "change_type": "created",
                        "additions": len(lines),
                        "deletions": 0,
                    })
                else:
                    diffs.append({
                        "path": path,
                        "change_type": "unchanged",
                        "additions": 0,
                        "deletions": 0,
                    })
            elif kind == "file":
                if not exists_now:
                    lines = (pre_content or b"").decode("utf-8", errors="replace").splitlines()
                    diffs.append({
                        "path": path,
                        "change_type": "deleted",
                        "additions": 0,
                        "deletions": len(lines),
                    })
                else:
                    pre_lines = (pre_content or b"").decode("utf-8", errors="replace").splitlines()
                    now_lines = now_content.decode("utf-8", errors="replace").splitlines()
                    if pre_content == now_content:
                        diffs.append({
                            "path": path,
                            "change_type": "unchanged",
                            "additions": 0,
                            "deletions": 0,
                        })
                    else:
                        matcher = difflib.SequenceMatcher(None, pre_lines, now_lines)
                        adds = 0
                        dels = 0
                        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
                            if tag == "insert":
                                adds += (j2 - j1)
                            elif tag == "delete":
                                dels += (i2 - i1)
                            elif tag == "replace":
                                dels += (i2 - i1)
                                adds += (j2 - j1)
                        diffs.append({
                            "path": path,
                            "change_type": "modified",
                            "additions": adds,
                            "deletions": dels,
                        })

        diffs.sort(key=lambda d: d["path"])
        return diffs

    def revert_check(self, turn_id: str) -> dict:
        """干跑分析回滚该回合的影响面（零副作用，不写盘，不落盘）。"""
        diffs = self.get_turn_diffs(turn_id)
        will_restore = []
        will_delete = []
        conflicts = []
        affected = []

        for d in diffs:
            p = d["path"]
            c_type = d["change_type"]
            affected.append(p)
            if c_type == "created":
                will_delete.append(p)
            elif c_type in ("modified", "deleted"):
                will_restore.append(p)

        return {
            "turn_id": turn_id,
            "dry_run": True,
            "affected_files": affected,
            "will_restore": will_restore,
            "will_delete": will_delete,
            "conflicts": conflicts,
            "total_changes": len(affected),
        }

    # ---- inspection -----------------------------------------------------

    def list_since(self, session_id: str, seq: int, include_folded: bool = False) -> list[dict]:
        """Snapshot rows at or after ``seq``, oldest first.

        Folded rows are excluded by default: they describe a branch the user
        already walked away from, and mixing them into the live list would make
        the timeline claim changes that are no longer on disk.
        """
        sql = ("SELECT id, seq, tool_name, call_id, path, kind, created_at, "
               "archived, fold_id, label "
               "FROM snapshots WHERE session_id=? AND seq>=?")
        if not include_folded:
            sql += " AND COALESCE(archived,0)=0"
        rows = self._conn.execute(sql + " ORDER BY id ASC", (session_id, int(seq))).fetchall()
        return [dict(r) for r in rows]

    def checkpoints(self, session_id: str) -> list[dict]:
        """One row per checkpoint (= per user-turn ``seq``), oldest first.

        This is what the timeline axis draws. Aggregated in SQL rather than
        returning every snapshot row because the UI wants "this turn touched 3
        files", not 3 rows it has to group itself — and because the ``content``
        BLOBs must never travel to the frontend.

        Each row carries:
            seq: the checkpoint key, also the handle for rollback/branching.
            files: how many distinct paths this turn touched.
            tools: comma-joined tool names, for the node tooltip.
            label: user-given name, empty for an automatic point.
            recoverable: 0 when any path in the turn was too large to snapshot —
                the node must not offer a rollback it cannot honour.
            folded: 1 when this checkpoint's changes were already rolled back.
        """
        rows = self._conn.execute(
            "SELECT seq, "
            "       COUNT(DISTINCT path) AS files, "
            "       GROUP_CONCAT(DISTINCT tool_name) AS tools, "
            "       MIN(created_at) AS first_at, "
            "       MAX(created_at) AS last_at, "
            "       MAX(COALESCE(label,'')) AS label, "
            "       MIN(CASE WHEN kind='skip' THEN 0 ELSE 1 END) AS recoverable, "
            "       MIN(COALESCE(archived,0)) AS folded "
            "FROM snapshots WHERE session_id=? "
            "GROUP BY seq ORDER BY seq ASC",
            (session_id,),
        ).fetchall()
        out = []
        for r in rows:
            row = dict(r)
            row["recoverable"] = bool(row.get("recoverable"))
            row["folded"] = bool(row.get("folded"))
            row["tools"] = [t for t in str(row.get("tools") or "").split(",") if t]
            out.append(row)
        return out

    def paths_at(self, session_id: str, seq: int) -> list[dict]:
        """What one checkpoint touched, for the read-only preview.

        Preview must not touch the disk, so this reports the pre-image size and
        whether the file currently differs from it — enough to render "3 files
        changed, 1 deleted" without restoring anything.
        """
        rows = self._conn.execute(
            "SELECT path, kind, tool_name, LENGTH(content) AS bytes, created_at "
            "FROM snapshots WHERE session_id=? AND seq=? AND COALESCE(archived,0)=0 "
            "ORDER BY id ASC",
            (session_id, int(seq)),
        ).fetchall()
        out = []
        for r in rows:
            row = dict(r)
            row["exists_now"] = os.path.exists(row["path"])
            out.append(row)
        return out

    def label_checkpoint(self, session_id: str, seq: int, label: str) -> int:
        """Name a checkpoint (「这里是好状态」). Empty label clears it back to auto."""
        cur = self._conn.execute(
            "UPDATE snapshots SET label=? WHERE session_id=? AND seq=?",
            (str(label or ""), session_id, int(seq)),
        )
        self._conn.commit()
        return cur.rowcount or 0

    # ---- rollback -------------------------------------------------------

    def _fold(self, session_id: str, seq: int, fold_id: str) -> int:
        """Mark a seq range as folded away instead of deleting it.

        This one line is the difference between UB1 and what was here before.
        The old code ran ``DELETE FROM snapshots WHERE seq>=?``, which consumed
        the pre-images: after a rollback there was no record that those turns had
        ever changed anything, so the timeline could not show the branch and
        nothing could ever be lifted back out of it.
        """
        cur = self._conn.execute(
            "UPDATE snapshots SET archived=1, fold_id=? "
            "WHERE session_id=? AND seq>=? AND COALESCE(archived,0)=0",
            (fold_id, session_id, int(seq)),
        )
        self._conn.commit()
        return cur.rowcount or 0

    @staticmethod
    def _new_fold_id(session_id: str, seq: int) -> str:
        return f"{session_id}:{int(seq)}:{int(time.time())}"

    def rollback_since(self, session_id: str, seq: int) -> dict:
        """Restore every live snapshot with ``seq >= seq``, newest first.

        Idempotent: the rows are FOLDED (``archived=1``) rather than deleted, so a
        second rollback of the same range is a no-op while the record of what was
        folded survives for the timeline.
        """
        rows = self._conn.execute(
            "SELECT id, path, kind, content FROM snapshots "
            "WHERE session_id=? AND seq>=? AND COALESCE(archived,0)=0 ORDER BY id DESC",
            (session_id, int(seq)),
        ).fetchall()
        restored: list[str] = []
        deleted: list[str] = []
        skipped: list[str] = []
        errors: list[dict] = []
        for r in rows:
            path = r["path"]
            kind = r["kind"]
            try:
                if kind == "file":
                    Path(path).parent.mkdir(parents=True, exist_ok=True)
                    with open(path, "wb") as f:
                        f.write(r["content"] or b"")
                    restored.append(path)
                elif kind == "missing":
                    # Roll back = "make it not exist again".
                    if os.path.isfile(path):
                        os.unlink(path)
                    elif os.path.isdir(path):
                        try:
                            os.rmdir(path)
                        except OSError:
                            errors.append({"path": path, "error": "dir not empty"})
                            continue
                    deleted.append(path)
                elif kind == "dir":
                    Path(path).mkdir(parents=True, exist_ok=True)
                    restored.append(path)
                else:  # 'skip'
                    skipped.append(path)
            except Exception as exc:
                errors.append({"path": path, "error": str(exc)})
        fold_id = self._new_fold_id(session_id, seq)
        folded = self._fold(session_id, seq, fold_id)
        return {
            "restored": restored,
            "deleted": deleted,
            "skipped": skipped,
            "errors": errors,
            "count": len(restored) + len(deleted),
            "foldId": fold_id,
            "folded": folded,
        }

    def discard_since(self, session_id: str, seq: int) -> dict:
        """Fold a seq range away WITHOUT touching the disk.

        The chat-only withdraw: the user dropped those turns from history but
        kept the files as they are. Their snapshots can never be applied now
        (their checkpoint is gone), so they leave the live timeline — but they are
        folded, not deleted, for the same reason as :meth:`rollback_since`.

        Replaces a direct ``DELETE`` that ``http_server`` used to run against
        ``_conn`` from the outside.
        """
        fold_id = self._new_fold_id(session_id, seq)
        return {"foldId": fold_id, "folded": self._fold(session_id, seq, fold_id)}


    def copy_to_session(self, src_session: str, dst_session: str, max_seq: int) -> int:
        """Copy live snapshots with ``seq <= max_seq`` onto another session (UA1).

        A fork inherits the parent's history, so it has to inherit the pre-images
        that history refers to — otherwise the new branch's timeline shows turns
        that changed files and offers no way back for any of them.

        Copies, never moves: the parent's own rollback path has to keep working.
        Folded rows are left behind — they describe a branch the parent already
        walked away from, and re-seeding them into a fresh line would resurrect it.

        Returns:
            How many rows were copied.
        """
        rows = self._conn.execute(
            "SELECT seq, tool_name, call_id, path, kind, content, created_at, label "
            "FROM snapshots WHERE session_id=? AND seq<=? AND COALESCE(archived,0)=0 "
            "ORDER BY id ASC",
            (src_session, int(max_seq)),
        ).fetchall()
        for r in rows:
            self._conn.execute(
                "INSERT INTO snapshots (session_id, seq, tool_name, call_id, path, kind, "
                "content, created_at, archived, fold_id, label) VALUES (?,?,?,?,?,?,?,?,0,'',?)",
                (dst_session, r["seq"], r["tool_name"], r["call_id"], r["path"],
                 r["kind"], r["content"], r["created_at"], r["label"] or ""),
            )
        self._conn.commit()
        return len(rows)

    def clear_session(self, session_id: str) -> int:
        cur = self._conn.execute(
            "DELETE FROM snapshots WHERE session_id=?", (session_id,)
        )
        self._conn.commit()
        return cur.rowcount or 0


_singleton: Optional[SnapshotStore] = None


def get_snapshot_store() -> SnapshotStore:
    global _singleton
    if _singleton is None:
        _singleton = SnapshotStore()
    return _singleton


# --- Tool reversibility table -----------------------------------------------

# Reversibility policy: hard line between "we can undo this from
# our own DB" and "we can't". Reads never mutate; writes we snapshot before
# they run, so they *become* reversible. Everything below either escapes the
# workspace (git_push), leaves an audit trail we can't cleanly rewind
# (git_commit — reversible via `git reset` but only on a clean tree), or runs
# arbitrary code (bash), so we mark them irreversible and the UI warns.
IRREVERSIBLE_TOOLS = {
    "bash",
    "shell_executor",
    "python_executor",
    "git_push",
    "git_commit",
    "git_reset",
    "cron_create",
    "cron_delete",
}

# Tools whose reversibility we OWN via snapshot_store. Anything writing to disk
# that we snapshot pre-mutation.
REVERSIBLE_MUTATING_TOOLS = {
    "write_file",
    "edit_file",
    "delete_file",
    "move_file",
    "copy_file",
}


def is_reversible(tool_name: str) -> bool:
    """Best-guess reversibility BEFORE the call runs, for the optimistic badge.

    This is a table lookup on the tool name, so it can only answer "do we
    normally snapshot this kind of call". It cannot know whether this particular
    call's snapshot succeeded — for that, use :func:`reversible_after_capture`
    with the report :meth:`SnapshotStore.capture` returns. The card starts with
    this answer and is corrected when the call settles.

    - ``True`` for reads and for mutations we snapshot ourselves.
    - ``False`` for anything we can't recover from cleanly.
    """
    if tool_name in IRREVERSIBLE_TOOLS:
        return False
    if tool_name in REVERSIBLE_MUTATING_TOOLS:
        return True
    # Reads and everything else default to reversible=True — a read tool badged
    # "irreversible" would be noise, and unknown tools default to safe messaging.
    return True


def reversible_after_capture(tool_name: str, report: dict = None) -> bool:
    """The authoritative verdict, once we know what the snapshot actually got.

    Args:
        tool_name: The tool that ran.
        report: What :meth:`SnapshotStore.capture` returned, or None when no
            snapshot was attempted (a read tool, or a tool we don't track).

    Returns:
        False when the tool is inherently irreversible, or when it mutated files
        and we do NOT hold a complete pre-image. True otherwise.

    The difference from :func:`is_reversible` is the case that matters: a
    ``write_file`` over a file larger than the snapshot cap is in
    ``REVERSIBLE_MUTATING_TOOLS``, so the static table says "reversible", but
    nothing recoverable was stored. Rollback would report it as skipped and the
    user would discover the promise was empty at the worst possible moment.
    """
    if tool_name in IRREVERSIBLE_TOOLS:
        return False
    if not isinstance(report, dict):
        # No capture attempted: nothing was mutated by us, so there is nothing
        # to undo and the badge should stay quiet.
        return True
    return bool(report.get("recoverable"))


def mutating_paths_for(tool_name: str, args: dict) -> list[str]:
    """Which paths does this call touch? Returns [] for read-only tools."""
    if tool_name not in REVERSIBLE_MUTATING_TOOLS or not isinstance(args, dict):
        return []
    if tool_name in ("write_file", "edit_file", "delete_file"):
        p = args.get("path")
        return [p] if isinstance(p, str) and p else []
    if tool_name in ("move_file", "copy_file"):
        # Snapshot BOTH: the source (in case the caller undoes a move by
        # dropping the copy) and the destination (in case the copy overwrote
        # an existing file).
        out = []
        for k in ("src", "dst"):
            v = args.get(k)
            if isinstance(v, str) and v:
                out.append(v)
        return out
    return []
