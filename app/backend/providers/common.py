"""providers/common.py - shared plumbing for IM providers.

Telegram and Feishu each hand-rolled their own HTTP transport, allow-list check,
built-in command table and reply dispatch. Four more platforms copying that
would be four more places to fix the same bug, so everything that is *not*
platform-specific lives here and the concrete providers only describe what
makes their platform different.

Deliberately NOT retrofitted onto the existing two providers: they work, they
are covered by their own behaviour, and rewriting a working transport to save
duplication is how you turn a refactor into an outage.
"""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from typing import Any, AsyncGenerator, Optional

from providers.base import IMProvider
from result import Result
from storage import get_storage

try:  # optional, and the only path that supports WebSocket listeners
    import aiohttp  # type: ignore
    _HAS_AIOHTTP = True
except ImportError:  # pragma: no cover - depends on environment
    aiohttp = None  # type: ignore
    _HAS_AIOHTTP = False


HAS_AIOHTTP = _HAS_AIOHTTP


class BaseProvider(IMProvider):
    """Common behaviour for a credential-backed IM provider.

    Subclasses set ``PLATFORM`` and implement ``is_configured`` /
    ``send_message`` / listening. Config always comes from
    ``bot_state["{PLATFORM}:config"]`` — never from config.json, never
    hardcoded.
    """

    #: Platform id. Must match the key used by the registry and the UI.
    PLATFORM: str = ""
    #: Longest single outbound message the platform accepts.
    SEND_LIMIT: int = 4000
    #: False for push-only platforms, so the UI can say so instead of the user
    #: waiting forever for a reply that will never arrive.
    SUPPORTS_INBOUND: bool = True

    def __init__(self) -> None:
        self.storage = get_storage()
        self._config: dict = self.storage.get_bot_state(f"{self.PLATFORM}:config", {}) or {}
        self._running: bool = False
        self._controller: Any = None
        self._paused_users: set[str] = set()

    # ------------------------------------------------------------------
    # Config
    # ------------------------------------------------------------------

    def get_platform_id(self) -> str:
        return self.PLATFORM

    def cfg(self, key: str, default: str = "") -> str:
        """Read one string config value, treating empty string as absent."""
        return str(self._config.get(key) or default)

    def persist(self, **patch: Any) -> None:
        """Merge keys into the stored config. Best-effort: a failed write must
        never take down a live listener."""
        merged = dict(self._config)
        merged.update(patch)
        self._config = merged
        try:
            self.storage.save_bot_state(f"{self.PLATFORM}:config", merged)
        except Exception:
            pass  # fail-open: 可选增强，失败不影响主流程

    def user_allowed(self, user_id: str) -> bool:
        """Fail-closed allow-list.

        An empty list means nobody, not everybody. A bot token is a bearer
        credential — anyone who finds the bot can message it, so "unset" has to
        mean "locked", otherwise a half-finished setup is an open door.
        """
        allowed = self._config.get("allowed_users")
        if not allowed:
            return False
        return str(user_id) in {str(u) for u in allowed}

    # ------------------------------------------------------------------
    # Inbound routing (shared by every platform)
    # ------------------------------------------------------------------

    async def route(self, user_id: str, text: str, reply_to: Optional[str] = None) -> None:
        """Take one inbound message all the way to a sent reply.

        Order matters: authorization first, then built-ins, then the pause
        gate, and only then the agent. Built-ins stay reachable while paused —
        otherwise ``/resume`` would be unreachable and the user would be stuck.

        Args:
            user_id: Platform user id, used for the allow-list and session key.
            text: Message text, already trimmed.
            reply_to: Where the answer goes when it differs from ``user_id``
                (Discord channel, Slack channel, DingTalk session webhook).
        """
        target = reply_to or user_id
        if not self.user_allowed(user_id):
            await self.send_message(target, "Not authorized.")
            return
        if await self.handle_builtin(target, user_id, text):
            return
        if user_id in self._paused_users:
            await self.send_message(target, "Paused. Send /resume to continue.")
            return
        if self._controller is None:
            await self.send_message(target, "Backend not ready.")
            return
        result = await self._controller.handle_message(self.PLATFORM, user_id, text)
        reply = result.value if getattr(result, "ok", False) else f"Error: {result.error}"
        await self.send_message(target, str(reply))

    async def handle_builtin(self, target: str, user_id: str, text: str) -> bool:
        """Answer /start /status /pause /resume locally.

        Returns:
            True when the text was a command and has been answered.
        """
        head = text.split()[0].lower() if text.split() else ""
        if head == "/start":
            await self.send_message(
                target,
                f"Ovolve connected via {self.PLATFORM}.\n"
                "/status - show state\n/pause - stop processing\n/resume - continue",
            )
        elif head == "/status":
            state = "paused" if user_id in self._paused_users else "active"
            await self.send_message(target, f"Status: {state}")
        elif head == "/pause":
            self._paused_users.add(user_id)
            await self.send_message(target, "Paused.")
        elif head == "/resume":
            self._paused_users.discard(user_id)
            await self.send_message(target, "Resumed.")
        else:
            return False
        return True

    # ------------------------------------------------------------------
    # Streaming default
    # ------------------------------------------------------------------

    async def send_streaming_card(
        self, user_id: str, content_stream: AsyncGenerator[str, None]
    ) -> bool:
        """Collect the stream and send it as one message.

        Platforms that can edit a sent message (Telegram, Slack, Discord)
        override this for a typewriter effect. For the rest, one complete
        message beats a burst of fragments that each ping the user's phone.
        """
        buffer = ""
        async for delta in content_stream:
            buffer += delta
        if not buffer:
            return True
        return await self.send_message(user_id, buffer)

    # ------------------------------------------------------------------
    # HTTP transport
    # ------------------------------------------------------------------

    async def request(
        self,
        method: str,
        url: str,
        *,
        json_body: Optional[dict] = None,
        data: Optional[bytes] = None,
        headers: Optional[dict] = None,
        timeout: int = 30,
    ) -> Result:
        """Perform one HTTP call, never raising.

        Prefers aiohttp; falls back to stdlib urllib on a worker thread so the
        provider still works in a bare Python environment.

        Returns:
            Result whose value is the decoded JSON, or the raw text when the
            response is not JSON (DingTalk and WeCom both answer plain text on
            some paths).
        """
        hdrs = {"Content-Type": "application/json; charset=utf-8"}
        hdrs.update(headers or {})
        payload = data
        if json_body is not None and payload is None:
            payload = json.dumps(json_body, ensure_ascii=False).encode("utf-8")

        if _HAS_AIOHTTP:
            return await self._request_aiohttp(method, url, payload, hdrs, timeout)
        return await asyncio.to_thread(
            self._request_urllib, method, url, payload, hdrs, timeout
        )

    async def _request_aiohttp(
        self, method: str, url: str, payload: Optional[bytes], headers: dict, timeout: int
    ) -> Result:
        try:
            cfg = aiohttp.ClientTimeout(total=timeout)
            async with aiohttp.ClientSession(timeout=cfg) as session:
                async with session.request(
                    method, url, data=payload, headers=headers
                ) as resp:
                    text = await resp.text()
                    if resp.status >= 400:
                        return Result.failure(f"{self.PLATFORM} HTTP {resp.status}: {text[:300]}")
                    return Result.success(self._decode(text))
        except Exception as exc:  # noqa: BLE001 - transport errors are data here
            return Result.failure(f"{self.PLATFORM} request failed: {exc}")

    def _request_urllib(
        self, method: str, url: str, payload: Optional[bytes], headers: dict, timeout: int
    ) -> Result:
        req = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8", errors="replace")
            return Result.success(self._decode(text))
        except urllib.error.HTTPError as exc:
            return Result.failure(f"{self.PLATFORM} HTTP {exc.code}: {exc.reason}")
        except Exception as exc:  # noqa: BLE001
            return Result.failure(f"{self.PLATFORM} request failed: {exc}")

    @staticmethod
    def _decode(text: str) -> Any:
        try:
            return json.loads(text) if text else {}
        except json.JSONDecodeError:
            return text

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @classmethod
    def split(cls, text: str, size: Optional[int] = None) -> list[str]:
        """Chop text into API-safe chunks, preferring newline boundaries."""
        limit = size or cls.SEND_LIMIT
        if len(text) <= limit:
            return [text] if text else []
        chunks: list[str] = []
        rest = text
        while len(rest) > limit:
            cut = rest.rfind("\n", 0, limit)
            if cut <= 0:
                cut = limit
            chunks.append(rest[:cut])
            rest = rest[cut:].lstrip("\n")
        if rest:
            chunks.append(rest)
        return chunks

    def require_aiohttp(self) -> None:
        """Guard for WebSocket listeners.

        Raising here is intentional: ``BotController.start()`` catches it and
        reports ``error: ...`` for this platform only, so the user sees why
        instead of a provider that silently never connects.
        """
        if not _HAS_AIOHTTP:
            raise RuntimeError(
                f"{self.PLATFORM} needs aiohttp for its WebSocket listener "
                "(pip install aiohttp)"
            )
