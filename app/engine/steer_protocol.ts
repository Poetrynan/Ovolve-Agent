/**
 * steer_protocol.ts — Mid-flight Steer Queue & Prompt Formatting Protocol.
 *
 * Ported from `app/backend/steer_protocol.py` (114 lines).
 *
 * Formats mid-turn user steer messages for the agent runtime.
 *
 * RULEBOOK CITATIONS
 *   §1  零依赖。threading.Lock → 单线程 JS 事件循环下无竞争（同
 *       stream_circuit_breaker 的等价说明）。
 *   §2  `from messaging import DeliverAs, QueuedMessage`：messaging.py 是
 *       未移植单元。QueuedMessage 是纯 dataclass（无逻辑），此处按源字段
 *       形状内联构造（deliver_as="steer" 字面值已核对 messaging.py 的
 *       DeliverAs.STEER），避免为拖一个类型而整单元提前；messaging 移植后
 *       可切换为动态 import（DIVERGENCE(port)：切换仅改变 import 来源，
 *       字面值已对源核对，行为不变）。
 *   §2  Python duck-typing（hasattr(mq, "_steer")）→ 属性存在性运行时检查，
 *       与源一样容忍任意 MessageQueue 形状。
 *   §4  naming: steer_protocol.py → steer_protocol.ts
 *
 * PORT FIX (2026-09-28, evidence tmp/steer_oracle.json): CPython
 * `str.strip()` 的空白集与 V8 `String.prototype.trim()` 不一致——
 * CPython 剥 \x1c-\x1f 与 \x85、保留 \ufeff；V8 反之（oracle
 * py_strip_l/py_strip_r 逐字符实测，python -B 打印，tmp/steer_oracle.py:29-33）。
 * enqueue 的 `(text or "").strip()` 是过滤/存储的真实语义面，端口必须逐 bug
 * 对齐 CPython。CPython 镜像层单一来源（§M 消费规则）：py_strip 一律
 * `import` 自 server/http_server_keys.ts（29 码点全集，实测枚举），**不得**
 * 私有复制。旧端口 sha256_16=4a6f96ed45644ac9（本行为修复前记录）。
 *
 * PORT STATUS: confidence=high todos=0
 */

import { py_strip } from "./server/http_server_keys.js";

export interface SteerItem {
  text: string;
  source: string;
  timestamp: number;
}

export function make_steer_item(text: string, source = "user", timestamp?: number): SteerItem {
  return { text, source, timestamp: timestamp ?? Date.now() / 1000 };
}

/** messaging.QueuedMessage 的结构形状（SPLIT 依赖，字段逐字对应）。 */
interface QueuedMessageShape {
  content: string;
  deliver_as: string;
  sender: string;
  timestamp: number;
  metadata: Record<string, unknown>;
}

/** Thread-safe queue holding mid-flight steering instructions for an active turn.
 *
 * When bound to a MessageQueue, acts as a synchronous adapter delegating to
 * MessageQueue so that MessageQueue remains the single source of truth across
 * the entire runtime. */
export class SteerQueue {
  _items: SteerItem[];
  _msg_queue: Record<string, unknown> | null;

  constructor(msg_queue?: unknown) {
    this._items = [];
    this._msg_queue = null;
    if (msg_queue !== undefined && msg_queue !== null) {
      this.bind_message_queue(msg_queue);
    }
  }

  /** Bind underlying MessageQueue as the single source of truth. */
  bind_message_queue(msg_queue: unknown): void {
    this._msg_queue = msg_queue as Record<string, unknown>;
    if (this._items.length > 0 && this._msg_queue) {
      const items = [...this._items];
      this._items.length = 0;
      for (const item of items) {
        this._enqueue_to_msg_queue(item.text, item.source, item.timestamp);
      }
    }
  }

  _enqueue_to_msg_queue(text: string, source: string, ts: number): void {
    const mq = this._msg_queue;
    if (mq === null) {
      return;
    }
    const msg: QueuedMessageShape = {
      content: text,
      deliver_as: "steer" /* DeliverAs.STEER */,
      sender: source,
      timestamp: ts,
      metadata: {},
    };
    if (Array.isArray(mq["_steer"])) {
      (mq["_steer"] as unknown[]).push(msg);
      const notifier = mq["_notifier"] as { set?: () => void } | undefined;
      if (notifier && typeof notifier.set === "function") {
        notifier.set();
      }
    }
  }

  enqueue(text: string, source = "user"): void {
    const t = py_strip(text || "");
    if (!t) {
      return;
    }
    const ts = Date.now() / 1000;
    if (this._msg_queue !== null) {
      const steer = this._msg_queue["_steer"];
      if (Array.isArray(steer) && steer.length >= 30) {
        throw new ValueError("转向过多，请等待排空（当前已达高水位 30 条限制）");
      }
      this._enqueue_to_msg_queue(t, source, ts);
    } else {
      if (this._items.length >= 30) {
        throw new ValueError("转向过多，请等待排空（当前已达高水位 30 条限制）");
      }
      this._items.push(make_steer_item(t, source, ts));
    }
  }

  has_pending(): boolean {
    if (this._msg_queue !== null && Array.isArray(this._msg_queue["_steer"])) {
      return (this._msg_queue["_steer"] as unknown[]).length > 0;
    }
    return this._items.length > 0;
  }

  pending_count(): number {
    if (this._msg_queue !== null && Array.isArray(this._msg_queue["_steer"])) {
      return (this._msg_queue["_steer"] as unknown[]).length;
    }
    return this._items.length;
  }

  drain_all(): SteerItem[] {
    if (this._msg_queue !== null && Array.isArray(this._msg_queue["_steer"])) {
      const steer = this._msg_queue["_steer"] as QueuedMessageShape[];
      const drained: SteerItem[] = [];
      while (steer.length > 0) {
        const msg = steer.shift()!;
        drained.push(
          make_steer_item(
            typeof msg.content === "string" ? msg.content : "",
            typeof msg.sender === "string" ? msg.sender : "user",
            typeof msg.timestamp === "number" ? msg.timestamp : 0.0
          )
        );
      }
      return drained;
    }
    const items = [...this._items];
    this._items.length = 0;
    return items;
  }
}

/** Python ValueError 的运行时等价（engine 约定：内置异常映射保留类名）。 */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

/** Render drained steering items into a formal system nudge for the model. */
export function format_steer_prompt(steer_items: SteerItem[]): string {
  if (steer_items.length === 0) {
    return "";
  }
  const joined = steer_items.map((item) => `- ${item.text}`).join("\n");
  return (
    "[系统与用户转向提示] 用户在执行过程中补充/更新了指令，请根据最新意图立即校准并调整接下来的行动方案：\n" +
    `${joined}\n` +
    "请确认已收到用户最新调整，并继续推进。"
  );
}
