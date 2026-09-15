"""providers/dingtalk_provider.py - DingTalk (钉钉) IMProvider.

Two channels, because DingTalk splits them:

  - **Outbound push** goes to a 自定义机器人 webhook URL, optionally signed with
    the robot's 加签 secret.
  - **Inbound** arrives as an outgoing-webhook callback from an 企业内部机器人,
    signed with the app secret. Each callback carries a short-lived
    ``sessionWebhook`` which is the correct place to answer that conversation.

Answering through the session webhook rather than the group robot matters: the
group robot broadcasts to the whole group, while the session webhook lands in
the thread the question came from.

Config lives in ``bot_state["dingtalk:config"]``:
```json
{
  "webhook": "https://oapi.dingtalk.com/robot/send?access_token=…",
  "secret": "SEC…",
  "app_secret": "…",
  "allowed_users": ["staffId1"]
}
```
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.parse
from typing import Any

from providers.common import BaseProvider


class DingTalkProvider(BaseProvider):
    """DingTalk robot: signed webhook push + signed callback intake."""

    PLATFORM = "dingtalk"
    #: The robot API rejects longer bodies; split before it does.
    SEND_LIMIT = 3500
    #: Reject callbacks whose timestamp is older than this, so a captured
    #: request can't be replayed tomorrow.
    SIGN_WINDOW_S = 3600

    def __init__(self) -> None:
        super().__init__()
        self._webhook = self.cfg("webhook")
        self._secret = self.cfg("secret")
        self._app_secret = self.cfg("app_secret")
        #: staffId -> (sessionWebhook, expires_at_epoch_seconds)
        self._sessions: dict[str, tuple[str, float]] = {}

    # ------------------------------------------------------------------
    # Contract
    # ------------------------------------------------------------------

    def is_configured(self) -> bool:
        # Either direction alone is useful: push-only with just a webhook,
        # listen-only with just an app secret.
        return bool(self._webhook or self._app_secret)

    async def start_listening(self, controller: Any) -> None:
        """Nothing to dial — inbound is push. Just hold the controller."""
        self._controller = controller
        self._running = True

    async def stop_listening(self) -> None:
        self._running = False
        self._controller = None
        self._sessions.clear()

    async def send_message(self, user_id: str, content: str) -> bool:
        """Send text to a session webhook, a known staff id, or the group robot.

        Args:
            user_id: A ``https://…`` session webhook, or a staffId whose live
                session we may still hold, or anything else (falls back to the
                configured group robot).
        """
        if not content.strip():
            return True
        target = self._resolve_target(user_id)
        if not target:
            print("[dingtalk] no webhook to send to (set `webhook` in config)")
            return False
        ok = True
        for chunk in self.split(content):
            body = {"msgtype": "text", "text": {"content": chunk}}
            r = await self.request("POST", target, json_body=body)
            data = r.value if isinstance(r.value, dict) else {}
            if not r.ok or int(data.get("errcode", 0) or 0) != 0:
                print(f"[dingtalk] send failed: {r.error or data}")
                ok = False
        return ok

    def _resolve_target(self, user_id: str) -> str:
        """Pick the URL a reply should go to."""
        if user_id.startswith("http"):
            return user_id
        cached = self._sessions.get(user_id)
        if cached and cached[1] > time.time():
            return cached[0]
        if cached:
            # Expired: drop it so the map doesn't grow forever with dead URLs.
            self._sessions.pop(user_id, None)
        return self._signed_webhook() if self._webhook else ""

    # ------------------------------------------------------------------
    # Inbound callback
    # ------------------------------------------------------------------

    async def handle_webhook(self, body: bytes, headers: dict) -> dict:
        """Process one outgoing-webhook callback.

        Args:
            body: Raw request body.
            headers: HTTP headers with lowercased keys.

        Returns:
            JSON-serializable response for DingTalk.
        """
        # Fail closed. Without an app secret we cannot tell DingTalk apart from
        # anyone who guessed the URL, and this endpoint drives a live agent.
        if not self._app_secret:
            return {"errcode": 403, "errmsg": "app_secret not configured"}
        if not self._verify(headers):
            return {"errcode": 403, "errmsg": "invalid signature"}

        try:
            payload = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {"errcode": 400, "errmsg": "invalid JSON"}

        if payload.get("msgtype") != "text":
            return {"errcode": 0, "errmsg": "ignored"}
        text = str((payload.get("text") or {}).get("content") or "").strip()
        staff_id = str(payload.get("senderStaffId") or payload.get("senderId") or "")
        if not (text and staff_id):
            return {"errcode": 0, "errmsg": "ignored"}

        session_url = str(payload.get("sessionWebhook") or "")
        if session_url:
            # The expiry arrives in milliseconds; keep it in seconds and shave a
            # little off so we never pick a URL that dies mid-request.
            expires_ms = float(payload.get("sessionWebhookExpiredTime") or 0)
            expires = (expires_ms / 1000.0 - 30) if expires_ms else (time.time() + 1200)
            self._sessions[staff_id] = (session_url, expires)

        await self.route(staff_id, text, reply_to=session_url or staff_id)
        return {"errcode": 0, "errmsg": "ok"}

    def _verify(self, headers: dict) -> bool:
        """Verify ``sign`` = base64(HMAC-SHA256(timestamp + "\\n" + secret)).

        Also rejects stale timestamps — a valid signature on an hour-old
        request is still a replay.
        """
        timestamp = headers.get("timestamp", "")
        expected = headers.get("sign", "")
        if not (timestamp and expected):
            return False
        try:
            sent_at = int(timestamp) / 1000.0
        except ValueError:
            return False
        if abs(time.time() - sent_at) > self.SIGN_WINDOW_S:
            return False
        computed = self._sign(f"{timestamp}\n{self._app_secret}", self._app_secret)
        return hmac.compare_digest(computed, expected)

    # ------------------------------------------------------------------
    # Signing
    # ------------------------------------------------------------------

    @staticmethod
    def _sign(string_to_sign: str, secret: str) -> str:
        digest = hmac.new(
            secret.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha256
        ).digest()
        return base64.b64encode(digest).decode("utf-8")

    def _signed_webhook(self) -> str:
        """Append ``timestamp`` + ``sign`` when the robot has 加签 enabled."""
        if not self._secret:
            return self._webhook
        ts = str(int(time.time() * 1000))
        sign = urllib.parse.quote_plus(self._sign(f"{ts}\n{self._secret}", self._secret))
        joiner = "&" if "?" in self._webhook else "?"
        return f"{self._webhook}{joiner}timestamp={ts}&sign={sign}"
