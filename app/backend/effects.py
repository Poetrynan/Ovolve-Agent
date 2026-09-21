"""effects.py — typed side effects: identity, precondition, postcondition, reconcile.

## Why `args_hash` was not enough

The side-effect ledger's first form recorded a hash of the tool arguments. That
answers exactly one question — "were these two requests spelled the same" — and
it is the wrong question after a crash or a pause. What a resumed run needs to
know is whether the effect **landed in the real world**, and two different
argument spellings can produce the same write while the same spelling can be
safe to repeat or catastrophic depending on what the file looks like now.

So each write-class call also records:

* ``effect_kind`` / ``target`` — what kind of change, to which canonical thing.
* ``operation_id`` — the stable identity of *this* change to *that* target, so a
  resumed run recognizes its own earlier attempt instead of comparing text.
* ``precondition`` — the target's observed state before we touched it.
* ``planned postcondition`` — the state we expect afterwards, where it can be
  computed cheaply and honestly (a full-content write, a delete, a move, a copy).

With those four, :func:`reconcile` can classify an interrupted effect into
``landed`` / ``not_started`` / ``conflict`` / ``unknown`` by looking at the file
system rather than at the transcript. Everything the caller cannot prove stays
``unknown`` — this module never guesses in the direction of "safe to redo".

## Git effects

Git gets the same treatment, with the repository — not a path from the
arguments — as the target, because no git tool takes a repo argument: they all
run in ``workspace_root``. The observable state of a repo is HEAD, HEAD's
message, the current branch, the staged set and the dirty set, and that is
enough to answer the question that matters after an interrupted run: *did my
commit land?* A commit's own sha cannot be predicted (it hashes the timestamp),
so the plan records the **message** instead and reconcile attributes a moved
HEAD by comparing it. Anything it cannot attribute stays ``unknown``.

## Deliberate limits

* HTTP and message effects are still untyped: their outcome lives on someone
  else's server, and the only honest precondition is an idempotency key the
  remote agrees to honour. :func:`classify` returns None for them, which keeps
  their existing advisory ledger behaviour instead of pretending to a certainty
  this module cannot deliver.
* ``edit_file`` gets a precondition but no planned postcondition: predicting the
  result means re-implementing the edit. It therefore reconciles as ``unknown``
  unless the file is byte-identical to before (``not_started``) — which is the
  truth, and better than a confident wrong answer.
* ``git_push`` can only ever answer ``landed`` or ``unknown``. A successful push
  updates the remote-tracking ref locally, so seeing our commit in
  ``<remote>/<branch>`` is proof it landed; *not* seeing it is not proof it
  didn't, because the process could have died between the remote accepting the
  push and the local ref being written.
* Arbitrary git through ``shell_executor`` is out of scope: the effect is keyed
  on tool name, and a shell command is not a modelled tool.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Optional

#: Files larger than this use a fast size+mtime hash rather than full sha256
MAX_HASH_BYTES = 8 * 1024 * 1024

#: Effect kinds. Strings (not an enum) because they are persisted in SQLite and
#: read by the recovery prompt builder; a value that outlives the process should
#: not depend on an import.
KIND_FILE_WRITE = "file_write"
KIND_FILE_DELETE = "file_delete"
KIND_FILE_MOVE = "file_move"
KIND_GIT_COMMIT = "git_commit"
KIND_GIT_BRANCH = "git_branch"
KIND_GIT_STAGE = "git_stage"
KIND_GIT_PUSH = "git_push"
KIND_GIT_PULL = "git_pull"

#: Kinds whose target is a repository root rather than a file. Everything that
#: observes or reconciles a target has to branch on this: `os.stat` on a repo
#: root says nothing about whether a commit landed.
GIT_KINDS = frozenset({KIND_GIT_COMMIT, KIND_GIT_BRANCH, KIND_GIT_STAGE,
                       KIND_GIT_PUSH, KIND_GIT_PULL})

#: tool name → (effect kind, the argument naming the target it changes)
_TOOL_EFFECTS: dict[str, tuple[str, str]] = {
    "write_file": (KIND_FILE_WRITE, "path"),
    "edit_file": (KIND_FILE_WRITE, "path"),
    "delete_file": (KIND_FILE_DELETE, "path"),
    "move_file": (KIND_FILE_MOVE, "dst"),
    "copy_file": (KIND_FILE_WRITE, "dst"),
}

#: git tool name → effect kind. Separate table because these tools take no
#: target argument at all: the repo comes from the workspace root.
_GIT_TOOL_EFFECTS: dict[str, str] = {
    "git_commit": KIND_GIT_COMMIT,
    "git_add": KIND_GIT_STAGE,
    "git_push": KIND_GIT_PUSH,
    "git_pull": KIND_GIT_PULL,
    "git_branch": KIND_GIT_BRANCH,
}


from dataclasses import dataclass, field
import time

#: Effect statuses
STATUS_PLANNED = "planned"
STATUS_STARTED = "started"
STATUS_LANDED = "landed"
STATUS_VERIFIED = "verified"
STATUS_NOT_STARTED = "not_started"
STATUS_CONFLICT = "conflict"
STATUS_UNKNOWN = "unknown"
STATUS_REVERTED = "reverted"

EFFECT_STATUSES = frozenset({
    STATUS_PLANNED, STATUS_STARTED, STATUS_LANDED, STATUS_VERIFIED,
    STATUS_NOT_STARTED, STATUS_CONFLICT, STATUS_UNKNOWN, STATUS_REVERTED,
})


@dataclass
class EffectRecord:
    """Typed representation of a side effect attempt."""
    operation_id: str
    goal_id: str = ""
    run_id: str = ""
    activity_id: str = ""
    tool_call_id: str = ""
    effect_kind: str = ""
    target: str = ""
    intent_hash: str = ""
    precondition: dict = field(default_factory=dict)
    precondition_hash: str = ""
    planned_payload_hash: str = ""
    status: str = STATUS_PLANNED
    postcondition: dict = field(default_factory=dict)
    postcondition_hash: str = ""
    verification_evidence_refs: list[str] = field(default_factory=list)
    attempt_count: int = 1
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "operation_id": self.operation_id,
            "goal_id": self.goal_id,
            "run_id": self.run_id,
            "activity_id": self.activity_id,
            "tool_call_id": self.tool_call_id,
            "effect_kind": self.effect_kind,
            "target": self.target,
            "intent_hash": self.intent_hash,
            "precondition": self.precondition,
            "precondition_hash": self.precondition_hash,
            "planned_payload_hash": self.planned_payload_hash,
            "status": self.status,
            "postcondition": self.postcondition,
            "postcondition_hash": self.postcondition_hash,
            "verification_evidence_refs": self.verification_evidence_refs,
            "attempt_count": self.attempt_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_row(cls, row: Any) -> EffectRecord:
        if not row:
            return cls(operation_id="")
        d = dict(row) if hasattr(row, "keys") else (row if isinstance(row, dict) else {})
        pre = d.get("precondition")
        post = d.get("postcondition")
        evidence = d.get("verification_evidence_refs")
        if isinstance(pre, str) and pre.startswith("{"):
            try:
                pre = json.loads(pre)
            except Exception:
                pass
        if isinstance(post, str) and post.startswith("{"):
            try:
                post = json.loads(post)
            except Exception:
                pass
        if isinstance(evidence, str) and evidence.startswith("["):
            try:
                evidence = json.loads(evidence)
            except Exception:
                pass

        return cls(
            operation_id=str(d.get("operation_id") or ""),
            goal_id=str(d.get("goal_id") or ""),
            run_id=str(d.get("run_id") or ""),
            activity_id=str(d.get("activity_id") or ""),
            tool_call_id=str(d.get("tool_call_id") or ""),
            effect_kind=str(d.get("effect_kind") or d.get("kind") or ""),
            target=str(d.get("target") or ""),
            intent_hash=str(d.get("intent_hash") or d.get("args_hash") or ""),
            precondition=pre if isinstance(pre, dict) else {},
            precondition_hash=str(d.get("precondition_hash") or d.get("precondition_state") or ""),
            planned_payload_hash=str(d.get("planned_payload_hash") or d.get("planned_state") or ""),
            status=str(d.get("status") or STATUS_PLANNED),
            postcondition=post if isinstance(post, dict) else {},
            postcondition_hash=str(d.get("postcondition_hash") or d.get("observed_postcondition") or ""),
            verification_evidence_refs=list(evidence) if isinstance(evidence, (list, tuple)) else [],
            attempt_count=int(d.get("attempt_count") or 1),
            created_at=float(d.get("created_at") or time.time()),
            updated_at=float(d.get("updated_at") or time.time()),
        )



def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_target(path: str, workspace_root: str = "") -> str:
    """A stable name for the thing being changed.

    Absolute, normalised, case-folded on Windows. Two spellings of one file
    (``./a/b.txt`` vs ``a\\b.txt``) must produce the same target, or the whole
    identity chain built on it splits in two.
    """
    raw = str(path or "")
    if not raw:
        return ""
    try:
        if not os.path.isabs(raw) and workspace_root:
            raw = os.path.join(workspace_root, raw)
        out = os.path.normpath(os.path.abspath(raw))
    except Exception:  # noqa: BLE001 — a malformed path must not break the call
        return raw
    return out.replace("\\", "/").lower() if os.name == "nt" else out


def file_state(path: str) -> dict:
    """Observed state of one file: existence plus a content identity.

    Never raises. An unreadable file yields ``{"exists": True, "hash": ""}`` —
    "it is there but we cannot characterise it", which reconcile treats as
    unknown rather than as unchanged.
    """
    state: dict = {"exists": False, "hash": "", "size": 0}
    try:
        st = os.stat(path)
    except (OSError, ValueError):
        return state
    state["exists"] = True
    state["size"] = int(getattr(st, "st_size", 0) or 0)
    if state["size"] > MAX_HASH_BYTES:
        state["hash"] = f"size:{state['size']}:mtime:{int(getattr(st, 'st_mtime', 0))}"
        return state
    try:
        with open(path, "rb") as fh:
            state["hash"] = _sha256(fh.read())
    except OSError:
        state["hash"] = ""
    return state


_MISSING = "<missing>"


def state_hash(state: dict) -> str:
    """One short string standing for an observed state, comparable across runs."""
    if not state or not state.get("exists"):
        return _MISSING
    h = str(state.get("hash") or "")
    return h or f"opaque:{state.get('size', 0)}"


def repo_root(path: str) -> str:
    """The repository containing ``path``, or "" — found by walking up.

    Deliberately not ``git rev-parse --show-toplevel``: this runs on the
    classify path of every git tool call, and a directory walk answers the same
    question without a subprocess. A linked worktree's ``.git`` is a file rather
    than a directory, so both are accepted.
    """
    cur = str(path or "")
    if not cur:
        return ""
    try:
        cur = os.path.normpath(os.path.abspath(cur))
    except Exception:  # noqa: BLE001
        return ""
    for _ in range(64):  # bounded: a symlink loop must not hang a tool call
        if os.path.exists(os.path.join(cur, ".git")):
            return cur
        parent = os.path.dirname(cur)
        if not parent or parent == cur:
            return ""
        cur = parent
    return ""


def _git_out(repo: str, args: list) -> tuple:
    """Run one read-only git command in ``repo``. Returns ``(ok, stdout)``.

    Through ``executors.tracked_run`` so the stop button can reach it: these run
    inside a tool call, and an unreachable child is exactly the bug Phase 1
    closed. Any failure is ``(False, "")`` — a state we could not read must
    reconcile as unknown, never as unchanged.
    """
    try:
        from executors import tracked_run
        proc = tracked_run(["git", "-c", "core.quotePath=false"] + list(args),
                           capture_output=True, text=True, encoding="utf-8",
                           errors="replace", cwd=repo, timeout=15)
    except Exception:  # noqa: BLE001
        return False, ""
    if getattr(proc, "returncode", 1) != 0:
        return False, ""
    return True, str(getattr(proc, "stdout", "") or "")


def _short(blob: str) -> str:
    return _sha256(str(blob or "").encode("utf-8", "replace"))[:32]


#: State and plan descriptors for git effects are JSON, not opaque digests: a
#: verdict like "HEAD moved but not to your commit" needs the fields, and a
#: branch name may legally contain any separator character we might have picked.
_GIT_STATE_PREFIX = "git:"
_GIT_PLAN_PREFIX = "gitplan:"


def _enc(prefix: str, obj: dict) -> str:
    try:
        return prefix + json.dumps(obj, sort_keys=True, ensure_ascii=False,
                                   default=str)
    except Exception:  # noqa: BLE001
        return ""


def _dec(prefix: str, blob: str) -> dict:
    """Decode a descriptor, or {} — including for descriptors we did not write."""
    raw = str(blob or "")
    if not raw.startswith(prefix):
        return {}
    try:
        out = json.loads(raw[len(prefix):])
    except Exception:  # noqa: BLE001
        return {}
    return out if isinstance(out, dict) else {}


def git_state(repo: str, branch_of_interest: str = "") -> dict:
    """Observed state of a repository.

    ``ok`` False means we could not read it (not a repo, git missing, timeout);
    callers must treat that as unknown rather than as "nothing changed". An
    unborn HEAD is a legitimate readable state with ``head`` == "".
    """
    state: dict = {"ok": False, "head": "", "head_msg": "", "branch": "",
                   "staged": "", "dirty": ""}
    if not repo:
        return state
    ok, top = _git_out(repo, ["rev-parse", "--is-inside-work-tree"])
    if not ok or top.strip() != "true":
        return state
    state["ok"] = True
    ok, head = _git_out(repo, ["rev-parse", "HEAD"])
    if ok:
        state["head"] = head.strip()
        ok_msg, msg = _git_out(repo, ["log", "-1", "--pretty=%B"])
        state["head_msg"] = _short(msg.strip()) if ok_msg else ""
    ok, branch = _git_out(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    state["branch"] = branch.strip() if ok else ""
    ok, staged = _git_out(repo, ["diff", "--cached", "--name-status"])
    state["staged"] = _short(staged) if ok else ""
    ok, dirty = _git_out(repo, ["status", "--porcelain"])
    state["dirty"] = _short(dirty) if ok else ""
    if branch_of_interest:
        state["branch_exists"] = branch_exists(repo, branch_of_interest)
    return state


def branch_exists(repo: str, name: str) -> bool:
    if not (repo and name):
        return False
    ok, _ = _git_out(repo, ["rev-parse", "--verify", "--quiet",
                            f"refs/heads/{name}"])
    return ok


def classify(tool_name: str, args: dict, workspace_root: str = "") -> Optional[dict]:
    """Typed description of what this call is about to change, or None.

    None means "this module has nothing better to offer than the existing
    advisory ledger" — an unknown tool, an HTTP or message effect, a read-only
    git action, a git tool outside a repository, or a call whose target argument
    is missing. Callers must keep working in that case; a typed effect is an
    upgrade, never a precondition for running a tool.
    """

    entry = _TOOL_EFFECTS.get(str(tool_name or ""))
    if not entry:
        git_kind = _GIT_TOOL_EFFECTS.get(str(tool_name or ""))
        if not git_kind:
            return None
        # `git_branch action=list` reads; only create/switch change anything.
        if git_kind == KIND_GIT_BRANCH and \
                str((args or {}).get("action") or "list") not in ("create", "switch"):
            return None
        repo = repo_root(workspace_root)
        if not repo:
            return None
        return {"kind": git_kind, "target": canonical_target(repo),
                "target_arg": ""}
    kind, target_arg = entry

    target = canonical_target(str((args or {}).get(target_arg) or ""), workspace_root)
    if not target:
        return None
    out = {"kind": kind, "target": target, "target_arg": target_arg}
    if kind == KIND_FILE_MOVE:
        out["source"] = canonical_target(str((args or {}).get("src") or ""),
                                         workspace_root)
    return out


def intent_hash(tool_name: str, args: dict) -> str:
    """Hash of the *request*. Kept as an audit field, no longer the identity."""
    try:
        blob = json.dumps({"tool": tool_name, "args": args}, sort_keys=True,
                          ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        blob = f"{tool_name}:{args!r}"
    return _sha256(blob.encode("utf-8"))


def operation_id(scope: str, kind: str, target: str, intent: str) -> str:
    """Stable identity of one external change.

    Deterministic on purpose: a resumed run recomputes the same id for the same
    intended change and therefore finds its own earlier attempt. ``scope`` is the
    goal id when there is one, else the session id — an unattended goal's writes
    must not be mistaken for an interactive session's.
    """
    blob = "|".join([str(scope or ""), str(kind or ""), str(target or ""),
                     str(intent or "")])
    return _sha256(blob.encode("utf-8"))[:32]


def _git_plan(tool_name: str, args: dict) -> str:
    """The planned postcondition of a git tool, as a descriptor or "".

    Not a state hash: a commit's sha hashes the author timestamp, so it cannot
    be predicted at all. What *can* be recorded is the intent that makes a moved
    HEAD attributable — the commit message, the branch being switched to, the
    remote being pushed. ``git_add`` and ``git_pull`` get nothing: staging is
    idempotent and a merge result is not predictable, so both reconcile on the
    precondition alone.
    """
    a = args or {}
    if tool_name == "git_commit":
        # "" when the tool drafts the message itself — then a moved HEAD stays
        # unattributable, which is the truth.
        msg = str(a.get("message") or "").strip()
        return _enc(_GIT_PLAN_PREFIX, {"kind": KIND_GIT_COMMIT,
                                       "message_hash": _short(msg) if msg else ""})
    if tool_name == "git_branch":
        action = str(a.get("action") or "")
        name = str(a.get("name") or "")
        if action not in ("create", "switch") or not name:
            return ""
        return _enc(_GIT_PLAN_PREFIX, {"kind": KIND_GIT_BRANCH,
                                       "action": action, "branch": name})
    if tool_name == "git_push":
        return _enc(_GIT_PLAN_PREFIX, {
            "kind": KIND_GIT_PUSH,
            "remote": str(a.get("remote") or "origin"),
            # "" = whatever branch HEAD was on; reconcile reads it back from the
            # precondition rather than guessing at verdict time.
            "branch": str(a.get("branch") or "")})
    return ""


def planned_state_hash(tool_name: str, args: dict) -> str:
    """The target's expected state hash AFTER a successful call, or "".

    "" is not a failure — it means this effect's outcome cannot be predicted
    without redoing the work (``edit_file``), so reconcile will decline to
    certify a landing instead of inventing one.

    The newline translation is not a detail: ``write_file`` writes through
    ``file_agent.atomic_write``, which opens in TEXT mode, so on Windows every
    ``\\n`` in the model's content reaches the disk as ``\\r\\n``. Hashing the raw
    string made every predicted state wrong on that platform — reconcile would
    have reported ``conflict`` for a write that landed exactly as asked, which is
    worse than having no prediction at all.
    """
    name = str(tool_name or "")
    a = args or {}
    if name in _GIT_TOOL_EFFECTS:
        return _git_plan(name, a)
    if name == "write_file":

        if a.get("append"):
            return ""  # depends on the current tail; not predictable here
        content = a.get("content")
        if not isinstance(content, str):
            return ""
        enc = str(a.get("encoding") or "utf-8")
        try:
            return _sha256(content.replace("\n", os.linesep).encode(enc))
        except (LookupError, UnicodeEncodeError):
            return ""
    if name == "delete_file":
        return _MISSING
    if name == "copy_file":
        src = str(a.get("src") or "")
        return state_hash(file_state(src)) if src else ""
    if name == "move_file":
        src = str(a.get("src") or "")
        return state_hash(file_state(src)) if src else ""
    return ""


def snapshot_hash(tool_name: str, args: dict, effect: dict) -> str:
    """The target's state *right now*, in the form reconcile can compare later.

    One function for both the precondition and the observed postcondition, so
    the two can never be recorded in different vocabularies. File effects keep
    producing exactly what ``state_hash(file_state(...))`` produced before 0013,
    so rows written by older builds still reconcile.
    """
    if not effect:
        return ""
    kind = str(effect.get("kind") or "")
    target = str(effect.get("target") or "")
    if kind in GIT_KINDS:
        # The branch a create/switch names is part of the *precondition*: "did
        # this branch already exist" is what separates "I created it" from "it
        # was always there".
        interest = (str((args or {}).get("name") or "")
                    if str(tool_name or "") == "git_branch" else "")
        st = git_state(target, interest)
        return _enc(_GIT_STATE_PREFIX, st) if st.get("ok") else ""
    return state_hash(file_state(target))


def reconcile(kind: str, target: str, precondition_hash: str,

              planned_hash: str) -> dict:
    """Classify an unfinished effect by looking at the world, not the transcript.

    Returns ``{"status", "detail"}`` where status is one of:

    * ``landed`` — the target already matches the planned outcome. Redoing the
      call would do it a second time.
    * ``not_started`` — the target is byte-identical to before the attempt. Safe
      to run once.
    * ``conflict`` — the target changed, but not into what this call intended.
      Something else wrote it (the user, another tool, a partial write). Never
      auto-redo; a human or the model has to look.
    * ``unknown`` — not enough evidence. The honest default.

    Git kinds are decided by the repository's state (HEAD, branch, staged set)
    instead of a file's bytes; see :func:`_reconcile_git`.
    """
    if str(kind or "") in GIT_KINDS:
        return _reconcile_git(kind, target, precondition_hash, planned_hash)
    current = state_hash(file_state(target)) if target else ""

    detail = {"target": target, "current": current[:16],
              "precondition": (precondition_hash or "")[:16],
              "planned": (planned_hash or "")[:16]}
    if not target or not current:
        return {"status": "unknown", "detail": detail}
    if planned_hash and current == planned_hash:
        return {"status": "landed", "detail": detail}
    if precondition_hash and current == precondition_hash:
        return {"status": "not_started", "detail": detail}
    if not planned_hash:
        return {"status": "unknown", "detail": detail}
    return {"status": "conflict", "detail": detail}


def _reconcile_git(kind: str, repo: str, pre_blob: str, plan_blob: str) -> dict:
    """Decide a git effect by reading the repository.

    The precondition carries HEAD, the branch and the staged set as they were
    before the attempt; the plan carries the intent (message, branch, remote).
    Between them most interrupted git operations become decidable without
    guessing — and the ones that don't say so.
    """
    now = git_state(repo)
    pre = _dec(_GIT_STATE_PREFIX, pre_blob)
    plan = _dec(_GIT_PLAN_PREFIX, plan_blob)
    detail = {"target": repo, "kind": kind,
              "head": str(now.get("head") or "")[:8],
              "pre_head": str(pre.get("head") or "")[:8],
              "branch": str(now.get("branch") or "")}
    if not now.get("ok") or not pre:
        # Not a repo any more, git unavailable, or a row written before typed
        # git effects existed. No evidence is not weak evidence.
        return {"status": "unknown", "detail": detail}
    head_moved = bool(now.get("head")) and now.get("head") != pre.get("head")
    unchanged = (now.get("head") == pre.get("head")
                 and now.get("staged") == pre.get("staged"))

    if kind == KIND_GIT_COMMIT:
        if head_moved:
            want = str(plan.get("message_hash") or "")
            if not want:
                # The tool drafts its own message, so a new commit cannot be
                # attributed to this attempt.
                return {"status": "unknown", "detail": detail}
            if now.get("head_msg") == want:
                return {"status": "landed", "detail": detail}
            # HEAD moved to a commit that is not ours: another process (or the
            # user) committed. Committing again would stack on top of that.
            return {"status": "conflict", "detail": detail}
        if unchanged:
            return {"status": "not_started", "detail": detail}
        return {"status": "unknown", "detail": detail}

    if kind == KIND_GIT_BRANCH:
        name = str(plan.get("branch") or "")
        if not name:
            return {"status": "unknown", "detail": detail}
        detail["plan_branch"] = name
        if str(plan.get("action")) == "switch":
            if now.get("branch") == name:
                return {"status": "landed", "detail": detail}
            if now.get("branch") == pre.get("branch"):
                return {"status": "not_started", "detail": detail}
            return {"status": "conflict", "detail": detail}
        exists_now = branch_exists(repo, name)
        if not exists_now:
            return {"status": "not_started", "detail": detail}
        if pre.get("branch_exists") is False:
            return {"status": "landed", "detail": detail}
        # It exists and already existed before — creating it again would just
        # fail; nothing here is evidence about our attempt.
        return {"status": "unknown", "detail": detail}

    if kind == KIND_GIT_PUSH:
        return _reconcile_push(repo, pre, plan, detail)

    # git_add / git_pull: no predictable outcome, so the precondition is the
    # only evidence. "Nothing moved" is a real answer; anything else is not.
    if unchanged and now.get("dirty") == pre.get("dirty"):
        return {"status": "not_started", "detail": detail}
    return {"status": "unknown", "detail": detail}


def _reconcile_push(repo: str, pre: dict, plan: dict, detail: dict) -> dict:
    """``landed`` or ``unknown``, never anything else.

    A push that the remote accepted also writes ``refs/remotes/<remote>/<branch>``
    locally, so finding our commit there is proof. The converse is not true: the
    process can die after the remote accepted and before that ref is written, and
    a fetch by anyone else can also advance it. So "not there" buys us nothing,
    and claiming ``not_started`` would invite a second push of a force-push.
    """
    remote = str(plan.get("remote") or "origin")
    branch = str(plan.get("branch") or "") or str(pre.get("branch") or "")
    want = str(pre.get("head") or "")
    detail["remote"] = f"{remote}/{branch}"
    if not (branch and want) or branch == "HEAD":
        return {"status": "unknown", "detail": detail}
    ok, sha = _git_out(repo, ["rev-parse", "--verify", "--quiet",
                              f"refs/remotes/{remote}/{branch}"])
    remote_sha = sha.strip() if ok else ""
    if not remote_sha:
        return {"status": "unknown", "detail": detail}
    detail["remote_head"] = remote_sha[:8]
    if remote_sha == want:
        return {"status": "landed", "detail": detail}
    # The remote ref moved past our commit — it still contains it, which is what
    # "our push landed" means.
    contained, _ = _git_out(repo, ["merge-base", "--is-ancestor", want,
                                   remote_sha])
    if contained:
        return {"status": "landed", "detail": detail}
    return {"status": "unknown", "detail": detail}
