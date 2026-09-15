"""
rust_adapters - Python adapter layer for Ovolve Core Rust modules.

This package provides drop-in replacements for performance-critical Python modules,
routing calls to the compiled Rust extension via PyO3 bindings.

Usage:
    # Instead of:
    from embedder import LocalEmbedder, get_embedder

    # Use:
    from rust_adapters.embedder import LocalEmbedder, get_embedder

    # Or set environment variable to auto-route:
    # RUST_BACKEND=1
"""

import os

RUST_BACKEND_ENABLED = os.environ.get("RUST_BACKEND", "0") == "1"

def _try_import_rust():
    """Attempt to import the compiled ovolve_core Rust extension."""
    try:
        import ovolve_core
        return ovolve_core
    except ImportError:
        return None

_ovolve_core = _try_import_rust()

#: Attributes proving the module is a real compiled extension rather than absent.
_RUST_PROBE_ATTRS = ("levenshtein_distance", "storage_engine", "embedder", "command_guard")

def is_rust_available() -> bool:
    """Check if Rust backend is actually functional."""
    if _ovolve_core is None:
        return False
    return any(hasattr(_ovolve_core, attr) for attr in _RUST_PROBE_ATTRS)

def backend_info() -> dict:
    """Report which backend is active."""
    if is_rust_available():
        return {
            "backend": "rust",
            "version": getattr(_ovolve_core, "__version__", "unknown"),
        }
    return {"backend": "python"}
