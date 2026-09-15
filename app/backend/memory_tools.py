"""
memory_tools.py — the model's own hand for writing long-term memory.

Why this exists
---------------
Before this module the agent had **no way to keep a promise**. Memory was
injected into every prompt (five channels, see ``router.get_system_prompt``) but
the only writers were (a) the settings page and (b) ``memory_layer``'s debounced
extractor, which fires on file writes and never on conversation. So when a user
said "以后我想看电脑配置" the model would answer "知道了，下次直接这样查" — and
nothing anywhere recorded it. The next session started from zero.

That is the worst kind of failure: the reply was *syntactically* a promise and
*semantically* a lie, and nothing in the system could tell the difference.

The fix has two halves and this is the second one:

1. ``system_prompt.md`` P-06 forbids promising future behaviour unless the turn
   actually called something that writes it down.
2. This tool is that something.

Design notes
------------
* **Tier defaults to LONG_TERM**, matching ``handle_memory_entry_create``: a
  thing the user asked to be remembered must be *always-injected*, not left to
  retrieval scoring where it might simply never resurface.
* **Visible, not silent.** Unlike the debounced extractor, a tool call renders
  as a card in the UI, so the user sees the write happen. That visibility is the
  reason this is allowed to run without a separate confirmation step: the user
  asking to be remembered *is* the confirmation, and double-prompting for it
  would train them to click through prompts.
* **Returns what was actually stored**, not "ok". The model is required to
  describe only the line it really wrote, so it needs that line back.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from result import Result


#: Long enough for a real preference or decision, short enough that the model
#: cannot smuggle a transcript into always-inject context.
MAX_CONTENT_CHARS = 600

#: Vocabulary the memory layer already understands. Anything else is coerced to
#: ``fact`` rather than rejected — a wrong bucket is recoverable, a lost memory
#: is not.
ALLOWED_TYPES = ("fact", "preference", "context", "procedure")


def _remember_impl(args, ctx):
    """Persist one durable memory and report exactly what landed."""
    content = str(args.get("content") or "").strip()
    if not content:
        return Result.failure("content is required")

    if len(content) > MAX_CONTENT_CHARS:
        content = content[:MAX_CONTENT_CHARS].rstrip() + "…"

    mem_type = str(args.get("type") or "fact").strip().lower()
    if mem_type not in ALLOWED_TYPES:
        mem_type = "fact"

    try:
        importance = float(args.get("importance") or 0.7)
    except (TypeError, ValueError):
        importance = 0.7
    importance = min(1.0, max(0.0, importance))

    try:
        from memory_layer import get_memory_layer, Memory, MemoryScope
        from memory_tiers import MemoryTier, normalize_tier, policy_for
    except Exception as exc:  # import failure is a real error, not a no-op
        return Result.failure(f"memory layer unavailable: {exc}")


    tier = normalize_tier(args.get("tier") or MemoryTier.LONG_TERM.value)
    if not policy_for(tier).persisted:
        # A non-persisted tier would accept the write and lose it at session end,
        # which is precisely the silent failure this tool exists to remove.
        return Result.failure(
            f"tier '{tier.value}' is not durable; use long_term or semantic"
        )


    root = ""
    if isinstance(ctx, dict):
        root = str(ctx.get("workspace_root") or ctx.get("effective_workspace") or "")

    mem = Memory(
        content=content,
        mem_type=mem_type,
        importance=importance,
        scope=MemoryScope.PROJECT,
        root_dir=root,
        tags=[t for t in (args.get("tags") or []) if isinstance(t, str)],
        tier=tier.value,
    )

    result = get_memory_layer().store(mem)
    if not result.ok:
        return Result.failure(result.error or "store failed")

    return Result.success({
        "stored": content,
        "type": mem_type,
        "tier": tier.value,
        "importance": importance,
        "id": mem.id,
    })



def register_tools(registry=None) -> None:
    """Register the ``remember`` tool."""
    from tools import ToolDef, get_tool_registry
    registry = registry or get_tool_registry()
    registry.register(ToolDef(
        "remember",
        # Written for the model, not for docs: it states when to call, and — more
        # importantly — that saying "I'll remember" without calling this is a lie.
        "Persist one durable fact, preference or decision to long-term memory so "
        "it is available in future sessions. Call this whenever the user says to "
        "remember something, states a lasting preference, or agrees to a way of "
        "working. Never claim you will remember something unless this succeeded.",
        {"type": "object", "properties": {
            "content": {
                "type": "string",
                "description": "The single thing to remember, phrased so it still "
                               "makes sense months later with no conversation around it.",
            },
            "type": {
                "type": "string",
                "enum": list(ALLOWED_TYPES),
                "default": "fact",
            },
            "importance": {
                "type": "number",
                "description": "0-1. Higher survives context pressure longer.",
                "default": 0.7,
            },
            "tags": {"type": "array", "items": {"type": "string"}},
        }, "required": ["content"]},
        _remember_impl, domain="general", risk_level="low",
    ))
