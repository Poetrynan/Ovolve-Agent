/**
 * telemetry.ts — 遥测契约化 (TS port).
 *
 * schema 定义 span 名与属性（含 sensitive/cardinality 元数据）。
 * 本地 JSONL / 环形缓冲。
 *
 * PORT STATUS: confidence=high todos=0
 */

export enum SpanName {
  TOOL_CALL = "tool_call",
  TOOL_RESULT = "tool_result",
  LLM_REQUEST = "llm_request",
  LLM_RESPONSE = "llm_response",
  AGENT_DISPATCH = "agent_dispatch",
  SKILL_LOAD = "skill_load",
  RISK_CHECK = "risk_check",
  OUTPUT_GUARD = "output_guard",
  GOAL_ITERATION = "goal_iteration",
  CRON_EXECUTE = "cron_execute",
  BOT_MESSAGE = "bot_message",
  MEMORY_EXTRACT = "memory_extract",
  MEMORY_RECALL = "memory_recall",
  SESSION_START = "session_start",
  SESSION_COMPACT = "session_compact",
  CONTRACT_ENFORCE = "contract_enforce",
  SUBAGENT_QUARANTINE = "subagent_quarantine",
}

export const ATTRIBUTE_METADATA: Record<string, { sensitive: boolean; high_cardinality: boolean }> = {
  tool_name: { sensitive: false, high_cardinality: true },
  tool_args: { sensitive: true, high_cardinality: true },
  tool_result: { sensitive: true, high_cardinality: true },
  error: { sensitive: false, high_cardinality: true },
  duration_ms: { sensitive: false, high_cardinality: true },
  session_id: { sensitive: true, high_cardinality: true },
  user_id: { sensitive: true, high_cardinality: true },
  agent_name: { sensitive: false, high_cardinality: false },
  risk_level: { sensitive: false, high_cardinality: false },
  model_name: { sensitive: false, high_cardinality: false },
  input_tokens: { sensitive: false, high_cardinality: true },
  output_tokens: { sensitive: false, high_cardinality: true },
};

export class Span {
  public name: string;
  public startTime: number;
  public endTime: number = 0;
  public attributes: Record<string, any>;
  public events: Array<{ name: string; time: number; attrs: Record<string, any> }> = [];
  public status: "ok" | "error" = "ok";
  public errorMessage: string = "";

  constructor(name: string, startTime: number, attributes: Record<string, any> = {}) {
    this.name = name;
    this.startTime = startTime;
    this.attributes = { ...attributes };
  }

  public get durationMs(): number {
    return this.endTime ? (this.endTime - this.startTime) * 1000 : 0;
  }

  public addEvent(name: string, attrs: Record<string, any> = {}): void {
    this.events.push({ name, time: Date.now() / 1000, attrs });
  }

  public setError(message: string): void {
    this.status = "error";
    this.errorMessage = message;
  }

  public set_error(message: string): void {
    this.setError(message);
  }

  public toDict(verbose: boolean = false): Record<string, any> {
    return {
      name: this.name,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.durationMs,
      attributes: this._redactAttributes(verbose),
      status: this.status,
      errorMessage: this.errorMessage,
    };
  }

  private _redactAttributes(verbose: boolean = false): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [key, val] of Object.entries(this.attributes)) {
      const meta = ATTRIBUTE_METADATA[key];
      if (meta?.sensitive && val !== null && val !== undefined && !verbose) {
        continue;
      }
      out[key] = val;
    }
    return out;
  }
}

export const MAX_BUFFERED_SPANS = 2000;
export const MAX_OPEN_SPANS = 64;

export class Telemetry {
  public enabled: boolean;
  public exporter?: (data: Record<string, any>) => void;
  public verbose: boolean;
  private _spans: Span[] = [];
  private _current: Span[] = [];
  private _maxSpans: number;

  constructor(
    enabled: boolean = true,
    exporter?: (data: Record<string, any>) => void,
    verbose: boolean = false,
    maxSpans: number = MAX_BUFFERED_SPANS,
  ) {
    this.enabled = enabled;
    this.exporter = exporter;
    this.verbose = verbose;
    this._maxSpans = Math.max(1, maxSpans);
  }

  public start_span(name: SpanName | string, attributes: Record<string, any> = {}): Span {
    if (!this.enabled) {
      return new Span(String(name), 0);
    }
    const spanName = typeof name === "string" ? name : name;
    const span = new Span(spanName, Date.now() / 1000, attributes);
    this._current.push(span);
    if (this._current.length > MAX_OPEN_SPANS) {
      this._current.shift();
    }
    return span;
  }

  public end_span(span: Span, extraAttrs: Record<string, any> = {}): void {
    if (!this.enabled || span.startTime === 0) {
      return;
    }
    span.endTime = Date.now() / 1000;
    Object.assign(span.attributes, extraAttrs);
    const idx = this._current.indexOf(span);
    if (idx !== -1) {
      this._current.splice(idx, 1);
    }
    this._spans.push(span);
    if (this._spans.length > this._maxSpans) {
      this._spans.shift();
    }
    this._export(span);
  }

  public record(name: SpanName | string, durationMs: number = 0, attributes: Record<string, any> = {}): void {
    if (!this.enabled) return;
    const now = Date.now() / 1000;
    const span = new Span(
      typeof name === "string" ? name : name,
      now - durationMs / 1000,
      attributes,
    );
    span.endTime = now;
    this._spans.push(span);
    if (this._spans.length > this._maxSpans) {
      this._spans.shift();
    }
    this._export(span);
  }

  private _export(span: Span): void {
    if (!this.exporter) return;
    try {
      this.exporter(span.toDict(this.verbose));
    } catch {
      // telemetry fail-open
    }
  }
}

let _GLOBAL_TELEMETRY: Telemetry | null = null;

export function get_telemetry(): Telemetry {
  if (!_GLOBAL_TELEMETRY) {
    const isOff = process.env["OVOLVE_TELEMETRY_OFF"] === "1";
    const isVerbose = process.env["OVOLVE_TELEMETRY_VERBOSE"] === "1";
    _GLOBAL_TELEMETRY = new Telemetry(!isOff, undefined, isVerbose);
  }
  return _GLOBAL_TELEMETRY;
}

export const getTelemetry = get_telemetry;
