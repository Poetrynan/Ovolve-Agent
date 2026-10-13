/**
 * llm_errors.ts — one vocabulary for "why did this LLM call fail".
 *
 * Ported from `app/backend/llm_errors.py` (236 lines).
 *
 * Failure classification used to be string sniffing. The mapping happens
 * once, here, from the two things that ARE reasonably stable: the HTTP
 * status, and the provider's own machine-readable error type/code field.
 * Everything downstream (retry policy, model downgrade, the message the user
 * reads) keys off the resulting semantic code instead of re-guessing.
 *
 * The distinction that motivated this (source docstring, kept as contract):
 * "out of credits" and "prompt too long" are both permanent for the current
 * request, yet they call for OPPOSITE recoveries — one wants a different
 * provider, the other wants a bigger-context model on the same one. A single
 * `is_permanent` boolean cannot express that.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only.
 *   §2  frozensets → ReadonlySet with the same membership semantics; dict
 *       lookups with default → Map/record + explicit fallback.
 *   §2  Python `re.match` anchors at the START (^) — JS .exec on patterns
 *       already anchored with ^ behaves identically here.
 *   §4  naming: llm_errors.py → llm_errors.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

// --- Semantic failure codes -------------------------------------------------

export const FAILURE_QUOTA = "quota"; // credits / billing exhausted
export const FAILURE_RATE_LIMIT = "rate_limit"; // too fast, try later
export const FAILURE_CONTEXT_OVERFLOW = "context_overflow"; // prompt exceeds the window
export const FAILURE_EMPTY = "empty_response"; // 200 with nothing usable in it
export const FAILURE_AUTH = "auth"; // key missing / rejected
export const FAILURE_MODEL_NOT_FOUND = "model_not_found"; // wrong model id or base_url
export const FAILURE_BAD_REQUEST = "bad_request"; // malformed body; identical retry fails
export const FAILURE_SERVER = "server"; // provider-side 5xx
export const FAILURE_TIMEOUT = "timeout";
export const FAILURE_TRANSPORT = "transport"; // DNS / TLS / socket
export const FAILURE_CANCELLED = "cancelled"; // we stopped it ourselves
export const FAILURE_UNKNOWN = "unknown";

/** Worth trying the SAME request again after a wait. */
export const RETRYABLE: ReadonlySet<string> = new Set([
  FAILURE_RATE_LIMIT, FAILURE_SERVER, FAILURE_TIMEOUT, FAILURE_TRANSPORT,
]);

/** Retrying is pointless. Not the same as unrecoverable — see RECOVERY. */
export const PERMANENT: ReadonlySet<string> = new Set([
  FAILURE_QUOTA, FAILURE_CONTEXT_OVERFLOW, FAILURE_AUTH,
  FAILURE_MODEL_NOT_FOUND, FAILURE_BAD_REQUEST,
]);

// --- What a different model would have to look like to help ----------------

export const RECOVER_NONE = ""; // nothing to switch to; report the failure
export const RECOVER_LARGER_CONTEXT = "larger_context";
export const RECOVER_OTHER_PROVIDER = "other_provider";
export const RECOVER_ANY_MODEL = "any_model";

/** Failure → the direction a downgrade has to move in. Getting this wrong is
 * worse than not downgrading: jumping to a cheaper small-context model on a
 * context overflow fails again immediately, and re-trying the same provider
 * on an exhausted quota fails again for free. */
export const RECOVERY: Readonly<Record<string, string>> = {
  [FAILURE_CONTEXT_OVERFLOW]: RECOVER_LARGER_CONTEXT,
  [FAILURE_QUOTA]: RECOVER_OTHER_PROVIDER,
  [FAILURE_AUTH]: RECOVER_OTHER_PROVIDER,
  [FAILURE_MODEL_NOT_FOUND]: RECOVER_ANY_MODEL,
  // A provider that keeps 5xx-ing is a provider problem, not a model problem;
  // worth one hop away once the retry ladder is spent.
  [FAILURE_SERVER]: RECOVER_OTHER_PROVIDER,
  [FAILURE_RATE_LIMIT]: RECOVER_OTHER_PROVIDER,
  [FAILURE_TIMEOUT]: RECOVER_OTHER_PROVIDER,
  [FAILURE_TRANSPORT]: RECOVER_OTHER_PROVIDER,
};

// --- Provider error-type vocabularies --------------------------------------

/** Substrings of the provider's own `error.type` / `error.code` / message.
 * Ordered most-specific first inside each bucket; the scan stops at the first
 * hit so "insufficient_quota" cannot be swallowed by a looser "quota" rule. */
const _BODY_SIGNS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [FAILURE_CONTEXT_OVERFLOW, [
    "context_length_exceeded", "context length", "maximum context",
    "too many tokens", "prompt is too long", "reduce the length",
    "input length and `max_tokens` exceed", "string too long",
  ]],
  [FAILURE_QUOTA, [
    "insufficient_quota", "insufficient_user_quota", "billing",
    "exceeded your current quota", "credit balance is too low",
    "out of credits", "payment required", "arrearage",
  ]],
  [FAILURE_RATE_LIMIT, [
    "rate_limit", "rate limit", "too many requests", "tpm", "rpm",
    "concurrency limit", "overloaded",
  ]],
  [FAILURE_AUTH, [
    "invalid_api_key", "invalid api key", "authentication",
    "unauthorized", "permission_denied", "api key not valid",
    "incorrect api key",
  ]],
  [FAILURE_MODEL_NOT_FOUND, [
    "model_not_found", "does not exist", "unknown model",
    "unsupported model", "no such model",
  ]],
];

/** Status → semantic code, used when the body says nothing recognisable. */
const _STATUS_MAP: Readonly<Record<number, string>> = {
  400: FAILURE_BAD_REQUEST,
  401: FAILURE_AUTH,
  402: FAILURE_QUOTA,
  403: FAILURE_AUTH,
  404: FAILURE_MODEL_NOT_FOUND,
  408: FAILURE_TIMEOUT,
  413: FAILURE_CONTEXT_OVERFLOW,
  422: FAILURE_BAD_REQUEST,
  429: FAILURE_RATE_LIMIT,
};

const _HTTP_CODE_RE = /^HTTP(\d{3})$/;

/** Semantic code implied by a provider error body, or "" when unclear. */
function _body_signal(text: string): string {
  const low = (text ?? "").toLowerCase();
  if (!low) {
    return "";
  }
  for (const [code, needles] of _BODY_SIGNS) {
    for (const needle of needles) {
      if (low.includes(needle)) {
        return code;
      }
    }
  }
  return "";
}

/** The machine-readable parts of a provider error body, joined.
 *
 * Prefers `error.type` / `error.code` / `error.message` when the body is
 * JSON, because those are the closest thing to a contract. Falls back to the
 * raw text so a non-JSON error page still gets scanned. */
function _error_fields(body: string): string {
  const text = (body ?? "").trim();
  if (!text) {
    return "";
  }
  const start = text.indexOf("{");
  if (start >= 0) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text.slice(start));
    } catch {
      // (json.JSONDecodeError, ValueError) -> parsed stays None
      parsed = null;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const p = parsed as Record<string, unknown>;
      const err = p["error"];
      if (typeof err === "string") {
        return err;
      }
      if (typeof err === "object" && err !== null && !Array.isArray(err)) {
        const e = err as Record<string, unknown>;
        const parts = ["type", "code", "message"].map((k) => String(e[k] ?? ""));
        const joined = parts.filter((x) => x).join(" ");
        if (joined) {
          return joined;
        }
      }
      for (const key of ["message", "detail", "msg"]) {
        if (typeof p[key] === "string") {
          return p[key] as string;
        }
      }
    }
  }
  return text;
}

/** Map one failed call to a semantic code.
 *
 * @param code The transport-level code we stamped (HTTP429, Timeout,
 *   Transport, NoApiKey, Cancelled…).
 * @param error The error string, normally "HTTP <status>: <body>".
 * @param status HTTP status when the caller already has it separately.
 *
 * Precedence is deliberate: **body first, then status.** A provider that
 * answers 400 for "context_length_exceeded" is common, and treating that as a
 * generic malformed request throws away the one recovery that would have
 * worked. The status is the fallback, not the authority. */
export function classify(code = "", error = "", status = 0): string {
  code = String(code ?? "");
  if (code === "NoApiKey") return FAILURE_AUTH;
  if (code === "Cancelled") return FAILURE_CANCELLED;
  if (code === "Timeout") return FAILURE_TIMEOUT;
  if (code === "Transport") return FAILURE_TRANSPORT;
  if (code === "EmptyResponse") return FAILURE_EMPTY;

  let st = status;
  if (!st) {
    const m = _HTTP_CODE_RE.exec(code);
    if (m) {
      st = Number(m[1]);
    } else {
      const m2 = /^HTTP (\d{3})/.exec(String(error ?? ""));
      if (m2) {
        st = Number(m2[1]);
      }
    }
  }

  const signal = _body_signal(_error_fields(String(error ?? "")));
  if (signal) {
    return signal;
  }
  if (st) {
    if (st in _STATUS_MAP) {
      return _STATUS_MAP[st]!;
    }
    if (st >= 500 && st < 600) {
      return FAILURE_SERVER;
    }
    if (st >= 400 && st < 500) {
      return FAILURE_BAD_REQUEST;
    }
  }
  return FAILURE_UNKNOWN;
}

/** Whether the identical request is worth sending again after a wait. */
export function is_retryable(failure: string): boolean {
  return RETRYABLE.has(failure);
}

/** Whether retrying the identical request is guaranteed to fail again. */
export function is_permanent(failure: string): boolean {
  return PERMANENT.has(failure);
}

/** Which direction a model switch would have to move in. "" = none helps. */
export function recovery_for(failure: string): string {
  return RECOVERY[failure] ?? RECOVER_NONE;
}

const _DESCRIBE: Readonly<Record<string, string>> = {
  [FAILURE_QUOTA]: "额度或余额已用尽",
  [FAILURE_RATE_LIMIT]: "触发服务商限流",
  [FAILURE_CONTEXT_OVERFLOW]: "上下文超出该模型窗口",
  [FAILURE_EMPTY]: "服务商返回了空响应",
  [FAILURE_AUTH]: "密钥无效或无权访问",
  [FAILURE_MODEL_NOT_FOUND]: "该服务商没有这个模型",
  [FAILURE_BAD_REQUEST]: "请求被服务商拒绝",
  [FAILURE_SERVER]: "服务商内部错误",
  [FAILURE_TIMEOUT]: "请求超时",
  [FAILURE_TRANSPORT]: "网络无法连接",
  [FAILURE_CANCELLED]: "已取消",
};

/** Short user-facing reason, in the product's language. */
export function describe(failure: string): string {
  return _DESCRIBE[failure] ?? "未知错误";
}
