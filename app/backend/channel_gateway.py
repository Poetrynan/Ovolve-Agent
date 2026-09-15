"""channel_gateway.py — 通用 HMAC webhook 渠道网关（Ovolve 开放约定层）。

## 定位

项目已有 feishu/dingtalk/wecom 三个**厂商专属** webhook（bot 模块）。本模块
补的是第四条路：**任何** IM 机器人 / 自动化系统，只要能配一个出站 webhook，
就按一套开放的 HMAC 约定接入 Ovolve——不绑定任何厂商 SDK，与
plugin_market 的 GitHub-as-Registry 同一设计哲学：用开放约定替代厂商绑定。

## 接入约定（写进文档即可对第三方承诺）

请求头::

    X-Ovolve-Signature: t=<unix秒>,v1=<hex>

签名串 = ``f"{t}.{raw_body}"`` 的 HMAC-SHA256，密钥是渠道的 ``secret``。
（Stripe webhook 同款格式——运维工具链里现成的校验脚本可直接用。）

时间窗 ±300s 之外拒绝（防重放）。渠道配置::

    "channels": { "ops-bot": { "secret": "...", "trust": "trusted",
                               "reply_url": "https://...", "session": "",
                               "workspace": "", "enabled": true } }

## 信任分级

trusted  → 立即派发为该渠道绑定会话的一个回合（auto 权限模型）；
untrusted → **不执行**，落邮箱 + 审计事件，等人在 UI 里处理。
安装≠信任的同一原则，推广到渠道。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, Optional

#: 签名时间窗（秒）。窗口外的请求按重放拒绝。
SIGNATURE_MAX_AGE_S = 300

#: 渠道配置在 config.json 里的顶层键。
_CHANNELS_KEY = "channels"

_TRUST_LEVELS = ("trusted", "untrusted")


def _resolve_secret(stored: str) -> str:
    """解封渠道 secret（enc: / env: / plain: / legacy 明文）。

    复用 mcp_oauth 的同一套解析 —— 全系统的密封凭证走同一条解封路径，
    而不是每个模块各写一份。解封失败返回空串：验证会以 mismatch 拒绝
    （可审计），而不是崩溃。
    """
    s = str(stored or "").strip()
    if not s:
        return ""
    if s.startswith(("enc:", "env:", "plain:")):
        try:
            from mcp_oauth import resolve_secret
            return resolve_secret(s)
        except Exception:
            return ""
    return s


# ---------------------------------------------------------------------------
# 配置管理
# ---------------------------------------------------------------------------

def _config_path() -> str:
    import os
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")


def load_channels() -> Dict[str, dict]:
    """config.json 的 channels 块。坏块按空处理——渠道故障不能拖垮启动。"""
    try:
        with open(_config_path(), "r", encoding="utf-8") as f:
            raw = json.load(f).get(_CHANNELS_KEY)
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _persist_channels(channels: Dict[str, dict]) -> None:
    import os
    path = _config_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        cfg = {}
    cfg[_CHANNELS_KEY] = channels
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)  # 原子替换，与 _persist_config 同款纪律


def _seal_secret(entry: dict) -> dict:
    """明文 secret 落盘前加密（enc: 前缀，同 model_registry 主密钥体系）。"""
    secret = str(entry.get("secret") or "")
    if secret and not secret.startswith(("enc:", "env:", "plain:")):
        try:
            from model_registry import CredentialCipher
            return {**entry, "secret": CredentialCipher().encrypt(secret)}
        except Exception:
            pass  # 加密不可用 → 原样落盘（fail-open），审计可见
    return entry


def upsert_channel(channel_id: str, entry: dict) -> Optional[str]:
    """新增/更新一个渠道。返回错误信息，None 为成功。

    secret 语义：新建必须提供；更新时**留空 = 保留原密钥**——编辑表单和
    启停开关都不该强迫用户重输密钥（重输一次就多一次泄露面）。
    """
    cid = str(channel_id or "").strip()
    if not cid or any(ch in cid for ch in "/\\") or cid in (".", ".."):
        return "illegal channel id"
    if not isinstance(entry, dict):
        return "invalid: object expected"
    trust = str(entry.get("trust") or "untrusted").strip().lower()
    if trust not in _TRUST_LEVELS:
        return f"illegal trust {trust!r} (expected trusted|untrusted)"
    channels = load_channels()
    existing = channels.get(cid)
    secret = str(entry.get("secret") or "").strip()
    if not secret and existing:
        secret = str(existing.get("secret") or "")  # 更新留空 → 沿用原密封值
    if not secret:
        return "secret required"
    channels[cid] = _seal_secret({
        **entry,
        "secret": secret,
        "trust": trust,
        "enabled": bool(entry.get("enabled", True)),
        "reply_url": str(entry.get("reply_url") or "").strip(),
        "session": str(entry.get("session") or "").strip(),
        "workspace": str(entry.get("workspace") or "").strip(),
    })
    _persist_channels(channels)
    return None


def remove_channel(channel_id: str) -> bool:
    channels = load_channels()
    if channel_id not in channels:
        return False
    del channels[channel_id]
    _persist_channels(channels)
    return True


def list_channels() -> list:
    """给 REST 的渠道清单 —— secret 只回显保护形态标记，绝不回原文。"""
    out = []
    for cid, e in sorted(load_channels().items()):
        secret = str(e.get("secret") or "")
        out.append({
            "id": cid,
            "trust": e.get("trust", "untrusted"),
            "enabled": bool(e.get("enabled", True)),
            "replyUrl": e.get("reply_url", ""),
            "session": e.get("session", ""),
            "workspace": e.get("workspace", ""),
            "secretProtected": secret.startswith(("enc:", "env:", "plain:")),
        })
    return out


# ---------------------------------------------------------------------------
# 签名校验
# ---------------------------------------------------------------------------

def verify_signature(secret: str, header: str, body: bytes, now: Optional[float] = None) -> tuple[bool, str]:
    """校验 X-Ovolve-Signature。返回 (ok, 原因)。常量时间比较，无信息泄露。"""
    now = now if now is not None else time.time()
    parsed: Dict[str, str] = {}
    for part in str(header or "").split(","):
        k, _, v = part.strip().partition("=")
        parsed[k.strip()] = v.strip()
    ts_raw, sig = parsed.get("t", ""), parsed.get("v1", "")
    if not ts_raw or not sig:
        return False, "missing signature fields"
    try:
        ts = float(ts_raw)
    except ValueError:
        return False, "bad timestamp"
    if abs(now - ts) > SIGNATURE_MAX_AGE_S:
        return False, f"timestamp outside ±{SIGNATURE_MAX_AGE_S}s window (replay?)"
    expected = hmac.new(
        str(secret).encode(), f"{ts_raw}.{body.decode('utf-8', errors='replace')}".encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, sig):
        return False, "signature mismatch"
    return True, ""


# ---------------------------------------------------------------------------
# 入站派发
# ---------------------------------------------------------------------------

async def handle_inbound(host, channel_id: str, headers: Dict[str, str], body: bytes) -> tuple[int, dict]:
    """渠道入站入口（http_server 的 route handler 只做参数搬运）。

    返回 ``(http_status, payload)``。整条链路留审计：
    received / rejected / held / dispatched / replied 在事件链里都可回答。
    """
    from event_types import EventType
    from trace_gateway import TraceGateway, OBSERVATIONAL

    session_id = str(load_channels().get(channel_id, {}).get("session") or "").strip() \
        or f"channel::{channel_id}"
    gateway = TraceGateway()

    def _audit(event_type: EventType, **extra: Any) -> None:
        try:
            gateway.append(
                session_id=session_id,
                event_type=event_type,
                payload={"channel": channel_id, **extra},
                importance=OBSERVATIONAL,
            )
        except Exception:
            pass  # 审计失败不影响派发决策本身

    cfg = load_channels().get(channel_id)
    if cfg is None:
        return 404, {"error": "unknown channel"}
    if not cfg.get("enabled", True):
        return 503, {"error": "channel disabled"}

    # 落盘的 secret 是密封形态（enc:/env:/plain:）——验证前先解封。
    # 这里是测试抓出来的真 bug 的修复点：拿密封值直接做 HMAC，合法请求
    # 会永远 401。
    secret = _resolve_secret(str(cfg.get("secret") or ""))

    _audit(EventType.CHANNEL_MESSAGE_RECEIVED, chars=len(body))
    ok, reason = verify_signature(
        secret, headers.get("X-Ovolve-Signature", ""), body)
    if not ok:
        _audit(EventType.CHANNEL_MESSAGE_REJECTED, reason=reason)
        return 401, {"error": f"signature rejected: {reason}"}

    try:
        payload = json.loads(body.decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("object expected")
    except (ValueError, UnicodeDecodeError) as exc:
        _audit(EventType.CHANNEL_MESSAGE_REJECTED, reason=f"bad json: {exc}")
        return 400, {"error": "invalid JSON body"}

    text = str(payload.get("text") or payload.get("message") or "").strip()
    message_id = str(payload.get("id") or "")
    if not text:
        _audit(EventType.CHANNEL_MESSAGE_REJECTED, reason="empty text")
        return 400, {"error": "text required"}

    trust = str(cfg.get("trust") or "untrusted")
    workspace = str(cfg.get("workspace") or "").strip()

    if trust != "trusted":
        # 安装≠信任的渠道版：untrusted 渠道的消息不执行，落操作员邮箱待审。
        _audit(EventType.CHANNEL_MESSAGE_HELD, messageId=message_id, preview=text[:200])
        try:
            from storage import get_storage
            from mailbox import send as _msend
            _msend(get_storage(), "mailbox::operator", "channel_gateway",
                   kind="warn", payload={
                       "event": "channel_message_held", "channel": channel_id,
                       "messageId": message_id, "preview": text[:200],
                   })
        except Exception:
            pass
        return 202, {"status": "held_for_approval", "channel": channel_id}

    # 派发为该渠道会话的一个回合 —— 与 WS 聊天/厂商 bot 同一条 Router.handle。
    try:
        router = host.get_or_create(session_id, workspace)
        ctx = {
            "session_id": session_id,
            "workspace_root": workspace or getattr(host, "_default_workspace", ""),
            "source": f"channel:{channel_id}",
        }
        result = await router.handle(text, ctx)
        reply = str(getattr(result, "value", "") or "") if getattr(result, "ok", False) else str(getattr(result, "error", "") or "turn failed")
        ok_reply = bool(getattr(result, "ok", False))
    except Exception as exc:  # noqa: BLE001
        _audit(EventType.CHANNEL_MESSAGE_REJECTED, reason=f"dispatch failed: {type(exc).__name__}: {exc}")
        return 500, {"error": "turn dispatch failed"}

    _audit(EventType.CHANNEL_MESSAGE_DISPATCHED, messageId=message_id, ok=ok_reply)

    # 回信：POST 到 reply_url（同样带 HMAC 签名）。异步线程池里跑同步 urllib。
    reply_url = str(cfg.get("reply_url") or "").strip()
    if reply_url:
        try:
            await _post_reply(channel_id, secret, reply_url, {
                "channel": channel_id, "id": message_id,
                "text": reply[:8000], "ok": ok_reply,
            })
            _audit(EventType.CHANNEL_REPLY_SENT, to=reply_url)
        except Exception as exc:  # noqa: BLE001
            _audit(EventType.CHANNEL_REPLY_FAILED, error=f"{type(exc).__name__}: {exc}")

    return 200, {"status": "dispatched", "session": session_id, "ok": ok_reply}


def sign_payload(secret: str, body: str, now: Optional[float] = None) -> str:
    """出站方向的同款签名头（回信/未来出站 webhook 共用）。"""
    t = str(int(now if now is not None else time.time()))
    sig = hmac.new(str(secret).encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    return f"t={t},v1={sig}"


async def _post_reply(channel_id: str, secret: str, url: str, payload: dict) -> None:
    """回信 POST。独立线程 + 短超时：渠道回信慢不能占着事件循环。"""
    import asyncio
    import urllib.request

    body = json.dumps(payload, ensure_ascii=False)
    headers = {"Content-Type": "application/json",
               "X-Ovolve-Signature": sign_payload(secret, body)}

    def _do_post() -> None:
        req = urllib.request.Request(
            url, data=body.encode("utf-8"), method="POST", headers=headers)
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()

    await asyncio.to_thread(_do_post)
