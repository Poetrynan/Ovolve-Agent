"""
failure_taxonomy.py — Provider 失败分类学（Phase 9 首切片）。

总指令 §12：失败分类必须可恢复，每类的重试/fallback 策略不同，且"不得为了
成功率隐瞒昂贵重试或把失败变成假成功"。本模块把分类从 llm_client 的字符串
猜测里提出来，成为可测试的纯函数 + 策略表。

分类只看证据（错误文本/状态码/异常类型），不猜意图。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

QUOTA = "quota"
RATE_LIMIT = "rate_limit"
CONTEXT_OVERFLOW = "context_overflow"
AUTH = "auth"
INVALID_TOOL = "invalid_tool"
NETWORK = "network"
PROVIDER = "provider"
POLICY = "policy"
UNKNOWN = "unknown"

_CLASSES = (QUOTA, RATE_LIMIT, CONTEXT_OVERFLOW, AUTH, INVALID_TOOL,
            NETWORK, PROVIDER, POLICY, UNKNOWN)

_PATTERNS: list[tuple[str, re.Pattern]] = [
    (CONTEXT_OVERFLOW, re.compile(
        r"context.{0,12}(length|window|overflow)|maximum context|too many tokens|"
        r"prompt is too long|max_tokens.*exceed", re.I)),
    (RATE_LIMIT, re.compile(r"\b429\b|rate.?limit|too many requests|TPD|RPM", re.I)),
    (QUOTA, re.compile(r"\b402\b|quota|billing|insufficient.*(balance|credit)|exceeded.*budget", re.I)),
    (AUTH, re.compile(r"\b401\b|\b403\b|unauthorized|invalid api key|authentication", re.I)),
    (POLICY, re.compile(r"\b451\b|content.?policy|safety system|blocked by policy", re.I)),
    (INVALID_TOOL, re.compile(r"invalid tool|no such tool|tool_use_failed|schema validation", re.I)),
    (NETWORK, re.compile(r"ECONNRESET|ETIMEDOUT|ECONNREFUSED|getaddrinfo|network|connection (reset|refused|timed out)", re.I)),
]


@dataclass(frozen=True)
class RetryPolicy:
    max_retries: int          # 0 = 不重试
    backoff_base_s: float     # 指数退避基数：base * 2^attempt
    allow_fallback: bool      # 允许切换到 fallback group 里的其他 provider


#: §12 失败分类 → 可恢复策略。policy/auth 不重试是纪律不是懒惰。
RETRY_POLICY: Dict[str, RetryPolicy] = {
    QUOTA:            RetryPolicy(0, 0.0, False),
    RATE_LIMIT:       RetryPolicy(3, 2.0, True),
    CONTEXT_OVERFLOW: RetryPolicy(0, 0.0, True),   # 走 compaction / 大窗模型
    AUTH:             RetryPolicy(0, 0.0, False),
    INVALID_TOOL:     RetryPolicy(1, 0.5, False),  # 修正 schema/参数，限一次
    NETWORK:          RetryPolicy(3, 1.0, True),
    PROVIDER:         RetryPolicy(1, 1.0, True),
    POLICY:           RetryPolicy(0, 0.0, False),
    UNKNOWN:          RetryPolicy(1, 1.0, False),
}


def classify(error: object, status_code: int | None = None) -> str:
    """从状态码或错误文本判类。状态码优先——它是结构化证据。"""
    if status_code is not None:
        code_map = {429: RATE_LIMIT, 401: AUTH, 402: QUOTA, 403: AUTH,
                    404: PROVIDER, 413: CONTEXT_OVERFLOW, 451: POLICY,
                    500: PROVIDER, 502: PROVIDER, 503: PROVIDER, 529: PROVIDER}
        if status_code in code_map:
            return code_map[status_code]
    text = str(getattr(error, "message", "") or error or "")
    if not text:
        return UNKNOWN
    for cls, pat in _PATTERNS:
        if pat.search(text):
            return cls
    return UNKNOWN


def policy_for(cls: str) -> RetryPolicy:
    return RETRY_POLICY.get(cls, RETRY_POLICY[UNKNOWN])


# ── llm_errors 适配层（§20：发现同类模块先复用加 adapter，不建第二套）──────────
# llm_errors.py 的语义码是权威分类源；本表把它映射到 §12 重试策略。
_LLMErrors_POLICY_MAP = {
    "quota": QUOTA,
    "rate_limit": RATE_LIMIT,
    "context_overflow": CONTEXT_OVERFLOW,
    "auth": AUTH,
    "model_not_found": INVALID_TOOL,   # 配置错误：重试无益
    "bad_request": INVALID_TOOL,
    "server": PROVIDER,
    "timeout": NETWORK,
    "transport": NETWORK,
    "empty_response": UNKNOWN,         # 200 空响应：保守重试一次
    "cancelled": POLICY,               # 我们自己停的：零重试语义
    "unknown": UNKNOWN,
}


def policy_for_failure(failure_code: str) -> RetryPolicy:
    """llm_errors 的语义码 → §12 重试策略。未知码走最保守档。"""
    cls = _LLMErrors_POLICY_MAP.get(str(failure_code or ""), UNKNOWN)
    return RETRY_POLICY.get(cls, RETRY_POLICY[UNKNOWN])


def backoff_delay(cls: str, attempt: int) -> float:
    """第 attempt 次（0 起）重试前的等待秒数。不可重试类返回 0。"""
    p = policy_for(cls)
    if p.max_retries == 0 or attempt >= p.max_retries:
        return 0.0
    return round(p.backoff_base_s * (2 ** attempt), 2)


def backoff_delay_for_failure(failure_code: str, attempt: int) -> float:
    """同 :func:`backoff_delay`，但接受 llm_errors 的语义码（经适配表）。

    llm_client 手里的分类是 "server"/"timeout"/"transport"/"empty_response"
    这类适配层码——直接喂给 :func:`backoff_delay` 会落进 UNKNOWN 档，
    用错退避基数。"""
    p = policy_for_failure(failure_code)
    if p.max_retries == 0 or attempt >= p.max_retries:
        return 0.0
    return round(p.backoff_base_s * (2 ** attempt), 2)


def explain(cls: str) -> str:
    """给 UI/日志的一句话处置说明。"""
    table = {
        QUOTA: "预算/额度用尽：告警或等待充值，不无限重试",
        RATE_LIMIT: "限流：有界退避，必要时切 fallback provider",
        CONTEXT_OVERFLOW: "上下文超窗：先压缩或换大窗口模型",
        AUTH: "凭证无效：停止并提示用户，绝不循环重试",
        INVALID_TOOL: "工具调用不合法：修正 schema/参数，最多重试一次",
        NETWORK: "网络故障：有界重试并保留 checkpoint",
        PROVIDER: "provider 内部错误：有限重试后 fallback 并记录",
        POLICY: "被策略拦截：不重试，进入审批/拒绝路径",
        UNKNOWN: "未归类失败：保守重试一次并保留完整现场",
    }
    return table.get(cls, "未归类失败")
