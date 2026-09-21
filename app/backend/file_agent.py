"""
file_agent.py - File sub-agent (Specialist Architecture).

Domain: file read/write, search, edit, Git operations.
Does NOT do: system settings, browser ops, app management.
"""
from __future__ import annotations
import os, re, time, difflib, subprocess, shutil
from typing import Any, Optional
from result import Result, try_result
from event_bus import get_event_bus
from telemetry import get_telemetry, SpanName
from tools import ToolDef, get_tool_registry, shorten_path
from path_lock import write_lock


def atomic_write(path: str, data: str, encoding: str = "utf-8") -> Result:
    """Write data to path atomically: write .tmp → fsync → os.replace.

    The temp file is created in the same directory as the target so
    os.replace is a single atomic rename on the same filesystem.
    Returns Result.success on completion, Result.failure on any error.
    The temp file is always cleaned up on failure.
    """
    import tempfile
    directory = os.path.dirname(path) or "."
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError as e:
        return Result.failure(f"Cannot create directory {directory}: {e}")
    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding=encoding) as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass  # fail-open: 可选增强，失败不影响主流程
        return Result.failure(f"Atomic write to {path} failed: {e}")
    return Result.success(path)


def file_revision(path: str) -> str:
    """A cheap revision token (mtime:size) for optimistic-concurrency checks.

    edit_file callers that want to detect 'the file changed under me' pass
    this value as expected_revision; if the current revision differs when the
    edit runs, the model is told to re-read and retry.
    """
    try:
        st = os.stat(path)
        return f"{int(st.st_mtime)}:{st.st_size}"
    except OSError:
        return ""


class FileAgent:
    """File sub-agent: all file-domain tools."""

    DOMAIN = "file"

    def __init__(self, workspace: str = None):
        self.workspace = workspace or os.getcwd()
        self.bus = get_event_bus()
        self.telemetry = get_telemetry()
        self.tools = get_tool_registry()
        self._register_tools()

    def _register_tools(self):
        for td in self._build_tool_defs():
            self.tools.register(td)

    def _build_tool_defs(self) -> list[ToolDef]:
        return [
            ToolDef("read_text", "Read a text file with auto encoding detection.",
                {"type":"object","properties":{
                    "path":{"type":"string","description":"Path to the file. Use `find_files`/`search_code` first if you are not sure it exists or where it is."},
                    "offset":{"type":"integer","default":0,"description":"Start at this LINE number (0 = beginning), not a byte offset."},
                    "limit":{"type":"integer","default":0,"description":"How many LINES to read. 0 = the whole file."}},
                 "required":["path"]},
                _read_text_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="You know the path and need the actual contents. Always read "
                            "before editing — `edit_file` needs the exact existing text.",
                when_not_to_use="You do not know the path yet — use `find_files` or "
                                "`search_code` first. For binary files this returns "
                                "garbage; use `get_file_info` to check size/type instead."),
            ToolDef("write_file", "Write content to a file, REPLACING it entirely. Creates parent dirs.",
                {"type":"object","properties":{
                    "path":{"type":"string","description":"Path to write. Parent directories are created. If the file exists its entire contents are replaced (unless `append`)."},
                    "content":{"type":"string","description":"The file's ENTIRE new content. Anything not included here is lost."},
                    "append":{"type":"boolean","default":False,"description":"True appends instead of replacing. Use this for logs, never for source files."},
                    "encoding":{"type":"string","default":"utf-8"}},
                 "required":["path","content"]},
                _write_file_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="Creating a NEW file, or deliberately rewriting a whole small "
                            "file whose full contents you just read.",
                when_not_to_use="Changing part of an existing file — use `edit_file`. "
                                "Writing a file you have not read overwrites everything "
                                "in it, which is the single most common way to destroy "
                                "the user's work."),
            ToolDef("edit_file", "Replace an exact string in a file, leaving the rest untouched.",
                {"type":"object","properties":{
                    "path":{"type":"string","description":"File to edit. Read it first — an unread file's exact text is a guess."},
                    "old_string":{"type":"string","description":"Exact text to replace, whitespace and indentation included. Must match once and only once unless replace_all is set."},
                    "new_string":{"type":"string","description":"Replacement text. Pass an empty string to delete old_string."},
                    "replace_all":{"type":"boolean","description":"Replace every occurrence instead of failing on an ambiguous match.","default":False},
                    "expected_revision":{"type":"string","description":"Revision from read_text to detect concurrent edits."}},
                 "required":["path","old_string","new_string"]},
                _edit_file_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="Small, surgical edits when you know the exact text to replace.",
                when_not_to_use="Multi-hunk or large changes — prefer `apply_patch` with a unified diff."),
            ToolDef("apply_patch", "Apply a unified diff patch to a file (multi-hunk, FastApply-style).",
                {"type":"object","properties":{
                    "path":{"type":"string","description":"Target file path."},
                    "patch":{"type":"string","description":"Unified diff hunks (@@ -l,s +l,s @@ lines)."},
                    "expected_revision":{"type":"string","description":"Optional revision token from read_text."}},
                 "required":["path","patch"]},
                _apply_patch_impl, domain=self.DOMAIN, risk_level="medium",
                when_to_use="Changing multiple regions or when exact old_string match is fragile.",
                when_not_to_use="Creating a new file — use `write_file`. Single tiny replace — `edit_file` is fine."),
            ToolDef("replace_file_content",
                "Replace content in a file with indentation-tolerant matching. Accepts a search/replace pair, "
                "a SEARCH/REPLACE block, or a unified diff.",
                {"type":"object","properties":{
                    "path":{"type":"string","description":"Target file path."},
                    "search":{"type":"string","description":"Exact text to find. Leading indentation may drift from the file — it is realigned automatically. Pair with `replace`."},
                    "replace":{"type":"string","description":"Replacement text. Re-indented to the file's actual indentation when `search` matched at a different column."},
                    "aider_block":{"type":"string","description":"SEARCH/REPLACE block: `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`. Several blocks are applied in order, all-or-nothing."},
                    "diff":{"type":"string","description":"Unified diff hunks (@@ -l,s +l,s @@) applied via the patch engine instead of a search/replace."},
                    "allow_multiple":{"type":"boolean","default":False,"description":"Replace every exact occurrence instead of refusing an ambiguous match."},
                    "similarity_threshold":{"type":"number","default":0.8,"description":"Minimum Levenshtein similarity (0-1) for a tolerant match. Below this the edit is refused rather than guessed."},
                    "expected_revision":{"type":"string","description":"Revision token from read_text to detect concurrent edits."}},
                 "required":["path"]},
                _replace_file_content_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="An `edit_file` call failed because the text you copied differs from the file only "
                            "in indentation or a typo, or you are applying a model-authored SEARCH/REPLACE block "
                            "verbatim. Also the one tool that takes all three edit formats.",
                when_not_to_use="You have the exact string — `edit_file` is stricter and a strict failure is "
                                "useful information. Tolerant matching can land on a similar-looking region, so "
                                "never use it to 'force through' an edit you have not verified by reading the file."),

            ToolDef("delete_file", "Delete a file or empty directory.",
                {"type":"object","properties":{"path":{"type":"string","description":"File or empty directory to remove. Non-empty directories are refused; there is no recursive delete here on purpose."}},"required":["path"]},
                _delete_file_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="Removing a file you created this session, or one the user "
                            "explicitly asked to delete.",
                when_not_to_use="You just want to empty its contents (use `write_file` "
                                "with empty content) or replace it (use `edit_file`). "
                                "Deletes are hard to undo — never delete to 'clean up' "
                                "something the user did not mention."),
            ToolDef("move_file", "Move/rename a file.",
                {"type":"object","properties":{
                    "src":{"type":"string","description":"Existing path. Must be a file, not a directory."},
                    "dst":{"type":"string","description":"Destination path. If something already lives here it is overwritten, so check with `get_file_info` when you are not sure."}},
                 "required":["src","dst"]},
                _move_file_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="Renaming a file, or relocating one the user asked you to move. "
                            "Prefer this over write-then-delete: a move keeps git's rename "
                            "detection intact, so the diff stays reviewable.",
                when_not_to_use="Reorganising a layout nobody asked you to reorganise. A "
                                "move breaks every import, config path and link that "
                                "pointed at the old name, and those breaks surface far "
                                "from here. Also not for directories."),
            ToolDef("copy_file", "Copy a file.",
                {"type":"object","properties":{
                    "src":{"type":"string","description":"Existing file to copy from."},
                    "dst":{"type":"string","description":"Destination path. Overwritten if it exists."}},
                 "required":["src","dst"]},
                _copy_file_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="Duplicating a file the user wants duplicated — seeding a config "
                            "from an example, forking a template.",
                when_not_to_use="Making a `.bak` before editing. `edit_file` is already "
                                "surgical and the user has version control; backup copies "
                                "just leave litter they have to clean up and can end up "
                                "committed. Also not for directories."),
            ToolDef("get_file_info", "Get file metadata: size, mtime, permissions.",
                {"type":"object","properties":{
                    "path":{"type":"string","description":"File or directory to inspect."}},
                 "required":["path"]},
                _get_file_info_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="Deciding whether reading something is even feasible — a 40MB "
                            "log will blow the context window, and this tells you before "
                            "`read_text` does. Also the cheap way to confirm a path exists.",
                when_not_to_use="You want the contents. This returns no content at all, so "
                                "calling it first just to be safe costs a step for nothing."),
            ToolDef("diff_files", "Diff two files line by line.",
                {"type":"object","properties":{
                    "file_a":{"type":"string","description":"Left side — conventionally the original / expected one."},
                    "file_b":{"type":"string","description":"Right side — conventionally the changed / actual one."}},
                 "required":["file_a","file_b"]},
                _diff_files_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="Comparing two files that both exist on disk: an actual output "
                            "against an expected fixture, a config against its `.example`.",
                when_not_to_use="Looking at what YOU changed — that is `git_diff`, and it "
                                "compares against the committed state instead of needing "
                                "you to have kept a copy. Also useless on binaries."),
            ToolDef("git_status", "Get git status (short form).",
                {"type":"object","properties":{},"required":[]},
                _git_status_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="Before staging or committing, always. It is the only way to see "
                            "what the user already had in flight before you touched "
                            "anything — that work must not end up in your commit.",
                when_not_to_use="To find out what a change actually says; that is `git_diff`. "
                                "Status only names files."),
            ToolDef("git_add", "Stage files for commit.",
                {"type":"object","properties":{"paths":{"type":"array","items":{"type":"string"},"description":"Specific paths to stage. Prefer naming the files you changed over '.' — '.' also stages unrelated work the user had in progress."}},"required":["paths"]},
                _git_add_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="Right before `git_commit`, to choose exactly what goes in.",
                when_not_to_use="As a reflex after editing. Staging with no commit "
                                "coming just makes the user's `git status` confusing."),
            ToolDef("git_commit", "Create a git commit. Omit message to auto-generate a Conventional Commits message from the staged diff.",
                {"type":"object","properties":{
                    "message":{"type":"string","description":"Commit message. Omit it and one is drafted from the staged diff."}},
                 "required":[]},
                _git_commit_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="The user asked to commit. Stage first with `git_add` — this "
                            "commits what is STAGED, not what is merely changed.",
                when_not_to_use="You finished some edits and it feels tidy to commit. "
                                "Committing unasked mixes your work into the user's "
                                "history. Also never commit without looking at "
                                "`git_status` / `git_diff` first — unrelated changes and "
                                "secrets ride along silently."),
            ToolDef("git_commit_message", "Draft a Conventional Commits message for the staged diff without committing.",
                {"type":"object","properties":{},"required":[]},
                _git_commit_message_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="The user wants to review the wording before you commit, or they "
                            "want to commit by hand and just need the message.",
                when_not_to_use="You are about to commit anyway — `git_commit` with no "
                                "`message` drafts the same text and commits in one step, so "
                                "calling both wastes a turn. Reads the STAGED diff, so it "
                                "returns nothing useful before `git_add`."),
            ToolDef("git_push", "Push to remote.",
                {"type":"object","properties":{"remote":{"type":"string","default":"origin"},"branch":{"type":"string","description":"Omit to push the current branch."}},"required":[]},
                _git_push_impl, domain=self.DOMAIN, risk_level="high",
                requires_subprocess=True,
                when_to_use="The user explicitly asked to push. This is the only "
                            "acceptable trigger.",
                when_not_to_use="Anything else. A push is visible to other people and "
                                "cannot be quietly undone — it is not part of "
                                "'finishing the task'. Never push to main/master unless "
                                "the user said so."),
            ToolDef("git_pull", "Pull from remote.",
                {"type":"object","properties":{
                    "remote":{"type":"string","default":"origin"},
                    "branch":{"type":"string","description":"Omit to pull the tracked branch."}},
                 "required":[]},
                _git_pull_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="The user asked to pull, or a push was rejected as non-fast-forward "
                            "and they asked you to sort it out.",
                when_not_to_use="Unprompted, and never with a dirty tree. A pull rewrites the "
                                "files under the user's editor and can stop halfway in a "
                                "conflicted state that you cannot resolve for them. Check "
                                "`git_status` first."),
            ToolDef("git_diff", "Show git diff (staged or unstaged).",
                {"type":"object","properties":{
                    "staged":{"type":"boolean","default":False,"description":"False shows what is changed but NOT staged; True shows what a commit would actually contain. These are different sets and mixing them up is how unrelated work gets committed."}},
                 "required":[]},
                _git_diff_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="Reading the actual content of changes — yours or the user's — "
                            "before committing, or to understand what a turn has done so far.",
                when_not_to_use="As a substitute for reading the file you are about to edit. A "
                                "diff shows what moved, not what the surrounding code is."),
            ToolDef("git_log", "Show recent git commits.",
                {"type":"object","properties":{
                    "count":{"type":"integer","default":10,"description":"How many commits back. Keep it small — a long log is mostly context you will not use."}},
                 "required":[]},
                _git_log_impl, domain=self.DOMAIN, risk_level="low",
                when_to_use="Learning the project's commit-message conventions before writing "
                            "one, or finding when something changed.",
                when_not_to_use="Establishing what the code currently does — read the code. "
                                "Commit messages describe intent, and they age badly."),
            ToolDef("git_branch", "List/create/switch branches.",
                {"type":"object","properties":{
                    "action":{"type":"string","enum":["list","create","switch"],"description":"`list` is read-only and always safe. `create` and `switch` both change what the user's editor is looking at."},
                    "name":{"type":"string","description":"Branch name. Required for create/switch, ignored for list."}},
                 "required":["action"]},
                _git_branch_impl, domain=self.DOMAIN, risk_level="medium",
                requires_subprocess=True,
                when_to_use="`list` to find out where you are before doing anything git-shaped "
                            "— pushing from the wrong branch is the expensive mistake here. "
                            "`create`/`switch` only when the user asked.",
                when_not_to_use="Switching on your own initiative. Uncommitted work either "
                                "follows you onto the new branch or blocks the switch, and "
                                "both outcomes surprise the user. This cannot delete a "
                                "branch, by design."),
        ]

    async def handle(self, tool_name: str, args: dict, context: dict = None) -> Result:
        context = context or {}
        context.setdefault("workspace_root", self.workspace)
        span = self.telemetry.start_span(SpanName.TOOL_CALL, tool_name=tool_name, agent_name="file_agent")
        try:
            result = await self.tools.dispatch(tool_name, args, context)
            if not result.ok:
                span.set_error(result.error)
            return result
        finally:
            self.telemetry.end_span(span)


def _redirect(path, ctx, *, seed=True):
    """UA3 hook: where should this write actually land?

    Returns `path` unchanged for the main agent — the overlay only exists for
    isolated sub-agents. Imported lazily so `file_agent` keeps no hard dependency
    on the sub-agent machinery.
    """
    try:
        from work_copy import redirect_write
        return redirect_write(path, ctx, seed=seed)
    except Exception:
        return path


def _record_delete(path, ctx):
    """True when the delete was recorded in an overlay and must NOT be done for
    real. False for the main agent, which deletes normally."""
    try:
        from work_copy import record_delete
        return record_delete(path, ctx)
    except Exception:
        return False


def _isolated(ctx):
    """Whether this call runs inside an overlay. Lets a tool branch BEFORE it
    records anything, which matters for move/delete: a tombstone written ahead of
    the existence check would survive a failed call."""
    try:
        from work_copy import for_ctx
        return for_ctx(ctx) is not None
    except Exception:
        return False


def _read_through(path, ctx):
    """Read side of the overlay: prefer the sub-agent's own version of a file.

    Without this a sub-agent that writes a file and then re-reads it gets the
    ORIGINAL bytes back — it would look like its own write silently didn't happen,
    and the usual reaction is to write it again.

    Only ever redirects to a file that already exists in the overlay, so this can
    never invent a path or hide a real file.
    """
    try:
        from work_copy import for_ctx
        wc = for_ctx(ctx)
        if wc is None:
            return path
        dest = wc.overlay_path(path)
        return dest if dest and os.path.isfile(dest) else path
    except Exception:
        return path


def _read_text_impl(args, ctx):
    path = args.get("path", "")
    shown = path
    offset = args.get("offset", 0)
    limit = args.get("limit", 0)

    # Auto-route HTTP/HTTPS URLs to web fetcher
    clean_path = str(path or "").strip()
    if clean_path.startswith(("http://", "https://")):
        try:
            import requests, re
            headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
            resp = requests.get(clean_path, headers=headers, timeout=20)
            resp.raise_for_status()
            text = resp.text
            if "<html" in text.lower() or "<body" in text.lower():
                text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", text, flags=re.DOTALL | re.IGNORECASE)
                text = re.sub(r"<[^>]+>", " ", text)
                text = re.sub(r"[ \t]+", " ", text)
                text = re.sub(r"\n\s*\n+", "\n\n", text).strip()
            lines = text.splitlines(keepends=True)
            total = len(lines)
            if offset > 0:
                lines = lines[offset:]
            if limit > 0:
                lines = lines[:limit]
            numbered = [f"{i+offset+1:6d}|{line.rstrip()}" for i, line in enumerate(lines)]
            content = "\n".join(numbered)
            if total > len(numbered):
                content += f"\n... ({total - len(numbered)} more lines)"
            return Result.success(content, url=clean_path, total_lines=total)
        except Exception as e:
            return Result.failure(f"Failed to fetch URL {shown}: {e}")

    path = _read_through(path, ctx)
    if not os.path.isfile(path):
        return Result.failure(f"File not found: {shown}")
    for enc in ("utf-8", "utf-8-sig", "gbk", "latin-1"):
        try:
            with open(path, "r", encoding=enc) as f:
                lines = f.readlines()
            break
        except (UnicodeDecodeError, OSError):
            continue
    else:
        return Result.failure(f"Failed to read file (encoding): {shown}")
    total = len(lines)
    if offset > 0:
        lines = lines[offset:]
    if limit > 0:
        lines = lines[:limit]
    numbered = [f"{i+offset+1:6d}|{line.rstrip()}" for i, line in enumerate(lines)]
    content = "\n".join(numbered)
    if total > len(numbered):
        content += f"\n... ({total - len(numbered)} more lines)"
    return Result.success(content, path=shorten_path(shown, ctx.get("workspace_root")), total_lines=total)


def _write_file_impl(args, ctx):
    path = args.get("path", "")
    content = args.get("content", "")
    append = args.get("append", False)
    encoding = args.get("encoding", "utf-8")
    # UA3: an isolated sub-agent writes into its own overlay instead of the real
    # file. `shown` stays the real path so the message the model reads is about
    # the file it asked for, not a temp directory it knows nothing about.
    shown = path
    # Appending needs the existing bytes seeded in; a full overwrite does not.
    path = _redirect(path, ctx, seed=bool(append))
    with write_lock(path):
        parent = os.path.dirname(path)
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)
        if append:
            # Append cannot go through atomic_write (that replaces the whole
            # file). Explicit flush + fsync instead, so a crash right after we
            # report success cannot lose the bytes we claimed to have written.
            def _append() -> int:
                with open(path, "a", encoding=encoding) as f:
                    n = f.write(content)
                    f.flush()
                    os.fsync(f.fileno())
                    return n
            r = try_result(_append)
        else:
            # Full overwrite goes through atomic_write. The previous version
            # opened in "w" mode, which truncates *before* writing: a kill
            # between truncate and close (app quit, tree-kill on exit, disk
            # full) left the target empty or half-written with the original
            # content unrecoverable. It also never closed the handle
            # explicitly, so close-time flush errors surfaced in __del__ after
            # the result had already been returned -- the tool reported a
            # successful write of content that was never fully on disk.
            # edit_file has always used atomic_write; write_file is the one
            # that replaces an entire file, so it needed it more.
            pre = _precheck_write(path, content, ctx, shown=shown)
            if pre is not None:
                return pre
            r = atomic_write(path, content, encoding=encoding)
        if not r.ok:
            return Result.failure(f"Write failed: {r.error}")
    return Result.success(f"Wrote {len(content)} chars to {shorten_path(shown, ctx.get('workspace_root'))}")


def _edit_file_impl(args, ctx):
    path = args.get("path", "")
    old_str = args.get("old_string", "")
    new_str = args.get("new_string", "")
    replace_all = args.get("replace_all", False)
    shown = path
    # Seeded, because the whole operation is read→replace→write: without the
    # pre-image in the overlay the read would fail on the first edit of a file.
    path = _redirect(path, ctx, seed=True)
    # The whole read→replace→write must be atomic against other writers: two
    # concurrent edits of the same file each read the pre-image, and the last
    # writer clobbers the other's change with NO error on either side.
    with write_lock(path):
        if not os.path.isfile(path):
            return Result.failure(f"File not found: {shown}")
        # Optimistic concurrency: if the caller passed expected_revision and
        # the file has been touched since, the model's pre-image is stale.
        # Tell it to re-read rather than silently clobber the newer content.
        expected = args.get("expected_revision", "")
        if expected:
            current_rev = file_revision(path)
            if current_rev and current_rev != expected:
                return Result.failure(
                    f"File changed since you last read it (expected revision {expected}, "
                    f"current {current_rev}). Please re-read the file and retry."
                )
        r = try_result(lambda: open(path, "r", encoding="utf-8").read())
        if not r.ok:
            return Result.failure(f"Read failed: {r.error}")
        content = r.value
        count = content.count(old_str)
        if count == 0:
            # Smart auto-diagnosis: find near matches or line numbers to guide 1-step self-healing
            import re, difflib
            lines = content.splitlines()
            old_lines = old_str.splitlines()
            hint = ""
            if old_lines:
                first_target = old_lines[0].strip()
                norm_target = re.sub(r'\s+', '', first_target)
                candidates = []
                for idx, line in enumerate(lines):
                    norm_line = re.sub(r'\s+', '', line)
                    is_match = bool(norm_target and (norm_target in norm_line or norm_line in norm_target))
                    if not is_match and len(norm_target) >= 4 and len(norm_line) >= 4:
                        ratio = difflib.SequenceMatcher(None, norm_target, norm_line).ratio()
                        if ratio >= 0.6:
                            is_match = True
                    if is_match:
                        start_ctx = max(0, idx - 2)
                        end_ctx = min(len(lines), idx + len(old_lines) + 2)
                        preview = "\n".join([f"{i+1:4d} | {lines[i]}" for i in range(start_ctx, end_ctx)])
                        candidates.append((idx + 1, preview))
                        if len(candidates) >= 2:
                            break
                if candidates:
                    hints_str = "\n---\n".join([f"Near Line {ln}:\n{prv}" for ln, prv in candidates])
                    hint = f"\n\n💡 Auto-Diagnosis: `old_string` was not found exactly (check whitespace/indentation). Found candidate line(s) in {shown}:\n{hints_str}\nPlease adjust `old_string` to match the exact lines above."
            return Result.failure(f"old_string not found in {shown}.{hint}")
        if count > 1 and not replace_all:
            return Result.failure(f"old_string appears {count} times in {shown}; provide more surrounding context or set replace_all=True")
        new_content = content.replace(old_str, new_str) if replace_all else content.replace(old_str, new_str, 1)
        pre = _precheck_write(path, new_content, ctx, shown=shown)
        if pre is not None:
            return pre
        r2 = atomic_write(path, new_content)
        if not r2.ok:
            return Result.failure(f"Write failed: {r2.error}")
    return Result.success(f"Replaced {count} occurrence(s) in {shorten_path(shown, ctx.get('workspace_root'))}")


def _precheck_write(logical_path: str, content: str, ctx, *, shown: str = "") -> Optional[Result]:
    """Shadow-workspace precheck on the logical target path; fail-open."""
    try:
        from shadow_workspace import preview_write
        ws = str(ctx.get("workspace_root") or ctx.get("workspace") or "")
        target = shown or logical_path
        preview = preview_write(target, content, ws)
        if not preview.ok:
            return Result.failure(preview.format_error())
    except Exception:
        pass
    return None


def _apply_patch_impl(args, ctx):
    from rust_adapters.patch_engine import apply_unified_patch

    path = args.get("path", "")
    patch = args.get("patch", "")
    shown = path
    path = _redirect(path, ctx, seed=True)
    with write_lock(path):
        if not os.path.isfile(path):
            return Result.failure(f"File not found: {shown}")
        expected = args.get("expected_revision", "")
        if expected:
            current_rev = file_revision(path)
            if current_rev and current_rev != expected:
                return Result.failure(
                    f"File changed since you last read it (expected {expected}, current {current_rev}). Re-read and retry."
                )
        r = try_result(lambda: open(path, "r", encoding="utf-8").read())
        if not r.ok:
            return Result.failure(f"Read failed: {r.error}")
        result = apply_unified_patch(r.value, patch)
        if not result.ok:
            return Result.failure(f"Patch failed: {result.error}")
        pre = _precheck_write(path, result.content, ctx, shown=shown)
        if pre is not None:
            return pre
        r2 = atomic_write(path, result.content)
        if not r2.ok:
            return Result.failure(f"Write failed: {r2.error}")
    return Result.success(
        f"Applied {result.hunks_applied} hunk(s) to {shorten_path(shown, ctx.get('workspace_root'))}"
    )


def _replace_file_content_impl(args, ctx):
    """Unified replace: search/replace OR Aider block OR unified diff.

    Two backends behind one tool:
      * ovolve_core (Rust) Levenshtein matcher, with a pure-Python fallback of
        the *same* algorithm when the extension is not built (the common case
        on this dev machine) — both live in aider_parser.
      * patch_engine for the unified-diff path.

    Test-file refusal is deliberately NOT done here; that is path_guard's job
    and duplicating it would just drift out of sync.
    """
    import aider_parser

    path = args.get("path", "")
    search = args.get("search")
    replace = args.get("replace")
    aider_block = args.get("aider_block", "")
    diff = args.get("diff", "")
    allow_multiple = bool(args.get("allow_multiple", False))
    threshold = float(args.get("similarity_threshold", aider_parser.DEFAULT_SIMILARITY_THRESHOLD))

    if not path:
        return Result.failure("path is required")

    modes = [m for m, v in (("search", search is not None), ("aider", bool(aider_block)), ("diff", bool(diff))) if v]
    if not modes:
        return Result.failure(
            "Provide one edit: `search`(+`replace`), `aider_block`, or `diff`."
        )
    if len(modes) > 1:
        return Result.failure(
            f"Ambiguous request: {', '.join(modes)} given together. Send exactly one edit format."
        )

    shown = path
    path = _redirect(path, ctx, seed=True)
    with write_lock(path):
        if not os.path.isfile(path):
            return Result.failure(f"File not found: {shown}")
        expected = args.get("expected_revision", "")
        if expected:
            current_rev = file_revision(path)
            if current_rev and current_rev != expected:
                return Result.failure(
                    f"File changed since you last read it (expected revision {expected}, "
                    f"current {current_rev}). Please re-read the file and retry."
                )
        r = try_result(lambda: open(path, "r", encoding="utf-8").read())
        if not r.ok:
            return Result.failure(f"Read failed: {r.error}")
        original = r.value

        # ── Unified diff path (patch_engine) ──────────────────────────────
        if diff:
            from rust_adapters.patch_engine import apply_unified_patch
            patch_result = apply_unified_patch(original, diff)
            if not patch_result.ok:
                return Result.failure(f"Diff apply failed: {patch_result.error}")
            new_content = patch_result.content
            backend = "patch_engine"
            similarity = 1.0
            summary = f"applied {patch_result.hunks_applied} hunk(s) via unified diff"
        else:
            # ── search/replace and Aider block share the matcher ──────────
            if aider_block:
                outcome = aider_parser.apply_aider_blocks(original, aider_block, threshold)
                summary = f"applied {outcome.replaced_count} Aider block(s)"
            else:
                outcome = aider_parser.replace_once(
                    original, search, replace or "", threshold, allow_multiple
                )
                summary = f"replaced {outcome.replaced_count} occurrence(s)"
            if not outcome.ok:
                msg = outcome.error
                if outcome.diagnostics:
                    msg = f"{msg}\n\n💡 {outcome.diagnostics}"
                return Result.failure(f"{msg} (in {shown})")
            new_content = outcome.content
            backend = outcome.backend
            similarity = outcome.similarity

        if new_content == original:
            return Result.failure(
                f"No change: the replacement is identical to the existing content in {shown}."
            )

        pre = _precheck_write(path, new_content, ctx, shown=shown)
        if pre is not None:
            return pre
        r2 = atomic_write(path, new_content)
        if not r2.ok:
            return Result.failure(f"Write failed: {r2.error}")

    bytes_changed = abs(len(new_content.encode("utf-8")) - len(original.encode("utf-8")))
    return Result.success(
        f"replace_file_content: {summary} in {shorten_path(shown, ctx.get('workspace_root'))} "
        f"(backend={backend}, similarity={similarity:.2f})",
        backend=backend,
        similarity=round(similarity, 4),
        bytes_changed=bytes_changed,
    )


def _delete_file_impl(args, ctx):
    path = args.get("path", "")
    # UA3: inside an overlay a delete is a tombstone, not an unlink. The real file
    # only goes away if the parent accepts this sub-agent's changes at merge time.
    # The existence check comes FIRST: a tombstone recorded for a path that was
    # never there would be replayed at merge time as a delete nobody asked for.
    if _isolated(ctx):
        if not os.path.exists(_read_through(path, ctx)) and not os.path.exists(path):
            return Result.failure(f"Path not found: {path}")
        if _record_delete(path, ctx):
            return Result.success(f"Deleted: {shorten_path(path, ctx.get('workspace_root'))}")
    with write_lock(path):
        if not os.path.exists(path):
            return Result.failure(f"Path not found: {path}")
        if os.path.isdir(path):
            r = try_result(lambda: os.rmdir(path))
        else:
            r = try_result(lambda: os.unlink(path))
        if not r.ok:
            return Result.failure(f"Delete failed: {r.error}")
    return Result.success(f"Deleted: {shorten_path(path, ctx.get('workspace_root'))}")



def _move_file_impl(args, ctx):
    src, dst = args.get("src", ""), args.get("dst", "")
    # UA3: inside an overlay a move is "write the destination, tombstone the
    # source". Doing it as a real os.rename would move the file out from under the
    # other sub-agents that are still reading the workspace.
    #
    # Order matters: the source is resolved and copied BEFORE the tombstone,
    # because tombstoning drops the overlay's copy of it. Tombstone first and a
    # move of a file this sub-agent had already edited would silently carry the
    # ORIGINAL bytes to the destination.
    if _isolated(ctx):
        read_src = _read_through(src, ctx)
        if not os.path.exists(read_src):
            return Result.failure(f"Source not found: {src}")
        out = _redirect(dst, ctx, seed=False)
        r = try_result(lambda: shutil.copy2(read_src, out))
        if not r.ok:
            return Result.failure(f"Move failed: {r.error}")
        _record_delete(src, ctx)
        return Result.success(f"Moved: {shorten_path(src, ctx.get('workspace_root'))} -> {shorten_path(dst, ctx.get('workspace_root'))}")
    # Lock both endpoints: another writer could be touching either the source
    # (racing a second move) or the destination (racing a write that this move
    # would then overwrite). write_lock sorts the keys, so no deadlock.
    with write_lock(src, dst):
        if not os.path.exists(src):
            return Result.failure(f"Source not found: {src}")
        parent = os.path.dirname(dst)
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)
        r = try_result(lambda: os.rename(src, dst))
        if not r.ok:
            return Result.failure(f"Move failed: {r.error}")
    return Result.success(f"Moved: {shorten_path(src, ctx.get('workspace_root'))} -> {shorten_path(dst, ctx.get('workspace_root'))}")


def _copy_file_impl(args, ctx):
    src, dst = args.get("src", ""), args.get("dst", "")
    # Only the destination is a write; the source is read through the overlay so a
    # file this sub-agent already edited copies its OWN version, not the original.
    read_src = _read_through(src, ctx)
    out = _redirect(dst, ctx, seed=False)
    with write_lock(read_src, out):
        if not os.path.exists(read_src):
            return Result.failure(f"Source not found: {src}")
        parent = os.path.dirname(out)
        if parent and not os.path.exists(parent):
            os.makedirs(parent, exist_ok=True)
        r = try_result(lambda: shutil.copy2(read_src, out))
        if not r.ok:
            return Result.failure(f"Copy failed: {r.error}")
    return Result.success(f"Copied: {shorten_path(src, ctx.get('workspace_root'))} -> {shorten_path(dst, ctx.get('workspace_root'))}")


def _get_file_info_impl(args, ctx):
    path = args.get("path", "")
    if not os.path.exists(path):
        return Result.failure(f"Path not found: {path}")
    stat = os.stat(path)
    return Result.success({
        "path": shorten_path(path, ctx.get("workspace_root")),
        "size": stat.st_size, "modified": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(stat.st_mtime)),
        "is_dir": os.path.isdir(path), "is_file": os.path.isfile(path), "permissions": oct(stat.st_mode & 0o777),
    })


def _diff_files_impl(args, ctx):
    fa, fb = args.get("file_a", ""), args.get("file_b", "")
    if not os.path.isfile(fa):
        return Result.failure(f"File A not found: {fa}")
    if not os.path.isfile(fb):
        return Result.failure(f"File B not found: {fb}")
    ra = try_result(lambda: open(fa, encoding="utf-8", errors="ignore").readlines())
    rb = try_result(lambda: open(fb, encoding="utf-8", errors="ignore").readlines())
    if not ra.ok or not rb.ok:
        return Result.failure("Failed to read files for diff")
    diff = list(difflib.unified_diff(ra.value, rb.value, fromfile=shorten_path(fa, ctx.get("workspace_root")), tofile=shorten_path(fb, ctx.get("workspace_root"))))
    return Result.success("".join(diff) if diff else "Files are identical.")


def _git_cmd(args_list, cwd=None):
    # tracked_run, not subprocess.run: a git child spawned here has to be
    # reachable by the stop button like any other. subprocess.run hides the
    # handle, so `git log` on a huge repo kept running after Stop.
    from executors import tracked_run
    try:
        proc = tracked_run(
            ["git", "-c", "core.quotePath=false"] + args_list,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=cwd, timeout=30,
        )
        if proc.returncode == 0:
            return Result.success(proc.stdout.strip())
        return Result.failure(f"git exited {proc.returncode}: {proc.stderr.strip()}")
    except Exception as e:
        return Result.failure(f"git error: {e}")


class _GitArgError(ValueError):
    """A git tool argument that git would parse as an option, not a value."""


def _git_value(v, label: str) -> str:
    """Validate one git argument that must be a value and never an option.

    `_git_cmd` runs git with shell=False, so classic shell-metacharacter
    injection is not the exposure here -- git's *own* option parser is. Several
    git options take a command and run it: `--receive-pack=<cmd>` and
    `--upload-pack=<cmd>` on push/pull, `-c core.pager=<cmd>` anywhere. These
    argument values arrive from tool_call arguments, i.e. from text a prompt
    injection can choose, so a leading `-` is refused outright instead of being
    sanitised. Rejecting is safe: no legitimate remote, branch or path starts
    with a dash.
    """
    if not isinstance(v, str) or not v.strip():
        raise _GitArgError(f"{label}不能为空")
    v = v.strip()
    if v.startswith("-"):
        raise _GitArgError(f"{label}不能以 - 开头（git 会当作选项解析）: {v!r}")
    if any(c in v for c in "\n\r\x00"):
        raise _GitArgError(f"{label}含非法控制字符")
    return v


def _git_paths(raw, label: str = "路径") -> list:
    """Validate a pathspec list. Callers must still pass it after a `--`."""
    if not isinstance(raw, (list, tuple)):
        raise _GitArgError(f"{label}必须是数组")
    if not raw:
        raise _GitArgError(f"{label}不能为空")
    return [_git_value(p, label) for p in raw]


def _git_count(raw, default: int = 10, cap: int = 500) -> int:
    """Coerce a commit count to a bounded int (it is interpolated into `-N`)."""
    try:
        n = int(raw)
    except (TypeError, ValueError):
        raise _GitArgError(f"count 必须是整数: {raw!r}")
    return max(1, min(cap, n))


def _git_status_impl(args, ctx):
    return _git_cmd(["status", "--short"], ctx.get("workspace_root"))

def _git_add_impl(args, ctx):
    try:
        paths = _git_paths(args.get("paths", []))
    except _GitArgError as e:
        return Result.failure(str(e))
    # `--` terminates option parsing: everything after it is a pathspec, so a
    # path can never be reinterpreted as a flag like `--all` or `-f`.
    return _git_cmd(["add", "--"] + paths, ctx.get("workspace_root"))

def _git_commit_impl(args, ctx):
    """Commit staged changes. When no message is supplied, generate a
    Conventional Commits message from the staged diff (fallback = heuristic
    when no LLM is wired up).
    """
    message = (args.get("message") or "").strip()
    if not message:
        drafted = _draft_commit_message(ctx.get("workspace_root"))
        if not drafted.ok:
            return drafted
        message = drafted.value["message"]
    result = _git_cmd(["commit", "-m", message], ctx.get("workspace_root"))
    if result.ok:
        result.meta["commit_message"] = message
    return result


def _git_commit_message_impl(args, ctx):
    """Draft a commit message without committing (for UI preview)."""
    return _draft_commit_message(ctx.get("workspace_root"))


def _draft_commit_message(repo_path):
    """Synchronously draft a commit message via CommitMessageGenerator.

    file_agent tool impls are sync so we call the generator's heuristic path
    directly. An async wrapper can call ``generator.generate`` for the LLM
    path.
    """
    from git_trust import get_commit_message_generator
    if not repo_path:
        return Result.failure("No workspace_root in context")
    gen = get_commit_message_generator()
    diff_r = gen.collect_staged_diff(repo_path)
    if not diff_r.ok:
        return diff_r
    message = gen._heuristic(repo_path, diff_r.value)
    return Result.success({
        "message": message,
        "type": gen._extract_type(message),
        "generated_by": "heuristic",
    })

def _git_push_impl(args, ctx):
    try:
        cmd = ["push", _git_value(args.get("remote") or "origin", "remote")]
        if args.get("branch"):
            cmd.append(_git_value(args["branch"], "branch"))
    except _GitArgError as e:
        return Result.failure(str(e))
    return _git_cmd(cmd, ctx.get("workspace_root"))

def _git_pull_impl(args, ctx):
    try:
        cmd = ["pull", _git_value(args.get("remote") or "origin", "remote")]
        if args.get("branch"):
            cmd.append(_git_value(args["branch"], "branch"))
    except _GitArgError as e:
        return Result.failure(str(e))
    return _git_cmd(cmd, ctx.get("workspace_root"))

def _git_diff_impl(args, ctx):
    cmd = ["diff"]
    if args.get("staged", False):
        cmd.append("--cached")
    return _git_cmd(cmd, ctx.get("workspace_root"))

def _git_log_impl(args, ctx):
    try:
        count = _git_count(args.get("count", 10))
    except _GitArgError as e:
        return Result.failure(str(e))
    return _git_cmd(["log", "--oneline", f"-{count}"], ctx.get("workspace_root"))

def _git_branch_impl(args, ctx):
    action = args.get("action", "list")
    if action == "list":
        return _git_cmd(["branch"], ctx.get("workspace_root"))
    if action not in ("create", "switch"):
        return Result.failure(f"Unknown action: {action}")
    try:
        name = _git_value(args.get("name"), "分支名")
    except _GitArgError as e:
        return Result.failure(str(e))
    # No `--` here on purpose: `git checkout -- <name>` means "restore this
    # path", not "switch to this branch". The leading-dash rejection above is
    # what protects the argument.
    if action == "create":
        return _git_cmd(["branch", name], ctx.get("workspace_root"))
    return _git_cmd(["checkout", name], ctx.get("workspace_root"))


_agent: Optional[FileAgent] = None
def get_file_agent(workspace: str = None) -> FileAgent:
    global _agent
    if _agent is None:
        _agent = FileAgent(workspace)
    return _agent
