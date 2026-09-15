"""llm_errors.py — one vocabulary for "why did this LLM call fail".

Failure classification used to be string sniffing: ``"HTTP 401" in err`` and
``"invalid" in err.lower()``. The author's own comment admitted a provider's
error text is not a stable contract, and it isn't — the same condition arrives as
``insufficient_quota``, ``billing_hard_limit_reached`` or a bare 402 depending on
who you ask, and a body that merely *mentions* "invalid" would be misfiled.

So the mapping happens once, here, from the two things that ARE reasonably
stable: the HTTP status, and the provider's own machine-readable error type/code
field. Everything downstream (retry policy, model downgrade, the message the user
reads) keys off the resulting semantic code instead of re-guessing from text.

The distinction that motivated this: "out of credits" and "prompt too long" are
both permanent for the current request, yet they call for OPPOSITE recoveries —
one wants a different provider, the other wants a bigger-context model on the
same one. A single ``is_permanent`` boolean cannot express that.
"""
from __future__ import annotations

import json
import re

# --- Semantic failure codes -------------------------------------------------

FAILURE_QUOTA = "quota"                       # credits / billing exhausted
FAILURE_RATE_LIMIT = "rate_limit"             # too fast, try later
FAILURE_CONTEXT_OVERFLOW = "context_overflow"  # prompt exceeds the window
FAILURE_EMPTY = "empty_response"              # 200 with nothing usable in it
FAILURE_AUTH = "auth"                         # key missing / rejected
FAILURE_MODEL_NOT_FOUND = "model_not_found"   # wrong model id or base_url
FAILURE_BAD_REQUEST = "bad_request"           # malformed body; identical retry fails
FAILURE_SERVER = "server"                     # provider-side 5xx
FAILURE_TIMEOUT = "timeout"
FAILURE_TRANSPORT = "transport"               # DNS / TLS / socket
FAILURE_CANCELLED = "cancelled"               # we stopped it ourselves
FAILURE_UNKNOWN = "unknown"

#: Worth trying the SAME request again after a wait.
RETRYABLE = frozenset({
    FAILURE_RATE_LIMIT, FAILURE_SERVER, FAILURE_TIMEOUT, FAILURE_TRANSPORT,
})

#: Retrying is pointless. Not the same as unrecoverable — see RECOVERY.
PERMANENT = frozenset({
    FAILURE_QUOTA, FAILURE_CONTEXT_OVERFLOW, FAILURE_AUTH,
    FAILURE_MODEL_NOT_FOUND, FAILURE_BAD_REQUEST,
})

# --- What a different model would have to look like to help ----------------

RECOVER_NONE = ""                     # nothing to switch to; report the failure
RECOVER_LARGER_CONTEXT = "larger_context"
RECOVER_OTHER_PROVIDER = "other_provider"
RECOVER_ANY_MODEL = "any_model"

#: Failure → the direction a downgrade has to move in. Getting this wrong is
#: worse than not downgrading: jumping to a cheaper small-context model on a
#: context overflow fails again immediately, and re-trying the same provider on
#: an exhausted quota fails again for free.
RECOVERY = {
    FAILURE_CONTEXT_OVERFLOW: RECOVER_LARGER_CONTEXT,
    FAILURE_QUOTA: RECOVER_OTHER_PROVIDER,
    FAILURE_AUTH: RECOVER_OTHER_PROVIDER,
    FAILURE_MODEL_NOT_FOUND: RECOVER_ANY_MODEL,
    # A provider that keeps 5xx-ing is a provider problem, not a model problem;
    # worth one hop away once the retry ladder is spent.
    FAILURE_SERVER: RECOVER_OTHER_PROVIDER,
    FAILURE_RATE_LIMIT: RECOVER_OTHER_PROVIDER,
    FAILURE_TIMEOUT: RECOVER_OTHER_PROVIDER,
    FAILURE_TRANSPORT: RECOVER_OTHER_PROVIDER,
}

# --- Provider error-type vocabularies --------------------------------------

#: Substrings of the provider's own ``error.type`` / ``error.code`` / message.
#: Ordered most-specific first inside each bucket; the scan stops at the first
#: hit so "insufficient_quota" cannot be swallowed by a looser "quota" rule.
_BODY_SIGNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (FAILURE_CONTEXT_OVERFLOW, (
        "context_length_exceeded", "context length", "maximum context",
        "too many tokens", "prompt is too long", "reduce the length",
        "input length and `max_tokens` exceed", "string too long",
    )),
    (FAILURE_QUOTA, (
        "insufficient_quota", "insufficient_user_quota", "billing",
        "exceeded your current quota", "credit balance is too low",
        "out of credits", "payment required", "arrearage",
    )),
    (FAILURE_RATE_LIMIT, (
        "rate_limit", "rate limit", "too many requests", "tpm", "rpm",
        "concurrency limit", "overloaded",
    )),
    (FAILURE_AUTH, (
        "invalid_api_key", "invalid api key", "authentication",
        "unauthorized", "permission_denied", "api key not valid",
        "incorrect api key",
    )),
    (FAILURE_MODEL_NOT_FOUND, (
        "model_not_found", "does not exist", "unknown model",
        "unsupported model", "no such model",
    )),
)

#: Status → semantic code, used when the body says nothing recognisable.
_STATUS_MAP = {
    400: FAILURE_BAD_REQUEST,
    401: FAILURE_AUTH,
    402: FAILURE_QUOTA,
    403: FAILURE_AUTH,
    404: FAILURE_MODEL_NOT_FOUND,
    408: FAILURE_TIMEOUT,
    413: FAILURE_CONTEXT_OVERFLOW,
    422: FAILURE_BAD_REQUEST,
    429: FAILURE_RATE_LIMIT,
}

_HTTP_CODE_RE = re.compile(r"^HTTP(\d{3})$")


def _body_signal(text: str) -> str:
    """Semantic code implied by a provider error body, or "" when unclear."""
    low = (text or "").lower()
    if not low:
        return ""
    for code, needles in _BODY_SIGNS:
        for needle in needles:
            if needle in low:
                return code
    return ""


def _error_fields(body: str) -> str:
    """The machine-readable parts of a provider error body, joined.

    Prefers ``error.type`` / ``error.code`` / ``error.message`` when the body is
    JSON, because those are the closest thing to a contract. Falls back to the
    raw text so a non-JSON error page still gets scanned.
    """
    text = (body or "").strip()
    if not text:
        return ""
    start = text.find("{")
    if start >= 0:
        try:
            parsed = json.loads(text[start:])
        except (json.JSONDecodeError, ValueError):
            parsed = None
        if isinstance(parsed, dict):
            err = parsed.get("error")
            if isinstance(err, str):
                return err
            if isinstance(err, dict):
                parts = [str(err.get(k) or "") for k in ("type", "code", "message")]
                joined = " ".join(p for p in parts if p)
                if joined:
                    return joined
            for key in ("message", "detail", "msg"):
                if isinstance(parsed.get(key), str):
                    return parsed[key]
    return text


def classify(code: str = "", error: str = "", status: int = 0) -> str:
    """Map one failed call to a semantic code.

    Args:
        code: The transport-level code we stamped (``HTTP429``, ``Timeout``,
            ``Transport``, ``NoApiKey``, ``Cancelled``…).
        error: The error string, normally ``"HTTP <status>: <body>"``.
        status: HTTP status when the caller already has it separately.

    Precedence is deliberate: **body first, then status.** A provider that
    answers 400 for "context_length_exceeded" is common, and treating that as a
    generic malformed request throws away the one recovery that would have
    worked. The status is the fallback, not the authority.
    """
    code = str(code or "")
    if code == "NoApiKey":
        return FAILURE_AUTH
    if code == "Cancelled":
        return FAILURE_CANCELLED
    if code == "Timeout":
        return FAILURE_TIMEOUT
    if code == "Transport":
        return FAILURE_TRANSPORT
    if code == "EmptyResponse":
        return FAILURE_EMPTY

    if not status:
        m = _HTTP_CODE_RE.match(code)
        if m:
            status = int(m.group(1))
        else:
            m2 = re.match(r"^HTTP (\d{3})", str(error or ""))
            if m2:
                status = int(m2.group(1))

    signal = _body_signal(_error_fields(str(error or "")))
    if signal:
        return signal
    if status:
        if status in _STATUS_MAP:
            return _STATUS_MAP[status]
        if 500 <= status < 600:
            return FAILURE_SERVER
        if 400 <= status < 500:
            return FAILURE_BAD_REQUEST
    return FAILURE_UNKNOWN


def is_retryable(failure: str) -> bool:
    """Whether the identical request is worth sending again after a wait."""
    return failure in RETRYABLE


def is_permanent(failure: str) -> bool:
    """Whether retrying the identical request is guaranteed to fail again."""
    return failure in PERMANENT


def recovery_for(failure: str) -> str:
    """Which direction a model switch would have to move in. "" = none helps."""
    return RECOVERY.get(failure, RECOVER_NONE)


def describe(failure: str) -> str:
    """Short user-facing reason, in the product's language."""
    return {
        FAILURE_QUOTA: "额度或余额已用尽",
        FAILURE_RATE_LIMIT: "触发服务商限流",
        FAILURE_CONTEXT_OVERFLOW: "上下文超出该模型窗口",
        FAILURE_EMPTY: "服务商返回了空响应",
        FAILURE_AUTH: "密钥无效或无权访问",
        FAILURE_MODEL_NOT_FOUND: "该服务商没有这个模型",
        FAILURE_BAD_REQUEST: "请求被服务商拒绝",
        FAILURE_SERVER: "服务商内部错误",
        FAILURE_TIMEOUT: "请求超时",
        FAILURE_TRANSPORT: "网络无法连接",
        FAILURE_CANCELLED: "已取消",
    }.get(failure, "未知错误")
