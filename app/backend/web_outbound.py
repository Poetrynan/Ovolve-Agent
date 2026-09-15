"""web_outbound.py — 工具内 HTTP 出站的统一出口（代理 / 出口策略 / 凭据）。

# 解决什么

工具族的 HTTP 请求（搜索、网页抓取、学术检索、GitHub）过去各自裸调
urllib.request.urlopen：既不走用户配置的代理，也不过上网权限的出口策略——
设置页"仅限白名单"的承诺对这条路不生效（轻度假层，BUG-104）。本模块把
这一路收成一个入口：

    open_url(url, ...)  =  出口策略检查 → 代理 opener → urllib

# 语义

- 出口策略：deny 命中恒拦；closed 模式下白名单未命中也拦——**工具内置
  出站没有审批卡可弹**（审批发生在工具调用层，工具已经获准运行），所以
  closed 模式的语义在这里只能是"非白名单即拒绝"，错误信息里写清楚去
  设置里加白名单。这与 shell 命令路径（REVIEW→弹审批卡）不同，是有意的。
- 代理：`proxy_url` 非空时用 ProxyHandler 显式建 opener；为空时不做任何
  事——urllib 默认就读环境变量与系统代理设置，不要替用户把它关掉。
- Tavily key：密钥级敏感，落库前经 CredentialCipher 加密（enc: 前缀），
  读取时解密；API 面只回掩码。
"""
from __future__ import annotations

from typing import Optional

# 模块级 import 而不是函数内：check_egress 每次调用都引用它，测试也要能
# 替换这个名字（monkeypatch web_outbound.get_egress_policy）。command_classifier
# 不反向依赖本模块，无环。
from command_classifier import get_egress_policy

_KV_NS = "network_outbound"
_KV_PROXY = "proxy_url"
_KV_TAVILY = "tavily_key"


class EgressBlocked(RuntimeError):
    """出口策略拒绝本次请求。str(exc) 即给模型看的三段式错误。"""


# ── 设置存取 ─────────────────────────────────────────────────────────────────

def get_outbound_settings() -> dict:
    """读取出站设置。任何失败都按"未配置"处理（fail-open）。"""
    out = {"proxy_url": "", "tavily_key": ""}
    try:
        from storage import get_storage
        proxy = get_storage().kv_get(_KV_PROXY, ns=_KV_NS)
        if isinstance(proxy, str):
            out["proxy_url"] = proxy.strip()
    except Exception:
        pass
    try:
        from storage import get_storage
        sealed = get_storage().kv_get(_KV_TAVILY, ns=_KV_NS)
        if isinstance(sealed, str) and sealed:
            from model_registry import CredentialCipher
            out["tavily_key"] = CredentialCipher().decrypt(sealed)
    except Exception:
        pass
    return out


def set_outbound_settings(proxy_url: Optional[str] = None,
                          tavily_key: Optional[str] = None) -> None:
    """写设置。传 None = 不动该项；空串 = 清除该项。"""
    from storage import get_storage
    if proxy_url is not None:
        get_storage().kv_set(
            _KV_PROXY, str(proxy_url).strip(), ns=_KV_NS)
    if tavily_key is not None:
        key = str(tavily_key).strip()
        if key:
            from model_registry import CredentialCipher
            key = CredentialCipher().encrypt(key)
        get_storage().kv_set(_KV_TAVILY, key, ns=_KV_NS)


# ── 代理 ─────────────────────────────────────────────────────────────────────

def _opener():
    """配置了代理就返回显式 opener；没配置返回 None（走 urllib 默认——
    默认行为本身就读环境变量与系统代理，不能反而把它弄丢）。"""
    proxy_url = get_outbound_settings()["proxy_url"]
    if not proxy_url:
        return None
    import urllib.request
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({
            "http": proxy_url,
            "https": proxy_url,
        }))


# ── 出口策略 ─────────────────────────────────────────────────────────────────

def check_egress(url: str) -> Optional[str]:
    """对目标 URL 做出口策略检查。拒绝时返回给模型的错误文本，放行返回 None。"""
    from urllib.parse import urlparse
    from tools import format_tool_error
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        host = ""
    if not host:
        return None  # 解析不出 host 的畸形 URL 交给 urllib 自己报错
    try:
        outcome = get_egress_policy().check([host])
    except Exception:
        return None  # fail-open: 策略子系统故障不拦正常请求
    if not outcome:
        return None
    verdict, hit = outcome
    if verdict == "restricted":
        return format_tool_error(
            f"网络出口策略拦截：{hit} 在永不访问名单中",
            suggestion="该域名被设置页的「永不访问」名单禁止；确认名单无误",
            recovery="如确需访问，请在 设置 → 安全与权限 → 上网权限 中移除该条目",
        )
    # closed 模式白名单未命中。与 shell 路径的 REVIEW→审批卡不同：
    # 工具内置请求没有审批卡可弹，这里只能是"拒绝 + 指路"。
    return format_tool_error(
        f"网络出口为白名单模式：{host} 不在允许访问名单中",
        suggestion="把该域名加入 设置 → 安全与权限 → 上网权限 的允许访问名单",
        recovery="或将上网权限切回「默认放行」模式",
    )


# ── 统一入口 ─────────────────────────────────────────────────────────────────

def open_url(url: str, *, timeout: float = 10, headers: dict = None,
             data=None, method: str = None):
    """工具内 HTTP 出站唯一入口。被策略拦截时抛 EgressBlocked（str 即错误文本）。

    返回 urlopen 风格的响应对象，调用方按原方式 read()/with 使用。
    """
    import urllib.request
    block = check_egress(url)
    if block:
        raise EgressBlocked(block)
    req = urllib.request.Request(url, headers=dict(headers or {}),
                                 data=data, method=method)
    opener = _opener()
    if opener is not None:
        return opener.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)
