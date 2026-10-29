/**
 * http_server_runtime.ts — production bindings behind the WebSocket segment.
 *
 * `http_server_s1.ts` is the socket session loop; every subsystem it touches
 * sits behind `HttpS1Seams`. The defaults in that file are deliberately inert
 * (each getter throws `ModuleNotFoundErrorP`) so the segment stays exercisable
 * without a server. This module supplies the live table:
 *
 *   • `websocket_response` binds to the native RFC 6455 channel that
 *     `handleNativeWebSocketUpgrade` builds for each upgrade request;
 *   • `create_task` / `asyncio_wait` / `asyncio_sleep` give the loop the subset
 *     of `asyncio` semantics it actually relies on (see the task runtime below);
 *   • everything else forwards to the engine singleton that owns the state.
 *
 * Convention note: the segment was ported against Python keyword calls
 * (`storage.get_messages(sid, limit=…)`), while the native modules expose the
 * same parameters positionally. The adapters here translate, so the ported
 * call sites can stay as they are.
 */

import * as crypto from "node:crypto";

import {
  HTTP_S1_SEAMS,
  PyCancelledErrorP,
  PyJsonDecodeErrorP,
} from "./http_server_s1.js";
import type {
  AskUserStoreApi,
  HttpS1Seams,
  PyTask,
  SnapshotStoreApi,
  TurnStateApi,
  TurnStatusTokens,
  WebSocketResponseApi,
  WsMessage,
} from "./http_server_s1.js";
import type { AskUserStore } from "../ask_user.js";
import type { SnapshotStore } from "../snapshot_store.js";
import type { TurnStateMachine, TurnStatus } from "../turn_state.js";

/* ══════════════════════════════════════════════════════════════════════════
 * §1 native websocket channel
 * ═══════════════════════════════════════════════════════════════════════ */

/** Key under which the upgrade handler parks its frame adapter on the request. */
export const NATIVE_WS_CHANNEL: unique symbol = Symbol("ovolve.ws.native-channel");

/** The `clientAdapter` shape built in `handleNativeWebSocketUpgrade`. */
interface NativeChannel {
  prepare(request: unknown): Promise<void>;
  send_json(data: unknown): Promise<void>;
  messages(): AsyncIterable<WsMessage>;
  exception(): unknown;
}

/**
 * `web.WebSocketResponse` for the ported loop. Holds no socket of its own —
 * `prepare(request)` binds it to the channel parked on that request, so the
 * handler object the segment keys its per-socket maps on is a plain, stable
 * JS object and every write lands on the real connection.
 */
class NativeWebSocketResponse implements WebSocketResponseApi {
  private channel: NativeChannel | null = null;

  async prepare(request: unknown): Promise<void> {
    const holder = request as { [NATIVE_WS_CHANNEL]?: unknown } | null;
    const channel = holder?.[NATIVE_WS_CHANNEL];
    if (!channel) {
      throw new Error("native websocket channel is not attached to this upgrade request");
    }
    this.channel = channel as NativeChannel;
  }

  private bound(): NativeChannel {
    if (this.channel === null) throw new Error("websocket used before prepare()");
    return this.channel;
  }

  send_json(data: unknown): Promise<void> {
    return this.bound().send_json(data);
  }

  messages(): AsyncIterable<WsMessage> {
    return this.bound().messages();
  }

  exception(): unknown {
    return this.bound().exception();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * §2 asyncio task runtime
 *
 * `create_task` receives a promise that has already started, so cancellation
 * cannot be injected into arbitrary awaits the way CPython does it. What the
 * segment actually relies on is narrower: a task parked in one of *our* waits
 * (`asyncio_sleep` / `asyncio_wait`) must learn it was cancelled. Those waits
 * register themselves during the coroutine's synchronous prefix — the code
 * that runs before the first `await` suspends — and the task created right
 * after that prefix claims them.
 * ═══════════════════════════════════════════════════════════════════════ */

interface PendingWait {
  cancel(): void;
}

let pendingWaits: PendingWait[] = [];

class NativeTask implements PyTask {
  private settled = false;
  private cancelRequested = false;
  private readonly waits: PendingWait[];
  private readonly callbacks: Array<(task: PyTask) => void> = [];

  constructor(coro: Promise<unknown>) {
    this.waits = pendingWaits;
    pendingWaits = [];
    void coro.then(
      () => this.finish(),
      (exc) => {
        this.finish();
        if (!(exc instanceof PyCancelledErrorP)) {
          // Python logs an unretrieved task exception; this is the same signal.
          console.error("[ws] background task failed:", exc);
        }
      },
    );
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    for (const cb of this.callbacks.splice(0)) {
      try {
        cb(this);
      } catch (exc) {
        console.error("[ws] done callback failed:", exc);
      }
    }
  }

  done(): boolean {
    return this.settled;
  }

  cancelled(): boolean {
    return this.cancelRequested;
  }

  cancel(): boolean {
    if (this.settled) return false;
    this.cancelRequested = true;
    for (const wait of this.waits.splice(0)) {
      try {
        wait.cancel();
      } catch {
        // the wait already settled; nothing to interrupt
      }
    }
    return true;
  }

  add_done_callback(callback: (task: PyTask) => void): void {
    if (this.settled) {
      queueMicrotask(() => callback(this));
      return;
    }
    this.callbacks.push(callback);
  }
}

function asyncio_sleep(seconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectSleep: ((exc: Error) => void) | null = null;
  const promise = new Promise<void>((resolve, reject) => {
    rejectSleep = reject;
    const ms = Math.max(0, Number(seconds) || 0) * 1000;
    timer = setTimeout(() => {
      timer = null;
      resolve();
    }, ms);
  });
  pendingWaits.push({
    cancel: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      rejectSleep?.(new PyCancelledErrorP());
    },
  });
  return promise;
}

/** `asyncio.wait(tasks, timeout=…)`: returns on timeout instead of throwing. */
function asyncio_wait(tasks: readonly PyTask[], timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const allDone = (): boolean => tasks.every((task) => task.done());
    const settle = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve();
    };
    const poll = (): void => {
      if (finished) return;
      if (allDone()) {
        settle();
        return;
      }
      setTimeout(poll, 20);
    };
    const timer = setTimeout(settle, Math.max(0, Number(timeout) || 0) * 1000);
    poll();
    pendingWaits.push({
      cancel: () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        reject(new PyCancelledErrorP());
      },
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * §3 subsystem adapters
 * ═══════════════════════════════════════════════════════════════════════ */

function json_loads(text: unknown): unknown {
  if (typeof text !== "string") {
    throw new PyJsonDecodeErrorP(
      `the JSON object must be str, not '${text === null ? "NoneType" : typeof text}'`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (exc) {
    throw new PyJsonDecodeErrorP(exc instanceof Error ? exc.message : String(exc));
  }
}

function uuid4_hex8(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function asTurnStateApi(machine: TurnStateMachine): TurnStateApi {
  return {
    note_phase: (sid, phase) => machine.note_phase(String(sid), String(phase)),
    snapshot: (sid) => machine.snapshot(String(sid)),
    current: (sid) => machine.current(String(sid)),
    transition: (sid, status, substatus, force) =>
      machine.transition(
        String(sid),
        status as TurnStatus,
        typeof substatus === "string" ? substatus : "",
        { force: Boolean(force) },
      ),
  };
}

function asAskUserStore(store: AskUserStore): AskUserStoreApi {
  return {
    pending_for: (sid) => store.pending_for(String(sid)),
    snapshot: (sid) => store.snapshot(String(sid)),
    resolve: (sid, opts) =>
      store.resolve(
        String(sid),
        String(opts.call_id ?? ""),
        opts.answers ?? null,
        Boolean(opts.skipped),
      ),
  };
}

function asSnapshotStore(store: SnapshotStore): SnapshotStoreApi {
  return {
    copy_to_session: (src, dst, branchPoint) =>
      store.copy_to_session(String(src), String(dst), Number(branchPoint)),
    rollback_since: (sid, seq) => store.rollback_since(String(sid), Number(seq)),
    discard_since: (sid, seq) => store.discard_since(String(sid), Number(seq)),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * §4 the table
 * ═══════════════════════════════════════════════════════════════════════ */

const RUNTIME_LOOP = Object.freeze({ kind: "node-event-loop" });

export async function createProductionSeams(): Promise<HttpS1Seams> {
  const [
    sessionHostModule,
    turnStateModule,
    askUserModule,
    planArtifactModule,
    snapshotStoreModule,
    terminalModule,
    messagingModule,
    tokenAnalyticsModule,
    riskControlModule,
    executorsModule,
  ] = await Promise.all([
    import("../session_host.js"),
    import("../turn_state.js"),
    import("../ask_user.js"),
    import("../plan_artifact.js"),
    import("../snapshot_store.js"),
    import("../persistent_terminal.js"),
    import("../messaging.js"),
    import("../token_analytics.js"),
    import("../risk_control.js"),
    import("../executors.js"),
  ]);

  return {
    ...HTTP_S1_SEAMS,
    websocket_response: () => new NativeWebSocketResponse(),
    json_loads,
    get_running_loop: () => RUNTIME_LOOP,
    create_task: (coro) => new NativeTask(coro),
    asyncio_wait,
    asyncio_sleep,
    pending_run_grace: () => sessionHostModule.PENDING_RUN_GRACE,
    uuid4_hex8,
    py_print: (text) => console.log(text),
    cancel_call: (callId) => executorsModule.cancelCall(String(callId)),
    get_turn_state: () => asTurnStateApi(turnStateModule.get_turn_state()),
    turn_status: (): TurnStatusTokens => turnStateModule.TurnStatus,
    get_ask_user_store: () => asAskUserStore(askUserModule.get_ask_user_store()),
    ask_user_has_waiter: (callId) => askUserModule.has_waiter(String(callId)),
    ask_user_deliver_answer: (callId, answers, skipped) =>
      askUserModule.deliver_answer(String(callId), answers ?? null, Boolean(skipped)),
    get_plan_artifact: (planId) => planArtifactModule.get_plan_artifact(planId),
    approve_plan_artifact: (planId, opts) =>
      planArtifactModule.approve_plan_artifact(planId, opts.approved_with),
    discard_plan_artifact: (planId) => planArtifactModule.discard_plan_artifact(planId),
    get_snapshot_store: () => asSnapshotStore(snapshotStoreModule.get_snapshot_store()),
    get_terminal_manager: () => ({
      close: (sid) => terminalModule.get_terminal_manager().close(String(sid)),
    }),
    deliver_as_steer: () => messagingModule.DeliverAs.STEER,
    get_token_analytics: () => ({
      reset_session: (opts) => tokenAnalyticsModule.get_token_analytics().reset_session(opts),
    }),
    coerce_permission: (value) => riskControlModule.coerce_permission(value),
    traceback_print_exc: () => {
      console.error("[ws] turn failed\n" + (new Error("turn failure").stack ?? ""));
    },
  };
}
