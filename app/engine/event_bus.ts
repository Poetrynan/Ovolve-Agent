/**
 * event_bus.ts — event-driven kernel core.
 *
 * Ported from `app/backend/event_bus.py` (178 lines).
 *
 * The kernel only loops: LLM -> tool -> event broadcast. Risk control,
 * anti-leakage and audit are all event subscribers. Handlers can block, cancel
 * or modify the payload.
 *
 * RULEBOOK CITATIONS
 *   §4  naming: app/backend/event_bus.py -> app/engine/event_bus.ts
 *   §2  `Enum` -> const object + union; values are a wire contract
 *   §2  `inspect.isawaitable` -> thenable check
 *   §2  module-level mutable state: the singleton is preserved
 *   §2  BUG rule: a duplicate definition in the source is reproduced as one
 *       function with the EFFECTIVE behaviour, marked below
 *
 * PORT STATUS: confidence=high todos=1
 */

export const EventAction = {
  CONTINUE: "continue",
  MODIFY: "modify",
  BLOCK: "block",
  CANCEL: "cancel",
  ASK: "ask",
} as const;

export type EventActionValue = (typeof EventAction)[keyof typeof EventAction];

/**
 * RULEBOOK §2 (`payload or {}`) — PROVENANCE for the port fix recorded in
 * `tmp/event_STATE.md` (evidence D2, printed by CPython 3.13 into
 * `tmp/event_oracle_py.json` BEFORE any assertion of this chain was written).
 *
 * `app/backend/event_bus.py:95` and `:119` build the event with `payload or {}`, which is
 * PYTHON TRUTHINESS, not a null check. Measured facts `emit_payload_face` /
 * `emit_sync_payload_face` / `emit_empty_payload_replaces_with_fresh_dict`:
 * `None`, `{}`, `[]`, `0`, `""`, `False` all come back as a FRESH `{}`
 * (`same_ref: false`, `type: "dict"`) while truthy values pass through untouched
 * (`1` -> `int 1`, `[1]` -> `list [1]`, `"0"` -> `str "0"`). Two emits handed two
 * different empty objects get two DIFFERENT substitute dicts, and a handler that writes
 * into `event.payload` therefore cannot write back into the caller's empty object
 * (fact `emit_handler_writes_payload`: `aliased: false` for `{}` and `None`,
 * `aliased: true` only for a non-empty dict).
 *
 * The previous port used `payload ?? {}`, which kept the caller's own empty object /
 * empty array / `0` / `""` / `false` as the event payload and aliased it — a visible
 * semantic divergence, not a style difference. This helper is the faithful translation
 * of `or {}`; it is not an improvement.
 */
function pythonOrEmpty(payload: unknown): Record<string, unknown> {
  if (payload === null || payload === undefined) {
    return {};
  }
  if (payload === false || payload === 0 || payload === "") {
    return {};
  }
  if (typeof payload === "object") {
    const container = payload as { length?: unknown };
    const size = Array.isArray(payload)
      ? payload.length
      : Object.keys(payload as object).length;
    if (typeof size === "number" && size === 0) {
      return {};
    }
    void container;
  }
  return payload as Record<string, unknown>;
}

/** Event object flowing through the bus. */
export class Event {
  name: string;
  payload: Record<string, unknown>;
  action: EventActionValue;
  modifiedPayload: Record<string, unknown> | null;
  blockReason: string;
  propagationStopped: boolean;

  /**
   * RULEBOOK §2 (`@dataclass field(default_factory=dict)`) — PROVENANCE for the port fix
   * recorded in `tmp/event_STATE.md` (evidence D1, same oracle run, fact
   * `event_direct_payload_falsy_face`).
   *
   * The dataclass itself does NOT coerce: `Event("x")` gets a fresh `{}` per instance
   * (`default_payload_not_shared: true`), but `Event("x", None)` stores `None`
   * (`is_none: true`) and `Event("x", {})` / `Event("x", [])` / `Event("x", 0)` store the
   * caller's own object (`same_ref: true` everywhere). Only `emit`/`emit_sync` substitute,
   * via `payload or {}` — see `pythonOrEmpty` above.
   *
   * The previous port wrote `this.payload = payload ?? {}`, which turned an explicit
   * `None`/`null` into `{}` at construction. A default parameter reproduces
   * `default_factory` exactly: only an OMITTED argument is substituted, an explicit
   * `null` is stored (JSON `null` is the only spelling of `None` in this chain, so
   * `undefined` and `null` can never be confused here).
   *
   * The declared type keeps the source's own annotation (`payload: dict`), which the
   * source itself violates at runtime by storing `None` — the annotation is preserved
   * rather than "fixed", because fixing it would be an improvement.
   */
  constructor(name: string, payload: Record<string, unknown> | null | undefined = {}) {
    this.name = name;
    this.payload = payload as Record<string, unknown>;
    this.action = EventAction.CONTINUE;
    this.modifiedPayload = null;
    this.blockReason = "";
    this.propagationStopped = false;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
  }

  block(reason = ""): void {
    this.action = EventAction.BLOCK;
    this.blockReason = reason;
    this.propagationStopped = true;
  }

  cancel(): void {
    this.action = EventAction.CANCEL;
    this.propagationStopped = true;
  }

  modify(newPayload: Record<string, unknown>): void {
    this.action = EventAction.MODIFY;
    this.modifiedPayload = newPayload;
  }

  ask(prompt = ""): void {
    this.action = EventAction.ASK;
    this.blockReason = prompt;
  }
}

/** A handler may be synchronous or return a promise. */
export type EventHandler = (event: Event) => unknown;

interface Registration {
  priority: number;
  seq: number;
  handler: EventHandler;
}

/**
 * RULEBOOK §2 (`inspect.isawaitable`): Python checks whether the handler's
 * return value is awaitable. The TS equivalent is a thenable check. A plain
 * value is ignored either way.
 */
function isThenable(v: unknown): v is Promise<unknown> {
  return (
    v !== null &&
    (typeof v === "object" || typeof v === "function") &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

export class EventBus {
  private _handlers: Map<string, Registration[]> = new Map();

  /**
   * Register a subscriber. Higher priority runs first.
   *
   * RULEBOOK §2 (sort stability): the source sorts by `(-priority, seq)`.
   * Python's sort is stable and the `seq` tiebreaker makes it deterministic
   * anyway. Reproduced with the same key.
   *
   * Note a quirk preserved from the source: `seq` is `len(handlers)` at
   * registration time, so after an `off` removes an entry a later `on` can
   * reuse an existing `seq`. Two handlers then tie on both keys and their
   * relative order is insertion order. Changing this to a monotonic counter
   * would be an improvement, and improvements are separate reviewable commits.
   */
  on(eventName: string, handler: EventHandler, priority = 0): void {
    const list = this._handlers.get(eventName) ?? [];
    const seq = list.length;
    list.push({ priority, seq, handler });
    list.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
    this._handlers.set(eventName, list);
  }

  /** Unsubscribe. */
  off(eventName: string, handler: EventHandler): void {
    const list = this._handlers.get(eventName);
    if (list) {
      this._handlers.set(
        eventName,
        list.filter((r) => r.handler !== handler)
      );
    }
  }

  /** Register a one-time subscriber. */
  once(eventName: string, handler: EventHandler, priority = 0): void {
    const wrapper: EventHandler = (event: Event) => {
      handler(event);
      this.off(eventName, wrapper);
    };
    this.on(eventName, wrapper, priority);
  }

  /** Emit an event; returns the final Event (carrying any handler modifications). */
  async emit(eventName: string, payload?: Record<string, unknown> | null): Promise<Event> {
    const event = new Event(eventName, pythonOrEmpty(payload));

    for (const reg of this._handlers.get(eventName) ?? []) {
      if (event.propagationStopped) {
        break;
      }
      const result = reg.handler(event);
      if (isThenable(result)) {
        await result;
      }
    }

    if (event.action === EventAction.MODIFY && event.modifiedPayload !== null) {
      event.payload = event.modifiedPayload;
    }
    return event;
  }

  hasHandlers(eventName: string): boolean {
    return Boolean(this._handlers.get(eventName)?.length);
  }

  // Aliases for compatibility.
  subscribe = this.on.bind(this);
  unsubscribe = this.off.bind(this);

  /**
   * Emit synchronously to subscribers.
   *
   * RULEBOOK §2 (`asyncio` mapping): the source calls `loop.create_task(result)`
   * for an awaitable handler and silently drops it when no loop is running
   * (`except RuntimeError: pass`). JS always has a microtask queue, so the
   * awaitable is scheduled rather than dropped. This is a deliberate divergence
   * and is recorded in the inventory: the Python path silently discarded the
   * coroutine (producing a "coroutine was never awaited" warning), which is a
   * defect, not a contract.
   */
  emitSync(
    eventName: string,
    payload?: Record<string, unknown> | null,
  ): Event {
    const event = new Event(eventName, pythonOrEmpty(payload));
    for (const reg of this._handlers.get(eventName) ?? []) {
      if (event.propagationStopped) {
        break;
      }
      const result = reg.handler(event);
      if (isThenable(result)) {
        // Fire and forget, matching create_task's semantics.
        void Promise.resolve(result).catch(() => {
          /* RULEBOOK §2: the source's task failure surfaces on the loop and is
             not observed by the emitter. Swallowed here for the same reason. */
        });
      }
    }
    if (event.action === EventAction.MODIFY && event.modifiedPayload !== null) {
      event.payload = event.modifiedPayload;
    }
    return event;
  }
}

// Global event bus singleton.
let _bus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (_bus === null) {
    _bus = new EventBus();
  }
  return _bus;
}

/** Reset the global event bus (for testing). */
export function resetEventBus(): void {
  _bus = new EventBus();
}

/**
 * Inject a specific bus as the global singleton (for tests / mocking).
 *
 * BUG(port): the source defines `set_event_bus` TWICE. The first definition
 * returns the installed bus; the second returns None and silently replaces the
 * first, because in Python the later binding wins. So the documented return
 * value never existed at runtime.
 *
 * Reproducing a duplicate definition is meaningless in TS. This ports the
 * EFFECTIVE behaviour — install the bus, return nothing — and the repro is the
 * two definitions at `app/backend/event_bus.py:155` and `:175`. A scan found no
 * production caller and only one test caller, which ignores the return value,
 * so the dead branch had no observable effect.
 *
 * DIVERGENCE(port): if the operator would rather have the returning form, that is a
 * one-line change and a deliberate improvement, not a fidelity fix.
 */
export function setEventBus(bus: EventBus): void {
  _bus = bus;
}
