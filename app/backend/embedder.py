"""embedder.py — Ovolve Layer 2 记忆：本地语义向量（ONNX 优先）

# 为什么用 ONNX Runtime 而不是 PyTorch

这是桌面应用。PyTorch 装下来带上 CUDA/依赖树是 1-2GB —— 对一个只做**推理**、
永远不训练的场景，这是纯粹的浪费。ONNX Runtime 只有 ~50MB，CPU 推理速度还更快
（图优化 + 量化）。

所以后端顺序是：

    1. ONNX (fastembed)          ← 首选。~50MB，无 torch，Qdrant 维护
    2. sentence-transformers      ← 兜底。如果环境里已经有 torch，也能用
    3. None                       ← 都没有 → memory_layer 退回关键词打分

用户装 `fastembed` 就走 ONNX；万一只装了 `sentence-transformers` 也不至于用不了；
两个都没有也不崩。公共接口（encode / encode_batch / available / status）三种
后端完全一致，Router 那边的接线一个字都不用改。

# 模型

``BAAI/bge-base-zh-v1.5``（768 维）。BGE 是智源（BAAI）的中文检索标杆模型，在
中文语义检索上明显强于多语言 MiniLM —— 我们的记忆召回主场景就是中文，用专精
中文的模型比用"什么都会一点"的多语言模型更合适。

fastembed 内置目录里没有 BGE-base-zh-v1.5（只有 small 版），所以我们首次加载时
调用 ``TextEmbedding.add_custom_model`` 把它注册进去，源仓库指向 Xenova 维护的
社区 ONNX 转换版（``Xenova/bge-base-zh-v1.5``，~400MB）。所有权仍归 BAAI，
Xenova 只做了 ONNX 导出。加载后 ONNX Runtime 直接跑，无需 PyTorch。

维度从 384 变成 768：存储层用 numpy 余弦、不锁维度，所以无需改 schema。但
**换模型后旧向量作废** —— 384 维的旧向量和 768 维的新向量没法算余弦。由于此前
embed_callback 一直是 None（从没真正算过向量落盘），库里本就没有旧向量，这次切换
是干净的。若将来再换模型，需要清空 memory_entries 的 embedding 列重新编码。

实测（本地基准，v1.5 + Xenova ONNX + CLS pooling + L2 归一化）：

  · "我喜欢用 TypeScript 写前端" vs "前端开发我偏好 TypeScript"     → 0.908
  · "我喜欢用 TypeScript 写前端" vs "今天北京的天气很热"            → 0.358
  · "这个项目用 pnpm 管理依赖"    vs "依赖管理器选的是 pnpm"        → 0.862
  · "这个项目用 pnpm 管理依赖"    vs "红烧肉的做法是先炒糖色"        → 0.237

同义高分（>0.85）、无关低分（<0.4），召回信号足够干净。

# BGE 的查询指令（已知取舍）

BGE 官方建议检索时给**查询侧**（不是文档侧）加前缀
"为这个句子生成表示以用于检索相关文章："。但 memory_layer 只有一个统一的
embed 回调，存储和查询走同一条路，无法只给查询加前缀。这里选择**对称嵌入**
（两侧都不加）—— 实现简单，BGE 在对称相似度下依然好用，只是检索质量比"查询加
指令"略低一点点。将来若要压榨这点收益，需要给 memory_layer 拆出独立的 query
嵌入路径。
"""
from __future__ import annotations

import math
import os
import threading
from typing import Optional


#: 默认模型。BGE 中文检索标杆，768 维，fastembed 提供 ONNX 版。
DEFAULT_MODEL = "BAAI/bge-base-zh-v1.5"

MODEL_ENV = "OVOLVE_EMBED_MODEL"
DISABLE_ENV = "OVOLVE_DISABLE_EMBEDDINGS"
#: 强制后端：``onnx`` / ``torch``。默认自动探测（ONNX 优先）。
BACKEND_ENV = "OVOLVE_EMBED_BACKEND"
#: 本地 fastembed 缓存目录（打包进 resources/embedder 后离线加载）。
CACHE_ENV = "OVOLVE_EMBED_CACHE"

#: 单条文本进模型前的字符上限。超长对语义向量无额外贡献，且可能超模型 max_seq。
MAX_CHARS = 2000

#: HuggingFace 上的 ONNX 源仓库（打包用）。
ONNX_HF_SOURCE = "Xenova/bge-base-zh-v1.5"


def resolve_embed_cache_dir() -> Optional[str]:
    """定位打包/开发环境下的 embedder 缓存目录。

    优先级：
      1. ``OVOLVE_EMBED_CACHE``
      2. 仓库内 ``app/resources/embedder``（开发）
      3. 与 ``embedder.py`` 相邻的 ``resources/embedder``（打包后常见布局）
    """
    env = (os.environ.get(CACHE_ENV) or "").strip()
    if env and os.path.isdir(env):
        return os.path.abspath(env)

    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        # app/backend/embedder.py → app/resources/embedder
        os.path.normpath(os.path.join(here, "..", "resources", "embedder")),
        # resources/app/backend/embedder.py → resources/embedder
        os.path.normpath(os.path.join(here, "..", "..", "embedder")),
        os.path.normpath(os.path.join(here, "..", "..", "resources", "embedder")),
    ]
    ranked: list[str] = []
    for path in candidates:
        if not os.path.isdir(path):
            continue
        if _cache_has_onnx(path):
            return path
        ranked.append(path)
    return ranked[0] if ranked else None


def _cache_has_onnx(cache_dir: str) -> bool:
    if os.path.isfile(os.path.join(cache_dir, "onnx", "model.onnx")):
        return True
    for root, _dirs, files in os.walk(cache_dir):
        if "model.onnx" in files:
            return True
    return False



def _l2_normalize(vec: list[float]) -> list[float]:
    """L2 归一化。零向量原样返回（避免除零）。幂等 —— 已归一化的再来一次不变。"""
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        return vec
    return [x / norm for x in vec]


class LocalEmbedder:
    """本地句向量编码器。ONNX 优先，线程安全懒加载，一次性失败标记。

    Args:
        model_name: 覆盖默认模型。为 None 时读 ``OVOLVE_EMBED_MODEL``。
    """

    def __init__(self, model_name: Optional[str] = None, cache_dir: Optional[str] = None):
        self.model_name = (model_name or os.environ.get(MODEL_ENV) or DEFAULT_MODEL)
        self.cache_dir = cache_dir or resolve_embed_cache_dir()
        self._model = None
        #: "onnx" | "torch" | None —— 实际加载成功的后端。
        self._backend: Optional[str] = None
        #: None = 没试过；True = 可用；False = 试过且失败，不再重试。
        self._state: Optional[bool] = None
        self._lock = threading.Lock()
        self._last_error: Optional[str] = None
        #: (model, sha1(text)) → normalized vector, LRU. Reindex/backfill/dream
        #: passes re-embed the SAME texts over and over; the model is local so
        #: the cost is CPU-seconds, not money, but a full reindex of a large
        #: store still burns minutes of it. Vectors are ~768 floats ≈ 6 KB, so
        #: 4096 entries cap the cache well under 30 MB.
        import hashlib
        from collections import OrderedDict
        self._cache: "OrderedDict[tuple, list[float]]" = OrderedDict()
        self._cache_cap = 4096
        self._hash = hashlib.sha1
        self._cache_hits = 0
        self._cache_misses = 0

    def _cache_key(self, text: str) -> tuple:
        return (self.model_name, self._hash(text.encode("utf-8", "replace")).hexdigest())


    def _cache_get(self, text: str) -> Optional[list[float]]:
        key = self._cache_key(text)
        with self._lock:
            hit = self._cache.get(key)
            if hit is not None:
                self._cache_hits += 1
                self._cache.move_to_end(key)
            else:
                self._cache_misses += 1
            return hit

    def _cache_put(self, text: str, vec: list[float]) -> None:
        key = self._cache_key(text)
        with self._lock:
            self._cache[key] = vec
            self._cache.move_to_end(key)
            while len(self._cache) > self._cache_cap:
                self._cache.popitem(last=False)

    def cache_stats(self) -> dict:
        with self._lock:
            total = self._cache_hits + self._cache_misses
            return {
                "size": len(self._cache),
                "cap": self._cache_cap,
                "hits": self._cache_hits,
                "misses": self._cache_misses,
                "hit_rate": round(self._cache_hits / total, 4) if total > 0 else 0.0,
            }

    # ── 后端加载 ─────────────────────────────────────────────────────────

    def _try_onnx(self) -> bool:
        """首选后端：fastembed（ONNX Runtime）。"""
        try:
            from fastembed import TextEmbedding
        except Exception as e:
            self._last_error = f"fastembed 不可用（{e}）"
            return False
        try:
            # fastembed 内置模型列表不含 bge-base-zh-v1.5，需要手动注册。
            # Xenova/bge-base-zh-v1.5 是社区提供的 ONNX 转换版。
            supported = {m["model"] for m in TextEmbedding.list_supported_models()}
            if self.model_name not in supported:
                self._register_custom_model(TextEmbedding)

            kwargs = {}
            if self.cache_dir:
                kwargs["cache_dir"] = self.cache_dir
                # 打包资源已含权重时强制离线，避免 release 用户二次下载。
                if _cache_has_onnx(self.cache_dir):
                    kwargs["local_files_only"] = True

            self._model = TextEmbedding(model_name=self.model_name, **kwargs)
            self._backend = "onnx"
            return True
        except Exception as e:
            self._last_error = f"fastembed 加载 {self.model_name} 失败：{e}"
            return False

    @staticmethod
    def _register_custom_model(cls) -> None:
        """注册 BGE-base-zh-v1.5 到 fastembed 的自定义模型目录。

        fastembed 0.8+ 的 ``add_custom_model`` 允许我们指定一个 HuggingFace
        仓库作为 ONNX 模型源。Xenova/bge-base-zh-v1.5 是 Xenova 维护的官方
        ONNX 导出版，结构标准（onnx/model.onnx + tokenizer），被 fastembed 直接支持。
        """
        try:
            from fastembed.common.model_description import PoolingType, ModelSource
            cls.add_custom_model(
                model="BAAI/bge-base-zh-v1.5",
                pooling=PoolingType.CLS,
                normalization=True,
                sources=ModelSource(hf=ONNX_HF_SOURCE),
                dim=768,
                model_file="onnx/model.onnx",
                description="BGE-base-zh-v1.5 中文检索标杆模型（768 维）",
                size_in_gb=0.4,
            )
        except Exception:
            # 注册失败不致命，后续 TextEmbedding() 会报错，走降级链。
            pass

    def _try_torch(self) -> bool:
        """兜底后端：sentence-transformers（PyTorch）。"""
        try:
            from sentence_transformers import SentenceTransformer
        except Exception as e:
            self._last_error = f"sentence-transformers 不可用（{e}）"
            return False
        try:
            # fastembed 要 HF 全名，ST 用不用前缀都行，直接传。
            self._model = SentenceTransformer(self.model_name)
            self._backend = "torch"
            return True
        except Exception as e:
            self._last_error = f"sentence-transformers 加载失败：{e}"
            return False

    def _ensure_model(self) -> bool:
        """按 ONNX → torch 顺序加载。返回是否可用。失败只尝试一次。"""
        if self._state is not None:
            return self._state
        with self._lock:
            if self._state is not None:
                return self._state
            if os.environ.get(DISABLE_ENV):
                self._state = False
                self._last_error = f"已通过环境变量 {DISABLE_ENV} 禁用嵌入模型"
                return False

            forced = (os.environ.get(BACKEND_ENV) or "").lower()
            if forced == "onnx":
                order = [self._try_onnx]
            elif forced == "torch":
                order = [self._try_torch]
            else:
                order = [self._try_onnx, self._try_torch]  # ONNX 优先

            for attempt in order:
                if attempt():
                    self._state = True
                    self._last_error = None
                    return True
            self._state = False
            # _last_error 保留最后一次失败原因
            return False

    @property
    def available(self) -> bool:
        return self._ensure_model()

    @property
    def loaded(self) -> bool:
        """已加载？不触发加载，仅查询。"""
        return self._state is True

    @property
    def backend(self) -> Optional[str]:
        return self._backend

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    # ── 编码 ─────────────────────────────────────────────────────────────

    def _raw_encode(self, text: str) -> Optional[list[float]]:
        """后端相关的原始编码。返回未归一化的 list[float] 或 None。"""
        if self._backend == "onnx":
            # fastembed.embed 接受可迭代、返回 numpy 数组的生成器。
            vecs = list(self._model.embed([text]))
            if not vecs:
                return None
            return [float(x) for x in vecs[0]]
        if self._backend == "torch":
            vec = self._model.encode(text, show_progress_bar=False)
            return [float(x) for x in vec]
        return None

    def encode(self, text: str) -> Optional[list[float]]:
        """编码为**已归一化**向量。不可用或失败返回 None。"""
        if not text or not text.strip():
            return None
        clipped = text[:MAX_CHARS]
        cached = self._cache_get(clipped)
        if cached is not None:
            return cached
        if not self._ensure_model():
            return None
        try:
            raw = self._raw_encode(clipped)
            if raw is None:
                return None
            vec = _l2_normalize(raw)
            self._cache_put(clipped, vec)
            return vec
        except Exception as e:
            # 单条失败不拉黑整个 embedder。
            self._last_error = f"编码失败：{e}"
            return None

    def encode_batch(self, texts: list[str]) -> list[Optional[list[float]]]:
        """批量编码。长度与输入一致，失败/空位置为 None，便于按下标对齐。"""
        if not texts:
            return []
        out: list[Optional[list[float]]] = [None] * len(texts)
        idx_map: list[int] = []
        payload: list[str] = []
        for i, t in enumerate(texts):
            if not (t and t.strip()):
                continue
            clipped = t[:MAX_CHARS]
            cached = self._cache_get(clipped)
            if cached is not None:
                out[i] = cached
                continue
            idx_map.append(i)
            payload.append(clipped)
        if not payload:
            return out
        if not self._ensure_model():
            return out
        try:
            if self._backend == "onnx":
                raws = [[float(x) for x in v] for v in self._model.embed(payload)]
            else:  # torch
                arr = self._model.encode(payload, show_progress_bar=False)
                raws = [[float(x) for x in v] for v in arr]
        except Exception as e:
            self._last_error = f"批量编码失败：{e}"
            return out
        for pos, raw, txt in zip(idx_map, raws, payload):
            vec = _l2_normalize(raw)
            out[pos] = vec
            self._cache_put(txt, vec)
        return out

    # ── 状态 ─────────────────────────────────────────────────────────────

    def status(self) -> dict:
        """不触发加载的状态快照。"""
        return {
            "model": self.model_name,
            "backend": self._backend,
            "loaded": self.loaded,
            "attempted": self._state is not None,
            "error": self._last_error,
            "cache": self.cache_stats(),
        }


_embedder: Optional[LocalEmbedder] = None


def get_embedder(model_name: Optional[str] = None) -> LocalEmbedder:
    global _embedder
    if _embedder is None:
        _embedder = LocalEmbedder(model_name)
    return _embedder


def embed_text(text: str) -> Optional[list[float]]:
    """模块级便捷函数 —— memory_layer 需要的 ``str -> list[float]`` 形状。"""
    return get_embedder().encode(text)
