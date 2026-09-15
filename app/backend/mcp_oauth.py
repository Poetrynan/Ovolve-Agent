"""mcp_oauth.py — MCP 连接器的 OAuth2 client-credentials 令牌获取。

## 解决什么

Remote MCP 服务器（http/sse）普遍要求 Bearer 令牌。静态 ``headers`` 能塞一个
手写的长期令牌，但企业内网的 MCP 网关（业界方案中那类 connector:* 形态）
走的是标准 OAuth2 client-credentials：令牌短命、需要按期刷新。这个模块就是
Ovolve 的本地令牌管家——**凭证不落明文、令牌不过期、失败留审计**。

## Ovolve 特色

1. **凭证加密落盘**：``client_secret`` 支持 ``enc:`` 前缀，复用 model_registry
   的 CredentialCipher（同一把主密钥、同一套 Fernet）。也支持 ``env:VAR``
   引用环境变量——部署脚本友好的明文路径，显式可辨。
2. **进程内缓存 + 主动过期**：令牌缓存在内存里，按 ``expires_in`` 提前 60s
   视为过期，避免把边界 401 交给调用方。
3. **失败可观测**：获取/刷新失败返回明确错误而非空头——连接侧会把
   ``failed`` 状态连同原因写进事件链，审计能回答"为什么连不上"。

仅支持 client-credentials：MCP 服务器到服务器的场景没有用户在场，
authorization-code/PKCE 属于聊天式产品的交互流（业界方案有，因为它连的是
消费级 SaaS）；Ovolve 定位本地 Agent，第一版不引入浏览器跳转流程。
"""
from __future__ import annotations

import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, Optional

#: 令牌提前过期余量（秒）。expires_in 是服务器给的理想值，边界 401 比一次
#: 多余的刷新贵得多。
_TOKEN_EXPIRY_MARGIN_S = 60.0

#: 单次令牌请求超时。令牌端点不该慢；慢了宁可本次连接失败重试。
_TOKEN_TIMEOUT_S = 15.0


class OAuthTokenError(RuntimeError):
    """令牌获取失败。message 面向审计日志，不含 secret 本体。"""


def resolve_secret(value: str) -> str:
    """解析凭证值的三种写法：明文 / ``env:VAR`` / ``enc:``|``plain:`` 密文。

    ``enc:``/``plain:`` 复用 model_registry.CredentialCipher —— 同一把主密钥，
    与模型 provider 的 apiKey 加密完全同构。解密失败返回空串（Cipher 的契约）
    ，调用方会拿到 401 而不是崩溃；这比把失败藏进"静默用明文"安全。
    """
    s = str(value or "").strip()
    if not s:
        return ""
    if s.startswith("env:"):
        return os.environ.get(s[4:].strip(), "")
    if s.startswith(("enc:", "plain:")):
        try:
            from model_registry import CredentialCipher
            return CredentialCipher().decrypt(s)
        except Exception:
            return ""
    return s  # legacy 明文 —— 与 model_registry 对 legacy 值的处理一致


class _CachedToken:
    __slots__ = ("access_token", "expires_at")

    def __init__(self, access_token: str, expires_at: float) -> None:
        self.access_token = access_token
        self.expires_at = expires_at

    def live(self) -> bool:
        return bool(self.access_token) and time.time() < self.expires_at


_lock = threading.Lock()
_tokens: Dict[str, _CachedToken] = {}


def invalidate(server_name: str) -> None:
    """丢弃某服务器缓存令牌。连接掉线/401 后由 mcp_manager 调用，
    下次连接强制刷新 —— 避免拿着已撤销的令牌反复撞墙。"""
    with _lock:
        _tokens.pop(server_name, None)


def _fetch_token(server_name: str, auth: dict) -> str:
    """向 token_url 发起一次 client-credentials 请求，返回 access_token。"""
    token_url = str(auth.get("token_url") or "").strip()
    if not token_url:
        raise OAuthTokenError(f"mcp[{server_name}]: auth.token_url is required")
    client_id = resolve_secret(str(auth.get("client_id") or ""))
    client_secret = resolve_secret(str(auth.get("client_secret") or ""))
    if not client_id or not client_secret:
        raise OAuthTokenError(
            f"mcp[{server_name}]: auth.client_id/client_secret missing or "
            f"undecryptable (enc: value with foreign key?)")
    scopes = auth.get("scopes") or []
    scope = " ".join(str(s) for s in scopes if str(s).strip()) if isinstance(scopes, list) else str(scopes)

    body = urllib.parse.urlencode({
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
        **({"scope": scope} if scope else {}),
    }).encode()
    req = urllib.request.Request(
        token_url, data=body, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded",
                 "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_TOKEN_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # 不把响应体打进错误 —— 令牌端点的错误页可能回显提交的表单。
        raise OAuthTokenError(
            f"mcp[{server_name}]: token endpoint returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise OAuthTokenError(f"mcp[{server_name}]: token request failed: {exc}") from exc

    token = str(data.get("access_token") or "")
    if not token:
        raise OAuthTokenError(
            f"mcp[{server_name}]: token endpoint returned no access_token")
    try:
        ttl = float(data.get("expires_in") or 3600)
    except (TypeError, ValueError):
        ttl = 3600.0
    with _lock:
        _tokens[server_name] = _CachedToken(token, time.time() + max(ttl, 0) - _TOKEN_EXPIRY_MARGIN_S)
    return token


def bearer_headers(server_name: str, auth: Optional[dict]) -> Dict[str, str]:
    """返回应附加到该服务器请求上的 Authorization 头（可能为空 dict）。

    auth 缺失/类型不符 → {}（连接退回静态 headers 行为）。
    令牌不存在或已过期 → 现场刷新一次。
    """
    if not isinstance(auth, dict) or str(auth.get("type") or "oauth2").lower() != "oauth2":
        return {}
    with _lock:
        cached = _tokens.get(server_name)
    if cached is not None and cached.live():
        return {"Authorization": f"Bearer {cached.access_token}"}
    token = _fetch_token(server_name, auth)
    return {"Authorization": f"Bearer {token}"}


def auth_config_summary(auth: Optional[dict]) -> dict:
    """给 REST/审计用的 auth 配置摘要 —— 绝不回显任何 secret 原文。"""
    if not isinstance(auth, dict):
        return {"enabled": False}
    secret = str(auth.get("client_secret") or "")
    return {
        "enabled": True,
        "type": str(auth.get("type") or "oauth2"),
        "tokenUrl": str(auth.get("token_url") or ""),
        "clientId": str(auth.get("client_id") or ""),
        "secretProtected": secret.startswith(("enc:", "env:", "plain:")),
        "scopes": [str(s) for s in (auth.get("scopes") or [])] if isinstance(auth.get("scopes"), list) else [],
    }
