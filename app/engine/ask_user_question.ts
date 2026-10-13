/**
 * ask_user_question.ts — 结构化决策模态卡片交互系统
 *
 * Ported from `app/backend/ask_user_question.py` (sha256/line count recorded in
 * `D:/ovolve-migration/tmp/asku_oracle_facts.json` meta; the source is READ-ONLY).
 * This revision was aligned face-by-face to pinned-CPython evidence:
 * `D:/ovolve-migration/tmp/asku_oracle_facts.json` + `tmp/asku_STATE.md`; the
 * case-level differential lives in `tmp/asku_facts_{py,ts}.json`.
 *
 * When the AI hits an architecture decision, multi-option selection, or an
 * uncertain key parameter, the ask_user_question tool suspends the task and
 * pushes a structured decision card to the frontend. The frontend pops a
 * single/multi-select modal with recommended options for one-click answers.
 *
 * EVIDENCE → BEHAVIOR MAP (face ids are keys of asku_oracle_facts.json):
 *  · c_* faces — `o.get(key, default)` semantics are `py_dict_get` (§M):
 *    key-present-with-None stays None (raw), missing key returns the default,
 *    a non-dict receiver raises the exact CPython AttributeError. Field values
 *    are stored RAW (no String()/Boolean() coercion); `is_recommended` alone is
 *    wrapped by `py_truth` (NaN is True, "" / {} / [] are False).
 *  · c_empty_obj / c_dict_repr_label — the missing-label default is `str(o)`,
 *    i.e. the CPython dict repr with quote flipping (`py_str` → `py_repr`).
 *  · c_bad_* / c_item_* — non-iterable options raise the CPython
 *    `'<t>' object is not iterable` TypeError; non-dict items raise
 *    `'<t>' object has no attribute 'get'` at the item where it happens.
 *  · a_* faces — binding errors are mirrored synchronously with the exact
 *    3.13 wording incl. the qualified names (see ASKU_QN_* below).
 *  · w_* faces — `asyncio.wait_for` semantics: the coroutine body of
 *    wait_for_answer does not run until the caller yields (Python coroutines
 *    start at await, not at call) → the port defers its body to a microtask;
 *    timeout<=0 with a fresh future cancels and reports the timeout triple;
 *    timeout=None waits without deadline; `_futures[question_id]` is
 *    overwritten by the latest waiter; `submit_answer` stores the caller's
 *    list BY REFERENCE and the resolved dict aliases it.
 *  · h_* / l_* faces — handler returns raw fields (`title`, `options[i].id`,
 *    ...), the `timeout` argument is never used; list_pending filters on
 *    status == "pending" preserving dict insertion order.
 *
 * RULEBOOK CITATIONS
 *   §1  node: builtins only (node:crypto for uuid); no ports, no sockets.
 *   §M  shared CPython mirror layer `./server/http_server_keys.js` is the ONLY
 *       source for py_dict_get/py_truth/py_str/py_type_name/PyTypeErrorP —
 *       no private copies.
 *   §2  naming: ask_user_question.py → ask_user_question.ts
 *   §4  PORT STATUS maintained by the wave convention (below).
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";

import {
  PyTypeErrorP,
  py_dict_get,
  py_iter,
  py_str,
  py_truth,
  py_type_name,
} from "./server/http_server_keys.js";

/*
 * CPython 3.13 binding-error wordings (facts a_* of asku_oracle_facts.json).
 * The qualnames below are the exact prefixes CPython prints for these
 * functions; the rest of the sentence is assembled by the three helpers.
 * Bound methods count `self` in the "given" total: given = argc + 1
 * (a_cq_6/a_cq_7, a_wf_3, a_sa_4, a_gp_2, a_lp_1); module-level functions
 * do not (a_h_7, a_gqr_1).
 */
const ASKU_QN_CTOR = "QuestionRegistry.__init__";
const ASKU_QN_CREATE = "QuestionRegistry.create_question";
const ASKU_QN_WAIT = "QuestionRegistry.wait_for_answer";
const ASKU_QN_SUBMIT = "QuestionRegistry.submit_answer";
const ASKU_QN_GET = "QuestionRegistry.get_pending";
const ASKU_QN_LIST = "QuestionRegistry.list_pending";
const ASKU_QN_HANDLER = "ask_user_question_handler";
const ASKU_QN_GQR = "get_question_registry";

/** `f() missing N required positional argument(s): 'a', 'b', and 'c'`. */
function asku_py_missing(fname: string, names: readonly string[]): PyTypeErrorP {
  const q = names.map((s) => `'${s}'`);
  const list = q.length === 1
    ? (q[0] as string)
    : q.length === 2
      ? `${q[0]} and ${q[1]}`
      : q.slice(0, -1).join(", ") + ", and " + q[q.length - 1];
  const plural = names.length === 1 ? "positional argument" : "positional arguments";
  return new PyTypeErrorP(`${fname}() missing ${names.length} required ${plural}: ${list}`);
}

/** `f() takes from X to Y positional arguments but Z were given`. */
function asku_py_too_many_range(fname: string, lo: number, hi: number, given: number): PyTypeErrorP {
  const verb = given === 1 ? "was" : "were";
  return new PyTypeErrorP(
    `${fname}() takes from ${lo} to ${hi} positional arguments but ${given} ${verb} given`,
  );
}

/** `f() takes N positional argument(s) but Z were given` (flat count, N may be 0). */
function asku_py_takes_exact(fname: string, n: number, given: number): PyTypeErrorP {
  const noun = n === 1 ? "positional argument" : "positional arguments";
  const verb = given === 1 ? "was" : "were";
  return new PyTypeErrorP(`${fname}() takes ${n} ${noun} but ${given} ${verb} given`);
}

export interface QuestionOption {
  id: string;
  label: string;
  description: string;
  is_recommended: boolean;
  preview_snippet: string;
}

export interface UserQuestionPayload {
  question_id: string;
  title: string;
  description: string;
  options: QuestionOption[];
  allow_multiple: boolean;
  allow_custom_input: boolean;
  /** "pending" | "answered" | "cancelled" */
  status: string;
  selected_options: string[];
  custom_input: string;
}

/** The port's managed Future: `asyncio.Future` + its `done()` + wait_for timer. */
interface PendingFuture {
  resolve: (value: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout> | null;
  done: boolean;
}

export class QuestionRegistry {
  /** 内存中的提问挂起与异步应答注册表 */
  private _pending = new Map<string, UserQuestionPayload>();
  private _futures = new Map<string, PendingFuture>();

  constructor(...args: unknown[]) {
    if (args.length > 0) {
      // `QuestionRegistry(x)` -> `QuestionRegistry.__init__() takes 1
      // positional argument but 2 were given` (self counted; fact a_ctor_1).
      throw asku_py_takes_exact(ASKU_QN_CTOR, 1, args.length + 1);
    }
  }

  create_question(
    title: string,
    description: string,
    options: Array<Record<string, unknown>>,
    allow_multiple = false,
    allow_custom_input = true
  ): UserQuestionPayload {
    const argc = arguments.length;
    if (argc < 3) {
      throw asku_py_missing(ASKU_QN_CREATE, ["title", "description", "options"].slice(argc));
    }
    if (argc > 5) {
      // Bound method: `takes from 4 to 6 positional arguments but <argc+1>
      // were given` (facts a_cq_6 / a_cq_7).
      throw asku_py_too_many_range(ASKU_QN_CREATE, 4, 6, argc + 1);
    }
    const qid = `q-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    // `for i, o in enumerate(options)`: options is iterated with CPython rules
    // (str -> chars, dict -> keys, non-iterable -> exact TypeError).
    const items = py_iter(options as unknown);
    const opts: QuestionOption[] = items.map((o, i) => ({
      // Field semantics are `o.get(key, default)` with RAW values preserved
      // (CPython dataclasses never coerce); only is_recommended wraps bool().
      id: py_dict_get(o, "id", `opt-${i}`),
      label: py_dict_get(o, "label", py_str(o)),
      description: py_dict_get(o, "description", ""),
      is_recommended: py_truth(py_dict_get(o, "is_recommended", false)),
      preview_snippet: py_dict_get(o, "preview_snippet", ""),
    }) as unknown as QuestionOption);
    const payload: UserQuestionPayload = {
      question_id: qid,
      title,
      description,
      options: opts,
      allow_multiple,
      allow_custom_input,
      status: "pending",
      selected_options: [],
      custom_input: "",
    };
    this._pending.set(qid, payload);
    return payload;
  }

  /**
   * 异步等待用户从前端点击提交答案
   *
   * Python coroutines start at `await`, not at call: binding errors raise
   * synchronously (guards below), but every side effect of the body happens
   * only when the caller yields — mirrored by deferring the body to a
   * microtask. `asyncio.wait_for(fut, timeout)` details: a `timeout<=0`
   * cancels the fresh future and reports the timeout triple immediately;
   * `timeout=None` waits without a deadline; a non-numeric timeout hits the
   * `<= 0` comparison and raises TypeError (`timeouts.py`).
   */
  wait_for_answer(
    question_id: string,
    timeout: number | null = 300.0
  ): Promise<Record<string, unknown>> {
    const argc = arguments.length;
    if (argc < 1) {
      throw asku_py_missing(ASKU_QN_WAIT, ["question_id"]);
    }
    if (argc > 2) {
      // Bound method self-counts: `takes from 2 to 3 positional arguments but
      // <argc+1> were given` (fact a_wf_3).
      throw asku_py_too_many_range(ASKU_QN_WAIT, 2, 3, argc + 1);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      queueMicrotask(() => {
        try {
          const entry: PendingFuture = { resolve: (v) => resolve(v), timer: null, done: false };
          // `self._futures[question_id] = fut` — overwrites a previous waiter.
          this._futures.set(question_id, entry);
          const fire = (): void => {
            if (entry.done) return;
            entry.done = true;
            const pending = this._pending.get(question_id);
            if (pending) {
              pending.status = "cancelled";
            }
            entry.resolve({ status: "timeout", selected: [], custom: "" });
          };
          const t: unknown = timeout;
          if (t === null || t === undefined) {
            // `asyncio.wait_for(fut, None)` — wait indefinitely.
          } else if (typeof t !== "number" && typeof t !== "boolean") {
            throw new PyTypeErrorP(
              `'<=' not supported between instances of '${py_type_name(t)}' and 'int'`
            );
          } else if ((t as number) <= 0) {
            // CPython wait_for: timeout<=0 + future not done -> cancel + TimeoutError.
            fire();
          } else {
            entry.timer = setTimeout(fire, (t as number) * 1000);
          }
        } catch (e) {
          reject(e);
        }
      });
    }).finally(() => {
      // `finally: self._futures.pop(question_id, None)`
      const entry = this._futures.get(question_id);
      if (entry && entry.timer) {
        clearTimeout(entry.timer);
      }
      this._futures.delete(question_id);
    });
  }

  /** 前端通过 HTTP API 提交用户的选择 */
  submit_answer(
    question_id: string,
    selected_options: string[],
    custom_input = ""
  ): boolean {
    const argc = arguments.length;
    if (argc < 2) {
      throw asku_py_missing(ASKU_QN_SUBMIT, ["question_id", "selected_options"].slice(argc));
    }
    if (argc > 3) {
      // Bound method self-counts: `takes from 3 to 4 positional arguments but
      // <argc+1> were given` (fact a_sa_4).
      throw asku_py_too_many_range(ASKU_QN_SUBMIT, 3, 4, argc + 1);
    }
    const payload = this._pending.get(question_id);
    if (payload === undefined) {
      return false;
    }
    payload.status = "answered";
    // BY REFERENCE: CPython assigns the caller's list; later mutations of the
    // caller's list are visible in the payload and in the resolved triple.
    payload.selected_options = selected_options;
    payload.custom_input = custom_input;

    const fut = this._futures.get(question_id);
    if (fut && !fut.done) {
      fut.done = true;
      if (fut.timer) {
        clearTimeout(fut.timer);
      }
      fut.resolve({
        status: "answered",
        question_id,
        selected: selected_options,
        custom: custom_input,
      });
    }
    return true;
  }

  get_pending(question_id: string): UserQuestionPayload | null {
    const argc = arguments.length;
    if (argc < 1) {
      throw asku_py_missing(ASKU_QN_GET, ["question_id"]);
    }
    if (argc > 1) {
      // Bound method self-counts: `get_pending() takes 2 positional arguments
      // but <argc+1> were given` (fact a_gp_2).
      throw asku_py_takes_exact(ASKU_QN_GET, 2, argc + 1);
    }
    const p = this._pending.get(question_id);
    return p === undefined ? null : p;
  }

  list_pending(): UserQuestionPayload[] {
    const argc = arguments.length;
    if (argc > 0) {
      // Bound method self-counts: `list_pending() takes 1 positional argument
      // but <argc+1> were given` (fact a_lp_1).
      throw asku_py_takes_exact(ASKU_QN_LIST, 1, argc + 1);
    }
    return Array.from(this._pending.values()).filter((p) => p.status === "pending");
  }
}

let _GLOBAL_QUESTION_REGISTRY: QuestionRegistry | null = null;

export function get_question_registry(): QuestionRegistry {
  if (arguments.length > 0) {
    throw asku_py_takes_exact(ASKU_QN_GQR, 0, arguments.length);
  }
  if (_GLOBAL_QUESTION_REGISTRY === null) {
    _GLOBAL_QUESTION_REGISTRY = new QuestionRegistry();
  }
  return _GLOBAL_QUESTION_REGISTRY;
}

/**
 * ask_user_question 工具运行时处理入口
 *
 * Like the Python coroutine, nothing runs (and no question is registered)
 * until the returned promise is awaited: the body is deferred to a microtask.
 * `timeout` is accepted for signature parity and never used (fact h_timeout_unused).
 */
export function ask_user_question_handler(
  title: string,
  description: string,
  options: Array<Record<string, unknown>>,
  allow_multiple = false,
  allow_custom_input = true,
  timeout = 180.0
): Promise<Record<string, unknown>> {
  const argc = arguments.length;
  if (argc < 3) {
    throw asku_py_missing(ASKU_QN_HANDLER, ["title", "description", "options"].slice(argc));
  }
  if (argc > 6) {
    throw asku_py_too_many_range(ASKU_QN_HANDLER, 3, 6, argc);
  }
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    queueMicrotask(() => {
      try {
        const registry = get_question_registry();
        const q = registry.create_question(
          title,
          description,
          options,
          allow_multiple,
          allow_custom_input
        );
        void timeout;
        // 在非交互环境或直接调用时，默认推荐项返回
        resolve({
          status: "question_created",
          question_id: q.question_id,
          title: q.title,
          options_count: q.options.length,
          options: q.options.map((o) => ({
            id: o.id,
            label: o.label,
            is_recommended: o.is_recommended,
          })),
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}
