"""providers/slack_provider.py - Slack Socket Mode IMProvider.

Socket Mode instead of the Events API on purpose: Events API needs a publicly
reachable HTTPS callback, which a desktop app running behind NAT does not have.
Socket Mode dials *out* to Slack, so it works from a laptop with no tunnel.

Two tokens, and they are not interchangeable:
  - ``app_token`` (``xapp-…``) opens the WebSocket. Nothing else.
  - ``bot_token`` (``xoxb-…``) authorizes chat.postMessage.

Config lives in ``bot_state["slack:config"]``:
```json
{
  "bot_token": "xoxb-…",
  "app_token": "xapp-…",
  "allowed_users": ["U01ABCDEF"]
}
```
"""
from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

from providers.common import BaseProvider


class SlackProvider(BaseProvider):
    """Slack bot over Socket Mode, sending via Web API."""

    PLATFORM = "slack"
    API_BASE = "https://slack.com/api"
    #: chat.postMessage tolerates more, but long single blocks get truncated in
    #: the client, so split well before the hard cap.
    SEND_LIMIT = 3800

    def __init__(self) -> None:
        super().__init__()
        self._bot_token = self.cfg("bot_token")
        self._app_token = self.cfg("app_token")
        self._task: Optional[asyncio.Task] = None
        self._ws: Any = None
        self._session: Any = None

    # ------------------------------------------------------------------
    # Contract
    # ------------------------------------------------------------------

    def is_configured(self) -> bool:
        # Both tokens matter: with only xoxb the bot can talk but never hears,
        # which is the most confusing half-working state possible.
        return bool(self._bot_token and self._app_token)

    async def start_listening(self, controller: Any) -> None:
        if not self.is_configured() or self._running:
            return
        self.require_aiohttp()
        self._controller = controller
        self._running = True
        self._task = asyncio.create_task(self._socket_loop())

    async def stop_listening(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass  # fail-open: 取消语义即静默，正确
        self._task = None
        await self._close_ws()
        self._controller = None

    async def send_message(self, user_id: str, content: str) -> bool:
        """Post to a channel id (or a user id, which Slack opens as a DM)."""
        if not content.strip():
            return True
        ok = True
        for chunk in self.split(content):
            r = await self.request(
                "POST",
                f"{self.API_BASE}/chat.postMessage",
                json_body={"channel": user_id, "text": chunk},
                headers={"Authorization": f"Bearer {self._bot_token}"},
            )
            # Slack answers HTTP 200 with {"ok": false, "error": "..."} for
            # things like invalid_auth, so HTTP status alone is not success.
            body = r.value if isinstance(r.value, dict) else {}
            if not r.ok or not body.get("ok"):
                print(f"[slack] send failed: {r.error or body.get('error')}")
                ok = False
        return ok

    # ------------------------------------------------------------------
    # Socket Mode
    # ------------------------------------------------------------------

    async def _socket_loop(self) -> None:
        """Open a socket, pump envelopes, reconnect with backoff."""
        import aiohttp

        backoff = 1.0
        while self._running:
            try:
                url = await self._open_connection()
                if not url:
                    await asyncio.sleep(backoff)
                    backoff = min(backoff * 2, 60.0)
                    continue
                self._session = aiohttp.ClientSession()
                # Slack pings us; aiohttp answers pongs automatically.
                async with self._session.ws_connect(url, heartbeat=30) as ws:
                    self._ws = ws
                    backoff = 1.0
                    await self._pump(ws)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                print(f"[slack] socket error: {exc}")
            finally:
                await self._close_ws()
            if self._running:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60.0)

    async def _open_connection(self) -> str:
        """Trade the app token for a single-use WebSocket URL."""
        r = await self.request(
            "POST",
            f"{self.API_BASE}/apps.connections.open",
            data=b"",
            headers={
                "Authorization": f"Bearer {self._app_token}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        body = r.value if isinstance(r.value, dict) else {}
        if not r.ok or not body.get("ok"):
            print(f"[slack] connections.open failed: {r.error or body.get('error')}")
            return ""
        return str(body.get("url") or "")

    async def _pump(self, ws: Any) -> None:
        async for msg in ws:
            if not self._running:
                break
            if msg.type.name not in ("TEXT", "BINARY"):
                break
            try:
                frame = json.loads(msg.data)
            except (json.JSONDecodeError, TypeError):
                continue

            envelope_id = frame.get("envelope_id")
            if envelope_id:
                # Ack immediately, before doing the work. Slack retries an
                # un-acked envelope, and an agent turn takes far longer than
                # its patience — the retry would run the same prompt twice.
                await ws.send_json({"envelope_id": envelope_id})

            kind = frame.get("type")
            if kind == "events_api":
                payload = frame.get("payload") or {}
                asyncio.create_task(self._on_event(payload.get("event") or {}))
            elif kind == "disconnect":
                await ws.close()

    async def _on_event(self, event: dict) -> None:
        """Route a message event, ignoring bots, edits and joins."""
        if event.get("type") != "message":
            return
        # subtype covers bot_message / message_changed / channel_join etc.
        # Anything with a subtype is not a plain human message.
        if event.get("subtype") or event.get("bot_id"):
            return
        text = str(event.get("text") or "").strip()
        user_id = str(event.get("user") or "")
        channel = str(event.get("channel") or "")
        if not (text and user_id and channel):
            return
        try:
            await self.route(user_id, text, reply_to=channel)
        except Exception as exc:  # noqa: BLE001 - one bad turn must not kill the socket
            print(f"[slack] route failed: {exc}")

    async def _close_ws(self) -> None:
        for obj in (self._ws, self._session):
            try:
                if obj is not None and not getattr(obj, "closed", True):
                    await obj.close()
            except Exception:
                pass  # fail-open: 可选增强，失败不影响主流程
        self._ws = self._session = None
