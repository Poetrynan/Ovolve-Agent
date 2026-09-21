"""
git_trust.py - Git repository trust checking + Conventional Commits generation.
"""
import os
import re
import subprocess
import hashlib
from result import Result
from typing import Callable, Optional

try:
    from user_dirs import home_dir as _user_home_dir
except ImportError:  # pragma: no cover - packaged import shape
    from app.backend.user_dirs import home_dir as _user_home_dir


def _trust_list_path() -> str:
    return os.path.join(str(_user_home_dir()), "trusted_repos.txt")


class GitTrustChecker:
    """Check if a Git repository is trusted."""

    def __init__(self):
        self._trusted_repo_hashes = set()
        self._trusted_signatures = set()
        self._load_trust_list()

    def _load_trust_list(self):
        """Load trusted repository hashes from storage."""
        try:
            with open(_trust_list_path(), "r") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        self._trusted_repo_hashes.add(line)
        except FileNotFoundError:
            pass  # fail-open: 可选增强，失败不影响主流程

    def _save_trust_list(self):
        """Save trusted repository hashes to storage."""
        os.makedirs(str(_user_home_dir()), exist_ok=True)
        with open(_trust_list_path(), "w") as f:
            for h in self._trusted_repo_hashes:
                f.write(f"{h}\n")

    def check_repo_safe(self, repo_path: str) -> Result:
        """Check if a Git repository is safe to operate on."""
        git_dir = os.path.join(repo_path, ".git")

        if not os.path.exists(git_dir):
            return Result.success("Not a Git repository, considered safe")

        # Check 1: Verify .git is not a symlink to external location
        if os.path.islink(git_dir):
            real_path = os.path.realpath(git_dir)
            if not real_path.startswith(os.path.realpath(repo_path)):
                return Result.failure(f"Unsafe: .git is symlink to external location: {real_path}")

        # Check 2: Verify gitdir is not pointing outside
        gitdir_file = os.path.join(git_dir, "config")
        if os.path.exists(gitdir_file):
            with open(gitdir_file, "r") as f:
                for line in f:
                    if line.startswith("worktree =") or line.startswith("gitdir:"):
                        # Check if path is outside repo
                        value = line.split("=")[1].strip()
                        if value.startswith("/") or value.startswith("\\"):
                            return Result.failure(f"Unsafe: gitdir points outside repo: {value}")

        # Check 3: Calculate repository hash and check against trusted list
        repo_hash = self._calculate_repo_hash(repo_path)
        if repo_hash in self._trusted_repo_hashes:
            return Result.success("Repository is trusted")

        # Not in trusted list - mark as potentially unsafe
        return Result.failure(f"Repository not in trusted list. Hash: {repo_hash[:16]}...")

    def mark_trusted(self, repo_path: str) -> Result:
        """Mark a repository as trusted."""
        repo_hash = self._calculate_repo_hash(repo_path)
        self._trusted_repo_hashes.add(repo_hash)
        self._save_trust_list()
        return Result.success(f"Repository marked as trusted: {repo_hash[:16]}...")

    def _calculate_repo_hash(self, repo_path: str) -> str:
        """Calculate a hash of the repository config and HEAD."""
        import subprocess
        try:
            # Get HEAD commit hash
            proc = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=repo_path,
                capture_output=True, text=True,
                encoding="utf-8", errors="replace",
                timeout=5
            )
            head_hash = proc.stdout.strip() if proc.returncode == 0 else "no-head"

            # Get config content
            config_path = os.path.join(repo_path, ".git", "config")
            if os.path.exists(config_path):
                with open(config_path, "rb") as f:
                    config_content = f.read()[:1000]
            else:
                config_content = b""

            combined = f"{head_hash}:{config_content}".encode()
            return hashlib.sha256(combined).hexdigest()
        except Exception:
            # Fallback: hash directory structure
            import os
            files = []
            for root, dirs, fnames in os.walk(repo_path):
                for f in fnames:
                    if not f.startswith("."):
                        files.append(f)
            return hashlib.sha256("|".join(sorted(files)).encode()).hexdigest()[:32]


_checker: Optional[GitTrustChecker] = None
def get_git_trust_checker() -> GitTrustChecker:
    global _checker
    if _checker is None:
        _checker = GitTrustChecker()
    return _checker


# ---------------------------------------------------------------------------
# Conventional Commits generation (TODO §4.1)
# ---------------------------------------------------------------------------

class CommitMessageGenerator:
    """Generate Conventional Commits messages from staged changes.

    Flow (TODO §4.1):
      1. ``git diff --cached`` -> staged change content
      2. ``git log --oneline -10`` -> recent commit style
      3. LLM analyses diff + history -> ``type(scope): description``
      4. Caller shows the message for confirmation (editable)
      5. Caller commits on approval

    When no LLM is configured a deterministic heuristic produces a reasonable
    message from the diff stat, so the feature degrades instead of failing.
    """

    VALID_TYPES = ("feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "build", "ci")
    MAX_DIFF_CHARS = 12000  # Cap the diff we feed to the LLM / heuristic

    def __init__(self, llm_callback: Optional[Callable] = None) -> None:
        """Initialize the generator.

        Args:
            llm_callback: Optional callable taking a prompt dict and returning
                either a commit-message string or a dict ``{"message": str}``.
                May be sync or async.
        """
        self._llm = llm_callback

    def collect_staged_diff(self, repo_path: str, include_unstaged: bool = False) -> Result:
        """Capture the diff to describe.

        Args:
            repo_path: Repository working directory.
            include_unstaged: Look at everything dirty (``git diff HEAD`` plus
                untracked filenames) instead of only the index. This exists
                because the panel offers "包含未暂存的更改" — if the user is about
                to commit unstaged work, describing only the index would produce
                a message about the wrong changes. Untracked files can't appear
                in a diff at all, so they're appended as a filename list.

        Returns:
            Result with the (possibly truncated) diff text, or failure.
        """
        proc = self._git(repo_path, ["diff", "HEAD"] if include_unstaged else ["diff", "--cached"])
        if not proc.ok:
            return proc
        diff = proc.value
        if include_unstaged:
            untracked = self._git(repo_path, ["ls-files", "--others", "--exclude-standard"])
            if untracked.ok and untracked.value.strip():
                names = [n for n in untracked.value.splitlines() if n.strip()][:50]
                diff += "\n\n# 新增（未跟踪）文件:\n" + "\n".join(f"# + {n}" for n in names)
        if not diff.strip():
            return Result.failure(
                "没有可提交的改动。" if include_unstaged else "暂存区是空的，请先 git add 或勾选「包含未暂存的更改」。",
                code="NoStagedChanges",
            )
        if len(diff) > self.MAX_DIFF_CHARS:
            diff = diff[: self.MAX_DIFF_CHARS] + "\n... [diff truncated]"
        return Result.success(diff)

    def collect_recent_style(self, repo_path: str, count: int = 10) -> list[str]:
        """Sample recent commit subjects to mirror the repo's style.

        Args:
            repo_path: Repository working directory.
            count: Number of recent commits to sample.

        Returns:
            List of recent commit subject lines (may be empty).
        """
        proc = self._git(repo_path, ["log", f"-{count}", "--pretty=format:%s"])
        if not proc.ok or not proc.value.strip():
            return []
        return [ln.strip() for ln in proc.value.splitlines() if ln.strip()]

    async def generate(self, repo_path: str, include_unstaged: bool = False,
                       llm_callback: Optional[Callable] = None) -> Result:
        """Produce a Conventional Commits message for the changes.

        Args:
            repo_path: Repository working directory.
            include_unstaged: Describe all dirty changes, not just the index.
                The commit panel passes the state of its "包含未暂存的更改" box so
                the drafted message matches what will actually be committed.
            llm_callback: Per-call model override. The commit panel passes the
                model the composer has selected, so the ✨ draft comes from the
                same model the user is talking to — we deliberately do NOT run a
                separate cheap "commit model", because an open-source build has
                no hosted small model to reach for. Passed per call rather than
                assigned to ``self`` because this is a shared singleton.

        Returns:
            Result with a dict ``{message, type, generated_by}`` on success.
        """
        diff_r = self.collect_staged_diff(repo_path, include_unstaged=include_unstaged)
        if not diff_r.ok:
            return diff_r
        diff = diff_r.value
        recent = self.collect_recent_style(repo_path)

        llm = llm_callback or self._llm
        if llm:
            message = await self._generate_with_llm(diff, recent, llm=llm)
            if message:
                return Result.success({
                    "message": self._sanitize(message),
                    "type": self._extract_type(message),
                    "generated_by": "llm",
                })

        message = self._heuristic(repo_path, diff, include_unstaged=include_unstaged)
        return Result.success({
            "message": message,
            "type": self._extract_type(message),
            "generated_by": "heuristic",
        })

    async def _generate_with_llm(self, diff: str, recent: list[str],
                                 llm: Optional[Callable] = None) -> str:
        """Call the LLM to draft a message; return "" on any failure."""
        import asyncio
        llm = llm or self._llm
        prompt = {
            "task": "commit_message",
            "instruction": (
                "Write ONE Conventional Commits message for the staged diff. "
                "Format: type(scope): description. "
                f"type in {self.VALID_TYPES}. Imperative mood, <=72 char subject. "
                "Match the style of the recent commits when reasonable."
            ),
            "recent_commits": recent,
            "diff": diff,
        }
        try:
            if asyncio.iscoroutinefunction(llm):
                out = await llm(prompt)
            else:
                out = llm(prompt)
        except Exception:
            return ""
        if isinstance(out, dict):
            return str(out.get("message", "")).strip()
        return str(out or "").strip()

    def _heuristic(self, repo_path: str, diff: str, include_unstaged: bool = False) -> str:
        """Deterministic fallback message from the diff stat + filenames."""
        stat = self._git(
            repo_path,
            ["diff", "HEAD", "--name-status"] if include_unstaged
            else ["diff", "--cached", "--name-status"],
        )
        files: list[tuple[str, str]] = []
        if stat.ok:
            for line in stat.value.splitlines():
                parts = line.split("\t")
                if len(parts) >= 2:
                    files.append((parts[0].strip(), parts[-1].strip()))
        if include_unstaged:
            # `git diff` can't see untracked files, but they ARE part of what
            # `git add -A` will commit, so the fallback must count them or a
            # brand-new-files commit would be described as "0 files".
            untracked = self._git(repo_path, ["ls-files", "--others", "--exclude-standard"])
            if untracked.ok:
                files += [("A", n.strip()) for n in untracked.value.splitlines() if n.strip()]

        ctype = self._infer_type(files, diff)
        scope = self._infer_scope(files)
        if not files:
            desc = "update staged changes"
        elif len(files) == 1:
            desc = f"update {os.path.basename(files[0][1])}"
        else:
            desc = f"update {len(files)} files"
        scope_part = f"({scope})" if scope else ""
        subject = f"{ctype}{scope_part}: {desc}"[:72]

        body_lines = [f"- {status} {path}" for status, path in files[:20]]
        body = "\n".join(body_lines)
        return f"{subject}\n\n{body}" if body else subject

    def _infer_type(self, files: list[tuple[str, str]], diff: str) -> str:
        """Guess a Conventional Commit type from file paths and diff content."""
        paths = [p.lower() for _, p in files]
        if files and all(s == "A" for s, _ in files):
            return "feat"
        if any("test" in p or p.endswith(("_test.py", ".test.ts", ".spec.ts")) for p in paths):
            return "test"
        if any(p.endswith((".md", ".rst", ".txt")) for p in paths):
            return "docs"
        if any(p.endswith((".css", ".scss")) for p in paths):
            return "style"
        if re.search(r"\bfix|bug|error|crash|patch\b", diff, re.IGNORECASE):
            return "fix"
        if any("config" in p or p.endswith((".json", ".toml", ".yaml", ".yml", ".ini")) for p in paths):
            return "chore"
        return "refactor" if files else "chore"

    @staticmethod
    def _infer_scope(files: list[tuple[str, str]]) -> str:
        """Derive a scope from the common top-level directory of changed files."""
        if not files:
            return ""
        tops = set()
        for _, path in files:
            norm = path.replace("\\", "/")
            top = norm.split("/")[0] if "/" in norm else ""
            if top:
                tops.add(top)
        if len(tops) == 1:
            return tops.pop()
        return ""

    def _extract_type(self, message: str) -> str:
        """Pull the leading Conventional Commit type out of a message."""
        m = re.match(r"^([a-z]+)(\([^)]*\))?!?:", message.strip())
        if m and m.group(1) in self.VALID_TYPES:
            return m.group(1)
        return "chore"

    def _sanitize(self, message: str) -> str:
        """Strip code fences / quotes the LLM may wrap the message in."""
        text = message.strip()
        text = re.sub(r"^```[a-zA-Z]*\n?", "", text)
        text = re.sub(r"\n?```$", "", text)
        return text.strip().strip('"').strip()

    @staticmethod
    def _git(repo_path: str, args: list[str]) -> Result:
        """Run a git command, returning stdout as a Result (never raises)."""
        try:
            proc = subprocess.run(
                ["git", "-c", "core.quotePath=false", *args],
                cwd=repo_path,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
            )
        except (OSError, subprocess.SubprocessError) as e:
            return Result.failure(f"git {' '.join(args)} failed: {e}", code="GitError")
        if proc.returncode != 0:
            return Result.failure(
                (proc.stderr or "git command failed").strip(), code="GitError"
            )
        return Result.success(proc.stdout)


_commit_gen: Optional[CommitMessageGenerator] = None


def get_commit_message_generator(llm_callback: Optional[Callable] = None) -> CommitMessageGenerator:
    """Get the global CommitMessageGenerator singleton.

    A later call may supply the LLM callback the first construction lacked.
    """
    global _commit_gen
    if _commit_gen is None:
        _commit_gen = CommitMessageGenerator(llm_callback)
    elif llm_callback is not None and _commit_gen._llm is None:
        _commit_gen._llm = llm_callback
    return _commit_gen
