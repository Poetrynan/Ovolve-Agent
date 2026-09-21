"""Tests for SSRF URL Guard (Cloud IMDS & Private Network Blacklist).

Based on community reference implementation for URL security sanitization.
"""
import os
import socket
import pytest
from app.backend.url_guard import check_url

def test_public_urls_allowed(monkeypatch):
    # Mock DNS to resolve to a public IP
    def fake_getaddrinfo(host, port, *args, **kwargs):
        if host in ("example.com", "github.com"):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 80))]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 80))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    ok, reason = check_url("https://example.com/api/v1")
    assert ok is True
    assert reason == ""

    ok, reason = check_url("http://github.com/test/repo")
    assert ok is True

    ok, reason = check_url("https://93.184.216.34/path")
    assert ok is True

def test_invalid_scheme_rejected():
    for url in ["ftp://example.com", "file:///etc/passwd", "gopher://127.0.0.1", "javascript:alert(1)", ""]:
        ok, reason = check_url(url)
        assert ok is False
        assert "协议" in reason or "scheme" in reason.lower() or "无效" in reason


def test_credentials_in_url_rejected():
    for url in ["http://user:pass@example.com/", "https://admin@example.com/secret"]:
        ok, reason = check_url(url)
        assert ok is False
        assert any(k in reason.lower() for k in ["凭据", "credential", "userinfo", "auth"])


def test_loopback_and_private_ips_rejected(monkeypatch):
    def fake_getaddrinfo(host, port, *args, **kwargs):
        if host == "localhost":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (host, 80))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    private_urls = [
        "http://127.0.0.1:8931/",
        "http://127.0.0.2/",
        "http://localhost:8080/",
        "http://10.0.1.5/admin",
        "http://172.16.5.10/",
        "http://172.31.255.254/",
        "http://192.168.1.1/router",
        "http://0.0.0.0/",
        "http://[::1]/",
        "http://[fe80::1]/",
    ]
    for url in private_urls:
        ok, reason = check_url(url)
        assert ok is False, f"Expected {url} to be blocked"
        assert any(k in reason.lower() for k in ["私网", "loopback", "private", "blocked", "拦截"])


def test_imds_endpoints_rejected():
    imds_urls = [
        "http://169.254.169.254/latest/meta-data/",
        "http://169.254.169.254/computeMetadata/v1/",
        "http://[fd00:ec2::254]/latest/meta-data/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://instance-data/latest/meta-data/",
    ]
    for url in imds_urls:
        ok, reason = check_url(url)
        assert ok is False, f"Expected {url} to be blocked"
        assert any(k in reason.lower() for k in ["元数据", "imds", "私网", "link-local", "metadata", "blocked"])


def test_dns_rebinding_to_private_ip_rejected(monkeypatch):
    # A public-looking hostname that resolves to a private IP
    def fake_getaddrinfo(host, port, *args, **kwargs):
        if host == "rebinding.attacker.com":
            return [
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.2.3.4", 80)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 80)),
            ]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("1.1.1.1", 80))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    ok, reason = check_url("http://rebinding.attacker.com/steal")
    assert ok is False
    assert any(k in reason.lower() for k in ["私网", "private", "rebinding", "blocked", "拦截"])


def test_allow_private_override(monkeypatch):
    ok, reason = check_url("http://127.0.0.1:8000/", allow_private=True)
    assert ok is True

    monkeypatch.setenv("OVOLVE_ALLOW_PRIVATE_URLS", "1")
    ok, reason = check_url("http://192.168.1.1/test")
    assert ok is True


def test_dns_resolution_failure_rejected(monkeypatch):
    def fake_getaddrinfo(host, port, *args, **kwargs):
        raise socket.gaierror("Name or service not known")

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    ok, reason = check_url("http://nonexistent-domain-xyz-12345.com/")
    assert ok is False
    assert any(w in reason.lower() for w in ["解析失败", "dns", "failed", "unresolvable", "域名"])


def test_browser_agent_web_fetch_ssrf_blocked():
    from app.backend.browser_agent import _web_fetch
    res = _web_fetch({"url": "http://169.254.169.254/latest/meta-data/"}, {})
    assert not res.ok
    assert "SSRF" in res.error or "安全校验" in res.error


def test_browser_agent_navigate_ssrf_blocked():
    from app.backend.browser_agent import _navigate
    # _navigate requires sessions in ctx, mock or pass dummy context
    class DummySessions:
        pass
    res = _navigate({"url": "http://127.0.0.1:9222/json"}, {"sessions": DummySessions()})
    assert not res.ok
    assert "SSRF" in res.error or "安全校验" in res.error



