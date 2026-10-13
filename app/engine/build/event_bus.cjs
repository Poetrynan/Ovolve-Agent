"use strict";
/**
 * event_bus.ts 鈥?event-driven kernel core.
 *
 * Ported from `app/backend/event_bus.py` (178 lines).
 *
 * The kernel only loops: LLM -> tool -> event broadcast. Risk control,
 * anti-leakage and audit are all event subscribers. Handlers can block, cancel
 * or modify the payload.
 *
 * RULEBOOK CITATIONS
 *   搂4  naming: app/backend/event_bus.py -> app/engine/event_bus.ts
 *   搂2  `Enum` -> const object + union; values are a wire contract
 *   搂2  `inspect.isawaitable` -> thenable check
 *   搂2  module-level mutable state: the singleton is preserved
 *   搂2  BUG rule: a duplicate definition in the source is reproduced as one
 *       function with the EFFECTIVE behaviour, marked below
 *
 * PORT STATUS: confidence=high todos=1
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventBus = exports.Event = exports.EventAction = void 0;
exports.getEventBus = getEventBus;
exports.resetEventBus = resetEventBus;
exports.setEventBus = setEventBus;
exports.EventAction = {
    CONTINUE: "continue",
    MODIFY: "modify",
    BLOCK: "block",
    CANCEL: "cancel",
    ASK: "ask",
};
/** Event object flowing through the bus. */
class Event {
    name;
    payload;
    action;
    modifiedPayload;
    blockReason;
    propagationStopped;
    constructor(name, payload) {
        this.name = name;
        this.payload = payload ?? {};
        this.action = exports.EventAction.CONTINUE;
        this.modifiedPayload = null;
        this.blockReason = "";
        this.propagationStopped = false;
    }
    stopPropagation() {
        this.propagationStopped = true;
    }
    block(reason = "") {
        this.action = exports.EventAction.BLOCK;
        this.blockReason = reason;
        this.propagationStopped = true;
    }
    cancel() {
        this.action = exports.EventAction.CANCEL;
        this.propagationStopped = true;
    }
    modify(newPayload) {
        this.action = exports.EventAction.MODIFY;
        this.modifiedPayload = newPayload;
    }
    ask(prompt = "") {
        this.action = exports.EventAction.ASK;
        this.blockReason = prompt;
    }
}
exports.Event = Event;
/**
 * RULEBOOK 搂2 (`inspect.isawaitable`): Python checks whether the handler's
 * return value is awaitable. The TS equivalent is a thenable check. A plain
 * value is ignored either way.
 */
function isThenable(v) {
    return (v !== null &&
        (typeof v === "object" || typeof v === "function") &&
        typeof v.then === "function");
}
class EventBus {
    _handlers = new Map();
    /**
     * Register a subscriber. Higher priority runs first.
     *
     * RULEBOOK 搂2 (sort stability): the source sorts by `(-priority, seq)`.
     * Python's sort is stable and the `seq` tiebreaker makes it deterministic
     * anyway. Reproduced with the same key.
     *
     * Note a quirk preserved from the source: `seq` is `len(handlers)` at
     * registration time, so after an `off` removes an entry a later `on` can
     * reuse an existing `seq`. Two handlers then tie on both keys and their
     * relative order is insertion order. Changing this to a monotonic counter
     * would be an improvement, and improvements are separate reviewable commits.
     */
    on(eventName, handler, priority = 0) {
        const list = this._handlers.get(eventName) ?? [];
        const seq = list.length;
        list.push({ priority, seq, handler });
        list.sort((a, b) => (b.priority - a.priority) || (a.seq - b.seq));
        this._handlers.set(eventName, list);
    }
    /** Unsubscribe. */
    off(eventName, handler) {
        const list = this._handlers.get(eventName);
        if (list) {
            this._handlers.set(eventName, list.filter((r) => r.handler !== handler));
        }
    }
    /** Register a one-time subscriber. */
    once(eventName, handler, priority = 0) {
        const wrapper = (event) => {
            handler(event);
            this.off(eventName, wrapper);
        };
        this.on(eventName, wrapper, priority);
    }
    /** Emit an event; returns the final Event (carrying any handler modifications). */
    async emit(eventName, payload) {
        const event = new Event(eventName, payload ?? {});
        for (const reg of this._handlers.get(eventName) ?? []) {
            if (event.propagationStopped) {
                break;
            }
            const result = reg.handler(event);
            if (isThenable(result)) {
                await result;
            }
        }
        if (event.action === exports.EventAction.MODIFY && event.modifiedPayload !== null) {
            event.payload = event.modifiedPayload;
        }
        return event;
    }
    hasHandlers(eventName) {
        return Boolean(this._handlers.get(eventName)?.length);
    }
    // Aliases for compatibility.
    subscribe = this.on.bind(this);
    unsubscribe = this.off.bind(this);
    /**
     * Emit synchronously to subscribers.
     *
     * RULEBOOK 搂2 (`asyncio` mapping): the source calls `loop.create_task(result)`
     * for an awaitable handler and silently drops it when no loop is running
     * (`except RuntimeError: pass`). JS always has a microtask queue, so the
     * awaitable is scheduled rather than dropped. This is a deliberate divergence
     * and is recorded in the inventory: the Python path silently discarded the
     * coroutine (producing a "coroutine was never awaited" warning), which is a
     * defect, not a contract.
     */
    emitSync(eventName, payload) {
        const event = new Event(eventName, payload ?? {});
        for (const reg of this._handlers.get(eventName) ?? []) {
            if (event.propagationStopped) {
                break;
            }
            const result = reg.handler(event);
            if (isThenable(result)) {
                // Fire and forget, matching create_task's semantics.
                void Promise.resolve(result).catch(() => {
                    /* RULEBOOK 搂2: the source's task failure surfaces on the loop and is
                       not observed by the emitter. Swallowed here for the same reason. */
                });
            }
        }
        if (event.action === exports.EventAction.MODIFY && event.modifiedPayload !== null) {
            event.payload = event.modifiedPayload;
        }
        return event;
    }
}
exports.EventBus = EventBus;
// Global event bus singleton.
let _bus = null;
function getEventBus() {
    if (_bus === null) {
        _bus = new EventBus();
    }
    return _bus;
}
/** Reset the global event bus (for testing). */
function resetEventBus() {
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
 * EFFECTIVE behaviour 鈥?install the bus, return nothing 鈥?and the repro is the
 * two definitions at `app/backend/event_bus.py:155` and `:175`. A scan found no
 * production caller and only one test caller, which ignores the return value,
 * so the dead branch had no observable effect.
 *
 * TODO(port): if the operator would rather have the returning form, that is a
 * one-line change and a deliberate improvement, not a fidelity fix.
 */
function setEventBus(bus) {
    _bus = bus;
}
