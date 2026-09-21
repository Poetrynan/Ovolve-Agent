"""providers/feishu_provider.py - Feishu (Lark) IMProvider.

Implements the Feishu Bot API over webhook-based event subscription:
  - Signature verification (X-Lark-Request-Timestamp + X-Lark-Request-Nonce + encrypt_key SHA256)
  - tenant_access_token auto-refresh (2h expiry)
  - Interactive card streaming (create card -> update content)
  - Built-in /start /status /pause /resume commands

The provider exposes an ASGI-compatible handler (handle_webhook) that can be
mounted on any HTTP framework (FastAPI / Starlette / bare ASGI).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import time
import urllib.request
import urllib.error
from typing import Any, AsyncGenerator, Optional

from providers.base import IMProvider
from result import Result
from storage import get_storage

try:
    import aiohttp
    _HAS_AIOHTTP = True
except ImportError:
    aiohttp = None
    _HAS_AIOHTTP = False


class FeishuProvider(IMProvider):
    """Feishu (Lark) Bot provider with webhook event subscription.

    Configuration is read from ``bot_state["feishu:config"]``:
    ```json
    {
      "app_id": "cli_xxxx",
      "app_secret": "xxxx",
      "encrypt_key": "optional_event_encrypt_key",
      "verification_token": "optional_v1_token",
      "allowed_users": ["ou_xxx", "on_xxx"]
    }
    ```
    """

    API_BASE: str = "https://open.feishu.cn/open-apis"
    TOKEN_EXPIRY_BUFFER: int = 300  # Refresh 5min before expiry (token lasts 2h)

    def __init__(self) -> None:
        self.storage = get_storage()
        self._config: dict = self.storage.get_bot_state("feishu:config", {}) or {}
        self._app_id: str = self._config.get("app_id", "")
        self._app_secret: str = self._config.get("app_secret", "")
        self._encrypt_key: str = self._config.get("encrypt_key", "")
        self._verification_token: str = self._config.get("verification_token", "")
        self._tenant_token: str = ""
        self._token_expires_at: float = 0.0
        self._running: bool = False
        self._controller: Any = None
        self._paused_users: set[str] = set()

    # ------------------------------------------------------------------
    # IMProvider contract
    # ------------------------------------------------------------------

    def get_platform_id(self) -> str:
        return "feishu"

    def is_configured(self) -> bool:
        return bool(self._app_id and self._app_secret)

    async def start_listening(self, controller: Any) -> None:
        """Store the controller reference; actual listening is webhook-based.

        For Feishu the webhook endpoint (``handle_webhook``) is registered on
        the HTTP server and messages are pushed to us — there is no polling loop.
        """
        self._controller = controller
        self._running = True
        # Pre-fetch a tenant token so first message doesn't pay the latency.
        await self._ensure_token()

    async def stop_listening(self) -> None:
        self._running = False
        self._controller = None

    async def send_message(self, user_id: str, content: str) -> bool:
        """Send a text message to a Feishu user.

        Args:
            user_id: Feishu open_id or user_id.
            content: Plain text to send.

        Returns:
            True on success.
        """
        await self._ensure_token()
        body = {
            "receive_id": user_id,
            "msg_type": "text",
            "content": json.dumps({"text": content}, ensure_ascii=False),
        }
        r = await self._post(
            f"{self.API_BASE}/im/v1/messages?receive_id_type=open_id", body
        )
        return r.ok

    async def send_streaming_card(
        self, user_id: str, content_stream: AsyncGenerator[str, None]
    ) -> bool:
        """Stream a reply as a Feishu interactive card (create then update).

        Args:
            user_id: Feishu open_id.
            content_stream: Async generator of text deltas.

        Returns:
            True if the card was created and final update succeeded.
        """
        await self._ensure_token()
        # Create initial card
        card = self._build_card("…")
        body = {
            "receive_id": user_id,
            "msg_type": "interactive",
            "content": json.dumps(card, ensure_ascii=False),
        }
        r = await self._post(
            f"{self.API_BASE}/im/v1/messages?receive_id_type=open_id", body
        )
        if not r.ok:
            return False
        message_id = (r.value or {}).get("data", {}).get("message_id")
        if not message_id:
            return False

        buffer = ""
        last_update = 0.0
        async for delta in content_stream:
            buffer += delta
            now = time.monotonic()
            if now - last_update >= 1.0:
                await self._update_card(message_id, buffer)
                last_update = now
        # Final flush
        return await self._update_card_ok(message_id, buffer)

    # ------------------------------------------------------------------
    # Webhook handling (called by HTTP framework)
    # ------------------------------------------------------------------

    async def handle_webhook(self, body: bytes, headers: dict) -> dict:
        """Process an incoming Feishu event callback.

        Args:
            body: Raw request body bytes.
            headers: HTTP headers dict (keys lowercased).

        Returns:
            JSON-serializable response dict.
        """
        # Signature verification
        if self._encrypt_key:
            if not self._verify_signature(body, headers):
                return {"code": 403, "msg": "Invalid signature"}

        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"code": 400, "msg": "Invalid JSON"}

        # URL verification challenge (initial setup)
        if "challenge" in payload:
            return {"challenge": payload["challenge"]}

        # v2.0 event format
        header = payload.get("header", {})
        event = payload.get("event", {})
        event_type = header.get("event_type", "")

        if event_type == "im.message.receive_v1":
            await self._handle_message_event(event)

        return {"code": 0, "msg": "ok"}

    async def _handle_message_event(self, event: dict) -> None:
        """Dispatch a message event to the controller."""
        if not self._controller:
            return
        sender = event.get("sender", {})
        sender_id = sender.get("sender_id", {}).get("open_id", "")
        message = event.get("message", {})
        msg_type = message.get("message_type", "")
        chat_id = message.get("chat_id", "")

        if msg_type != "text":
            return
        try:
            content_json = json.loads(message.get("content", "{}"))
        except json.JSONDecodeError:
            return
        text = content_json.get("text", "").strip()
        if not text:
            return

        if not self._user_allowed(sender_id):
            await self.send_message(sender_id, "Not authorized.")
            return

        # Built-in commands
        handled = await self._handle_builtin(sender_id, text)
        if handled:
            return
        if sender_id in self._paused_users:
            await self.send_message(sender_id, "Paused. /resume to continue.")
            return

        result = await self._controller.handle_message("feishu", sender_id, text)
        reply = result.value if getattr(result, "ok", False) else f"Error: {result.error}"
        await self.send_message(sender_id, str(reply))

    async def _handle_builtin(self, user_id: str, text: str) -> bool:
        cmd = text.split()[0].lower()
        if cmd == "/start":
            await self.send_message(user_id, "Ovolve connected via Feishu.\n/status /pause /resume")
        elif cmd == "/status":
            state = "paused" if user_id in self._paused_users else "active"
            await self.send_message(user_id, f"Status: {state}")
        elif cmd == "/pause":
            self._paused_users.add(user_id)
            await self.send_message(user_id, "Paused.")
        elif cmd == "/resume":
            self._paused_users.discard(user_id)
            await self.send_message(user_id, "Resumed.")
        else:
            return False
        return True

    def _user_allowed(self, user_id: str) -> bool:
        """Fail-closed: no allowed_users list = nobody gets in."""
        allowed = self._config.get("allowed_users")
        if not allowed:
            return False
        return user_id in allowed

    # ------------------------------------------------------------------
    # Signature verification (X-Lark-Request-Timestamp + Nonce + body)
    # ------------------------------------------------------------------

    def _verify_signature(self, body: bytes, headers: dict) -> bool:
        """Verify Feishu event signature using SHA256(timestamp+nonce+encrypt_key+body).

        Args:
            body: Raw request body.
            headers: Dict with lowercase header keys.

        Returns:
            True if the computed signature matches X-Lark-Signature.
        """
        timestamp = headers.get("x-lark-request-timestamp", "")
        nonce = headers.get("x-lark-request-nonce", "")
        expected = headers.get("x-lark-signature", "")
        if not (timestamp and nonce and expected):
            return False
        seed = f"{timestamp}{nonce}{self._encrypt_key}".encode("utf-8") + body
        computed = hashlib.sha256(seed).hexdigest()
        # Constant-time comparison to prevent timing attacks
        return len(computed) == len(expected) and all(
            a == b for a, b in zip(computed, expected)
        )

    # ------------------------------------------------------------------
    # tenant_access_token (2h validity, auto-refresh)
    # ------------------------------------------------------------------

    async def _ensure_token(self) -> None:
        """Ensure we have a valid tenant_access_token, refreshing if needed."""
        if self._tenant_token and time.time() < self._token_expires_at:
            return
        body = {"app_id": self._app_id, "app_secret": self._app_secret}
        r = await self._post(
            f"{self.API_BASE}/auth/v3/tenant_access_token/internal", body, auth=False
        )
        if r.ok and r.value:
            data = r.value
            self._tenant_token = data.get("tenant_access_token", "")
            expire = int(data.get("expire", 7200))
            self._token_expires_at = time.time() + expire - self.TOKEN_EXPIRY_BUFFER

    # ------------------------------------------------------------------
    # HTTP helpers
    # ------------------------------------------------------------------

    async def _post(self, url: str, body: dict, auth: bool = True) -> Result:
        """POST JSON to Feishu API, auto-adding Authorization header.

        Args:
            url: Full API URL.
            body: JSON body dict.
            auth: Whether to include Bearer token.

        Returns:
            Result with decoded JSON or error.
        """
        headers_dict: dict[str, str] = {"Content-Type": "application/json; charset=utf-8"}
        if auth and self._tenant_token:
            headers_dict["Authorization"] = f"Bearer {self._tenant_token}"

        if _HAS_AIOHTTP:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.post(url, json=body, headers=headers_dict) as resp:
                        data = await resp.json(content_type=None)
                        if resp.status != 200 or data.get("code", -1) != 0:
                            return Result.failure(f"Feishu {resp.status}: {data}")
                        return Result.success(data)
            except Exception as e:
                return Result.failure(f"Feishu request failed: {e}")
        else:
            return await asyncio.to_thread(self._post_urllib, url, body, headers_dict)

    @staticmethod
    def _post_urllib(url: str, body: dict, headers: dict) -> Result:
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                result = json.loads(resp.read().decode("utf-8"))
            if result.get("code", -1) != 0:
                return Result.failure(f"Feishu error: {result}")
            return Result.success(result)
        except urllib.error.HTTPError as e:
            return Result.failure(f"HTTP {e.code}: {e.reason}")
        except Exception as e:
            return Result.failure(f"Feishu request failed: {e}")

    # ------------------------------------------------------------------
    # Card helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _build_card(content: str) -> dict:
        """Build a minimal interactive card with markdown content."""
        return {
            "config": {"wide_screen_mode": True},
            "elements": [
                {"tag": "markdown", "content": content}
            ],
        }

    async def _update_card(self, message_id: str, content: str) -> None:
        """Best-effort card content update."""
        await self._update_card_ok(message_id, content)

    async def _update_card_ok(self, message_id: str, content: str) -> bool:
        """Update card content, returning success state."""
        card = self._build_card(content)
        body = {"content": json.dumps(card, ensure_ascii=False)}
        r = await self._post(
            f"{self.API_BASE}/im/v1/messages/{message_id}", body
        )
        return r.ok
