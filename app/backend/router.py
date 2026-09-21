"""router.py - Main Router facade with 5-step decision chain (Micro-Agent Orchestration Architecture).

Modularized into 5 components in router_modules/:
- admission: Session lifecycle, workspace, usage tracking, cancellation, and handle entrypoint
- loop: Agent loop core (_agent_loop), streaming LLM chat, and MoA council
- dispatch: Tool execution, dispatching, ask-user, audit, and output presentation
- prompt: System prompt assembly, guidance files, and EnvironmentSnapshot
- goal: Long-horizon goal continuation and execution

Step 1: Intent recognition & risk classification
Step 2: Task dispatch (sub-agent / skill / direct tool)
Step 3: Execution strategy (single / sequential / parallel)
Step 4: Acceptance & artifact audit
Step 5: Result presentation
"""
from __future__ import annotations

import asyncio
import json
import os
import platform
import subprocess
import threading
import time
import uuid
from typing import Any, Optional

import token_estimate
from ask_user import (
    ASK_WAIT_TIMEOUT_S,
    AUTO_RESOLVE_SYSTEM,
    PendingQuestion,
    build_auto_resolve_user_prompt,
    drop_waiter,
    get_ask_user_store,
    normalize_questions,
    parse_auto_resolution,
    prompt_block as ask_user_prompt_block,
    register_waiter,
    render_answer,
)
from browser_agent import get_anti_scraping_guard
from context_compactor import ContextCompactor, get_compactor
from embedder import embed_text
from event_bus import Event, EventBus, get_event_bus
from execution_provider import (
    MODE_DANGER_FULL,
    MODE_REFUSED,
    risk_to_rlevel,
    select_execution,
)
from executors import cancel_call, register_output_sink, unregister_output_sink
from goal_manager import GoalManager, get_goal_manager
from image_store import placeholder as _image_placeholder, save_ref as _save_image_ref
from llm_client import get_llm_client
from memory_layer import get_memory_layer
from messaging import DeliverAs, MAX_STEER_MERGED_CHARS, MessageQueue, get_message_queue
from model_registry import get_model_registry
from output_guard import OutputGuard, get_output_guard
from path_guard import get_path_guard
from prompt_layers import LAYER_ORDER, get_prompt_loader
from result import Result
from risk_control import (
    PermissionMode,
    RiskController,
    RiskLevel,
    coerce_permission,
    get_remote_risk_decorator,
    get_risk_controller,
    parse_consent,
    prompt_block as permission_prompt_block,
)
from rule_engine import get_rule_engine
from sanitizer import get_output_sanitizer
from skill_loader import get_skill_loader
from storage import get_storage
from tool_hooks import HookStage, get_tool_hooks
from tools import ToolRegistry, get_tool_registry, shorten_path, truncate

# Re-exports from router_modules
from router_modules.prompt import (
    EnvironmentSnapshot,
    _is_cot_content_leak,
    _strip_leading_junk,
    _approved_plan_context,
    _merge_plan_meta,
    RouterPromptMixin,
)
from router_modules.dispatch import (
    AGENT_ROLES,
    PARALLEL_SAFE_TOOLS,
    _summarize_turn_outcome,
    RouterDispatchMixin,
)
from router_modules.loop import (
    IMAGE_HINT_DELAY,
    TOOL_ARG_FRAME_INTERVAL,
    INTERRUPT_NOTE_TYPE,
    INTERRUPT_NUDGE,
    SOFT_LANDING_NOTICE,
    RouterLoopMixin,
)
from router_modules.admission import (
    RouterAdmissionMixin,
)
from router_modules.goal import (
    RouterGoalMixin,
)

#: Explicit whitelist of tools that mutate workspace files or git state.
MUTATING_WORKSPACE_TOOLS = {
    "write_file", "edit_file", "apply_patch", "delete_file", "move_file", "rename_file",
    "create_file", "append_file", "replace_file_content", "write_to_file", "file_write", "file_edit",
    "run_shell", "run_command", "git_commit", "git_checkout", "git_add", "git_reset",
    "git_merge", "git_rebase", "git_cherry_pick", "git_stash", "git_pull", "git_branch",
    "worktree_create", "worktree_switch", "worktree_delete",
}


class Router(
    RouterAdmissionMixin,
    RouterLoopMixin,
    RouterDispatchMixin,
    RouterPromptMixin,
    RouterGoalMixin,
):
    """One agent session: state + the 5-step decision chain that routes a turn.

    A Router instance IS a session. Everything mutable that a conversation owns
    lives here — workspace, session_id, mode, permission, the context compactor,
    the steer queue, the goal binding, the cancel token. Nothing about a turn is
    read from module state, so N Routers can run concurrently in one process
    without seeing each other. This is what lets `SessionHost` hand a different
    Router to each connected window (VS Code's Agent Host model: the session
    lives in its own object, clients attach to it).

    Low-level services ARE shared on purpose, because they hold no
    conversation state: storage (SQLite, every row keyed by session), the tool
    and skill registries, the model registry, the LLM client, the event bus.
    Sharing them is what keeps a second session nearly free instead of another
    150MB.
    """

    def __init__(
        self,
        workspace: str = None,
        system_prompt: str = None,
        session_id: str = None,
        mount_shared: bool = True,
    ):
        self.system_prompt = system_prompt or ""
        # Storage must exist before we can read the persisted workspace choice.
        self.storage = get_storage()
        # Boot into the folder the user last opened, if any. Falls back to the
        # value passed in (from config.workspace.root or CLI) and finally CWD.
        try:
            saved_ws = self.storage.get_config("active_workspace", "") or ""
        except Exception:
            saved_ws = ""
        chosen = saved_ws if saved_ws and os.path.isdir(saved_ws) else (workspace or os.getcwd())
        # An explicit workspace argument wins over the persisted one: the host
        # creates per-workspace sessions, and those must land where asked rather
        # than snapping back to whatever folder was open last.
        if workspace and os.path.isdir(workspace):
            chosen = workspace
        # Normalize to an ABSOLUTE path. Callers occasionally pass "." or an
        # already-relative path (the config file, an old bookmark, `os.getcwd()`
        # in a shell that was launched relative). Storing the raw string then
        # made the sidebar label say ".", which reads like a rendering bug.
        try:
            chosen = os.path.abspath(chosen) if chosen else chosen
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程
        self.workspace = chosen
        if self.workspace:
            try:
                os.makedirs(self.workspace, exist_ok=True)
            except Exception:
                pass
        # Whether the user has ACTUALLY picked a workspace, as opposed to the
        # process silently falling back to its own CWD (which, when running from
        # source, is inside Ovolve's own git repo — that is how the git panel
        # used to show hundreds of "changes" before any folder was opened).
        #
        # "Selected" means one of:
        #   * a persisted ``active_workspace`` exists and still resolves, OR
        #   * an explicit workspace argument was passed that is NOT just the
        #     process CWD (config's ``workspace.root: "."`` resolves to CWD, so
        #     that boot default must NOT count as a real selection).
        # ``switch_workspace`` flips this True the moment the user opens a folder.
        try:
            startup_cwd = os.path.abspath(os.getcwd())
        except Exception:
            startup_cwd = ""
        has_saved = bool(saved_ws) and os.path.isdir(saved_ws)
        explicit_pick = (
            bool(workspace) and os.path.isdir(workspace)
            and os.path.abspath(workspace) != startup_cwd
        )
        self.workspace_selected = bool(has_saved or explicit_pick)
        if session_id:
            # Host-driven: attach to a specific session row, create it if the
            # caller invented a fresh UUID.
            self.session_id = session_id
            try:
                if not self.storage.get_session(session_id):
                    # `effective_workspace`, NOT `self.workspace`: the raw value
                    # is the cwd fallback, and stamping it onto a session row is
                    # what made a workspace called "app" (Ovolve's own launch
                    # directory) appear in the sidebar the moment the user sent a
                    # message. `workspace_selected` is computed just above, so
                    # the property is already meaningful here.
                    self.storage.create_session(
                        session_id, "New chat", workspace=self.effective_workspace,
                    )
            except Exception as exc:
                print(f"[Router] create_session({session_id}) failed: {exc}")
        else:
            # Sweep ghost sessions (empty rows created by prior boots) and back-fill
            # placeholder titles from the first user message, THEN pick a real one to
            # resume. Doing this before the resume query guarantees we can't pick a
            # ghost as the "most recent" session.
            try:
                deleted, retitled = self.storage.cleanup_sessions()
                if deleted or retitled:
                    print(f"[Router] cleanup_sessions: deleted={deleted} retitled={retitled}")
            except Exception as exc:
                print(f"[Router] cleanup_sessions failed: {exc}")
            # Reuse the most recent session with messages rather than spawning a new
            # UUID every startup. The old code created one per boot, which is why
            # the sidebar fills with untitled "Main session" ghosts.
            existing = self.storage.list_sessions(limit=1)
            if existing:
                self.session_id = existing[0]["id"]
            else:
                self.session_id = str(uuid.uuid4())
                self.storage.create_session(self.session_id, "New chat")
        self.bus = get_event_bus()
        self.risk = get_risk_controller()
        self.guard = get_output_guard()
        self.tools = get_tool_registry()
        self.skills = get_skill_loader()
        self.models = get_model_registry()
        #: Where the unchanging head of the system prompt ends this turn (3.3).
        #: Written by get_system_prompt, read by _llm_chat_streamed. Empty until
        #: the first prompt is built, and an empty value simply means "no cache
        #: breakpoint" — so a caller that skips get_system_prompt is safe.
        self._sys_cache_prefix: str = ""
        #: 稳定前缀注册表（进程内共享）。get_system_prompt 每次算出新的
        #: stable 前缀就按会话作用域注册一次；后续拼接点（技能展开、
        #: 定时任务）也可以注册自己的静态脚手架，让缓存断点落在确切
        #: 字节边界而不是整块消息。
        from prompt_cache_planner import get_stable_prefix_registry
        self._stable_prefixes = get_stable_prefix_registry()
        # Per-session, NOT singletons. The compactor accumulates read/modified
        # files and fold counters for one conversation; the queue is this
        # session's steer inbox. Sharing either one lets a fold triggered in
        # window A truncate window B's history, or a steer typed in A get
        # consumed by B's turn.
        # Config-tunable fold thresholds (`compaction` block in config.json) —
        # the same helper get_compactor() uses, applied to this session's own
        # compactor.
        from context_compactor import compaction_kwargs_from_config
        self.compactor = ContextCompactor(**compaction_kwargs_from_config())
        self.queue = MessageQueue()
        # The compactor emits `context_folded` on the shared bus; tag it with our
        # session so the fold card renders in the right window.
        self.compactor.session_id = self.session_id
        # Point memory at the workspace the user actually opened. Without this the
        # layer keeps its constructor default of ``os.getcwd()`` forever — nothing
        # in the codebase used to scope it at all — so recall was reading a
        # bucket keyed by wherever the backend process happened to start, while
        # writes were stamped with the real workspace. Memories got saved and then
        # never recalled.
        #
        # `effective_workspace`, not `workspace`: when the user hasn't picked a
        # folder, memories belong to the default workspace (`''`) — the same key
        # the sessions table uses — not to the backend's launch directory.
        #
        # A per-Router handle, not a mutable global root: the layer is a process
        # singleton and the app keeps several sessions open on different folders.
        # A shared "current workspace" meant the most recently constructed Router
        # silently repointed every other session's recall at ITS workspace. The
        # handle shares all the machinery (one DB handle, one embedder, one dream
        # loop) — only the scope differs. Passing the session id keeps this
        # session's WORKING-tier scratch in its own bucket, so two windows never
        # inject each other's "we're editing foo.py right now" notes.
        self.memory = get_memory_layer().for_root(
            self.effective_workspace, self.session_id,
        )
        # Layer 2 semantic memory: give memory_layer a local sentence embedder so
        # recall switches from OR-keyword scoring to cosine similarity. embed_text
        # degrades to None if sentence-transformers isn't installed, so this is
        # safe to wire unconditionally — the memory layer keeps working either way.
        self.memory.set_embed_callback(embed_text)
        # Layer 1 rule memory: user-editable rules/*.md, injected into the prompt.
        # Cached per workspace path, so two sessions in the same folder share the
        # parsed rules while sessions in different folders never cross-read.
        self.rules = get_rule_engine(self.workspace)

        # One axis, chosen by the USER per turn (never by the model):
        #   permission — plan / readonly / confirm / auto / full
        # It lives in `risk_control`, because that module already owns the
        # "may this call happen" question; a second enum next to it just meant
        # two places to keep in sync. `plan` and `readonly` hard-block writes
        # (a GLOBAL-layer DENY, which short-circuits the pipeline and so can't be
        # rescued by a granted permission); the rest differ only in whether a
        # write needs approval. There used to be a second `mode` axis (ask/plan/
        # edit/agent) on top of this, but the product IS an agent — "should it act
        # like an agent" is not a question worth asking every turn. Plan was the
        # only mode carrying real intent, so it moved onto this axis.
        # Baseline = config.json's `permissions.mode`. This was hardcoded AUTO,
        # so a user who set `plan` there was silently ignored; a caller that
        # sends nothing (tests, old frontend) still lands on auto when the
        # config omits the key too. The same read also feeds the agent-loop
        # ceiling and the compactor knobs below — one file touch, one dict.
        _cfg: dict = {}
        try:
            _cfg_path = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
            with open(_cfg_path, "r", encoding="utf-8") as _f:
                _cfg = json.load(_f)
        except Exception:
            _cfg = {}
        self.permission: PermissionMode = coerce_permission(
            (_cfg.get("permissions") or {}).get("mode"))
        # Per-turn tool-loop ceiling, user-tunable (`agent.max_steps_per_turn`).
        # 工业级 AI Agent 架构规范（业界主流方案对齐）：
        # 默认不设人为步数硬截断（_steps <= 0 代表无步数限制，持续执行直至自然收敛或用户打断）。
        # 若用户显式配置了正整数上限，则尊重用户设置，不再硬性钳位到 32 步。
        try:
            _steps_val = (_cfg.get("agent") or {}).get("max_steps_per_turn")
            _steps = int(_steps_val) if _steps_val is not None else 0
        except (TypeError, ValueError):
            _steps = 0
        self.max_agent_steps: int = _steps if _steps > 0 else 0
        self.soft_landing_step: int = max(1, self.max_agent_steps - 2) if self.max_agent_steps > 0 else -1
        #: Loop-detection thresholds (`agent.loop_detection`), read once and
        #: validated so a hand-edited config can't leave the circuit breaker
        #: unreachable. The detector itself is per-TURN (see `handle`); only its
        #: configuration is per-Router.
        from loop_detector import LoopConfig, LoopDetector
        self._loop_config = LoopConfig.from_config(_cfg)
        self.loop_detector: LoopDetector = LoopDetector(self._loop_config)
        from steer_protocol import SteerQueue
        self.steer_queue: SteerQueue = SteerQueue(msg_queue=self.queue)
        from repeat_tool_guard import RepeatToolGuard
        self.repeat_tool_guard: RepeatToolGuard = RepeatToolGuard()
        # `ask_user` 自动消解开关。默认开：答案其实已经在上下文里的时候，多问一遍
        # 只是白烧一个回合还打断人。判定本身是一次独立的模型调用，判不出来就照常
        # 问人 —— 详见 ask_user.py 里那三条纪律。
        self.ask_auto_resolve: bool = True
        # Per-session goal binding. GoalManager caches `_active_goal` and
        # `_session_id`, so a shared instance means session B's `set_session`
        # silently repoints session A's active goal. Goal ROWS stay in the shared
        # SQLite, so nothing is duplicated — only the in-memory cursor is local.
        self.goals = GoalManager()
        self.goals.set_session(self.session_id)
        self.llm = get_llm_client()
        #: The config.json-backed client. Every turn re-derives its working client
        #: from THIS one, so a model pick on one turn never leaks into the next:
        #: a turn that sends no model falls straight back to config's defaults.
        self._base_llm = self.llm
        #: The composite model id the current turn asked for ("" = config default).
        self._turn_model: str = ""
        #: Workspace-level defaults persisted via per-workspace settings
        #: (`workspace_settings_set`). The per-turn payload wins, then these,
        #: then config.json. Previously these were written onto the router under
        #: names nothing ever read, so the settings page changed nothing.
        self.workspace_model: str = ""
        self.workspace_thought_level: str = ""
        #: Thinking level for the current turn (UD4). "" = don't send the
        #: parameter at all, which is NOT the same as asking for no thinking.
        self._turn_effort: str = ""
        #: 本轮 `tool_search` 已经浮出来的工具名（六·UC1）。**按回合清空**：
        #: 每个新请求都有自己的相关性画像，留着上一轮的命中会一路累积到目录
        #: 又变成全量，裁剪就白做了。真的还需要，重搜一次的代价只有一次调用。
        self._revealed_tools: set[str] = set()
        #: `_revealed_tools` 变宽后置位，由 `_agent_loop` 在下一个步边界消费并
        #: 重建 tool_specs。用标志位而不是在工具里直接改 specs，是因为步边界是
        #: 唯一能安全换目录的地方 —— 一次模型调用发出去之后目录就定了。
        self._catalogue_dirty: bool = False


        # NOTE: session creation happens above (reuse-or-create). Do NOT
        # create_session here — it's INSERT OR REPLACE, so on a reused session
        # it would reset the title back to a placeholder and stomp created_at.
        # Restore any active goal for this session
        self.goals.load_goal_state(self.session_id)
        self._session_started = False  # session_start fires lazily on first handle()
        #: Cooperative cancel token for the in-flight turn. Set by ``cancel()``,
        #: checked between agent-loop steps and before each tool call.
        self._cancelled = asyncio.Event()
        #: call_id → tool name for every tool call currently in flight. Tools run
        #: in worker threads, so cancelling the await unwinds the coroutine while
        #: the child command keeps running; this registry is what makes killing
        #: it possible. Mutated from the event loop only (dispatch is awaited),
        #: so no lock is needed on this side — `executors` guards its own table.
        self._live_calls: dict[str, str] = {}
        self._turn_seq: int = -1  # updated at the start of each handle() call
        #: Optional tool allowlist. None → full catalogue. A set of tool names →
        #: only those tools are exposed to the model AND accepted at dispatch.
        #: Set by the sub-agent runtime so a spawned ``explore`` agent physically
        #: cannot write, no matter what the model tries.
        self.allowed_tools: Optional[frozenset] = None
        #: True when this Router is a spawned sub-agent (suppresses recursive
        #: ``task`` spawning and marks its turns as internal).
        self.is_subagent: bool = False
        #: Personas this sub-agent may hand the task onward to. Empty → it is a
        #: leaf and `task` stays hidden. Populated by the sub-agent runtime from
        #: the persona definition, never by the model.
        self.subagent_handoffs: frozenset = frozenset()
        #: How many hand-offs deep we already are. 0 = the user's own turn.
        self.subagent_depth: int = 0
        self._init_event_subscribers(mount_shared=mount_shared)
        # Load on-disk skills (.agents/skills) — discover() existed but was never
        # called, so skills on disk were invisible. This makes SOP / domain
        # skills actually available at runtime.
        try:
            self.skills.discover()
        except Exception as _e:
            # 技能不可见 = 能力静默失效（§11 渐进披露整条链路空转），必须喊出来
            print(f"[router] skill discover failed: {_e}")
        # Register the asset-derived analysis tools (diagnose / security_audit /
        # red_team_scan / recommend) so they are available in every entry point.
        self._register_analysis_tools()
        # Kick off idle-driven dream loop (P0 fix: DreamConsolidator was never started).
        # Best-effort — if no running loop yet, the caller can start it later via
        # `await router.start_background()`.
        try:
            asyncio.get_running_loop().create_task(self.memory.start_background())
        except RuntimeError:
            pass  # fail-open: 可选增强，失败不影响主流程

    def _init_event_subscribers(self, *, mount_shared: bool = True):
        """Mount event subscribers onto the process-wide bus.

        Two categories:
          - Process-wide (guards, sanitizers, risk): should only be mounted once
            per process lifetime. `mount_shared=False` skips them; `SessionHost`
            passes this for every router after the first.
          - Per-session (compactor, memory layer hooks): always mounted because
            each router instance has its own compactor/memory wiring.
        """
        if mount_shared:
            # PathGuard (priority 300): block writes escaping the workspace.
            get_path_guard().mount(self.bus)
            # AntiScrapingGuard (priority 120): escalate blacklisted platforms.
            get_anti_scraping_guard().mount(self.bus)
            self.risk.mount(self.bus)
            # Remote (Bot) sessions: enforce toolDenylist.
            get_remote_risk_decorator().mount(self.bus)
            self.guard.mount(self.bus)
            # OutputSanitizer (priority 50): strip MAC/abs paths from output.
            get_output_sanitizer().mount(self.bus)
            # HookRunner (priority -50): external script hooks on bus events.
            try:
                from hook_runner import get_hook_runner
                get_hook_runner(self.workspace, self.session_id).mount(self.bus)
            except Exception:
                pass
            # Capability recommender (priority 20): rank local skills/tools against
            # this turn and, only when the match is strong, name the top few in the
            # TOOLS layer. Process-wide because the ranker is a stateless singleton
            # — it scopes its cache by the workspace carried on the event.
            try:
                from recommender import get_recommender
                get_recommender().mount(self.bus)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程

        # Per-session subscribers — safe to mount per router because the compactor
        # and memory instances are already per-session (owned by `self`).
        self.compactor.mount(self.bus)
        # Give the compactor its LLM layer. Injected rather than imported so the
        # compactor stays independent of Router/memory_layer.
        self.compactor.set_summarizer(self._synthesize_for_fold)
        # Pre-compaction memory flush: extract decisions/preferences BEFORE the
        # summariser eats the transcript, so compaction stops being a net loss.
        self.compactor.set_memory_flush(self._flush_memory_for_fold)
        # Post-compaction memory warmup: prefetch relevant memories so the next
        # turn starts with both the summary skeleton and warm recall血肉.
        async def _warmup(session_id: str, query: str) -> None:
            try:
                await self.memory.active_recall(query, limit=5, session_id=session_id)
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        self.compactor.set_post_fold_warmup(_warmup)

        # Post-edit verification: verify the workspace after file edits.
        try:
            from post_edit_verifier import PostEditVerifier
            self._post_edit_verifier = PostEditVerifier(bus=self.bus)
            self._post_edit_verifier.mount(self.workspace, self.session_id)
        except Exception as exc:
            print(f"[Router] post-edit verifier mount skipped: {exc}")

        # P0 fix (audit §1 + §10): memory_layer had mount() but was never called.
        # Also wire session_before_compact -> synthesize_session for cross-session memory.
        self.memory.mount(self.bus)
        self.bus.on("session_before_compact", self._on_before_compact, priority=5)
        # Phase 1: mirror this session's turn/step/tool traffic into the
        # EventStore via the canonical gateway. Observational by design — a
        # broken trace mirror must never break the turn it traces.
        try:
            from router_trace import RouterTraceBridge
            self._trace_bridge = RouterTraceBridge(self.bus, self.session_id)
            self._trace_bridge.mount()
        except Exception:
            # Local import: this module predates the logging convention; a
            # NameError in the failure path would be worse than the failure.
            import logging
            logging.getLogger(__name__).exception("trace bridge failed to mount — turns run untraced")




_ROUTER_INSTANCE: Optional[Router] = None

def get_router(workspace: Optional[str] = None) -> Router:
    """Get or create the singleton Router instance."""
    global _ROUTER_INSTANCE
    if _ROUTER_INSTANCE is None:
        _ROUTER_INSTANCE = Router(workspace=workspace)
    return _ROUTER_INSTANCE
