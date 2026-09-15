"""
event_bus.py - Event-driven kernel core (Pi engineering pattern).

The kernel only loops: LLM -> tool -> event broadcast.
Risk control / anti-leakage / audit are all event subscribers.
Handlers can block / cancel / modify payload.

Events:
  tool_call, tool_result, before_provider, output,
  session_before_compact, session_start, user_prompt_submit,
  pre_tool_use, post_tool_use, post_tool_use_failure, stop
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional


class EventAction(Enum):
    CONTINUE = "continue"
    MODIFY = "modify"
    BLOCK = "block"
    CANCEL = "cancel"
    ASK = "ask"


@dataclass
class Event:
    """Event object flowing through the bus."""
    name: str
    payload: dict = field(default_factory=dict)
    action: EventAction = EventAction.CONTINUE
    modified_payload: Optional[dict] = None
    block_reason: str = ""
    propagation_stopped: bool = False

    def stop_propagation(self):
        self.propagation_stopped = True

    def block(self, reason: str = ""):
        self.action = EventAction.BLOCK
        self.block_reason = reason
        self.propagation_stopped = True

    def cancel(self):
        self.action = EventAction.CANCEL
        self.propagation_stopped = True

    def modify(self, new_payload: dict):
        self.action = EventAction.MODIFY
        self.modified_payload = new_payload

    def ask(self, prompt: str = ""):
        self.action = EventAction.ASK
        self.block_reason = prompt


class EventBus:
    """Event bus: register handlers + emit events.

    Supports sync and async handlers. Handlers execute by priority.
    stop_propagation stops subsequent handlers.
    """

    def __init__(self):
        self._handlers: dict = {}

    def on(self, event_name: str, handler: Callable, priority: int = 0):
        """Register a subscriber. Higher priority runs first."""
        if event_name not in self._handlers:
            self._handlers[event_name] = []
        seq = len(self._handlers[event_name])
        self._handlers[event_name].append((priority, seq, handler))
        self._handlers[event_name].sort(key=lambda x: (-x[0], x[1]))

    def off(self, event_name: str, handler: Callable):
        """Unsubscribe."""
        if event_name in self._handlers:
            self._handlers[event_name] = [
                (p, i, h) for p, i, h in self._handlers[event_name] if h != handler
            ]

    def once(self, event_name: str, handler: Callable, priority: int = 0):
        """Register a one-time subscriber."""
        def wrapper(event: Event):
            handler(event)
            self.off(event_name, wrapper)
        self.on(event_name, wrapper, priority)

    async def emit(self, event_name: str, payload: dict = None) -> Event:
        """Emit event, return final Event object (with handler modifications)."""
        event = Event(name=event_name, payload=payload or {})

        for _, _, handler in self._handlers.get(event_name, []):
            if event.propagation_stopped:
                break
            result = handler(event)
            if inspect.isawaitable(result):
                await result

        if event.action == EventAction.MODIFY and event.modified_payload is not None:
            event.payload = event.modified_payload

        return event

    def has_handlers(self, event_name: str) -> bool:
        return bool(self._handlers.get(event_name))

    # Aliases for compatibility
    subscribe = on
    unsubscribe = off

    def emit_sync(self, event_name: str, payload: dict = None) -> Event:
        """Emit event synchronously to subscribers."""
        import asyncio
        event = Event(name=event_name, payload=payload or {})
        for _, _, handler in self._handlers.get(event_name, []):
            if event.propagation_stopped:
                break
            result = handler(event)
            if inspect.isawaitable(result):
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(result)
                except RuntimeError:
                    pass
        if event.action == EventAction.MODIFY and event.modified_payload is not None:
            event.payload = event.modified_payload
        return event



# Global event bus singleton
_bus: Optional[EventBus] = None


def get_event_bus() -> EventBus:
    global _bus
    if _bus is None:
        _bus = EventBus()
    return _bus


def reset_event_bus():
    """Reset global event bus (for testing)."""
    global _bus
    _bus = EventBus()


def set_event_bus(bus: "EventBus") -> "EventBus":
    """Inject a specific bus as the global singleton (for tests / mocking).

    Lets a test build an isolated ``EventBus`` (or a subclass that records
    emissions) and make every ``get_event_bus()`` caller use it, so guards and
    subscribers can be exercised without touching the process-wide bus.

    Args:
        bus: The bus instance to install as the global singleton.

    Returns:
        The installed bus.
    """
    global _bus
    _bus = bus
    return _bus


def set_event_bus(bus: "EventBus") -> None:
    """Inject a specific bus as the global singleton (for testing/mocking).

    Lets a test build an isolated ``EventBus`` (or a subclass that records
    emitted events) and make every module resolve it via ``get_event_bus``.
    """
    global _bus
    _bus = bus
