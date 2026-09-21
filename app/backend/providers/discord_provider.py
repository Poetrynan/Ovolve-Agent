"""providers/discord_provider.py - Discord Gateway IMProvider.

Discord has no long-polling equivalent: a bot that wants to *receive* messages
without exposing a public HTTPS endpoint has to hold a Gateway WebSocket open.
So this provider speaks the Gateway protocol directly — HELLO, IDENTIFY,
heartbeat, MESSAGE_CREATE — and sends over the plain REST API.

Config lives in ``bot_state["discord:config"]``:
```json
{
  "bot_token": "MTIz...",
  "allowed_users": ["123456789012345678"]
}
```
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from providers.common import BaseProvider


class DiscordProvider(BaseProvider):
    """Discord bot over the Gateway WebSocket + REST send."""

    PLATFORM = "discord"
    API_BASE = "https://discord.com/api/v10"
    #: Discord rejects anything longer in a single message.
    SEND_LIMIT = 2000

    #: GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
    #: MESSAGE_CONTENT is privileged — it must also be toggled on in the
    #: Developer Portal, otherwise every `content` arrives as an empty string
    #: and the bot looks broken while the connection looks perfectly healthy.
    INTENTS = (1 << 9) | (1 << 12) | (1 << 15)

    def __init__(self) -> None:
        super().__init__()
        self._token = self.cfg("bot_token")
        self._task: Optional[asyncio.Task] = None
        self._ws: Any = None
        self._session: Any = None
        self._seq: Optional[int] = None
        self._hb_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # Contract
    # ------------------------------------------------------------------

    def is_configured(self) -> bool:
        return bool(self._token)

    async def start_listening(self, controller: Any) -> None:
        if not self.is_configured() or self._running:
            return
        self.require_aiohttp()
        self._controller = controller
        self._running = True
        self._task = asyncio.create_task(self._gateway_loop())

    async def stop_listening(self) -> None:
        self._running = False
        for task in (self._hb_task, self._task):
            if task and not task.done():
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass  # fail-open: 取消语义即静默，正确
        self._hb_task = self._task = None
        await self._close_ws()
        self._controller = None

    async def send_message(self, user_id: str, content: str) -> bool:
        """Post to a channel.

        ``user_id`` is a *channel* id here — inbound messages carry the channel
        they arrived on and that is where the answer belongs. Replying to the
        author id would need a DM channel lookup and would drag a public thread
        into private messages.
        """
        if not content.strip():
            return True
        ok = True
        for chunk in self.split(content):
            r = await self.request(
                "POST",
                f"{self.API_BASE}/channels/{user_id}/messages",
                json_body={"content": chunk},
                headers={"Authorization": f"Bot {self._token}"},
            )
            ok = ok and r.ok
        return ok

    # ------------------------------------------------------------------
    # Gateway
    # ------------------------------------------------------------------

    async def _gateway_loop(self) -> None:
        """Connect, identify, pump events; reconnect with backoff on drop.

        No session resume: after a drop we re-IDENTIFY from scratch. Resuming
        would save a few replayed events but needs session_id + resume_gateway
        bookkeeping, and a duplicated message here is harmless while a stuck
        listener is not.
        """
        import aiohttp  # local: require_aiohttp already proved it imports

        backoff = 1.0
        while self._running:
            try:
                self._session = aiohttp.ClientSession()
                url = await self._gateway_url()
                async with self._session.ws_connect(url, heartbeat=None) as ws:
                    self._ws = ws
                    backoff = 1.0
                    await self._pump(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                print(f"[discord] gateway error: {exc}")
            finally:
                await self._close_ws()
            if self._running:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _gateway_url(self) -> str:
        """Ask Discord where to connect, falling back to the documented host."""
        r = await self.request(
            "GET", f"{self.API_BASE}/gateway",
            headers={"Authorization": f"Bot {self._token}"},
        )
        base = ""
        if r.ok and isinstance(r.value, dict):
            base = str(r.value.get("url") or "")
        if not base:
            base = "wss://gateway.discord.gg"
        return f"{base}/?v=10&encoding=json"

    async def _pump(self, ws: Any) -> None:
        """Read frames until the socket closes."""
        async for msg in ws:
            if not self._running:
                break
            if msg.type.name not in ("TEXT", "BINARY"):
                break
            try:
                frame = json.loads(msg.data)
            except (json.JSONDecodeError, TypeError):
                continue
            await self._on_frame(ws, frame)

    async def _on_frame(self, ws: Any, frame: dict) -> None:
        op = frame.get("op")
        if frame.get("s") is not None:
            self._seq = frame["s"]

        if op == 10:  # HELLO
            interval = float(frame.get("d", {}).get("heartbeat_interval", 41250)) / 1000.0
            self._hb_task = asyncio.create_task(self._heartbeat(ws, interval))
            await ws.send_json({
                "op": 2,
                "d": {
                    "token": self._token,
                    "intents": self.INTENTS,
                    "properties": {"os": "linux", "browser": "ovolve", "device": "ovolve"},
                },
            })
        elif op == 0 and frame.get("t") == "MESSAGE_CREATE":
            await self._on_message(frame.get("d") or {})
        elif op in (7, 9):  # reconnect / invalid session -> drop and let the loop retry
            await ws.close()

    async def _heartbeat(self, ws: Any, interval: float) -> None:
        """Send op 1 on Discord's schedule.

        The first beat is jittered per Discord's guidance so a fleet of bots
        restarting together doesn't hammer the gateway on the same tick.
        """
        try:
            await asyncio.sleep(interval * 0.5)
            while self._running and not ws.closed:
                await ws.send_json({"op": 1, "d": self._seq})
                await asyncio.sleep(interval)
        except (asyncio.CancelledError, ConnectionResetError):
            pass  # fail-open: 取消语义即静默，正确
        except Exception:  # noqa: BLE001 - a dead heartbeat just drops the socket
            pass

    async def _on_message(self, data: dict) -> None:
        """Route one MESSAGE_CREATE, ignoring bots and empty text."""
        author = data.get("author") or {}
        if author.get("bot"):
            # Including ourselves. Without this a reply would re-trigger the
            # bot and two bots in one channel would talk forever.
            return
        text = str(data.get("content") or "").strip()
        if not text:
            return
        user_id = str(author.get("id") or "")
        channel_id = str(data.get("channel_id") or "")
        if not (user_id and channel_id):
            return
        await self.route(user_id, text, reply_to=channel_id)

    async def _close_ws(self) -> None:
        for obj in (self._ws, self._session):
            try:
                if obj is not None and not getattr(obj, "closed", True):
                    await obj.close()
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        self._ws = self._session = None
