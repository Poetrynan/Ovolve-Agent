"""router_modules/prompt.py - EnvironmentSnapshot, prompt assembly, and guidance blocks."""
from __future__ import annotations

import json
import os
import platform
import subprocess
import threading
import time
from typing import Any, Optional

from ask_user import prompt_block as ask_user_prompt_block
from prompt_layers import get_prompt_loader
from risk_control import prompt_block as permission_prompt_block
from tools import shorten_path


class EnvironmentSnapshot:
    """Build environment snapshot for system prompt injection with short TTL cache."""
    _cache: dict[str, tuple[float, str]] = {}
    _lock = threading.Lock()
    TTL_SECONDS = 2.5

    @classmethod
    def invalidate(cls, workspace: str = None) -> None:
        """Explicitly invalidate snapshot cache on file/git mutations."""
        with cls._lock:
            if workspace:
                ws_key = os.path.abspath(workspace)
                cls._cache.pop(ws_key, None)
            else:
                cls._cache.clear()

    @classmethod
    def build(cls, workspace: str = None) -> str:
        ws = workspace or os.getcwd()
        ws_key = os.path.abspath(ws)
        now = time.time()
        with cls._lock:
            cached = cls._cache.get(ws_key)
            if cached and (now - cached[0]) < cls.TTL_SECONDS:
                return cached[1]

        parts = ["# Environment Snapshot (snapshot in time)\n"]
        parts.append(f"- Working directory: `{shorten_path(ws)}`")
        parts.append(f"- Platform: {platform.system()} {platform.release()}")
        parts.append(f"- Python: {platform.python_version()}")
        # Git snapshot
        git_info = cls._git_snapshot(ws)
        if git_info:
            parts.append(f"\n## Git Status\n{git_info}")
        else:
            # Directory snapshot for non-git dirs
            dir_info = cls._dir_snapshot(ws)
            if dir_info:
                parts.append(f"\n## Directory Overview\n{dir_info}")
        res = "\n".join(parts)
        with cls._lock:
            cls._cache[ws_key] = (now, res)
        return res

    @staticmethod
    def _git_snapshot(ws: str) -> Optional[str]:
        git_dir = os.path.join(ws, ".git")
        if not os.path.exists(git_dir):
            return None
        try:
            def _git(args: list[str]) -> str:
                return subprocess.run(
                    ["git", "-c", "core.quotePath=false"] + args,
                    capture_output=True, text=True,
                    encoding="utf-8", errors="replace",
                    cwd=ws, timeout=5,
                ).stdout.strip()

            branch = _git(["rev-parse", "--abbrev-ref", "HEAD"])
            status = _git(["status", "--short"])
            log = _git(["log", "--oneline", "-5"])
            # Capture the committer identity and the repo's main
            # branch so the model can reason about "merge to main" style asks.
            user = _git(["config", "user.name"])
            main_branch = EnvironmentSnapshot._main_branch(ws, _git)

            parts = [f"- Branch: `{branch}`"]
            if main_branch and main_branch != branch:
                parts.append(f"- Main branch: `{main_branch}`")
            if user:
                parts.append(f"- Git user: {user}")
            parts.append(f"- Status: {'dirty' if status else 'clean'}")
            if status:
                lines = status.split("\n")[:10]
                parts.append(f"- Modified files: {len(status.split(chr(10)))}")
                parts.append("```\n" + "\n".join(lines) + "\n```")
            else:
                parts.append("- Working tree clean")
            parts.append("- Recent commits:\n```\n" + log + "\n```")
            return "\n".join(parts)
        except Exception:
            return None

    @staticmethod
    def _main_branch(ws: str, _git) -> str:
        """Resolve the repo's main branch (origin/HEAD, else main/master)."""
        head = _git(["symbolic-ref", "refs/remotes/origin/HEAD"])
        if head:
            return head.rsplit("/", 1)[-1]
        for candidate in ("main", "master"):
            if _git(["rev-parse", "--verify", candidate]):
                return candidate
        return ""

    @staticmethod
    def _dir_snapshot(ws: str) -> Optional[str]:
        try:
            entries = sorted(os.listdir(ws))[:20]
            dirs = [e+"/" for e in entries if os.path.isdir(os.path.join(ws,e)) and not e.startswith(".")]
            files = [e for e in entries if os.path.isfile(os.path.join(ws,e)) and not e.startswith(".")]
            parts = [f"- Directories: {', '.join(dirs[:10])}"]
            parts.append(f"- Files: {', '.join(files[:10])}")
            return "\n".join(parts)
        except Exception:
            return None


def _is_cot_content_leak(text: str) -> bool:
    """True when *text* looks like a spurious content token during CoT streaming.

    Some reasoning gateways (e.g. LongCat) emit ``reasoning_content`` and also
    leak 1–2 punctuation/digit tokens on the ``content`` channel while thinking.
    Those must not grow the assistant bubble.
    """
    t = (text or "").strip()
    if not t:
        return True
    if len(t) > 2:
        return False
    for c in t:
        if c.isalpha() or ("\u4e00" <= c <= "\u9fff"):
            return False
    return True


def _strip_leading_junk(text: str) -> str:
    """Strip a SHORT junk prefix（≤2 数字/标点字符，判据同 _is_cot_content_leak）
    from the first frame of a channel. Returns the remainder; "" when the whole
    frame is junk.

    为什么需要它：帧级检查只拦得住“纯垃圾帧”，拦不住垃圾前缀粘着真实文本的
    混合帧（“0你好”len>2 直接放行）——用户看到的现象就是回复以一个幽灵 "0"
    开头、agent_response 替换后它又消失（最终组装走 llm_client 的 done.reply，
    与流式分帧是两条路）。超过 2 字符的数字/标点前缀视为合法内容（“2026 年…”）
    原样放行——保留 len>2 的逃生门，与 _is_cot_content_leak 口径一致。"""
    t = text or ""
    n = 0
    for c in t:
        if c.isalpha() or ("\u4e00" <= c <= "\u9fff"):
            break
        n += 1
    else:
        return ""  # 整帧都是垃圾
    if 0 < n <= 2:
        return t[n:].lstrip()
    return t


# ---------------------------------------------------------------------------
# Plan 档：已批准方案的合同注入（缺口 B）
# ---------------------------------------------------------------------------

def _approved_plan_context(messages: list, context: dict) -> tuple:
    """执行轮前置：把已批准方案合同注入消息头，并产出 meta 附加字段。

    返回 ``(messages, meta_extra)``。合同以 user 角色紧贴原始请求注入——
    不用 system：中途 system 消息会扰动既有 compactor 的轮次视角与缓存
    断点布局。方案未批准/不存在时原样返回（fail-open）。
    """
    meta_extra: dict = {}
    plan_id = str((context or {}).get("approved_plan") or "").strip()
    if not plan_id:
        return messages, meta_extra
    try:
        from plan_artifact import get_plan_artifact, render_contract
        art = get_plan_artifact(plan_id)
        if not art or art.get("status") != "approved":
            return messages, meta_extra
        contract = render_contract(art)
        injected = [{"role": "user", "content": contract}] + list(messages)
        meta_extra["approved_with"] = str(art.get("approved_with") or "")
        meta_extra["approved_plan_id"] = plan_id
        return injected, meta_extra
    except Exception as exc:
        print(f"[plan_artifact] contract injection failed (fail-open): {exc}")
        return messages, meta_extra


def _merge_plan_meta(meta: dict, context: Any) -> dict:
    """终态 meta 组装：把执行轮记下的方案审批信息并入轮次 meta。

    ``_plan_meta`` 由 ``_approved_plan_context`` 产出、经 ``_agent_loop``
    写进 context；此前全库没有消费者，``approved_with`` / ``approved_plan_id``
    这两个值走不到轮次终态。取出即消费（pop），避免残留到后续轮次。
    """
    if not isinstance(context, dict):
        return meta
    plan_meta = context.pop("_plan_meta", None)
    if isinstance(plan_meta, dict) and plan_meta:
        meta.update(plan_meta)
    return meta


class RouterPromptMixin:
    """Mixin providing prompt building, guidance reading, and plan capture for Router."""

    GUIDANCE_FILES: tuple = ("MEMORY.md", "AGENTS.md", "SOUL.md")
    GUIDANCE_MAX_CHARS: int = 6000

    def _read_guidance_file(self, name: str) -> str:
        """Read one workspace-root guidance file, or "" if it isn't usable.

        Containment is checked with realpath rather than trusting the join: the
        workspace root comes from configuration, and a symlinked AGENTS.md would
        otherwise pull arbitrary file content into the system prompt.
        """
        root = getattr(self, "workspace", None) or ""
        if not root:
            return ""
        try:
            base = os.path.realpath(root)
            target = os.path.realpath(os.path.join(base, name))
            if not target.startswith(base + os.sep):
                return ""      # a symlink resolved outside the workspace
            if not os.path.isfile(target):
                return ""
            with open(target, "r", encoding="utf-8", errors="replace") as f:
                text = f.read(self.GUIDANCE_MAX_CHARS + 1)
        except OSError:
            return ""
        text = text.strip()
        if not text:
            return ""
        if len(text) > self.GUIDANCE_MAX_CHARS:
            text = text[:self.GUIDANCE_MAX_CHARS].rstrip() + "\n…（已截断，完整内容见项目根目录该文件）"
        return text

    def guidance_blocks(self) -> dict[str, str]:
        """All readable guidance files, keyed by filename. Empty when none exist."""
        out: dict[str, str] = {}
        for name in self.GUIDANCE_FILES:
            body = self._read_guidance_file(name)
            if body:
                out[name] = body
        return out

    def _sync_turn_cache_prefix(self, full_system: str) -> None:
        """Extend cache prefix using registry longest_match after skill append."""
        try:
            _, matched = self._stable_prefixes.longest_match(full_system or "")
            if matched and len(matched) > len(getattr(self, "_sys_cache_prefix", None) or ""):
                self._sys_cache_prefix = matched
        except Exception:
            pass

    def _skill_guidance_block(self, context: dict) -> str:
        """LLM 主环路的 Stage-2 渐进披露（Step E 补全）。

        触发命中的技能正文作为【不可信参考资料】注入系统提示——模型看见的
        是参考，不是指令。注入与否记录在 context['skill_injected']，回合终态
        据此记账：没注入就不算"用了技能"，不造经验假账。
        """
        try:
            if not context or context.get("benchmark"):
                return ""
            cands = context.get("skill_candidates") or []
            if not cands or context.get("skill_injected"):
                return ""
            entry = self.skills.get_skill(str(cands[0].get("name") or ""))
            if entry is None:
                return ""
            loaded = self.skills.load_skill_body(entry.name)
            if not getattr(loaded, "ok", False):
                return ""
            val = getattr(loaded, "value", None) or {}
            body = (str(val.get("body") or "") if isinstance(val, dict)
                    else str(val or "")).strip()
            if not body:
                return ""
            context["skill_injected"] = {
                "name": entry.name,
                "version": getattr(entry, "version", "") or "",
            }
            from active_memory import wrap_untrusted
            wrapped = wrap_untrusted(body[:2000], source="skill")
            block = (f"\n\n<skill-guidance source=\"trigger-matched-skill\""
                    f" name=\"{entry.name}\">\n{wrapped}\n</skill-guidance>")
            try:
                scope = self.compactor.cache_scope()
                base = getattr(self, "_sys_cache_prefix", None) or ""
                # 技能正文在同名同版本下跨轮稳定——登记为可缓存前缀，
                # 让规划器通过 longest_match 命中，而不是每轮冷写。
                self._stable_prefixes.register(
                    f"skill:{scope}:{entry.name}:{getattr(entry, 'version', '')}",
                    base + block,
                )
            except Exception:
                pass
            return block
        except Exception as e:
            print(f"[skills] guidance inject failed: {e}")
            return ""

    async def _maybe_capture_plan(self, context: dict, output: str) -> None:
        """permission=plan 的成功轮次把最终输出存成方案产物并广播 plan_ready。

        只在 plan 档、有实质输出时触发；提取 ```plan 围栏优先，无围栏取全文。
        Fail-open：任何异常只打日志，绝不影响轮次本身的返回；plan_id 写回
        context 供调用方并入 turn meta，前端据此弹方案审批卡。
        """
        try:
            if (context or {}).get("permission") != "plan":
                return
            text = str(output or "")
            if not text.strip():
                return
            from plan_artifact import save_plan_artifact, extract_plan_block
            plan_md = extract_plan_block(text)
            if not plan_md:
                return
            art = save_plan_artifact(
                self.session_id, plan_md,
                meta={"turn_id": str((context or {}).get("turn_id") or "")},
            )
            await self.bus.emit("plan_ready", {
                "session_id": self.session_id,
                "plan_id": art["plan_id"],
                "chars": art["chars"],
                "preview": plan_md[:300],
            })
            context["plan_id"] = art["plan_id"]
        except Exception as exc:
            print(f"[plan_artifact] capture failed (fail-open): {exc}")

    def get_system_prompt(self, context: dict = None) -> str:
        """Build the system prompt from the six-layer file cluster."""
        ctx = context or {}
        if ctx.get("benchmark"):
            return (
                "You are an elite scientific researcher, mathematician, and expert problem solver with PhD-level mastery "
                "across physics, chemistry, biology, materials science, and mathematics.\n\n"
                "### Core Operating Constitution:\n"
                "1. First-Principles Deconstruction: Do not rely on intuition, superficial pattern-matching, or mental shortcuts. "
                "Explicitly identify the governing physical laws, reaction mechanisms, differential equations, biochemical pathways, "
                "or mathematical definitions involved.\n"
                "2. Mandatory Code-as-Scratchpad Verification: You have access to python_executor (which supports math, numpy, scipy, "
                "sympy, itertools, fractions, etc.) and shell_executor. For any quantitative, combinatorial, thermodynamic, spectroscopic, "
                "or coordinate problem, NEVER calculate in your head. Write and execute Python code to compute exact values, check units, "
                "evaluate matrix determinants, solve roots, or verify limits.\n"
                "3. Adversarial Distractor Auditing: In multiple-choice questions (MCQs), incorrect options are specifically designed to "
                "exploit common misconceptions, sign flips, index shifts, standard temperature/pressure conversions, and stoichiometric ratios. "
                "Before concluding, systematically eliminate distractors by proving why each alternative choice is invalid.\n"
                "4. Tool Error Resilience: If a tool call returns an error or empty output, immediately inspect the failure, adjust the syntax "
                "or parameters, and re-run. Do not give up on verification.\n"
                "5. Strict Output Protocol: At the very end of your final response, state your definitive answer in the exact format "
                "requested in the prompt (e.g., 'ANSWER: $CHOICE' where $CHOICE is A, B, C, or D; or 'FINAL ANSWER: $VALUE')."
            )

        snapshot = EnvironmentSnapshot.build(self.workspace)
        model_info = self.models.resolve()
        model_name = model_info.value.get("model_id", "unknown") if model_info.ok else "unknown"

        # ── MEMORY layer: tier inject + wiki claims + recall + synthesis ──
        memory_parts: list[str] = []

        # 1. C1 always-inject tiers (WORKING + LONG_TERM). User-editable,
        #    pre-budgeted, highest trust.
        tier_inject = ctx.get("memory_inject")
        if tier_inject:
            memory_parts.append(
                "## Persistent Memory (curated; WORKING + LONG_TERM tiers)\n"
                + str(tier_inject)
            )

        # 1b. Project guidance files (AGENTS.md / MEMORY.md / SOUL.md), read back off disk.
        for _name, _body in self.guidance_blocks().items():
            memory_parts.append(f"## Project Guidance · {_name}\n{_body}")

        # 2. C4 wiki claims.
        wiki_block = ctx.get("wiki_claims")
        if wiki_block:
            memory_parts.append(
                "## Declarative Knowledge (wiki claims)\n"
                "带 status=\"disputed\" 的条目存在未裁决的矛盾——需要时向用户澄清，"
                "不要自己挑一边当事实。\n" + str(wiki_block)
            )

        # 3. C3 recalled episodic memory.
        injected = ctx.get("injected_memories") or []
        if injected:
            body = "\n".join(injected) if isinstance(injected, list) else str(injected)
            memory_parts.append(
                "## Recalled Memory (from previous sessions; not user-visible)\n" + body
            )

        # 4. Reflexion (NeurIPS 2023): 前置避坑反思与历史教训
        reflections = ctx.get("reflections")
        if reflections:
            memory_parts.append("## Reflexion Self-Reflections (前置避坑与自省)\n" + str(reflections))

        prev = self.memory.get_session_synthesis(self.session_id)
        if prev:
            body = json.dumps(prev, indent=2, ensure_ascii=False, default=str)
            memory_parts.append(f"## Session Synthesis\n```json\n{body}\n```")
        else:
            # Cross-session: parent fork synthesis or recent workspace syntheses
            try:
                row = self.storage.get_session(self.session_id) or {}
                parent_id = str(row.get("parent_id") or "")
                if parent_id:
                    ps = self.memory.get_session_synthesis(parent_id)
                    if ps:
                        body = json.dumps(ps, indent=2, ensure_ascii=False, default=str)
                        memory_parts.append(
                            f"## Prior Session Synthesis (from parent)\n```json\n{body}\n```"
                        )
                ws = str(row.get("workspace") or self.effective_workspace or "")
                for item in self.storage.get_workspace_recent_synthesis(ws, self.session_id, limit=2):
                    body = json.dumps(item.get("synthesis") or {}, indent=2, ensure_ascii=False, default=str)
                    memory_parts.append(
                        f"## Cross-Session Synthesis (session {item.get('session_id', '')[:8]}…)\n```json\n{body}\n```"
                    )
            except Exception:
                pass

        # ── AGENTS layer: active goal keeps long tasks alive across turns ──
        agents_parts: list[str] = []
        goal_ctx = self.goals.get_active_goal_context()
        if goal_ctx:
            agents_parts.append(f"## Active Goal\n{goal_ctx}")

        # ── SOUL layer: builtin constitution + the user's own rule library ──
        loader = self._prompt_loader()
        base_layers = {l.name: l.content for l in loader.load()}

        soul_override = None
        rules_block = self.rules.render_for_prompt()
        if rules_block:
            soul_override = (base_layers.get("SOUL", "") + "\n\n" + rules_block).strip()

        # ── Dynamic Turn Rules & Capability Hints (placed in dynamic MEMORY layer) ──
        hint_block = ctx.get("capability_hints")
        if hint_block:
            memory_parts.append(f"## Recommended Capabilities for This Turn\n{hint_block}")

        perm_block = permission_prompt_block(self.permission)
        ask_block = ask_user_prompt_block(
            not (getattr(self, "is_subagent", False) or (context or {}).get("is_remote"))
        )
        dynamic_exec_blocks = "\n\n".join(b for b in (perm_block, ask_block) if b)
        if dynamic_exec_blocks:
            memory_parts.append(f"## Turn Execution Policy\n{dynamic_exec_blocks}")

        overrides = {
            "MEMORY": "\n\n".join(memory_parts),
            "AGENTS": "\n\n".join(agents_parts),
        }
        if soul_override:
            overrides["SOUL"] = soul_override

        # TOOLS layer: Stage 1 of progressive skill disclosure (B2).
        tools_block = (context or {}).get("available_skills_block") or ""
        if not tools_block:
            try:
                tools_block = self.skills.render_available_skills_prompt()
            except Exception:
                tools_block = ""  # a broken catalogue must not kill the turn
        if tools_block:
            overrides["TOOLS"] = tools_block
            try:
                self._stable_prefixes.register(
                    f"tools:{self.compactor.cache_scope()}", tools_block,
                )
            except Exception:
                pass

        layered, stable = loader.render_and_prefix(overrides)
        self._sys_cache_prefix = stable
        try:
            self._stable_prefixes.register(
                f"sys:{self.compactor.cache_scope()}", stable,
            )
        except Exception:
            pass

        return (
            f"{layered}\n\n"
            f"{snapshot}"
            f"\n## Active Model: {model_name}\n"
            f"## Session: {self.session_id}\n"
        )

    def _prompt_loader(self):
        """Lazily bind the layer loader to this router's workspace."""
        return get_prompt_loader(self.workspace, master_prompt=getattr(self, "system_prompt", "") or "")
