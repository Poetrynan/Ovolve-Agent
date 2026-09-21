"""rust_adapters/patch_engine.py — Rust-accelerated unified diff apply with Python fallback."""
from __future__ import annotations

from dataclasses import dataclass

try:
    from ovolve_core import patch_engine as _rust
    _HAS_RUST = True
except ImportError:
    _HAS_RUST = False


@dataclass
class PatchResult:
    ok: bool
    content: str = ""
    error: str = ""
    hunks_applied: int = 0


def apply_unified_patch(content: str, patch: str) -> PatchResult:
    if _HAS_RUST:
        try:
            r = _rust.apply_unified_patch(content, patch)
            return PatchResult(
                ok=bool(r.get("ok")),
                content=str(r.get("content") or ""),
                error=str(r.get("error") or ""),
                hunks_applied=int(r.get("hunks_applied") or 0),
            )
        except Exception:
            pass
    import patch_engine as _py_impl
    return _py_impl.apply_unified_patch(content, patch)
