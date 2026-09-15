"""
rust_adapters/edge.py - Drop-in replacement for backend/edge/ modules.

Routes to ovolve_core.edge when available, falls back to pure Python.
All public APIs are 100% compatible with the original module.
"""
from __future__ import annotations
from typing import Any, Optional
from result import Result

# Try to import Rust backend (ovolve_core)
try:
    from ovolve_core import edge as _rust
    _HAS_RUST = True
except ImportError:
    _HAS_RUST = False

__all__ = [
    "EdgeBackend",
    "ONNXBackend",
    "OpenVinoBackend",
    "NullBackend",
    "pick_backend",
]


class EdgeBackend:
    """Abstract base for on-device inference backends."""
    
    name = "base"
    
    def available(self) -> bool:
        raise NotImplementedError
    
    def load_model(self, model_path: str, **kwargs: Any) -> Result:
        raise NotImplementedError
    
    def infer(self, inputs: Any, **kwargs: Any) -> Result:
        raise NotImplementedError
    
    def unload(self) -> None:
        pass
    
    def get_metadata(self) -> dict:
        return {"name": self.name}


class NullBackend(EdgeBackend):
    """No-op backend."""
    
    name = "null"
    
    def available(self) -> bool:
        return False
    
    def load_model(self, model_path: str, **kwargs: Any) -> Result:
        return Result.ok(None)
    
    def infer(self, inputs: Any, **kwargs: Any) -> Result:
        return Result.err("No backend available")
    
    def get_metadata(self) -> dict:
        return {"name": "null", "available": False}


class ONNXBackend(EdgeBackend):
    """ONNX Runtime backend."""
    
    name = "onnx"
    
    def __init__(self, providers: Optional[list[str]] = None):
        if _HAS_RUST:
            self._inner = _rust.OnnxBackend(providers)
        else:
            self._inner = None
        self._providers = providers or ["CPUExecutionProvider"]
        self._model_path: Optional[str] = None
    
    def available(self) -> bool:
        if _HAS_RUST and self._inner:
            return self._inner.available()
        try:
            import onnxruntime  # noqa: F401
            return True
        except ImportError:
            return False
    
    def load_model(self, model_path: str, **kwargs: Any) -> Result:
        if _HAS_RUST and self._inner:
            r = self._inner.load_model(model_path)
            return Result.ok(r.data) if r.success else Result.err(r.error or "load failed")
        self._model_path = model_path
        return Result.ok(None)
    
    def infer(self, inputs: Any, **kwargs: Any) -> Result:
        if _HAS_RUST and self._inner:
            flat = inputs if isinstance(inputs, list) else inputs.flatten().tolist()
            r = self._inner.infer(flat)
            return Result.ok(r.data) if r.success else Result.err(r.error or "infer failed")
        return Result.err("ONNX runtime not available")
    
    def unload(self) -> None:
        if _HAS_RUST and self._inner:
            self._inner.unload()
        self._model_path = None
    
    def get_metadata(self) -> dict:
        if _HAS_RUST and self._inner:
            return dict(self._inner.get_metadata())
        return {"name": "onnx", "available": self.available(), "providers": self._providers}


class OpenVinoBackend(EdgeBackend):
    """OpenVINO backend."""
    
    name = "openvino"
    
    def __init__(self, device: str = "CPU"):
        if _HAS_RUST:
            self._inner = _rust.OpenVinoBackend(device)
        else:
            self._inner = None
        self._device = device
        self._model_path: Optional[str] = None
    
    def available(self) -> bool:
        if _HAS_RUST and self._inner:
            return self._inner.available()
        try:
            import openvino  # noqa: F401
            return True
        except ImportError:
            return False
    
    def load_model(self, model_path: str, **kwargs: Any) -> Result:
        if _HAS_RUST and self._inner:
            r = self._inner.load_model(model_path)
            return Result.ok(r.data) if r.success else Result.err(r.error or "load failed")
        self._model_path = model_path
        return Result.ok(None)
    
    def infer(self, inputs: Any, **kwargs: Any) -> Result:
        if _HAS_RUST and self._inner:
            flat = inputs if isinstance(inputs, list) else inputs.flatten().tolist()
            r = self._inner.infer(flat)
            return Result.ok(r.data) if r.success else Result.err(r.error or "infer failed")
        return Result.err("OpenVINO not available")
    
    def unload(self) -> None:
        if _HAS_RUST and self._inner:
            self._inner.unload()
        self._model_path = None
    
    def get_metadata(self) -> dict:
        if _HAS_RUST and self._inner:
            return dict(self._inner.get_metadata())
        return {"name": "openvino", "available": self.available(), "device": self._device}


def pick_backend(preferred: Optional[str] = None) -> EdgeBackend:
    """Pick the first available backend."""
    if _HAS_RUST:
        name = _rust.pick_backend(preferred)
        if name == "onnx":
            return ONNXBackend()
        elif name == "openvino":
            return OpenVinoBackend()
        return NullBackend()
    
    if preferred == "onnx" or preferred is None:
        b = ONNXBackend()
        if b.available():
            return b
    if preferred == "openvino" or preferred is None:
        b = OpenVinoBackend()
        if b.available():
            return b
    return NullBackend()
