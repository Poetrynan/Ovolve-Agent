"""
bot_remote.py - Bot remote control architecture.

Remote control via Telegram or Feishu (Lark) with:
  - Session isolation by provider:user_id
  - allowedWorkspace whitelist
  - toolDenylist for high-risk tools
  - BotController for unified interface
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from typing import Any, Callable, Optional

from result import Result
from storage import get_storage
from telemetry import get_telemetry, SpanName


class BotPlatform:
    """Platform identifier constants."""
    TELEGRAM = "telegram"
    FEISHU = "feishu"
    WECHAT = "wechat"


class BotMessage:
    """Message data class for bot communication."""

    def __init__(self, platform: str, user_id: str, content: str) -> None:
        self.id: str = str(uuid.uuid4())
        self.platform: str = platform
        self.user_id: str = user_id
        self.content: str = content
        self.timestamp: float = time.time()

    def to_dict(self, direction: str = "inbound") -> dict:
        """Serialize to dict for storage.

        Args:
            direction: 'inbound' or 'outbound'.

        Returns:
            Serialized message dict.
        """
        return {
            "id": self.id,
            "platform": self.platform,
            "user_id": self.user_id,
            "content": self.content,
            "direction": direction,
            "timestamp": self.timestamp,
        }


class BotController:
    """Bot remote controller with session isolation and security.

    Features:
      - Session isolation: each (platform, user_id) gets unique session
      - allowedWorkspace whitelist: restricts workspace access
      - toolDenylist: blocks high-risk tools in remote sessions
      - Message audit logging: tracks all remote operations
    """

    DEFAULT_DENYLIST = [
        "shell_executor",
        "process_kill",
        "app_install",
        "git_push",
        "bash",
    ]

    def __init__(self) -> None:
        self.storage = get_storage()
        self.telemetry = get_telemetry()
        self._handlers: dict[str, Callable] = {}
        self._sessions: dict[str, str] = {}
        # platform id -> IMProvider. Keyed so send/webhook can look one up.
        self._providers: dict[str, Any] = {}
        # platforms whose listener started successfully, for the status UI.
        self._listening: set[str] = set()
        self._llm_callback: Optional[Callable] = None

    def register_handler(self, command: str, handler: Callable) -> None:
        """Register a command handler.

        Args:
            command: Command string (e.g., '/start').
            handler: Async handler function.
        """
        self._handlers[command.lower()] = handler

    def set_llm_callback(self, callback: Callable) -> None:
        """Set LLM callback for processing user messages.

        Args:
            callback: Async function that takes (message, context) -> Result.
        """
        self._llm_callback = callback

    async def handle_message(
        self,
        platform: str,
        user_id: str,
        content: str,
    ) -> Result:
        """Handle an incoming message from a remote platform.

        Args:
            platform: Platform identifier (telegram/feishu).
            user_id: User identifier.
            content: Message content.

        Returns:
            Result with response text or error.
        """
        span = self.telemetry.start_span(SpanName.BOT_MESSAGE, platform=platform, user_id=user_id)
        try:
            # Fail-closed user allow-list check. Without this any user who
            # discovers the bot token could drive the machine.
            if not self.is_user_allowed(platform, user_id):
                self.audit_operation(
                    platform, user_id, "", "handle_message",
                    action="deny_user", blocked=True,
                    reason="user not in allowed_users",
                )
                span.add_event("user_denied", user_id=user_id)
                return Result.failure(
                    "Not authorized. Ask the workstation owner to add your ID to allowed_users."
                )

            session_key = f"{platform}:{user_id}"
            session_id = self._sessions.get(session_key)
            if not session_id:
                session_id = str(uuid.uuid4())
                self._sessions[session_key] = session_id
                self.storage.create_session(session_id, f"Remote: {platform}:{user_id}")

            msg = BotMessage(platform, user_id, content)
            self.storage.add_bot_message(msg.to_dict(direction="inbound"))

            cmd = content.strip().split()[0].lower() if content.strip() else ""

            if cmd in self._handlers:
                result = await self._handlers[cmd](content, session_id, user_id)
                span.add_event("command_handled", command=cmd)
            elif self._llm_callback:
                context = {
                    "session_id": session_id,
                    "user_id": user_id,
                    "platform": platform,
                    "is_remote": True,
                }
                result = await self._llm_callback(content, context)
                span.add_event("llm_processed")
            else:
                result = Result.success("No handler for this message")

            self.telemetry.end_span(span)
            return result
        except Exception as e:
            span.set_error(str(e))
            self.telemetry.end_span(span)
            return Result.failure(f"Error handling message: {e}")

    async def send_message(self, platform: str, user_id: str, content: str) -> Result:
        """Deliver a message to a user on ``platform`` and log it.

        Previously this only wrote a DB row, so "send" from the desktop UI was
        a no-op as far as the remote user was concerned. Now the registered
        provider actually ships it; the DB row is the audit trail, not the
        delivery mechanism.

        Delivery is attempted first so a transport failure is reported instead
        of being masked by a successful log write.

        Args:
            platform: Platform identifier.
            user_id: User identifier.
            content: Message content.

        Returns:
            Result carrying a human-readable status, or failure when no
            provider for ``platform`` is registered / the transport rejected it.
        """
        provider = self._providers.get(platform)
        msg = BotMessage(platform, user_id, content)

        if provider is None:
            self.storage.add_bot_message(msg.to_dict(direction="outbound"))
            return Result.failure(
                f"No {platform} provider is running. Save its credentials in "
                f"Settings → Bot, then restart the gateway."
            )

        try:
            delivered = await provider.send_message(user_id, content)
        except Exception as exc:  # noqa: BLE001 — transport errors are expected
            self.storage.add_bot_message(msg.to_dict(direction="outbound"))
            return Result.failure(f"{platform} delivery failed: {exc}")

        self.storage.add_bot_message(msg.to_dict(direction="outbound"))
        if not delivered:
            return Result.failure(f"{platform} rejected the message (check the receiver id)")
        return Result.success(f"Delivered to {platform}:{user_id}")

    def add_provider(self, provider: Any) -> None:
        """Register an IM provider instance, keyed by its platform id.

        Keyed by platform rather than appended to a list so ``send_message``
        and the webhook route can look up the one provider they need instead
        of scanning. Re-registering a platform replaces the old instance,
        which is what a credential change should do.

        Args:
            provider: IMProvider instance (Telegram/Feishu/etc).
        """
        self._providers[provider.get_platform_id()] = provider

    def get_provider(self, platform: str) -> Optional[Any]:
        """Return the registered provider for ``platform``, or None."""
        return self._providers.get(platform)

    async def start(self) -> dict:
        """Start listeners for every registered provider.

        Must run inside the server's event loop — Telegram's listener spawns a
        long-poll task and Feishu's pre-fetches a tenant token, neither of
        which can happen before the loop exists.

        One provider failing to start never blocks the others: a bad Telegram
        token should not take Feishu down with it.

        Returns:
            ``{platform: "listening" | "error: ..."}`` for logging / the UI.
        """
        report: dict[str, str] = {}
        for platform, provider in self._providers.items():
            try:
                await provider.start_listening(self)
                self._listening.add(platform)
                report[platform] = "listening"
            except Exception as exc:  # noqa: BLE001
                report[platform] = f"error: {exc}"
        return report

    async def stop(self) -> None:
        """Stop every running listener. Safe to call when nothing is running."""
        for platform, provider in self._providers.items():
            try:
                await provider.stop_listening()
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
            self._listening.discard(platform)

    def provider_status(self) -> list[dict]:
        """Per-platform state for the settings UI.

        Reports what is knowable without touching the network: whether
        credentials exist, whether a listener is running, and whether the
        allow-list has anyone in it. The last one matters because
        ``is_user_allowed`` fails closed — a configured bot with an empty
        allow-list answers nobody, and that is confusing without a hint.

        Returns:
            One dict per known platform.
        """
        from providers import available_providers, get_provider

        out: list[dict] = []
        for platform in available_providers():
            provider = self._providers.get(platform)
            configured = False
            if provider is None:
                # Not registered at boot → build a throwaway instance so the UI
                # reflects credentials saved since startup. Asking the provider
                # keeps "what counts as configured" in one place; the old
                # hardcoded bot_token/app_id guess here silently reported every
                # new platform as unconfigured no matter what the user typed.
                try:
                    provider = get_provider(platform)
                except Exception:
                    provider = None
            if provider is not None:
                try:
                    configured = bool(provider.is_configured())
                except Exception:
                    configured = False
            out.append({
                "platform": platform,
                "configured": configured,
                "listening": platform in self._listening,
                "allowedUsers": len(self.load_allowed_users(platform)),
            })
        return out


    def get_session_id(self, platform: str, user_id: str) -> Optional[str]:
        """Get session ID for a platform:user_id pair.

        Args:
            platform: Platform identifier.
            user_id: User identifier.

        Returns:
            Session ID or None.
        """
        return self._sessions.get(f"{platform}:{user_id}")

    def load_allowed_workspaces(self, platform: str) -> list[str]:
        """Load allowed workspace paths from bot-state.json.

        Args:
            platform: Platform identifier.

        Returns:
            List of allowed workspace paths.
        """
        state = self.storage.get_bot_state(f"{platform}:config", {})
        return state.get("allowed_workspaces", [])

    def load_tool_denylist(self, platform: str) -> list[str]:
        """Load tool denylist from bot-state.json.

        Args:
            platform: Platform identifier.

        Returns:
            List of blocked tool names.
        """
        state = self.storage.get_bot_state(f"{platform}:config", {})
        return state.get("tool_denylist", self.DEFAULT_DENYLIST)

    def load_allowed_users(self, platform: str) -> list[str]:
        """Load the allowed user ids for a platform.

        Args:
            platform: Platform identifier.

        Returns:
            List of allowed user id strings (empty means "nobody").
        """
        state = self.storage.get_bot_state(f"{platform}:config", {}) or {}
        return [str(u) for u in state.get("allowed_users", [])]

    def is_user_allowed(self, platform: str, user_id: str) -> bool:
        """Whether a remote user may drive this Agent.

        Fail-closed on purpose: an unconfigured allow list means nobody is
        authorized. A bot token is a bearer credential — anyone who finds the
        bot could otherwise run tools on the user's machine.

        Args:
            platform: Platform identifier.
            user_id: Remote user identifier.

        Returns:
            True only if the user is explicitly listed.
        """
        allowed = self.load_allowed_users(platform)
        if not allowed:
            return False
        return str(user_id) in allowed

    def is_workspace_allowed(self, platform: str, workspace_path: str) -> bool:
        """Check whether a workspace path is inside the allow list.

        Hardened over the original prefix check:
          - paths are resolved with ``realpath`` so ``allowed/../../etc`` and
            symlinks cannot escape
          - comparison is boundary-aware (``/allowed`` must not match
            ``/allowed-other``)
          - an empty allow list denies (fail-closed), not allows

        Args:
            platform: Platform identifier.
            workspace_path: Path to check.

        Returns:
            True if the path is within an allowed workspace.
        """
        allowed = self.load_allowed_workspaces(platform)
        if not allowed:
            return False
        try:
            target = os.path.realpath(os.path.abspath(workspace_path))
        except (OSError, ValueError):
            return False
        for root in allowed:
            try:
                base = os.path.realpath(os.path.abspath(root))
            except (OSError, ValueError):
                continue
            if target == base:
                return True
            if target.startswith(base.rstrip(os.sep) + os.sep):
                return True
        return False

    def is_tool_allowed(self, platform: str, tool_name: str) -> bool:
        """Check if a tool is not in the denylist.

        Args:
            platform: Platform identifier.
            tool_name: Tool name.

        Returns:
            True if allowed.
        """
        denylist = self.load_tool_denylist(platform)
        return tool_name not in denylist

    def audit_operation(
        self,
        platform: str,
        user_id: str,
        session_id: str,
        tool_name: str,
        action: str,
        blocked: bool,
        reason: str = "",
    ) -> None:
        """Log a remote operation to the audit table.

        Args:
            platform: Platform identifier.
            user_id: User identifier.
            session_id: Session identifier.
            tool_name: Tool name.
            action: Action performed.
            blocked: Whether the operation was blocked.
            reason: Reason for blocking (if any).
        """
        self.storage.add_bot_audit(platform, user_id, session_id, tool_name, action, blocked, reason)


class BotRemote:
    """Legacy facade kept only for the read-only message-log endpoint.

    The mutating paths used to run command handlers with NO authorization at
    all — any caller could invoke a registered handler by name. They now
    delegate to :class:`BotController`, which applies the fail-closed user
    allow-list and writes an audit row. Nothing here re-implements security;
    it forwards so there is exactly one enforcement point.

    New code should use ``get_bot_controller()`` directly.
    """

    def __init__(self) -> None:
        self.storage = get_storage()
        self.telemetry = get_telemetry()
        self._handlers: dict[str, Callable] = {}
        self._state: dict = {}

    def register_handler(self, command: str, handler: Callable) -> None:
        """Register a command handler on the real controller.

        Forwarded so a handler registered through the legacy facade is still
        reachable from the authorized path, instead of living in a shadow
        registry that bypasses the allow-list.
        """
        self._handlers[command] = handler
        get_bot_controller().register_handler(command, handler)

    async def send_message(self, platform: str, user_id: str, content: str) -> Result:
        """Send via the controller so delivery actually happens."""
        return await get_bot_controller().send_message(platform, user_id, content)

    async def receive_message(self, platform: str, user_id: str, content: str) -> Result:
        """Handle an inbound message through the authorized controller path.

        Previously this ran handlers with no allow-list check — the security
        hole this facade existed to avoid.
        """
        return await get_bot_controller().handle_message(platform, user_id, content)

    def set_state(self, key: str, value: Any) -> None:
        """Set bot state."""
        self._state[key] = value

    def get_state(self, key: str) -> Any:
        """Get bot state."""
        return self._state.get(key)

    def get_recent_messages(self, platform: str, user_id: str, limit: int = 20) -> list[dict]:
        """Get recent bot messages (read-only; safe to expose)."""
        return self.storage.get_bot_messages(platform, user_id, limit)


_bot: Optional[BotRemote] = None


def get_bot_remote() -> BotRemote:
    """Get the global BotRemote singleton."""
    global _bot
    if _bot is None:
        _bot = BotRemote()
    return _bot


_controller: Optional[BotController] = None


def get_bot_controller() -> BotController:
    """Get the global BotController singleton."""
    global _controller
    if _controller is None:
        _controller = BotController()
    return _controller
