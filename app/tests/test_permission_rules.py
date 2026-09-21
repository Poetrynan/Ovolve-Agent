"""Tests for permission_rules: matching precedence, pattern generalisation,

persistence, and the builtin seeding contract."""

import sqlite3

import pytest



from permission_rules import (

    PermissionRule,

    PermissionRuleStore,

    RuleBehavior,

    RuleScope,

    call_signature,

    suggest_pattern,

)





class FakeStorage:

    """Minimal stand-in: one in-memory sqlite + a kv dict. Mirrors the two

    Storage methods PermissionRuleStore touches (`_db`, `kv_get`, `kv_set`)."""



    def __init__(self):

        self._conn = sqlite3.connect(":memory:")

        self._conn.row_factory = sqlite3.Row

        self._kv = {}



    def _db(self, name):

        return self._conn



    def kv_get(self, key, ns="default", default=None):

        return self._kv.get((ns, key), default)



    def kv_set(self, key, value, ns="default"):

        self._kv[(ns, key)] = value





def store():

    return PermissionRuleStore(storage=FakeStorage())





# ── signature ──────────────────────────────────────────────────────────────



@pytest.mark.parametrize("args,expected", [

    ({"command": "pytest tests/a.py -q"}, "pytest tests/a.py -q"),

    ({"cmd": "npm  run   build"}, "npm run build"),   # whitespace collapsed

    ({"code": "print(1)"}, "print(1)"),

    ({"path": "src\\app\\main.py"}, "src/app/main.py"),  # separators normalised

    ({}, ""),

    ({"unrelated": 42}, ""),

])

def test_call_signature(args, expected):

    assert call_signature("bash", args) == expected





def test_command_wins_over_path():

    """A shell call that also carries a path is still about the command."""

    sig = call_signature("bash", {"command": "rm x.py", "path": "x.py"})

    assert sig == "rm x.py"





# ── pattern generalisation ─────────────────────────────────────────────────



@pytest.mark.parametrize("cmd,expected", [

    ("pytest tests/a.py -q", "pytest *"),      # the path is data, not identity

    ("git commit -m hi", "git commit *"),       # subcommand kept

    ("pytest", "pytest *"),

    ("pytest -q", "pytest *"),                  # a flag is not a subcommand

    ("npm run build", "npm run *"),

    ("python -m pytest x", "python -m pytest *"),

    ("python deploy.py", "python deploy.py *"),  # interpreter: the script IS identity

])

def test_suggest_pattern_generalises_commands(cmd, expected):

    assert suggest_pattern("bash", {"command": cmd}) == expected





def test_suggest_pattern_does_not_widen_an_interpreter_to_any_script():

    """`python deploy.py` must not become `python *` — that would allow any

    script at all, the whole hole we are avoiding."""

    p = suggest_pattern("bash", {"command": "python deploy.py"})

    assert p != "python *"

    assert not __import__("fnmatch").fnmatch("python wipe.py", p.lower())





def test_suggest_pattern_never_widens_git_to_everything():

    """`git *` would cover `git push --force`. Two tokens keeps force-push out

    of a rule the user created by approving a commit."""

    p = suggest_pattern("bash", {"command": "git commit -m x"})

    assert p != "git *"

    assert not __import__("fnmatch").fnmatch("git push --force", p)





def test_suggest_pattern_empty_for_non_command_tools():

    """A file-tool approval becomes a tool-wide rule, not a path glob the user

    never asked for."""

    assert suggest_pattern("write_file", {"path": "src/a.py"}) == ""





# ── matching ───────────────────────────────────────────────────────────────



def test_pattern_matches_the_class_not_the_call():

    """The whole reason patterns exist: a per-args hash re-asks on every new

    argument, which is the interruption we are removing."""

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="pytest *",

                         scope=RuleScope.GLOBAL))

    assert s.match("bash", {"command": "pytest tests/a.py"}) is not None

    assert s.match("bash", {"command": "pytest tests/b.py -q"}) is not None





def test_pattern_does_not_leak_to_other_commands():

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="pytest *",

                         scope=RuleScope.GLOBAL))

    assert s.match("bash", {"command": "rm -rf build"}) is None





def test_empty_pattern_is_tool_wide():

    s = store()

    s.add(PermissionRule(tool_name="write_file", pattern="",

                         scope=RuleScope.GLOBAL))

    assert s.match("write_file", {"path": "anything.py"}) is not None





def test_rule_is_scoped_to_its_tool():

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="*", scope=RuleScope.GLOBAL))

    assert s.match("write_file", {"path": "a.py"}) is None





def test_trailing_star_also_matches_a_bare_command():

    """`pytest *` has to cover a bare `pytest`, otherwise the pattern we suggest

    for an argument-less command fails to match the command it came from."""

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="mytool *",

                         scope=RuleScope.GLOBAL))

    assert s.match("bash", {"command": "mytool"}) is not None

    assert s.match("bash", {"command": "mytool --flag"}) is not None

    assert s.match("bash", {"command": "mytoolx"}) is None





def test_matching_is_case_insensitive():

    """A rule written on one machine must not stop applying on another."""

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="Git Commit *",

                         scope=RuleScope.GLOBAL))

    assert s.match("bash", {"command": "git commit -m x"}) is not None





# ── precedence ─────────────────────────────────────────────────────────────



def test_deny_beats_allow_regardless_of_insert_order():

    """An allow rule is a standing pass; letting ordering decide whether a deny

    applies would be a silent hole."""

    for order in (("allow", "deny"), ("deny", "allow")):

        s = store()

        for b in order:

            s.add(PermissionRule(tool_name="bash", pattern="*",

                                 behavior=RuleBehavior(b), scope=RuleScope.GLOBAL))

        won = s.match("bash", {"command": "anything"})

        assert won.behavior is RuleBehavior.DENY, order





def test_ask_beats_allow():

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="*",

                         behavior=RuleBehavior.ALLOW, scope=RuleScope.GLOBAL))

    s.add(PermissionRule(tool_name="bash", pattern="git push*",

                         behavior=RuleBehavior.ASK, scope=RuleScope.GLOBAL))

    won = s.match("bash", {"command": "git push origin main"})

    assert won.behavior is RuleBehavior.ASK





# ── scope ──────────────────────────────────────────────────────────────────



def test_workspace_rule_does_not_apply_in_another_workspace():

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="*", scope=RuleScope.WORKSPACE,

                         workspace_root="C:/proj/a"))

    assert s.match("bash", {"command": "x"}, workspace_root="C:/proj/a") is not None

    assert s.match("bash", {"command": "x"}, workspace_root="C:/proj/b") is None





def test_session_rule_does_not_leak_into_another_session():

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="*", scope=RuleScope.SESSION,

                         session_id="s1"))

    assert s.match("bash", {"command": "x"}, session_id="s1") is not None

    assert s.match("bash", {"command": "x"}, session_id="s2") is None





def test_global_rule_applies_everywhere():

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="*", scope=RuleScope.GLOBAL))

    assert s.match("bash", {"command": "x"}, workspace_root="anywhere",

                   session_id="whatever") is not None





def test_global_deny_beats_a_session_allow():

    """Scope decides applicability, behaviour decides strictness — a narrower

    scope is not a stronger claim."""

    s = store()

    s.add(PermissionRule(tool_name="bash", pattern="*", behavior=RuleBehavior.ALLOW,

                         scope=RuleScope.SESSION, session_id="s1"))

    s.add(PermissionRule(tool_name="bash", pattern="*", behavior=RuleBehavior.DENY,

                         scope=RuleScope.GLOBAL))

    won = s.match("bash", {"command": "x"}, session_id="s1")

    assert won.behavior is RuleBehavior.DENY





# ── persistence & CRUD ─────────────────────────────────────────────────────



def test_rules_survive_a_reload():

    fake = FakeStorage()

    s1 = PermissionRuleStore(storage=fake)

    s1.add(PermissionRule(tool_name="bash", pattern="pytest *",

                          scope=RuleScope.GLOBAL, source="user"))

    s2 = PermissionRuleStore(storage=fake)

    assert s2.match("bash", {"command": "pytest x"}) is not None





def test_remove_deletes_from_both_cache_and_table():

    fake = FakeStorage()

    s = PermissionRuleStore(storage=fake)

    # A pattern no builtin covers, so the assertion below can only be satisfied

    # by the removal actually working.

    r = s.add(PermissionRule(tool_name="bash", pattern="mytool *",

                             scope=RuleScope.GLOBAL))

    assert s.remove(r.id) is True

    assert s.match("bash", {"command": "mytool x"}) is None

    assert PermissionRuleStore(storage=fake).match("bash", {"command": "mytool x"}) is None





def test_remove_unknown_id_is_false():

    assert store().remove("nope") is False





# ── builtin seeding ────────────────────────────────────────────────────────



def test_builtins_unblock_the_verify_loop():

    """The seeded rules exist for one reason: a coding agent edits, verifies,

    edits again, and being asked before every verify is what makes it claim

    success it never checked."""

    s = store()

    for cmd in ("pytest tests/", "python -m py_compile x.py", "npx tsc --noEmit",

                "cargo check", "ruff check ."):

        won = s.match("bash", {"command": cmd})

        assert won is not None and won.behavior is RuleBehavior.ALLOW, cmd





def test_builtins_do_not_cover_manifest_driven_scripts():

    """`npm test` runs whatever the manifest says — arbitrary code wearing a

    build step's clothes. Some IDEs only auto-run that class inside a sandbox."""

    s = store()

    for cmd in ("npm test", "npm run test", "npm run build", "make", "make install", "python -c 'import os'", "python -m http.server"):

        assert s.match("bash", {"command": cmd}) is None, cmd





def test_builtins_do_not_cover_destructive_commands():

    s = store()

    for cmd in ("rm -rf build", "git push --force", "git reset --hard HEAD~3"):

        assert s.match("bash", {"command": cmd}) is None, cmd





def test_builtins_are_seeded_once_so_a_delete_sticks():

    """Re-deriving builtins from absence would resurrect a rule the user

    deleted, which is how a permission UI loses trust."""

    fake = FakeStorage()

    s1 = PermissionRuleStore(storage=fake)

    target = [r for r in s1.list() if r.source == "builtin"][0]

    s1.remove(target.id)

    s2 = PermissionRuleStore(storage=fake)

    assert all(r.id != target.id for r in s2.list())





def test_builtin_seeding_is_idempotent():

    fake = FakeStorage()

    n = len(PermissionRuleStore(storage=fake).list())

    assert len(PermissionRuleStore(storage=fake).list()) == n

