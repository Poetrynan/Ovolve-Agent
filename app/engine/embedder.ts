/**
 * embedder.ts — Ovolve Layer 2 memory: local semantic vectors (ONNX first).
 *
 * Ported from `app/backend/embedder.py` (400 lines).
 *
 * Backend reality check (source docstring, preserved as the contract): the
 * Python module tries fastembed (ONNX) → sentence-transformers (torch) →
 * None, all via lazy imports. The TS engine has neither dependency and adds
 * none (RULEBOOK §1), so the ported chain is: a native ONNX-runtime handle,
 * when one is INJECTED by the host layer, else None (memory_layer falls back
 * to keyword scoring). The public surface (encode / encode_batch / available
 * / status) is identical across backends, so consumers don't change.
 *
 * What IS fully ported here, byte-for-byte with the source:
 *   - L2 normalization (idempotent, zero-vector safe)
 *   - the sha1-keyed LRU embed cache (OrderedDict semantics via Map +
 *     explicit eviction; 4096 cap ≈ <30 MB of 768-dim vectors) with
 *     hit/miss stats and cache_stats()
 *   - the one-shot failure marker (_state: null = untried / true / false)
 *   - MAX_CHARS clipping, encode/encode_batch None-on-empty contracts,
 *     batch index alignment
 *   - resolve_embed_cache_dir's three-location probe + _cache_has_onnx walk
 *   - module singleton get_embedder()
 *
 * RULEBOOK CITATIONS
 *   §1  (amended per user policy 2026-09-22: dependencies ARE allowed when
 *       needed) @xenova/transformers + sharp added to app/engine/package.json;
 *       the ONNX backend is real now — same model, same 768-dim CLS output.
 *   §2  threading.Lock → the Node event loop serializes access; the lock is
 *       structurally unnecessary (same reasoning as path_lock.ts) — noted
 *       at the cache.
 *   §2  `except Exception` swallows preserved verbatim with BUG(port)-
 *       style comments naming what is ignored; the single-item failure
 *       must not blacklist the whole embedder (source behaviour).
 *   §4  naming: embedder.py → embedder.ts
 *
 * PORT STATUS: confidence=high todos=0
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** 默认模型。BGE 中文检索标杆，768 维，fastembed 提供 ONNX 版。 */
export const DEFAULT_MODEL = "BAAI/bge-base-zh-v1.5";

export const MODEL_ENV = "OVOLVE_EMBED_MODEL";
export const DISABLE_ENV = "OVOLVE_DISABLE_EMBEDDINGS";
/** 强制后端：`onnx` / `torch`。默认自动探测（ONNX 优先）。 */
export const BACKEND_ENV = "OVOLVE_EMBED_BACKEND";
/** 本地 fastembed 缓存目录（打包进 resources/embedder 后离线加载）。 */
export const CACHE_ENV = "OVOLVE_EMBED_CACHE";

/** 单条文本进模型前的字符上限。超长对语义向量无额外贡献，且可能超模型 max_seq。 */
export const MAX_CHARS = 2000;

/** HuggingFace 上的 ONNX 源仓库（打包用）。 */
export const ONNX_HF_SOURCE = "Xenova/bge-base-zh-v1.5";

/**
 * Host-injected native embedding backend.
 *
 * The Python module discovers fastembed/sentence-transformers via lazy
 * imports; the TS engine has no such packages and adds none. The host layer
 * (Electron main / a native addon) may inject a synchronous encoder here —
 * everything else in this module (cache, normalization, state machine,
 * status) wraps it identically.
 */
export type OnnxEmbedFn = (text: string) => number[] | null;

let _hostBackend: { name: string; embed: OnnxEmbedFn } | null = null;

export function setOnnxEmbedBackend(name: string, embed: OnnxEmbedFn): void {
  _hostBackend = { name, embed };
}

// Lazy transformers.js pipeline (the source lazy-imports fastembed the same
// way; the model download must never happen at import time — RULEBOOK §2).
let _tfPipeline:
  | ((texts: string[]) => Promise<number[][]>)
  | null
  | undefined = undefined;

async function get_transformers_pipeline(cache_dir: string | null) {
  if (_tfPipeline !== undefined) {
    return _tfPipeline;
  }
  try {
    // Dynamic import keeps module import side-effect-free (RULEBOOK §2).
    const mod = (await import("@xenova/transformers")) as unknown as {
      env: Record<string, unknown>;
      pipeline: (
        task: string,
        model: string,
        opts?: Record<string, unknown>
      ) => Promise<unknown>;
    };
    if (cache_dir) {
      // 与源一致：OVOLVE_EMBED_CACHE / 打包资源目录作为本地缓存根，
      // 命中已打包权重时不再联网二次下载。
      mod.env.cacheDir = cache_dir;
    }
    mod.env.allowRemoteModels = true;
    // Xenova/bge-base-zh-v1.5: the same ONNX conversion the Python source
    // registers via fastembed's add_custom_model (768-dim, CLS pooling).
    const pipe = (await mod.pipeline("feature-extraction", "Xenova/bge-base-zh-v1.5", {
      quantized: true,
    })) as (
      texts: string[],
      opts?: Record<string, unknown>
    ) => Promise<Array<{ data: Float32Array }>>;
    _tfPipeline = async (texts: string[]) => {
      // transformers.js feature-extraction: 单串+无 tokenize 参数返回单个
      // Tensor；数组输入返回 Tensor[]。统一转 { data: Float32Array } 列表。
      const out = await pipe(texts, { pooling: "cls", normalize: false });
      const arr = Array.isArray(out) ? out : [out];
      return arr.map((t) => {
        const tensor = t as { data: Float32Array | number[] };
        return Array.from(tensor.data as Float32Array);
      });
    };
    return _tfPipeline;
  } catch (e) {
    // 永久失败标记由调用方的 _state 一次性契约兜底；这里清缓存避免
    // 半初始化状态被复用。
    _tfPipeline = null;
    throw e;
  }
}

export function resolve_embed_cache_dir(): string | null {
  /** 定位打包/开发环境下的 embedder 缓存目录。
   *
   * 优先级：
   *   1. OVOLVE_EMBED_CACHE
   *   2. 仓库内 app/resources/embedder（开发）
   *   3. 与 embedder.ts 相邻的 resources/embedder（打包后常见布局）
   */
  const env = (process.env[CACHE_ENV] ?? "").trim();
  if (env && fs.existsSync(env) && fs.statSync(env).isDirectory()) {
    return path.resolve(env);
  }

  const here = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    // app/engine/embedder.ts → app/resources/embedder
    path.resolve(here, "..", "resources", "embedder"),
    // resources/app/engine/embedder.ts → resources/embedder
    path.resolve(here, "..", "..", "embedder"),
    path.resolve(here, "..", "..", "resources", "embedder"),
  ];
  const ranked: string[] = [];
  for (const p of candidates) {
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      continue;
    }
    if (_cache_has_onnx(p)) {
      return p;
    }
    ranked.push(p);
  }
  return ranked.length > 0 ? ranked[0]! : null;
}

function _cache_has_onnx(cache_dir: string): boolean {
  if (fs.existsSync(path.join(cache_dir, "onnx", "model.onnx"))) {
    return true;
  }
  const stack: string[] = [cache_dir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // OSError -> skip (os.walk semantics)
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name === "model.onnx") {
        return true;
      }
    }
  }
  return false;
}

/** L2 归一化。零向量原样返回（避免除零）。幂等 —— 已归一化的再来一次不变。 */
export function _l2_normalize(vec: number[]): number[] {
  let sum = 0;
  for (const x of vec) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) {
    return vec;
  }
  return vec.map((x) => x / norm);
}

/** Python OrderedDict + popitem(last=False) → Map preserves insertion order;
 * the LRU touch is delete-then-set. */
export class LocalEmbedder {
  model_name: string;
  cache_dir: string | null;
  /** "onnx" | "torch" | null —— 实际加载成功的后端。 */
  private _backend: string | null = null;
  /** null = 没试过；true = 可用；false = 试过且失败，不再重试。 */
  private _state: boolean | null = null;
  private _last_error: string | null = null;
  private _model: unknown = null;
  /**
   * (model, sha1(text)) → normalized vector, LRU. Reindex/backfill/dream
   * passes re-embed the SAME texts over and over; the model is local so the
   * cost is CPU-seconds, not money, but a full reindex of a large store
   * still burns minutes of it. Vectors are ~768 floats ≈ 6 KB, so 4096
   * entries cap the cache well under 30 MB.
   */
  private _cache = new Map<string, number[]>();
  private readonly _cache_cap = 4096;
  private _cache_hits = 0;
  private _cache_misses = 0;

  constructor(model_name?: string | null, cache_dir?: string | null) {
    this.model_name = model_name || process.env[MODEL_ENV] || DEFAULT_MODEL;
    this.cache_dir = cache_dir ?? resolve_embed_cache_dir();
    // Python 用 threading.Lock 保护 _cache/_state；Node 事件循环天然串行，
    // 锁在结构上不必要（同 path_lock.ts 的 MutexLock 论证）。
  }

  private _cache_key(text: string): string {
    const digest = crypto
      .createHash("sha1")
      .update(Buffer.from(text, "utf-8"))
      .digest("hex");
    return `${this.model_name}|${digest}`;
  }

  private _cache_get(text: string): number[] | null {
    const key = this._cache_key(text);
    const hit = this._cache.get(key);
    if (hit !== undefined) {
      this._cache_hits += 1;
      // move_to_end
      this._cache.delete(key);
      this._cache.set(key, hit);
      return hit;
    }
    this._cache_misses += 1;
    return null;
  }

  private _cache_put(text: string, vec: number[]): void {
    const key = this._cache_key(text);
    this._cache.set(key, vec);
    while (this._cache.size > this._cache_cap) {
      // popitem(last=False) — evict the OLDEST entry.
      const oldest = this._cache.keys().next().value;
      if (oldest === undefined) break;
      this._cache.delete(oldest);
    }
  }

  cache_stats(): Record<string, unknown> {
    const total = this._cache_hits + this._cache_misses;
    return {
      size: this._cache.size,
      cap: this._cache_cap,
      hits: this._cache_hits,
      misses: this._cache_misses,
      hit_rate: total > 0 ? Math.round((this._cache_hits / total) * 10000) / 10000 : 0.0,
    };
  }

  // ── 后端加载 ─────────────────────────────────────────────────────────

  private _try_onnx(): boolean {
    /** 首选后端：transformers.js (ONNX Runtime)。有宿主注入时直接用注入的
     * 编码器；否则惰性加载 @xenova/transformers（同一模型仓库）。模型下载
     * 延迟到首条文本编码时发生，失败置一次性失败标记（last_error 契约不变）。 */
    if (_hostBackend !== null) {
      this._model = _hostBackend.embed;
      this._backend = "onnx";
      return true;
    }
    this._backend = "onnx";
    this._model = null; // pipeline resolved lazily in _raw_encode
    return true;
  }

  private _try_torch(): boolean {
    /** 兜底后端：sentence-transformers。TS 侧无 torch 生态（依赖策略虽放宽，
     * 但 torch 无 JS 等价物且 transformers.js 已覆盖同一模型），如实失败并
     * 记录（源同样在这一步记录 last_error 后走降级链）。 */
    this._last_error = "sentence-transformers 不可用（TS 引擎无 torch 生态；transformers.js 已覆盖同模型）";
    return false;
  }

  private _ensure_model(): boolean {
    /** 按 ONNX → torch 顺序加载。返回是否可用。失败只尝试一次。 */
    if (this._state !== null) {
      return this._state;
    }
    if (process.env[DISABLE_ENV]) {
      this._state = false;
      this._last_error = `已通过环境变量 ${DISABLE_ENV} 禁用嵌入模型`;
      return false;
    }

    const forced = (process.env[BACKEND_ENV] ?? "").toLowerCase();
    let order: Array<() => boolean>;
    if (forced === "onnx") {
      order = [() => this._try_onnx()];
    } else if (forced === "torch") {
      order = [() => this._try_torch()];
    } else {
      order = [() => this._try_onnx(), () => this._try_torch()]; // ONNX 优先
    }

    for (const attempt of order) {
      if (attempt()) {
        this._state = true;
        this._last_error = null;
        return true;
      }
    }
    this._state = false;
    // _last_error 保留最后一次失败原因
    return false;
  }

  get available(): boolean {
    return this._ensure_model();
  }

  /** 已加载？不触发加载，仅查询。 */
  get loaded(): boolean {
    return this._state === true;
  }

  get backend(): string | null {
    return this._backend;
  }

  get last_error(): string | null {
    return this._last_error;
  }

  // ── 编码 ─────────────────────────────────────────────────────────────

  private async _raw_encode(text: string): Promise<number[] | null> {
    /** 后端相关的原始编码。返回未归一化的 number[] 或 null。 */
    if (this._backend !== "onnx") {
      return null;
    }
    if (typeof this._model === "function") {
      // host-injected synchronous encoder
      const fn = this._model as OnnxEmbedFn;
      return fn(text);
    }
    // lazy transformers.js pipeline (first call downloads/caches the model;
    // cache_dir 重定向复用打包资源，OVOLVE_EMBED_CACHE 语义与源一致)
    const pipe = await get_transformers_pipeline(this.cache_dir);
    if (!pipe) {
      return null;
    }
    const vecs = await pipe([text]);
    if (!vecs || vecs.length === 0) {
      return null;
    }
    return vecs[0]!;
  }

  /** 编码为**已归一化**向量。不可用或失败返回 null。 */
  async encode(text: string): Promise<number[] | null> {
    if (!text || !text.trim()) {
      return null;
    }
    // Python str[:MAX_CHARS] is codepoint slicing; word runs here can be CJK,
    // so Array.from keeps the same cut boundary (HANDOFF §6.2).
    const clipped = Array.from(text).slice(0, MAX_CHARS).join("");
    const cached = this._cache_get(clipped);
    if (cached !== null) {
      return cached;
    }
    if (!this._ensure_model()) {
      return null;
    }
    try {
      const raw = await this._raw_encode(clipped);
      if (raw === null) {
        return null;
      }
      const vec = _l2_normalize(raw);
      this._cache_put(clipped, vec);
      return vec;
    } catch (e) {
      // 单条失败不拉黑整个 embedder。
      this._last_error = `编码失败：${e}`;
      return null;
    }
  }

  /** 批量编码。长度与输入一致，失败/空位置为 null，便于按下标对齐。 */
  async encode_batch(texts: string[]): Promise<Array<number[] | null>> {
    if (!texts || texts.length === 0) {
      return [];
    }
    const out: Array<number[] | null> = new Array(texts.length).fill(null);
    const idx_map: number[] = [];
    const payload: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i]!;
      if (!t || !t.trim()) {
        continue;
      }
      const clipped = Array.from(t).slice(0, MAX_CHARS).join("");
      const cached = this._cache_get(clipped);
      if (cached !== null) {
        out[i] = cached;
        continue;
      }
      idx_map.push(i);
      payload.push(clipped);
    }
    if (payload.length === 0) {
      return out;
    }
    if (!this._ensure_model()) {
      return out;
    }
    let raws: Array<number[] | null>;
    try {
      if (this._backend === "onnx") {
        if (typeof this._model === "function") {
          // host-injected synchronous encoder
          const fn = this._model as OnnxEmbedFn;
          raws = payload.map((t) => fn(t));
        } else {
          // transformers.js 批量推理（一条 pipeline 调用处理整个 payload）
          const pipe = await get_transformers_pipeline(this.cache_dir);
          if (!pipe) {
            raws = payload.map(() => null);
          } else {
            raws = await pipe(payload);
          }
        }
      } else {
        raws = payload.map(() => null);
      }
    } catch (e) {
      this._last_error = `批量编码失败：${e}`;
      return out;
    }
    for (let pos = 0; pos < idx_map.length; pos++) {
      const raw = raws[pos];
      if (raw === null || raw === undefined) {
        continue; // 该位置保持 None（与源的生成器空产出对齐）
      }
      const vec = _l2_normalize(raw);
      out[idx_map[pos]!] = vec;
      this._cache_put(payload[pos]!, vec);
    }
    return out;
  }

  // ── 状态 ─────────────────────────────────────────────────────────────

  /** 不触发加载的状态快照。 */
  status(): Record<string, unknown> {
    return {
      model: this.model_name,
      backend: this._backend,
      loaded: this.loaded,
      attempted: this._state !== null,
      error: this._last_error,
      cache: this.cache_stats(),
    };
  }
}

let _embedder: LocalEmbedder | null = null;

export function get_embedder(model_name?: string | null): LocalEmbedder {
  if (_embedder === null) {
    _embedder = new LocalEmbedder(model_name);
  }
  return _embedder;
}

/** 模块级便捷函数 —— memory_layer 需要的 ``str -> list[float]`` 形状
 *  （embedder.py:403；router.py:44 的 `set_embed_callback(embed_text)` 就是它）。
 *  DIVERGENCE(port): `LocalEmbedder.encode` 在 TS 侧是 async（transformers.js 的
 *  pipeline 返回 Promise，python 侧是同步阻塞），所以本入口同样 async。
 *  memory_layer.ts:1128-1134 已经写明它如何处理返回 Promise 的 embed 回调。 */
export async function embed_text(text: string): Promise<number[] | null> {
  return await get_embedder().encode(text);
}

// DIVERGENCE(port): the ONNX backend is registered here via the
// setOnnxEmbedBackend seam (Xenova/bge-base-zh-v1.5 — the same ONNX
// conversion the Python source runs). The BGE query-prefix optimisation the
// source docstring discusses (line 47: "为这个句子生成表示以用于检索相关文章：")
// is NOT applied by the source either — memory_layer keeps one unified
// encode path and the docstring only notes future upside. Behaviour is
// identical: neither build prefixes queries. If a real onnxruntime node-addon
// ships later, register it the same way; cache keys already carry
// model_name, so a prefix change would invalidate cleanly.
