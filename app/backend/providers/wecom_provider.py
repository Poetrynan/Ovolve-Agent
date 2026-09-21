"""providers/wecom_provider.py - WeCom (企业微信) IMProvider.

WeCom encrypts every inbound callback, so this provider carries a bit more
machinery than the others:

  - URL verification (GET ``echostr``) and event delivery (POST XML) are both
    signed with ``sha1(sorted([token, timestamp, nonce, payload]))``.
  - The payload itself is AES-256-CBC, keyed by the 43-char
    ``encoding_aes_key`` (base64 with the padding stripped by WeCom).

Outbound has two routes and picks the better one automatically:
  - a self-built app (``corp_id`` + ``app_secret`` + ``agent_id``) can message a
    specific person, which is what a reply should do;
  - a group robot ``webhook_key`` can only broadcast to its group, which is
    still the right answer for proactive pushes and the only option when the
    app credentials are absent.

Config lives in ``bot_state["wecom:config"]``:
```json
{
  "webhook_key": "693a91f6-…",
  "corp_id": "ww…",
  "app_secret": "…",
  "agent_id": "1000002",
  "callback_token": "…",
  "encoding_aes_key": "43-char key",
  "allowed_users": ["zhangsan"]
}
```
"""
from __future__ import annotations

import base64
import hashlib
import time
import xml.etree.ElementTree as ET
from typing import Any, Optional

from providers.common import BaseProvider


class WeComProvider(BaseProvider):
    """WeCom robot/app with encrypted callback intake."""

    PLATFORM = "wecom"
    API_BASE = "https://qyapi.weixin.qq.com/cgi-bin"
    SEND_LIMIT = 2000
    #: An encrypted callback body should never be large. Anything bigger is not
    #: a chat message, and parsing it would just hand XML a bigger surface.
    MAX_BODY = 256 * 1024
    TOKEN_EXPIRY_BUFFER = 300

    def __init__(self) -> None:
        super().__init__()
        self._webhook_key = self.cfg("webhook_key")
        self._corp_id = self.cfg("corp_id")
        self._app_secret = self.cfg("app_secret")
        self._agent_id = self.cfg("agent_id")
        self._callback_token = self.cfg("callback_token")
        self._aes_key = self.cfg("encoding_aes_key")
        self._access_token: str = ""
        self._token_expires_at: float = 0.0

    # ------------------------------------------------------------------
    # Contract
    # ------------------------------------------------------------------

    def is_configured(self) -> bool:
        return bool(self._webhook_key or (self._corp_id and self._app_secret))

    def can_reply_to_user(self) -> bool:
        """Whether we can address one person instead of a whole group."""
        return bool(self._corp_id and self._app_secret and self._agent_id)

    async def start_listening(self, controller: Any) -> None:
        """Inbound is push-based; just take the controller reference."""
        self._controller = controller
        self._running = True

    async def stop_listening(self) -> None:
        self._running = False
        self._controller = None

    async def send_message(self, user_id: str, content: str) -> bool:
        if not content.strip():
            return True
        if self.can_reply_to_user() and user_id and not user_id.startswith("@"):
            return await self._send_app(user_id, content)
        return await self._send_robot(content)

    async def _send_app(self, user_id: str, content: str) -> bool:
        """Send via the self-built app, addressed to one member."""
        token = await self._ensure_token()
        if not token:
            # Credentials exist but the exchange failed; the group robot is a
            # worse-but-working fallback and beats dropping the reply.
            return await self._send_robot(content)
        ok = True
        for chunk in self.split(content):
            r = await self.request(
                "POST",
                f"{self.API_BASE}/message/send?access_token={token}",
                json_body={
                    "touser": user_id,
                    "msgtype": "text",
                    "agentid": self._agent_id,
                    "text": {"content": chunk},
                },
            )
            if not self._errcode_ok(r):
                ok = False
        return ok

    async def _send_robot(self, content: str) -> bool:
        """Broadcast via the group robot webhook."""
        if not self._webhook_key:
            print("[wecom] nothing to send with (set webhook_key or app credentials)")
            return False
        ok = True
        for chunk in self.split(content):
            r = await self.request(
                "POST",
                f"{self.API_BASE}/webhook/send?key={self._webhook_key}",
                json_body={"msgtype": "text", "text": {"content": chunk}},
            )
            if not self._errcode_ok(r):
                ok = False
        return ok

    @staticmethod
    def _errcode_ok(result: Any) -> bool:
        data = result.value if isinstance(result.value, dict) else {}
        if not result.ok or int(data.get("errcode", 0) or 0) != 0:
            print(f"[wecom] send failed: {result.error or data}")
            return False
        return True

    async def _ensure_token(self) -> str:
        """Fetch/refresh access_token (2h validity)."""
        if self._access_token and time.time() < self._token_expires_at:
            return self._access_token
        r = await self.request(
            "GET",
            f"{self.API_BASE}/gettoken?corpid={self._corp_id}&corpsecret={self._app_secret}",
        )
        data = r.value if isinstance(r.value, dict) else {}
        token = str(data.get("access_token") or "")
        if token:
            self._access_token = token
            expires = int(data.get("expires_in", 7200) or 7200)
            self._token_expires_at = time.time() + expires - self.TOKEN_EXPIRY_BUFFER
        return self._access_token

    # ------------------------------------------------------------------
    # Callback: URL verification
    # ------------------------------------------------------------------

    def verify_url(self, query: dict) -> Optional[str]:
        """Answer WeCom's GET handshake.

        Returns:
            The decrypted echostr to echo back, or None when verification
            fails (the caller should answer 403).
        """
        if not (self._callback_token and self._aes_key):
            return None
        echostr = query.get("echostr", "")
        if not echostr:
            return None
        if not self._verify_signature(query, echostr):
            return None
        decrypted = self._decrypt(echostr)
        return decrypted[0] if decrypted else None

    # ------------------------------------------------------------------
    # Callback: events
    # ------------------------------------------------------------------

    async def handle_webhook(self, body: bytes, query: dict) -> str:
        """Process one encrypted event callback.

        Returns:
            The body to answer with. WeCom accepts an empty string as "got it";
            the actual reply is pushed separately because an agent turn takes
            far longer than the 5s callback budget.
        """
        # Fail closed: no token/key means we cannot authenticate the sender, and
        # this endpoint starts real work on the user's machine.
        if not (self._callback_token and self._aes_key):
            return ""
        if len(body) > self.MAX_BODY:
            return ""
        encrypt = self._extract(body, "Encrypt")
        if not encrypt or not self._verify_signature(query, encrypt):
            return ""

        decrypted = self._decrypt(encrypt)
        if not decrypted:
            return ""
        plain_xml = decrypted[0]
        if self._extract(plain_xml.encode("utf-8"), "MsgType") != "text":
            return ""
        text = (self._extract(plain_xml.encode("utf-8"), "Content") or "").strip()
        user_id = self._extract(plain_xml.encode("utf-8"), "FromUserName") or ""
        if not (text and user_id):
            return ""

        await self.route(user_id, text)
        return ""

    # ------------------------------------------------------------------
    # Crypto
    # ------------------------------------------------------------------

    def _verify_signature(self, query: dict, payload: str) -> bool:
        """msg_signature = sha1 of the sorted [token, timestamp, nonce, payload]."""
        expected = query.get("msg_signature", "")
        timestamp = query.get("timestamp", "")
        nonce = query.get("nonce", "")
        if not (expected and timestamp and nonce):
            return False
        joined = "".join(sorted([self._callback_token, timestamp, nonce, payload]))
        computed = hashlib.sha1(joined.encode("utf-8")).hexdigest()
        # Constant-time: a leaky comparison here leaks the signature byte by byte.
        return len(computed) == len(expected) and all(
            a == b for a, b in zip(computed, expected)
        )

    def _decrypt(self, b64_cipher: str) -> Optional[tuple[str, str]]:
        """AES-256-CBC decrypt one WeCom payload.

        Returns:
            ``(message_xml, receive_id)`` or None when anything is off. The
            layout is 16 random bytes + 4-byte big-endian length + message +
            receive_id, PKCS#7 padded.
        """
        try:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        except ImportError:
            print("[wecom] cryptography not installed; cannot decrypt callbacks")
            return None
        try:
            key = base64.b64decode(self._aes_key + "=")
            raw = base64.b64decode(b64_cipher)
            if len(key) != 32 or not raw or len(raw) % 16:
                return None
            decryptor = Cipher(algorithms.AES(key), modes.CBC(key[:16])).decryptor()
            plain = decryptor.update(raw) + decryptor.finalize()
            pad = plain[-1]
            if not 1 <= pad <= 32:
                return None
            plain = plain[:-pad]
            body = plain[16:]
            msg_len = int.from_bytes(body[:4], "big")
            if msg_len < 0 or msg_len > len(body) - 4:
                return None
            message = body[4:4 + msg_len].decode("utf-8")
            receive_id = body[4 + msg_len:].decode("utf-8", errors="replace")
            return message, receive_id
        except Exception as exc:  # noqa: BLE001 - a malformed payload is data
            print(f"[wecom] decrypt failed: {exc}")
            return None

    @staticmethod
    def _extract(xml_bytes: bytes, tag: str) -> str:
        """Pull one tag's text out of a WeCom XML document.

        Only ever called on signature-verified bytes — parsing unauthenticated
        XML would hand a stranger the parser.
        """
        try:
            root = ET.fromstring(xml_bytes.decode("utf-8", errors="replace"))
        except ET.ParseError:
            return ""
        node = root.find(tag)
        return (node.text or "") if node is not None else ""
