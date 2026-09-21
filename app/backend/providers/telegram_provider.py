"""providers/telegram_provider.py - Telegram long-polling IMProvider.

Implements the Telegram Bot API over ``getUpdates`` long polling:
  - offset tracking so an update is never processed twice
  - /start /status /pause /resume commands
  - typewriter streaming via editMessageText
  - bot token + allowed_users read from bot_state (never hardcoded)

Transport is stdlib ``urllib`` executed in a worker thread, so the module has
no third-party dependency. If ``aiohttp`` is installed it is used instead for
lower overhead.
"""
from __future__ import annotations

import asyncio
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, AsyncGenerator, Optional

from providers.base import IMProvider
from result import Result
from storage import get_storage

try:  # optional, faster path
    import aiohttp  # type: ignore
    _HAS_AIOHTTP = True
except ImportError:  # pragma: no cover - depends on environment
    aiohttp = None  # type: ignore
    _HAS_AIOHTTP = False


class TelegramProvider(IMProvider):
    """Telegram Bot API provider using long polling.

    Args:
        token: Bot token. When omitted it is read from bot_state key
            ``telegram:config`` -> ``bot_token``.
        poll_timeout: Long-poll timeout in seconds passed to getUpdates.
    """

    API_BASE: str = "https://api.telegram.org"
    #: Telegram caps edits; throttle typewriter updates to stay well under it.
    STREAM_EDIT_INTERVAL: float = 0.8

    def __init__(self, token: Optional[str] = None, poll_timeout: int = 25) -> None:
        self.storage = get_storage()
        self._config: dict = self.storage.get_bot_state("telegram:config", {}) or {}
        self._token: str = token or self._config.get("bot_token", "")
        self._poll_timeout: int = poll_timeout
        self._offset: int = int(self._config.get("offset", 0))
        self._running: bool = False
        self._task: Optional[asyncio.Task] = None
        self._paused_users: set[str] = set()

    # ------------------------------------------------------------------
    # IMProvider contract
    # ------------------------------------------------------------------

    def get_platform_id(self) -> str:
        """Return the platform identifier."""
        return "telegram"

    def is_configured(self) -> bool:
        """Whether a bot token is available."""
        return bool(self._token)

    async def start_listening(self, controller: Any) -> None:
        """Begin the long-poll loop, dispatching messages to the controller.

        Args:
            controller: BotController that owns session isolation and security.
        """
        if not self.is_configured():
            return
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop(controller))

    async def stop_listening(self) -> None:
        """Stop the long-poll loop and persist the offset."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass  # fail-open: 取消语义即静默，正确
        self._persist_offset()

    async def send_message(self, user_id: str, content: str) -> bool:
        """Send a plain text message.

        Args:
            user_id: Telegram chat id.
            content: Message text (split automatically if over 4096 chars).

        Returns:
            True when every chunk was accepted by the API.
        """
        ok = True
        for chunk in self._split(content, 4096):
            r = await self._call("sendMessage", {"chat_id": user_id, "text": chunk})
            ok = ok and r.ok
        return ok

    async def send_streaming_card(
        self, user_id: str, content_stream: AsyncGenerator[str, None]
    ) -> bool:
        """Stream a reply with a typewriter effect via editMessageText.

        Sends a placeholder, then edits it as chunks arrive. Edits are
        throttled to ``STREAM_EDIT_INTERVAL`` to respect rate limits, and the
        final text is always flushed.

        Args:
            user_id: Telegram chat id.
            content_stream: Async generator yielding text deltas.

        Returns:
            True if the message was created and the final edit succeeded.
        """
        first = await self._call("sendMessage", {"chat_id": user_id, "text": "…"})
        if not first.ok:
            return False
        message_id = (first.value or {}).get("result", {}).get("message_id")
        if message_id is None:
            return False

        buffer = ""
        last_edit = 0.0
        last_sent = ""
        async for delta in content_stream:
            buffer += delta
            now = time.monotonic()
            if now - last_edit >= self.STREAM_EDIT_INTERVAL and buffer != last_sent:
                await self._edit(user_id, message_id, buffer)
                last_edit, last_sent = now, buffer
        if buffer and buffer != last_sent:
            return await self._edit_ok(user_id, message_id, buffer)
        return True

    # ------------------------------------------------------------------
    # Polling
    # ------------------------------------------------------------------

    async def _poll_loop(self, controller: Any) -> None:
        """Long-poll getUpdates until stopped, dispatching each message once."""
        backoff = 1.0
        while self._running:
            r = await self._call(
                "getUpdates",
                {"offset": self._offset, "timeout": self._poll_timeout},
                timeout=self._poll_timeout + 10,
            )
            if not r.ok:
                # Network hiccup: exponential backoff capped at 30s, keep looping.
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
                continue
            backoff = 1.0
            for update in (r.value or {}).get("result", []):
                self._offset = max(self._offset, int(update.get("update_id", 0)) + 1)
                await self._dispatch(controller, update)
            self._persist_offset()

    async def _dispatch(self, controller: Any, update: dict) -> None:
        """Route one Telegram update into the controller."""
        message = update.get("message") or update.get("edited_message")
        if not message:
            return
        text = (message.get("text") or "").strip()
        if not text:
            return
        chat_id = str(message.get("chat", {}).get("id", ""))
        user_id = str(message.get("from", {}).get("id", chat_id))
        if not self._user_allowed(user_id):
            await self.send_message(chat_id, "Not authorized.")
            return

        handled = await self._handle_builtin(chat_id, user_id, text)
        if handled:
            return
        if user_id in self._paused_users:
            await self.send_message(chat_id, "Paused. Send /resume to continue.")
            return

        result = await controller.handle_message("telegram", user_id, text)
        reply = result.value if getattr(result, "ok", False) else f"Error: {result.error}"
        await self.send_message(chat_id, str(reply))

    async def _handle_builtin(self, chat_id: str, user_id: str, text: str) -> bool:
        """Handle /start /status /pause /resume locally.

        Returns:
            True when the text was a built-in command and was answered.
        """
        cmd = text.split()[0].lower()
        if cmd == "/start":
            await self.send_message(
                chat_id,
                "Ovolve is connected.\n"
                "/status - show state\n/pause - stop processing\n/resume - continue",
            )
        elif cmd == "/status":
            state = "paused" if user_id in self._paused_users else "active"
            await self.send_message(chat_id, f"Status: {state}\nOffset: {self._offset}")
        elif cmd == "/pause":
            self._paused_users.add(user_id)
            await self.send_message(chat_id, "Paused.")
        elif cmd == "/resume":
            self._paused_users.discard(user_id)
            await self.send_message(chat_id, "Resumed.")
        else:
            return False
        return True

    def _user_allowed(self, user_id: str) -> bool:
        """Whether this Telegram user is on the allow list.

        Fail-closed: when ``allowed_users`` is unset nobody is allowed, because
        a bot token alone is a bearer credential that anyone who finds the bot
        can talk to.
        """
        allowed = self._config.get("allowed_users")
        if not allowed:
            return False
        return str(user_id) in {str(u) for u in allowed}

    def _persist_offset(self) -> None:
        """Persist the update offset so restarts do not replay messages."""
        cfg = dict(self._config)
        cfg["offset"] = self._offset
        self._config = cfg
        try:
            self.storage.save_bot_state("telegram:config", cfg)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    # ------------------------------------------------------------------
    # HTTP plumbing
    # ------------------------------------------------------------------

    async def _edit(self, chat_id: str, message_id: int, text: str) -> None:
        """Best-effort edit (ignores failures mid-stream)."""
        await self._edit_ok(chat_id, message_id, text)

    async def _edit_ok(self, chat_id: str, message_id: int, text: str) -> bool:
        """Edit a message, reporting whether it succeeded."""
        r = await self._call(
            "editMessageText",
            {"chat_id": chat_id, "message_id": message_id, "text": text[:4096]},
        )
        return r.ok

    async def _call(self, method: str, params: dict, timeout: int = 30) -> Result:
        """Call a Bot API method, returning a Result (never raising).

        Args:
            method: Bot API method name.
            params: JSON body.
            timeout: Socket timeout in seconds.

        Returns:
            Result with the decoded JSON payload, or an error string.
        """
        if not self._token:
            return Result.failure("Telegram token not configured")
        url = f"{self.API_BASE}/bot{self._token}/{method}"
        if _HAS_AIOHTTP:
            return await self._call_aiohttp(url, params, timeout)
        return await asyncio.to_thread(self._call_urllib, url, params, timeout)

    async def _call_aiohttp(self, url: str, params: dict, timeout: int) -> Result:
        """aiohttp transport."""
        try:
            cfg = aiohttp.ClientTimeout(total=timeout)
            async with aiohttp.ClientSession(timeout=cfg) as session:
                async with session.post(url, json=params) as resp:
                    body = await resp.json(content_type=None)
                    if resp.status != 200 or not body.get("ok", False):
                        return Result.failure(f"HTTP {resp.status}: {body}")
                    return Result.success(body)
        except Exception as e:
            return Result.failure(f"Telegram request failed: {e}")

    @staticmethod
    def _call_urllib(url: str, params: dict, timeout: int) -> Result:
        """Blocking stdlib transport, run in a worker thread."""
        data = json.dumps(params).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            if not body.get("ok", False):
                return Result.failure(f"Telegram error: {body}")
            return Result.success(body)
        except urllib.error.HTTPError as e:
            return Result.failure(f"HTTP {e.code}: {e.reason}")
        except Exception as e:
            return Result.failure(f"Telegram request failed: {e}")

    @staticmethod
    def _split(text: str, size: int) -> list[str]:
        """Split text into API-safe chunks, preferring newline boundaries."""
        if len(text) <= size:
            return [text] if text else [""]
        chunks: list[str] = []
        remaining = text
        while len(remaining) > size:
            cut = remaining.rfind("\n", 0, size)
            if cut <= 0:
                cut = size
            chunks.append(remaining[:cut])
            remaining = remaining[cut:].lstrip("\n")
        if remaining:
            chunks.append(remaining)
        return chunks
