/**
 * llm_client.ts - Unified LLM client for Ovolve (TS port).
 *
 * Connects the router / goal_manager / memory_layer to the configured LLM provider
 * (OpenAI-compatible Chat Completions API). Supports:
 *   - Streaming & non-streaming
 *   - Reasoning models (reasoning_content field, e.g. LongCat-2.0)
 *   - Token usage tracking via model_registry
 *   - Retry with exponential backoff
 *   - System prompt injection (environment snapshot + memory + goal context)
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Result } from "./result.js";
import { get_telemetry, SpanName, type Telemetry, type Span } from "./telemetry.js";
import { get_rate_limiter } from "./rate_limiter.js";
import {
  plan_cache_breakpoints,
  resolve_effective_system_prefix,
} from "./prompt_cache_planner.js";
import { StreamingThinkScrubber, scrub_static } from "./stream_scrubber.js";
import {
  scene_effort,
  body_plan,
  is_reasoning_model,
} from "./model_registry.js";
import { get_model_registry } from "./model_registry_impl.js";
import { extract as _extract_media, normalize_content } from "./image_extract.js";
import {
  check_allowed,
  record_failure,
  record_success,
} from "./stream_circuit_breaker.js";
import {
  classify as classify_error,
  is_permanent as is_permanent_error,
  recovery_for,
  FAILURE_UNKNOWN,
  FAILURE_CANCELLED,
  FAILURE_RATE_LIMIT,
} from "./llm_errors.js";
import {
  backoff_delay_for_failure,
  policy_for_failure,
} from "./failure_taxonomy.js";
import { BYTES_PER_TOKEN } from "./token_estimate.js";

export const IMAGE_TOKEN_ESTIMATE = 1200;

export function _parse_retry_after(value: any): number {
  try {
    const s = String(value ?? "").trim();
    const n = parseFloat(s);
    return isNaN(n) ? 0.0 : Math.max(0.0, n);
  } catch {
    return 0.0;
  }
}

export const _CACHE_BREAKPOINT_KINDS: ReadonlySet<string> = new Set(["anthropic", "oauth"]);
export const CACHE_PREFIX_MIN_CHARS = 4000;

export interface LLMClientSeams {
  fetch?: (url: string, init: any) => Promise<any>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  readConfigFile?: (filePath: string) => string | null;
}

export const LLM_CLIENT_SEAMS: LLMClientSeams = {
  fetch: typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined,
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  readConfigFile: (filePath: string) => {
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
      }
    } catch {
      // fail-open
    }
    return null;
  },
};

export class LLMClient {
  public static readonly DEFAULT_MAX_TOKENS = 65536;
  public static readonly DEFAULT_TIMEOUT = 120;
  public static readonly RETRY_DELAYS = [1.0, 2.0, 4.0, 8.0, 16.0];
  public static readonly PERMANENT_CODES = ["NoApiKey"];
  public static readonly PERMANENT_HTTP = ["400", "401", "402", "403", "404"];

  public model_id: string;
  public api_key: string;
  public base_url: string;
  public max_tokens: number;
  public temperature: number;
  public context_limit: number;
  public timeout_s: number;
  public output_limit: number;
  public kind: string;
  public cache_ttl: string;
  public provider_id: string;
  public effort: string;
  public effort_supported: boolean | null;
  public _telemetry: Telemetry;

  constructor(config: Record<string, any> = {}) {
    const model_cfg = (config && typeof config === "object" && config["model"]) || {};
    this.model_id = String(model_cfg["model_id"] || "LongCat-2.0");
    this.api_key = String(model_cfg["api_key"] || "");
    this.base_url = String(model_cfg["base_url"] || "").replace(/\/+$/, "");
    this.max_tokens = Number(model_cfg["max_tokens"] ?? LLMClient.DEFAULT_MAX_TOKENS);
    this.temperature = Number(model_cfg["temperature"] ?? 0.0);
    this.context_limit = Number(model_cfg["context_limit"] ?? 200000);

    let t = LLMClient.DEFAULT_TIMEOUT;
    try {
      const rawT = model_cfg["stream_timeout_s"];
      if (rawT !== undefined && rawT !== null && rawT !== "") {
        t = Math.max(30, parseInt(String(rawT), 10));
      }
    } catch {
      t = LLMClient.DEFAULT_TIMEOUT;
    }
    this.timeout_s = isNaN(t) ? LLMClient.DEFAULT_TIMEOUT : t;

    this.output_limit = Number(model_cfg["output_limit"] || 0);
    this.kind = String(model_cfg["kind"] || "");
    this.cache_ttl = String(model_cfg["cache_ttl"] || "");
    this.provider_id = "";
    this.effort = "";
    this.effort_supported = null;
    this._telemetry = get_telemetry();
  }

  public get endpoint(): string {
    return `${this.base_url}/chat/completions`;
  }

  public bind(resolved: Record<string, any>): LLMClient {
    if (!resolved || typeof resolved !== "object") {
      return this;
    }
    const model_id = String(resolved["model_id"] ?? "").trim() || this.model_id;
    const api_key = String(resolved["api_key"] ?? "") || this.api_key;
    const base_url = (String(resolved["base_url"] ?? "").trim() || this.base_url).replace(/\/+$/, "");
    const ctx = Number(resolved["context_limit"] || 0) || this.context_limit;
    const out_lim = Number(resolved["output_limit"] || 0) || this.output_limit;
    const pid = String(resolved["provider_id"] ?? "") || this.provider_id;
    const kind = String(resolved["kind"] ?? "") || this.kind;

    const declared =
      "supports_thinking_declared" in resolved
        ? resolved["supports_thinking_declared"]
        : this.effort_supported;

    if (
      model_id === this.model_id &&
      api_key === this.api_key &&
      base_url === this.base_url &&
      ctx === this.context_limit &&
      out_lim === this.output_limit &&
      pid === this.provider_id &&
      kind === this.kind &&
      declared === this.effort_supported
    ) {
      return this;
    }

    const clone = Object.create(Object.getPrototypeOf(this));
    Object.assign(clone, this);
    clone.model_id = model_id;
    clone.api_key = api_key;
    clone.base_url = base_url;
    clone.context_limit = ctx;
    clone.output_limit = out_lim;
    clone.provider_id = pid;
    clone.kind = kind;
    clone.effort_supported = declared;
    return clone;
  }

  public bind_scene(scene: string): LLMClient {
    if (!scene) {
      return this;
    }
    let info: any;
    let effort = "";
    try {
      const reg = get_model_registry();
      info = reg.resolve("", scene);
      effort = scene_effort(scene);
    } catch {
      return this;
    }

    let bound: LLMClient = this;
    if (info && info.ok && typeof info.value === "object") {
      bound = this.bind(info.value);
    }
    if (effort && effort !== bound.effort) {
      const clone = Object.create(Object.getPrototypeOf(bound));
      Object.assign(clone, bound);
      clone.effort = effort;
      bound = clone;
    }
    return bound;
  }

  public _apply_body_plan(body: Record<string, any>, level: string): Record<string, any> {
    const plan = body_plan(
      this.model_id,
      this.kind,
      level,
      Number(body["max_tokens"] ?? this.max_tokens),
      this.output_limit,
      this.effort_supported,
    ) as { set: Record<string, any>; unset: string[]; compat: any };
    Object.assign(body, plan.set);
    for (const key of plan.unset) {
      delete body[key];
    }
    return plan;
  }

  public _mark_cache_breakpoint(msgs: any[], prefix: string): void {
    if (!prefix || !_CACHE_BREAKPOINT_KINDS.has(this.kind.toLowerCase())) {
      return;
    }
    if (!msgs || msgs.length === 0 || msgs[0]?.role !== "system") {
      return;
    }
    const content = msgs[0].content;
    if (typeof content !== "string") {
      return;
    }
    if (!content.startsWith(prefix) || prefix.length >= content.length) {
      return;
    }
    msgs[0] = {
      role: "system",
      content: [
        {
          type: "text",
          text: prefix,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: content.slice(prefix.length),
        },
      ],
    };
  }

  public _apply_cache_plan(msgs: any[], cache_prefix: string): void {
    const effective = resolve_effective_system_prefix(msgs, cache_prefix);
    const plan = plan_cache_breakpoints(msgs, {
      system_prefix: effective,
      kind: this.kind,
      ttl: this.cache_ttl,
    });
    if (plan.messages !== msgs) {
      msgs.length = 0;
      msgs.push(...plan.messages);
    }
  }

  public _backfill_reasoning_content(msgs: any[]): void {
    let needs_backfill = false;
    try {
      const key = String(this.model_id || "").toLowerCase();
      needs_backfill =
        is_reasoning_model(this.model_id) ||
        ["deepseek", "kimi", "moonshot", "glm", "qwen", "qwq"].some((h) => key.includes(h));
    } catch {
      needs_backfill = false;
    }

    if (!needs_backfill) {
      for (const msg of msgs) {
        if (msg && typeof msg === "object" && msg.role === "assistant") {
          delete msg.reasoning_content;
        }
      }
      return;
    }

    for (const msg of msgs) {
      if (msg && typeof msg === "object" && msg.role === "assistant") {
        if (!("reasoning_content" in msg)) {
          msg.reasoning_content = "";
        }
      }
    }
  }

  public async chat(
    messages: any[],
    max_tokens?: number | null,
    temperature?: number | null,
    system?: string | null,
    extra: Record<string, any> = {},
  ): Promise<Result> {
    const span = this._telemetry.start_span(SpanName.LLM_REQUEST, { model: this.model_id });
    const msgs = [...messages];
    if (system) {
      msgs.unshift({ role: "system", content: system });
    }

    const extraCopy = { ...extra };
    const abort_check = extraCopy["abort_check"];
    delete extraCopy["abort_check"];
    const effort = extraCopy["reasoning_effort"] || this.effort;
    delete extraCopy["reasoning_effort"];
    const cache_prefix = String(extraCopy["cache_prefix"] || "");
    delete extraCopy["cache_prefix"];

    if (cache_prefix.length >= CACHE_PREFIX_MIN_CHARS) {
      this._apply_cache_plan(msgs, cache_prefix);
    }
    this._backfill_reasoning_content(msgs);

    const body: Record<string, any> = {
      model: this.model_id,
      messages: msgs,
      max_tokens: max_tokens || this.max_tokens,
      temperature: temperature !== undefined && temperature !== null ? temperature : this.temperature,
      ...extraCopy,
    };
    this._apply_body_plan(body, effort);

    const result = await this._post_with_retry(body, abort_check);
    if (!result.ok) {
      span.set_error(result.error);
      this._telemetry.end_span(span, { error: result.error });
      return result;
    }

    const raw = (result.value as Record<string, any>) || {};
    const choice = (raw.choices && raw.choices[0]) || {};
    const message = choice.message || {};
    const usage = raw.usage || {};

    const [rawText, images] = _extract_media(message, raw);
    let text = rawText;
    let hidden = "";
    if (text && text.includes("<think>")) {
      const scrubbed = scrub_static(text);
      text = scrubbed[0];
      hidden = scrubbed[1];
    }

    let _reasoning = message.reasoning_content;
    if (hidden) {
      _reasoning = (_reasoning || "") + hidden;
    }

    const out = {
      content: text,
      images,
      reasoning: _reasoning || null,
      tool_calls: LLMClient._normalize_tool_calls(message.tool_calls),
      usage,
      finish_reason: choice.finish_reason || "",
      raw,
    };

    this._telemetry.end_span(span, {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    });
    return Result.success(out);
  }

  public async *chat_stream(
    messages: any[],
    max_tokens?: number | null,
    temperature?: number | null,
    system?: string | null,
    extra: Record<string, any> = {},
  ): AsyncGenerator<Record<string, any>, void, unknown> {
    const span = this._telemetry.start_span(SpanName.LLM_REQUEST, { model: this.model_id });
    let _record_success: (() => void) | null = null;
    let _record_failure: ((code?: string) => void) | null = null;

    try {
      const [allowed, reason] = check_allowed();
      if (!allowed) {
        this._telemetry.end_span(span, { error: reason });
        yield { type: "error", error: reason, code: "CircuitOpen" };
        return;
      }
      _record_success = record_success;
      _record_failure = record_failure;
    } catch {
      // circuit breaker optional
    }

    const msgs = [...messages];
    if (system) {
      msgs.unshift({ role: "system", content: system });
    }

    const extraCopy = { ...extra };
    const abort_check = extraCopy["abort_check"];
    delete extraCopy["abort_check"];
    const effort = extraCopy["reasoning_effort"] || this.effort;
    delete extraCopy["reasoning_effort"];
    const cache_prefix = String(extraCopy["cache_prefix"] || "");
    delete extraCopy["cache_prefix"];

    if (cache_prefix.length >= CACHE_PREFIX_MIN_CHARS) {
      this._apply_cache_plan(msgs, cache_prefix);
    }
    this._backfill_reasoning_content(msgs);

    const body: Record<string, any> = {
      model: this.model_id,
      messages: msgs,
      max_tokens: max_tokens || this.max_tokens,
      temperature: temperature !== undefined && temperature !== null ? temperature : this.temperature,
      stream: true,
      ...extraCopy,
    };
    this._apply_body_plan(body, effort);

    if (!this.api_key) {
      yield { type: "error", error: "No API key configured", code: "NoApiKey" };
      this._telemetry.end_span(span, { error: "NoApiKey" });
      return;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.api_key}`,
      Accept: "text/event-stream",
    };

    const content_parts: string[] = [];
    const reasoning_parts: string[] = [];
    const scrubber = new StreamingThinkScrubber();
    const tool_acc: Record<number, { id: string; name: string; arguments: string }> = {};
    const stream_images: any[] = [];
    let finish_reason = "";
    let usage: Record<string, any> = {};

    let admission: any = null;
    let stream_result: Result | null = null;
    let aborted = false;

    try {
      admission = await this._admit(body, abort_check);
      if (admission && admission.aborted) {
        this._telemetry.end_span(span, { error: "Cancelled" });
        yield {
          type: "error",
          error: "Cancelled while queued for rate limit",
          code: "Cancelled",
        };
        return;
      }

      const fetchFn = LLM_CLIENT_SEAMS.fetch;
      if (!fetchFn) {
        const err = "fetch transport unavailable";
        stream_result = Result.failure(err, { code: "NoTransport" });
        span.set_error(err);
        this._telemetry.end_span(span, { error: err });
        yield { type: "error", error: err, code: "NoTransport" };
        return;
      }

      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      let timeoutHandle: any = null;
      if (controller && this.timeout_s > 0) {
        timeoutHandle = setTimeout(() => controller.abort(), this.timeout_s * 1000);
      }

      let resp: any;
      try {
        resp = await fetchFn(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller?.signal,
        });
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      if (resp.status !== 200) {
        let rawText = "";
        try {
          rawText = await resp.text();
        } catch {
          rawText = "";
        }
        const err = `HTTP ${resp.status}: ${rawText.slice(0, 500)}`;
        const retryHeader = resp.headers?.get?.("Retry-After") ?? resp.headers?.["retry-after"];
        const retry_after = _parse_retry_after(retryHeader);
        stream_result = Result.failure(err, { code: `HTTP${resp.status}`, retry_after });
        span.set_error(err);
        this._telemetry.end_span(span, { error: err });
        if (_record_failure) {
          _record_failure(`HTTP${resp.status}`);
        }
        yield { type: "error", error: err, code: `HTTP${resp.status}` };
        return;
      }

      // Stream processing: handles ReadableStream (web standard / fetch) or string chunks
      let buffer = "";
      let done = false;

      if (resp.body && typeof resp.body.getReader === "function") {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        while (!done) {
          if (abort_check && abort_check()) {
            aborted = true;
            try {
              await reader.cancel();
            } catch {}
            break;
          }
          const { value, done: readerDone } = await reader.read();
          if (readerDone) break;
          buffer += decoder.decode(value, { stream: true });

          while (buffer.includes("\n")) {
            const nlIdx = buffer.indexOf("\n");
            const rawLine = buffer.slice(0, nlIdx);
            buffer = buffer.slice(nlIdx + 1);
            const line = rawLine.replace(/\r$/, "").trim();
            if (!line || line.startsWith(":")) continue;
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              done = true;
              break;
            }
            let chunk: any;
            try {
              chunk = JSON.parse(data);
            } catch {
              continue;
            }
            if (chunk.usage) {
              usage = chunk.usage;
            }
            const choices = chunk.choices || [];
            if (!choices.length) continue;
            const choice = choices[0];
            finish_reason = choice.finish_reason || finish_reason;
            const delta = choice.delta || {};

            const r_piece = delta.reasoning_content || delta.reasoning;
            if (r_piece) {
              reasoning_parts.push(r_piece);
              yield { type: "reasoning", text: r_piece };
            }

            const c_piece = delta.content;
            if (c_piece) {
              if (typeof c_piece === "string") {
                const [piece_text, think_piece] = scrubber.feed(c_piece);
                if (think_piece) {
                  reasoning_parts.push(think_piece);
                  yield { type: "reasoning", text: think_piece };
                }
                if (piece_text) {
                  content_parts.push(piece_text);
                  yield { type: "content", text: piece_text };
                }
              } else {
                const piece_text = normalize_content(c_piece, stream_images);
                if (piece_text) {
                  const [v_text, think_piece] = scrubber.feed(piece_text);
                  if (think_piece) {
                    reasoning_parts.push(think_piece);
                    yield { type: "reasoning", text: think_piece };
                  }
                  if (v_text) {
                    content_parts.push(v_text);
                    yield { type: "content", text: v_text };
                  }
                }
              }
            }

            if (delta.images) {
              const [, imgs] = _extract_media({ images: delta.images });
              stream_images.push(...imgs);
            }

            for (const tc of delta.tool_calls || []) {
              const idx = tc.index ?? 0;
              if (!tool_acc[idx]) {
                tool_acc[idx] = { id: "", name: "", arguments: "" };
              }
              const slot = tool_acc[idx]!;
              if (tc.id) slot.id = tc.id;
              const fn = tc.function || {};
              if (fn.name) slot.name += fn.name;
              if (fn.arguments) slot.arguments += fn.arguments;
              yield {
                type: "tool_call_delta",
                index: idx,
                call_id: slot.id,
                name: slot.name,
                arguments_delta: fn.arguments || "",
                arguments: slot.arguments,
              };
            }
          }
        }
      } else {
        // Fallback for non-streamed or mocked text response
        const text = typeof resp.text === "function" ? await resp.text() : String(resp);
        buffer = text;
        const lines = buffer.split("\n");
        for (const rawLine of lines) {
          if (abort_check && abort_check()) {
            aborted = true;
            break;
          }
          const line = rawLine.replace(/\r$/, "").trim();
          if (!line || line.startsWith(":")) continue;
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") break;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.usage) usage = chunk.usage;
          const choices = chunk.choices || [];
          if (!choices.length) continue;
          const choice = choices[0];
          finish_reason = choice.finish_reason || finish_reason;
          const delta = choice.delta || {};
          const r_piece = delta.reasoning_content || delta.reasoning;
          if (r_piece) {
            reasoning_parts.push(r_piece);
            yield { type: "reasoning", text: r_piece };
          }
          const c_piece = delta.content;
          if (c_piece && typeof c_piece === "string") {
            const [piece_text, think_piece] = scrubber.feed(c_piece);
            if (think_piece) {
              reasoning_parts.push(think_piece);
              yield { type: "reasoning", text: think_piece };
            }
            if (piece_text) {
              content_parts.push(piece_text);
              yield { type: "content", text: piece_text };
            }
          }
        }
      }

      stream_result = Result.success({ usage });
    } catch (e: any) {
      const errName = e?.name || "";
      if (errName === "AbortError" || String(e).includes("abort") || String(e).includes("Timeout")) {
        const err = "Request timed out";
        stream_result = Result.failure(err, { code: "Timeout" });
        span.set_error(err);
        this._telemetry.end_span(span, { error: err });
        if (_record_failure) _record_failure("Timeout");
        yield { type: "error", error: err, code: "Timeout" };
        return;
      }
      const err = `Request failed: ${e}`;
      stream_result = Result.failure(err, { code: "Transport" });
      span.set_error(err);
      this._telemetry.end_span(span, { error: err });
      if (_record_failure) _record_failure("Transport");
      yield { type: "error", error: err, code: "Transport" };
      return;
    } finally {
      if (admission && !admission.aborted) {
        const final_res =
          stream_result !== null
            ? stream_result
            : Object.keys(usage).length > 0
              ? Result.success({ usage })
              : Result.failure("Stream interrupted", { code: "Interrupted" });
        this._settle_admission(admission, final_res);
      }
    }

    const raw_tool_calls: any[] = [];
    const sortedIndices = Object.keys(tool_acc)
      .map(Number)
      .sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      const slot = tool_acc[idx]!;
      raw_tool_calls.push({
        id: slot.id || `call_${idx}`,
        type: "function",
        function: {
          name: slot.name,
          arguments: slot.arguments || "{}",
        },
      });
    }

    const [_v, _r] = scrubber.flush();
    if (_r) reasoning_parts.push(_r);
    if (_v) content_parts.push(_v);

    const out = {
      content: content_parts.join(""),
      images: stream_images,
      reasoning: reasoning_parts.join("") || null,
      tool_calls: LLMClient._normalize_tool_calls(raw_tool_calls),
      usage,
      finish_reason: aborted ? "aborted" : finish_reason,
      aborted,
      raw: {},
    };

    this._telemetry.end_span(span, {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    });
    try {
      if (_record_success) _record_success();
    } catch {}
    yield { type: "done", reply: out };
  }

  public static _normalize_tool_calls(tool_calls: any): any[] {
    if (!tool_calls || !Array.isArray(tool_calls)) {
      return [];
    }
    const out: any[] = [];
    for (let idx = 0; idx < tool_calls.length; idx++) {
      const call = tool_calls[idx];
      if (!call || typeof call !== "object") continue;
      const fn = call.function || {};
      const raw_args = fn.arguments;
      let args: any;
      if (typeof raw_args === "string") {
        try {
          args = raw_args.trim() ? JSON.parse(raw_args) : {};
        } catch {
          args = { __parse_error__: raw_args };
        }
      } else if (raw_args && typeof raw_args === "object") {
        args = raw_args;
      } else {
        args = {};
      }
      out.push({
        id: call.id || `call_${idx}`,
        name: fn.name || "",
        arguments: args,
      });
    }
    return out;
  }

  public async call(prompt: any): Promise<any> {
    let user_msg: string;
    if (typeof prompt === "string") {
      user_msg = prompt;
    } else if (prompt && typeof prompt === "object") {
      user_msg = LLMClient._render_prompt(prompt);
    } else {
      user_msg = String(prompt);
    }

    const r = await this.chat([{ role: "user", content: user_msg }]);
    if (!r.ok) {
      return null;
    }
    const content = String((r.value as any)?.content || "").trim();
    if (!content) {
      return null;
    }
    return LLMClient._maybe_json(content);
  }

  public static pyJsonDumps(obj: any): string {
    if (obj === null || obj === undefined) return "null";
    if (typeof obj === "boolean") return obj ? "true" : "false";
    if (typeof obj === "number") return String(obj);
    if (typeof obj === "string") return JSON.stringify(obj);
    if (Array.isArray(obj)) {
      return "[" + obj.map(LLMClient.pyJsonDumps).join(", ") + "]";
    }
    if (typeof obj === "object") {
      const keys = Object.keys(obj);
      const pairs = keys.map((k) => `${JSON.stringify(k)}: ${LLMClient.pyJsonDumps(obj[k])}`);
      return "{" + pairs.join(", ") + "}";
    }
    return String(obj);
  }

  public static _render_prompt(prompt: Record<string, any>): string {
    const skip = new Set(["instruction", "task"]);
    const head = prompt["instruction"] || prompt["task"] || "";
    const parts: string[] = head ? [String(head)] : [];
    for (const [key, value] of Object.entries(prompt)) {
      if (
        skip.has(key) ||
        value === null ||
        value === undefined ||
        value === "" ||
        (Array.isArray(value) && value.length === 0) ||
        (typeof value === "object" && Object.keys(value).length === 0)
      ) {
        continue;
      }
      let valStr: string;
      if (typeof value === "object") {
        try {
          valStr = LLMClient.pyJsonDumps(value);
        } catch {
          valStr = String(value);
        }
      } else {
        valStr = String(value);
      }
      parts.push(`\n--- ${key} ---\n${valStr}`);
    }
    return parts.length ? parts.join("\n") : LLMClient.pyJsonDumps(prompt);
  }

  public static _maybe_json(content: string): any {
    const text = content.trim();
    let fenced = text;
    if (fenced.startsWith("```")) {
      const firstNl = fenced.indexOf("\n");
      if (firstNl !== -1) {
        fenced = fenced.slice(firstNl + 1);
      }
      if (fenced.endsWith("```")) {
        fenced = fenced.slice(0, -3);
      }
      fenced = fenced.trim();
    }
    for (const candidate of [fenced, text]) {
      try {
        return JSON.parse(candidate);
      } catch {}
    }
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (0 <= start && start < end) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {}
    }
    return content;
  }

  public _classify(r: Result): string {
    return classify_error(this._result_code(r), r.error || "");
  }

  public _result_code(r: Result): string {
    return String((r.meta && r.meta["code"]) || "");
  }

  public _is_permanent(r: Result): boolean {
    const failure = this._classify(r);
    if (failure === FAILURE_CANCELLED) {
      return true;
    }
    if (failure !== FAILURE_UNKNOWN) {
      return is_permanent_error(failure);
    }
    if (LLMClient.PERMANENT_CODES.includes(this._result_code(r))) {
      return true;
    }
    const err = r.error || "";
    return LLMClient.PERMANENT_HTTP.some((code) => err.includes(`HTTP ${code}`));
  }

  public async _post_with_retry(body: Record<string, any>, abort_check?: () => boolean): Promise<Result> {
    let last: Result | null = null;
    const delays = LLMClient.RETRY_DELAYS;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const delay = delays[attempt]!;
      const r = await this._post(body, abort_check);
      if (r.ok) {
        return r;
      }
      last = r;
      if (this._is_permanent(r)) {
        return LLMClient._stamp_failure(r);
      }
      const _cls = this._classify(last);
      try {
        const pol = policy_for_failure(_cls);
        if (attempt >= pol.max_retries) {
          break;
        }
      } catch {}

      if (attempt < delays.length - 1) {
        let _wait = delay;
        try {
          const taxonomyWait = backoff_delay_for_failure(_cls, attempt);
          _wait = Math.max(_wait, taxonomyWait);
        } catch {}
        if (LLM_CLIENT_SEAMS.sleep) {
          await LLM_CLIENT_SEAMS.sleep(_wait * 1000);
        }
      }
    }

    const exhausted = Result.failure(
      `All retries exhausted. Last error: ${last ? last.error : ""}`,
      { code: "RetriesExhausted" },
    );
    const failure = last !== null ? this._classify(last) : "";
    exhausted.meta["failure"] = failure;
    exhausted.meta["recovery"] = recovery_for(failure);

    try {
      const pol = policy_for_failure(failure);
      exhausted.meta["retry_policy"] = {
        max_retries: pol.max_retries,
        allow_fallback: pol.allow_fallback,
        backoff_base_s: pol.backoff_base_s,
      };
    } catch {}
    return exhausted;
  }

  public static _stamp_failure(r: Result): Result {
    const code = String((r.meta && r.meta["code"]) || "");
    const failure = classify_error(code, r.error || "");
    r.meta["failure"] = failure;
    r.meta["recovery"] = recovery_for(failure);
    try {
      const pol = policy_for_failure(failure);
      r.meta["retry_policy"] = {
        max_retries: pol.max_retries,
        allow_fallback: pol.allow_fallback,
        backoff_base_s: pol.backoff_base_s,
      };
    } catch {}
    return r;
  }

  public estimate_request_tokens(body: Record<string, any>): number {
    let payload = "";
    try {
      payload = LLMClient.pyJsonDumps(LLMClient._estimable(body["messages"] || []));
    } catch {
      payload = "";
    }
    const byteLen = Buffer.byteLength(payload, "utf8");
    const prompt = Math.floor(byteLen / BYTES_PER_TOKEN);
    return prompt + Number(body["max_tokens"] ?? this.max_tokens);
  }

  public static _estimable(messages: any[]): any[] {
    const stand_in = "x".repeat(Math.floor(IMAGE_TOKEN_ESTIMATE * BYTES_PER_TOKEN));
    const out: any[] = [];
    for (const m of messages) {
      const content = m && typeof m === "object" ? m.content : null;
      if (!Array.isArray(content)) {
        out.push(m);
        continue;
      }
      const parts: any[] = [];
      for (const p of content) {
        if (p && typeof p === "object" && p.type === "image_url") {
          parts.push({ type: "image_url", image_url: stand_in });
        } else {
          parts.push(p);
        }
      }
      out.push({ ...m, content: parts });
    }
    return out;
  }

  public async _admit(body: Record<string, any>, abort_check?: () => boolean): Promise<any> {
    const limiter = get_rate_limiter();
    return await limiter.acquire(this.base_url, {
      estimated_tokens: this.estimate_request_tokens(body),
      should_abort: abort_check,
    });
  }

  public _settle_admission(admission: any, result: Result): void {
    if (!admission || !admission.reserved_tokens) {
      return;
    }
    const limiter = get_rate_limiter();
    if (result.ok) {
      const usage = (result.value as any)?.usage || {};
      const actual = Number(usage.total_tokens || 0);
      limiter.settle(
        this.base_url,
        admission.reserved_tokens,
        actual > 0 ? actual : admission.reserved_tokens,
      );
      return;
    }

    if (this._classify(result) === FAILURE_RATE_LIMIT) {
      const retry_after = Number((result.meta && result.meta["retry_after"]) || 0);
      limiter.penalize(this.base_url, retry_after);
    } else {
      limiter.settle(this.base_url, admission.reserved_tokens, 0);
    }
  }

  public async _post(body: Record<string, any>, abort_check?: () => boolean): Promise<Result> {
    if (!this.api_key) {
      return Result.failure("No API key configured", { code: "NoApiKey" });
    }
    const admission = await this._admit(body, abort_check);
    if (admission && admission.aborted) {
      return Result.failure("Cancelled while queued for rate limit", { code: "Cancelled" });
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.api_key}`,
    };

    let result: Result;
    const fetchFn = LLM_CLIENT_SEAMS.fetch;
    if (!fetchFn) {
      result = Result.failure("fetch transport unavailable", { code: "NoTransport" });
      this._settle_admission(admission, result);
      return result;
    }

    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      let timeoutHandle: any = null;
      if (controller && this.timeout_s > 0) {
        timeoutHandle = setTimeout(() => controller.abort(), this.timeout_s * 1000);
      }

      let resp: any;
      try {
        resp = await fetchFn(this.endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller?.signal,
        });
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      if (resp.status !== 200) {
        let rawText = "";
        try {
          rawText = await resp.text();
        } catch {
          rawText = "";
        }
        const retryHeader = resp.headers?.get?.("Retry-After") ?? resp.headers?.["retry-after"];
        const retry_after = _parse_retry_after(retryHeader);
        result = Result.failure(`HTTP ${resp.status}: ${rawText.slice(0, 500)}`, {
          code: `HTTP${resp.status}`,
          retry_after,
        });
      } else {
        const json = await resp.json();
        result = Result.success(json);
      }
    } catch (e: any) {
      const errName = e?.name || "";
      if (errName === "AbortError" || String(e).includes("abort") || String(e).includes("Timeout")) {
        result = Result.failure("Request timed out", { code: "Timeout" });
      } else {
        result = Result.failure(`Request failed: ${e}`, { code: "Transport" });
      }
    }

    this._settle_admission(admission, result);
    return result;
  }
}

let _GLOBAL_CLIENT: LLMClient | null = null;

export function get_llm_client(config?: Record<string, any>): LLMClient {
  if (!_GLOBAL_CLIENT) {
    let finalCfg: Record<string, any> = config || {};
    if (!config) {
      const baseDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, "$1"));
      const configPath = path.join(baseDir, "..", "config.json");
      const readFn = LLM_CLIENT_SEAMS.readConfigFile;
      if (readFn) {
        const raw = readFn(configPath);
        if (raw) {
          try {
            finalCfg = JSON.parse(raw);
          } catch {
            finalCfg = {};
          }
        }
        const localPath = path.join(baseDir, "..", "config.local.json");
        const rawLocal = readFn(localPath);
        if (rawLocal) {
          try {
            const localCfg = JSON.parse(rawLocal);
            if (localCfg && typeof localCfg === "object") {
              for (const [k, v] of Object.entries(localCfg)) {
                if (v && typeof v === "object" && finalCfg[k] && typeof finalCfg[k] === "object") {
                  Object.assign(finalCfg[k], v);
                } else {
                  finalCfg[k] = v;
                }
              }
            }
          } catch {}
        }
      }
    }
    _GLOBAL_CLIENT = new LLMClient(finalCfg);
  }
  return _GLOBAL_CLIENT;
}

export function reset_llm_client(): void {
  _GLOBAL_CLIENT = null;
}

export const getLlmClient = get_llm_client;
export const resetLlmClient = reset_llm_client;
