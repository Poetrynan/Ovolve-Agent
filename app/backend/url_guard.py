"""URL Guard with SSRF protection, IMDS blacklist, and private network filtering.

Provides URL sanitization and destination verification based on community reference implementation.
"""
from __future__ import annotations

import ipaddress
import os
import socket
import urllib.parse
from typing import Tuple

# Cloud Instance Metadata Service (IMDS) well-known hostnames & endpoints
_IMDS_HOSTNAMES = {
    "metadata.google.internal",
    "instance-data",
}

_IMDS_IPS = {
    ipaddress.ip_address("169.254.169.254"),
    ipaddress.ip_address("fd00:ec2::254"),
}

# Blacklisted networks: loopback, private, link-local, unspecified
_BLOCKED_NETWORKS = [
    # IPv4
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("255.255.255.255/32"),
    # IPv6
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def is_ip_blocked(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> Tuple[bool, str]:
    """Check if an IP address belongs to IMDS, loopback, link-local, or private range."""
    if ip in _IMDS_IPS:
        return True, f"云厂商元数据服务(IMDS)已被拦截 (blocked IMDS): {ip}"
    if ip.is_loopback:
        return True, f"回环地址(Loopback)已被拦截 (blocked loopback): {ip}"
    if ip.is_link_local:
        return True, f"链路本地(Link-local)地址已被拦截 (blocked link-local): {ip}"
    if ip.is_private:
        return True, f"私网(Private IP)地址已被拦截 (blocked private): {ip}"
    if ip.is_unspecified or ip.is_multicast or ip.is_reserved:
        return True, f"保留/未指定网络地址已被拦截 (blocked reserved): {ip}"
    for net in _BLOCKED_NETWORKS:
        if ip in net:
            return True, f"黑名单网络范围已被拦截 (blocked network range): {ip} in {net}"
    return False, ""


def check_url(url: str, *, allow_private: bool = False) -> Tuple[bool, str]:
    """Validate a URL against SSRF attack vectors and restricted networks.

    Args:
        url: URL string to inspect.
        allow_private: If True, bypass private/loopback/IMDS checks (useful in tests/dev).

    Returns:
        (allowed: bool, reason: str)
    """
    if not url or not isinstance(url, str):
        return False, "无效的 URL 格式"

    try:
        parsed = urllib.parse.urlparse(url.strip())
    except Exception as e:
        return False, f"URL 解析失败: {e}"

    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        return False, f"不支持的 URL 协议方案: {scheme} (仅允许 http/https)"

    if parsed.username or parsed.password:
        return False, "URL 中禁止包含用户身份凭据 (userinfo)"

    host = parsed.hostname
    if not host:
        return False, "URL 中未提供有效的主机名 (hostname)"

    # Clean IPv6 bracket notation if present
    clean_host = host.strip("[]").strip()

    # If allow_private is enabled, bypass network/IMDS checks
    env_override = os.environ.get("OVOLVE_ALLOW_PRIVATE_URLS", "").strip().lower() in ("1", "true", "yes")
    if allow_private or env_override:
        return True, ""

    # Special-use test/documentation domains (RFC 2606 / RFC 6761)
    if clean_host.lower().endswith((".example", ".test", ".invalid")):
        return True, ""

    # Check hostname blacklist
    if clean_host.lower() in _IMDS_HOSTNAMES:
        return False, f"禁止访问云厂商元数据服务主机名 (blocked IMDS): {clean_host}"
    if clean_host.lower() == "localhost":
        return False, f"禁止访问本地回环主机名 (blocked loopback localhost): {clean_host}"

    # Check if host is direct IP address
    direct_ip = None
    try:
        direct_ip = ipaddress.ip_address(clean_host)
    except ValueError:
        pass

    if direct_ip is not None:
        blocked, reason = is_ip_blocked(direct_ip)
        if blocked:
            return False, reason
        return True, ""

    # Hostname requires DNS resolution to verify destination IP (prevents DNS rebinding)
    try:
        addr_info = socket.getaddrinfo(clean_host, parsed.port or (443 if scheme == "https" else 80))
    except socket.gaierror as e:
        return False, f"域名解析失败 (DNS resolution failed): {e}"
    except Exception as e:
        return False, f"域名解析异常: {e}"

    if not addr_info:
        return False, "域名解析失败: 未获取到任何 IP 地址记录"

    for entry in addr_info:
        sockaddr = entry[4]
        ip_str = sockaddr[0]
        try:
            resolved_ip = ipaddress.ip_address(ip_str)
            blocked, reason = is_ip_blocked(resolved_ip)
            if blocked:
                return False, f"域名解析到受限制网络 (DNS Rebinding/SSRF 防护): {reason}"
        except ValueError:
            continue

    return True, ""

