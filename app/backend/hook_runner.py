"""
hook_runner.py - External script hooks mounted on the event bus.

Lets the user extend agent behaviour with out-of-process scripts instead of
editing core modules: a hook can inject context before the model sees a prompt,
deny a tool call, react to a tool failure, or ask the agent to keep going.

Config discovery (later sources append after earlier ones):
  <project>/.agents/hooks.json
  ~/.agents/hooks.json

Schema::

    {
      "enabled": true,
      "timeoutMs": 60000,
      "maxOutputBytes": 65536,
      "events": {
        "PreToolUse": [
          {"matcher": "Bash|shell_executor",
           "hooks": [{"type": "process", "command": "python",
                      "args": ["${OVOLVE_PROJECT_DIR}/scripts/guard.py"],
                      "timeoutMs": 5000}]}
        ],
        "SubagentStart": [
          {"hooks": [{"type": "http", "url": "https://hooks.internal/subagent",
                      "method": "POST", "timeoutMs": 3000}]}
        ]
      }
    }

Protocol (Standard deterministic lifecycle hook protocol):
  - exit 0 -> pass, exit 2 -> block/deny, any other non-zero -> error (logged,
    non-fatal)
  - stdout, when non-empty, must be JSON with only recognised keys; an unknown
    key fails validation and the hook's effect is discarded
  - ``additionalContext`` is injected into the turn
  - PreToolUse / PermissionRequest may return
    ``permissionDecision: allow|ask|deny``
  - Stop may return ``continue: true`` (honoured up to STOP_CONTINUE_LIMIT)
  - PreCompact / PostCompact / SubagentStart / SubagentStop are observe-only:
    exit 2 is recorded but cannot cancel the fold or resurrect the sub-agent,
    because neither caller consults the outcome. Use them for archiving and
    post-checks, not for veto.
  - PreCompact receives ``messageCount`` instead of the transcript — the whole
    history is too large to pipe and the likeliest place for secrets to sit.
    PostCompact likewise receives the fold report *without* the summary, which
    is the transcript in condensed form.

``type: http`` hooks post the same JSON envelope as the process hooks' stdin and
read the response body with the same protocol. Response handling:

    2xx          -> parse as hook output
    4xx          -> warn and continue. A 4xx means the *request* was malformed;
                    a hook is a side channel and must not stall the user's turn
                    over our own mistake.
    5xx / unreachable / timeout
                 -> recorded as a failed hook; also non-blocking.

SECURITY: hooks run arbitrary local commands with the agent's privileges. Only
files under the user's own config paths are read, and the runner stays disabled
unless ``enabled`` is explicitly true.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import time
import urllib.error
from typing import Any, Optional

import web_outbound
from result import Result
from event_bus import get_event_bus, Event

# The eleven supported hook events. Anything else in a config is unsupported and
# reported rather than silently ignored.
HOOK_EVENTS = (
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "PreCompact",
    "PostCompact",
    "SubagentStart",
    "SubagentStop",
    "Stop",
)

# Bus event -> hook event. tool_result fans out to two hook events depending on
# whether the tool succeeded, mirroring the upstream spec.
#
# ``session_before_compact`` and ``subagent_state`` were already on the bus long
# before they were listed here, so the two most-requested hook points ("archive
# something before history is folded", "run a check after a sub-agent finishes")
# were unreachable purely because this table didn't mention them.
BUS_TO_HOOK = {
    "session_start": ("SessionStart",),
    "user_prompt_submit": ("UserPromptSubmit",),
    "pre_tool_use": ("PreToolUse",),
    "permission_request": ("PermissionRequest",),
    "tool_result": ("PostToolUse", "PostToolUseFailure"),
    "session_before_compact": ("PreCompact",),
    # `context_folded` already existed on the bus (the compactor emits it with
    # the fold report) — it was simply absent here, so there was no hook point
    # *after* a fold.
    "context_folded": ("PostCompact",),
    "subagent_state": ("SubagentStart", "SubagentStop"),
    "output": ("Stop",),
}

#: ``subagent_state`` fires on every transition. SubagentStop is about the *end*
#: of a sub-agent, so only these statuses fire it. Kept as plain strings rather
#: than importing SubagentStatus: hook_runner is imported by the router, and
#: subagent_runtime imports the router.
#: Mirrors subagent_runtime.TERMINAL_STATUSES — an end state that is missing
#: here means "the sub-agent died but the hook never ran".
SUBAGENT_TERMINAL_STATUSES = frozenset({
    "completed", "error", "killed", "timeout", "stale",
    "spawn_error", "lost", "orphan_recovered",
})

#: The mirror image of the set above: which status means "a sub-agent just came
#: to life". Only ``spawning`` — it is the initial value of
#: ``SubagentSession.status`` and is emitted exactly once, whereas the later
#: states can repeat. Putting ``running`` here would fire the user's script
#: again on every progress update.
SUBAGENT_START_STATUSES = frozenset({"spawning"})

DEFAULT_TIMEOUT_MS = 60_000
DEFAULT_MAX_OUTPUT = 64 * 1024
STOP_CONTINUE_LIMIT = 3

#: Fields accepted by a ``type: http`` hook.
HTTP_HOOK_FIELDS = {"type", "url", "method", "headers", "body",
                    "timeoutMs", "statusMessage"}
HTTP_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE"})

# Strict output schema: an unrecognised key invalidates the whole payload.
ALLOWED_OUTPUT_KEYS = {
    "additionalContext",
    "permissionDecision",
    "permissionDecisionReason",
    "continue",
    "stopReason",
    "systemMessage",
}
VALID_DECISIONS = ("allow", "ask", "deny")


class HookOutcome:
    """Result of one hook invocation, in a shape the caller can act on."""

    __slots__ = ("status", "decision", "reason", "context", "continue_", "duration_ms")

    def __init__(self, status: str, decision: str = "", reason: str = "",
                 context: str = "", continue_: bool = False, duration_ms: int = 0):
        self.status = status          # pass | block | error | timeout | invalid
        self.decision = decision      # allow | ask | deny | ""
        self.reason = reason
        self.context = context
        self.continue_ = continue_
        self.duration_ms = duration_ms

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "decision": self.decision,
            "reason": self.reason,
            "context": self.context,
            "continue": self.continue_,
            "durationMs": self.duration_ms,
        }


class HookRunner:
    """Loads hook configs and executes matching hooks on bus events."""

    def __init__(self, project_dir: str = None, session_id: str = ""):
        self.project_dir = project_dir or os.getcwd()
        self.session_id = session_id
        self.enabled = False
        self.timeout_ms = DEFAULT_TIMEOUT_MS
        self.max_output = DEFAULT_MAX_OUTPUT
        # event name -> list of {matcher, pattern, hooks, source}
        self.matchers: dict[str, list[dict]] = {e: [] for e in HOOK_EVENTS}
        self.log: list[dict] = []
        self.problems: list[str] = []
        self._stop_continues = 0

    # ── config loading ────────────────────────────────────────────

    def config_paths(self) -> list[str]:
        return [
            os.path.join(self.project_dir, ".agents", "hooks.json"),
            os.path.expanduser(os.path.join("~", ".agents", "hooks.json")),
        ]

    def load(self, paths: list[str] = None) -> dict:
        """Read every config file and build the matcher table.

        Returns a summary ``{enabled, registered, sources, problems}``. Malformed
        entries are recorded in ``problems`` rather than raising — one bad hook
        must not stop the agent from starting.
        """
        self.matchers = {e: [] for e in HOOK_EVENTS}
        self.problems = []
        sources: list[str] = []
        registered = 0

        for path in (paths if paths is not None else self.config_paths()):
            if not os.path.isfile(path):
                continue
            try:
                with open(path, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
            except (OSError, json.JSONDecodeError) as e:
                self.problems.append(f"{path}: unreadable ({e})")
                continue

            sources.append(path)
            if cfg.get("enabled") is True:
                self.enabled = True
            if isinstance(cfg.get("timeoutMs"), int) and cfg["timeoutMs"] > 0:
                self.timeout_ms = cfg["timeoutMs"]
            if isinstance(cfg.get("maxOutputBytes"), int) and cfg["maxOutputBytes"] > 0:
                self.max_output = cfg["maxOutputBytes"]

            # Accept both the config shape (events: {...}) and the plugin shape
            # (hooks: {...}) so a hooks.json copied from a plugin just works.
            events = cfg.get("events") or cfg.get("hooks") or {}
            if not isinstance(events, dict):
                self.problems.append(f"{path}: 'events' must be an object")
                continue

            for event_name, groups in events.items():
                if event_name not in HOOK_EVENTS:
                    self.problems.append(
                        f"{path}: unsupported event '{event_name}' "
                        f"(supported: {', '.join(HOOK_EVENTS)})"
                    )
                    continue
                if not isinstance(groups, list):
                    self.problems.append(f"{path}: {event_name} must be an array")
                    continue
                for group in groups:
                    entry = self._build_group(group, event_name, path)
                    if entry:
                        self.matchers[event_name].append(entry)
                        registered += len(entry["hooks"])

        return {
            "enabled": self.enabled,
            "registered": registered,
            "sources": sources,
            "problems": self.problems,
        }

    def _build_group(self, group: Any, event_name: str, path: str) -> Optional[dict]:
        """Validate one ``{matcher, hooks:[...]}`` group."""
        if not isinstance(group, dict):
            self.problems.append(f"{path}: {event_name} entry must be an object")
            return None

        raw_matcher = group.get("matcher")
        pattern = None
        if raw_matcher not in (None, ""):
            try:
                # Case-sensitive by design: `bash` must not match `Bash`.
                pattern = re.compile(str(raw_matcher))
            except re.error as e:
                self.problems.append(
                    f"{path}: {event_name} matcher {raw_matcher!r} is not a valid regex ({e}); "
                    "it would never fire"
                )
                return None

        specs = []
        for spec in group.get("hooks") or []:
            validated = self._validate_hook(spec, event_name, path)
            if validated:
                specs.append(validated)
        if not specs:
            return None

        return {"matcher": raw_matcher, "pattern": pattern, "hooks": specs, "source": path}

    def _validate_hook(self, spec: Any, event_name: str, path: str) -> Optional[dict]:
        """Validate one hook spec and normalise its timeout to milliseconds.

        Mixed ``command``/``process`` field styles are rejected outright — that
        mistake otherwise produces a hook that silently never behaves as written.
        """
        if not isinstance(spec, dict):
            self.problems.append(f"{path}: {event_name} hook must be an object")
            return None

        hook_type = spec.get("type", "command")
        if hook_type not in ("command", "process", "http"):
            self.problems.append(f"{path}: {event_name} unknown hook type {hook_type!r}")
            return None

        if hook_type == "http":
            return self._validate_http_hook(spec, event_name, path)

        command = spec.get("command")
        if not command or not isinstance(command, str):
            self.problems.append(f"{path}: {event_name} hook needs a 'command' string")
            return None

        allowed = ({"type", "command", "args", "timeoutMs", "statusMessage"}
                   if hook_type == "process"
                   else {"type", "command", "shell", "timeout", "timeoutMs", "statusMessage"})
        extra = set(spec) - allowed
        if extra:
            self.problems.append(
                f"{path}: {event_name} {hook_type} hook has fields not valid for its type: "
                f"{', '.join(sorted(extra))}"
            )
            return None

        # Timeout resolution order: timeoutMs -> timeout(seconds) -> config default.
        # Seconds vs milliseconds is the classic footgun, so it is resolved once
        # here and only milliseconds travel further.
        if isinstance(spec.get("timeoutMs"), (int, float)) and spec["timeoutMs"] > 0:
            timeout_ms = int(spec["timeoutMs"])
        elif isinstance(spec.get("timeout"), (int, float)) and spec["timeout"] > 0:
            timeout_ms = int(spec["timeout"] * 1000)
        else:
            timeout_ms = self.timeout_ms

        args = spec.get("args") or []
        if hook_type == "process" and not isinstance(args, list):
            self.problems.append(f"{path}: {event_name} process hook 'args' must be an array")
            return None

        return {
            "type": hook_type,
            "command": command,
            "args": [str(a) for a in args],
            "shell": spec.get("shell"),
            "timeout_ms": timeout_ms,
            "status_message": spec.get("statusMessage", ""),
            "source": path,
        }

    def _validate_http_hook(self, spec: dict, event_name: str, path: str) -> Optional[dict]:
        """Validate an ``http`` hook: URL + method + optional headers/body.

        An http hook posts the same JSON envelope the process hooks receive on
        stdin, which is why it needs no ``command``.
        """
        url = spec.get("url")
        if not url or not isinstance(url, str):
            self.problems.append(f"{path}: {event_name} http hook needs a 'url' string")
            return None

        method = str(spec.get("method", "POST")).upper()
        if method not in HTTP_METHODS:
            self.problems.append(
                f"{path}: {event_name} http hook method {method!r} not in "
                f"{', '.join(sorted(HTTP_METHODS))}")
            return None

        headers = spec.get("headers") or {}
        if not isinstance(headers, dict):
            self.problems.append(f"{path}: {event_name} http hook 'headers' must be an object")
            return None
        if any(not isinstance(k, str) or not isinstance(v, str) for k, v in headers.items()):
            self.problems.append(
                f"{path}: {event_name} http hook 'headers' must be string -> string")
            return None

        extra = set(spec) - HTTP_HOOK_FIELDS
        if extra:
            self.problems.append(
                f"{path}: {event_name} http hook has fields not valid for its type: "
                f"{', '.join(sorted(extra))}"
            )
            return None

        if isinstance(spec.get("timeoutMs"), (int, float)) and spec["timeoutMs"] > 0:
            timeout_ms = int(spec["timeoutMs"])
        else:
            timeout_ms = self.timeout_ms

        return {
            "type": "http",
            "command": url,          # reuse the log/record field
            "args": [],
            "shell": None,
            "url": self._expand(url),
            "method": method,
            "headers": {str(k): self._expand(str(v)) for k, v in headers.items()},
            "body": spec.get("body"),
            "timeout_ms": timeout_ms,
            "status_message": spec.get("statusMessage", ""),
            "source": path,
        }

    # ── template expansion ────────────────────────────────────────

    def _variables(self) -> dict:
        """Template variables for hook process execution."""
        return {
            "OVOLVE_PROJECT_DIR": self.project_dir,
            "PROJECT_DIR": self.project_dir,
            "OVOLVE_SESSION_ID": self.session_id,
            "SESSION_ID": self.session_id,
        }

    def _expand(self, text: str) -> str:
        for key, value in self._variables().items():
            text = text.replace("${%s}" % key, value)
        return text

    # ── execution ─────────────────────────────────────────────────

    async def run_one(self, spec: dict, match_value: str, hook_event: str,
                      payload: dict) -> HookOutcome:
        """Run a single hook subprocess. Returns HookOutcome regardless of crash."""
        if spec["type"] == "http":
            return await self._run_http(spec, hook_event, match_value, payload)

        command = self._expand(spec["command"])
        args = [self._expand(a) for a in spec["args"]]

        # Build stdin input that a hook script can read (matches upstream spec).
        stdin_data = json.dumps({
            "event": hook_event,
            "matchValue": match_value,
            "payload": payload,
        }, ensure_ascii=False)

        env = {**os.environ, **self._variables()}
        t0 = time.time()

        try:
            if spec["type"] == "process":
                proc = await asyncio.create_subprocess_exec(
                    command, *args,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                    cwd=self.project_dir,
                )
            else:
                shell_cmd = command
                if args:
                    shell_cmd += " " + " ".join(shlex.quote(a) for a in args)
                proc = await asyncio.create_subprocess_shell(
                    shell_cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                    cwd=self.project_dir,
                )

            try:
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(stdin_data.encode()),
                    timeout=spec["timeout_ms"] / 1000.0,
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                duration = int((time.time() - t0) * 1000)
                self._record(spec, hook_event, match_value, "timeout", duration)
                return HookOutcome("timeout", duration_ms=duration,
                                   reason=f"killed after {spec['timeout_ms']}ms")

        except OSError as e:
            duration = int((time.time() - t0) * 1000)
            self._record(spec, hook_event, match_value, "error", duration, str(e))
            return HookOutcome("error", reason=str(e), duration_ms=duration)

        duration = int((time.time() - t0) * 1000)
        rc = proc.returncode
        out = stdout[:self.max_output].decode(errors="replace").strip()

        # Exit code protocol: 0=pass, 2=block/deny, other=error.
        if rc == 2:
            self._record(spec, hook_event, match_value, "block", duration)
            return HookOutcome("block", decision="deny",
                               reason=out or "hook exited 2",
                               duration_ms=duration)
        if rc not in (0, None):
            err_msg = stderr[:512].decode(errors="replace").strip() or f"exit {rc}"
            self._record(spec, hook_event, match_value, "error", duration, err_msg)
            return HookOutcome("error", reason=err_msg, duration_ms=duration)

        return self._parse_output(out, spec, hook_event, match_value, duration)

    async def _run_http(self, spec: dict, hook_event: str, match_value: str,
                        payload: dict) -> HookOutcome:
        """Run a ``type: http`` hook.

        Response handling, in order — this ordering is deliberate and covered by
        tests, because the obvious implementation blocks the user's turn on a
        server bug:

            2xx        -> parse the body with the same protocol as stdout
            4xx        -> warn and continue. A 400 means *we* built the request
                          wrong; a hook is a side channel and must never stall
                          the main flow over our own mistake.
            5xx / unreachable / timeout
                       -> treated as a failed hook (``error`` / ``timeout``),
                          which is recorded but likewise does not block.

        The request goes through ``web_outbound`` so it honours the same proxy
        and egress policy as every other outbound call in the app.
        """
        body = None
        if spec.get("body") is not None:
            body = json.dumps(spec["body"], ensure_ascii=False).encode()
        headers = dict(spec.get("headers") or {})
        if body is not None and not any(k.lower() == "content-type" for k in headers):
            headers["Content-Type"] = "application/json"

        envelope = json.dumps({
            "event": hook_event,
            "matchValue": match_value,
            "payload": payload,
        }, ensure_ascii=False).encode()

        if spec["method"] == "GET":
            data = None
        else:
            data = body if body is not None else envelope

        t0 = time.time()
        try:
            resp = await asyncio.wait_for(
                asyncio.to_thread(
                    web_outbound.open_url,
                    spec["url"],
                    timeout=spec["timeout_ms"] / 1000.0,
                    headers=headers,
                    data=data,
                    method=spec["method"],
                ),
                timeout=spec["timeout_ms"] / 1000.0 + 1,
            )
            try:
                raw = resp.read()
            finally:
                close = getattr(resp, "close", None)
                if close:
                    close()
        except asyncio.TimeoutError:
            duration = int((time.time() - t0) * 1000)
            self._record(spec, hook_event, match_value, "timeout", duration,
                         f"no response within {spec['timeout_ms']}ms")
            return HookOutcome("timeout", duration_ms=duration,
                               reason=f"HTTP hook timed out after {spec['timeout_ms']}ms")
        except urllib.error.HTTPError as e:
            duration = int((time.time() - t0) * 1000)
            code = getattr(e, "code", 0) or 0
            if 400 <= code < 500:
                # Our request was wrong, not the user's turn. Warn and move on.
                self._record(spec, hook_event, match_value, "warning", duration,
                             f"HTTP {code}")
                return HookOutcome("pass", duration_ms=duration,
                                   reason=f"HTTP {code} (4xx does not block the main flow)")
            self._record(spec, hook_event, match_value, "error", duration, f"HTTP {code}")
            return HookOutcome("error", reason=f"HTTP {code}", duration_ms=duration)
        except Exception as e:
            duration = int((time.time() - t0) * 1000)
            self._record(spec, hook_event, match_value, "error", duration, str(e))
            return HookOutcome("error", reason=str(e), duration_ms=duration)

        duration = int((time.time() - t0) * 1000)
        out = raw[:self.max_output].decode(errors="replace").strip()
        return self._parse_output(out, spec, hook_event, match_value, duration)

    def _parse_output(self, out: str, spec: dict, hook_event: str, match_value: str,
                      duration: int) -> HookOutcome:
        """Turn hook stdout / HTTP 2xx body into a HookOutcome (strict schema)."""
        # If the output is empty: pass with no side effects.
        if not out:
            self._record(spec, hook_event, match_value, "pass", duration)
            return HookOutcome("pass", duration_ms=duration)

        # Parse JSON output (strict schema: extra keys -> invalid).
        try:
            data = json.loads(out)
        except json.JSONDecodeError as e:
            self._record(spec, hook_event, match_value, "invalid", duration, str(e))
            return HookOutcome("invalid", reason=f"output not JSON: {e}",
                               duration_ms=duration)
        if not isinstance(data, dict):
            self._record(spec, hook_event, match_value, "invalid", duration,
                         "output must be a JSON object")
            return HookOutcome("invalid", reason="output must be a JSON object",
                               duration_ms=duration)
        extra = set(data) - ALLOWED_OUTPUT_KEYS
        if extra:
            self._record(spec, hook_event, match_value, "invalid", duration,
                         f"unknown keys: {extra}")
            return HookOutcome("invalid",
                               reason=f"unknown output keys: {', '.join(sorted(extra))}",
                               duration_ms=duration)

        # Extract structured fields.
        decision = data.get("permissionDecision", "")
        if decision and decision not in VALID_DECISIONS:
            decision = ""
        context = str(data.get("additionalContext", ""))
        cont = bool(data.get("continue", False))

        self._record(spec, hook_event, match_value, "pass", duration)
        return HookOutcome(
            "pass" if not decision or decision == "allow" else "block",
            decision=decision,
            reason=data.get("permissionDecisionReason", ""),
            context=context,
            continue_=cont,
            duration_ms=duration,
        )

    def _record(self, spec: dict, event: str, match_value: str,
                status: str, duration_ms: int, error: str = ""):
        """Append an execution record (for debug / /api/hooks endpoint)."""
        self.log.append({
            "event": event,
            "matchValue": match_value,
            "command": spec["command"],
            "type": spec["type"],
            "source": spec.get("source", ""),
            "status": status,
            "durationMs": duration_ms,
            "error": error,
            "ts": time.time(),
        })
        # Keep the log from growing unbounded.
        if len(self.log) > 200:
            self.log = self.log[-100:]

    # ── event bus integration ─────────────────────────────────────

    def _match_value_for(self, bus_event_name: str, payload: dict) -> str:
        """Compute the match value for a bus event.

        Tool events match on tool_name. user_prompt_submit matches on the
        message text. session_start on the reason. output on preview text.
        """
        if bus_event_name in ("pre_tool_use", "tool_result", "permission_request"):
            return payload.get("tool_name", "")
        if bus_event_name == "user_prompt_submit":
            return payload.get("message", "")
        if bus_event_name == "session_start":
            return payload.get("reason", "startup")
        if bus_event_name == "output":
            return str(payload.get("text", ""))[:200]
        if bus_event_name == "subagent_state":
            # Match on persona, so a hook can target `coder` without also
            # running after every `explore`.
            return str(payload.get("subagentType", ""))
        if bus_event_name in ("session_before_compact", "context_folded"):
            # "manual" when the user asked for the fold, "auto" when a threshold
            # tripped — the only discriminator worth matching on here.
            return "manual" if payload.get("manual") else "auto"
        return ""

    def _hook_payload_for(self, bus_event_name: str, payload: dict) -> dict:
        """Project a bus payload down to what is safe to hand a hook.

        The payload goes to the hook's stdin verbatim, so anything huge or
        sensitive on the bus would leave the process. ``session_before_compact``
        carries the entire message history — megabytes, and the single most
        likely place for secrets to appear — so it is replaced with a count. A
        hook that genuinely needs the transcript can read the session store.
        """
        if bus_event_name == "session_before_compact":
            slim = {k: v for k, v in payload.items() if k != "messages"}
            slim["messageCount"] = len(payload.get("messages") or [])
            return slim
        if bus_event_name == "context_folded":
            # Same reasoning, other end of the fold: the summary *is* the
            # transcript, only shorter. A hook that needs the text can read the
            # session store; the metadata below is enough to decide whether to
            # look.
            return {k: v for k, v in payload.items() if k != "summary"}
        return payload

    def _hook_event_for(self, bus_event_name: str, payload: dict) -> str:
        """Determine which hook event to fire for a bus event."""
        candidates = BUS_TO_HOOK.get(bus_event_name)
        if not candidates:
            return ""
        if bus_event_name == "tool_result":
            ok = (payload.get("result") or {}).get("ok", True)
            return "PostToolUse" if ok else "PostToolUseFailure"
        if bus_event_name == "subagent_state":
            status = str(payload.get("status", ""))
            if status in SUBAGENT_START_STATUSES:
                return "SubagentStart"
            # Only the end of a sub-agent's life is a "Stop". Firing on
            # spawning/running would run the user's script three times per
            # sub-agent and mean something different each time.
            if status not in SUBAGENT_TERMINAL_STATUSES:
                return ""
            return "SubagentStop"
        return candidates[0]

    async def fire(self, bus_event_name: str, payload: dict) -> list[HookOutcome]:
        """Fire all matching hooks for a bus event. Called by bus subscriber."""
        if not self.enabled:
            return []

        hook_event = self._hook_event_for(bus_event_name, payload)
        if not hook_event:
            return []

        match_value = self._match_value_for(bus_event_name, payload)
        hook_payload = self._hook_payload_for(bus_event_name, payload)
        outcomes: list[HookOutcome] = []

        for group in self.matchers.get(hook_event, []):
            # Matcher filtering: None matches everything; a compiled pattern
            # must match the value.
            pat = group["pattern"]
            if pat is not None and not pat.search(match_value):
                continue

            for spec in group["hooks"]:
                outcome = await self.run_one(spec, match_value, hook_event, hook_payload)
                outcomes.append(outcome)

                # A blocking outcome short-circuits remaining hooks in this
                # event, matching the upstream behaviour.
                if outcome.status == "block":
                    return outcomes

        return outcomes

    def mount(self, bus=None):
        """Subscribe to all relevant bus events at a low priority.

        Priority -50: after risk_control (100) and memory (50) but before the
        WebSocket bridge (-100). A hook can see the risk level already set by
        risk_control, and any block it issues propagates to the bridge.
        """
        bus = bus or get_event_bus()
        for bus_event in BUS_TO_HOOK:
            bus.on(bus_event, self._make_handler(bus_event), priority=-50)

    def _make_handler(self, bus_event_name: str):
        """Create a handler closure for a specific bus event."""
        async def handler(event: Event):
            outcomes = await self.fire(bus_event_name, event.payload)
            for o in outcomes:
                if o.context:
                    # Inject additional context so downstream consumers (router,
                    # system prompt) can use it.
                    event.payload.setdefault("hook_context", []).append(o.context)
                if o.decision:
                    # allow / ask / deny — surfaced for the router's permission
                    # resolution on pre_tool_use / permission_request.
                    event.payload["hook_decision"] = o.decision
                if o.status == "block":
                    if bus_event_name in ("pre_tool_use", "permission_request"):
                        event.block(o.reason or "Blocked by hook")
                    return
        return handler


# ── singleton ─────────────────────────────────────────────────────

_runner: Optional[HookRunner] = None


def get_hook_runner(project_dir: str = None, session_id: str = "") -> HookRunner:
    global _runner
    if _runner is None:
        _runner = HookRunner(project_dir, session_id)
    return _runner


def init_hooks(project_dir: str = None, session_id: str = "") -> dict:
    """Initialize, load config, mount on bus. Returns load summary."""
    runner = get_hook_runner(project_dir, session_id)
    summary = runner.load()
    if runner.enabled:
        runner.mount()
    return summary
