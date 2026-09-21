"""
hook_system.py - Hook system (7 events).

Allows plugins to hook into key lifecycle events.
"""
from __future__ import annotations
import time
from typing import Any, Optional, Callable, List
from result import Result
from event_bus import get_event_bus, Event


class HookSystem:
    """Hook system for 7 key events.

    Events:
      1. session_start     - When a new session starts
      2. session_end       - When a session ends
      3. tool_call         - Before a tool is called
      4. tool_result       - After a tool returns
      5. pre_tool_use      - Before tool execution (risk control)
      6. output            - Before output to user (guard)
      7. session_before_compact - Before history compaction
    """

    EVENTS = [
        "session_start",
        "session_end",
        "tool_call",
        "tool_result",
        "pre_tool_use",
        "output",
        "session_before_compact",
    ]

    def __init__(self):
        self.bus = get_event_bus()
        self._hooks: dict[str, List[Callable]] = {e: [] for e in self.EVENTS}

    def register(self, event_name: str, handler: Callable, priority: int = 0):
        """Register a hook for an event."""
        if event_name not in self.EVENTS:
            return Result.failure(f"Unknown event: {event_name}")
        self._hooks[event_name].append(handler)
        self.bus.on(event_name, handler, priority=priority)
        return Result.success(f"Registered hook for: {event_name}")

    def unregister(self, event_name: str, handler: Callable):
        """Unregister a hook."""
        if event_name in self._hooks:
            self._hooks[event_name] = [h for h in self._hooks[event_name] if h != handler]
            self.bus.off(event_name, handler)

    async def trigger(self, event_name: str, payload: dict = None) -> Event:
        """Trigger a hook event."""
        return await self.bus.emit(event_name, payload)

    def get_hooks(self, event_name: str = None) -> dict:
        """Get registered hooks."""
        if event_name:
            return {event_name: self._hooks.get(event_name, [])}
        return self._hooks.copy()

    async def on_session_start(self, session_id: str, user_info: dict = None):
        await self.trigger("session_start", {
            "session_id": session_id,
            "user_info": user_info or {},
            "timestamp": time.time(),
        })

    async def on_session_end(self, session_id: str):
        await self.trigger("session_end", {
            "session_id": session_id,
            "timestamp": time.time(),
        })

    async def on_tool_call(self, tool_name: str, args: dict):
        return await self.trigger("tool_call", {
            "tool_name": tool_name,
            "args": args,
            "timestamp": time.time(),
        })

    async def on_tool_result(self, tool_name: str, result: Any):
        return await self.trigger("tool_result", {
            "tool_name": tool_name,
            "result": str(result)[:1000],
            "timestamp": time.time(),
        })

    async def on_pre_tool_use(self, tool_name: str, args: dict, context: dict):
        return await self.trigger("pre_tool_use", {
            "tool_name": tool_name,
            "args": args,
            "context": context,
        })

    async def on_output(self, text: str, user_intent: str):
        return await self.trigger("output", {
            "text": text,
            "user_intent": user_intent,
            "timestamp": time.time(),
        })

    async def on_session_before_compact(self, session_id: str):
        return await self.trigger("session_before_compact", {
            "session_id": session_id,
            "timestamp": time.time(),
        })


_hooks: Optional[HookSystem] = None
def get_hook_system() -> HookSystem:
    global _hooks
    if _hooks is None:
        _hooks = HookSystem()
    return _hooks
