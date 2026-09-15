"""edge/base.py - Abstract base for on-device inference backends.

The edge subsystem provides local inference (OCR, embeddings, small models) so
Ovolve can operate offline for privacy-sensitive tasks. Each backend has a
graceful degradation path: if the underlying library isn't installed, the
backend reports ``available=False`` and callers can fall back to the next
backend or to a remote model.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any, Optional
from result import Result


class EdgeBackend(ABC):
    """Abstract base class for on-device inference backends."""

    name: str = "abstract"

    @property
    @abstractmethod
    def available(self) -> bool:
        """Whether this backend is ready to serve inferences."""
        ...

    @abstractmethod
    def load_model(self, model_path: str, **kwargs: Any) -> Result:
        """Load a model from disk.

        Args:
            model_path: Path to the model file/directory.
            **kwargs: Backend-specific options.

        Returns:
            Result indicating success or failure.
        """
        ...

    @abstractmethod
    def infer(self, inputs: Any, **kwargs: Any) -> Result:
        """Run inference on the loaded model.

        Args:
            inputs: Model-specific input (image bytes, text, tensor, etc.).
            **kwargs: Runtime options.

        Returns:
            Result with the inference output on success.
        """
        ...

    def unload(self) -> None:
        """Release any loaded model resources. Subclasses may override."""
        return None

    def get_metadata(self) -> dict:
        """Return backend metadata (name, available, model info)."""
        return {"name": self.name, "available": self.available}


class NullBackend(EdgeBackend):
    """No-op backend used when nothing else is available.

    Keeps the caller code simple: every request returns a clear "unavailable"
    result rather than raising.
    """

    name = "null"

    @property
    def available(self) -> bool:
        return False

    def load_model(self, model_path: str, **kwargs: Any) -> Result:
        return Result.failure("No edge backend available", code="EdgeUnavailable")

    def infer(self, inputs: Any, **kwargs: Any) -> Result:
        return Result.failure("No edge backend available", code="EdgeUnavailable")


def pick_backend(preferred: Optional[str] = None) -> EdgeBackend:
    """Pick the first available backend, honoring an optional preference.

    Args:
        preferred: One of ``openvino``, ``onnx`` — tried first when supplied.

    Returns:
        The chosen backend instance (never None; falls back to ``NullBackend``).
    """
    from edge.openvino_backend import OpenVINOBackend
    from edge.onnx_backend import ONNXBackend

    order = ["openvino", "onnx"]
    if preferred and preferred in order:
        order.remove(preferred)
        order.insert(0, preferred)

    for name in order:
        backend: EdgeBackend
        if name == "openvino":
            backend = OpenVINOBackend()
        elif name == "onnx":
            backend = ONNXBackend()
        else:
            continue
        if backend.available:
            return backend
    return NullBackend()
