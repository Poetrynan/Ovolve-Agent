"""permission_rules.py — 持久化权限规则：按「工具 + 参数模式」匹配 allow/ask/deny。

# 为什么需要这一层

在此之前，用户点头的产物是 ``risk_control.PermissionRecord``：工具名 + 参数
md5 + 单次消费 + 15 分钟 TTL。它回答的是「这一次可以吗」，而且只回答一次。

后果是 Agent 做不完长任务。改 30 个文件就要批 30 次；跑一次 `pytest` 批一次，
改完再跑再批一次。每次打断都要用户回到窗口打一个「同意」，中间的思路全断。
业界同类产品普遍采用权限白名单（工具允许列表 / 命令允许列表 /
URL 允许列表），没有一家只靠单次授权撑着——因为撑不住。

这个模块补的就是那件事：一条规则不是「这次可以」，而是「这类调用以后都这样
处理」。用户批准时可以选择顺手留下一条规则（允许列表增量更新是同一个动作），
规则落 SQLite，跨会话跨重启有效。

# 为什么是 glob 而不是 md5

md5 精确哈希天生只能匹配「同一次调用」：`pytest tests/a.py` 和
`pytest tests/b.py` 哈希不同，于是第二次又问一遍。规则要匹配的是**同一类**
调用，所以匹配对象必须是调用的可读签名（shell 是命令文本，文件工具是路径），
匹配方式是 glob：把 `git commit -m "..."` 归约成 `git commit` 这类签名。

用 glob 不用正则是刻意的：模式由用户手写，正则的回溯爆炸和误写代价都太高，
而 `fnmatch` 表达力刚好够 `npm run *` / `src/**` 这类需求。

# 优先级：deny 永远赢

一条 allow 规则本质是一张长期有效的通行证，所以必须有东西压得住它：
deny > ask > allow，且 deny 规则和 CRITICAL 地板都在 pipeline 的 GLOBAL 段
返回，靠 DENY 短路挡在 allow 之前。这不是保守，是这套设计能成立的前提——
允许列表旁边必须配拒绝列表，规则行为里也要有 deny 这一档，
存在的唯一理由就是让 allow 不能是全集。
"""
from __future__ import annotations

import fnmatch
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

class RuleBehavior(str, Enum):
    """What a matching rule does. Strictness order: ALLOW < ASK < DENY."""

    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


#: deny beats ask beats allow. Used to pick a winner when several rules match.
_BEHAVIOR_RANK = {RuleBehavior.ALLOW: 0, RuleBehavior.ASK: 1, RuleBehavior.DENY: 2}


class RuleScope(str, Enum):
    """How far a rule reaches.

    ``SESSION`` dies with the chat, ``WORKSPACE`` is remembered per project (the
    useful default — "in this repo, `pytest` is fine"), ``GLOBAL`` is everywhere.
    A narrower scope is not weaker: scope decides *applicability*, behaviour
    decides *strictness*. A global deny still beats a session allow.
    """

    SESSION = "session"
    WORKSPACE = "workspace"
    GLOBAL = "global"


#: Argument keys that carry the "what is actually being run" text, in priority
#: order. First hit wins. These are the keys our shell/interpreter executors
#: already use — see executors.py and danger_classifier.payload_of.
_COMMAND_KEYS = ("command", "cmd", "script", "code")

#: Argument keys that carry a filesystem target.
_PATH_KEYS = ("path", "file_path", "filepath", "target", "filename", "file")


def call_signature(tool_name: str, args: dict = None) -> str:
    """The human-readable string a rule pattern matches against.

    Empty when the call has nothing pattern-worthy — such a call can only be
    matched by a tool-wide rule (one with no pattern), which is intentional:
    inventing a signature out of an opaque arg dict would make patterns match
    things the user never looked at.
    """
    a = args or {}
    for key in _COMMAND_KEYS:
        v = a.get(key)
        if isinstance(v, str) and v.strip():
            return " ".join(v.strip().split())
    for key in _PATH_KEYS:
        v = a.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip().replace("\\", "/")
    return ""


#: Heads where the first argument IS the identity of what runs, not data for it.
#: `pytest tests/a.py` runs pytest; `python a.py` runs a.py. Generalising the
#: second case to `python *` would turn "always allow this one script" into
#: "always allow any Python", which is a hole, not a convenience.
_INTERPRETER_HEADS = {
    "python", "python3", "py", "node", "nodejs", "deno", "bun", "ruby", "perl",
    "php", "sh", "bash", "zsh", "powershell", "pwsh", "cmd", "osascript",
}


def _looks_like_subcommand(token: str) -> bool:
    """A bare verb like `commit` / `run` / `check`, not a flag or a path."""
    if not token or token.startswith("-"):
        return False
    return not any(c in token for c in "/\\.=*\"'")


def suggest_pattern(tool_name: str, args: dict = None) -> str:
    """The pattern to propose when the user says "always allow this".

    Generalises one call into a class of calls, the way industry peers'
    ``suggested_allowlist_entry`` + ``subcommand_tokens`` do: keep the tokens
    that say *what is being run*, drop the ones that are merely *what it runs on*.

        pytest tests/a.py -q   ->  pytest *
        git commit -m "..."    ->  git commit *
        npm run build          ->  npm run *
        python -m pytest x     ->  python -m pytest *
        python deploy.py       ->  python deploy.py *

    Dropping too much is the dangerous direction: `git *` would cover
    `git push --force`, and `python *` would cover any script. Keeping too much
    is merely useless — the rule stops matching, which is the failure mode we
    are here to fix. So the rule is: keep the head, keep a subcommand if there
    is one, keep the script path when the head is an interpreter, drop the rest.

    Returns "" for anything that isn't a command, so a file-tool approval becomes
    a tool-wide rule rather than a path glob the user didn't ask for.
    """
    a = args or {}
    is_command = any(isinstance(a.get(k), str) and a.get(k, "").strip()
                     for k in _COMMAND_KEYS)
    if not is_command:
        return ""
    tokens = call_signature(tool_name, a).split()
    if not tokens:
        return ""
    head = tokens[0]
    rest = tokens[1:]
    parts = [head]
    if len(rest) >= 2 and rest[0] in ("-m", "--module") and _looks_like_subcommand(rest[1]):
        # `python -m pytest`: the module is what runs.
        parts += [rest[0], rest[1]]
    elif rest and _looks_like_subcommand(rest[0]):
        parts.append(rest[0])
    elif rest and head.lower() in _INTERPRETER_HEADS:
        parts.append(rest[0])
    return " ".join(parts) + " *"


@dataclass
class PermissionRule:
    """One standing decision about a class of tool calls."""

    tool_name: str
    #: glob against :func:`call_signature`. Empty = matches every call of this
    #: tool, which is why the UI must show it as "所有调用" and not as a blank.
    pattern: str = ""
    behavior: RuleBehavior = RuleBehavior.ALLOW
    scope: RuleScope = RuleScope.WORKSPACE
    workspace_root: str = ""
    session_id: str = ""
    #: ``builtin`` rules ship with the app and are re-seeded on boot; ``user``
    #: rules came from a real click and are never recreated once deleted.
    source: str = "user"
    note: str = ""
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    created_at: float = field(default_factory=time.time)


#: Shipped ALLOW rules, global scope, re-seeded on every boot (deleting one
#: sticks — see :meth:`PermissionRuleStore._seed_builtins`).
#:
#: The line drawn here: these are the commands that tell the agent *whether its
#: own change worked*. Compile, typecheck, test-run. They are the single largest
#: source of repeated confirmations for a coding agent — it edits, it verifies,
#: it edits again — and the verify step is the one the user least wants to be
#: interrupted for, because a refusal there just means the agent reports success
#: it never checked.
#:
#: Deliberately NOT seeded: `npm test`, `npm run test`, `npm run build`, `make`. Those execute
#: whatever the project's manifest says, which is an arbitrary-code hole dressed
#: up as a build step. Peers auto-run that class only inside a sandbox; we
#: have no sandbox yet, so they keep asking. `npm run typecheck` is in, because
#: while it is also manifest-driven, it is conventionally a pure check — and the user
#: can delete the rule if their project disagrees. `python *` is restricted to
#: verification modules (-m pytest/unittest/py_compile) and literal .py scripts rather than
#: unrestricted arbitrary execution.
_BUILTIN_RULES = (
    ("git status", "查看 git 状态"),
    ("git status *", "查看 git 状态"),
    ("git diff", "查看 git diff"),
    ("git diff *", "查看 git diff"),
    ("git log *", "查看 git 日志"),
    ("git branch", "查看 git 分支"),
    ("git branch *", "查看 git 分支"),
    ("ls", "列出目录"),
    ("ls *", "列出目录"),
    ("dir", "列出目录"),
    ("dir *", "列出目录"),
    ("pwd", "查看当前目录"),
    ("where *", "查找可执行文件"),
    ("which *", "查找可执行文件"),
    ("pytest *", "运行 pytest"),
    ("python -m pytest *", "运行 pytest"),
    ("python -m unittest *", "运行 unittest"),
    ("python -m py_compile *", "Python 语法检查"),
    ("python *.py", "运行 python 脚本"),
    ("python *.py *", "运行 python 脚本"),
    ("npx tsc *", "TypeScript 类型检查"),
    ("tsc *", "TypeScript 类型检查"),
    ("npm run typecheck*", "类型检查脚本"),
    ("go vet *", "Go 静态检查"),
    ("go build *", "Go 编译检查"),
    ("cargo check *", "Rust 编译检查"),
    ("cargo clippy *", "Rust lint"),
    ("ruff *", "Python lint"),
    ("eslint *", "JS/TS lint"),
    ("npx eslint *", "JS/TS lint"),
)

#: Which tools a builtin command rule applies to. A rule is (tool, pattern), so
#: the same pattern is seeded once per shell-ish tool.
_BUILTIN_TOOLS = ("bash", "shell_executor")


class PermissionRuleStore:
    """In-memory index of rules, backed by SQLite.

    Rules are few (tens, not thousands) and read on every non-low-risk tool
    call, so the whole set lives in memory and the DB is just the durable copy.
    Writes go through here so the cache and the table never diverge.
    """

    def __init__(self, storage=None):
        # storage is injected in tests; in production it's the process singleton.
        if storage is None:
            from storage import get_storage
            storage = get_storage()
        self._storage = storage
        self._rules: list[PermissionRule] = []
        self._ensure_table()
        self._load()
        self._seed_builtins()

    # ── persistence ─────────────────────────────────────────────────────────

    def _db(self):
        # Reuse the configs db — one more small, rarely-written table, no reason
        # to open a ninth connection for it.
        return self._storage._db("configs")

    def _ensure_table(self):
        self._db().execute(
            "CREATE TABLE IF NOT EXISTS permission_rules ("
            "id TEXT PRIMARY KEY, tool_name TEXT, pattern TEXT DEFAULT '', "
            "behavior TEXT DEFAULT 'allow', scope TEXT DEFAULT 'workspace', "
            "workspace_root TEXT DEFAULT '', session_id TEXT DEFAULT '', "
            "source TEXT DEFAULT 'user', note TEXT DEFAULT '', created_at INTEGER)"
        )
        self._db().commit()

    def _row_to_rule(self, r) -> PermissionRule:
        return PermissionRule(
            id=r["id"], tool_name=r["tool_name"], pattern=r["pattern"] or "",
            behavior=RuleBehavior(r["behavior"]), scope=RuleScope(r["scope"]),
            workspace_root=r["workspace_root"] or "", session_id=r["session_id"] or "",
            source=r["source"] or "user", note=r["note"] or "",
            created_at=float(r["created_at"] or 0),
        )

    def _load(self):
        rows = self._db().execute("SELECT * FROM permission_rules").fetchall()
        out = []
        for r in rows:
            try:
                out.append(self._row_to_rule(r))
            except (ValueError, KeyError):
                # A row with an enum value this version no longer knows: skip it
                # rather than crash the whole store on one bad record.
                continue
        self._rules = out

    def _seed_builtins(self):
        """Insert the shipped ALLOW rules once, on first ever boot.

        Guarded by a kv sentinel rather than by "is this rule missing?", because
        those two questions differ in exactly the case that matters: a user who
        deleted a builtin. Re-deriving from absence would resurrect it on the
        next restart, which is the kind of thing that makes people stop trusting
        a permission UI. Seeding once means a delete is permanent.
        """
        if self._storage.kv_get("permission_rules_seeded", ns="risk"):
            return
        for tool in _BUILTIN_TOOLS:
            for pattern, note in _BUILTIN_RULES:
                self.add(PermissionRule(
                    tool_name=tool, pattern=pattern, behavior=RuleBehavior.ALLOW,
                    scope=RuleScope.GLOBAL, source="builtin", note=note,
                ))
        self._storage.kv_set("permission_rules_seeded", "1", ns="risk")

    # ── CRUD ──────────────────────────────────────────────────────────────

    def add(self, rule: PermissionRule) -> PermissionRule:
        self._db().execute(
            "INSERT OR REPLACE INTO permission_rules "
            "(id, tool_name, pattern, behavior, scope, workspace_root, "
            "session_id, source, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (rule.id, rule.tool_name, rule.pattern, rule.behavior.value,
             rule.scope.value, rule.workspace_root, rule.session_id,
             rule.source, rule.note, int(rule.created_at)),
        )
        self._db().commit()
        # Keep the cache in step without a full reload.
        self._rules = [r for r in self._rules if r.id != rule.id] + [rule]
        return rule

    def remove(self, rule_id: str) -> bool:
        before = len(self._rules)
        self._rules = [r for r in self._rules if r.id != rule_id]
        self._db().execute("DELETE FROM permission_rules WHERE id=?", (rule_id,))
        self._db().commit()
        return len(self._rules) != before

    def list(self, workspace_root: str = "", session_id: str = "") -> list[PermissionRule]:
        """Rules applicable in a context, newest first. Empty filters = all."""
        out = [r for r in self._rules if self._applies(r, workspace_root, session_id)]
        return sorted(out, key=lambda r: r.created_at, reverse=True)

    # ── matching ────────────────────────────────────────────────────────────

    def _applies(self, rule: PermissionRule, workspace_root: str, session_id: str) -> bool:
        """Is this rule in scope for the given context?

        An empty filter means "don't filter on this axis" (used by the settings
        UI to list everything). A GLOBAL rule always applies; a WORKSPACE rule
        needs the roots to match; a SESSION rule needs the session to match.
        """
        if rule.scope is RuleScope.GLOBAL:
            return True
        if rule.scope is RuleScope.WORKSPACE:
            return not workspace_root or not rule.workspace_root or \
                rule.workspace_root == workspace_root
        # SESSION
        return not session_id or not rule.session_id or rule.session_id == session_id

    def match(self, tool_name: str, args: dict, workspace_root: str = "",
              session_id: str = "") -> Optional[PermissionRule]:
        """The winning rule for a call, or None.

        Among all in-scope rules whose pattern matches the call signature, the
        strictest behaviour wins (deny > ask > allow) — never the "first" or
        "most specific". A user who wrote one deny means it, and letting a
        broader allow out-vote it by ordering would be a silent hole. Ties in
        behaviour break toward the newer rule, so re-approving updates intent.
        """
        sig = call_signature(tool_name, args)
        candidates = [
            r for r in self._rules
            if r.tool_name == tool_name
            and self._applies(r, workspace_root, session_id)
            and self._pattern_matches(r.pattern, sig)
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda r: (_BEHAVIOR_RANK[r.behavior], r.created_at))

    @staticmethod
    def _pattern_matches(pattern: str, signature: str) -> bool:
        """Empty pattern = tool-wide (matches any call). Otherwise glob.

        Case-insensitive: shell heads and paths differ in case across platforms
        (`Git` vs `git`, Windows drive letters), and a case-sensitive glob would
        make a rule silently stop applying on a different machine.

        The trailing ` *` is treated as "and optionally more": `pytest *` matches
        a bare `pytest` too. Without this, the pattern we *suggest* for a bare
        `pytest` (`pytest *`) wouldn't match the very command it came from —
        fnmatch needs the literal space to be present, and a run with no args has
        none.
        """
        if not pattern:
            return True
        p, sig = pattern.lower(), signature.lower()
        if fnmatch.fnmatch(sig, p):
            return True
        if p.endswith(" *") and fnmatch.fnmatch(sig, p[:-2]):
            return True
        return False


_store: Optional[PermissionRuleStore] = None


def get_permission_rules() -> PermissionRuleStore:
    global _store
    if _store is None:
        _store = PermissionRuleStore()
    return _store


def set_permission_rules(store: Optional[PermissionRuleStore]) -> None:
    """Swap the process store. For tests, so exercising the real policy path
    doesn't seed rules into the user's actual database. Pass None to reset."""
    global _store
    _store = store
