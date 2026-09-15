"""
rust_adapters/embedder.py - Delegation shim for backend/embedder.py.

The embedding hot path is the ONNX/PyTorch model itself (already native
performance); a Rust wrapper adds no measurable gain here, and the previous
standalone copy had drifted from the original on multiple axes (attribute
vs property accessors, env-var switches OVOLVE_DISABLE_EMBEDDINGS /
OVOLVE_EMBED_BACKEND, fastembed custom-model registration for
bge-base-zh-v1.5, cache_stats key names). This shim therefore delegates
every symbol to the canonical embedder module — one implementation,
zero drift, and rust_adapters users keep their import paths.
"""
from __future__ import annotations

try:
    from embedder import (  # noqa: F401
        DEFAULT_MODEL,
        MODEL_ENV,
        DISABLE_ENV,
        BACKEND_ENV,
        MAX_CHARS,
        _l2_normalize,
        LocalEmbedder,
        get_embedder,
        embed_text,
    )
except ImportError:  # packaged import shape
    from app.backend.embedder import (  # noqa: F401
        DEFAULT_MODEL,
        MODEL_ENV,
        DISABLE_ENV,
        BACKEND_ENV,
        MAX_CHARS,
        _l2_normalize,
        LocalEmbedder,
        get_embedder,
        embed_text,
    )

__all__ = [
    "DEFAULT_MODEL",
    "MODEL_ENV",
    "DISABLE_ENV",
    "BACKEND_ENV",
    "MAX_CHARS",
    "_l2_normalize",
    "LocalEmbedder",
    "get_embedder",
    "embed_text",
]
